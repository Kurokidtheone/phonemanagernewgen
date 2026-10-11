import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests of the shared code and the window's helpers. The core's tests are Rust: `cargo test --workspace`.
export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared'), '@': resolve(__dirname, 'src/renderer/src') } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
