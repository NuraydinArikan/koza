import type { SupabaseClient } from '@supabase/supabase-js';

// ─── public types ─────────────────────────────────────────────────────────────

export type PurgeErrorCode = 'TIMEOUT' | 'API_ERROR' | 'INVALID_SESSION_ID';

export class PurgeError extends Error {
  constructor(message: string, public readonly code: PurgeErrorCode) {
    super(message);
    this.name = 'PurgeError';
  }
}

/** Minimal Supabase-compatible interface; a plain object mock works in tests. */
export type SupabaseLike = Pick<SupabaseClient, 'rpc'>;

export interface SessionPurgerConfig {
  supabase: SupabaseLike;
  timeoutMs?: number; // default 10000 ms
}

/** One row from the `verify_purge_integrity` RPC. */
export interface PurgeIntegrityRow {
  sessionId: string;
  leftoverMessages: number;
  leftoverHeartbeats: number;
  sdpCleared: boolean;
  iceCleared: boolean;
}

export interface PurgeIntegrityReport {
  rows: PurgeIntegrityRow[];
  violations: PurgeIntegrityRow[];
  clean: boolean;
}

// ─── pure utilities ───────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/**
 * True only when a session has been wiped irreversibly:
 * no messages, no heartbeat traces, no WebRTC signaling material left.
 */
export function isPurgeComplete(row: PurgeIntegrityRow): boolean {
  return (
    row.leftoverMessages === 0 &&
    row.leftoverHeartbeats === 0 &&
    row.sdpCleared &&
    row.iceCleared
  );
}

/** Parse a raw RPC row into a typed PurgeIntegrityRow; null if malformed. */
export function parseIntegrityRow(
  raw: Record<string, unknown>
): PurgeIntegrityRow | null {
  const sessionId = raw['session_id'];
  const messages = Number(raw['leftover_messages']);
  const heartbeats = Number(raw['leftover_heartbeats']);
  const sdpCleared = raw['sdp_cleared'];
  const iceCleared = raw['ice_cleared'];

  if (
    !isValidSessionId(sessionId) ||
    !Number.isFinite(messages) ||
    !Number.isFinite(heartbeats) ||
    typeof sdpCleared !== 'boolean' ||
    typeof iceCleared !== 'boolean'
  ) {
    return null;
  }

  return {
    sessionId,
    leftoverMessages: messages,
    leftoverHeartbeats: heartbeats,
    sdpCleared,
    iceCleared,
  };
}

// ─── SessionPurger ────────────────────────────────────────────────────────────

/**
 * Client for the irreversible session-purge pipeline (spec §2.3).
 *
 * Server-side primitives (migration 002, all SECURITY DEFINER and restricted
 * to the service role):
 *
 *   purge_session(uuid)        -> boolean   one session, idempotent
 *   auto_purge_session()       -> integer   sweep of all expired sessions
 *   verify_purge_integrity()   -> TABLE     leftover-data report
 *
 * NOTE: must be used with a service-role Supabase client (never the anon
 * key) - purge RPCs are not executable by `anon` / `authenticated`.
 */
export class SessionPurger {
  private readonly supabase: SupabaseLike;
  private readonly timeoutMs: number;

  constructor(config: SessionPurgerConfig) {
    this.supabase = config.supabase;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  /**
   * Irreversibly purge a single session (messages, heartbeats, SDP, ICE).
   * Returns true if the session was purged now, false if it was already
   * purged or does not exist. Idempotent.
   */
  async purgeSession(sessionId: string): Promise<boolean> {
    if (!isValidSessionId(sessionId)) {
      throw new PurgeError(
        `Not a valid session UUID: ${String(sessionId)}`,
        'INVALID_SESSION_ID'
      );
    }
    const data = await this._rpc('purge_session', {
      target_session_id: sessionId,
    });
    return data === true;
  }

  /** Purge every expired, not-yet-purged session. Returns purge count. */
  async purgeExpiredSessions(): Promise<number> {
    const data = await this._rpc('auto_purge_session', {});
    return typeof data === 'number' && Number.isFinite(data) ? data : 0;
  }

  /** Delete all expired messages across sessions. Returns deletion count. */
  async deleteExpiredMessages(): Promise<number> {
    const data = await this._rpc('auto_delete_expired_messages', {});
    return typeof data === 'number' && Number.isFinite(data) ? data : 0;
  }

  /**
   * Verify that no recoverable data survives for purged/expired sessions.
   * `report.clean === false` means the anonymity guarantee is violated and
   * should fail CI / page an operator.
   */
  async verifyPurgeIntegrity(): Promise<PurgeIntegrityReport> {
    const data = await this._rpc('verify_purge_integrity', {});
    const rawRows = Array.isArray(data)
      ? (data as Record<string, unknown>[])
      : [];

    const rows: PurgeIntegrityRow[] = [];
    for (const raw of rawRows) {
      if (raw === null || typeof raw !== 'object') continue;
      const row = parseIntegrityRow(raw);
      if (row) rows.push(row);
    }

    const violations = rows.filter((r) => !isPurgeComplete(r));
    return { rows, violations, clean: violations.length === 0 };
  }

  // ─── private ───────────────────────────────────────────────────────────────

  private async _rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
    let data: unknown;
    let error: { message: string } | null;

    try {
      const response = await this._withTimeout(
        this.supabase.rpc(fn, args) as unknown as Promise<{
          data: unknown;
          error: { message: string } | null;
        }>,
        this.timeoutMs
      );
      ({ data, error } = response);
    } catch (err) {
      if (err instanceof PurgeError) throw err;
      throw new PurgeError(
        `RPC ${fn} failed: ${(err as Error).message}`,
        'API_ERROR'
      );
    }

    if (error) {
      throw new PurgeError(`Supabase error in ${fn}: ${error.message}`, 'API_ERROR');
    }
    return data;
  }

  private _withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new PurgeError(`Operation timed out after ${ms}ms`, 'TIMEOUT')),
          ms
        )
      ),
    ]);
  }
}

export default SessionPurger;
