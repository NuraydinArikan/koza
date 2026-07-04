// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// jsdom's `crypto` has no SubtleCrypto implementation at all (crypto.subtle
// is simply missing), which breaks the real ECDH/AES-GCM this component
// performs. `crypto` itself can't be reassigned (accessor property with no
// setter), so patch just the missing `subtle` piece with Node's own
// spec-compliant WebCrypto implementation.
Object.defineProperty(globalThis.crypto, 'subtle', {
  value: webcrypto.subtle,
  configurable: true,
});

vi.mock('../api/rooms');
vi.mock('../api/messages');
vi.mock('../webrtc/signalingRelay');
vi.mock('./VoiceControl', () => ({
  VoiceControl: () => null,
}));

import { BlindConfessional } from './BlindConfessional';
import { useAuthStore } from '../store/authStore';
import { useSessionStore } from '../store/sessionStore';
import * as roomsApi from '../api/rooms';
import * as messagesApi from '../api/messages';
import * as relayModule from '../webrtc/signalingRelay';
import type { PeerConstructor } from '../webrtc/signaling';
import { generateSessionKeyPair, deriveSessionKey, encryptMessage, decryptMessage } from '../crypto/messageEncryption';
import { bytesToBase64, base64ToBytes } from '../lib/base64';

// ─── fake WebRTC peer ───────────────────────────────────────────────────────

class FakePeer {
  static instances: FakePeer[] = [];
  private listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  destroyed = false;
  connected = false;
  sent: string[] = [];

  constructor(_opts: Record<string, unknown>) {
    FakePeer.instances.push(this);
  }

  on(event: string, fn: (...a: unknown[]) => void) {
    (this.listeners[event] ??= []).push(fn);
    return this;
  }
  off(event: string, fn: (...a: unknown[]) => void) {
    this.listeners[event] = (this.listeners[event] ?? []).filter((f) => f !== fn);
    return this;
  }
  once(event: string, fn: (...a: unknown[]) => void) {
    const wrapped = (...a: unknown[]) => {
      this.off(event, wrapped);
      fn(...a);
    };
    return this.on(event, wrapped);
  }
  removeAllListeners() {
    this.listeners = {};
    return this;
  }
  signal() {}
  send(data: string) {
    this.sent.push(data);
  }
  addStream() {}
  destroy() {
    this.destroyed = true;
  }

  connectNow() {
    this.connected = true;
    this.emit('connect');
  }
  emitData(data: string) {
    this.emit('data', Buffer.from(data));
  }

  private emit(event: string, ...args: unknown[]) {
    for (const fn of this.listeners[event] ?? []) fn(...args);
  }
}

const room = {
  id: 'room-1',
  roomType: 'blind_confessional' as const,
  topicId: null,
  initiatorUserId: 'user-1',
  acceptedUserId: null,
  status: 'waiting' as const,
  createdAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-01-01T01:00:00Z',
};

const fakeDatabase = {} as Parameters<typeof relayModule.attachSignalingRelay>[0];
const fakeSupabase = {} as roomsApi.SupabaseLike;

async function waitForFakePeer(): Promise<FakePeer> {
  await waitFor(() => expect(FakePeer.instances.length).toBeGreaterThan(0));
  return FakePeer.instances[0];
}

