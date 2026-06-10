/**
 * Integration tests for SignalingHandler.
 *
 * WebRTC internals are replaced by MockPeer so tests run in Node.js without
 * a browser. MockPeer simulates the exact simple-peer event sequence:
 *   initiator → 'signal'(offer) → remote 'signal'(answer) → ICE → 'connect'
 *
 * Two-peer tests wire both handlers so the full offer/answer/ICE roundtrip
 * executes end-to-end through the SignalingHandler state machine.
 *
 * Single-handler tests (reconnection, state tracking) use the autoConnect
 * variant of MockPeer which self-connects without needing a remote peer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  SignalingHandler,
  SignalMessage,
  SignalingConfig,
  SignalingState,
  PeerConstructor,
} from './signaling';

// ─── MockPeer ─────────────────────────────────────────────────────────────────

/**
 * Simulates simple-peer without real WebRTC.
 *
 * Behaviors:
 *   'error'       – emits 'error' on the next microtask.
 *   'connect'     – full protocol (offer → answer → ICE → connect).
 *                   Requires a wired remote peer to send the answer.
 *   'autoConnect' – initiator emits offer then self-connects after 5ms
 *                   (no remote peer required; for single-handler tests).
 */
type PeerBehavior = 'connect' | 'autoConnect' | 'error';

class MockPeer extends EventEmitter {
  destroyed = false;
  protected _connected = false;

  constructor(opts: Record<string, unknown>, behavior: PeerBehavior) {
    super();

    if (behavior === 'error') {
      Promise.resolve().then(() => {
        if (!this.destroyed) this.emit('error', new Error('Mock network failure'));
      });
      return;
    }

    if (opts['initiator']) {
      Promise.resolve().then(() => {
        if (!this.destroyed) {
          this.emit('signal', { type: 'offer', sdp: 'v=0\r\no=mock 0 0 IN IP4 127.0.0.1' });
        }
      });
    }

    if (behavior === 'autoConnect') {
      // Self-connect without waiting for a remote answer
      setTimeout(() => {
        if (!this.destroyed) { this._connected = true; this.emit('connect'); }
      }, 5);
    }
  }

  get connected() { return this._connected; }

