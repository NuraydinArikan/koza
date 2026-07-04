import { useState, type FormEvent } from 'react';
import { getOrCreateDeviceIdentity, registerUser, type SupabaseLike } from '../api/auth';
import { generateEmbedding } from '../lib/embeddings';
import { VOICE_PRESETS } from '../audio/voiceMasker';
import { useAuthStore } from '../store/authStore';
import { useUserPrefsStore, type VoicePresetName, type AvatarStyle } from '../store/userPrefsStore';

const AVATAR_STYLES: AvatarStyle[] = ['clay_figure', 'nature_spirit', 'origami'];
const VOICE_PRESET_NAMES = Object.keys(VOICE_PRESETS) as VoicePresetName[];

const ONBOARDING_QUESTIONS = [
  { key: 'q1', prompt: 'What brings you here today?' },
  { key: 'q2', prompt: "What's been weighing on you lately?" },
] as const;

export interface OnboardingProps {
  supabase: SupabaseLike;
  embeddingEndpoint: string;
}

type Status = 'idle' | 'submitting' | 'error' | 'done';

export function Onboarding({ supabase, embeddingEndpoint }: OnboardingProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [voicePreset, setVoicePresetLocal] = useState<VoicePresetName>('warm_hearth');
  const [avatarStyle, setAvatarStyleLocal] = useState<AvatarStyle>('clay_figure');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  const setAuthUser = useAuthStore((s) => s.setUser);
  const setAuthLoading = useAuthStore((s) => s.setLoading);
  const setAuthError = useAuthStore((s) => s.setError);
  const setPrefsVoicePreset = useUserPrefsStore((s) => s.setVoicePreset);
  const setPrefsAvatarStyle = useUserPrefsStore((s) => s.setAvatarStyle);

  const allAnswered = ONBOARDING_QUESTIONS.every((q) => (answers[q.key] ?? '').trim().length > 0);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!allAnswered || status === 'submitting') return;

    setStatus('submitting');
    setError(null);
    setAuthLoading();

    try {
      const identity = await getOrCreateDeviceIdentity();
      const combinedText = ONBOARDING_QUESTIONS.map((q) => answers[q.key]).join('\n');
      const embedding = await generateEmbedding(combinedText, { endpoint: embeddingEndpoint });

      const user = await registerUser({
        supabase,
        anonHash: identity.anonHash,
        onboardingAnswers: answers,
        answerEmbedding: embedding,
        voicePreset,
        avatarStyle,
      });

      setAuthUser({ id: user.id, anonHash: user.anonHash });
      setPrefsVoicePreset(voicePreset);
      setPrefsAvatarStyle(avatarStyle);
      setRecoveryCode(identity.secret);
      setStatus('done');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      setError(message);
      setAuthError(message);
      setStatus('error');
    }
  }

  if (status === 'done' && recoveryCode) {
    return (
      <div aria-label="onboarding-complete">
        <h2>Save your recovery code</h2>
        <p>
          This code is the only way to restore your identity if you switch devices or clear your
          browser storage. Koza never stores it and can never show it to you again - write it down
          somewhere safe.
        </p>
        <code>{recoveryCode}</code>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} aria-label="onboarding-form">
      {ONBOARDING_QUESTIONS.map((q) => (
        <label key={q.key}>
          {q.prompt}
          <textarea
            value={answers[q.key] ?? ''}
            onChange={(e) => setAnswers((prev) => ({ ...prev, [q.key]: e.target.value }))}
          />
        </label>
      ))}

      <fieldset>
        <legend>Voice</legend>
        {VOICE_PRESET_NAMES.map((name) => (
          <label key={name}>
            <input
              type="radio"
              name="voicePreset"
              value={name}
              checked={voicePreset === name}
              onChange={() => setVoicePresetLocal(name)}
            />
            {name}
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Avatar</legend>
        {AVATAR_STYLES.map((style) => (
          <label key={style}>
            <input
              type="radio"
              name="avatarStyle"
              value={style}
              checked={avatarStyle === style}
              onChange={() => setAvatarStyleLocal(style)}
            />
            {style}
          </label>
        ))}
      </fieldset>

      {error && <p role="alert">{error}</p>}

      <button type="submit" disabled={!allAnswered || status === 'submitting'}>
        {status === 'submitting' ? 'Connecting…' : 'Continue'}
      </button>
    </form>
  );
}

export default Onboarding;
