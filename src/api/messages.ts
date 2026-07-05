import type { SupabaseClient } from '@supabase/supabase-js';
import { isValidSessionId } from '../purge/sessionPurger';
import { bytesToHex, hexToBytes } from '../lib/bytea';

/**
 * Pure persistence layer for session_messages, via RPC (send_message,
 * fetch_messages - migration 004; see api/auth.ts for why direct table
 * access doesn't work here). Deliberately never sees plaintext: callers
 * must encrypt client-side before calling sendMessage() and decrypt after
 * fetchMessages() - see crypto/messageEncryption.ts.
 */

export type SupabaseLike = Pick<SupabaseClient, 'rpc'>;

export type MessageErrorCode = 'API_ERROR' | 'INVALID_ID';

export class MessageError extends Error {
  constructor(message: string, public readonly code: MessageErrorCode) {
    super(message);
    this.name = 'MessageError';
  }
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  senderUserId: string;
  contentEncrypted: Uint8Array;
  hasPiiDetected: boolean;
  piiDetectedFields: string[];
  createdAt: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  sender_user_id: string;
  content_encrypted_hex: string; // plain hex (no "\x" prefix) - see migration 004
  has_pii_detected: boolean;
  pii_detected_fields: string[] | null;
  created_at: string;
}

function toMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    senderUserId: row.sender_user_id,
    contentEncrypted: hexToBytes(row.content_encrypted_hex),
    hasPiiDetected: row.has_pii_detected,
    piiDetectedFields: row.pii_detected_fields ?? [],
    createdAt: row.created_at,
  };
}

function requireUuid(value: string, label: string): void {
  if (!isValidSessionId(value)) {
    throw new MessageError(`${label} must be a valid UUID: ${value}`, 'INVALID_ID');
  }
}

export interface SendMessageParams {
  supabase: SupabaseLike;
  sessionId: string;
  senderUserId: string;
  /** Already-encrypted content. This function only persists it. */
  contentEncrypted: Uint8Array;
  /**
   * Must not be later than the room's own expires_at - the DB clamps it down
   * if it is (enforce_message_session_timing trigger), but the row insert
   * still requires a non-null value up front. Pass the room's expiresAt.
   */
  expiresAt: string;
}

export async function sendMessage(params: SendMessageParams): Promise<MessageRecord> {
  const { supabase, sessionId, senderUserId, contentEncrypted, expiresAt } = params;
  requireUuid(sessionId, 'sessionId');
  requireUuid(senderUserId, 'senderUserId');

  const { data, error } = await supabase.rpc('send_message', {
    p_session_id: sessionId,
    p_sender_user_id: senderUserId,
    p_content_encrypted_hex: bytesToHex(contentEncrypted),
    p_expires_at: expiresAt,
  });

  if (error) throw new MessageError(`Failed to send message: ${error.message}`, 'API_ERROR');
  const rows = (data ?? []) as MessageRow[];
  if (rows.length === 0) throw new MessageError('send_message returned no row', 'API_ERROR');
  return toMessage(rows[0]);
}

export async function fetchMessages(
  supabase: SupabaseLike,
  sessionId: string
): Promise<MessageRecord[]> {
  requireUuid(sessionId, 'sessionId');

  const { data, error } = await supabase.rpc('fetch_messages', { p_session_id: sessionId });

  if (error) throw new MessageError(`Failed to fetch messages: ${error.message}`, 'API_ERROR');
  return ((data ?? []) as MessageRow[]).map(toMessage);
}
