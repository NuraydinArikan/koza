-- ============================================================================
-- MIGRATION 003: SEMANTIC MATCHING RPC (src/matching/semanticMatcher.ts)
-- ============================================================================
-- semanticMatcher.ts already calls supabase.rpc('find_similar_users', ...)
-- but that function was never defined in DATABASE_SCHEMA.sql or an earlier
-- migration, so real matching fails at runtime with "function does not
-- exist" (see semanticMatcher.unit.test.ts, which already simulates that
-- exact error).
--
-- users_isolation (DATABASE_SCHEMA.sql) restricts SELECT on `users` to the
-- caller's own row, so a plain query can never see other users' embeddings.
-- SECURITY DEFINER is what lets this function bypass that for the one
-- narrow purpose of matching, while still only ever returning a user_id and
-- a similarity score - never onboarding_answers, anon_hash, or anything else.
-- ============================================================================

CREATE OR REPLACE FUNCTION find_similar_users(
  query_embedding vector(1536),
  exclude_user_id uuid,
  match_count int DEFAULT 3,
  min_similarity float DEFAULT 0
)
RETURNS TABLE (user_id uuid, similarity float)
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    u.id AS user_id,
    1 - (u.answer_embedding <=> query_embedding) AS similarity
  FROM users u
  WHERE u.id != exclude_user_id
    AND u.answer_embedding IS NOT NULL
    AND u.is_active
    AND NOT u.is_flagged_for_review
    AND (1 - (u.answer_embedding <=> query_embedding)) >= min_similarity
  ORDER BY u.answer_embedding <=> query_embedding ASC
  LIMIT match_count;
$$ LANGUAGE sql STABLE;

-- Unlike the purge RPCs, this one is meant to be called directly by clients
-- (there's no Supabase Auth session to gate on since identity is
-- device-hash-only - see src/api/auth.ts), so anon/authenticated need
-- EXECUTE. Guarded because those roles only exist on Supabase, not the
-- vanilla Postgres CI uses.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT EXECUTE ON FUNCTION find_similar_users(vector, uuid, int, float)
    TO anon, authenticated;
  END IF;
END
$$;
