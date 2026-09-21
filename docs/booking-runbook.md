# Booking system runbook

Operational reference for `/book`. Read `CLAUDE.md` first for the site's general rules — this file only covers what's specific to booking.

## Architecture at a glance

- **Config-only availability.** `worker/booking/config.ts` is the sole source of truth for your hours. No admin panel, no database-stored schedule. Edit the file, commit, push — the git-connected Cloudflare Workers build takes it live.
- **No calendar integration of any kind.** Nothing reads from or writes to iCloud, Google, or any other calendar. You get an email with a `.ics` file per confirmed booking and add it to your own calendar by hand.
- **Storage:** Cloudflare D1 (`cyphral-bookings`, created with `--jurisdiction=eu`), two tables: `bookings`, `rate_events`.
- **Email:** Resend, from `send.cyphral.co.uk`, separate API key from the contact form's.

## Setup checklist

1. **ICO registration** — confirm the number in `src/pages/privacy.astro` is current before `/book` goes live. Recorded at `ZC179468` as of the last check; verify it's still accurate.
2. **D1** — already created and migrated (both locally and, once Aisha ran it herself, remotely). Future migrations: add a new numbered file under `migrations/`, apply locally first (`npx wrangler d1 migrations apply cyphral-bookings --local`), then remotely (`--remote`) after review.
3. **Turnstile** — create a widget for `cyphral.co.uk` at the Cloudflare dashboard. You'll get a sitekey (public) and a secret key.
   - Sitekey goes in a `PUBLIC_TURNSTILE_SITE_KEY` build environment variable (Cloudflare Workers Builds → your project → Settings → Environment variables — **not** `wrangler secret put`, sitekeys aren't secret). Until this is set, `/book` falls back to Cloudflare's published test sitekey (`1x00000000000000000000AA`), so local/preview builds work without a real widget.
   - Secret key goes in the `TURNSTILE_SECRET_KEY` Worker secret (below).
4. **Resend** — create a second API key, sending access only, restricted to `send.cyphral.co.uk`. This must be a different key from the one the contact form and Gmail "Send mail as" use — see `TURNSTILE_SECRET_KEY` / `BOOKING_RESEND_API_KEY` naming below for why.
5. **Secrets**, via `npx wrangler secret put <NAME>` (production) and in `.dev.vars` (local — already gitignored, never committed):
   - `TURNSTILE_SECRET_KEY` — from step 3.
   - `RATE_HMAC_SECRET` — 32 random bytes, e.g. `openssl rand -hex 32`. Used to HMAC IPs and emails before they ever touch D1; never store the raw value anywhere else, and rotating it just resets everyone's rate-limit history (harmless).
   - `BOOKING_RESEND_API_KEY` — from step 4. Deliberately not named `RESEND_API_KEY`, which is already the contact form's key — a shared name would mean `wrangler secret put RESEND_API_KEY` overwrites one with the other.
   - `MAIL_DAILY_CAP` (optional) — overrides the default cap of 40 booking emails/day if you ever need to.
6. **Cron trigger** — `wrangler.jsonc`'s `main` needs to point at `./src/worker.ts` (not the adapter's default entrypoint) and a `triggers.crons` entry needs adding, so the 30-minute maintenance sweep actually runs. See the diff in the Phase 5 handover — this wasn't applied automatically (the same `Edit(wrangler.jsonc)` deny rule as the D1 binding).
7. **Test end to end** on a preview deployment before this goes fully live: book a real slot, confirm it, check the `.ics` file opens correctly in your calendar app, check the slot disappears from `/book`, cancel it, check the slot reappears. Use an inbox at a different provider (e.g. Outlook) to sanity-check deliverability and that link scanners don't trigger a confirm/cancel by themselves.

## The kill switch

