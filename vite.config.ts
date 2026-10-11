import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The window's web content. Tauri loads it from the dev server (npm run dev) or from out/renderer (npm run build).
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/renderer/src'),
    },
  },
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    outDir: resolve(__dirname, 'out/renderer'),
    emptyOutDir: true,
    // WebView2 on Windows 10/11 is evergreen Chromium. macOS uses the system WKWebView: Safari 14 at least on the
    // oldest supported release (10.15 Catalina); src/renderer/src/polyfills.ts fills what it lacks.
    target: ['chrome105', 'safari14'],
    chunkSizeWarningLimit: 1500,
  },
});
