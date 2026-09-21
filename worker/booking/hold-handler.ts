/**
 * The orchestration logic for POST /api/booking/hold, extracted from the
 * Astro route so it can be unit-tested with injected fakes — in particular
 * so the ordering guarantee ("nothing expensive runs until everything
 * cheaper has passed") is actually verifiable: honeypot, a failed
 * Turnstile check, a hit rate limit, or an exhausted mail budget must each
 * result in zero calls to Turnstile/D1-write/email as appropriate. See
 * hold-handler.test.ts.
 *
 * The route (src/pages/api/booking/hold.ts) stays responsible for
 * everything HTTP-shaped: reading env/secrets, the global request checks
 * (content-type, origin, body size, JSON/shape parsing), and turning this
 * function's plain result into a Response. No `cloudflare:workers` or
 * `astro` import belongs in this file — that's what keeps it testable
 * under the fast plain-Node Vitest project, no D1/Workers runtime needed.
 */
import { computeAvailableSlots, formatSlotIso } from './availability';
import bankHolidayData from './bank-holidays.json';
import { BOOKING } from './config';
import { generateToken, hashToken, hmacHex } from './crypto';
import {
  countActiveHolds as dbCountActiveHolds,
  createHold as dbCreateHold,
  expireHeldBooking as dbExpireHeldBooking,
  listLiveBookingIntervals as dbListLiveBookingIntervals,
} from './db';
import {
  isWithinMailBudget as mailIsWithinBudget,
  recordMailSent as mailRecordSent,
  sendVerificationEmail as mailSendVerification,
} from './mail';
import { isRateLimited as rateIsLimited, RATE_LIMITS, recordRateLimitEvent as rateRecordEvent } from './rate-limit';
import { addDays, calendarDateInZone, zonedWallTimeToUtcMs } from './timezone';
import { verifyTurnstile as turnstileVerify } from './turnstile';
import {
  isValidSlotStartFormat,
  isValidTopic,
  isValidTurnstileToken,
  normalizeVisitorTz,
  validateCompany,
  validateEmail,
  validateName,
  validateNote,
  type HoldRequestShape,
} from './validation';

const GLOBAL_ACTIVE_HOLDS_CAP = 10;
const MAIL_DAILY_CAP_DEFAULT = 40;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export interface HoldHandlerDeps {
  computeAvailableSlots: typeof computeAvailableSlots;
  verifyTurnstile: typeof turnstileVerify;
  isRateLimited: typeof rateIsLimited;
  recordRateLimitEvent: typeof rateRecordEvent;
  countActiveHolds: typeof dbCountActiveHolds;
  isWithinMailBudget: typeof mailIsWithinBudget;
  recordMailSent: typeof mailRecordSent;
  listLiveBookingIntervals: typeof dbListLiveBookingIntervals;
  createHold: typeof dbCreateHold;
  expireHeldBooking: typeof dbExpireHeldBooking;
  sendVerificationEmail: typeof mailSendVerification;
}

export const defaultHoldHandlerDeps: HoldHandlerDeps = {
  computeAvailableSlots,
  verifyTurnstile: turnstileVerify,
  isRateLimited: rateIsLimited,
  recordRateLimitEvent: rateRecordEvent,
  countActiveHolds: dbCountActiveHolds,
  isWithinMailBudget: mailIsWithinBudget,
  recordMailSent: mailRecordSent,
  listLiveBookingIntervals: dbListLiveBookingIntervals,
  createHold: dbCreateHold,
  expireHeldBooking: dbExpireHeldBooking,
  sendVerificationEmail: mailSendVerification,
};

export interface HandleHoldRequestParams {
  body: HoldRequestShape;
  now: Date;
  clientIp: string;
  db: D1Database;
  rateHmacSecret: string;
  turnstileSecretKey: string;
  turnstileExpectedHostname: string;
  bookingResendApiKey: string;
  mailDailyCapGlobal?: number;
  bankHolidayDates?: string[];
}

