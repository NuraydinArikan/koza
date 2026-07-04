import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore, isAuthenticated } from './authStore';

describe('authStore', () => {
  beforeEach(() => {
    useAuthStore.getState().logout();
  });

  it('starts idle with no user', () => {
    const state = useAuthStore.getState();
    expect(state.status).toBe('idle');
    expect(state.user).toBeNull();
    expect(isAuthenticated(state)).toBe(false);
  });

  it('setLoading moves to loading and clears error', () => {
    useAuthStore.getState().setError('boom');
    useAuthStore.getState().setLoading();
    const state = useAuthStore.getState();
    expect(state.status).toBe('loading');
    expect(state.error).toBeNull();
  });

  it('setUser authenticates and clears a prior error', () => {
    useAuthStore.getState().setError('previous failure');
    useAuthStore.getState().setUser({ id: 'u1', anonHash: 'hash1' });
    const state = useAuthStore.getState();
    expect(state.status).toBe('authenticated');
    expect(state.user).toEqual({ id: 'u1', anonHash: 'hash1' });
    expect(isAuthenticated(state)).toBe(true);
  });

  it('setError records the message and drops out of authenticated status', () => {
    useAuthStore.getState().setUser({ id: 'u1', anonHash: 'hash1' });
    useAuthStore.getState().setError('session expired');
    const state = useAuthStore.getState();
    expect(state.status).toBe('error');
    expect(state.error).toBe('session expired');
    expect(isAuthenticated(state)).toBe(false);
  });

  it('logout resets to idle with no user', () => {
    useAuthStore.getState().setUser({ id: 'u1', anonHash: 'hash1' });
    useAuthStore.getState().logout();
    const state = useAuthStore.getState();
    expect(state.status).toBe('idle');
    expect(state.user).toBeNull();
    expect(state.error).toBeNull();
  });
});
