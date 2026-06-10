import { describe, it, expect } from 'vitest';
import {
  SessionPurger,
  PurgeError,
  isValidSessionId,
  isPurgeComplete,
  parseIntegrityRow,
  SupabaseLike,
  PurgeIntegrityRow,
} from './sessionPurger';

// ─── test helpers ─────────────────────────────────────────────────────────────

const SESSION_ID = '6f1b2a3c-4d5e-4f60-8a9b-0c1d2e3f4a5b';

interface MockConfig {
  data?: unknown;
  error?: string;
  delayMs?: number;
  /** Captures the last rpc call for assertions. */
  calls?: Array<{ fn: string; args: Record<string, unknown> }>;
}

function mockSupabase(cfg: MockConfig = {}): SupabaseLike {
  return {
    rpc: ((fn: string, args: Record<string, unknown>) => {
      cfg.calls?.push({ fn, args });
      const result = cfg.error
        ? { data: null, error: { message: cfg.error } }
        : { data: cfg.data ?? null, error: null };
      if (cfg.delayMs) {
        return new Promise((resolve) => setTimeout(() => resolve(result), cfg.delayMs));
      }
      return Promise.resolve(result);
    }) as unknown as SupabaseLike['rpc'],
  };
}

const cleanRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  session_id: SESSION_ID,
  leftover_messages: 0,
  leftover_heartbeats: 0,
  sdp_cleared: true,
  ice_cleared: true,
  ...overrides,
});

// ─── isValidSessionId ─────────────────────────────────────────────────────────

describe('isValidSessionId', () => {
  it('accepts a valid v4 UUID', () => {
    expect(isValidSessionId(SESSION_ID)).toBe(true);
  });

  it('accepts uppercase UUIDs', () => {
    expect(isValidSessionId(SESSION_ID.toUpperCase())).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['not a uuid', 'session-123'],
    ['missing segment', '6f1b2a3c-4d5e-4f60-8a9b'],
    ['number', 42],
    ['null', null],
    ['undefined', undefined],
    ['sql injection', "'; DROP TABLE session_messages; --"],
  ])('rejects %s', (_label, value) => {
    expect(isValidSessionId(value)).toBe(false);
  });
});

// ─── isPurgeComplete ──────────────────────────────────────────────────────────

describe('isPurgeComplete', () => {
  const base: PurgeIntegrityRow = {
    sessionId: SESSION_ID,
    leftoverMessages: 0,
    leftoverHeartbeats: 0,
    sdpCleared: true,
    iceCleared: true,
  };

  it('is true when nothing recoverable remains', () => {
    expect(isPurgeComplete(base)).toBe(true);
  });

  it.each([
    ['leftover messages', { leftoverMessages: 1 }],
    ['leftover heartbeats', { leftoverHeartbeats: 3 }],
    ['SDP not cleared', { sdpCleared: false }],
    ['ICE not cleared', { iceCleared: false }],
  ])('is false with %s', (_label, override) => {
    expect(isPurgeComplete({ ...base, ...override })).toBe(false);
  });
});

// ─── parseIntegrityRow ────────────────────────────────────────────────────────

describe('parseIntegrityRow', () => {
  it('parses a well-formed row', () => {
    expect(parseIntegrityRow(cleanRow())).toEqual({
      sessionId: SESSION_ID,
      leftoverMessages: 0,
      leftoverHeartbeats: 0,
      sdpCleared: true,
      iceCleared: true,
    });
  });

  it('coerces bigint-as-string counts (pg returns count() as string)', () => {
    const row = parseIntegrityRow(
      cleanRow({ leftover_messages: '5', leftover_heartbeats: '2' })
    );
    expect(row?.leftoverMessages).toBe(5);
    expect(row?.leftoverHeartbeats).toBe(2);
  });

  it.each([
    ['bad session id', cleanRow({ session_id: 'nope' })],
    ['non-numeric count', cleanRow({ leftover_messages: 'many' })],
    ['non-boolean sdp flag', cleanRow({ sdp_cleared: 'yes' })],
    ['missing fields', { session_id: SESSION_ID }],
  ])('returns null for %s', (_label, raw) => {
    expect(parseIntegrityRow(raw as Record<string, unknown>)).toBeNull();
  });
});

// ─── SessionPurger.purgeSession ───────────────────────────────────────────────

