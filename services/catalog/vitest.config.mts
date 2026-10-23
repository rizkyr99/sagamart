import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// NestJS's dependency injection reads decorator metadata, which esbuild (Vitest's default) doesn't emit; SWC does.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    // Test support straight from source: tests never depend on its dist being built (or rebuilt mid-run).
    alias: {
      '@sagamart/contract-testing': fileURLToPath(
        new URL('../../packages/contract-testing/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/testing/**', 'src/main.ts', 'src/instrument.ts'],
    },
  },
});
