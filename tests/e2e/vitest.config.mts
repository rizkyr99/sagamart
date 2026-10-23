import { defineConfig } from 'vitest/config';

// The suite drives one shared stack and stops a container mid-way, so its tests run in order, one file at a time.
export default defineConfig({
  test: {
    include: ['src/**/*.e2e.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
