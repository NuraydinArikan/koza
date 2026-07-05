import { describe, it, expect } from 'vitest';
import {
  createRoom,
  acceptRoom,
  getRoom,
  getActiveRoomForUser,
  endRoom,
  RoomError,
  SupabaseLike,
} from './rooms';

// ─── test helpers ─────────────────────────────────────────────────────────────

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';
const ROOM_ID = '33333333-3333-3333-3333-333333333333';

type RpcResult = { data: unknown; error: { message: string } | null };

function mockSupabase(result: RpcResult): SupabaseLike {
  return { rpc: () => Promise.resolve(result) } as unknown as SupabaseLike;
}

const roomRow = {
  id: ROOM_ID,
  room_type: 'blind_confessional',
  topic_id: null,
  initiator_user_id: UUID_A,
  accepted_user_id: null,
  status: 'waiting',
  created_at: '2026-01-01T00:00:00Z',
  expires_at: '2026-01-01T01:00:00Z',
};

const expectedRoom = {
  id: ROOM_ID,
  roomType: 'blind_confessional',
  topicId: null,
  initiatorUserId: UUID_A,
  acceptedUserId: null,
  status: 'waiting',
  createdAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-01-01T01:00:00Z',
};

// ─── createRoom ────────────────────────────────────────────────────────────

describe('createRoom', () => {
  it('creates a room and maps the row', async () => {
    const room = await createRoom({
      supabase: mockSupabase({ data: [roomRow], error: null }),
      initiatorUserId: UUID_A,
      roomType: 'blind_confessional',
    });
    expect(room).toEqual(expectedRoom);
  });

  it('rejects a non-UUID initiatorUserId before hitting the network', async () => {
    await expect(
      createRoom({
        supabase: mockSupabase({ data: [roomRow], error: null }),
        initiatorUserId: 'not-a-uuid',
        roomType: 'blind_confessional',
      })
    ).rejects.toThrow(RoomError);
  });

  it('throws RoomError when the insert fails', async () => {
    await expect(
      createRoom({
        supabase: mockSupabase({ data: null, error: { message: 'insert failed' } }),
        initiatorUserId: UUID_A,
        roomType: 'blind_confessional',
      })
    ).rejects.toThrow(RoomError);
  });
});

// ─── acceptRoom ────────────────────────────────────────────────────────────

describe('acceptRoom', () => {
  it('accepts a waiting room', async () => {
    const acceptedRow = { ...roomRow, accepted_user_id: UUID_B, status: 'connecting' };
    const room = await acceptRoom({
      supabase: mockSupabase({ data: [acceptedRow], error: null }),
      roomId: ROOM_ID,
      acceptedUserId: UUID_B,
    });
    expect(room.status).toBe('connecting');
    expect(room.acceptedUserId).toBe(UUID_B);
  });

  it('throws NOT_FOUND when the room is no longer waiting', async () => {
    await expect(
      acceptRoom({
        supabase: mockSupabase({ data: [], error: null }),
        roomId: ROOM_ID,
        acceptedUserId: UUID_B,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ─── getRoom / getActiveRoomForUser ────────────────────────────────────────

describe('getRoom', () => {
  it('returns null when no room matches', async () => {
    const room = await getRoom(mockSupabase({ data: [], error: null }), ROOM_ID);
    expect(room).toBeNull();
  });

  it('returns the mapped room when found', async () => {
    const room = await getRoom(mockSupabase({ data: [roomRow], error: null }), ROOM_ID);
    expect(room).toEqual(expectedRoom);
  });
});

describe('getActiveRoomForUser', () => {
  it('returns the mapped room when an active one exists', async () => {
    const room = await getActiveRoomForUser(mockSupabase({ data: [roomRow], error: null }), UUID_A);
    expect(room).toEqual(expectedRoom);
  });

  it('returns null when the user has no active room', async () => {
    const room = await getActiveRoomForUser(mockSupabase({ data: [], error: null }), UUID_A);
    expect(room).toBeNull();
  });
});

// ─── endRoom ───────────────────────────────────────────────────────────────

describe('endRoom', () => {
  it('resolves without throwing on success', async () => {
    await expect(
      endRoom(mockSupabase({ data: null, error: null }), ROOM_ID, 900)
    ).resolves.toBeUndefined();
  });

  it('throws RoomError when the update fails', async () => {
    await expect(
      endRoom(mockSupabase({ data: null, error: { message: 'update failed' } }), ROOM_ID)
    ).rejects.toThrow(RoomError);
  });
});
