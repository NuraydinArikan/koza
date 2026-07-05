-- ============================================================================
-- MIGRATION 004: RPC-ONLY ACCESS LAYER (device-hash auth + RLS mismatch fix)
-- ============================================================================
-- DATABASE_SCHEMA.sql's RLS policies (users_isolation, message_access) key
-- off current_setting('app.current_user_id'), which is only ever populated
-- by Supabase Auth's JWT-based session. Koza uses device-hash-only identity
-- (api/auth.ts) - there is no Supabase Auth session, so that setting is
-- always NULL and those policies always deny. Direct table access from the
-- anon/authenticated roles can never work under this schema.
--
-- Fix: every read/write the client needs goes through a narrow SECURITY
-- DEFINER RPC (same pattern as find_similar_users in migration 003) that
-- validates/shapes its own inputs instead of relying on row-level policies.
-- RLS stays enabled with no policies on every table - the default-deny
-- means direct REST table access is always blocked, so the RPCs are the
-- only path in, by construction.
--
-- bytea columns (anon_hash, content_encrypted) are exposed to/from these
-- RPCs as plain hex text (encode/decode(..., 'hex')), not the "\x..."
-- literal PostgREST uses for direct table access - simpler for the client,
-- since it never touches those columns directly anymore.
-- ============================================================================

-- ─── auth ───────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION find_user_by_anon_hash(p_anon_hash_hex text)
RETURNS TABLE (
  id uuid,
  anon_hash text,
  voice_preset text,
  avatar_style text
)
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id, encode(u.anon_hash, 'hex'), u.voice_preset, u.avatar_style
  FROM users u
  WHERE u.anon_hash = decode(p_anon_hash_hex, 'hex');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION register_user(
  p_anon_hash_hex text,
  p_onboarding_answers jsonb,
  p_answer_embedding vector(1536),
  p_voice_preset text,
  p_avatar_style text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  anon_hash text,
  voice_preset text,
  avatar_style text
)
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO users (anon_hash, onboarding_answers, answer_embedding, voice_preset, avatar_style)
  VALUES (decode(p_anon_hash_hex, 'hex'), p_onboarding_answers, p_answer_embedding, p_voice_preset, p_avatar_style)
  RETURNING users.id INTO new_id;

  RETURN QUERY
  SELECT u.id, encode(u.anon_hash, 'hex'), u.voice_preset, u.avatar_style
  FROM users u WHERE u.id = new_id;
END;
$$ LANGUAGE plpgsql;

-- ─── rooms ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_room(
  p_initiator_user_id uuid,
  p_room_type text,
  p_topic_id uuid DEFAULT NULL,
  p_duration_minutes int DEFAULT 60
)
RETURNS TABLE (
  id uuid, room_type text, topic_id uuid, initiator_user_id uuid,
  accepted_user_id uuid, status text, created_at timestamp, expires_at timestamp
)
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO session_rooms (initiator_user_id, room_type, topic_id, duration_minutes)
  VALUES (p_initiator_user_id, p_room_type, p_topic_id, p_duration_minutes)
  RETURNING session_rooms.id INTO new_id;

  RETURN QUERY
  SELECT r.id, r.room_type, r.topic_id, r.initiator_user_id, r.accepted_user_id,
         r.status, r.created_at, r.expires_at
  FROM session_rooms r WHERE r.id = new_id;
END;
$$ LANGUAGE plpgsql;

-- Only ever matches (and returns a row) when the room was actually still
-- 'waiting' - api/rooms.ts treats an empty result as NOT_FOUND.
CREATE OR REPLACE FUNCTION accept_room(p_room_id uuid, p_accepted_user_id uuid)
RETURNS TABLE (
  id uuid, room_type text, topic_id uuid, initiator_user_id uuid,
  accepted_user_id uuid, status text, created_at timestamp, expires_at timestamp
)
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE session_rooms
  SET accepted_user_id = p_accepted_user_id, status = 'connecting'
  WHERE session_rooms.id = p_room_id AND session_rooms.status = 'waiting';

  RETURN QUERY
  SELECT r.id, r.room_type, r.topic_id, r.initiator_user_id, r.accepted_user_id,
         r.status, r.created_at, r.expires_at
  FROM session_rooms r
  WHERE r.id = p_room_id AND r.accepted_user_id = p_accepted_user_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_room(p_room_id uuid)
