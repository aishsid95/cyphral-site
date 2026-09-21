import { defineConfig } from 'vitest/config';

// Plain-Node project: pure functions and anything else that doesn't need the
// Workers runtime (D1, etc). Those tests live in *.workers.test.ts and run
// under vitest.workers.config.ts instead — see `npm run test:d1`.
export default defineConfig({
  test: {
    include: ['worker/**/*.test.ts'],
    exclude: ['worker/**/*.workers.test.ts', 'node_modules/**'],
  },
});
