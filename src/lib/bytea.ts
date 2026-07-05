/**
 * Hex <-> bytes conversion for Postgres `bytea` columns exposed through RPC
 * parameters/results as plain hex text (encode/decode(..., 'hex') - see
 * migration 004) rather than raw bytea, so the client never needs to deal
 * with PostgREST's "\x..." bytea literal format at all.
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
