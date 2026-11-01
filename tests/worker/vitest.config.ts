import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    testTimeout: 900_000, // the shared CI/dev host may be heavily loaded; correctness, not wall time, is asserted
    hookTimeout: 300_000,
    fileParallelism: false,
    reporters: ['default'],
  },
});
