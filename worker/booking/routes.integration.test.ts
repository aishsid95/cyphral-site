/**
 * Routing-level integration tests against the real built Worker (see
 * vitest.integration.config.ts). Scope is deliberately routing and wiring,
 * not business logic already covered by unit/D1 tests elsewhere: does
 * /api/booking/* actually reach its handler in the real dispatch path, do
 * unrelated static routes keep working unmodified, is the real D1 binding
 * actually wired through a real `astro build`.
 *
 * Turnstile is exercised against the real network endpoint rather than
 * mocked, using dist/server/.dev.vars's Turnstile secret — Cloudflare's
 * published "always passes" test secret, which (confirmed against the real
 * endpoint) returns success regardless of the token's content, so it can't
 * be used here to test rejection. Instead the request body's slotStart is
 * deliberately far in the future (outside any real availability window),
 * so the request reliably fails slot-availability validation *after*
 * Turnstile has genuinely passed — proving the real build's routing wires
 * all the way through Turnstile's real network round trip into business
 * logic without crashing, which is what this file's routing/wiring scope
 * (see above) actually needs. A full mocked happy-path hold -> confirm ->
 * cancel round trip is not attempted at this layer; that would need
 * outbound-fetch mocking wiring this package version doesn't expose in an
 * obvious way, and the round trip's pieces are each already covered: db.ts
 * (Phase 2 + concurrency tests), mail.ts, turnstile.ts, and validation.ts
 * all have direct unit/D1 coverage.
 */
import { SELF } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

/**
 * `Cloudflare.Exports` (ambient, from worker-configuration.d.ts) is keyed by
 * a `GlobalProps.mainModule` augmentation that Cloudflare's experimental
 * typed-exports feature would need us to wire up separately — not done here
 * for one test call. The runtime call works (proven by the test passing);
 * this narrows `exports` to just the shape this file actually relies on,
 * instead of reaching for `any`.
 */
const workerExports = exports as unknown as {
  default: { scheduled(options: { scheduledTime: Date; cron: string }): Promise<{ outcome: string }> };
};

const ORIGIN = 'https://cyphral.co.uk';

