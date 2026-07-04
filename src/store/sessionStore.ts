import { create } from 'zustand';
import type { SignalingState } from '../webrtc/signaling';

export type RoomType = 'blind_confessional' | 'relief_circle' | 'shadow_session';

/** A message as rendered in the UI: already decrypted/masked, never the raw DB row. */
export interface LocalMessage {
  id: string;
  senderId: string;
  text: string;
  sentAt: number;
  fromSelf: boolean;
}

export interface SessionState {
  sessionId: string | null;
  roomType: RoomType | null;
  remotePeerId: string | null;
  connectionState: SignalingState;
  messages: LocalMessage[];
  joinSession: (params: {
    sessionId: string;
    roomType: RoomType;
    remotePeerId?: string;
  }) => void;
  setConnectionState: (state: SignalingState) => void;
  addMessage: (message: LocalMessage) => void;
  leaveSession: () => void;
}

const emptySession = {
  sessionId: null,
  roomType: null,
  remotePeerId: null,
  connectionState: 'idle' as SignalingState,
  messages: [] as LocalMessage[],
};

export const useSessionStore = create<SessionState>((set) => ({
  ...emptySession,
  joinSession: ({ sessionId, roomType, remotePeerId }) =>
    set({
      sessionId,
      roomType,
      remotePeerId: remotePeerId ?? null,
      connectionState: 'idle',
      messages: [],
    }),
  setConnectionState: (connectionState) => set({ connectionState }),
  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  leaveSession: () => set({ ...emptySession }),
}));
