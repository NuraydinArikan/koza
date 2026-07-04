import { create } from 'zustand';

export interface AuthUser {
  id: string;
  anonHash: string;
}

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'error';

export interface AuthState {
  user: AuthUser | null;
  status: AuthStatus;
  error: string | null;
  setLoading: () => void;
  setUser: (user: AuthUser) => void;
  setError: (message: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  status: 'idle',
  error: null,
  setLoading: () => set({ status: 'loading', error: null }),
  setUser: (user) => set({ user, status: 'authenticated', error: null }),
  setError: (message) => set({ status: 'error', error: message }),
  logout: () => set({ user: null, status: 'idle', error: null }),
}));

/** True only once a user is both authenticated and present. */
export function isAuthenticated(state: Pick<AuthState, 'status' | 'user'>): boolean {
  return state.status === 'authenticated' && state.user !== null;
}
