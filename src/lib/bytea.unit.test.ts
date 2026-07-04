import { describe, it, expect } from 'vitest';
import { bytesToHex, hexToBytes, toBytea, fromBytea } from './bytea';

describe('hex conversion', () => {
  it('round-trips bytes through hex', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });

  it('pads single-digit byte values', () => {
    expect(bytesToHex(new Uint8Array([0, 5, 10]))).toBe('00050a');
  });

  it('throws on odd-length hex', () => {
    expect(() => hexToBytes('abc')).toThrow();
  });

  it('throws on non-hex characters', () => {
    expect(() => hexToBytes('zz')).toThrow();
  });
});

describe('bytea literal encoding', () => {
  it('encodes raw bytes with the \\x prefix', () => {
    expect(toBytea(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('\\xdeadbeef');
  });

  it('encodes an already-hex string with the \\x prefix', () => {
    expect(toBytea('deadbeef')).toBe('\\xdeadbeef');
  });

  it('decodes a \\x-prefixed bytea literal back to bytes', () => {
    expect(fromBytea('\\xdeadbeef')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it('decodes a bare hex string without the prefix', () => {
    expect(fromBytea('deadbeef')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it('round-trips through toBytea/fromBytea', () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 251]);
    expect(fromBytea(toBytea(bytes))).toEqual(bytes);
  });
});