Set the `BOOKING_ENABLED` Worker environment variable to the string `"false"` (via `wrangler.jsonc`'s `vars`, or as a Worker environment variable in the dashboard) to take every `/api/booking/*` route down immediately — they all return `503 { "error": "booking_unavailable" }`. `/book` itself will show "Booking is paused right now" once it gets that response. This doesn't touch the config file, so flipping it back on restores exactly the schedule you had.

## How to change your hours

Edit `worker/booking/config.ts`, commit, push. A short "How to change your hours" comment block sits at the top of that file with the same examples below, kept in sync with this runbook.

**Add a one-off blocked morning** (e.g. a dentist appointment on 3 November 2026, 9am–12pm):

```ts
blockedRanges: [{ start: "2026-11-03T09:00", end: "2026-11-03T12:00" }]
```

Times are Europe/London local, 24-hour clock, no timezone suffix.

**Block a week's holiday** (e.g. Christmas week):

```ts
blockedDates: ["2026-12-22", "2026-12-23", "2026-12-24", "2026-12-29", "2026-12-30", "2026-12-31"]
```

Each entry blocks the whole Europe/London calendar day.

**Change a class time** (e.g. the Saudi qaidah class moves to 17:30–18:00 Riyadh time):

```ts
{ label: "Qaidah (Saudi)", days: ["mon", "tue", "wed"], start: "17:30", end: "18:00", timeZone: "Asia/Riyadh" },
```

The UK-local time this blocks is computed automatically, including across the UK's own clock changes — you never need to hand-adjust for BST/GMT.

**Narrow the jummah bands** once your mosque publishes a timetable (e.g. summer jummah is reliably 13:10–13:40):

```ts
{ label: "Jummah (summer)", days: ["fri"], start: "13:10", end: "13:40", timeZone: "Europe/London", ukSeason: "bst" },
```

Narrower bands free up more Friday slots either side of prayer. The winter band works the same way.

**Add the US qaidah class** once its time is confirmed — add a new entry to `recurringBlocks` following the same shape as the existing classes:

```ts
{ label: "Qaidah (US)", days: ["thu"], start: "18:00", end: "18:30", timeZone: "America/New_York" },
```

After any config change: `npm run test` locally re-validates the config (a typo — bad day name, time, timezone — fails the test suite, so it can't deploy) before you push.

## Bank holiday data

`worker/booking/bank-holidays.json` is committed, fetched from gov.uk. Re-run `npm run fetch-bank-holidays` periodically (the availability engine fails closed — offers no slots at all — for any date beyond the last one in this file, so letting it go stale just means fewer slots shown, never a wrongly-offered bank holiday).

## Looking up and cancelling a booking manually

Via `wrangler d1 execute cyphral-bookings --remote --command "..."` (drop `--remote` to check the local database instead):

```sql
-- Find a booking by the visitor's email
SELECT id, slot_start_utc, status, name, email, topic FROM bookings WHERE email_key = 'visitor@example.com';

-- Find everything happening this week
SELECT id, slot_start_utc, status, name, topic FROM bookings
  WHERE status IN ('held','confirmed') AND slot_start_utc >= '2026-07-20T00:00:00Z'
  ORDER BY slot_start_utc;

-- Cancel a booking by id (mirrors what /api/booking/cancel does)
UPDATE bookings SET status = 'cancelled', cancelled_at = '2026-07-19T12:00:00Z', cancel_token_hash = NULL
  WHERE id = '<booking-id>' AND status = 'confirmed';
```

After manually cancelling, email the visitor yourself — the automated cancellation email only fires through the `/api/booking/cancel` route.

## Rotating secrets

`npx wrangler secret put <NAME>` prompts for a new value and replaces the old one immediately — no downtime, no code change needed. Rotate:

- `TURNSTILE_SECRET_KEY` — from the Turnstile widget settings if you suspect it's leaked. Old in-flight tokens (5-minute lifetime) will fail verification during the rotation window; not worth scheduling around.
- `RATE_HMAC_SECRET` — any time; only effect is that existing rate-limit history becomes unreadable (treated as if it doesn't exist), so it's a soft reset of everyone's limits, not a security issue.
- `BOOKING_RESEND_API_KEY` — from the Resend dashboard if it leaks. Revoke the old key there too, not just in Wrangler.

## Cron job

Runs every 30 minutes (once the deferred `wrangler.jsonc` change is applied — see setup step 6): expires stale holds, purges bookings past `purge_after` (90 days after the call) and `rate_events` older than 7 days, and alerts you once per booking where the post-confirmation email failed to send (`bookings.mail_failed = 1`). Check the Worker's logs (Cloudflare dashboard → Workers → Logs, or `wrangler tail`) if you want to confirm it's actually firing — each run logs a single `booking_maintenance_run` line with counts.
