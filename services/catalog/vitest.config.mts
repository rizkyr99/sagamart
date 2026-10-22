import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// NestJS's dependency injection reads decorator metadata, which esbuild (Vitest's default) doesn't emit; SWC does.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/instrument.ts'] },
  },
});
