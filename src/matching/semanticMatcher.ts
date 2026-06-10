import type { SupabaseClient } from '@supabase/supabase-js';

// ─── public types ─────────────────────────────────────────────────────────────

export const EMBEDDING_DIM = 1536;

export interface MatchResult {
  userId: string;
  similarity: number; // cosine similarity in [−1, 1]; higher = more compatible
  rank: number;       // 1 = closest match
}

export type MatchingErrorCode =
  | 'TIMEOUT'
  | 'API_ERROR'
  | 'USER_NOT_FOUND'
  | 'INVALID_EMBEDDING';

export class MatchingError extends Error {
  constructor(message: string, public readonly code: MatchingErrorCode) {
    super(message);
    this.name = 'MatchingError';
  }
}

/**
 * Minimal Supabase-compatible interface.
 * Using the real SupabaseClient satisfies this; a plain object mock works in tests.
 */
export type SupabaseLike = Pick<SupabaseClient, 'from' | 'rpc'>;

export interface SemanticMatcherConfig {
  supabase: SupabaseLike;
  timeoutMs?: number;     // default 5000 ms
  matchCount?: number;    // default 3
  minSimilarity?: number; // default 0 – keep all results regardless of score
}

// ─── pure utilities ───────────────────────────────────────────────────────────

/** Cosine similarity of two equal-length numeric arrays. Returns 0 for zero vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom < 1e-10 ? 0 : dot / denom;
}

/** Returns true only for finite float arrays of exactly EMBEDDING_DIM elements. */
export function isValidEmbedding(v: unknown): v is number[] {
  if (!Array.isArray(v) || v.length !== EMBEDDING_DIM) return false;
  return (v as unknown[]).every((x) => typeof x === 'number' && isFinite(x));
}

// ─── SemanticMatcher ──────────────────────────────────────────────────────────

/**
 * Finds the top-N semantically compatible users for a given user by comparing
 * OpenAI embeddings stored in the `users.answer_embedding` column.
 *
 * Primary path:  Supabase RPC `find_similar_users` (uses pgvector IVFFlat index).
 * The expected Postgres signature:
 *
 *   find_similar_users(
 *     query_embedding  vector(1536),
 *     exclude_user_id  uuid,
 *     match_count      int     DEFAULT 3,
 *     min_similarity   float   DEFAULT 0
 *   ) RETURNS TABLE (user_id uuid, similarity float)
 */
export class SemanticMatcher {
  private readonly supabase: SupabaseLike;
  private readonly timeoutMs: number;
  private readonly matchCount: number;
  private readonly minSimilarity: number;

  constructor(config: SemanticMatcherConfig) {
    this.supabase     = config.supabase;
    this.timeoutMs    = config.timeoutMs    ?? 5000;
    this.matchCount   = config.matchCount   ?? 3;
    this.minSimilarity = config.minSimilarity ?? 0;
  }

  /**
   * Fetches the stored embedding for `userId`, then finds the top matches.
   * Throws MatchingError on failure; never returns partial/corrupt results.
   */
  async findMatches(userId: string): Promise<MatchResult[]> {
    const embedding = await this._fetchEmbedding(userId);
    return this._queryMatches(embedding, userId);
  }

  /**
   * Finds top matches for a pre-computed embedding (e.g. from the onboarding flow
   * before the vector has been persisted).
   */
  async findMatchesByEmbedding(
    embedding: number[],
    excludeUserId: string
  ): Promise<MatchResult[]> {
    if (!isValidEmbedding(embedding)) {
      throw new MatchingError(
        `Embedding must be a ${EMBEDDING_DIM}-dimensional finite float array`,
        'INVALID_EMBEDDING'
      );
    }
    return this._queryMatches(embedding, excludeUserId);
  }

  // ─── private ───────────────────────────────────────────────────────────────

  private async _fetchEmbedding(userId: string): Promise<number[]> {
    let data: Record<string, unknown>[] | null;
    let error: { message: string } | null;

    try {
      const response = await this._withTimeout(
        this.supabase
          .from('users')
          .select('answer_embedding')
          .eq('id', userId) as unknown as Promise<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>,
        this.timeoutMs
      );
      ({ data, error } = response);
    } catch (err) {
      if (err instanceof MatchingError) throw err;
      throw new MatchingError(
        `Failed to fetch embedding: ${(err as Error).message}`,
        'API_ERROR'
      );
    }

    if (error) {
      throw new MatchingError(`Supabase error: ${error.message}`, 'API_ERROR');
    }
    if (!data || data.length === 0) {
      throw new MatchingError(`User not found: ${userId}`, 'USER_NOT_FOUND');
    }

    const raw = data[0]['answer_embedding'];
    if (!isValidEmbedding(raw)) {
      throw new MatchingError(
        `User ${userId} has no valid embedding – run onboarding first`,
        'INVALID_EMBEDDING'
      );
    }
    return raw;
  }

  private async _queryMatches(
    embedding: number[],
    excludeUserId: string
  ): Promise<MatchResult[]> {
    let data: Record<string, unknown>[] | null;
    let error: { message: string } | null;

    try {
      const response = await this._withTimeout(
        this.supabase.rpc('find_similar_users', {
          query_embedding:  embedding,
          exclude_user_id:  excludeUserId,
          match_count:      this.matchCount,
          min_similarity:   this.minSimilarity,
        }) as unknown as Promise<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>,
        this.timeoutMs
      );
      ({ data, error } = response);
    } catch (err) {
      if (err instanceof MatchingError) throw err;
      throw new MatchingError(
        `Match query failed: ${(err as Error).message}`,
        'API_ERROR'
      );
    }

    if (error) {
      throw new MatchingError(`Supabase RPC error: ${error.message}`, 'API_ERROR');
    }

    const rows = data ?? [];
    const results: MatchResult[] = [];

    for (const row of rows) {
      const userId     = row['user_id'];
      const similarity = row['similarity'];
      // Silently skip any row that doesn't conform to the expected shape
      if (
        typeof userId !== 'string' ||
        typeof similarity !== 'number' ||
        !isFinite(similarity)
      ) continue;
      if (similarity < this.minSimilarity) continue;
      results.push({ userId, similarity, rank: 0 });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results
      .slice(0, this.matchCount)
      .map((r, i) => ({ ...r, rank: i + 1 }));
  }

  private _withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new MatchingError(`Operation timed out after ${ms}ms`, 'TIMEOUT')),
          ms
        )
      ),
    ]);
  }
}

export default SemanticMatcher;
