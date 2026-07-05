import { describe, it, expect } from 'vitest';
import { bytesToHex, hexToBytes } from './bytea';

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
