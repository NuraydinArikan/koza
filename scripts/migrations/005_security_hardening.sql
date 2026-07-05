-- ============================================================================
-- MIGRATION 005: SECURITY HARDENING (findings from Supabase security advisor)
-- ============================================================================
-- Deploying migrations 001-004 against the real koza-prod project surfaced
-- three real issues via `get_advisors` that a local-only Postgres+pgvector
-- test run can't catch (it has no PostgREST/anon-role layer to flag them):
--
-- 1. session_statistics / moderation_workload views were created as
--    SECURITY DEFINER (Postgres's default view behavior), meaning they'd
--    bypass RLS-enabled-with-no-policy on session_rooms/moderation_queue
--    and leak real row data to anyone with anon/authenticated access via
--    PostgREST. Neither view is used anywhere in the app - force
--    security_invoker so they respect the caller's (denied) access instead
--    of the view owner's.
-- 2. Postgres grants EXECUTE to PUBLIC by default on function creation
--    unless explicitly revoked. auto_delete_expired_messages(),
--    mask_pii_in_text(), detect_and_mask_pii() (trigger),
--    execute_scheduled_user_deletions(), enforce_message_session_timing()
--    (trigger) never had that revoke - meaning any anon client could call
--    them directly via /rest/v1/rpc/..., including
--    execute_scheduled_user_deletions() which deletes user accounts.
--    Migration 002 also missed trigger_purge_on_session_end() in its own
--    revoke list. None of these are meant to be called directly by
--    clients - only by triggers/pg_cron/service_role.
-- 3. search_path pinned on the functions that were missing it, matching
--    the pattern already used in migrations 002-004.
-- ============================================================================

ALTER VIEW session_statistics SET (security_invoker = true);
ALTER VIEW moderation_workload SET (security_invoker = true);

CREATE OR REPLACE FUNCTION mask_pii_in_text(text_input TEXT)
RETURNS TABLE(masked_text TEXT, patterns TEXT[])
SET search_path = public
AS $$
DECLARE
  masked_text TEXT := text_input;
  detected_patterns TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF text_input ~ '\d{10,}' THEN
    masked_text := regexp_replace(masked_text, '\d{10,}', '[PHONE_REDACTED]', 'g');
    detected_patterns := array_append(detected_patterns, 'phone_number');
  END IF;

  IF text_input ~ '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' THEN
    masked_text := regexp_replace(
      masked_text,
      '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}',
      '[EMAIL_REDACTED]',
      'g'
    );
    detected_patterns := array_append(detected_patterns, 'email');
  END IF;

  IF text_input ~ '@[a-zA-Z0-9_]{2,}' THEN
    masked_text := regexp_replace(masked_text, '@[a-zA-Z0-9_]{2,}', '[HANDLE_REDACTED]', 'g');
    detected_patterns := array_append(detected_patterns, 'social_media_handle');
  END IF;

  IF text_input ~ '\d+\s+(main|oak|elm|street|ave|boulevard|drive|lane|road)' THEN
    masked_text := regexp_replace(
      masked_text,
      '\d+\s+(main|oak|elm|street|ave|boulevard|drive|lane|road)',
      '[ADDRESS_REDACTED]',
      'gi'
    );
    detected_patterns := array_append(detected_patterns, 'street_address');
  END IF;

  RETURN QUERY SELECT masked_text, detected_patterns;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION detect_and_mask_pii()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE
  plaintext TEXT;
  masked_content TEXT;
  detected_patterns TEXT[];
BEGIN
  BEGIN
    plaintext := pgp_sym_decrypt(NEW.content_encrypted, 'session_key');
  EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
  END;

  SELECT m.masked_text, m.patterns
  INTO masked_content, detected_patterns
  FROM mask_pii_in_text(plaintext) AS m;

  IF array_length(detected_patterns, 1) > 0 THEN
    NEW.has_pii_detected := true;
    NEW.pii_detected_fields := detected_patterns;
    NEW.content_masked_version := masked_content;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION execute_scheduled_user_deletions()
RETURNS void
SET search_path = public
AS $$
DECLARE
  user_to_delete RECORD;
BEGIN
  FOR user_to_delete IN
    SELECT user_id FROM user_deletion_requests
    WHERE scheduled_deletion_at <= now() AND NOT is_cancelled
  LOOP
    DELETE FROM session_rooms WHERE initiator_user_id = user_to_delete.user_id OR accepted_user_id = user_to_delete.user_id;
    DELETE FROM users WHERE id = user_to_delete.user_id;
    UPDATE user_deletion_requests
    SET scheduled_deletion_at = now()
    WHERE user_id = user_to_delete.user_id;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_message_session_timing()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE
  room RECORD;
BEGIN
  SELECT created_at, expires_at INTO room
  FROM session_rooms WHERE id = NEW.session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'session % does not exist', NEW.session_id;
  END IF;
  IF NEW.created_at < room.created_at THEN
    RAISE EXCEPTION 'message cannot be older than its session';
  END IF;
  IF NEW.expires_at > room.expires_at THEN
    NEW.expires_at := room.expires_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Not meant to be called directly by any client - internal/scheduled only.
REVOKE EXECUTE ON FUNCTION auto_delete_expired_messages() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION mask_pii_in_text(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION detect_and_mask_pii() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION execute_scheduled_user_deletions() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION enforce_message_session_timing() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION trigger_purge_on_session_end() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION auto_delete_expired_messages() FROM anon, authenticated;
    REVOKE EXECUTE ON FUNCTION mask_pii_in_text(TEXT) FROM anon, authenticated;
    REVOKE EXECUTE ON FUNCTION detect_and_mask_pii() FROM anon, authenticated;
    REVOKE EXECUTE ON FUNCTION execute_scheduled_user_deletions() FROM anon, authenticated;
    REVOKE EXECUTE ON FUNCTION enforce_message_session_timing() FROM anon, authenticated;
    REVOKE EXECUTE ON FUNCTION trigger_purge_on_session_end() FROM anon, authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION auto_delete_expired_messages() TO service_role;
    GRANT EXECUTE ON FUNCTION execute_scheduled_user_deletions() TO service_role;
  END IF;
END
$$;
