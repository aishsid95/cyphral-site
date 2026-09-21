import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Setup files run outside per-test-file storage isolation and may run more
// than once; applyD1Migrations() only applies migrations not already
// recorded as applied, so this is safe to call unconditionally.
await applyD1Migrations(env.BOOKINGS_DB, env.TEST_MIGRATIONS);
