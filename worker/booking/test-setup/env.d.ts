// Test-only augmentation of the Worker env: TEST_MIGRATIONS is injected via
// `miniflare.bindings` in vitest.workers.config.ts and only exists under
// the Workers vitest project — it is never part of the deployed Worker.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
