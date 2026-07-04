import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export class SupabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseConfigError';
  }
}

/**
 * Reads and validates the Supabase env vars. Takes an explicit env object
 * (defaulting to import.meta.env) so it can be unit-tested without needing
 * to mock Vite's import.meta.
 */
export function readSupabaseEnv(
  env: Partial<ImportMetaEnv> = import.meta.env
): { url: string; key: string } {
  const url = env.VITE_SUPABASE_URL;
  const key = env.VITE_SUPABASE_KEY;

  if (!url || !key) {
    throw new SupabaseConfigError(
      'Missing Supabase config: set VITE_SUPABASE_URL and VITE_SUPABASE_KEY in .env.local (see .env.example)'
    );
  }
  return { url, key };
}

let cachedClient: SupabaseClient | null = null;

/** Lazily creates and caches the app-wide Supabase client. */
export function getSupabaseClient(): SupabaseClient {
  if (!cachedClient) {
    const { url, key } = readSupabaseEnv();
    cachedClient = createClient(url, key);
  }
  return cachedClient;
}
