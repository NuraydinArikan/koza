/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_KEY: string;
  readonly VITE_EMBEDDING_ENDPOINT: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
