import { describe, it, expect, vi, beforeEach } from 'vitest';

const pushMock = vi.fn();
const onChildAddedMock = vi.fn();
const unsubscribeMock = vi.fn();

vi.mock('firebase/database', () => ({
  ref: vi.fn((_db: unknown, path: string) => ({ __path: path })),
  push: (...args: unknown[]) => {
    pushMock(...args);
    return Promise.resolve();
  },
  onChildAdded: (...args: unknown[]) => {
    onChildAddedMock(...args);
    return unsubscribeMock;
  },
  serverTimestamp: () => '__SERVER_TIMESTAMP__',
}));

import { attachSignalingRelay } from './signalingRelay';
import { SignalingHandler, type PeerConstructor, type SignalMessage } from './signaling';

/** Emits a fake SDP offer signal shortly after construction, like simple-peer's initiator flow. */
class FakeInitiatorPeer {
  private listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  destroyed = false;
  connected = false;

  constructor() {
    queueMicrotask(() => this.emit('signal', { type: 'offer', sdp: 'fake-sdp' }));
  }

  on(event: string, fn: (...a: unknown[]) => void) {
    (this.listeners[event] ??= []).push(fn);
    return this;
  }
  off(event: string, fn: (...a: unknown[]) => void) {
    this.listeners[event] = (this.listeners[event] ?? []).filter((f) => f !== fn);
    return this;
  }
  once(event: string, fn: (...a: unknown[]) => void) {
    const wrapped = (...a: unknown[]) => {
      this.off(event, wrapped);
      fn(...a);
    };
    return this.on(event, wrapped);
  }
  removeAllListeners() {
    this.listeners = {};
    return this;
  }
  signal() {}
  send() {}
  addStream() {}
  destroy() {
    this.destroyed = true;
  }

  private emit(event: string, ...args: unknown[]) {
    for (const fn of this.listeners[event] ?? []) fn(...args);
  }
}

const fakeDb = {} as Parameters<typeof attachSignalingRelay>[0];

describe('attachSignalingRelay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards outgoing signal events to the target peer inbox', async () => {
    const handler = new SignalingHandler({
      localPeerId: 'alice',
      remotePeerId: 'bob',
      initiator: true,
      PeerClass: FakeInitiatorPeer as unknown as PeerConstructor,
    });
    attachSignalingRelay(fakeDb, 'session-1', 'alice', handler);
    handler.start();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pushMock).toHaveBeenCalledTimes(1);
    const [refArg, valueArg] = pushMock.mock.calls[0] as [{ __path: string }, SignalMessage];
    expect(refArg).toEqual({ __path: 'signaling/session-1/bob' });
    expect(valueArg).toMatchObject({
      peerId: 'alice',
      targetPeerId: 'bob',
      payload: { type: 'offer', sdp: 'fake-sdp' },
    });
  });

  it('subscribes to the local peer inbox path', () => {
    const handler = new SignalingHandler({ localPeerId: 'alice', initiator: false });
    attachSignalingRelay(fakeDb, 'session-1', 'alice', handler);

    expect(onChildAddedMock).toHaveBeenCalledTimes(1);
    const [inboxRef] = onChildAddedMock.mock.calls[0] as [{ __path: string }];
    expect(inboxRef).toEqual({ __path: 'signaling/session-1/alice' });
  });

  it('feeds incoming messages from other peers into receiveSignal', () => {
    const handler = new SignalingHandler({
      localPeerId: 'alice',
      initiator: false,
      // receiveSignal() auto-starts a peer for the first incoming signal;
      // use the fake so that doesn't require real WebRTC support.
      PeerClass: FakeInitiatorPeer as unknown as PeerConstructor,
    });
    const receiveSignalSpy = vi.spyOn(handler, 'receiveSignal');
    attachSignalingRelay(fakeDb, 'session-1', 'alice', handler);

    const onChildAddedCallback = onChildAddedMock.mock.calls[0][1] as (snapshot: {
      val(): unknown;
    }) => void;
    const incoming: SignalMessage = {
      peerId: 'bob',
      targetPeerId: 'alice',
      payload: { type: 'answer', sdp: 'fake-answer' },
      timestamp: 456,
    };
    onChildAddedCallback({ val: () => incoming });

    expect(receiveSignalSpy).toHaveBeenCalledWith(incoming);
  });

  it('ignores self-authored inbox entries', () => {
    const handler = new SignalingHandler({ localPeerId: 'alice', initiator: false });
    const receiveSignalSpy = vi.spyOn(handler, 'receiveSignal');
    attachSignalingRelay(fakeDb, 'session-1', 'alice', handler);

    const onChildAddedCallback = onChildAddedMock.mock.calls[0][1] as (snapshot: {
      val(): unknown;
    }) => void;
    onChildAddedCallback({
      val: () => ({ peerId: 'alice', targetPeerId: 'alice', payload: {}, timestamp: 1 }),
    });

    expect(receiveSignalSpy).not.toHaveBeenCalled();
  });

  it('stop() unsubscribes from Firebase and stops forwarding signal events', async () => {
    const handler = new SignalingHandler({
      localPeerId: 'alice',
      remotePeerId: 'bob',
      initiator: true,
      PeerClass: FakeInitiatorPeer as unknown as PeerConstructor,
    });
    const relay = attachSignalingRelay(fakeDb, 'session-1', 'alice', handler);

    relay.stop();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);

    handler.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pushMock).not.toHaveBeenCalled();
  });
});
