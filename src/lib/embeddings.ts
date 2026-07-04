import { EMBEDDING_DIM } from '../matching/semanticMatcher';

/**
 * The client never calls OpenAI directly - that would mean shipping the
 * OpenAI API key inside the browser bundle (VITE_ env vars are public,
 * unlike the Supabase anon key, which is meant to be public and is backed
 * by RLS). Instead this posts to a same-origin proxy endpoint that holds
 * the key server-side and forwards to text-embedding-3-small.
 *
 * That proxy (a Supabase Edge Function) doesn't exist yet - see the
 * "OpenAI embedding proxy" follow-up task. Until it's deployed, calling
 * this against a real endpoint will fail; the onboarding UI surfaces that
 * failure rather than silently falling back to a fake embedding.
 */

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export interface EmbeddingClientConfig {
  /** URL of the server-side embedding proxy. */
  endpoint: string;
  fetchImpl?: typeof fetch;
}

function isValidEmbeddingArray(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === EMBEDDING_DIM &&
    v.every((x) => typeof x === 'number' && Number.isFinite(x))
  );
}

/** Sends onboarding answer text to the embedding proxy; returns the 1536-dim vector. */
export async function generateEmbedding(
  text: string,
  config: EmbeddingClientConfig
): Promise<number[]> {
  const fetchImpl = config.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    throw new EmbeddingError(`Embedding request failed: ${(err as Error).message}`);
  }

  if (!response.ok) {
    throw new EmbeddingError(`Embedding proxy returned ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as { embedding?: unknown };
  if (!isValidEmbeddingArray(body.embedding)) {
    throw new EmbeddingError('Embedding proxy returned a malformed vector');
  }
  return body.embedding;
}
