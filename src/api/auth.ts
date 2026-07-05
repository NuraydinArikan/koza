import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Device-hash-only identity (per user decision: no SMS OTP). A random secret
 * is generated on first use and persisted locally; its SHA-256 hash
 * (anon_hash) is the only thing ever sent to the server. The raw secret
 * doubles as a recovery code: whoever holds it can restore the same identity
 * on another device/browser, and losing it means losing the identity with
 * no other recovery path (consistent with "no PII, nothing to recover from").
 *
 * All server access goes through RPCs (find_user_by_anon_hash, register_user
 * - migration 004), not direct table access: the RLS policies in
 * DATABASE_SCHEMA.sql key off a Supabase-Auth-only session setting that a
 * device-hash identity never populates, so direct `.from('users')` calls
 * from the anon/publishable key are always denied by design. The RPCs are
 * SECURITY DEFINER and validate/shape their own inputs instead.
 */

const SECRET_STORAGE_KEY = 'koza_device_secret';
const SECRET_HEX_RE = /^[0-9a-f]{64}$/i;

export type SupabaseLike = Pick<SupabaseClient, 'rpc'>;

export type AuthErrorCode = 'API_ERROR' | 'INVALID_SECRET' | 'NOT_ONBOARDED';

export class AuthError extends Error {
  constructor(message: string, public readonly code: AuthErrorCode) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface DeviceIdentity {
  /** Raw recovery code. Show it to the user once; never log or transmit it as-is. */
  secret: string;
  /** SHA-256(secret) as hex — the only identity material sent to the server. */
  anonHash: string;
}

export interface UserRecord {
  id: string;
  anonHash: string;
  voicePreset: string | null;
  avatarStyle: string | null;
}

interface UserRow {
  id: string;
  anon_hash: string;
  voice_preset: string | null;
  avatar_style: string | null;
}

function toUserRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    anonHash: row.anon_hash,
    voicePreset: row.voice_preset,
    avatarStyle: row.avatar_style,
  };
}

// ─── device secret / recovery code ─────────────────────────────────────────

function randomSecretHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of the UTF-8 encoded secret, as lowercase hex. */
export async function hashSecret(secret: string): Promise<string> {
  const data = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Returns this device's identity, generating and persisting a new recovery
 * secret on first use.
 */
export async function getOrCreateDeviceIdentity(
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage
): Promise<DeviceIdentity> {
  let secret = storage.getItem(SECRET_STORAGE_KEY);
  if (!secret) {
    secret = randomSecretHex();
    storage.setItem(SECRET_STORAGE_KEY, secret);
  }
  return { secret, anonHash: await hashSecret(secret) };
}

/** Restores a device identity from a previously saved recovery code. */
export async function restoreDeviceIdentity(
  secret: string,
  storage?: Pick<Storage, 'setItem'>
): Promise<DeviceIdentity> {
  const trimmed = secret.trim();
  if (!SECRET_HEX_RE.test(trimmed)) {
    throw new AuthError('Recovery code must be a 64-character hex string', 'INVALID_SECRET');
  }
  (storage ?? window.localStorage).setItem(SECRET_STORAGE_KEY, trimmed);
  return { secret: trimmed, anonHash: await hashSecret(trimmed) };
}

// ─── server lookups ────────────────────────────────────────────────────────

/** Looks up an existing user by anon_hash. Returns null if this device hasn't onboarded yet. */
export async function findUserByAnonHash(
  supabase: SupabaseLike,
  anonHash: string
): Promise<UserRecord | null> {
  if (!SECRET_HEX_RE.test(anonHash)) {
    throw new AuthError('anonHash must be a 64-character hex SHA-256 digest', 'INVALID_SECRET');
  }
  const { data, error } = await supabase.rpc('find_user_by_anon_hash', {
    p_anon_hash_hex: anonHash,
  });

  if (error) throw new AuthError(`Failed to look up user: ${error.message}`, 'API_ERROR');
  const rows = (data ?? []) as UserRow[];
  return rows.length > 0 ? toUserRecord(rows[0]) : null;
}

export interface RegisterUserParams {
  supabase: SupabaseLike;
  anonHash: string;
  onboardingAnswers: Record<string, string>;
  answerEmbedding: number[];
  voicePreset: string;
  avatarStyle?: string;
}

/**
 * Creates the `users` row for a device once onboarding (answers + embedding)
 * is complete. Until this is called, findUserByAnonHash() will keep
 * returning null for this device.
 */
export async function registerUser(params: RegisterUserParams): Promise<UserRecord> {
  const { supabase, anonHash, onboardingAnswers, answerEmbedding, voicePreset, avatarStyle } = params;

  const { data, error } = await supabase.rpc('register_user', {
    p_anon_hash_hex: anonHash,
    p_onboarding_answers: onboardingAnswers,
    p_answer_embedding: answerEmbedding,
    p_voice_preset: voicePreset,
    p_avatar_style: avatarStyle ?? null,
  });

  if (error) throw new AuthError(`Failed to register user: ${error.message}`, 'API_ERROR');
  const rows = (data ?? []) as UserRow[];
  if (rows.length === 0) {
    throw new AuthError('register_user returned no row', 'API_ERROR');
  }
  return toUserRecord(rows[0]);
}
