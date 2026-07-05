import type { SupabaseClient } from '@supabase/supabase-js';
import { isValidSessionId } from '../purge/sessionPurger';
import type { RoomType } from '../store/sessionStore';

/**
 * All access goes through RPCs (create_room, accept_room, get_room,
 * get_active_room_for_user, end_room - migration 004), not direct table
 * access: see api/auth.ts for why (RLS policies key off a session setting
 * device-hash identity never populates).
 */
export type SupabaseLike = Pick<SupabaseClient, 'rpc'>;

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

function firstRow(data: unknown): RoomRow | null {
  const rows = (data ?? []) as RoomRow[];
  return rows.length > 0 ? rows[0] : null;
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

  const { data, error } = await supabase.rpc('create_room', {
    p_initiator_user_id: initiatorUserId,
    p_room_type: roomType,
    p_topic_id: topicId ?? null,
    p_duration_minutes: durationMinutes ?? 60,
  });

  if (error) throw new RoomError(`Failed to create room: ${error.message}`, 'API_ERROR');
  const row = firstRow(data);
  if (!row) throw new RoomError('create_room returned no row', 'API_ERROR');
  return toRoom(row);
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

  const { data, error } = await supabase.rpc('accept_room', {
    p_room_id: roomId,
    p_accepted_user_id: acceptedUserId,
  });

  if (error) throw new RoomError(`Failed to accept room: ${error.message}`, 'API_ERROR');
  const row = firstRow(data);
  if (!row) throw new RoomError(`Room not found or no longer waiting: ${roomId}`, 'NOT_FOUND');
  return toRoom(row);
}

export async function getRoom(supabase: SupabaseLike, roomId: string): Promise<Room | null> {
  requireUuid(roomId, 'roomId');

  const { data, error } = await supabase.rpc('get_room', { p_room_id: roomId });

  if (error) throw new RoomError(`Failed to fetch room: ${error.message}`, 'API_ERROR');
  const row = firstRow(data);
  return row ? toRoom(row) : null;
}

/** Most recent non-ended, non-purged room this user is initiator or acceptor of. */
export async function getActiveRoomForUser(
  supabase: SupabaseLike,
  userId: string
): Promise<Room | null> {
  requireUuid(userId, 'userId');

  const { data, error } = await supabase.rpc('get_active_room_for_user', { p_user_id: userId });

  if (error) throw new RoomError(`Failed to fetch active room: ${error.message}`, 'API_ERROR');
  const row = firstRow(data);
  return row ? toRoom(row) : null;
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

  const { error } = await supabase.rpc('end_room', {
    p_room_id: roomId,
    p_actual_duration_seconds: actualDurationSeconds ?? null,
  });

  if (error) throw new RoomError(`Failed to end room: ${error.message}`, 'API_ERROR');
}
