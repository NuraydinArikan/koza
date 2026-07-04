import { describe, it, expect } from 'vitest';
import {
  generateSessionKeyPair,
  deriveSessionKey,
  encryptMessage,
  decryptMessage,
  DecryptionError,
} from './messageEncryption';

describe('ECDH session key derivation', () => {
  it('both peers derive the identical AES-GCM key from each other\'s public key', async () => {
    const alice = await generateSessionKeyPair();
    const bob = await generateSessionKeyPair();

    const aliceKey = await deriveSessionKey(alice.privateKey, bob.publicKeyRaw);
    const bobKey = await deriveSessionKey(bob.privateKey, alice.publicKeyRaw);

    // CryptoKey isn't directly comparable, so prove equality via round-trip:
    // something encrypted with one key must decrypt cleanly with the other.
    const ciphertext = await encryptMessage(aliceKey, 'hello from alice');
    expect(await decryptMessage(bobKey, ciphertext)).toBe('hello from alice');
  });

  it('produces different keys for different peer pairings', async () => {
    const alice = await generateSessionKeyPair();
    const bob = await generateSessionKeyPair();
    const eve = await generateSessionKeyPair();

    const aliceBobKey = await deriveSessionKey(alice.privateKey, bob.publicKeyRaw);
    const ciphertext = await encryptMessage(aliceBobKey, 'secret');

    const eveBobKey = await deriveSessionKey(eve.privateKey, bob.publicKeyRaw);
    await expect(decryptMessage(eveBobKey, ciphertext)).rejects.toThrow(DecryptionError);
  });
});

describe('encryptMessage / decryptMessage', () => {
  it('round-trips plaintext through encryption and decryption', async () => {
    const { privateKey, publicKeyRaw } = await generateSessionKeyPair();
    const key = await deriveSessionKey(privateKey, publicKeyRaw); // self-pairing is fine for this test

    const ciphertext = await encryptMessage(key, 'Call me at 5551234567');
    expect(ciphertext).not.toEqual(new TextEncoder().encode('Call me at 5551234567'));
    expect(await decryptMessage(key, ciphertext)).toBe('Call me at 5551234567');
  });

  it('produces a different ciphertext each time (random IV)', async () => {
    const { privateKey, publicKeyRaw } = await generateSessionKeyPair();
    const key = await deriveSessionKey(privateKey, publicKeyRaw);

    const a = await encryptMessage(key, 'same plaintext');
    const b = await encryptMessage(key, 'same plaintext');
    expect(a).not.toEqual(b);
  });

  it('rejects ciphertext that has been tampered with', async () => {
    const { privateKey, publicKeyRaw } = await generateSessionKeyPair();
    const key = await deriveSessionKey(privateKey, publicKeyRaw);

    const tampered = await encryptMessage(key, 'original message');
    tampered[tampered.length - 1] ^= 0xff; // flip a bit in the ciphertext

    await expect(decryptMessage(key, tampered)).rejects.toThrow(DecryptionError);
  });

  it('rejects a buffer too short to contain an IV', async () => {
    const { privateKey, publicKeyRaw } = await generateSessionKeyPair();
    const key = await deriveSessionKey(privateKey, publicKeyRaw);

    await expect(decryptMessage(key, new Uint8Array(4))).rejects.toThrow(DecryptionError);
  });
});
