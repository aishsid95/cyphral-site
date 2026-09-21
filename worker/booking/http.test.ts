import { describe, expect, it } from 'vitest';
import {
  checkJsonContentType,
  checkOrigin,
  errorResponse,
  getClientIp,
  getRayId,
  hasDangerousKeys,
  isBookingEnabled,
  jsonResponse,
  MAX_BODY_BYTES,
  methodNotAllowed,
  readJsonBody,
} from './http';

describe('jsonResponse / errorResponse', () => {
  it('sets no-store, nosniff, and JSON content type', async () => {
    const res = jsonResponse({ ok: true }, 200);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('never sets Access-Control-Allow-Origin', () => {
    const res = jsonResponse({ ok: true }, 200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('errorResponse produces a stable { error } code shape only', async () => {
    const res = errorResponse('slot_unavailable', 409);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'slot_unavailable' });
  });
});

describe('methodNotAllowed', () => {
  it('returns 405 with an Allow header listing permitted methods', () => {
    const res = methodNotAllowed(['GET', 'POST']);
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET, POST');
  });
});

describe('checkOrigin', () => {
  it('accepts the production origin', () => {
    const req = new Request('https://cyphral.co.uk/api/booking/hold', { headers: { Origin: 'https://cyphral.co.uk' } });
    expect(checkOrigin(req, {})).toBe(true);
  });

  it('rejects a missing Origin header', () => {
    const req = new Request('https://cyphral.co.uk/api/booking/hold');
    expect(checkOrigin(req, {})).toBe(false);
  });

  it('rejects an arbitrary other origin', () => {
    const req = new Request('https://cyphral.co.uk/api/booking/hold', { headers: { Origin: 'https://evil.example' } });
    expect(checkOrigin(req, {})).toBe(false);
  });

  it('rejects localhost in production (ENVIRONMENT unset)', () => {
    const req = new Request('https://cyphral.co.uk/api/booking/hold', { headers: { Origin: 'http://localhost:4321' } });
    expect(checkOrigin(req, {})).toBe(false);
  });

  it('accepts localhost only when ENVIRONMENT is development', () => {
    const req = new Request('https://cyphral.co.uk/api/booking/hold', { headers: { Origin: 'http://localhost:4321' } });
    expect(checkOrigin(req, { ENVIRONMENT: 'development' })).toBe(true);
  });

  it('still rejects production origin spoofing attempts like a trailing dot or subdomain', () => {
    const req1 = new Request('https://x', { headers: { Origin: 'https://cyphral.co.uk.evil.example' } });
    expect(checkOrigin(req1, {})).toBe(false);
    const req2 = new Request('https://x', { headers: { Origin: 'https://evil.cyphral.co.uk' } });
    expect(checkOrigin(req2, {})).toBe(false);
  });
});

describe('checkJsonContentType', () => {
  it('accepts an exact application/json content type', () => {
    const req = new Request('https://x', { headers: { 'Content-Type': 'application/json' } });
    expect(checkJsonContentType(req)).toBe(true);
  });

  it('accepts application/json with a charset parameter', () => {
    const req = new Request('https://x', { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    expect(checkJsonContentType(req)).toBe(true);
  });

  it('rejects a different media type', () => {
    const req = new Request('https://x', { headers: { 'Content-Type': 'text/plain' } });
    expect(checkJsonContentType(req)).toBe(false);
  });

  it('rejects a missing content type', () => {
    const req = new Request('https://x');
    expect(checkJsonContentType(req)).toBe(false);
  });

  it('rejects form-encoded content masquerading with json in the name', () => {
    const req = new Request('https://x', { headers: { 'Content-Type': 'application/json-patch+json' } });
    expect(checkJsonContentType(req)).toBe(false);
  });
});

describe('readJsonBody', () => {
  it('parses a small valid JSON body', async () => {
    const req = new Request('https://x', { method: 'POST', body: JSON.stringify({ a: 1 }) });
    expect(await readJsonBody(req)).toEqual({ ok: true, data: { a: 1 } });
  });

  it('rejects a body over the size cap, even without an honest Content-Length', async () => {
    const bigPayload = JSON.stringify({ note: 'x'.repeat(MAX_BODY_BYTES + 1000) });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bigPayload));
        controller.close();
      },
    });
    const req = new Request('https://x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    expect(await readJsonBody(req)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('rejects based on a declared Content-Length over the cap without reading the stream', async () => {
    const req = new Request('https://x', {
      method: 'POST',
      headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) },
      body: JSON.stringify({ a: 1 }),
    });
    expect(await readJsonBody(req)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('rejects invalid JSON', async () => {
    const req = new Request('https://x', { method: 'POST', body: '{not json' });
    expect(await readJsonBody(req)).toEqual({ ok: false, reason: 'invalid_json' });
  });

  it('accepts a body right at the size cap', async () => {
    // Build a JSON body whose exact byte length is MAX_BODY_BYTES.
    const overhead = '{"note":""}'.length;
    const padded = 'x'.repeat(MAX_BODY_BYTES - overhead);
    const body = JSON.stringify({ note: padded });
    expect(new TextEncoder().encode(body).byteLength).toBe(MAX_BODY_BYTES);
    const req = new Request('https://x', { method: 'POST', body });
    const result = await readJsonBody(req);
    expect(result.ok).toBe(true);
  });
});

describe('hasDangerousKeys', () => {
  it('detects __proto__, constructor, and prototype as own keys', () => {
    expect(hasDangerousKeys(JSON.parse('{"__proto__": {"x": 1}}'))).toBe(true);
    expect(hasDangerousKeys(JSON.parse('{"constructor": 1}'))).toBe(true);
    expect(hasDangerousKeys(JSON.parse('{"prototype": 1}'))).toBe(true);
  });

  it('is false for an ordinary object', () => {
    expect(hasDangerousKeys({ name: 'Bob', email: 'bob@example.com' })).toBe(false);
  });

  it('is false for arrays and primitives (those are rejected elsewhere, by shape)', () => {
    expect(hasDangerousKeys([1, 2, 3])).toBe(false);
    expect(hasDangerousKeys('a string')).toBe(false);
    expect(hasDangerousKeys(null)).toBe(false);
  });
});

describe('getClientIp / getRayId', () => {
  it('reads CF-Connecting-IP and CF-Ray, defaulting to empty string', () => {
    const req = new Request('https://x', { headers: { 'CF-Connecting-IP': '203.0.113.5', 'CF-Ray': 'abc123' } });
    expect(getClientIp(req)).toBe('203.0.113.5');
    expect(getRayId(req)).toBe('abc123');

    const bare = new Request('https://x');
    expect(getClientIp(bare)).toBe('');
    expect(getRayId(bare)).toBe('');
  });
});

describe('isBookingEnabled', () => {
  it('is enabled by default', () => {
    expect(isBookingEnabled({ BOOKINGS_DB: {} as D1Database, RATE_HMAC_SECRET: 's', TURNSTILE_SECRET_KEY: 't', BOOKING_RESEND_API_KEY: 'r' })).toBe(true);
  });

  it('is disabled by the BOOKING_ENABLED="false" kill switch', () => {
    expect(
      isBookingEnabled({
        BOOKINGS_DB: {} as D1Database,
        RATE_HMAC_SECRET: 's',
        TURNSTILE_SECRET_KEY: 't',
        BOOKING_RESEND_API_KEY: 'r',
        BOOKING_ENABLED: 'false',
      }),
    ).toBe(false);
  });
});