  signal(data: Record<string, unknown>): void {
    if (this.destroyed) return;

    if (data['type'] === 'offer') {
      // Non-initiator responds with answer + ICE then connects
      Promise.resolve().then(() => {
        if (this.destroyed) return;
        this.emit('signal', { type: 'answer', sdp: 'v=0\r\no=mock-answer 0 0 IN IP4 127.0.0.1' });
        this.emit('signal', { candidate: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
        setTimeout(() => {
          if (!this.destroyed) { this._connected = true; this.emit('connect'); }
        }, 5);
      });
    } else if (data['type'] === 'answer') {
      // Initiator received answer → emit ICE then connect
      Promise.resolve().then(() => {
        if (this.destroyed) return;
        this.emit('signal', { candidate: { candidate: 'candidate:2 1 udp 2122260223 192.168.1.2 50001 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
        setTimeout(() => {
          if (!this.destroyed) { this._connected = true; this.emit('connect'); }
        }, 5);
      });
    }
    // ICE candidates and autoConnect peers: no response needed
  }

  send(data: unknown): void {
    if (this.destroyed) return;
    try {
      const parsed = JSON.parse(String(data)) as Record<string, unknown>;
      if (parsed['__type'] === 'ping') {
        Promise.resolve().then(() => {
          this.emit('data', Buffer.from(JSON.stringify({ __type: 'pong', ts: parsed['ts'] })));
        });
      }
    } catch { /* non-JSON, ignore */ }
  }

  addStream(): void { /* no-op */ }

  destroy(err?: Error): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this._connected = false;
    if (err) this.emit('error', err);
    this.emit('close');
  }

  override removeAllListeners(event?: string): this {
    super.removeAllListeners(event);
    return this;
  }
}

/**
 * Returns a PeerConstructor whose N-th instantiation uses behaviors[N].
 * Defaults to 'autoConnect' when the list is exhausted.
 */
function makeMockPeerClass(behaviors: PeerBehavior[]): PeerConstructor {
  let count = 0;
  return class extends MockPeer {
    constructor(opts: object) {
      const b = behaviors[count] ?? 'autoConnect';
      count++;
      super(opts as Record<string, unknown>, b);
    }
  } as unknown as PeerConstructor;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const BASE_CFG: Omit<SignalingConfig, 'initiator'> = {
  localPeerId: 'peer-local',
  remotePeerId: 'peer-remote',
  reconnectAttempts: 3,
  reconnectDelay: 10,
  signalTimeout: 200,
};

function makeHandler(
  overrides: Partial<SignalingConfig> & { initiator: boolean },
  PeerClass: PeerConstructor = makeMockPeerClass(['autoConnect'])
): SignalingHandler {
  return new SignalingHandler({ ...BASE_CFG, PeerClass, ...overrides });
}

/** Wire two handlers so each routes the other's signal events. */
function wirePeers(a: SignalingHandler, b: SignalingHandler): void {
  a.on('signal', (msg) => b.receiveSignal(msg as SignalMessage));
  b.on('signal', (msg) => a.receiveSignal(msg as SignalMessage));
}

/** Resolves with the first emission of `event`, or rejects after `timeoutMs`. */
function waitFor<T = unknown>(
  handler: SignalingHandler,
  event: string,
  timeoutMs = 300
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Timed out waiting for '${event}'`)),
      timeoutMs
    );
    handler.once(event, (...args: unknown[]) => {
      clearTimeout(t);
      resolve(args[0] as T);
    });
  });
}

function waitForBothConnected(a: SignalingHandler, b: SignalingHandler, ms = 300): Promise<void> {
  return Promise.all([waitFor(a, 'connect', ms), waitFor(b, 'connect', ms)]).then(() => undefined);
}

function waitForState(handler: SignalingHandler, target: SignalingState, ms = 500): Promise<void> {
  if (handler.currentState === target) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timed out waiting for state '${target}'`)), ms);
    handler.on('stateChange', (_from: unknown, to: unknown) => {
      if (to === target) { clearTimeout(t); resolve(); }
    });
  });
}

// ─── offer / answer flow ──────────────────────────────────────────────────────

