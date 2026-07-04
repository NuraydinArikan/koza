import { describe, it, expect, beforeEach } from 'vitest';
import { useUserPrefsStore } from './userPrefsStore';

describe('userPrefsStore', () => {
  beforeEach(() => {
    useUserPrefsStore.setState({ voicePreset: 'warm_hearth', avatarStyle: null });
  });

  it('defaults to warm_hearth voice preset and no avatar style', () => {
    const state = useUserPrefsStore.getState();
    expect(state.voicePreset).toBe('warm_hearth');
    expect(state.avatarStyle).toBeNull();
  });

  it('setVoicePreset updates the selected preset', () => {
    useUserPrefsStore.getState().setVoicePreset('velvet_echo');
    expect(useUserPrefsStore.getState().voicePreset).toBe('velvet_echo');
  });

  it('setAvatarStyle updates the selected style', () => {
    useUserPrefsStore.getState().setAvatarStyle('nature_spirit');
    expect(useUserPrefsStore.getState().avatarStyle).toBe('nature_spirit');
  });
});
