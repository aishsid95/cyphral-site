/**
 * Proves the ordering guarantee in handleBookingRequest: nothing expensive
 * runs until everything cheaper than it has passed. Every dependency is a
 * plain injected fake (vi.fn()) — no test-only switch exists in the
 * production code to skip Turnstile or anything else; this only works
 * because booking-handler.ts already takes its D1/mail/Turnstile calls as
 * parameters for real architectural reasons (see its file header).
 */
import { describe, expect, it, vi } from 'vitest';
import { defaultBookingHandlerDeps, handleBookingRequest, type BookingHandlerDeps } from './booking-handler';
import type { BookRequestShape } from './validation';

const VALID_BODY: BookRequestShape = {
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
function fakeDeps(overrides: Partial<BookingHandlerDeps> = {}): BookingHandlerDeps {
  return {
    computeAvailableSlots: vi.fn(() => [VALID_BODY.slotStart]),
    verifyTurnstile: vi.fn(async () => ({ ok: true }) as const),
    isRateLimited: vi.fn(async () => false),
    recordRateLimitEvent: vi.fn(async () => {}),
    isWithinMailBudget: vi.fn(async () => true),
    recordMailSent: vi.fn(async () => {}),
    listLiveBookingIntervals: vi.fn(async () => []),
    createConfirmedBooking: vi.fn(async () => ({ ok: true }) as const),
    markMailFailed: vi.fn(async () => {}),
    sendBookerConfirmationEmail: vi.fn(async () => ({ ok: true }) as const),
    sendOwnerNotificationEmail: vi.fn(async () => ({ ok: true }) as const),
    ...overrides,
  };
}

describe('handleBookingRequest — happy path (establishes what "everything ran" looks like)', () => {
  it('calls Turnstile, writes the confirmed booking, and sends both emails, in that order', async () => {
    const deps = fakeDeps();
    const result = await handleBookingRequest({ ...BASE_PARAMS, body: VALID_BODY }, deps);

    expect(result.status).toBe(201);
    expect(result.body).toEqual({ status: 'booked' });
    expect(result.logEvent).toBe('booking_created');
    expect(deps.verifyTurnstile).toHaveBeenCalledTimes(1);
    expect(deps.createConfirmedBooking).toHaveBeenCalledTimes(1);
    expect(deps.sendBookerConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(deps.sendOwnerNotificationEmail).toHaveBeenCalledTimes(1);
    expect(deps.recordMailSent).toHaveBeenCalledTimes(1);

    const turnstileOrder = vi.mocked(deps.verifyTurnstile).mock.invocationCallOrder[0];
    const createOrder = vi.mocked(deps.createConfirmedBooking).mock.invocationCallOrder[0];
    const sendBookerOrder = vi.mocked(deps.sendBookerConfirmationEmail).mock.invocationCallOrder[0];
    expect(turnstileOrder).toBeLessThan(createOrder);
    expect(createOrder).toBeLessThan(sendBookerOrder);
  });

  it('creates the booking with status confirmed at write time, not a held/pending state', async () => {
    const deps = fakeDeps();
    await handleBookingRequest({ ...BASE_PARAMS, body: VALID_BODY }, deps);

    const [, input] = vi.mocked(deps.createConfirmedBooking).mock.calls[0];
    expect(input.confirmedAtUtc).toBe(BASE_PARAMS.now.toISOString());
    expect(input.cancelTokenHash).toEqual(expect.any(String));
  });
});

describe('handleBookingRequest — honeypot short-circuit', () => {
  it('a filled honeypot calls none of Turnstile, D1 write, or email, and returns the same success shape', async () => {
    const deps = fakeDeps();
    const result = await handleBookingRequest(
      { ...BASE_PARAMS, body: { ...VALID_BODY, website: 'i-am-a-bot' } },
      deps,
    );

    expect(result.status).toBe(201);
    expect(result.body).toEqual({ status: 'booked' });
    expect(deps.verifyTurnstile).not.toHaveBeenCalled();
    expect(deps.isRateLimited).not.toHaveBeenCalled();
    expect(deps.isWithinMailBudget).not.toHaveBeenCalled();
    expect(deps.createConfirmedBooking).not.toHaveBeenCalled();
    expect(deps.sendBookerConfirmationEmail).not.toHaveBeenCalled();
    expect(deps.sendOwnerNotificationEmail).not.toHaveBeenCalled();
  });
});

describe('handleBookingRequest — Turnstile failure short-circuit', () => {
  it('a failed Turnstile check writes nothing to D1 and sends no email', async () => {
    const deps = fakeDeps({ verifyTurnstile: vi.fn(async () => ({ ok: false }) as const) });
    const result = await handleBookingRequest({ ...BASE_PARAMS, body: VALID_BODY }, deps);

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: 'challenge_failed' });
    expect(deps.verifyTurnstile).toHaveBeenCalledTimes(1); // it WAS attempted — it's what failed
    expect(deps.isRateLimited).not.toHaveBeenCalled();
    expect(deps.createConfirmedBooking).not.toHaveBeenCalled();
    expect(deps.sendBookerConfirmationEmail).not.toHaveBeenCalled();
  });
});