describe('SessionPurger.purgeSession', () => {
  it('calls purge_session RPC with the session id', async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const purger = new SessionPurger({ supabase: mockSupabase({ data: true, calls }) });

    await expect(purger.purgeSession(SESSION_ID)).resolves.toBe(true);
    expect(calls).toEqual([
      { fn: 'purge_session', args: { target_session_id: SESSION_ID } },
    ]);
  });

  it('returns false when session was already purged (idempotency)', async () => {
    const purger = new SessionPurger({ supabase: mockSupabase({ data: false }) });
    await expect(purger.purgeSession(SESSION_ID)).resolves.toBe(false);
  });

  it('rejects invalid session ids without calling the backend', async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const purger = new SessionPurger({ supabase: mockSupabase({ calls }) });

    await expect(purger.purgeSession('not-a-uuid')).rejects.toMatchObject({
      name: 'PurgeError',
      code: 'INVALID_SESSION_ID',
    });
    expect(calls).toHaveLength(0);
  });

  it('wraps Supabase errors as PurgeError API_ERROR', async () => {
    const purger = new SessionPurger({
      supabase: mockSupabase({ error: 'permission denied for function purge_session' }),
    });
    await expect(purger.purgeSession(SESSION_ID)).rejects.toMatchObject({
      code: 'API_ERROR',
    });
  });

  it('times out slow RPCs', async () => {
    const purger = new SessionPurger({
      supabase: mockSupabase({ data: true, delayMs: 100 }),
      timeoutMs: 10,
    });
    await expect(purger.purgeSession(SESSION_ID)).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });
});

// ─── SessionPurger.purgeExpiredSessions / deleteExpiredMessages ───────────────

describe('SessionPurger sweeps', () => {
  it('purgeExpiredSessions returns the purge count', async () => {
    const purger = new SessionPurger({ supabase: mockSupabase({ data: 7 }) });
    await expect(purger.purgeExpiredSessions()).resolves.toBe(7);
  });

  it('deleteExpiredMessages returns the deletion count', async () => {
    const purger = new SessionPurger({ supabase: mockSupabase({ data: 42 }) });
    await expect(purger.deleteExpiredMessages()).resolves.toBe(42);
  });

  it.each([[null], [undefined], ['9'], [NaN]])(
    'returns 0 for malformed count %s',
    async (data) => {
      const purger = new SessionPurger({ supabase: mockSupabase({ data }) });
      await expect(purger.purgeExpiredSessions()).resolves.toBe(0);
    }
  );

  it('propagates backend errors', async () => {
    const purger = new SessionPurger({ supabase: mockSupabase({ error: 'boom' }) });
    await expect(purger.purgeExpiredSessions()).rejects.toBeInstanceOf(PurgeError);
  });
});

// ─── SessionPurger.verifyPurgeIntegrity ───────────────────────────────────────

describe('SessionPurger.verifyPurgeIntegrity', () => {
  it('reports clean when all sessions are fully purged', async () => {
    const purger = new SessionPurger({
      supabase: mockSupabase({ data: [cleanRow(), cleanRow()] }),
    });
    const report = await purger.verifyPurgeIntegrity();
    expect(report.clean).toBe(true);
    expect(report.rows).toHaveLength(2);
    expect(report.violations).toHaveLength(0);
  });

  it('flags sessions with recoverable data as violations', async () => {
    const purger = new SessionPurger({
      supabase: mockSupabase({
        data: [
          cleanRow(),
          cleanRow({ leftover_messages: 3 }),
          cleanRow({ sdp_cleared: false }),
        ],
      }),
    });
    const report = await purger.verifyPurgeIntegrity();
    expect(report.clean).toBe(false);
    expect(report.violations).toHaveLength(2);
  });

  it('skips malformed rows instead of crashing', async () => {
    const purger = new SessionPurger({
      supabase: mockSupabase({
        data: [cleanRow(), { garbage: true }, null],
      }),
    });
    const report = await purger.verifyPurgeIntegrity();
    expect(report.rows).toHaveLength(1);
    expect(report.clean).toBe(true);
  });

  it('treats a non-array response as an empty (clean) report', async () => {
    const purger = new SessionPurger({ supabase: mockSupabase({ data: null }) });
    const report = await purger.verifyPurgeIntegrity();
    expect(report.rows).toHaveLength(0);
    expect(report.clean).toBe(true);
  });
});

// ─── anonymity invariants ─────────────────────────────────────────────────────

describe('anonymity invariants', () => {
  it('never sends anything but the session UUID to the backend', async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const purger = new SessionPurger({ supabase: mockSupabase({ data: true, calls }) });
    await purger.purgeSession(SESSION_ID);

    const sentValues = Object.values(calls[0].args);
    expect(sentValues).toEqual([SESSION_ID]); // no user ids, no content, no metadata
  });

  it('integrity report exposes counts and flags only - no content fields', async () => {
    const purger = new SessionPurger({
      supabase: mockSupabase({
        data: [cleanRow({ content_masked_version: 'leaked!', sender_user_id: 'u1' })],
      }),
    });
    const report = await purger.verifyPurgeIntegrity();
    const keys = Object.keys(report.rows[0]);
    expect(keys.sort()).toEqual(
      ['iceCleared', 'leftoverHeartbeats', 'leftoverMessages', 'sdpCleared', 'sessionId'].sort()
    );
  });
});
