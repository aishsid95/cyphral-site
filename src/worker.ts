/**
 * Custom Worker entry, replacing the adapter's default
 * `@astrojs/cloudflare/entrypoints/server` so a `scheduled()` handler can
 * sit alongside Astro's own `fetch` handler. `handle` is the same function
 * the default entrypoint uses; every non-cron request is served exactly as
 * before.
 *
 * The cron trigger (wrangler.jsonc `triggers.crons`) fires this every 30
 * minutes: purge bookings past purge_after and rate_events older than 7
 * days, alert once per booking whose confirmation/notification email
 * failed to send, and send the day-before reminder to any confirmed
 * booking that's due one.
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
        // Undefined, not thrown, if the secret isn't set — cron.ts skips
        // only the alert/reminder steps in that case; both purges still run.
        resendApiKey: env.BOOKING_RESEND_API_KEY,
        ownerEmail: 'hello@cyphral.co.uk',
        rateHmacSecret: env.RATE_HMAC_SECRET,
        mailDailyCapGlobal: env.MAIL_DAILY_CAP ? Number(env.MAIL_DAILY_CAP) : undefined,
      })
        .then((result) => {
          // CronRunResult is plain counts, nothing else — no booking id, no
          // email, no name ever passes through this log line.
          console.log(JSON.stringify({ event: 'booking_maintenance_run', ...result }));
        })
        .catch((err: unknown) => {
          // Error *name* only (e.g. "TypeError") — never err.message, which
          // could echo back a value from whatever failed (a row's data, a
          // query fragment) into the logs.
          console.log(
            JSON.stringify({
              event: 'booking_maintenance_failed',
              errorName: err instanceof Error ? err.name : 'Unknown',
            }),
          );
        }),
    );
  },
} satisfies ExportedHandler<Env>;
