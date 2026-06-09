import { describe, it, expect } from 'vitest';
import {
  SemanticMatcher,
  cosineSimilarity,
  isValidEmbedding,
  MatchingError,
  EMBEDDING_DIM,
  SupabaseLike,
} from './semanticMatcher';

// ─── test helpers ─────────────────────────────────────────────────────────────

/** Zero-filled embedding with specific indices set. */
function emb(overrides: Record<number, number> = {}): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  for (const [i, val] of Object.entries(overrides)) v[Number(i)] = val;
  return v;
}

/** Valid 1536-dim embedding where every element equals `fill`. */
const validEmb = (fill = 0.5) => new Array<number>(EMBEDDING_DIM).fill(fill);

interface MockConfig {
  userEmbedding?: number[] | null;
  userError?: string;
  notFound?: boolean;
  rpcRows?: Array<{ user_id: string; similarity: number } & Record<string, unknown>>;
  rpcError?: string;
  rpcDelayMs?: number;
}

function mockSupabase(cfg: MockConfig = {}): SupabaseLike {
  return {
    from: () => ({
      select: () => ({
        eq: (): Promise<{ data: Record<string, unknown>[] | null; error: { message: string } | null }> => {
          if (cfg.userError)
            return Promise.resolve({ data: null, error: { message: cfg.userError } });
          if (cfg.notFound)
            return Promise.resolve({ data: [], error: null });
          return Promise.resolve({
            data: [{ answer_embedding: cfg.userEmbedding ?? null }],
            error: null,
          });
        },
      }),
    }),
    rpc: (): Promise<{ data: Record<string, unknown>[] | null; error: { message: string } | null }> => {
      const resolve = () =>
        cfg.rpcError
          ? { data: null, error: { message: cfg.rpcError } }
          : { data: (cfg.rpcRows ?? []) as Record<string, unknown>[], error: null };

      return cfg.rpcDelayMs
        ? new Promise((res) => setTimeout(() => res(resolve()), cfg.rpcDelayMs))
        : Promise.resolve(resolve());
    },
  } as unknown as SupabaseLike;
}

function makeMatcher(cfg: MockConfig = {}, opts: { timeoutMs?: number; matchCount?: number; minSimilarity?: number } = {}) {
  return new SemanticMatcher({
    supabase: mockSupabase(cfg),
    timeoutMs:    opts.timeoutMs    ?? 2000,
    matchCount:   opts.matchCount   ?? 3,
    minSimilarity: opts.minSimilarity ?? 0,
  });
}

// ─── cosineSimilarity ─────────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('identical vectors → 1', () => {
    const v = [1, 0, 0, 0];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1);
  });

  it('orthogonal vectors → 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('opposite vectors → −1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('zero vector → 0 (no division by zero)', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it('mismatched lengths → 0', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('empty arrays → 0', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('high-dimensional equal vectors → 1', () => {
    const v = validEmb(0.3);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1);
  });
});

// ─── isValidEmbedding ─────────────────────────────────────────────────────────

describe('isValidEmbedding', () => {
  it('accepts a valid 1536-dim float array', () => {
    expect(isValidEmbedding(validEmb())).toBe(true);
  });

  it('rejects null', () => {
    expect(isValidEmbedding(null)).toBe(false);
  });

  it('rejects non-array', () => {
    expect(isValidEmbedding('string')).toBe(false);
    expect(isValidEmbedding(42)).toBe(false);
  });

  it('rejects empty array', () => {
    expect(isValidEmbedding([])).toBe(false);
  });

  it('rejects wrong-length array', () => {
    expect(isValidEmbedding(new Array(512).fill(0))).toBe(false);
    expect(isValidEmbedding(new Array(EMBEDDING_DIM + 1).fill(0))).toBe(false);
  });

  it('rejects array containing NaN', () => {
    const bad = validEmb();
    bad[100] = NaN;
    expect(isValidEmbedding(bad)).toBe(false);
  });

  it('rejects array containing Infinity', () => {
    const bad = validEmb();
    bad[0] = Infinity;
    expect(isValidEmbedding(bad)).toBe(false);
  });

  it('rejects array containing non-number elements', () => {
    const bad: unknown[] = new Array(EMBEDDING_DIM).fill(0);
    bad[50] = 'x';
    expect(isValidEmbedding(bad)).toBe(false);
  });
});

// ─── findMatches – normal flow ────────────────────────────────────────────────

describe('SemanticMatcher.findMatches – normal flow', () => {
  it('returns top 3 matches sorted by descending similarity', async () => {
    const matcher = makeMatcher({
      userEmbedding: validEmb(),
      rpcRows: [
        { user_id: 'u1', similarity: 0.72 },
        { user_id: 'u2', similarity: 0.91 },
        { user_id: 'u3', similarity: 0.85 },
      ],
    });

    const results = await matcher.findMatches('me');
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ userId: 'u2', similarity: 0.91, rank: 1 });
    expect(results[1]).toMatchObject({ userId: 'u3', similarity: 0.85, rank: 2 });
    expect(results[2]).toMatchObject({ userId: 'u1', similarity: 0.72, rank: 3 });
  });

  it('returns fewer than 3 when fewer matches exist', async () => {
    const matcher = makeMatcher({
      userEmbedding: validEmb(),
      rpcRows: [{ user_id: 'u1', similarity: 0.88 }],
    });

    const results = await matcher.findMatches('me');
    expect(results).toHaveLength(1);
    expect(results[0].rank).toBe(1);
  });

  it('respects matchCount configuration', async () => {
    const matcher = makeMatcher(
      {
        userEmbedding: validEmb(),
        rpcRows: [
          { user_id: 'u1', similarity: 0.9 },
          { user_id: 'u2', similarity: 0.8 },
          { user_id: 'u3', similarity: 0.7 },
          { user_id: 'u4', similarity: 0.6 },
        ],
      },
      { matchCount: 2 }
    );

    const results = await matcher.findMatches('me');
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.userId)).toEqual(['u1', 'u2']);
  });

  it('filters results below minSimilarity', async () => {
    const matcher = makeMatcher(
      {
        userEmbedding: validEmb(),
        rpcRows: [
          { user_id: 'u1', similarity: 0.9 },
          { user_id: 'u2', similarity: 0.4 }, // below threshold
        ],
      },
      { minSimilarity: 0.6 }
    );

    const results = await matcher.findMatches('me');
    expect(results).toHaveLength(1);
    expect(results[0].userId).toBe('u1');
  });
});