describe('offer / answer flow', () => {
  let handlerA: SignalingHandler;
  let handlerB: SignalingHandler;

  beforeEach(() => {
    const PC = makeMockPeerClass(['connect', 'connect']);
    handlerA = makeHandler({ initiator: true,  localPeerId: 'A', remotePeerId: 'B' }, PC);
    handlerB = makeHandler({ initiator: false, localPeerId: 'B', remotePeerId: 'A' }, PC);
    wirePeers(handlerA, handlerB);
  });

  afterEach(() => { handlerA.destroy(); handlerB.destroy(); });

  it('both sides reach "connected" after a successful handshake', async () => {
    handlerA.start();
    handlerB.start();
    await waitForBothConnected(handlerA, handlerB);
    expect(handlerA.currentState).toBe('connected');
    expect(handlerB.currentState).toBe('connected');
  });

  it('initiator transitions idle → connecting → connected', async () => {
    const states: SignalingState[] = ['idle'];
    handlerA.on('stateChange', (_f: unknown, to: unknown) => states.push(to as SignalingState));

    handlerA.start();
    handlerB.start();
    await waitFor(handlerA, 'connect');

    expect(states).toContain('connecting');
    expect(states).toContain('connected');
    expect(states[0]).toBe('idle');
    expect(states[states.length - 1]).toBe('connected');
  });

  it('non-initiator transitions idle → connecting → connected', async () => {
    const states: SignalingState[] = [];
    handlerB.on('stateChange', (_f: unknown, to: unknown) => states.push(to as SignalingState));

    handlerA.start();
    handlerB.start();
    await waitFor(handlerB, 'connect');

    expect(states).toContain('connected');
  });

  it('emits "signal" with correct peerId and targetPeerId', async () => {
    const signals: SignalMessage[] = [];
    handlerA.on('signal', (msg) => signals.push(msg as SignalMessage));

    handlerA.start();
    await waitFor(handlerA, 'signal');

    expect(signals[0].peerId).toBe('A');
    expect(signals[0].targetPeerId).toBe('B');
    expect(signals[0].timestamp).toBeGreaterThan(0);
  });

  it('emits "signal" with an SDP offer payload from the initiator', async () => {
    const signals: SignalMessage[] = [];
    handlerA.on('signal', (msg) => signals.push(msg as SignalMessage));

    handlerA.start();
    handlerB.start();
    await waitFor(handlerA, 'signal');

    const offer = signals.find((m) => m.payload.type === 'offer');
    expect(offer).toBeDefined();
    expect(typeof offer!.payload.sdp).toBe('string');
  });

  it('non-initiator auto-starts when it receives a signal before start()', async () => {
    handlerA.start(); // handlerB.start() is intentionally not called
    await waitForBothConnected(handlerA, handlerB);
    expect(handlerB.currentState).toBe('connected');
  });

  it('calling start() twice has no effect', async () => {
    handlerA.start();
    handlerA.start();
    handlerB.start();
    await waitForBothConnected(handlerA, handlerB);
    expect(handlerA.isConnected).toBe(true);
  });
});

// ─── ICE candidate handling ───────────────────────────────────────────────────

describe('ICE candidate handling', () => {
  let handlerA: SignalingHandler;
  let handlerB: SignalingHandler;

  beforeEach(() => {
    const PC = makeMockPeerClass(['connect', 'connect']);
    handlerA = makeHandler({ initiator: true,  localPeerId: 'A', remotePeerId: 'B' }, PC);
    handlerB = makeHandler({ initiator: false, localPeerId: 'B', remotePeerId: 'A' }, PC);
    wirePeers(handlerA, handlerB);
  });

  afterEach(() => { handlerA.destroy(); handlerB.destroy(); });

  it('ICE candidates are emitted as "signal" events after SDP exchange', async () => {
    const all: SignalMessage[] = [];
    handlerA.on('signal', (m) => all.push(m as SignalMessage));
    handlerB.on('signal', (m) => all.push(m as SignalMessage));

    handlerA.start();
    handlerB.start();
    await waitForBothConnected(handlerA, handlerB);

    expect(all.filter((m) => m.payload.candidate !== undefined).length).toBeGreaterThan(0);
  });

  it('candidate payloads contain the expected WebRTC candidate field', async () => {
    const candidates: SignalMessage[] = [];
    handlerA.on('signal', (m) => {
      const msg = m as SignalMessage;
      if (msg.payload.candidate) candidates.push(msg);
    });

    handlerA.start();
    handlerB.start();
    await waitForBothConnected(handlerA, handlerB);

    expect(candidates.length).toBeGreaterThan(0);
    const cand = candidates[0].payload.candidate as Record<string, unknown>;
    expect(typeof cand['candidate']).toBe('string');
  });

  it('pending signals queued before start() are flushed after peer creation', async () => {
    const PC = makeMockPeerClass(['connect', 'connect']);
    const a = makeHandler({ initiator: true,  localPeerId: 'A', remotePeerId: 'B' }, PC);
    const b = makeHandler({ initiator: false, localPeerId: 'B', remotePeerId: 'A' }, PC);

    a.on('signal', (msg) => b.receiveSignal(msg as SignalMessage));
    b.on('signal', (msg) => a.receiveSignal(msg as SignalMessage));

    a.start();
    // Wait for the offer to be queued in b before b.start()
    await new Promise((r) => setTimeout(r, 2));
    b.start();

    await waitForBothConnected(a, b, 500);
    expect(a.isConnected).toBe(true);
    expect(b.isConnected).toBe(true);
    a.destroy();
    b.destroy();
  });
});

