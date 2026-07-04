import { useEffect, useRef, useState } from 'react';
import { VoiceMasker, VOICE_PRESETS } from '../audio/voiceMasker';
import { useUserPrefsStore, type VoicePresetName } from '../store/userPrefsStore';

const VOICE_PRESET_NAMES = Object.keys(VOICE_PRESETS) as VoicePresetName[];
const METRICS_POLL_MS = 500;

type Status = 'idle' | 'requesting' | 'active' | 'error';

type VoiceMetrics = ReturnType<VoiceMasker['getMetrics']>;

export interface VoiceControlProps {
  /** Called with the masked (never raw) audio once masking is active - e.g. to feed a peer connection. */
  onStreamReady?: (stream: MediaStream) => void;
  /** Called when masking stops, for any reason (user action, error, unmount). */
  onStreamEnded?: () => void;
}

export function VoiceControl({ onStreamReady, onStreamEnded }: VoiceControlProps = {}) {
  const voicePreset = useUserPrefsStore((s) => s.voicePreset);
  const setVoicePreset = useUserPrefsStore((s) => s.setVoicePreset);

  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<VoiceMetrics | null>(null);

  const maskerRef = useRef<VoiceMasker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const metricsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function teardown() {
    if (metricsIntervalRef.current !== null) {
      clearInterval(metricsIntervalRef.current);
      metricsIntervalRef.current = null;
    }
    const wasActive = maskerRef.current !== null;
    maskerRef.current?.stop();
    maskerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    audioContextRef.current?.close();
    audioContextRef.current = null;
    setMetrics(null);
    if (wasActive) onStreamEnded?.();
  }

  useEffect(() => teardown, []);

  async function start() {
    if (status === 'active' || status === 'requesting') return;
    setStatus('requesting');
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const masker = new VoiceMasker(audioContext, VOICE_PRESETS[voicePreset]);
      await masker.initializeProcessor(stream);
      maskerRef.current = masker;

      metricsIntervalRef.current = setInterval(() => {
        setMetrics(masker.getMetrics());
      }, METRICS_POLL_MS);

      setStatus('active');
      onStreamReady?.(masker.getOutputStream());
    } catch (err) {
      teardown();
      setError(err instanceof Error ? err.message : 'Microphone access failed');
      setStatus('error');
    }
  }

  function stop() {
    teardown();
    setStatus('idle');
  }

  function handlePresetChange(name: VoicePresetName) {
    setVoicePreset(name);
    maskerRef.current?.setPreset(VOICE_PRESETS[name]);
  }

  return (
    <div aria-label="voice-control">
      <fieldset>
        <legend>Voice</legend>
        {VOICE_PRESET_NAMES.map((name) => (
          <label key={name}>
            <input
              type="radio"
              name="voiceControlPreset"
              value={name}
              checked={voicePreset === name}
              onChange={() => handlePresetChange(name)}
            />
            {name}
          </label>
        ))}
      </fieldset>

      {status === 'active' ? (
        <button type="button" onClick={stop}>
          Stop
        </button>
      ) : (
        <button type="button" onClick={start} disabled={status === 'requesting'}>
          {status === 'requesting' ? 'Requesting microphone…' : 'Start voice masking'}
        </button>
      )}

      {error && <p role="alert">{error}</p>}

      {metrics && (
        <dl aria-label="voice-metrics">
          <dt>Latency</dt>
          <dd>{metrics.lastLatency}ms</dd>
          <dt>Within target</dt>
          <dd>{metrics.isWithinTarget ? 'yes' : 'no'}</dd>
        </dl>
      )}
    </div>
  );
}

export default VoiceControl;
