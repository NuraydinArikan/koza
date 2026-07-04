import { describe, it, expect } from 'vitest';
import { readSupabaseEnv, SupabaseConfigError } from './supabase';

describe('readSupabaseEnv', () => {
  it('returns url and key when both are set', () => {
    const result = readSupabaseEnv({
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_KEY: 'test-key',
    });
    expect(result).toEqual({ url: 'https://example.supabase.co', key: 'test-key' });
  });

  it.each([
    ['missing url', { VITE_SUPABASE_KEY: 'test-key' }],
    ['missing key', { VITE_SUPABASE_URL: 'https://example.supabase.co' }],
    ['missing both', {}],
  ])('throws SupabaseConfigError when %s', (_label, env) => {
    expect(() => readSupabaseEnv(env)).toThrow(SupabaseConfigError);
  });
});
