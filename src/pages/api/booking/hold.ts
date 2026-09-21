/**
 * POST /api/booking/hold — creates a 15-minute provisional hold on a slot
 * and emails a confirm link. See the numbered steps below; they run in this
 * exact order because each is deliberately the cheapest check that can
 * reject a bad request before more expensive work (Turnstile, D1, Resend)
 * runs on it.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import bankHolidayData from '../../../../worker/booking/bank-holidays.json';
import { computeAvailableSlots, formatSlotIso } from '../../../../worker/booking/availability';
import { BOOKING } from '../../../../worker/booking/config';
import { generateToken, hashToken, hmacHex } from '../../../../worker/booking/crypto';
import { countActiveHolds, createHold, expireHeldBooking, listLiveBookingIntervals } from '../../../../worker/booking/db';
import {
  checkJsonContentType,
  checkOrigin,
  errorResponse,
  getClientIp,
  getRayId,
  hasDangerousKeys,
  isBookingEnabled,
  jsonResponse,
  logEvent,
  methodNotAllowed,
  readJsonBody,
} from '../../../../worker/booking/http';
import { isWithinMailBudget, recordMailSent, sendVerificationEmail } from '../../../../worker/booking/mail';
import { isRateLimited, RATE_LIMITS, recordRateLimitEvent } from '../../../../worker/booking/rate-limit';
import { verifyTurnstile } from '../../../../worker/booking/turnstile';
import { addDays, calendarDateInZone, zonedWallTimeToUtcMs } from '../../../../worker/booking/timezone';
import {
  isValidSlotStartFormat,
  isValidTopic,
  isValidTurnstileToken,
  normalizeVisitorTz,
  parseHoldRequestShape,
  validateCompany,
  validateEmail,
  validateName,
  validateNote,
} from '../../../../worker/booking/validation';

export const prerender = false;

const GLOBAL_ACTIVE_HOLDS_CAP = 10;
const MAIL_DAILY_CAP_DEFAULT = 40;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export const POST: APIRoute = async ({ request }) => {
  const rayId = getRayId(request);

  if (!isBookingEnabled(env)) return errorResponse('booking_unavailable', 503);
  if (!checkJsonContentType(request)) return errorResponse('unsupported_media_type', 415);
  if (!checkOrigin(request, env)) return errorResponse('forbidden_origin', 403);

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return bodyResult.reason === 'too_large'
      ? errorResponse('payload_too_large', 413)
      : errorResponse('invalid_json', 400);
  }
  if (hasDangerousKeys(bodyResult.data)) return errorResponse('invalid_input', 400);

  const shapeResult = parseHoldRequestShape(bodyResult.data);
  if (!shapeResult.ok) return errorResponse('invalid_input', 400);
  const body = shapeResult.data;

  // 1. Honeypot — same success shape as a real hold, do nothing else.
  if (body.website.trim() !== '') {
    return jsonResponse({ status: 'verification_sent', holdMinutes: BOOKING.holdMinutes }, 202);
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
    return jsonResponse({ error: 'invalid_input', fields: fieldErrors }, 400);
  }
  // Every field above is now known non-null/valid — TypeScript can't see
  // that from the loose `fieldErrors` accumulation, so re-bind explicitly.
  const validatedName: string = name;
  const validatedCompany: string = company;
  const validatedNote: string = note;
  const { email, emailKey } = validEmail;

  // 3. Turnstile — before anything that writes to D1 or sends email.
  const ip = getClientIp(request);
  const turnstileResult = await verifyTurnstile({
    token: body.turnstileToken,
    remoteIp: ip,
    secretKey: env.TURNSTILE_SECRET_KEY,
    expectedHostname: env.ENVIRONMENT === 'development' ? 'localhost' : 'cyphral.co.uk',
    expectedAction: 'booking_hold',
  });
  if (!turnstileResult.ok) return errorResponse('challenge_failed', 403);

  // 4. Rate limits. Recorded immediately once all three checks pass, so
  // every attempt that gets this far counts toward the caller's budget
  // regardless of what happens in the remaining steps.
  const now = new Date();
  const nowIso = now.toISOString();
  const ipHash = await hmacHex(env.RATE_HMAC_SECRET, ip);
  const emailHash = await hmacHex(env.RATE_HMAC_SECRET, emailKey);

  if (await isRateLimited(env.BOOKINGS_DB, ipHash, nowIso, [RATE_LIMITS.holdPerIpHour, RATE_LIMITS.holdPerIpDay])) {
    return errorResponse('rate_limited', 429, { 'Retry-After': '3600' });
  }
  if (await isRateLimited(env.BOOKINGS_DB, emailHash, nowIso, [RATE_LIMITS.holdPerEmailDay])) {
    return errorResponse('rate_limited', 429, { 'Retry-After': '86400' });
  }
  if ((await countActiveHolds(env.BOOKINGS_DB, nowIso)) >= GLOBAL_ACTIVE_HOLDS_CAP) {
    return errorResponse('rate_limited', 429, { 'Retry-After': '900' });
  }
  await recordRateLimitEvent(env.BOOKINGS_DB, RATE_LIMITS.holdPerIpHour.bucket, ipHash, nowIso);
  await recordRateLimitEvent(env.BOOKINGS_DB, RATE_LIMITS.holdPerEmailDay.bucket, emailHash, nowIso);

  // 5. Email budget — never create a hold we can't verify.
  const recipientHash = await hmacHex(env.RATE_HMAC_SECRET, emailKey);
  const dailyCapGlobal = env.MAIL_DAILY_CAP ? Number(env.MAIL_DAILY_CAP) : MAIL_DAILY_CAP_DEFAULT;
  const withinBudget = await isWithinMailBudget({
    db: env.BOOKINGS_DB,
    recipientSubjectHash: recipientHash,
    nowUtc: nowIso,
    dailyCapGlobal,
  });
  if (!withinBudget) return errorResponse('booking_unavailable', 503);

  // 6. Recompute availability — the server never trusts the client's idea of what's free.
  const liveBookings = await listLiveBookingIntervals(env.BOOKINGS_DB);
  const availableSlots = computeAvailableSlots({
    config: BOOKING,
    now,
    bankHolidayDates: bankHolidayData.dates,
    liveBookings,
  });
  if (!availableSlots.includes(body.slotStart)) return errorResponse('slot_unavailable', 409);

  // 7. Atomic conditional insert.
  const slotStartMs = Date.parse(body.slotStart);
  const slotEndMs = slotStartMs + BOOKING.durationMinutes * 60_000;
  const bufferMs = BOOKING.bookingBufferMinutes * 60_000;
  const londonDay = calendarDateInZone(slotStartMs, BOOKING.businessTimeZone);
  const nextLondonDay = addDays(londonDay, 1);
  const londonDayStartMs = zonedWallTimeToUtcMs(londonDay.year, londonDay.month, londonDay.day, 0, 0, BOOKING.businessTimeZone);
  const londonDayEndMs = zonedWallTimeToUtcMs(nextLondonDay.year, nextLondonDay.month, nextLondonDay.day, 0, 0, BOOKING.businessTimeZone);
  // Europe/London never transitions at midnight, so these are never null in practice.
  if (londonDayStartMs === null || londonDayEndMs === null) return errorResponse('slot_unavailable', 409);

  const id = crypto.randomUUID();
  const confirmToken = generateToken();
  const confirmTokenHash = await hashToken(confirmToken);
  const holdExpiresAtMs = now.getTime() + BOOKING.holdMinutes * 60_000;

  const holdResult = await createHold(env.BOOKINGS_DB, {
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

  if (!holdResult.ok) return errorResponse('slot_unavailable', 409);

  // 8. Send verification email. Failure here must not leave an unverifiable hold behind.
  const sendResult = await sendVerificationEmail({
    apiKey: env.BOOKING_RESEND_API_KEY,
    to: email,
    slotStartIso: body.slotStart,
    visitorTz,
    confirmToken,
    idempotencyKey: `${id}:verification`,
  });

  if (!sendResult.ok) {
    await expireHeldBooking(env.BOOKINGS_DB, id);
    logEvent({ event: 'hold_verification_mail_failed', bookingId: id, rayId });
    return errorResponse('booking_unavailable', 503);
  }
  await recordMailSent(env.BOOKINGS_DB, recipientHash, nowIso);

  logEvent({ event: 'hold_created', bookingId: id, rayId });

  // 9. Same response shape whether or not this email has booked before.
  return jsonResponse({ status: 'verification_sent', holdMinutes: BOOKING.holdMinutes }, 202);
};

const notAllowed: APIRoute = () => methodNotAllowed(['POST']);
export const GET = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
