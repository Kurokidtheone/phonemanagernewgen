import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The phone app imports from the desktop source instead of copying it:
//   @shared       -> src/shared (schemas, money, app config, error type)
//   @desktop-i18n -> the desktop translation files
//   (the Api type is in @shared/api, generated from the desktop's Rust core)
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../src/shared'),
      '@desktop-i18n': resolve(__dirname, '../src/renderer/src/i18n'),
      '@': resolve(__dirname, 'src'),
    },
  },
  server: { fs: { allow: [resolve(__dirname, '..')] } },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
