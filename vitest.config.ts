import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    benchmark: { include: ['bench/**/*.bench.ts'] },
    testTimeout: 30000,
  },
});
