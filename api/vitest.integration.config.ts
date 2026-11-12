import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    clearMocks: true,
    fileParallelism: false,
    testTimeout: 150_000,
    hookTimeout: 45_000,
  },
});
