# Booking system runbook

Operational reference for `/book`. Read `CLAUDE.md` first for the site's general rules — this file only covers what's specific to booking.

## Architecture at a glance

- **Config-only availability.** `worker/booking/config.ts` is the sole source of truth for your hours. No admin panel, no database-stored schedule. Edit the file, commit, push — the git-connected Cloudflare Workers build takes it live.
- **No calendar integration of any kind.** Nothing reads from or writes to iCloud, Google, or any other calendar. You get an email with a `.ics` file per confirmed booking and add it to your own calendar by hand.
- **No email verification step.** `POST /api/booking/book` creates a confirmed booking directly — Turnstile, rate limits, the mail budget, and the one-live-booking-per-email check are the gate, not a click-to-confirm email. The booker's confirmation email (with their cancel link) and your notification email (with the `.ics`) both go out immediately, in the same request. `/book/confirm` is a retired static page now — see "The retired verification flow" below.
- **Storage:** Cloudflare D1 (`cyphral-bookings`, created with `--jurisdiction=eu`), two tables: `bookings`, `rate_events`.
- **Email:** Resend, from `send.cyphral.co.uk`, separate API key from the contact form's. Templates live in `worker/booking/emails/`: confirmed, day-before reminder, and cancelled go to the booker; a new-booking notification (with the `.ics`) and a cancellation note go to you.

## Setup checklist

1. **ICO registration** — confirm the number in `src/pages/privacy.astro` is current before `/book` goes live. Recorded at `ZC179468` as of the last check; verify it's still accurate.
2. **D1** — already created and migrated locally; **migration `0003_reminder_sent_at.sql` (adds `bookings.reminder_sent_at`) still needs `--remote` applied before this deploys**, the same as any other pending migration. Future migrations: add a new numbered file under `migrations/`, apply locally first (`npx wrangler d1 migrations apply cyphral-bookings --local`), then remotely (`--remote`) after review.
3. **Turnstile** — create a widget for `cyphral.co.uk` at the Cloudflare dashboard. You'll get a sitekey (public) and a secret key.
   - Sitekey goes in a `PUBLIC_TURNSTILE_SITE_KEY` build environment variable (Cloudflare Workers Builds → your project → Settings → Environment variables — **not** `wrangler secret put`, sitekeys aren't secret). Until this is set, `/book` falls back to Cloudflare's published test sitekey (`1x00000000000000000000AA`), so local/preview builds work without a real widget.
   - Secret key goes in the `TURNSTILE_SECRET_KEY` Worker secret (below).
   - Cloudflare's test sitekey/secret pair always reports the visitor's hostname as `example.com` in its siteverify response — not whatever domain actually loaded the widget — and never includes an `action` field at all. `book.ts` checks the hostname it gets back against `TURNSTILE_EXPECTED_HOSTNAME` (defaulting to `cyphral.co.uk` when unset) and only enforces the action match when the field is present, so anywhere you're using the test keys — local dev, or a preview deploy that hasn't been given the real widget — needs `TURNSTILE_EXPECTED_HOSTNAME=example.com` set too, or every booking request 403s. Already set this way in `.dev.vars`; see "Testing before go-live" below for previews.
4. **Resend** — create a second API key, sending access only, restricted to `send.cyphral.co.uk`. This must be a different key from the one the contact form and Gmail "Send mail as" use — see `TURNSTILE_SECRET_KEY` / `BOOKING_RESEND_API_KEY` naming below for why.
5. **Secrets**, via `npx wrangler secret put <NAME>` (production) and in `.dev.vars` (local — already gitignored, never committed):
   - `TURNSTILE_SECRET_KEY` — from step 3.
   - `RATE_HMAC_SECRET` — 32 random bytes, e.g. `openssl rand -hex 32`. Used to HMAC IPs and emails before they ever touch D1; never store the raw value anywhere else, and rotating it just resets everyone's rate-limit history (harmless).
   - `BOOKING_RESEND_API_KEY` — from step 4. Deliberately not named `RESEND_API_KEY`, which is already the contact form's key — a shared name would mean `wrangler secret put RESEND_API_KEY` overwrites one with the other.
   - `MAIL_DAILY_CAP` (optional) — overrides the default cap of 40 booking emails/day if you ever need to.
6. **Cron trigger** — `wrangler.jsonc`'s `main` needs to point at `./src/worker.ts` (not the adapter's default entrypoint) and a `triggers.crons` entry needs adding, so the 30-minute maintenance sweep actually runs. See the diff in the Phase 5 handover — this wasn't applied automatically (the same `Edit(wrangler.jsonc)` deny rule as the D1 binding).
7. **Test end to end** on a preview deployment before this goes fully live: book a real slot, check the confirmation email and the `.ics` file open correctly, check the slot disappears from `/book`, cancel it, check the slot reappears. Use an inbox at a different provider (e.g. Outlook) to sanity-check deliverability and that a link scanner pre-fetching the cancel link doesn't cancel it by itself — it can't: cancelling is click-to-act, not automatic on page load (see the comment at the top of `src/scripts/book-cancel.ts`). See "Testing before go-live" below for how Turnstile fits in on a `workers.dev` preview URL.

