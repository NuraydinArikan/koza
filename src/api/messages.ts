import type { SupabaseClient } from '@supabase/supabase-js';
import { isValidSessionId } from '../purge/sessionPurger';
import { toBytea, fromBytea } from '../lib/bytea';

/**
 * Pure persistence layer for session_messages. Deliberately never sees
 * plaintext: callers must encrypt client-side before calling sendMessage()
 * and decrypt after fetchMessages(). That encryption step (real
 * per-session AES-256-GCM key material, not yet implemented anywhere in
 * this codebase) is a separate concern - see the "message encryption key
 * derivation" follow-up task.
 */

export type SupabaseLike = Pick<SupabaseClient, 'from'>;

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
  content_encrypted: string; // "\x..." hex, per PostgREST bytea representation
  has_pii_detected: boolean;
  pii_detected_fields: string[] | null;
  created_at: string;
}

const MESSAGE_COLUMNS =
  'id, session_id, sender_user_id, content_encrypted, has_pii_detected, pii_detected_fields, created_at';

function toMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    senderUserId: row.sender_user_id,
    contentEncrypted: fromBytea(row.content_encrypted),
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

  const { data, error } = await supabase
    .from('session_messages')
    .insert({
      session_id: sessionId,
      sender_user_id: senderUserId,
      content_encrypted: toBytea(contentEncrypted),
      expires_at: expiresAt,
    })
    .select(MESSAGE_COLUMNS)
    .single();

  if (error) throw new MessageError(`Failed to send message: ${error.message}`, 'API_ERROR');
  return toMessage(data as MessageRow);
}

export async function fetchMessages(
  supabase: SupabaseLike,
  sessionId: string
): Promise<MessageRecord[]> {
  requireUuid(sessionId, 'sessionId');

  const { data, error } = await supabase
    .from('session_messages')
    .select(MESSAGE_COLUMNS)
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });

  if (error) throw new MessageError(`Failed to fetch messages: ${error.message}`, 'API_ERROR');
  return (data as MessageRow[]).map(toMessage);
}