export interface HoldHandlerResult {
  status: number;
  body: Record<string, unknown>;
  retryAfterSeconds?: number;
  /** For the route to log, with the rayId this function deliberately doesn't know about. */
  logEvent?: string;
  bookingId?: string;
}

export async function handleHoldRequest(
  params: HandleHoldRequestParams,
  deps: HoldHandlerDeps = defaultHoldHandlerDeps,
): Promise<HoldHandlerResult> {
  const { body } = params;
  const bankHolidayDates = params.bankHolidayDates ?? bankHolidayData.dates;

  // 1. Honeypot — same success shape as a real hold, do nothing else.
  if (body.website.trim() !== '') {
    return { status: 202, body: { status: 'verification_sent', holdMinutes: BOOKING.holdMinutes } };
  }

  // 2. Field validation. Every field is checked (not short-circuited) so a
  // single response can list every invalid field at once.
  const fieldErrors: string[] = [];
  if (!isValidSlotStartFormat(body.slotStart)) fieldErrors.push('slotStart');
  const name = validateName(body.name);
  if (name === null) fieldErrors.push('name');
  const company = validateCompany(body.company);
  if (company === null) fieldErrors.push('company');
  if (!isValidTopic(body.topic)) fieldErrors.push('topic');
  const note = validateNote(body.note);
  if (note === null) fieldErrors.push('note');
  if (!isValidTurnstileToken(body.turnstileToken)) fieldErrors.push('turnstileToken');
  const visitorTz = normalizeVisitorTz(body.visitorTz);
  const validEmail = await validateEmail(body.email, { checkDns: true });
  if (validEmail === null) fieldErrors.push('email');

  if (fieldErrors.length > 0 || name === null || company === null || note === null || validEmail === null) {
    return { status: 400, body: { error: 'invalid_input', fields: fieldErrors } };
  }
  const validatedName: string = name;
  const validatedCompany: string = company;
  const validatedNote: string = note;
  const { email, emailKey } = validEmail;

  // 3. Turnstile — before anything that writes to D1 or sends email.
  const turnstileResult = await deps.verifyTurnstile({
    token: body.turnstileToken,
    remoteIp: params.clientIp,
    secretKey: params.turnstileSecretKey,
    expectedHostname: params.turnstileExpectedHostname,
    expectedAction: 'booking_hold',
  });
  if (!turnstileResult.ok) {
    return { status: 403, body: { error: 'challenge_failed' } };
  }

  // 4. Rate limits. Recorded immediately once all three checks pass, so
  // every attempt that gets this far counts toward the caller's budget
  // regardless of what happens in the remaining steps.
  const now = params.now;
  const nowIso = now.toISOString();
  const ipHash = await hmacHex(params.rateHmacSecret, params.clientIp);
  const emailHash = await hmacHex(params.rateHmacSecret, emailKey);

  if (await deps.isRateLimited(params.db, ipHash, nowIso, [RATE_LIMITS.holdPerIpHour, RATE_LIMITS.holdPerIpDay])) {
    return { status: 429, body: { error: 'rate_limited' }, retryAfterSeconds: 3600 };
  }
  if (await deps.isRateLimited(params.db, emailHash, nowIso, [RATE_LIMITS.holdPerEmailDay])) {
    return { status: 429, body: { error: 'rate_limited' }, retryAfterSeconds: 86400 };
  }
  if ((await deps.countActiveHolds(params.db, nowIso)) >= GLOBAL_ACTIVE_HOLDS_CAP) {
    return { status: 429, body: { error: 'rate_limited' }, retryAfterSeconds: 900 };
  }
  await deps.recordRateLimitEvent(params.db, RATE_LIMITS.holdPerIpHour.bucket, ipHash, nowIso);
  await deps.recordRateLimitEvent(params.db, RATE_LIMITS.holdPerEmailDay.bucket, emailHash, nowIso);

  // 5. Email budget — never create a hold we can't verify.
  const recipientHash = await hmacHex(params.rateHmacSecret, emailKey);
  const dailyCapGlobal = params.mailDailyCapGlobal ?? MAIL_DAILY_CAP_DEFAULT;
  const withinBudget = await deps.isWithinMailBudget({
    db: params.db,
    recipientSubjectHash: recipientHash,
    nowUtc: nowIso,
    dailyCapGlobal,
  });
  if (!withinBudget) {
    return { status: 503, body: { error: 'booking_unavailable' } };
  }

  // 6. Recompute availability — the server never trusts the client's idea of what's free.
  const liveBookings = await deps.listLiveBookingIntervals(params.db);
  const availableSlots = deps.computeAvailableSlots({
    config: BOOKING,
    now,
    bankHolidayDates,
    liveBookings,
  });
  if (!availableSlots.includes(body.slotStart)) {
    return { status: 409, body: { error: 'slot_unavailable' } };
  }

  // 7. Atomic conditional insert.
  const slotStartMs = Date.parse(body.slotStart);
  const slotEndMs = slotStartMs + BOOKING.durationMinutes * 60_000;
  const bufferMs = BOOKING.bookingBufferMinutes * 60_000;
  const londonDay = calendarDateInZone(slotStartMs, BOOKING.businessTimeZone);
  const nextLondonDay = addDays(londonDay, 1);
  const londonDayStartMs = zonedWallTimeToUtcMs(londonDay.year, londonDay.month, londonDay.day, 0, 0, BOOKING.businessTimeZone);
  const londonDayEndMs = zonedWallTimeToUtcMs(nextLondonDay.year, nextLondonDay.month, nextLondonDay.day, 0, 0, BOOKING.businessTimeZone);
  // Europe/London never transitions at midnight, so these are never null in practice.
  if (londonDayStartMs === null || londonDayEndMs === null) {
    return { status: 409, body: { error: 'slot_unavailable' } };
  }

  const id = crypto.randomUUID();
  const confirmToken = generateToken();
  const confirmTokenHash = await hashToken(confirmToken);
  const holdExpiresAtMs = now.getTime() + BOOKING.holdMinutes * 60_000;

  const holdResult = await deps.createHold(params.db, {
    id,
    slotStartUtc: body.slotStart,
    slotEndUtc: formatSlotIso(slotEndMs),
    bufferedRangeStartUtc: formatSlotIso(slotStartMs - bufferMs),
    bufferedRangeEndUtc: formatSlotIso(slotEndMs + bufferMs),
    londonDayStartUtc: formatSlotIso(londonDayStartMs),
    londonDayEndUtc: formatSlotIso(londonDayEndMs),
    maxCallsPerDay: BOOKING.maxCallsPerDay,
    name: validatedName,
    email,
    emailKey,
    company: validatedCompany || null,
    topic: body.topic,
    note: validatedNote || null,
    visitorTz,
    confirmTokenHash,
    holdExpiresAtUtc: formatSlotIso(holdExpiresAtMs),
    createdAtUtc: nowIso,
    purgeAfterUtc: formatSlotIso(slotEndMs + NINETY_DAYS_MS),
  });

  if (!holdResult.ok) {
    return { status: 409, body: { error: 'slot_unavailable' } };
  }

  // 8. Send verification email. Failure here must not leave an unverifiable hold behind.
  const sendResult = await deps.sendVerificationEmail({
    apiKey: params.bookingResendApiKey,
    to: email,
    slotStartIso: body.slotStart,
    visitorTz,
    confirmToken,
    idempotencyKey: `${id}:verification`,
  });

  if (!sendResult.ok) {
    await deps.expireHeldBooking(params.db, id);
    return { status: 503, body: { error: 'booking_unavailable' }, logEvent: 'hold_verification_mail_failed', bookingId: id };
  }
  await deps.recordMailSent(params.db, recipientHash, nowIso);

  // 9. Same response shape whether or not this email has booked before.
  return {
    status: 202,
    body: { status: 'verification_sent', holdMinutes: BOOKING.holdMinutes },
    logEvent: 'hold_created',
    bookingId: id,
  };
}
