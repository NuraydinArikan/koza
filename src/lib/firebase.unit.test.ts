import { describe, it, expect } from 'vitest';
import { readFirebaseConfig, FirebaseConfigError } from './firebase';

describe('readFirebaseConfig', () => {
  it('parses a valid JSON config', () => {
    const config = readFirebaseConfig({
      VITE_FIREBASE_CONFIG: '{"apiKey":"abc","databaseURL":"https://example.firebaseio.com"}',
    });
    expect(config).toEqual({ apiKey: 'abc', databaseURL: 'https://example.firebaseio.com' });
  });

  it('throws FirebaseConfigError when the env var is missing', () => {
    expect(() => readFirebaseConfig({})).toThrow(FirebaseConfigError);
  });

  it('throws FirebaseConfigError when the env var is not valid JSON', () => {
    expect(() => readFirebaseConfig({ VITE_FIREBASE_CONFIG: 'not json' })).toThrow(
      FirebaseConfigError
    );
  });
});
