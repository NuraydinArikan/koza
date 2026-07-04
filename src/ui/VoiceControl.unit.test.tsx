// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { VoiceControl } from './VoiceControl';
import { useUserPrefsStore } from '../store/userPrefsStore';

// ─── Web Audio / mic mocks ─────────────────────────────────────────────────

class MockAudioContext {
  sampleRate = 44100;
  destination = {};
  close = vi.fn();
  createMediaStreamSource = vi.fn().mockReturnValue({ connect: vi.fn(), disconnect: vi.fn() });
  createScriptProcessor = vi.fn().mockReturnValue({
    connect: vi.fn(),
    disconnect: vi.fn(),
    onaudioprocess: null,
  });
}

function fakeStream() {
  const track = { stop: vi.fn() };
  return { getTracks: () => [track], _track: track };
}

describe('VoiceControl', () => {
  beforeEach(() => {
    useUserPrefsStore.setState({ voicePreset: 'warm_hearth', avatarStyle: null });
    vi.stubGlobal('AudioContext', MockAudioContext);
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn().mockResolvedValue(fakeStream()) },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders preset options and a start button, nothing active yet', () => {
    render(<VoiceControl />);
    expect(screen.getByRole('radio', { name: 'warm_hearth' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'gentle_breeze' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: /start voice masking/i })).toBeInTheDocument();
  });

  it('requests the microphone and switches to the Stop button on success', async () => {
    render(<VoiceControl />);
    fireEvent.click(screen.getByRole('button', { name: /start voice masking/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^stop$/i })).toBeInTheDocument()
    );
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  it('stops the stream, masker, and audio context when Stop is clicked', async () => {
    const stream = fakeStream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(stream as unknown as MediaStream);

    render(<VoiceControl />);
    fireEvent.click(screen.getByRole('button', { name: /start voice masking/i }));
    await waitFor(() => screen.getByRole('button', { name: /^stop$/i }));

    fireEvent.click(screen.getByRole('button', { name: /^stop$/i }));

    expect(stream._track.stop).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /start voice masking/i })).toBeInTheDocument();
  });

  it('shows an error message when microphone permission is denied', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(
      new Error('Permission denied')
    );

    render(<VoiceControl />);
    fireEvent.click(screen.getByRole('button', { name: /start voice masking/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Permission denied'));
    expect(screen.getByRole('button', { name: /start voice masking/i })).toBeInTheDocument();
  });

  it('persists the selected preset to userPrefsStore', () => {
    render(<VoiceControl />);
    fireEvent.click(screen.getByRole('radio', { name: 'velvet_echo' }));
    expect(useUserPrefsStore.getState().voicePreset).toBe('velvet_echo');
  });
});