describe('BlindConfessional', () => {
  beforeEach(() => {
    FakePeer.instances = [];
    vi.clearAllMocks();
    useAuthStore.getState().logout();
    useAuthStore.getState().setUser({ id: 'user-1', anonHash: 'a'.repeat(64) });
    useSessionStore.getState().leaveSession();

    vi.mocked(relayModule.attachSignalingRelay).mockReturnValue({ stop: vi.fn() });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows a message when the user has not onboarded yet', () => {
    useAuthStore.getState().logout();
    render(<BlindConfessional supabase={fakeSupabase} database={fakeDatabase} />);
    expect(screen.getByText(/complete onboarding/i)).toBeInTheDocument();
  });

  it('creates a room as initiator and shows the room id to share', async () => {
    vi.mocked(roomsApi.createRoom).mockResolvedValue(room);

    render(
      <BlindConfessional
        supabase={fakeSupabase}
        database={fakeDatabase}
        peerClass={FakePeer as unknown as PeerConstructor}
      />
    );

    await waitFor(() => expect(screen.getByText(/share this room id/i)).toBeInTheDocument());
    expect(roomsApi.createRoom).toHaveBeenCalledWith({
      supabase: fakeSupabase,
      initiatorUserId: 'user-1',
      roomType: 'blind_confessional',
    });
    // setRoom() (which the "share this room id" text depends on) happens
    // before generateSessionKeyPair()/attachSignalingRelay() in the same
    // effect, so wait for the relay call explicitly rather than assuming
    // it's already settled once the room id renders.
    await waitFor(() =>
      expect(relayModule.attachSignalingRelay).toHaveBeenCalledWith(
        fakeDatabase,
        'room-1',
        'user-1',
        expect.anything()
      )
    );
  });

  it('accepts an existing room when given a roomId, without showing the share prompt', async () => {
    // Must belong to someone else - can't join your own room.
    const otherUsersRoom = { ...room, initiatorUserId: 'other-user' };
    vi.mocked(roomsApi.getRoom).mockResolvedValue(otherUsersRoom);
    vi.mocked(roomsApi.acceptRoom).mockResolvedValue({
      ...otherUsersRoom,
      acceptedUserId: 'user-1',
      status: 'connecting',
    });

    render(
      <BlindConfessional
        supabase={fakeSupabase}
        database={fakeDatabase}
        roomId="room-1"
        peerClass={FakePeer as unknown as PeerConstructor}
      />
    );

    await waitFor(() =>
      expect(roomsApi.acceptRoom).toHaveBeenCalledWith({
        supabase: fakeSupabase,
        roomId: 'room-1',
        acceptedUserId: 'user-1',
      })
    );
    expect(screen.queryByText(/share this room id/i)).not.toBeInTheDocument();
  });

  it('shows an error when the room to join is no longer available', async () => {
    vi.mocked(roomsApi.getRoom).mockResolvedValue({ ...room, status: 'ended' });

    render(
      <BlindConfessional
        supabase={fakeSupabase}
        database={fakeDatabase}
        roomId="room-1"
        peerClass={FakePeer as unknown as PeerConstructor}
      />
    );

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/no longer available/i)
    );
    expect(roomsApi.acceptRoom).not.toHaveBeenCalled();
  });

  it('performs the ECDH handshake on connect and can send/receive encrypted chat', async () => {
    vi.mocked(roomsApi.createRoom).mockResolvedValue(room);

    render(
      <BlindConfessional
        supabase={fakeSupabase}
        database={fakeDatabase}
        peerClass={FakePeer as unknown as PeerConstructor}
      />
    );

    const peer = await waitForFakePeer();
    peer.connectNow();

    // Component sent its ECDH public key as the first data-channel message.
    await waitFor(() => expect(peer.sent).toHaveLength(1));
    const keyExchangeMsg = JSON.parse(peer.sent[0]) as { __type: string; publicKey: string };
    expect(keyExchangeMsg.__type).toBe('key-exchange');

    // Simulate the remote peer's side of the same handshake to get a shared key.
    const peerKeyPair = await generateSessionKeyPair();
    const componentPublicKey = base64ToBytes(keyExchangeMsg.publicKey);
    const sharedKey = await deriveSessionKey(peerKeyPair.privateKey, componentPublicKey);

    peer.emitData(
      JSON.stringify({
        __type: 'key-exchange',
        publicKey: bytesToBase64(peerKeyPair.publicKeyRaw),
      })
    );

    await waitFor(() =>
      expect(screen.getByPlaceholderText(/type a message/i)).not.toBeDisabled()
    );

    // Send a message from our side.
    fireEvent.change(screen.getByPlaceholderText(/type a message/i), {
      target: { value: 'hello from me' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() => expect(peer.sent.length).toBeGreaterThan(1));
    const chatMsg = JSON.parse(peer.sent[peer.sent.length - 1]) as {
      __type: string;
      ciphertext: string;
    };
    expect(chatMsg.__type).toBe('chat');
    const decrypted = await decryptMessage(sharedKey, base64ToBytes(chatMsg.ciphertext));
    expect(decrypted).toBe('hello from me');
    expect(screen.getByText('hello from me')).toBeInTheDocument();
    expect(messagesApi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'room-1', senderUserId: 'user-1' })
    );

    // Receive an incoming message from the peer, encrypted with the shared key.
    const incomingCiphertext = await encryptMessage(sharedKey, 'hello from them');
    peer.emitData(
      JSON.stringify({
        __type: 'chat',
        ciphertext: bytesToBase64(incomingCiphertext),
      })
    );

    await waitFor(() => expect(screen.getByText('hello from them')).toBeInTheDocument());
  });

  it('warns when the draft message looks like it contains PII', async () => {
    vi.mocked(roomsApi.createRoom).mockResolvedValue(room);

    render(
      <BlindConfessional
        supabase={fakeSupabase}
        database={fakeDatabase}
        peerClass={FakePeer as unknown as PeerConstructor}
      />
    );

    await waitForFakePeer();
    fireEvent.change(screen.getByPlaceholderText(/waiting for secure connection|type a message/i), {
      target: { value: 'call me at 5551234567' },
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/personal info/i);
  });

  it('ends the room and tears down signaling when leaving', async () => {
    vi.mocked(roomsApi.createRoom).mockResolvedValue(room);
    vi.mocked(roomsApi.endRoom).mockResolvedValue(undefined);
    const relayStop = vi.fn();
    vi.mocked(relayModule.attachSignalingRelay).mockReturnValue({ stop: relayStop });

    render(
      <BlindConfessional
        supabase={fakeSupabase}
        database={fakeDatabase}
        peerClass={FakePeer as unknown as PeerConstructor}
      />
    );

    // Wait for the relay to actually be attached (happens after the room-id
    // text renders, in the same effect) before leaving, so relayRef.current
    // is populated and handleLeave's relayRef.current?.stop() isn't a no-op.
    await waitFor(() => expect(relayModule.attachSignalingRelay).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /leave session/i }));

    await waitFor(() => expect(roomsApi.endRoom).toHaveBeenCalledWith(fakeSupabase, 'room-1'));
    expect(relayStop).toHaveBeenCalled();
    expect(useSessionStore.getState().sessionId).toBeNull();
  });
});
