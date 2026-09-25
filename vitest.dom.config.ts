import { defineConfig } from 'vitest/config';

// DOM project: client-side page scripts under src/scripts/ that manipulate
// a real document (form state, button enable/disable, event listeners).
// happy-dom simulates the browser environment; Turnstile's own widget script
// is never loaded here — window.turnstile and its callbacks are stubbed per
// test, and the tests drive them the same way the real Turnstile script
// would (calling the page's own cyphralTurnstileSuccess/Error/Expired
// globals), so what's under test is book.ts's own logic, not Cloudflare's.
export default defineConfig({
  test: {
    include: ['src/scripts/**/*.test.ts'],
    environment: 'happy-dom',
  },
});
