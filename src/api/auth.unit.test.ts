import { describe, it, expect } from 'vitest';
import {
  hashSecret,
  getOrCreateDeviceIdentity,
  restoreDeviceIdentity,
  findUserByAnonHash,
  registerUser,
  AuthError,
  SupabaseLike,
} from './auth';

// ─── test helpers ─────────────────────────────────────────────────────────────

function fakeStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

interface MockResult {
  /** Rows returned by the RPC (RETURNS TABLE always yields an array). */
  rows?: Record<string, unknown>[];
  errorMsg?: string;
}

function mockSupabase({ rows, errorMsg }: MockResult): SupabaseLike {
  const result = errorMsg ? { data: null, error: { message: errorMsg } } : { data: rows ?? [], error: null };
  return {
    rpc: () => Promise.resolve(result),
  } as unknown as SupabaseLike;
}

// ─── hashSecret ────────────────────────────────────────────────────────────

describe('hashSecret', () => {
  it('produces a 64-char lowercase hex SHA-256 digest', async () => {
    const hash = await hashSecret('some-secret');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', async () => {
    expect(await hashSecret('same')).toBe(await hashSecret('same'));
  });

  it('differs for different inputs', async () => {
    expect(await hashSecret('a')).not.toBe(await hashSecret('b'));
  });
});

// ─── device identity ───────────────────────────────────────────────────────

describe('getOrCreateDeviceIdentity', () => {
  it('generates and persists a new secret on first use', async () => {
    const storage = fakeStorage();
    const identity = await getOrCreateDeviceIdentity(storage);
    expect(identity.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.anonHash).toBe(await hashSecret(identity.secret));
    expect(storage.getItem('koza_device_secret')).toBe(identity.secret);
  });

  it('reuses an existing persisted secret', async () => {
    const storage = fakeStorage({ koza_device_secret: 'a'.repeat(64) });
    const identity = await getOrCreateDeviceIdentity(storage);
    expect(identity.secret).toBe('a'.repeat(64));
  });
});

describe('restoreDeviceIdentity', () => {
  it('restores from a valid recovery code, trimming whitespace', async () => {
    const storage = fakeStorage();
    const code = 'b'.repeat(64);
    const identity = await restoreDeviceIdentity(`  ${code}  `, storage);
    expect(identity.secret).toBe(code);
    expect(storage.getItem('koza_device_secret')).toBe(code);
  });

  it('rejects a malformed recovery code', async () => {
    await expect(restoreDeviceIdentity('not-a-valid-code')).rejects.toThrow(AuthError);
  });
});

// ─── server lookups ────────────────────────────────────────────────────────

describe('findUserByAnonHash', () => {
  const hash = 'c'.repeat(64);

  it('returns null when no user matches', async () => {
    const result = await findUserByAnonHash(mockSupabase({ rows: [] }), hash);
    expect(result).toBeNull();
  });

  it('maps a found row to a UserRecord', async () => {
    const result = await findUserByAnonHash(
      mockSupabase({
        rows: [{ id: 'u1', anon_hash: hash, voice_preset: 'warm_hearth', avatar_style: null }],
      }),
      hash
    );
    expect(result).toEqual({
      id: 'u1',
      anonHash: hash,
      voicePreset: 'warm_hearth',
      avatarStyle: null,
    });
  });

  it('throws AuthError on a malformed hash', async () => {
    await expect(findUserByAnonHash(mockSupabase({ rows: [] }), 'too-short')).rejects.toThrow(
      AuthError
    );
  });

  it('throws AuthError when the query fails', async () => {
    await expect(
      findUserByAnonHash(mockSupabase({ errorMsg: 'connection reset' }), hash)
    ).rejects.toThrow(AuthError);
  });
});

describe('registerUser', () => {
  const hash = 'd'.repeat(64);

  it('creates a user and returns the mapped record', async () => {
    const result = await registerUser({
      supabase: mockSupabase({
        rows: [{ id: 'u2', anon_hash: hash, voice_preset: 'gentle_breeze', avatar_style: 'origami' }],
      }),
      anonHash: hash,
      onboardingAnswers: { q1: 'answer' },
      answerEmbedding: [0.1, 0.2],
      voicePreset: 'gentle_breeze',
      avatarStyle: 'origami',
    });
    expect(result).toEqual({
      id: 'u2',
      anonHash: hash,
      voicePreset: 'gentle_breeze',
      avatarStyle: 'origami',
    });
  });

  it('throws AuthError when the insert fails', async () => {
    await expect(
      registerUser({
        supabase: mockSupabase({ errorMsg: 'unique violation' }),
        anonHash: hash,
        onboardingAnswers: {},
        answerEmbedding: [],
        voicePreset: 'warm_hearth',
      })
    ).rejects.toThrow(AuthError);
  });

  it('throws AuthError when the RPC returns no row', async () => {
    await expect(
      registerUser({
        supabase: mockSupabase({ rows: [] }),
        anonHash: hash,
        onboardingAnswers: {},
        answerEmbedding: [],
        voicePreset: 'warm_hearth',
      })
    ).rejects.toThrow(AuthError);
  });
});