## Testing before go-live

A Cloudflare Workers Builds preview deployment runs on a `<branch>-cyphral-site.<subdomain>.workers.dev` URL, not `cyphral.co.uk` — so the real production Turnstile widget would reject it (wrong hostname) if you pointed a preview at it. Two options, and you don't need to pick just one:

- **Default — test keys everywhere, no widget changes.** Leave `PUBLIC_TURNSTILE_SITE_KEY` unset for the preview build too (same as local dev). `/book` then uses Cloudflare's published test sitekey automatically, which always reports hostname `example.com`. Add a `previews` block to `wrangler.jsonc` so the preview environment expects that instead of `cyphral.co.uk`:
  ```jsonc
  "previews": {
    "vars": {
      "TURNSTILE_EXPECTED_HOSTNAME": "example.com"
    }
  }
  ```
  Then set the preview's Turnstile secret (it does not inherit from the production secret):
  ```
  npx wrangler preview base-config secret put TURNSTILE_SECRET_KEY
  ```
  (paste the same test secret from `.dev.vars`, `1x0000000000000000000000000000000AA`) — or `wrangler preview secret put TURNSTILE_SECRET_KEY --name <branch>` to scope it to one preview branch. Also set `RATE_HMAC_SECRET` and `BOOKING_RESEND_API_KEY` the same way, or the preview's other checks will fail before Turnstile is even reached. This exercises the entire book → cancel flow for real, against real D1 and real email, with zero changes to the production Turnstile widget.
- **Optional — exercise the real widget once before launch.** Turnstile widgets support multiple allowed hostnames (Dashboard → Turnstile → your widget → Settings → Hostname Management → Add Hostnames; up to 10 on the free tier). Add the actual preview hostname, set `PUBLIC_TURNSTILE_SITE_KEY` for the preview build to the real sitekey, and set the preview's `TURNSTILE_SECRET_KEY` to the real secret with `TURNSTILE_EXPECTED_HOSTNAME` matching that preview hostname exactly. Worth doing once for genuine end-to-end confidence in the real widget's visible challenge, but not required for every test run — remove the extra hostname afterwards if you'd rather keep the widget's allowlist to just `cyphral.co.uk`.

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
  WHERE status = 'confirmed' AND slot_start_utc >= '2026-07-20T00:00:00Z'
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

Runs every 30 minutes (once the deferred `wrangler.jsonc` change is applied — see setup step 6): purges bookings past `purge_after` (90 days after the call) and `rate_events` older than 7 days, alerts you once per booking where a confirmation/notification/reminder email failed to send (`bookings.mail_failed = 1`), and sends the day-before reminder to any confirmed booking that's due one (see "Day-before reminder" below). Check the Worker's logs (Cloudflare dashboard → Workers → Logs, or `wrangler tail`) if you want to confirm it's actually firing — each run logs a single `booking_maintenance_run` line with counts.

## The retired verification flow

Booking used to work in two steps: a 15-minute `held` row and a verification email, then a click to `/api/booking/confirm` turned it into a real, `confirmed` booking. That's gone — `POST /api/booking/book` creates a `confirmed` booking directly, and sends the booker's confirmation email and your notification email in the same request. There's no `held` status any more, no confirm token, no 15-minute window.

