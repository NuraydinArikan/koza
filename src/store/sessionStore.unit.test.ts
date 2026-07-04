import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from './sessionStore';

describe('sessionStore', () => {
  beforeEach(() => {
    useSessionStore.getState().leaveSession();
  });

  it('starts with no active session', () => {
    const state = useSessionStore.getState();
    expect(state.sessionId).toBeNull();
    expect(state.roomType).toBeNull();
    expect(state.connectionState).toBe('idle');
    expect(state.messages).toEqual([]);
  });

  it('joinSession populates session identity and resets messages', () => {
    useSessionStore.getState().addMessage({
      id: 'stale',
      senderId: 'u0',
      text: 'from a previous session',
      sentAt: 0,
      fromSelf: true,
    });

    useSessionStore.getState().joinSession({
      sessionId: 'session-1',
      roomType: 'blind_confessional',
      remotePeerId: 'peer-2',
    });

    const state = useSessionStore.getState();
    expect(state.sessionId).toBe('session-1');
    expect(state.roomType).toBe('blind_confessional');
    expect(state.remotePeerId).toBe('peer-2');
    expect(state.connectionState).toBe('idle');
    expect(state.messages).toEqual([]);
  });

  it('joinSession defaults remotePeerId to null when omitted', () => {
    useSessionStore.getState().joinSession({
      sessionId: 'session-2',
      roomType: 'relief_circle',
    });
    expect(useSessionStore.getState().remotePeerId).toBeNull();
  });

  it('setConnectionState updates connection state', () => {
    useSessionStore.getState().setConnectionState('connected');
    expect(useSessionStore.getState().connectionState).toBe('connected');
  });

  it('addMessage appends without mutating the previous array', () => {
    const before = useSessionStore.getState().messages;
    useSessionStore.getState().addMessage({
      id: 'm1',
      senderId: 'u1',
      text: 'hello',
      sentAt: 123,
      fromSelf: false,
    });
    const state = useSessionStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages).not.toBe(before);
    expect(state.messages[0]).toEqual({
      id: 'm1',
      senderId: 'u1',
      text: 'hello',
      sentAt: 123,
      fromSelf: false,
    });
  });

  it('leaveSession clears everything back to the initial state', () => {
    useSessionStore.getState().joinSession({ sessionId: 's', roomType: 'shadow_session' });
    useSessionStore.getState().setConnectionState('connected');
    useSessionStore.getState().addMessage({
      id: 'm1',
      senderId: 'u1',
      text: 'hi',
      sentAt: 1,
      fromSelf: true,
    });

    useSessionStore.getState().leaveSession();

    const state = useSessionStore.getState();
    expect(state.sessionId).toBeNull();
    expect(state.roomType).toBeNull();
    expect(state.remotePeerId).toBeNull();
    expect(state.connectionState).toBe('idle');
    expect(state.messages).toEqual([]);
  });
});
