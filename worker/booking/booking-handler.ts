/**
 * The orchestration logic for POST /api/booking/book, extracted from the
 * Astro route so it can be unit-tested with injected fakes — in particular
 * so the ordering guarantee ("nothing expensive runs until everything
 * cheaper has passed") is actually verifiable: honeypot, a failed
 * Turnstile check, a hit rate limit, or an exhausted mail budget must each
 * result in zero calls to Turnstile/D1-write/email as appropriate. See
 * booking-handler.test.ts.
 *
 * A booking is created directly as confirmed — there is no email-verification
 * step, no 15-minute hold, no confirm token. The booker's confirmation email
 * (with their cancel link) and the owner's notification (with the .ics) both
 * go out immediately, in the same request. If either fails to send, the
 * booking is NOT rolled back (it already happened, and the visitor already
 * sees it confirmed on screen) — the same "email failure must not undo a
 * real booking" principle the old /api/booking/confirm route used, just
 * applied one step earlier now that confirmation and booking are the same
 * step. A failed send instead sets `mail_failed`, which the cron's existing
 * alert loop already turns into a one-time notification to Aisha.
 *
 * The route (src/pages/api/booking/book.ts) stays responsible for
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
  createConfirmedBooking as dbCreateConfirmedBooking,
  listLiveBookingIntervals as dbListLiveBookingIntervals,
  markMailFailed as dbMarkMailFailed,
} from './db';
import {
  isWithinMailBudget as mailIsWithinBudget,
  recordMailSent as mailRecordSent,
  sendBookerConfirmationEmail as mailSendBookerConfirmation,
  sendOwnerNotificationEmail as mailSendOwnerNotification,
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
  type BookRequestShape,
} from './validation';

const MAIL_DAILY_CAP_DEFAULT = 40;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const OWNER_EMAIL = 'hello@cyphral.co.uk';

export interface BookingHandlerDeps {
  computeAvailableSlots: typeof computeAvailableSlots;
  verifyTurnstile: typeof turnstileVerify;
  isRateLimited: typeof rateIsLimited;
  recordRateLimitEvent: typeof rateRecordEvent;
  isWithinMailBudget: typeof mailIsWithinBudget;
  recordMailSent: typeof mailRecordSent;
  listLiveBookingIntervals: typeof dbListLiveBookingIntervals;
  createConfirmedBooking: typeof dbCreateConfirmedBooking;
  markMailFailed: typeof dbMarkMailFailed;
  sendBookerConfirmationEmail: typeof mailSendBookerConfirmation;
  sendOwnerNotificationEmail: typeof mailSendOwnerNotification;
}

export const defaultBookingHandlerDeps: BookingHandlerDeps = {
  computeAvailableSlots,
  verifyTurnstile: turnstileVerify,
  isRateLimited: rateIsLimited,
  recordRateLimitEvent: rateRecordEvent,
  isWithinMailBudget: mailIsWithinBudget,
  recordMailSent: mailRecordSent,
  listLiveBookingIntervals: dbListLiveBookingIntervals,
  createConfirmedBooking: dbCreateConfirmedBooking,
  markMailFailed: dbMarkMailFailed,
  sendBookerConfirmationEmail: mailSendBookerConfirmation,
  sendOwnerNotificationEmail: mailSendOwnerNotification,
};

export interface HandleBookingRequestParams {
  body: BookRequestShape;
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

export interface BookingHandlerResult {
  status: number;
  body: Record<string, unknown>;
  retryAfterSeconds?: number;
  /** For the route to log, with the rayId this function deliberately doesn't know about. */
  logEvent?: string;
  bookingId?: string;
}

export async function handleBookingRequest(
  params: HandleBookingRequestParams,
  deps: BookingHandlerDeps = defaultBookingHandlerDeps,
): Promise<BookingHandlerResult> {
  const { body } = params;
  const bankHolidayDates = params.bankHolidayDates ?? bankHolidayData.dates;

  // 1. Honeypot — same success shape as a real booking, do nothing else.
  if (body.website.trim() !== '') {
    return { status: 201, body: { status: 'booked' } };
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
    expectedAction: 'booking_book',
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

  if (await deps.isRateLimited(params.db, ipHash, nowIso, [RATE_LIMITS.bookPerIpHour, RATE_LIMITS.bookPerIpDay])) {
    return { status: 429, body: { error: 'rate_limited' }, retryAfterSeconds: 3600 };
  }
  if (await deps.isRateLimited(params.db, emailHash, nowIso, [RATE_LIMITS.bookPerEmailDay])) {
    return { status: 429, body: { error: 'rate_limited' }, retryAfterSeconds: 86400 };
  }
  await deps.recordRateLimitEvent(params.db, RATE_LIMITS.bookPerIpHour.bucket, ipHash, nowIso);
  await deps.recordRateLimitEvent(params.db, RATE_LIMITS.bookPerEmailDay.bucket, emailHash, nowIso);

  // 5. Email budget — never create a booking we can't tell the booker about.
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

  // 7. Atomic conditional insert, straight to confirmed.
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
  const cancelToken = generateToken();
  const cancelTokenHash = await hashToken(cancelToken);

  const createResult = await deps.createConfirmedBooking(params.db, {
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
    cancelTokenHash,
    createdAtUtc: nowIso,
    confirmedAtUtc: nowIso,
    purgeAfterUtc: formatSlotIso(slotEndMs + NINETY_DAYS_MS),
  });

  if (!createResult.ok) {
    return { status: 409, body: { error: 'slot_unavailable' } };
  }

  // 8. Tell the booker and Aisha immediately. A send failure here does not
  // undo the booking — see this file's header for why.
  const [bookerResult, ownerResult] = await Promise.all([
    deps.sendBookerConfirmationEmail({
      apiKey: params.bookingResendApiKey,
      to: email,
      name: validatedName,
      slotStartIso: body.slotStart,
      visitorTz,
      topic: body.topic,
      cancelToken,
      idempotencyKey: `${id}:confirmed-booker`,
    }),
    deps.sendOwnerNotificationEmail({
      apiKey: params.bookingResendApiKey,
      to: OWNER_EMAIL,
      bookingId: id,
      name: validatedName,
      email,
      company: validatedCompany,
      topic: body.topic,
      note: validatedNote,
      slotStartIso: body.slotStart,
      slotEndIso: formatSlotIso(slotEndMs),
      visitorTz,
      idempotencyKey: `${id}:confirmed-owner`,
    }),
  ]);

  if (bookerResult.ok) {
    await deps.recordMailSent(params.db, recipientHash, nowIso);
  }

  if (!bookerResult.ok || !ownerResult.ok) {
    await deps.markMailFailed(params.db, id);
    return {
      status: 201,
      body: { status: 'booked' },
      logEvent: 'booking_created_mail_failed',
      bookingId: id,
    };
  }

  return {
    status: 201,
    body: { status: 'booked' },
    logEvent: 'booking_created',
    bookingId: id,
  };
}
