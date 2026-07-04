import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Database } from 'firebase/database';
import { createRoom, acceptRoom, getRoom, endRoom, type Room, type SupabaseLike } from '../api/rooms';
import { sendMessage } from '../api/messages';
import { SignalingHandler, type SignalingState, type PeerConstructor } from '../webrtc/signaling';
import { attachSignalingRelay, type SignalingRelayHandle } from '../webrtc/signalingRelay';
import {
  generateSessionKeyPair,
  deriveSessionKey,
  encryptMessage,
  decryptMessage,
} from '../crypto/messageEncryption';
import { maskPii } from '../safety/piiDetector';
import { bytesToBase64, base64ToBytes } from '../lib/base64';
import { VoiceControl } from './VoiceControl';
import { useAuthStore } from '../store/authStore';
import { useSessionStore } from '../store/sessionStore';

const KEY_EXCHANGE_TYPE = 'key-exchange';
const CHAT_TYPE = 'chat';

export interface BlindConfessionalProps {
  supabase: SupabaseLike;
  database: Database;
  /** Join this waiting room instead of creating a new one. */
  roomId?: string;
  /** Test-only dependency injection point for the underlying WebRTC peer implementation. */
  peerClass?: PeerConstructor;
}

export function BlindConfessional({ supabase, database, roomId, peerClass }: BlindConfessionalProps) {
  const authUser = useAuthStore((s) => s.user);
  const connectionState = useSessionStore((s) => s.connectionState);
  const messages = useSessionStore((s) => s.messages);
  const joinSession = useSessionStore((s) => s.joinSession);
  const setConnectionState = useSessionStore((s) => s.setConnectionState);
  const addMessage = useSessionStore((s) => s.addMessage);
  const leaveSession = useSessionStore((s) => s.leaveSession);

  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [piiWarning, setPiiWarning] = useState(false);
  const [encryptionReady, setEncryptionReady] = useState(false);

  const handlerRef = useRef<SignalingHandler | null>(null);
  const relayRef = useRef<SignalingRelayHandle | null>(null);
  const localKeyPairRef = useRef<Awaited<ReturnType<typeof generateSessionKeyPair>> | null>(null);
  const sessionKeyRef = useRef<CryptoKey | null>(null);
  const maskedStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const roomRef = useRef<Room | null>(null);

  async function handleIncomingData(raw: string) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (parsed['__type'] === KEY_EXCHANGE_TYPE && localKeyPairRef.current) {
      const peerPublicKey = base64ToBytes(parsed['publicKey'] as string);
      sessionKeyRef.current = await deriveSessionKey(localKeyPairRef.current.privateKey, peerPublicKey);
      setEncryptionReady(true);
      return;
    }

    if (parsed['__type'] === CHAT_TYPE && sessionKeyRef.current) {
      const ciphertext = base64ToBytes(parsed['ciphertext'] as string);
      try {
        const plaintext = await decryptMessage(sessionKeyRef.current, ciphertext);
        addMessage({
          id: crypto.randomUUID(),
          senderId: 'peer',
          text: plaintext,
          sentAt: Date.now(),
          fromSelf: false,
        });
      } catch {
        setError('Failed to decrypt an incoming message.');
      }
    }
  }

  useEffect(() => {
    if (!authUser) return undefined;
    let cancelled = false;

    async function setup() {
      try {
        let activeRoom: Room;
        let initiator: boolean;
        let remotePeerId: string | undefined;

        if (roomId) {
          const existing = await getRoom(supabase, roomId);
          if (!existing || existing.status !== 'waiting') {
            throw new Error('This room is no longer available to join.');
          }
          activeRoom = await acceptRoom({ supabase, roomId, acceptedUserId: authUser!.id });
          initiator = false;
          remotePeerId = activeRoom.initiatorUserId;
        } else {
          activeRoom = await createRoom({
            supabase,
            initiatorUserId: authUser!.id,
            roomType: 'blind_confessional',
          });
          initiator = true;
        }
        if (cancelled) return;

        roomRef.current = activeRoom;
        setRoom(activeRoom);
        joinSession({ sessionId: activeRoom.id, roomType: activeRoom.roomType, remotePeerId });

        const keyPair = await generateSessionKeyPair();
        localKeyPairRef.current = keyPair;

        const handler = new SignalingHandler({
          localPeerId: authUser!.id,
          remotePeerId,
          initiator,
          // Spread only when set: SignalingHandler's config merge is a plain
          // object spread, so an explicit `PeerClass: undefined` here would
          // overwrite its internal SimplePeer default with undefined.
          ...(peerClass ? { PeerClass: peerClass } : {}),
        });
        handlerRef.current = handler;

        handler.on('stateChange', (...args: unknown[]) => {
          setConnectionState(args[1] as SignalingState);
        });

        handler.on('connect', () => {
          handler.send(
            JSON.stringify({
              __type: KEY_EXCHANGE_TYPE,
              publicKey: bytesToBase64(keyPair.publicKeyRaw),
            })
          );
          if (maskedStreamRef.current) handler.addStream(maskedStreamRef.current);
        });

        handler.on('stream', (...args: unknown[]) => {
          if (remoteAudioRef.current) {
            remoteAudioRef.current.srcObject = args[0] as MediaStream;
          }
        });

        handler.on('data', (...args: unknown[]) => {
          void handleIncomingData(args[0] as string);
        });

        handler.on('error', (...args: unknown[]) => {
          const err = args[0];
          setError(err instanceof Error ? err.message : 'Connection error');
        });

        relayRef.current = attachSignalingRelay(database, activeRoom.id, authUser!.id, handler);
        handler.start();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to start session');
      }
    }

    void setup();

    return () => {
      cancelled = true;
      relayRef.current?.stop();
      relayRef.current = null;
      handlerRef.current?.destroy();
      handlerRef.current = null;
      leaveSession();
    };
    // Intentionally re-run only when identity or target room changes, not on
    // every render (joinSession/setConnectionState/addMessage/leaveSession
    // are stable Zustand action references).
  }, [authUser?.id, roomId]);

  async function handleSend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !sessionKeyRef.current || !room || !authUser) return;

    const ciphertext = await encryptMessage(sessionKeyRef.current, text);
    handlerRef.current?.send(
      JSON.stringify({ __type: CHAT_TYPE, ciphertext: bytesToBase64(ciphertext) })
    );

    addMessage({
      id: crypto.randomUUID(),
      senderId: authUser.id,
      text,
      sentAt: Date.now(),
      fromSelf: true,
    });
    setDraft('');
    setPiiWarning(false);

    try {
      await sendMessage({
        supabase,
        sessionId: room.id,
        senderUserId: authUser.id,
        contentEncrypted: ciphertext,
        expiresAt: room.expiresAt,
      });
    } catch {
      // Best-effort persistence - the peer already has the message in real
      // time over the data channel regardless of whether this succeeds.
    }
  }

  async function handleLeave() {
    if (roomRef.current) {
      try {
        await endRoom(supabase, roomRef.current.id);
      } catch {
        // room may already be gone/ended; nothing more to do
      }
    }
    relayRef.current?.stop();
    handlerRef.current?.destroy();
    leaveSession();
    setRoom(null);
  }

  function handleDraftChange(value: string) {
    setDraft(value);
    setPiiWarning(maskPii(value).hasPii);
  }

  if (!authUser) {
    return <p>Complete onboarding before starting a session.</p>;
  }

  return (
    <div aria-label="blind-confessional">
      {error && <p role="alert">{error}</p>}

      {!room ? (
        <p>Setting up your session…</p>
      ) : (
        <>
          <p>
            Status: {connectionState}
            {room.initiatorUserId === authUser.id && connectionState !== 'connected' && (
              <>
                {' '}
                — share this room ID: <code>{room.id}</code>
              </>
            )}
          </p>

          <VoiceControl
            onStreamReady={(stream) => {
              maskedStreamRef.current = stream;
              if (handlerRef.current?.isConnected) handlerRef.current.addStream(stream);
            }}
            onStreamEnded={() => {
              maskedStreamRef.current = null;
            }}
          />

          <audio ref={remoteAudioRef} autoPlay aria-label="remote-audio" />

          <ul aria-label="chat-messages">
            {messages.map((m) => (
              <li key={m.id}>
                <strong>{m.fromSelf ? 'You' : 'Them'}:</strong> {m.text}
              </li>
            ))}
          </ul>

          <form onSubmit={handleSend}>
            <input
              value={draft}
              onChange={(e) => handleDraftChange(e.target.value)}
              disabled={!encryptionReady}
              placeholder={encryptionReady ? 'Type a message…' : 'Waiting for secure connection…'}
            />
            <button type="submit" disabled={!draft.trim() || !encryptionReady}>
              Send
            </button>
          </form>
          {piiWarning && <p role="alert">This message looks like it contains personal info.</p>}

          <button type="button" onClick={handleLeave}>
            Leave session
          </button>
        </>
      )}
    </div>
  );
}

export default BlindConfessional;