RETURNS TABLE (
  id uuid, room_type text, topic_id uuid, initiator_user_id uuid,
  accepted_user_id uuid, status text, created_at timestamp, expires_at timestamp
)
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.id, r.room_type, r.topic_id, r.initiator_user_id, r.accepted_user_id,
         r.status, r.created_at, r.expires_at
  FROM session_rooms r WHERE r.id = p_room_id;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION get_active_room_for_user(p_user_id uuid)
RETURNS TABLE (
  id uuid, room_type text, topic_id uuid, initiator_user_id uuid,
  accepted_user_id uuid, status text, created_at timestamp, expires_at timestamp
)
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.id, r.room_type, r.topic_id, r.initiator_user_id, r.accepted_user_id,
         r.status, r.created_at, r.expires_at
  FROM session_rooms r
  WHERE (r.initiator_user_id = p_user_id OR r.accepted_user_id = p_user_id)
    AND r.status NOT IN ('ended', 'purged')
  ORDER BY r.created_at DESC
  LIMIT 1;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION end_room(p_room_id uuid, p_actual_duration_seconds int DEFAULT NULL)
RETURNS void
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE session_rooms
  SET status = 'ended',
      actual_duration_seconds = COALESCE(p_actual_duration_seconds, actual_duration_seconds)
  WHERE id = p_room_id;
$$ LANGUAGE sql;

-- ─── messages ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION send_message(
  p_session_id uuid,
  p_sender_user_id uuid,
  p_content_encrypted_hex text,
  p_expires_at timestamp
)
RETURNS TABLE (
  id uuid, session_id uuid, sender_user_id uuid, content_encrypted_hex text,
  has_pii_detected boolean, pii_detected_fields text[], created_at timestamp
)
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO session_messages (session_id, sender_user_id, content_encrypted, expires_at)
  VALUES (p_session_id, p_sender_user_id, decode(p_content_encrypted_hex, 'hex'), p_expires_at)
  RETURNING session_messages.id INTO new_id;

  RETURN QUERY
  SELECT m.id, m.session_id, m.sender_user_id, encode(m.content_encrypted, 'hex'),
         m.has_pii_detected, m.pii_detected_fields, m.created_at
  FROM session_messages m WHERE m.id = new_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fetch_messages(p_session_id uuid)
RETURNS TABLE (
  id uuid, session_id uuid, sender_user_id uuid, content_encrypted_hex text,
  has_pii_detected boolean, pii_detected_fields text[], created_at timestamp
)
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.id, m.session_id, m.sender_user_id, encode(m.content_encrypted, 'hex'),
         m.has_pii_detected, m.pii_detected_fields, m.created_at
  FROM session_messages m
  WHERE m.session_id = p_session_id
  ORDER BY m.created_at ASC;
$$ LANGUAGE sql STABLE;

-- ─── grants ─────────────────────────────────────────────────────────────────
-- These RPCs are the only sanctioned access path for anon/authenticated -
-- direct table access stays denied by RLS-enabled-with-no-policy.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT EXECUTE ON FUNCTION find_user_by_anon_hash(text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION register_user(text, jsonb, vector, text, text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION create_room(uuid, text, uuid, int) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION accept_room(uuid, uuid) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION get_room(uuid) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION get_active_room_for_user(uuid) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION end_room(uuid, int) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION send_message(uuid, uuid, text, timestamp) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION fetch_messages(uuid) TO anon, authenticated;
  END IF;
END
$$;
