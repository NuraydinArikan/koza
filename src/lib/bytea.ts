/**
 * PostgREST (and therefore supabase-js) represents Postgres `bytea` columns
 * as hex strings prefixed with "\x" on both read and write. These helpers
 * keep that encoding in one place instead of repeating it in every API
 * module that touches a bytea column (anon_hash, content_encrypted, ...).
 */

const HEX_RE = /^[0-9a-f]*$/i;

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !HEX_RE.test(hex)) {
    throw new Error(`Invalid hex string: ${hex}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Encodes raw bytes (or an already-hex string) as a Postgres bytea literal ("\x..."). */
export function toBytea(value: Uint8Array | string): string {
  const hex = typeof value === 'string' ? value : bytesToHex(value);
  return `\\x${hex}`;
}

/** Decodes a "\x..."-prefixed bytea value (as returned by PostgREST) back into raw bytes. */
export function fromBytea(value: string): Uint8Array {
  const hex = value.startsWith('\\x') ? value.slice(2) : value;
  return hexToBytes(hex);
}
