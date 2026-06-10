-- ============================================================================
-- MIGRATION 002: AUTO-PURGE ARCHITECTURE (Spec §2.3)
-- ============================================================================
-- Hardens the session purge pipeline:
--   1. Fixes audit-log ordering bug in auto_delete_expired_messages()
--      (log was written AFTER delete, so it never recorded anything)
--   2. purge_session(uuid): irreversible single-session purge, RPC-callable
--   3. auto_purge_session(): now also wipes connection_heartbeat rows
--   4. Trigger: session status -> 'ended' purges immediately (no waiting
--      for the cron sweep)
--   5. verify_purge_integrity(): returns leftover-data counts so CI can
--      assert that no recoverable data survives a purge
--   6. pg_cron schedules (guarded - skipped if extension unavailable)
--
-- All functions are SECURITY DEFINER so they run with owner privileges
-- under RLS; they expose no message content, only counts and ids.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. The base schema defines these with RETURNS void; the new versions return
--    counts. CREATE OR REPLACE cannot change a return type, so drop first.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS auto_delete_expired_messages();
DROP FUNCTION IF EXISTS auto_purge_session();

-- ----------------------------------------------------------------------------
-- 1. FIX: log expired messages BEFORE deleting them
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auto_delete_expired_messages()
RETURNS integer
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  -- Audit first (counts only - never content)
  INSERT INTO anonymization_log (session_id, action_taken, action_timestamp)
  SELECT DISTINCT session_id, 'AUTO_DELETE_EXPIRED_MESSAGES', now()
  FROM session_messages
  WHERE expires_at <= now();

  DELETE FROM session_messages WHERE expires_at <= now();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 2. IRREVERSIBLE SINGLE-SESSION PURGE (RPC-callable)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purge_session(target_session_id UUID)
RETURNS boolean
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  room session_rooms%ROWTYPE;
BEGIN
  SELECT * INTO room FROM session_rooms WHERE id = target_session_id;
  IF NOT FOUND OR room.is_purged THEN
    RETURN false;
  END IF;

  -- 1) All messages (encrypted blobs, masked versions, scores - everything)
  DELETE FROM session_messages WHERE session_id = target_session_id;

  -- 2) Heartbeat / presence traces
  DELETE FROM connection_heartbeat WHERE session_id = target_session_id;

  -- 3) WebRTC signaling material + state
  UPDATE session_rooms
  SET is_purged        = true,
      purged_at        = now(),
      webrtc_sdp_offer = NULL,
      webrtc_sdp_answer = NULL,
      ice_candidates   = '[]'::jsonb,
      status           = 'purged'
  WHERE id = target_session_id;

  -- 4) Audit (id + timestamp only)
  INSERT INTO anonymization_log (session_id, action_taken, action_timestamp)
  VALUES (target_session_id, 'SESSION_PURGED', now());

  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 3. BULK SWEEP: purge every expired, not-yet-purged session
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auto_purge_session()
RETURNS integer
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  expired RECORD;
  purged_count integer := 0;
BEGIN
  FOR expired IN
    SELECT id FROM session_rooms
    WHERE expires_at <= now() AND NOT is_purged
  LOOP
    IF purge_session(expired.id) THEN
      purged_count := purged_count + 1;
    END IF;
  END LOOP;
  RETURN purged_count;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 4. IMMEDIATE PURGE WHEN A SESSION ENDS (timer fired client-side)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_purge_on_session_end()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'ended' AND OLD.status IS DISTINCT FROM 'ended' THEN
    PERFORM purge_session(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_session_end_purge ON session_rooms;
CREATE TRIGGER trigger_session_end_purge
AFTER UPDATE OF status ON session_rooms
FOR EACH ROW
EXECUTE FUNCTION trigger_purge_on_session_end();

-- ----------------------------------------------------------------------------
-- 5. PURGE INTEGRITY VERIFICATION (for CI / maintenance checks)
-- ----------------------------------------------------------------------------
-- A purge is complete when, for every purged or expired session:
--   * zero rows remain in session_messages
--   * zero rows remain in connection_heartbeat
--   * SDP offer/answer are NULL and ice_candidates is empty
CREATE OR REPLACE FUNCTION verify_purge_integrity()
RETURNS TABLE (
  session_id UUID,
  leftover_messages bigint,
  leftover_heartbeats bigint,
  sdp_cleared boolean,
  ice_cleared boolean
)
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    r.id,
    (SELECT count(*) FROM session_messages m WHERE m.session_id = r.id),
    (SELECT count(*) FROM connection_heartbeat h WHERE h.session_id = r.id),
    (r.webrtc_sdp_offer IS NULL AND r.webrtc_sdp_answer IS NULL),
    (r.ice_candidates = '[]'::jsonb OR r.ice_candidates = '{}'::jsonb)
  FROM session_rooms r
  WHERE r.is_purged OR r.expires_at <= now();
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 6. SCHEDULING (pg_cron - available on Supabase; guarded for local dev)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;

    -- Idempotent re-schedule
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname IN ('koza-purge-sessions', 'koza-delete-expired-messages');

    PERFORM cron.schedule(
      'koza-purge-sessions', '* * * * *',
      'SELECT auto_purge_session()'
    );
    PERFORM cron.schedule(
      'koza-delete-expired-messages', '* * * * *',
      'SELECT auto_delete_expired_messages()'
    );
  ELSE
    RAISE NOTICE 'pg_cron unavailable - run scripts/maintenance/purge-sessions.js on a 1-minute external schedule instead';
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 7. LEAST PRIVILEGE: only service_role may invoke purge RPCs
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION purge_session(UUID)            FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION auto_purge_session()           FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION auto_delete_expired_messages() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION verify_purge_integrity()       FROM PUBLIC;

-- Supabase roles exist only on Supabase; guard for vanilla PostgreSQL (CI)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION purge_session(UUID),
                               auto_purge_session(),
                               auto_delete_expired_messages(),
                               verify_purge_integrity()
    FROM anon, authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION purge_session(UUID),
                              auto_purge_session(),
                              auto_delete_expired_messages(),
                              verify_purge_integrity()
    TO service_role;
  END IF;
END
$$;
