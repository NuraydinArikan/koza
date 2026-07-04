import { Buffer } from 'buffer';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// simple-peer (via webrtc/signaling.ts) and this app's own Buffer.from()
// checks assume Node's Buffer global, which browsers don't provide.
if (!('Buffer' in window)) {
  (window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
