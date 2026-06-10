/**
 * KOZA WEBRTC SIGNALING HANDLER
 *
 * Manages the full lifecycle of a WebRTC peer connection:
 *   SDP offer/answer exchange → ICE candidate trickling → data channel
 *   Connection state tracking → error recovery → exponential-backoff reconnection
 *
 * Transport-agnostic: the handler emits 'signal' events that the caller must
 * forward to the remote peer (e.g. via Supabase Realtime, Firebase, etc.).
 * Incoming remote signals are fed back via receiveSignal().
 *
 * Dependency injection: pass `PeerClass` in config to replace simple-peer
 * (useful in tests and server-side environments).
 *
 * Latency target: signaling operations (signal emission, state transitions)
 * complete synchronously or within a single microtask — well under 100ms.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – no @types/simple-peer package
import SimplePeer from 'simple-peer';

// ─── public types ────────────────────────────────────────────────────────────

export type SignalingState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'closed';

export interface SignalPayload {
  type?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit | Record<string, unknown>;
  renegotiate?: boolean;
  transceiverRequest?: { kind: string; init: Record<string, unknown> };
  [key: string]: unknown;
}

export interface SignalMessage {
  peerId: string;
  targetPeerId: string;
  payload: SignalPayload;
  timestamp: number;
}

export interface SignalingConfig {
  localPeerId: string;
  remotePeerId?: string;
  initiator: boolean;
  iceServers?: RTCIceServer[];
  reconnectAttempts?: number; // default 3
  reconnectDelay?: number;    // ms, base for exponential backoff (default 500)
  signalTimeout?: number;     // ms before signaling is considered stuck (default 5000)
  wrtc?: object;              // inject WebRTC for non-browser environments
  PeerClass?: PeerConstructor;
}

// ─── internal peer interface (matches simple-peer public API) ────────────────

interface PeerInstance {
  on(event: string, fn: (...args: unknown[]) => void): this;
  off(event: string, fn: (...args: unknown[]) => void): this;
  once(event: string, fn: (...args: unknown[]) => void): this;
  removeAllListeners(event?: string): this;
  signal(data: unknown): void;
  send(data: string | Buffer | ArrayBuffer | Blob): void;
  addStream(stream: MediaStream): void;
  destroy(err?: Error): void;
  readonly destroyed: boolean;
  readonly connected: boolean;
}

export type PeerConstructor = new (opts: object) => PeerInstance;

// ─── constants ───────────────────────────────────────────────────────────────

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const PING_INTERVAL_MS = 2000;

// ─── minimal typed event emitter (no Node.js dependency) ─────────────────────

class Emitter {
  private readonly _listeners = new Map<string, Array<(...a: unknown[]) => void>>();

  on(event: string, fn: (...a: unknown[]) => void): this {
    const list = this._listeners.get(event) ?? [];
    list.push(fn);
    this._listeners.set(event, list);
    return this;
  }

  off(event: string, fn: (...a: unknown[]) => void): this {
    const list = this._listeners.get(event);
    if (list) {
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    }
    return this;
  }

  once(event: string, fn: (...a: unknown[]) => void): this {
    const w = (...a: unknown[]) => { this.off(event, w); fn(...a); };
    return this.on(event, w);
  }

  protected fire(event: string, ...args: unknown[]): void {
    const snapshot = [...(this._listeners.get(event) ?? [])];
    for (const fn of snapshot) {
      try {
        fn(...args);
      } catch (e) {
        console.error(`[SignalingHandler:${event}] listener threw:`, e);
      }
    }
  }

  removeAllListeners(): void {
    this._listeners.clear();
  }
}

// ─── SignalingHandler ─────────────────────────────────────────────────────────

export class SignalingHandler extends Emitter {
  private readonly cfg: Required<Omit<SignalingConfig, 'wrtc'>> & { wrtc?: object };
  private peer: PeerInstance | null = null;
  private _state: SignalingState = 'idle';
  private reconnectCount = 0;
  private signalTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private _latency = 0;
  private pingTs = 0;
  private pendingSignals: SignalPayload[] = [];

  constructor(config: SignalingConfig) {
    super();
    this.cfg = {
      remotePeerId: '',
      iceServers: DEFAULT_ICE_SERVERS,
      reconnectAttempts: 3,
      reconnectDelay: 500,
      signalTimeout: 5000,
      PeerClass: SimplePeer as unknown as PeerConstructor,
      ...config,
    };
  }

  // ─── public API ────────────────────────────────────────────────────────────

  /** Begin the signaling process. Safe to call from either end. */
  start(stream?: MediaStream): void {
    if (this._state === 'closed') return;
    if (this._state !== 'idle' && this._state !== 'failed') return;
    this.reconnectCount = 0;
    this._createPeer(stream);
  }

  /**
   * Feed a signal message received from the remote peer into the local peer.
   * Auto-starts non-initiator peers that have not yet called start().
   */
  receiveSignal(msg: SignalMessage): void {
    if (this._state === 'closed') return;

    if (!this.cfg.remotePeerId) this.cfg.remotePeerId = msg.peerId;

    // Internal pong for latency measurement
    if (msg.payload['__type'] === 'pong') {
      this._latency = Date.now() - this.pingTs;
      this.fire('latency', this._latency);
      return;
    }

    if (!this.peer || this.peer.destroyed) {
      this.pendingSignals.push(msg.payload);
      if (this._state === 'idle') {
        // Auto-start non-initiator on first incoming signal
        this._createPeer();
      }
      return;
    }

    try {
      this.peer.signal(msg.payload);
    } catch (err) {
      this.fire('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Add a MediaStream to the active peer connection. */
  addStream(stream: MediaStream): void {
    if (!this.peer || this.peer.destroyed) throw new Error('No active peer connection');
    this.peer.addStream(stream);
  }

  /** Send data over the established data channel. */
  send(data: string | Buffer | ArrayBuffer): void {
    if (!this.isConnected || !this.peer) throw new Error('Cannot send: peer not connected');
    this.peer.send(data);
  }

  /** Permanently close the connection. Does not trigger reconnection. */
  destroy(): void {
    this._setState('closed');
    this._clearTimers();
    this._destroyPeer();
    this.removeAllListeners();
  }

  /** Manually trigger a reconnection attempt (resets the retry counter). */
  reconnect(): void {
    if (this._state === 'closed') return;
    this.reconnectCount = 0;
    this._scheduleReconnect(0);
  }

  get currentState(): SignalingState { return this._state; }
  get isConnected(): boolean { return this._state === 'connected'; }
  get latency(): number { return this._latency; }

  // ─── state machine ─────────────────────────────────────────────────────────

  private _setState(next: SignalingState): void {
    if (this._state === next) return;
    const prev = this._state;
    this._state = next;
    this.fire('stateChange', prev, next);
  }

  // ─── peer lifecycle ────────────────────────────────────────────────────────

  private _createPeer(stream?: MediaStream): void {
    this._destroyPeer();
    this._setState('connecting');

    const opts: Record<string, unknown> = {
      initiator: this.cfg.initiator,
      trickle: true,
      config: { iceServers: this.cfg.iceServers },
    };
    if (this.cfg.wrtc) opts['wrtc'] = this.cfg.wrtc;
    if (stream) opts['stream'] = stream;

    this.peer = new this.cfg.PeerClass(opts);
    this._startSignalTimeout();

    this.peer.on('signal', (data: unknown) => {
      this._clearSignalTimeout();
      const msg: SignalMessage = {
        peerId: this.cfg.localPeerId,
        targetPeerId: this.cfg.remotePeerId,
        payload: data as SignalPayload,
        timestamp: Date.now(),
      };
      this.fire('signal', msg);
    });

    this.peer.on('connect', () => {
      this._clearSignalTimeout();
      this._clearReconnectTimer();
      this.reconnectCount = 0;
      this._setState('connected');
      this.fire('connect');
      this._startPingInterval();
    });

    this.peer.on('data', (raw: unknown) => {
      const data = raw instanceof Buffer ? raw.toString() : String(raw);
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (parsed['__type'] === 'ping') {
          this.peer?.send(JSON.stringify({ __type: 'pong', ts: parsed['ts'] }));
          return;
        }
        if (parsed['__type'] === 'pong') {
          this._latency = Date.now() - (parsed['ts'] as number);
          this.fire('latency', this._latency);
          return;
        }
      } catch { /* not a protocol message, pass through */ }
      this.fire('data', data);
    });

    this.peer.on('error', (err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      this.fire('error', e);
      if (this._state !== 'closed' && this._state !== 'failed') this._scheduleReconnect();
    });

    this.peer.on('close', () => {
      this._stopPingInterval();
      if (this._state === 'connected') {
        this.fire('disconnect');
      }
      if (this._state !== 'closed' && this._state !== 'failed') {
        this._scheduleReconnect();
      }
    });

    // Flush any signals that arrived before the peer was ready
    if (this.pendingSignals.length > 0) {
      const pending = this.pendingSignals.splice(0);
      for (const payload of pending) {
        try { this.peer.signal(payload); } catch { /* ignore */ }
      }
    }
  }

  private _destroyPeer(): void {
    if (this.peer && !this.peer.destroyed) {
      this.peer.removeAllListeners();
      this.peer.destroy();
    }
    this.peer = null;
  }

  // ─── reconnection ──────────────────────────────────────────────────────────

  private _scheduleReconnect(delayOverride?: number): void {
    if (this._state === 'closed') return;

    if (this.reconnectCount >= this.cfg.reconnectAttempts) {
      this._setState('failed');
      this.fire(
        'error',
        new Error(
          `WebRTC signaling failed after ${this.cfg.reconnectAttempts} reconnect attempts`
        )
      );
      return;
    }

    const delay =
      delayOverride ?? this.cfg.reconnectDelay * Math.pow(2, this.reconnectCount);
    this.reconnectCount++;
    this._setState('reconnecting');
    this.fire('reconnect', this.reconnectCount);

    this.reconnectTimer = setTimeout(() => {
      if (this._state !== 'closed' && this._state !== 'failed') this._createPeer();
    }, delay);
  }

  // ─── timers ────────────────────────────────────────────────────────────────

  private _startSignalTimeout(): void {
    this._clearSignalTimeout();
    this.signalTimer = setTimeout(() => {
      if (this._state === 'connecting') {
        this.fire(
          'error',
          new Error(`Signaling timeout: no signal received within ${this.cfg.signalTimeout}ms`)
        );
        this._scheduleReconnect();
      }
    }, this.cfg.signalTimeout);
  }

  private _clearSignalTimeout(): void {
    if (this.signalTimer !== null) { clearTimeout(this.signalTimer); this.signalTimer = null; }
  }

  private _clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private _startPingInterval(): void {
    this.pingTimer = setInterval(() => {
      if (this.isConnected && this.peer && !this.peer.destroyed) {
        this.pingTs = Date.now();
        try { this.peer.send(JSON.stringify({ __type: 'ping', ts: this.pingTs })); } catch { /* ok */ }
      }
    }, PING_INTERVAL_MS);
  }

  private _stopPingInterval(): void {
    if (this.pingTimer !== null) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private _clearTimers(): void {
    this._clearSignalTimeout();
    this._clearReconnectTimer();
    this._stopPingInterval();
  }
}

export default SignalingHandler;
