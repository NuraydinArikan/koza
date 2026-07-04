/**
 * Per-session end-to-end encryption for chat messages (spec: AES-256-GCM
 * with a "session_key" that the server never sees - DATABASE_SCHEMA.sql's
 * detect_and_mask_pii() trigger only ever gets ciphertext and silently
 * no-ops when it can't decrypt it).
 *
 * Key derivation: ECDH (P-256). Each peer generates an ephemeral key pair
 * with generateSessionKeyPair() and sends publicKeyRaw to the other peer
 * over the already-connected WebRTC data channel (webrtc/signaling.ts's
 * SignalingHandler.send(), as the first message after the 'connect' event -
 * see the BlindConfessional UI wiring). Both sides then call
 * deriveSessionKey(myPrivateKey, peerPublicKeyRaw) and arrive at the same
 * AES-256-GCM key without either the key or any key material ever passing
 * through Supabase/Firebase.
 */

const IV_LENGTH_BYTES = 12; // 96-bit IV, the standard/recommended size for AES-GCM

export interface SessionKeyPair {
  privateKey: CryptoKey;
  /** Raw uncompressed EC point - safe to send to the peer, never sent to the server. */
  publicKeyRaw: Uint8Array;
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

/** Generates an ephemeral ECDH key pair for one side of a session. */
export async function generateSessionKeyPair(): Promise<SessionKeyPair> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey']
  )) as CryptoKeyPair;

  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  return { privateKey: keyPair.privateKey, publicKeyRaw };
}

/**
 * Combines this peer's private key with the other peer's raw public key to
 * derive the shared AES-256-GCM session key. Both peers get the identical
 * key when they call this with each other's publicKeyRaw.
 */
export async function deriveSessionKey(
  privateKey: CryptoKey,
  peerPublicKeyRaw: Uint8Array
): Promise<CryptoKey> {
  const peerPublicKey = await crypto.subtle.importKey(
    'raw',
    peerPublicKeyRaw as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Encrypts plaintext with the session key. Returns iv || ciphertext as one buffer. */
export async function encryptMessage(key: CryptoKey, plaintext: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  );

  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return packed;
}

/** Decrypts a buffer produced by encryptMessage(). Throws DecryptionError on tampering/wrong key. */
export async function decryptMessage(key: CryptoKey, packed: Uint8Array): Promise<string> {
  if (packed.length <= IV_LENGTH_BYTES) {
    throw new DecryptionError('Ciphertext too short to contain an IV');
  }
  const iv = packed.slice(0, IV_LENGTH_BYTES);
  const ciphertext = packed.slice(IV_LENGTH_BYTES);

  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new DecryptionError('Failed to decrypt message (wrong key or tampered ciphertext)');
  }
}
