import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // simple-peer (webrtc/signaling.ts) and its dependencies assume Node's
  // `global`; Vite doesn't polyfill it the way webpack historically did.
  // Buffer is polyfilled separately, in main.tsx.
  define: {
    global: 'globalThis',
  },
  server: {
    port: 5173,
  },
});