// ─── findMatches – empty results ──────────────────────────────────────────────

describe('SemanticMatcher.findMatches – empty results', () => {
  it('returns [] when RPC returns empty array', async () => {
    const matcher = makeMatcher({ userEmbedding: validEmb(), rpcRows: [] });
    await expect(matcher.findMatches('me')).resolves.toEqual([]);
  });

  it('returns [] when RPC data is null', async () => {
    const matcher = makeMatcher({ userEmbedding: validEmb() }); // rpcRows defaults to []
    const sb = mockSupabase({
      userEmbedding: validEmb(),
      rpcRows: undefined,
    });
    // Override to return null data
    const nullSb: SupabaseLike = {
      ...sb,
      rpc: () => Promise.resolve({ data: null, error: null }) as never,
    } as unknown as SupabaseLike;

    const m = new SemanticMatcher({ supabase: nullSb, timeoutMs: 2000 });
    await expect(m.findMatches('me')).resolves.toEqual([]);
  });

  it('returns [] when all results fall below minSimilarity', async () => {
    const matcher = makeMatcher(
      {
        userEmbedding: validEmb(),
        rpcRows: [
          { user_id: 'u1', similarity: 0.2 },
          { user_id: 'u2', similarity: 0.1 },
        ],
      },
      { minSimilarity: 0.5 }
    );
    await expect(matcher.findMatches('me')).resolves.toEqual([]);
  });
});

// ─── findMatches – timeout ────────────────────────────────────────────────────

describe('SemanticMatcher.findMatches – timeout', () => {
  it('throws MatchingError(TIMEOUT) when RPC exceeds timeoutMs', async () => {
    const matcher = makeMatcher(
      { userEmbedding: validEmb(), rpcDelayMs: 300 },
      { timeoutMs: 50 }
    );
    await expect(matcher.findMatches('me')).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('throws MatchingError(TIMEOUT) when user fetch exceeds timeoutMs', async () => {
    // Delay the user fetch by returning a slow promise
    const slowSb: SupabaseLike = {
      from: () => ({
        select: () => ({
          eq: () =>
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ data: [{ answer_embedding: validEmb() }], error: null }),
                300
              )
            ),
        }),
      }),
      rpc: () => Promise.resolve({ data: [], error: null }),
    } as unknown as SupabaseLike;

    const matcher = new SemanticMatcher({ supabase: slowSb, timeoutMs: 50 });
    await expect(matcher.findMatches('me')).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('error message includes the timeout duration', async () => {
    const matcher = makeMatcher(
      { userEmbedding: validEmb(), rpcDelayMs: 300 },
      { timeoutMs: 80 }
    );
    try {
      await matcher.findMatches('me');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as MatchingError).message).toContain('80ms');
    }
  });
});

// ─── findMatches – invalid embeddings ────────────────────────────────────────