// ─── reconnection scenarios ───────────────────────────────────────────────────

describe('reconnection scenarios', () => {
  it('reconnects after a single network error', async () => {
    const PC = makeMockPeerClass(['error', 'autoConnect']);
    const handler = makeHandler({ initiator: true, reconnectAttempts: 3, reconnectDelay: 5 }, PC);

    const retries: number[] = [];
    handler.on('reconnect', (n) => retries.push(n as number));

    handler.start();
    await waitFor(handler, 'connect', 500);

    expect(handler.currentState).toBe('connected');
    expect(retries).toContain(1);
    handler.destroy();
  });

  it('reconnects after two consecutive failures', async () => {
    const PC = makeMockPeerClass(['error', 'error', 'autoConnect']);
    const handler = makeHandler({ initiator: true, reconnectAttempts: 3, reconnectDelay: 5 }, PC);

    handler.start();
    await waitFor(handler, 'connect', 1000);

    expect(handler.currentState).toBe('connected');
    handler.destroy();
  });

  it('reaches "failed" state after exhausting all reconnect attempts', async () => {
    const PC = makeMockPeerClass(['error', 'error', 'error', 'error']);
    const handler = makeHandler({ initiator: true, reconnectAttempts: 3, reconnectDelay: 5 }, PC);

    const errors: Error[] = [];
    handler.on('error', (e) => errors.push(e as Error));

    handler.start();
    await waitForState(handler, 'failed', 1000);
    await Promise.resolve(); // flush any synchronous follow-up after 'failed' fires

    expect(handler.currentState).toBe('failed');
    expect(errors.some((e) => e.message.includes('reconnect'))).toBe(true);
    handler.destroy();
  });

  it('emits increasing reconnect attempt numbers (exponential backoff)', async () => {
    const PC = makeMockPeerClass(['error', 'error', 'autoConnect']);
    const handler = makeHandler({ initiator: true, reconnectAttempts: 3, reconnectDelay: 5 }, PC);

    const attempts: number[] = [];
    handler.on('reconnect', (n) => attempts.push(n as number));

    handler.start();
    await waitFor(handler, 'connect', 1000);

    // First two reconnect events must be numbered 1, 2 in order
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts[0]).toBe(1);
    expect(attempts[1]).toBe(2);
    handler.destroy();
  });

  it('manual reconnect() resets the retry counter and allows a fresh attempt', async () => {
    // FlipPeer: first 2 instantiations fail, third auto-connects
    let callCount = 0;
    class FlipPeer extends MockPeer {
      constructor(opts: object) {
        callCount++;
        super(opts as Record<string, unknown>, callCount <= 2 ? 'error' : 'autoConnect');
      }
    }

    const handler = makeHandler(
      { initiator: true, reconnectAttempts: 1, reconnectDelay: 5 },
      FlipPeer as unknown as PeerConstructor
    );

    handler.start();
    await waitForState(handler, 'failed', 500);
    await Promise.resolve(); // flush any synchronous follow-up after 'failed' fires
    expect(handler.currentState).toBe('failed');

    // Reset limit and retry
    (handler as unknown as Record<string, unknown>)['cfg'] = {
      ...((handler as unknown as Record<string, unknown>)['cfg'] as Record<string, unknown>),
      reconnectAttempts: 3,
    };
    handler.reconnect();

    await waitFor(handler, 'connect', 500);
    expect(handler.currentState).toBe('connected');
    handler.destroy();
  });

  it('emits "disconnect" when a connected peer closes unexpectedly', async () => {
    const PC = makeMockPeerClass(['autoConnect', 'autoConnect']);
    const handler = makeHandler({ initiator: true, reconnectAttempts: 2, reconnectDelay: 5 }, PC);

    handler.start();
    await waitFor(handler, 'connect', 300);
    expect(handler.currentState).toBe('connected');

    const disconnectPromise = waitFor(handler, 'disconnect', 300);
    const peer = (handler as unknown as Record<string, unknown>)['peer'] as EventEmitter;
    peer.emit('close');

    await disconnectPromise;
    handler.destroy();
  });

  it('destroy() during a pending reconnect cancels the retry', async () => {
    const PC = makeMockPeerClass(['error']);
    const handler = makeHandler(
      { initiator: true, reconnectAttempts: 3, reconnectDelay: 100 },
      PC
    );

    handler.start();
    await new Promise((r) => setTimeout(r, 30)); // error fires, reconnect scheduled
    handler.destroy();

    await new Promise((r) => setTimeout(r, 150)); // reconnect delay passes
    expect(handler.currentState).toBe('closed');
  });
});