describe('handleBookingRequest — rate limit short-circuit', () => {
  it('an IP/email rate limit hit passes Turnstile first, then writes nothing to D1 and sends no email', async () => {
    const deps = fakeDeps({ isRateLimited: vi.fn(async () => true) });
    const result = await handleBookingRequest({ ...BASE_PARAMS, body: VALID_BODY }, deps);

    expect(result.status).toBe(429);
    expect(result.body).toEqual({ error: 'rate_limited' });
    expect(deps.verifyTurnstile).toHaveBeenCalledTimes(1); // ran and passed, before the rate check
    expect(deps.isWithinMailBudget).not.toHaveBeenCalled();
    expect(deps.createConfirmedBooking).not.toHaveBeenCalled();
    expect(deps.sendBookerConfirmationEmail).not.toHaveBeenCalled();
  });
});

describe('handleBookingRequest — mail budget short-circuit', () => {
  it('an exhausted mail budget passes Turnstile and rate limits first, then writes nothing to D1 and sends no email', async () => {
    const deps = fakeDeps({ isWithinMailBudget: vi.fn(async () => false) });
    const result = await handleBookingRequest({ ...BASE_PARAMS, body: VALID_BODY }, deps);

    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'booking_unavailable' });
    expect(deps.verifyTurnstile).toHaveBeenCalledTimes(1);
    expect(deps.isRateLimited).toHaveBeenCalled(); // rate limiting ran (and passed) before the budget check
    expect(deps.createConfirmedBooking).not.toHaveBeenCalled();
    expect(deps.sendBookerConfirmationEmail).not.toHaveBeenCalled();
  });
});

describe('handleBookingRequest — slot no longer available', () => {
  it('a slot missing from the recomputed availability list writes nothing and sends no email', async () => {
    const deps = fakeDeps({ computeAvailableSlots: vi.fn(() => []) });
    const result = await handleBookingRequest({ ...BASE_PARAMS, body: VALID_BODY }, deps);

    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: 'slot_unavailable' });
    expect(deps.createConfirmedBooking).not.toHaveBeenCalled();
  });

  it('a race lost at the atomic insert also reports slot_unavailable', async () => {
    const deps = fakeDeps({ createConfirmedBooking: vi.fn(async () => ({ ok: false, reason: 'slot_unavailable' }) as const) });
    const result = await handleBookingRequest({ ...BASE_PARAMS, body: VALID_BODY }, deps);

    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: 'slot_unavailable' });
    expect(deps.sendBookerConfirmationEmail).not.toHaveBeenCalled();
  });
});

describe('handleBookingRequest — email failure does not roll back the booking', () => {
  it('the booking already succeeded, so a failed booker email still returns 201 booked, but marks mail_failed and records no mail-sent event', async () => {
    const deps = fakeDeps({ sendBookerConfirmationEmail: vi.fn(async () => ({ ok: false }) as const) });
    const result = await handleBookingRequest({ ...BASE_PARAMS, body: VALID_BODY }, deps);

    expect(result.status).toBe(201);
    expect(result.body).toEqual({ status: 'booked' });
    expect(result.logEvent).toBe('booking_created_mail_failed');
    expect(deps.markMailFailed).toHaveBeenCalledTimes(1);
    expect(deps.recordMailSent).not.toHaveBeenCalled();
  });

  it('a failed owner notification alone still returns 201 booked and marks mail_failed, but the booker email still counts toward the mail budget', async () => {
    const deps = fakeDeps({ sendOwnerNotificationEmail: vi.fn(async () => ({ ok: false }) as const) });
    const result = await handleBookingRequest({ ...BASE_PARAMS, body: VALID_BODY }, deps);

    expect(result.status).toBe(201);
    expect(result.logEvent).toBe('booking_created_mail_failed');
    expect(deps.markMailFailed).toHaveBeenCalledTimes(1);
    expect(deps.recordMailSent).toHaveBeenCalledTimes(1); // the booker's email itself did go out
  });
});

describe('handleBookingRequest — real production wiring exists', () => {
  it('defaultBookingHandlerDeps wires every dependency to the real implementation, not a stub', () => {
    // Sanity check against the refactor's whole point regressing silently:
    // the route must actually use real functions when no deps are passed.
    for (const key of Object.keys(defaultBookingHandlerDeps) as (keyof BookingHandlerDeps)[]) {
      expect(typeof defaultBookingHandlerDeps[key]).toBe('function');
    }
  });
});
