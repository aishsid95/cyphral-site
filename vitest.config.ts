import { defineConfig } from 'vitest/config';

// Plain-Node project: pure functions and anything else that doesn't need the
// Workers runtime (D1, etc). *.workers.test.ts (vitest.workers.config.ts,
// `npm run test:d1`) and *.integration.test.ts (vitest.integration.config.ts,
// `npm run test:integration`) run under their own projects instead.
export default defineConfig({
  test: {
    include: ['worker/**/*.test.ts'],
    exclude: ['worker/**/*.workers.test.ts', 'worker/**/*.integration.test.ts', 'node_modules/**'],
  },
});