describe('unrelated routes are unaffected by the booking routes', () => {
  it('GET / still returns the real prerendered home page', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Cyphral');
  });

  it('GET /about still returns the real prerendered page', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/about');
    expect(res.status).toBe(200);
  });

  it('an unknown route still 404s', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/this-page-does-not-exist');
    expect(res.status).toBe(404);
  });

  it('GET /api/contact is still not allowed', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/api/contact', { method: 'GET' });
    expect(res.status).toBe(405); // GET not allowed there, same as before this feature existed
  });

  it('POST /api/contact reaches the real handler and runs its own logic (honeypot path — no live email is sent)', async () => {
    // A genuine POST, not just a method check — contact.ts's honeypot branch
    // returns success without ever calling Resend, so this proves the real
    // route and its real code run, with no risk of sending a live email
    // using whatever key happens to be in this environment's .dev.vars.
    // CF-Connecting-IP is required here: a real Cloudflare edge request
    // always carries it, and @astrojs/cloudflare's Astro.clientAddress
    // (which contact.ts reads) throws without it — this test harness
    // doesn't synthesize that header on its own the way the real edge does.
    const res = await SELF.fetch('https://cyphral.co.uk/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.5' },
      body: JSON.stringify({ name: 'Test', email: 'test@example.com', message: 'hello', company: 'i-am-a-bot' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('GET /api/booking/slots reaches the real handler with a real D1 binding', () => {
  it('returns a well-shaped response with no live bookings', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/api/booking/slots');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const body = (await res.json()) as { businessTimeZone: string; durationMinutes: number; slots: string[] };
    expect(body.businessTimeZone).toBe('Europe/London');
    expect(body.durationMinutes).toBe(30);
    expect(Array.isArray(body.slots)).toBe(true);
    // Never leaks block labels — proves the real route, not just the pure function, honours this.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('Qaidah');
    expect(raw).not.toContain('Jummah');
  });

  it('POST is not allowed', async () => {
    // A JSON content type clears Astro's own built-in CSRF middleware (which
    // only guards form-like content types), so this genuinely reaches
    // slots.ts's own method-not-allowed handler rather than Astro's guard.
    const res = await SELF.fetch('https://cyphral.co.uk/api/booking/slots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET');
  });

  it('a bare POST with no headers at all is rejected by Astro\'s own CSRF guard before reaching the route', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/api/booking/slots', { method: 'POST' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/booking/hold — global request handling in the real build', () => {
  const validBody = {
    slotStart: '2099-01-05T10:00:00Z',
    name: 'Test',
    email: 'test@example.com',
    company: '',
    topic: 'ce-readiness',
    note: '',
    visitorTz: 'Europe/London',
    website: '',
    turnstileToken: 'not-a-real-token',
  };

  it('rejects a missing Origin header', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/api/booking/hold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden_origin' });
  });

  it('rejects a wrong Origin header', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/api/booking/hold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a non-JSON content type', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/api/booking/hold', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: ORIGIN },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(415);
  });

  it('rejects an oversized body', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/api/booking/hold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ ...validBody, note: 'x'.repeat(9000) }),
    });
    expect(res.status).toBe(413);
  });

  it('rejects malformed JSON', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/api/booking/hold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: '{not valid json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a __proto__ key', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/api/booking/hold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: '{"__proto__": {"polluted": true}}',
    });
    expect(res.status).toBe(400);
  });

  it('an honeypot-filled submission returns the same success shape but creates nothing', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/api/booking/hold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ ...validBody, website: 'i-am-a-bot' }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'verification_sent', holdMinutes: 15 });
  });

  it('a well-shaped request reaches real Turnstile verification and then fails on its deliberately unavailable slot', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/api/booking/hold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'slot_unavailable' });
  });

  it('GET is not allowed', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/api/booking/hold', { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST');
  });
});

describe('POST /api/booking/confirm and /cancel — reachable and correctly reject unknown tokens', () => {
  it('confirm with an unknown token returns link_expired', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/api/booking/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ token: 'a'.repeat(43) }),
    });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'link_expired' });
  });

  it('cancel with an unknown token returns link_expired', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/api/booking/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ token: 'a'.repeat(43) }),
    });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'link_expired' });
  });

  it('confirm rejects a wrong Origin', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/api/booking/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ token: 'a'.repeat(43) }),
    });
    expect(res.status).toBe(403);
  });
});

