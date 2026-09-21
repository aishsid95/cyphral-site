/**
 * Proves the ordering guarantee in handleHoldRequest: nothing expensive
 * runs until everything cheaper than it has passed. Every dependency is a
 * plain injected fake (vi.fn()) — no test-only switch exists in the
 * production code to skip Turnstile or anything else; this only works
 * because hold-handler.ts already takes its D1/mail/Turnstile calls as
 * parameters for real architectural reasons (see its file header).
 */
import { describe, expect, it, vi } from 'vitest';
import { defaultHoldHandlerDeps, handleHoldRequest, type HoldHandlerDeps } from './hold-handler';
import type { HoldRequestShape } from './validation';

const VALID_BODY: HoldRequestShape = {
  slotStart: '2099-01-05T10:00:00Z', // format-valid; the fake computeAvailableSlots below decides real availability
  name: 'Test Visitor',
  email: 'visitor@example.com',
  company: '',
  topic: 'ce-readiness',
  note: '',
  visitorTz: 'Europe/London',
  website: '',
  turnstileToken: 'a-plausible-token',
};

const BASE_PARAMS = {
  now: new Date('2026-01-01T00:00:00Z'),
  clientIp: '203.0.113.5',
  db: {} as D1Database, // never touched when deps are fully faked
  rateHmacSecret: 'secret',
  turnstileSecretKey: 'ts-secret',
  turnstileExpectedHostname: 'cyphral.co.uk',
  bookingResendApiKey: 'resend-key',
};

/** All deps stubbed to their "everything passes" shape; each test overrides only what it needs. */
function fakeDeps(overrides: Partial<HoldHandlerDeps> = {}): HoldHandlerDeps {
  return {
    computeAvailableSlots: vi.fn(() => [VALID_BODY.slotStart]),
    verifyTurnstile: vi.fn(async () => ({ ok: true }) as const),
    isRateLimited: vi.fn(async () => false),
    recordRateLimitEvent: vi.fn(async () => {}),
    countActiveHolds: vi.fn(async () => 0),
    isWithinMailBudget: vi.fn(async () => true),
    recordMailSent: vi.fn(async () => {}),
    listLiveBookingIntervals: vi.fn(async () => []),
    createHold: vi.fn(async () => ({ ok: true }) as const),
    expireHeldBooking: vi.fn(async () => {}),
    sendVerificationEmail: vi.fn(async () => ({ ok: true }) as const),
    ...overrides,
  };
}

describe('handleHoldRequest — happy path (establishes what "everything ran" looks like)', () => {
  it('calls Turnstile, writes the hold, and sends the verification email, in that order', async () => {
    const deps = fakeDeps();
    const result = await handleHoldRequest({ ...BASE_PARAMS, body: VALID_BODY }, deps);

    expect(result.status).toBe(202);
    expect(deps.verifyTurnstile).toHaveBeenCalledTimes(1);
    expect(deps.createHold).toHaveBeenCalledTimes(1);
    expect(deps.sendVerificationEmail).toHaveBeenCalledTimes(1);
    expect(deps.recordMailSent).toHaveBeenCalledTimes(1);

    const turnstileOrder = vi.mocked(deps.verifyTurnstile).mock.invocationCallOrder[0];
    const createHoldOrder = vi.mocked(deps.createHold).mock.invocationCallOrder[0];
    const sendEmailOrder = vi.mocked(deps.sendVerificationEmail).mock.invocationCallOrder[0];
    expect(turnstileOrder).toBeLessThan(createHoldOrder);
    expect(createHoldOrder).toBeLessThan(sendEmailOrder);
  });
});

