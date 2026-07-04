// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { Onboarding } from './Onboarding';
import { useAuthStore } from '../store/authStore';
import { useUserPrefsStore } from '../store/userPrefsStore';
import { getOrCreateDeviceIdentity, registerUser, type SupabaseLike } from '../api/auth';
import { generateEmbedding } from '../lib/embeddings';

vi.mock('../api/auth', () => ({
  getOrCreateDeviceIdentity: vi.fn(),
  registerUser: vi.fn(),
}));
vi.mock('../lib/embeddings', () => ({
  generateEmbedding: vi.fn(),
}));

const mockSupabase = {} as SupabaseLike;
const SECRET = 'a'.repeat(64);
const ANON_HASH = 'b'.repeat(64);

function fillAnswers() {
  const textareas = screen.getAllByRole('textbox');
  fireEvent.change(textareas[0], { target: { value: 'Answer one' } });
  fireEvent.change(textareas[1], { target: { value: 'Answer two' } });
}

describe('Onboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().logout();
    useUserPrefsStore.setState({ voicePreset: 'warm_hearth', avatarStyle: null });
  });

  afterEach(() => {
    cleanup();
  });

  it('disables submit until both questions are answered', () => {
    render(<Onboarding supabase={mockSupabase} embeddingEndpoint="https://example.test/embed" />);
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    fillAnswers();
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled();
  });

  it('submits the flow and shows the recovery code on success', async () => {
    vi.mocked(getOrCreateDeviceIdentity).mockResolvedValue({ secret: SECRET, anonHash: ANON_HASH });
    vi.mocked(generateEmbedding).mockResolvedValue(new Array(1536).fill(0.1));
    vi.mocked(registerUser).mockResolvedValue({
      id: 'user-1',
      anonHash: ANON_HASH,
      voicePreset: 'warm_hearth',
      avatarStyle: 'clay_figure',
    });

    render(<Onboarding supabase={mockSupabase} embeddingEndpoint="https://example.test/embed" />);
    fillAnswers();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(screen.getByText(/save your recovery code/i)).toBeInTheDocument());
    expect(screen.getByText(SECRET)).toBeInTheDocument();
    expect(useAuthStore.getState().user).toEqual({ id: 'user-1', anonHash: ANON_HASH });
    expect(useAuthStore.getState().status).toBe('authenticated');
    expect(useUserPrefsStore.getState().voicePreset).toBe('warm_hearth');
    expect(useUserPrefsStore.getState().avatarStyle).toBe('clay_figure');
  });

  it('shows an error message and records it in authStore when registration fails', async () => {
    vi.mocked(getOrCreateDeviceIdentity).mockResolvedValue({ secret: SECRET, anonHash: ANON_HASH });
    vi.mocked(generateEmbedding).mockResolvedValue(new Array(1536).fill(0.1));
    vi.mocked(registerUser).mockRejectedValue(new Error('network failure'));

    render(<Onboarding supabase={mockSupabase} embeddingEndpoint="https://example.test/embed" />);
    fillAnswers();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('network failure'));
    expect(useAuthStore.getState().status).toBe('error');
    expect(useAuthStore.getState().error).toBe('network failure');
  });

  it('does not submit while a question is still blank', () => {
    render(<Onboarding supabase={mockSupabase} embeddingEndpoint="https://example.test/embed" />);
    const textareas = screen.getAllByRole('textbox');
    fireEvent.change(textareas[0], { target: { value: 'Only one answered' } });

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(getOrCreateDeviceIdentity).not.toHaveBeenCalled();
  });
});