describe('/book* pages and their headers, served via the real ASSETS binding + public/_headers', () => {
  it('GET /book returns the real prerendered page', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/book');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Pick a time that suits you');
  });

  it('GET /book/confirm and /book/cancel return their real prerendered pages', async () => {
    const confirmRes = await SELF.fetch('https://cyphral.co.uk/book/confirm');
    expect(confirmRes.status).toBe(200);
    expect(await confirmRes.text()).toContain('Confirm your call');

    const cancelRes = await SELF.fetch('https://cyphral.co.uk/book/cancel');
    expect(cancelRes.status).toBe(200);
    expect(await cancelRes.text()).toContain('Cancel your call');
  });

  it('/book carries a script-src with no unsafe-inline, and frame-ancestors none', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/book');
    const csp = res.headers.get('Content-Security-Policy');
    expect(csp).toBeTruthy();
    // script-src must not carry unsafe-inline (style-src does, intentionally, for Tailwind).
    const scriptSrc = csp!.split(';').find((d) => d.trim().startsWith('script-src'));
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('challenges.cloudflare.com');
  });

  it('the CSP is not comma-corrupted by the site-wide rule also matching /book', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/book');
    const csp = res.headers.get('Content-Security-Policy');
    // A corrupted merge would show up as a comma joining two full policies.
    expect(csp).not.toContain(', default-src');
    expect(csp?.split(',').length).toBe(1);
  });

  it('an ordinary page has no Content-Security-Policy header at all', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/about');
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
  });

  it('/book/confirm sends Referrer-Policy: no-referrer via its own <meta> tag', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/book/confirm');
    const html = await res.text();
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('/book itself keeps the site-wide Referrer-Policy (no override)', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/book');
    const html = await res.text();
    expect(html).not.toContain('name="referrer"');
  });

  it('every /book* page has X-Content-Type-Options and Permissions-Policy from the site-wide rule', async () => {
    for (const path of ['/book', '/book/confirm', '/book/cancel']) {
      const res = await SELF.fetch(`https://cyphral.co.uk${path}`);
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Permissions-Policy')).toContain('camera=()');
    }
  });

  it('every script tag on /book, /book/confirm, and /book/cancel is external (no inline body content)', async () => {
    for (const path of ['/book', '/book/confirm', '/book/cancel']) {
      const res = await SELF.fetch(`https://cyphral.co.uk${path}`);
      const html = await res.text();
      const scriptTags = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
      expect(scriptTags.length).toBeGreaterThan(0);
      for (const [full, body] of scriptTags) {
        expect(body.trim()).toBe(''); // every script tag has empty body content; all logic loads via src=
        expect(full).toMatch(/\bsrc=/);
      }
    }
  });
});

describe('scheduled() — the cron handler added alongside fetch in src/worker.ts', () => {
  // src/worker.ts imports @astrojs/cloudflare/handler, which imports an
  // Astro-internal Vite virtual module that only resolves inside Astro's
  // own build — confirmed empirically that a test file can't import
  // src/worker.ts directly and have Vite re-resolve it (the module
  // resolution issue Cloudflare documents at
  // developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#module-resolution).
  // So this reaches into the *already-running*, already-bundled worker via
  // exports.default.scheduled() instead of re-importing source — the same
  // instance SELF.fetch() talks to elsewhere in this file. That call is
  // Cloudflare-documented as experimental and needs the
  // service_binding_extra_handlers compatibility flag; see
  // scripts/prepare-integration-test-config.mjs for why that's added only
  // to the test-only stripped config, never to the real wrangler.jsonc.
  it('runs the maintenance sweep without throwing, against the real D1 binding', async () => {
    // A booking whose hold has already expired, so the sweep has visible
    // work to do — proves this isn't a no-op.
    await env.BOOKINGS_DB.batch([
      env.BOOKINGS_DB.prepare('DELETE FROM bookings'),
      env.BOOKINGS_DB.prepare('DELETE FROM rate_events'),
    ]);
    await env.BOOKINGS_DB
      .prepare(
        `INSERT INTO bookings (
           id, slot_start_utc, slot_end_utc, status, name, email, email_key, topic,
           visitor_tz, confirm_token_hash, hold_expires_at, created_at, purge_after
         ) VALUES (?, ?, ?, 'held', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        'scheduled-test-stale-hold',
        '2026-07-20T09:00:00Z',
        '2026-07-20T09:30:00Z',
        'Test',
        'test@example.com',
        'test@example.com',
        'ce-readiness',
        'Europe/London',
        'ct-scheduled-test',
        '2020-01-01T00:00:00Z', // long expired
        '2020-01-01T00:00:00Z',
        '2099-01-01T00:00:00Z', // not due for purge — proves the row was expired, not deleted
      )
      .run();

    const result = await workerExports.default.scheduled({ scheduledTime: new Date(), cron: '*/30 * * * *' });
    expect(result.outcome).toBe('ok');

    const row = await env.BOOKINGS_DB
      .prepare('SELECT status FROM bookings WHERE id = ?')
      .bind('scheduled-test-stale-hold')
      .first<{ status: string }>();
    expect(row?.status).toBe('expired');
  });
});
