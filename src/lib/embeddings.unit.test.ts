import { describe, it, expect } from 'vitest';
import { generateEmbedding, EmbeddingError } from './embeddings';
import { EMBEDDING_DIM } from '../matching/semanticMatcher';

function fakeFetch(response: { ok: boolean; status?: number; statusText?: string; body?: unknown }) {
  return (async () =>
    ({
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      statusText: response.statusText ?? '',
      json: async () => response.body,
    }) as Response) as typeof fetch;
}

describe('generateEmbedding', () => {
  it('returns the embedding vector on success', async () => {
    const vector = new Array(EMBEDDING_DIM).fill(0.5);
    const result = await generateEmbedding('some onboarding text', {
      endpoint: 'https://example.test/embed',
      fetchImpl: fakeFetch({ ok: true, body: { embedding: vector } }),
    });
    expect(result).toEqual(vector);
  });

  it('throws EmbeddingError on a non-OK response', async () => {
    await expect(
      generateEmbedding('text', {
        endpoint: 'https://example.test/embed',
        fetchImpl: fakeFetch({ ok: false, status: 500, statusText: 'Internal Error' }),
      })
    ).rejects.toThrow(EmbeddingError);
  });

  it('throws EmbeddingError when the embedding is the wrong length', async () => {
    await expect(
      generateEmbedding('text', {
        endpoint: 'https://example.test/embed',
        fetchImpl: fakeFetch({ ok: true, body: { embedding: [0.1, 0.2] } }),
      })
    ).rejects.toThrow(EmbeddingError);
  });

  it('throws EmbeddingError when the embedding field is missing', async () => {
    await expect(
      generateEmbedding('text', {
        endpoint: 'https://example.test/embed',
        fetchImpl: fakeFetch({ ok: true, body: {} }),
      })
    ).rejects.toThrow(EmbeddingError);
  });

  it('throws EmbeddingError when fetch itself rejects (network failure)', async () => {
    const failingFetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(
      generateEmbedding('text', { endpoint: 'https://example.test/embed', fetchImpl: failingFetch })
    ).rejects.toThrow(EmbeddingError);
  });
});
