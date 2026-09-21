/**
 * Custom Worker entry, replacing the adapter's default
 * `@astrojs/cloudflare/entrypoints/server` so a `scheduled()` handler can
 * sit alongside Astro's own `fetch` handler — see the Phase 5 routing
 * discussion in the booking build. `handle` is the same function the
 * default entrypoint uses; every non-cron request is served exactly as
 * before.
 *
 * The cron trigger (wrangler.jsonc `triggers.crons`) fires this every 30
 * minutes: expire stale holds, purge bookings past purge_after and
 * rate_events older than 7 days, and alert once per booking whose
 * post-confirmation email failed to send.
 */
import { handle } from '@astrojs/cloudflare/handler';
import { env } from 'cloudflare:workers';
import { runBookingMaintenance } from '../worker/booking/cron';

export default {
  fetch: handle,
  async scheduled(_controller, _env, ctx) {
    ctx.waitUntil(
      runBookingMaintenance({
        db: env.BOOKINGS_DB,
        nowUtc: new Date().toISOString(),
        resendApiKey: env.BOOKING_RESEND_API_KEY,
        ownerEmail: 'hello@cyphral.co.uk',
      }).then((result) => {
        console.log(JSON.stringify({ event: 'booking_maintenance_run', ...result }));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
