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
