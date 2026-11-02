import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    testTimeout: 20_000,
    environment: 'node',
  },
});
