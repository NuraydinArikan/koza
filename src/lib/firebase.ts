import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getDatabase, type Database } from 'firebase/database';

export class FirebaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirebaseConfigError';
  }
}

/** Parses VITE_FIREBASE_CONFIG (a JSON-stringified web config object). */
export function readFirebaseConfig(
  env: Partial<ImportMetaEnv> = import.meta.env
): Record<string, unknown> {
  const raw = env.VITE_FIREBASE_CONFIG;
  if (!raw) {
    throw new FirebaseConfigError(
      'Missing Firebase config: set VITE_FIREBASE_CONFIG in .env.local (see .env.example)'
    );
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new FirebaseConfigError('VITE_FIREBASE_CONFIG is not valid JSON');
  }
}

let cachedApp: FirebaseApp | null = null;
let cachedDatabase: Database | null = null;

/** Lazily creates and caches the app-wide Firebase Realtime Database handle. */
export function getFirebaseDatabase(): Database {
  if (!cachedDatabase) {
    if (!cachedApp) {
      cachedApp = initializeApp(readFirebaseConfig());
    }
    cachedDatabase = getDatabase(cachedApp);
  }
  return cachedDatabase;
}
