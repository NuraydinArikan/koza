import type { SupabaseClient } from '@supabase/supabase-js';
import { isValidSessionId } from '../purge/sessionPurger';
import type { RoomType } from '../store/sessionStore';

export type SupabaseLike = Pick<SupabaseClient, 'from'>;

export type RoomStatus = 'waiting' | 'connecting' | 'connected' | 'ended' | 'purged';

export type RoomErrorCode = 'API_ERROR' | 'NOT_FOUND' | 'INVALID_ID';

export class RoomError extends Error {
  constructor(message: string, public readonly code: RoomErrorCode) {
    super(message);
    this.name = 'RoomError';
  }
}

export interface Room {
  id: string;
  roomType: RoomType;
  topicId: string | null;
  initiatorUserId: string;
  acceptedUserId: string | null;
  status: RoomStatus;
  createdAt: string;
  expiresAt: string;
}

interface RoomRow {
  id: string;
  room_type: RoomType;
  topic_id: string | null;
  initiator_user_id: string;
  accepted_user_id: string | null;
  status: RoomStatus;
  created_at: string;
  expires_at: string;
}

const ROOM_COLUMNS =
  'id, room_type, topic_id, initiator_user_id, accepted_user_id, status, created_at, expires_at';

function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    roomType: row.room_type,
    topicId: row.topic_id,
    initiatorUserId: row.initiator_user_id,
    acceptedUserId: row.accepted_user_id,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function requireUuid(value: string, label: string): void {
  if (!isValidSessionId(value)) {
    throw new RoomError(`${label} must be a valid UUID: ${value}`, 'INVALID_ID');
  }
}

export interface CreateRoomParams {
  supabase: SupabaseLike;
  initiatorUserId: string;
  roomType: RoomType;
  topicId?: string;
  /** 1-120, DB-enforced. Defaults to 60. */
  durationMinutes?: number;
}

export async function createRoom(params: CreateRoomParams): Promise<Room> {
  const { supabase, initiatorUserId, roomType, topicId, durationMinutes } = params;
  requireUuid(initiatorUserId, 'initiatorUserId');

  const { data, error } = await supabase
    .from('session_rooms')
    .insert({
      initiator_user_id: initiatorUserId,
      room_type: roomType,
      topic_id: topicId ?? null,
      duration_minutes: durationMinutes ?? 60,
    })
    .select(ROOM_COLUMNS)
    .single();

  if (error) throw new RoomError(`Failed to create room: ${error.message}`, 'API_ERROR');
  return toRoom(data as RoomRow);
}

export interface AcceptRoomParams {
  supabase: SupabaseLike;
  roomId: string;
  acceptedUserId: string;
}

/** Accepts a waiting room. Fails if it's no longer waiting (already taken/expired). */
export async function acceptRoom(params: AcceptRoomParams): Promise<Room> {
  const { supabase, roomId, acceptedUserId } = params;
  requireUuid(roomId, 'roomId');
  requireUuid(acceptedUserId, 'acceptedUserId');

  const { data, error } = await supabase
    .from('session_rooms')
    .update({ accepted_user_id: acceptedUserId, status: 'connecting' })
    .eq('id', roomId)
    .eq('status', 'waiting')
    .select(ROOM_COLUMNS)
    .maybeSingle();

  if (error) throw new RoomError(`Failed to accept room: ${error.message}`, 'API_ERROR');
  if (!data) throw new RoomError(`Room not found or no longer waiting: ${roomId}`, 'NOT_FOUND');
  return toRoom(data as RoomRow);
}

export async function getRoom(supabase: SupabaseLike, roomId: string): Promise<Room | null> {
  requireUuid(roomId, 'roomId');

  const { data, error } = await supabase
    .from('session_rooms')
    .select(ROOM_COLUMNS)
    .eq('id', roomId)
    .maybeSingle();

  if (error) throw new RoomError(`Failed to fetch room: ${error.message}`, 'API_ERROR');
  return data ? toRoom(data as RoomRow) : null;
}

/** Most recent non-ended, non-purged room this user is initiator or acceptor of. */
export async function getActiveRoomForUser(
  supabase: SupabaseLike,
  userId: string
): Promise<Room | null> {
  requireUuid(userId, 'userId');

  const { data, error } = await supabase
    .from('session_rooms')
    .select(ROOM_COLUMNS)
    .or(`initiator_user_id.eq.${userId},accepted_user_id.eq.${userId}`)
    .not('status', 'in', '("ended","purged")')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new RoomError(`Failed to fetch active room: ${error.message}`, 'API_ERROR');
  return data ? toRoom(data as RoomRow) : null;
}

/**
 * Marks a room ended. The DB's session-end purge trigger (migration 002)
 * takes it from there — messages and signaling data are deleted server-side.
 */
export async function endRoom(
  supabase: SupabaseLike,
  roomId: string,
  actualDurationSeconds?: number
): Promise<void> {
  requireUuid(roomId, 'roomId');

  const { error } = await supabase
    .from('session_rooms')
    .update({
      status: 'ended',
      ...(actualDurationSeconds !== undefined
        ? { actual_duration_seconds: actualDurationSeconds }
        : {}),
    })
    .eq('id', roomId);

  if (error) throw new RoomError(`Failed to end room: ${error.message}`, 'API_ERROR');
}
