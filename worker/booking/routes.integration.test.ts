/**
 * Routing-level integration tests against the real built Worker (see
 * vitest.integration.config.ts). Scope is deliberately routing and wiring,
 * not business logic already covered by unit/D1 tests elsewhere: does
 * /api/booking/* actually reach its handler in the real dispatch path, do
 * unrelated static routes keep working unmodified, is the real D1 binding
 * actually wired through a real `astro build`.
 *
 * Turnstile is exercised with a deliberately invalid token rather than
 * mocked: real verification of a bogus token always fails (whether
 * Cloudflare's endpoint is reachable and says so, or is unreachable and
 * verifyTurnstile's own catch-and-fail-closed behaviour kicks in), so the
 * assertion is robust to network conditions either way. A full mocked
 * happy-path hold -> confirm -> cancel round trip is not attempted at this
 * layer; that would need outbound-fetch mocking wiring this package
 * version doesn't expose in an obvious way, and the round trip's pieces
 * are each already covered: db.ts (Phase 2 + concurrency tests), mail.ts,
 * turnstile.ts, and validation.ts all have direct unit/D1 coverage.
 */
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

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

  it('the existing /api/contact endpoint still works', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/api/contact', { method: 'GET' });
    expect(res.status).toBe(405); // GET not allowed there, same as before this feature existed
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

  it('a well-shaped request with a bogus Turnstile token fails the challenge (real or unreachable verification both fail closed)', async () => {
    const res = await SELF.fetch('https://cyphral.co.uk/api/booking/hold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'challenge_failed' });
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
