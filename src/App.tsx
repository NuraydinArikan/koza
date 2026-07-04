import { useState } from 'react';
import { Onboarding } from './ui/Onboarding';
import { getSupabaseClient, SupabaseConfigError } from './lib/supabase';

function readSupabaseClient() {
  try {
    return { client: getSupabaseClient(), error: null as string | null };
  } catch (err) {
    if (err instanceof SupabaseConfigError) {
      return { client: null, error: err.message };
    }
    throw err;
  }
}

export default function App() {
  const [{ client, error }] = useState(readSupabaseClient);

  return (
    <div style={{ fontFamily: 'system-ui', padding: '2rem', maxWidth: '600px', margin: '0 auto' }}>
      <h1>Koza</h1>
      {client ? (
        <Onboarding supabase={client} embeddingEndpoint={import.meta.env.VITE_EMBEDDING_ENDPOINT} />
      ) : (
        <p>{error}</p>
      )}
    </div>
  );
}
