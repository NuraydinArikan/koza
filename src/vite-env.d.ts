/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_KEY: string;
  readonly VITE_EMBEDDING_ENDPOINT: string;
  /** JSON-stringified Firebase web config, e.g. '{"apiKey":"...","databaseURL":"..."}' */
  readonly VITE_FIREBASE_CONFIG: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
