import { create } from 'zustand';
import type { VoicePreset } from '../audio/voiceMasker';

export type VoicePresetName = VoicePreset['name'];

/** Matches the avatar_style CHECK constraint in DATABASE_SCHEMA.sql. */
export type AvatarStyle = 'clay_figure' | 'nature_spirit' | 'origami';

export interface UserPrefsState {
  voicePreset: VoicePresetName;
  avatarStyle: AvatarStyle | null;
  setVoicePreset: (preset: VoicePresetName) => void;
  setAvatarStyle: (style: AvatarStyle) => void;
}

export const useUserPrefsStore = create<UserPrefsState>((set) => ({
  voicePreset: 'warm_hearth',
  avatarStyle: null,
  setVoicePreset: (voicePreset) => set({ voicePreset }),
  setAvatarStyle: (avatarStyle) => set({ avatarStyle }),
}));
