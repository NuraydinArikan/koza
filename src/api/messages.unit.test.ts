import { describe, it, expect } from 'vitest';
import { sendMessage, fetchMessages, MessageError, SupabaseLike } from './messages';
import { bytesToHex } from '../lib/bytea';

// ─── test helpers ─────────────────────────────────────────────────────────────

const SESSION_ID = '44444444-4444-4444-4444-444444444444';
const SENDER_ID = '55555555-5555-5555-5555-555555555555';

type RpcResult = { data: unknown; error: { message: string } | null };

function mockSupabase(result: RpcResult): SupabaseLike {
  return { rpc: () => Promise.resolve(result) } as unknown as SupabaseLike;
}

const cipherBytes = new Uint8Array([1, 2, 3, 4]);

const messageRow = {
  id: '66666666-6666-6666-6666-666666666666',
  session_id: SESSION_ID,
  sender_user_id: SENDER_ID,
  content_encrypted_hex: bytesToHex(cipherBytes),
  has_pii_detected: false,
  pii_detected_fields: [],
  created_at: '2026-01-01T00:00:00Z',
};

describe('sendMessage', () => {
  it('persists ciphertext and maps the row back, decoding content_encrypted_hex', async () => {
    const result = await sendMessage({
      supabase: mockSupabase({ data: [messageRow], error: null }),
      sessionId: SESSION_ID,
      senderUserId: SENDER_ID,
      contentEncrypted: cipherBytes,
      expiresAt: '2026-01-01T01:00:00Z',
    });
    expect(result.contentEncrypted).toEqual(cipherBytes);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.hasPiiDetected).toBe(false);
  });

  it('rejects a non-UUID sessionId before hitting the network', async () => {
    await expect(
      sendMessage({
        supabase: mockSupabase({ data: [messageRow], error: null }),
        sessionId: 'not-a-uuid',
        senderUserId: SENDER_ID,
        contentEncrypted: cipherBytes,
        expiresAt: '2026-01-01T01:00:00Z',
      })
    ).rejects.toThrow(MessageError);
  });

  it('throws MessageError when the insert fails', async () => {
    await expect(
      sendMessage({
        supabase: mockSupabase({ data: null, error: { message: 'insert failed' } }),
        sessionId: SESSION_ID,
        senderUserId: SENDER_ID,
        contentEncrypted: cipherBytes,
        expiresAt: '2026-01-01T01:00:00Z',
      })
    ).rejects.toThrow(MessageError);
  });

  it('throws MessageError when the RPC returns no row', async () => {
    await expect(
      sendMessage({
        supabase: mockSupabase({ data: [], error: null }),
        sessionId: SESSION_ID,
        senderUserId: SENDER_ID,
        contentEncrypted: cipherBytes,
        expiresAt: '2026-01-01T01:00:00Z',
      })
    ).rejects.toThrow(MessageError);
  });
});

describe('fetchMessages', () => {
  it('maps rows in order, defaulting missing pii fields to an empty array', async () => {
    const rowWithNullFields = { ...messageRow, pii_detected_fields: null };
    const rows = await fetchMessages(
      mockSupabase({ data: [rowWithNullFields], error: null }),
      SESSION_ID
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].piiDetectedFields).toEqual([]);
    expect(rows[0].contentEncrypted).toEqual(cipherBytes);
  });

  it('throws MessageError when the query fails', async () => {
    await expect(
      fetchMessages(mockSupabase({ data: null, error: { message: 'query failed' } }), SESSION_ID)
    ).rejects.toThrow(MessageError);
  });
});