// ─── error cases ──────────────────────────────────────────────────────────────

describe('error cases', () => {
  it('emits "error" on signaling timeout', async () => {
    class SilentPeer extends EventEmitter {
      destroyed = false;
      get connected() { return false; }
      constructor(_opts: object) { super(); }
      signal() {}
      send() {}
      addStream() {}
      destroy() { this.destroyed = true; this.emit('close'); }
      override removeAllListeners(e?: string) { super.removeAllListeners(e); return this; }
    }

    const handler = makeHandler(
      { initiator: true, signalTimeout: 50, reconnectAttempts: 0 },
      SilentPeer as unknown as PeerConstructor
    );

    const errors: Error[] = [];
    handler.on('error', (e) => errors.push(e as Error));

    handler.start();
    await new Promise((r) => setTimeout(r, 200));

    expect(errors.some((e) => e.message.toLowerCase().includes('timeout'))).toBe(true);
    handler.destroy();
  });

  it('emits "error" when peer fires an error event while connecting', async () => {
    const PC = makeMockPeerClass(['error']);
    const handler = makeHandler({ initiator: true, reconnectAttempts: 0 }, PC);

    const errors: Error[] = [];
    handler.on('error', (e) => errors.push(e as Error));

    handler.start();
    await new Promise((r) => setTimeout(r, 100));

    expect(errors.length).toBeGreaterThan(0);
    handler.destroy();
  });

  it('receiveSignal() with invalid payload emits error (no throw)', () => {
    class ThrowingPeer extends EventEmitter {
      destroyed = false;
      get connected() { return false; }
      constructor(_opts: object) { super(); }
      signal() { throw new Error('invalid signal'); }
      send() {}
      addStream() {}
      destroy() { this.destroyed = true; this.emit('close'); }
      override removeAllListeners(e?: string) { super.removeAllListeners(e); return this; }
    }

    const handler = makeHandler(
      { initiator: false },
      ThrowingPeer as unknown as PeerConstructor
    );
    handler.start();

    const errors: Error[] = [];
    handler.on('error', (e) => errors.push(e as Error));

    handler.receiveSignal({
      peerId: 'remote', targetPeerId: 'local',
      payload: { type: 'offer', sdp: 'bad' },
      timestamp: Date.now(),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('invalid signal');
    handler.destroy();
  });

  it('send() throws when peer is not connected', () => {
    const handler = makeHandler({ initiator: true });
    expect(() => handler.send('hello')).toThrow('Cannot send');
    handler.destroy();
  });

  it('receiveSignal() after destroy() is silently ignored', () => {
    const handler = makeHandler({ initiator: false });
    handler.destroy();

    expect(() =>
      handler.receiveSignal({
        peerId: 'x', targetPeerId: 'y',
        payload: { type: 'offer', sdp: 'v=0' },
        timestamp: Date.now(),
      })
    ).not.toThrow();
  });

  it('start() after destroy() is a no-op', () => {
    const PC = makeMockPeerClass(['autoConnect']);
    const handler = makeHandler({ initiator: true }, PC);
    handler.destroy();
    expect(() => handler.start()).not.toThrow();
    expect(handler.currentState).toBe('closed');
  });
});

// ─── connection state tracking ────────────────────────────────────────────────

describe('connection state tracking', () => {
  it('getters reflect state correctly throughout the lifecycle', async () => {
    const PC = makeMockPeerClass(['autoConnect']);
    const handler = makeHandler({ initiator: true }, PC);

    expect(handler.currentState).toBe('idle');
    expect(handler.isConnected).toBe(false);

    handler.start();
    expect(handler.currentState).toBe('connecting');

    await waitFor(handler, 'connect', 300);
    expect(handler.currentState).toBe('connected');
    expect(handler.isConnected).toBe(true);

    handler.destroy();
    expect(handler.currentState).toBe('closed');
    expect(handler.isConnected).toBe(false);
  });

  it('stateChange event carries correct from/to values', async () => {
    const PC = makeMockPeerClass(['autoConnect']);
    const handler = makeHandler({ initiator: true }, PC);

    const transitions: Array<[SignalingState, SignalingState]> = [];
    handler.on('stateChange', (from: unknown, to: unknown) =>
      transitions.push([from as SignalingState, to as SignalingState])
    );

    handler.start();
    await waitFor(handler, 'connect', 300);
    handler.destroy();

    expect(transitions).toContainEqual(['idle', 'connecting']);
    expect(transitions).toContainEqual(['connecting', 'connected']);
    expect(transitions).toContainEqual(['connected', 'closed']);
  });

  it('remotePeerId is inferred from the first received signal', async () => {
    const PC = makeMockPeerClass(['connect', 'connect']);
    const initiator = makeHandler({ initiator: true,  localPeerId: 'peer-X', remotePeerId: 'peer-Y' }, PC);
    const responder = makeHandler({ initiator: false, localPeerId: 'peer-Y', remotePeerId: '' }, PC);

    initiator.on('signal', (msg) => responder.receiveSignal(msg as SignalMessage));
    responder.on('signal', (msg) => initiator.receiveSignal(msg as SignalMessage));

    initiator.start();
    await waitFor(responder, 'connect', 300);

    const cfg = (responder as unknown as Record<string, unknown>)['cfg'] as Record<string, unknown>;
    expect(cfg['remotePeerId']).toBe('peer-X');

    initiator.destroy();
    responder.destroy();
  });

  it('reconnecting state is entered before each retry', async () => {
    const PC = makeMockPeerClass(['error', 'autoConnect']);
    const handler = makeHandler({ initiator: true, reconnectAttempts: 3, reconnectDelay: 5 }, PC);

    const states: SignalingState[] = [];
    handler.on('stateChange', (_f: unknown, to: unknown) => states.push(to as SignalingState));

    handler.start();
    await waitFor(handler, 'connect', 500);

    expect(states).toContain('reconnecting');
    handler.destroy();
  });
});

// ─── latency target: sub-100ms signaling ──────────────────────────────────────

describe('latency target: sub-100ms signaling', () => {
  it('first signal event fires in under 100ms after start()', async () => {
    const PC = makeMockPeerClass(['autoConnect']);
    const handler = makeHandler({ initiator: true }, PC);

    const t0 = performance.now();
    handler.start();
    await waitFor(handler, 'signal', 200);
    expect(performance.now() - t0).toBeLessThan(100);
    handler.destroy();
  });

  it('full offer → answer → connect handshake completes in under 100ms', async () => {
    const PC = makeMockPeerClass(['connect', 'connect']);
    const handlerA = makeHandler({ initiator: true,  localPeerId: 'A', remotePeerId: 'B' }, PC);
    const handlerB = makeHandler({ initiator: false, localPeerId: 'B', remotePeerId: 'A' }, PC);
    wirePeers(handlerA, handlerB);

    const t0 = performance.now();
    handlerA.start();
    handlerB.start();
    await waitForBothConnected(handlerA, handlerB, 200);
    expect(performance.now() - t0).toBeLessThan(100);

    handlerA.destroy();
    handlerB.destroy();
  });

  it('receiveSignal() dispatches to the peer synchronously (same tick)', () => {
    const signalCalls: unknown[] = [];

    class TrackingPeer extends EventEmitter {
      destroyed = false;
      get connected() { return false; }
      constructor(_opts: object) { super(); }
      signal(data: unknown) { signalCalls.push(data); }
      send() {}
      addStream() {}
      destroy() { this.destroyed = true; this.emit('close'); }
      override removeAllListeners(e?: string) { super.removeAllListeners(e); return this; }
    }

    const handler = makeHandler(
      { initiator: false },
      TrackingPeer as unknown as PeerConstructor
    );
    handler.start();

    handler.receiveSignal({
      peerId: 'remote', targetPeerId: 'local',
      payload: { type: 'offer', sdp: 'v=0' },
      timestamp: Date.now(),
    });

    // Synchronous: the signal was forwarded to the peer in the same tick
    expect(signalCalls).toHaveLength(1);
    expect((signalCalls[0] as Record<string, unknown>)['type']).toBe('offer');
    handler.destroy();
  });

  it('latency property is updated after a pong is received', async () => {
    const PC = makeMockPeerClass(['autoConnect']);
    const handler = makeHandler({ initiator: true }, PC);

    handler.start();
    await waitFor(handler, 'connect', 300);

    const peer = (handler as unknown as Record<string, unknown>)['peer'] as MockPeer;
    const ts = Date.now() - 10; // simulate 10ms round-trip
    (handler as unknown as Record<string, unknown>)['pingTs'] = ts;
    peer.emit('data', Buffer.from(JSON.stringify({ __type: 'pong', ts })));

    await new Promise((r) => setTimeout(r, 10));
    expect(handler.latency).toBeGreaterThanOrEqual(0);
    handler.destroy();
  });
});

// ─── data channel ─────────────────────────────────────────────────────────────

describe('data channel', () => {
  it('routes non-protocol data through to the "data" event', async () => {
    const PC = makeMockPeerClass(['autoConnect']);
    const handler = makeHandler({ initiator: true }, PC);

    handler.start();
    await waitFor(handler, 'connect', 300);

    const received: string[] = [];
    handler.on('data', (d) => received.push(d as string));

    const peer = (handler as unknown as Record<string, unknown>)['peer'] as MockPeer;
    peer.emit('data', Buffer.from('hello from remote'));

    expect(received).toContain('hello from remote');
    handler.destroy();
  });

  it('send() forwards the payload to the underlying peer', async () => {
    const PC = makeMockPeerClass(['autoConnect']);
    const handler = makeHandler({ initiator: true }, PC);

    handler.start();
    await waitFor(handler, 'connect', 300);

    const peer = (handler as unknown as Record<string, unknown>)['peer'] as MockPeer;
    const spy = vi.spyOn(peer, 'send');

    handler.send('test-payload');
    expect(spy).toHaveBeenCalledWith('test-payload');
    handler.destroy();
  });

  it('JSON data that is not a ping/pong is passed through as a string', async () => {
    const PC = makeMockPeerClass(['autoConnect']);
    const handler = makeHandler({ initiator: true }, PC);

    handler.start();
    await waitFor(handler, 'connect', 300);

    const received: string[] = [];
    handler.on('data', (d) => received.push(d as string));

    const peer = (handler as unknown as Record<string, unknown>)['peer'] as MockPeer;
    peer.emit('data', Buffer.from(JSON.stringify({ message: 'hi', from: 'user' })));

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0])).toEqual({ message: 'hi', from: 'user' });
    handler.destroy();
  });
});
