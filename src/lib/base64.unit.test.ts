import { describe, it, expect } from 'vitest';
import { bytesToBase64, base64ToBytes } from './base64';

describe('bytesToBase64', () => {
  it('matches known base64 encodings', () => {
    expect(bytesToBase64(new TextEncoder().encode('Man'))).toBe('TWFu');
    expect(bytesToBase64(new TextEncoder().encode('Ma'))).toBe('TWE=');
    expect(bytesToBase64(new TextEncoder().encode('M'))).toBe('TQ==');
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
  });

  it('round-trips the full 0-255 byte range', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('round-trips lengths that are and are not multiples of 3', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 6, 65]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 7) % 256);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });
});

describe('base64ToBytes', () => {
  it('decodes known base64 strings', () => {
    expect(new TextDecoder().decode(base64ToBytes('TWFu'))).toBe('Man');
    expect(new TextDecoder().decode(base64ToBytes('TWE='))).toBe('Ma');
    expect(new TextDecoder().decode(base64ToBytes('TQ=='))).toBe('M');
  });

  it('ignores unknown characters like whitespace', () => {
    expect(base64ToBytes('TWFu\n')).toEqual(base64ToBytes('TWFu'));
  });
});