`/book/confirm` is kept as a static, no-script "this link is no longer needed" page rather than deleted outright, for the narrow window of already-sent verification-flow emails around the deploy that retired it, and for anything cached or bookmarked. `POST /api/booking/confirm` no longer exists.

The `bookings` table's `status` CHECK constraint still technically permits the old `held`/`expired` values (left alone deliberately — a constraint/index migration would add real risk for no benefit, since nothing writes those values any more) and its `confirm_token_hash`/`hold_expires_at` columns are similarly untouched but unused going forward.

**What now limits someone making many bookings**, now that there's no abandoned-hold state to cap: Turnstile still gates every request; the per-IP (3/hour, 10/day) and per-email (3/day) rate limits still apply; the one-live-booking-per-email database constraint still applies; the mail budget still refuses to create a booking it can't confirm by email. The one limit that's gone is the old cap on 10 *concurrent unverified holds* — but that existed to stop someone parking many since-abandoned, never-verified holds, a concern that doesn't exist any more since every attempt that clears Turnstile and the rate limits immediately becomes a real, `maxCallsPerDay`-counted booking. `maxCallsPerDay` (2, in `config.ts`) was always the tightest real ceiling — the per-IP/email rate limits (3-10/day) are already looser than it — so nothing here needed tightening. The realistic worst case (someone claiming both of a day's two slots with two different email addresses, each individually passing Turnstile and the rate limits) existed before this change too; it just used to need an extra click on a verification link first, which was never a strong anti-abuse gate on its own. If you ever want a harder stop, the daily slot cap itself (`maxCallsPerDay`) is the lever, not the rate limits.

## Day-before reminder

The 30-minute cron sends a reminder to any confirmed, non-cancelled booking starting between 1 and 24 hours from now that hasn't had one yet (`bookings.reminder_sent_at IS NULL`). It's gated behind the same daily mail budget the initial confirmation uses, so a reminder counts toward `MAIL_DAILY_CAP` (default 40) like every other booking email.

The reminder mints a fresh cancel link rather than reusing the one from the confirmation email — only a hash of a cancel token is ever stored, never the raw value, so there's nothing to recover at reminder time to reuse; a new one is generated and the booking's `cancel_token_hash` is rotated to match. The confirmation email's original cancel link stops working once this happens; the reminder's own link is the current one from then on. `reminder_sent_at` is set atomically in the same write that rotates the token, which is what makes "send at most once" hold even if the cron overlaps itself.

**Owner digest.** Whenever a cron run sends at least one booker reminder, you also get one email listing every call it just reminded (time, name, company, email, topic) — one digest per *run*, not per booking, so a run that reminds three bookings still sends you one email, not three. This is the close-the-loop check for the "I'll send the video call link before we speak" promise in the confirmation email and the on-page panel: the digest is your prompt to actually send it for each call listed, the day before. There's no tracking column for the digest and no "mark as sent" link — it's built fresh from whichever bookings that run's reminder step just succeeded on, so there's nothing to persist and nothing to replay if it fails; a failed digest send is simply gone for that run (counted in the cron's logged `reminderDigestFailed`, nowhere else). It's gated behind and counted against the same mail budget as everything else.

**Worst-case emails for one booking**, now that verification is gone and reminders (plus the owner digest) exist: confirmation (booker) + notification (you) + reminder (booker, if the call is still on) + cancellation (booker) + cancellation (you) = 5 — same total as before this change, since verification was swapped for reminder, not added on top. The owner digest doesn't add to this per-booking count at all: `reminder_sent_at` means any one booking triggers a reminder, and so a digest, at most once, ever — never once per 30-minute tick. So the number of digests on any given day is bounded by how many *distinct* bookings happen to cross into their reminder window that day, not by how many cron ticks run (48) — and that's already tightly capped by `maxCallsPerDay = 2`. Worst case, a handful of digests a day, each counted individually against `MAIL_DAILY_CAP` (default 40) alongside everything else — nowhere close to it.
