import { ref, push, onChildAdded, serverTimestamp, type Database } from 'firebase/database';
import type { SignalingHandler, SignalMessage } from './signaling';

export interface SignalingRelayHandle {
  stop(): void;
}

/**
 * Bridges the transport-agnostic SignalingHandler (webrtc/signaling.ts) to
 * Firebase Realtime Database: forwards its outgoing 'signal' events into
 * the remote peer's inbox at signaling/{sessionId}/{peerId}, and feeds
 * incoming messages from the local peer's own inbox into
 * handler.receiveSignal().
 *
 * Firebase only ever relays SDP/ICE metadata here, matching "Signaling
 * Server (Minimal Role)" (SYSTEM_SPECIFICATION.md §6.2) - it never sees
 * audio or chat content, both of which travel over the WebRTC connection
 * directly once peers connect.
 */
export function attachSignalingRelay(
  database: Database,
  sessionId: string,
  localPeerId: string,
  handler: SignalingHandler
): SignalingRelayHandle {
  const inboxRef = ref(database, `signaling/${sessionId}/${localPeerId}`);

  const onSignal = (...args: unknown[]) => {
    const message = args[0] as SignalMessage;
    const outboxRef = ref(database, `signaling/${sessionId}/${message.targetPeerId}`);
    void push(outboxRef, { ...message, relayedAt: serverTimestamp() });
  };
  handler.on('signal', onSignal);

  const unsubscribe = onChildAdded(inboxRef, (snapshot) => {
    const message = snapshot.val() as SignalMessage | null;
    // Skip self-authored entries (a peer's own outgoing messages never
    // land in its own inbox, but guards against any relay bugs that would).
    if (message && message.peerId !== localPeerId) {
      handler.receiveSignal(message);
    }
  });

  return {
    stop() {
      handler.off('signal', onSignal);
      unsubscribe();
    },
  };
}