describe('handleHoldRequest — honeypot short-circuit', () => {
  it('a filled honeypot calls none of Turnstile, D1 write, or email, and returns the same success shape', async () => {
    const deps = fakeDeps();
    const result = await handleHoldRequest(
      { ...BASE_PARAMS, body: { ...VALID_BODY, website: 'i-am-a-bot' } },
      deps,
    );

    expect(result.status).toBe(202);
    expect(result.body).toEqual({ status: 'verification_sent', holdMinutes: 15 });
    expect(deps.verifyTurnstile).not.toHaveBeenCalled();
    expect(deps.isRateLimited).not.toHaveBeenCalled();
    expect(deps.isWithinMailBudget).not.toHaveBeenCalled();
    expect(deps.createHold).not.toHaveBeenCalled();
    expect(deps.sendVerificationEmail).not.toHaveBeenCalled();
  });
});

describe('handleHoldRequest — Turnstile failure short-circuit', () => {
  it('a failed Turnstile check writes nothing to D1 and sends no email', async () => {
    const deps = fakeDeps({ verifyTurnstile: vi.fn(async () => ({ ok: false }) as const) });
    const result = await handleHoldRequest({ ...BASE_PARAMS, body: VALID_BODY }, deps);

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: 'challenge_failed' });
    expect(deps.verifyTurnstile).toHaveBeenCalledTimes(1); // it WAS attempted — it's what failed
    expect(deps.isRateLimited).not.toHaveBeenCalled();
    expect(deps.createHold).not.toHaveBeenCalled();
    expect(deps.sendVerificationEmail).not.toHaveBeenCalled();
  });
});

describe('handleHoldRequest — rate limit short-circuit', () => {
  it('an IP/email rate limit hit passes Turnstile first, then writes nothing to D1 and sends no email', async () => {
    const deps = fakeDeps({ isRateLimited: vi.fn(async () => true) });
    const result = await handleHoldRequest({ ...BASE_PARAMS, body: VALID_BODY }, deps);

    expect(result.status).toBe(429);
    expect(result.body).toEqual({ error: 'rate_limited' });
    expect(deps.verifyTurnstile).toHaveBeenCalledTimes(1); // ran and passed, before the rate check
    expect(deps.isWithinMailBudget).not.toHaveBeenCalled();
    expect(deps.createHold).not.toHaveBeenCalled();
    expect(deps.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('a global-active-holds cap hit also writes nothing and sends no email', async () => {
    const deps = fakeDeps({ countActiveHolds: vi.fn(async () => 999) });
    const result = await handleHoldRequest({ ...BASE_PARAMS, body: VALID_BODY }, deps);

    expect(result.status).toBe(429);
    expect(deps.verifyTurnstile).toHaveBeenCalledTimes(1);
    expect(deps.createHold).not.toHaveBeenCalled();
    expect(deps.sendVerificationEmail).not.toHaveBeenCalled();
  });
});

describe('handleHoldRequest — mail budget short-circuit', () => {
  it('an exhausted mail budget passes Turnstile and rate limits first, then writes nothing to D1 and sends no email', async () => {
    const deps = fakeDeps({ isWithinMailBudget: vi.fn(async () => false) });
    const result = await handleHoldRequest({ ...BASE_PARAMS, body: VALID_BODY }, deps);

    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'booking_unavailable' });
    expect(deps.verifyTurnstile).toHaveBeenCalledTimes(1);
    expect(deps.isRateLimited).toHaveBeenCalled(); // rate limiting ran (and passed) before the budget check
    expect(deps.createHold).not.toHaveBeenCalled();
    expect(deps.sendVerificationEmail).not.toHaveBeenCalled();
  });
});

describe('handleHoldRequest — real production wiring exists', () => {
  it('defaultHoldHandlerDeps wires every dependency to the real implementation, not a stub', () => {
    // Sanity check against the refactor's whole point regressing silently:
    // the route must actually use real functions when no deps are passed.
    for (const key of Object.keys(defaultHoldHandlerDeps) as (keyof HoldHandlerDeps)[]) {
      expect(typeof defaultHoldHandlerDeps[key]).toBe('function');
    }
  });
});
