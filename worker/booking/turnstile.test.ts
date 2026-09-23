import { describe, expect, it } from 'vitest';
import { verifyTurnstile } from './turnstile';

const BASE_PARAMS = {
  token: 'a-token',
  remoteIp: '203.0.113.5',
  secretKey: 'secret',
  expectedHostname: 'cyphral.co.uk',
  expectedAction: 'booking_book',
};

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe('verifyTurnstile', () => {
  it('succeeds when success, hostname, and action all match', async () => {
    const fetchImpl = fetchReturning({ success: true, hostname: 'cyphral.co.uk', action: 'booking_book' });
    expect(await verifyTurnstile({ ...BASE_PARAMS, fetchImpl })).toEqual({ ok: true });
  });

  it('fails when Cloudflare reports success: false', async () => {
    const fetchImpl = fetchReturning({ success: false, 'error-codes': ['invalid-input-response'] });
    expect(await verifyTurnstile({ ...BASE_PARAMS, fetchImpl })).toEqual({ ok: false });
  });

  it('fails on a hostname mismatch even when success is true', async () => {
    const fetchImpl = fetchReturning({ success: true, hostname: 'attacker.example', action: 'booking_book' });
    expect(await verifyTurnstile({ ...BASE_PARAMS, fetchImpl })).toEqual({ ok: false });
  });

  it('fails on an action mismatch even when success is true', async () => {
    const fetchImpl = fetchReturning({ success: true, hostname: 'cyphral.co.uk', action: 'some_other_form' });
    expect(await verifyTurnstile({ ...BASE_PARAMS, fetchImpl })).toEqual({ ok: false });
  });

  it('fails on a non-2xx response from Cloudflare', async () => {
    const fetchImpl = fetchReturning({ success: true, hostname: 'cyphral.co.uk', action: 'booking_book' }, 500);
    expect(await verifyTurnstile({ ...BASE_PARAMS, fetchImpl })).toEqual({ ok: false });
  });

  it('fails on a network error', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    expect(await verifyTurnstile({ ...BASE_PARAMS, fetchImpl })).toEqual({ ok: false });
  });

  it('fails on malformed JSON from the endpoint', async () => {
    const fetchImpl = (async () => new Response('not json', { status: 200 })) as typeof fetch;
    expect(await verifyTurnstile({ ...BASE_PARAMS, fetchImpl })).toEqual({ ok: false });
  });

  it('accepts the development hostname when explicitly expected', async () => {
    const fetchImpl = fetchReturning({ success: true, hostname: 'localhost', action: 'booking_book' });
    expect(
      await verifyTurnstile({ ...BASE_PARAMS, expectedHostname: 'localhost', fetchImpl }),
    ).toEqual({ ok: true });
  });

  it('succeeds when action is absent entirely, matching Cloudflare\'s published test sitekeys', async () => {
    // Confirmed against the real siteverify endpoint, driven by an actual
    // widget in a real browser: Cloudflare's test sitekeys never include
    // "action" in the response at all, unlike real widgets which always echo
    // it back. A strict equality check would make every test-key flow 403
    // forever, so an absent field is treated as "not checked", not a mismatch.
    const fetchImpl = fetchReturning({ success: true, hostname: 'cyphral.co.uk', metadata: { result_with_testing_key: true } });
    expect(await verifyTurnstile({ ...BASE_PARAMS, fetchImpl })).toEqual({ ok: true });
  });
});