describe('SemanticMatcher.findMatches – invalid embeddings', () => {
  it('throws INVALID_EMBEDDING when stored embedding is null', async () => {
    const matcher = makeMatcher({ userEmbedding: null });
    await expect(matcher.findMatches('me')).rejects.toMatchObject({
      code: 'INVALID_EMBEDDING',
    });
  });

  it('throws INVALID_EMBEDDING when stored embedding is wrong dimension', async () => {
    const matcher = makeMatcher({ userEmbedding: [0.1, 0.2, 0.3] });
    await expect(matcher.findMatches('me')).rejects.toMatchObject({
      code: 'INVALID_EMBEDDING',
    });
  });

  it('throws INVALID_EMBEDDING when stored embedding contains NaN', async () => {
    const bad = validEmb();
    bad[42] = NaN;
    const matcher = makeMatcher({ userEmbedding: bad });
    await expect(matcher.findMatches('me')).rejects.toMatchObject({
      code: 'INVALID_EMBEDDING',
    });
  });

  it('throws INVALID_EMBEDDING when stored embedding contains Infinity', async () => {
    const bad = validEmb();
    bad[0] = Infinity;
    const matcher = makeMatcher({ userEmbedding: bad });
    await expect(matcher.findMatches('me')).rejects.toMatchObject({
      code: 'INVALID_EMBEDDING',
    });
  });

  it('silently skips RPC rows with non-finite similarity', async () => {
    const matcher = makeMatcher({
      userEmbedding: validEmb(),
      rpcRows: [
        { user_id: 'u1', similarity: 0.9 },
        { user_id: 'u2', similarity: NaN },   // skipped
        { user_id: 'u3', similarity: Infinity }, // skipped
        { user_id: 'u4', similarity: 0.7 },
      ],
    });
    const results = await matcher.findMatches('me');
    expect(results.map((r) => r.userId)).toEqual(['u1', 'u4']);
  });

  it('silently skips RPC rows with missing user_id', async () => {
    const matcher = makeMatcher({
      userEmbedding: validEmb(),
      rpcRows: [
        { user_id: 'u1', similarity: 0.9 },
        { user_id: undefined as unknown as string, similarity: 0.8 },
      ],
    });
    const results = await matcher.findMatches('me');
    expect(results).toHaveLength(1);
    expect(results[0].userId).toBe('u1');
  });
});

// ─── findMatchesByEmbedding ───────────────────────────────────────────────────

describe('SemanticMatcher.findMatchesByEmbedding', () => {
  it('uses the provided embedding instead of fetching from DB', async () => {
    const matcher = makeMatcher({
      rpcRows: [{ user_id: 'u1', similarity: 0.88 }],
    });
    const results = await matcher.findMatchesByEmbedding(validEmb(), 'me');
    expect(results).toHaveLength(1);
    expect(results[0].userId).toBe('u1');
  });

  it('throws INVALID_EMBEDDING for wrong-dimension input', async () => {
    const matcher = makeMatcher({});
    await expect(
      matcher.findMatchesByEmbedding([1, 2, 3], 'me')
    ).rejects.toMatchObject({ code: 'INVALID_EMBEDDING' });
  });

  it('throws INVALID_EMBEDDING for embedding with NaN', async () => {
    const bad = validEmb();
    bad[0] = NaN;
    await expect(
      makeMatcher({}).findMatchesByEmbedding(bad, 'me')
    ).rejects.toMatchObject({ code: 'INVALID_EMBEDDING' });
  });
});

// ─── API failures ─────────────────────────────────────────────────────────────

describe('SemanticMatcher – API failures', () => {
  it('throws USER_NOT_FOUND when user row is absent', async () => {
    const matcher = makeMatcher({ notFound: true });
    await expect(matcher.findMatches('missing-id')).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
    });
  });

  it('throws API_ERROR when user select returns an error', async () => {
    const matcher = makeMatcher({ userError: 'connection refused' });
    await expect(matcher.findMatches('me')).rejects.toMatchObject({
      code: 'API_ERROR',
    });
  });

  it('error message surfaces the Supabase error text', async () => {
    const matcher = makeMatcher({ userError: 'relation "users" does not exist' });
    try {
      await matcher.findMatches('me');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as MatchingError).message).toContain('relation "users" does not exist');
    }
  });

  it('throws API_ERROR when RPC returns an error', async () => {
    const matcher = makeMatcher({
      userEmbedding: validEmb(),
      rpcError: 'function find_similar_users not found',
    });
    await expect(matcher.findMatches('me')).rejects.toMatchObject({
      code: 'API_ERROR',
    });
  });

  it('MatchingError.name is "MatchingError"', async () => {
    const matcher = makeMatcher({ notFound: true });
    try {
      await matcher.findMatches('x');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).name).toBe('MatchingError');
    }
  });
});
