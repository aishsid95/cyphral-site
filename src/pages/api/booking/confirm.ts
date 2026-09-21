/**
 * POST /api/booking/confirm — turns a held booking into a confirmed one.
 * The token travels in the request body (never the URL/query string), read
 * by the client from the page's URL fragment — see src/pages/book/confirm.astro.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import bankHolidayData from '../../../../worker/booking/bank-holidays.json';
import { computeAvailableSlots } from '../../../../worker/booking/availability';
import { BOOKING } from '../../../../worker/booking/config';
import { generateToken, hashToken, isPlausibleToken } from '../../../../worker/booking/crypto';
import {
  confirmHeldBooking,
  expireHeldBooking,
  findHeldBookingByConfirmTokenHash,
  listLiveBookingIntervals,
  markMailFailed,
} from '../../../../worker/booking/db';
import {
  checkJsonContentType,
  checkOrigin,
  errorResponse,
  getRayId,
  hasDangerousKeys,
  isBookingEnabled,
  jsonResponse,
  logEvent,
  methodNotAllowed,
  readJsonBody,
} from '../../../../worker/booking/http';
import { sendBookerConfirmationEmail, sendOwnerNotificationEmail } from '../../../../worker/booking/mail';
import { parseTokenRequestShape } from '../../../../worker/booking/validation';

export const prerender = false;

const OWNER_EMAIL = 'hello@cyphral.co.uk';

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

  const shapeResult = parseTokenRequestShape(bodyResult.data);
  if (!shapeResult.ok) return errorResponse('invalid_input', 400);

  // Validate token shape before hashing/lookup — a malformed token is
  // certainly not found, same response either way.
  if (!isPlausibleToken(shapeResult.data.token)) return errorResponse('link_expired', 410);
  const confirmTokenHash = await hashToken(shapeResult.data.token);

  const booking = await findHeldBookingByConfirmTokenHash(env.BOOKINGS_DB, confirmTokenHash);
  if (!booking) return errorResponse('link_expired', 410);

  const now = new Date();
  const nowIso = now.toISOString();

  // Recompute availability for this slot, ignoring this booking's own hold
  // — the config may have changed (a deploy) since the hold was created.
  const otherLiveBookings = (await listLiveBookingIntervals(env.BOOKINGS_DB)).filter(
    (b) => b.startUtc !== booking.slotStartUtc,
  );
  const stillAvailable = computeAvailableSlots({
    config: BOOKING,
    now,
    bankHolidayDates: bankHolidayData.dates,
    liveBookings: otherLiveBookings,
  }).includes(booking.slotStartUtc);

  if (!stillAvailable) {
    await expireHeldBooking(env.BOOKINGS_DB, booking.id);
    logEvent({ event: 'confirm_slot_no_longer_available', bookingId: booking.id, rayId });
    return errorResponse('slot_unavailable', 409);
  }

  const cancelToken = generateToken();
  const cancelTokenHash = await hashToken(cancelToken);

  const confirmResult = await confirmHeldBooking(env.BOOKINGS_DB, {
    confirmTokenHash,
    nowUtc: nowIso,
    cancelTokenHash,
    confirmedAtUtc: nowIso,
  });
  if (!confirmResult.ok) return errorResponse('link_expired', 410);

  logEvent({ event: 'booking_confirmed', bookingId: booking.id, rayId });

  // Email failure here must not roll back the booking — it's already confirmed.
  const [bookerResult, ownerResult] = await Promise.all([
    sendBookerConfirmationEmail({
      apiKey: env.BOOKING_RESEND_API_KEY,
      to: booking.email,
      name: booking.name,
      slotStartIso: booking.slotStartUtc,
      visitorTz: booking.visitorTz,
      topic: booking.topic,
      cancelToken,
      idempotencyKey: `${booking.id}:confirmed-booker`,
    }),
    sendOwnerNotificationEmail({
      apiKey: env.BOOKING_RESEND_API_KEY,
      to: OWNER_EMAIL,
      name: booking.name,
      email: booking.email,
      company: booking.company ?? '',
      topic: booking.topic,
      note: booking.note ?? '',
      slotStartIso: booking.slotStartUtc,
      visitorTz: booking.visitorTz,
      idempotencyKey: `${booking.id}:confirmed-owner`,
    }),
  ]);

  if (!bookerResult.ok || !ownerResult.ok) {
    await markMailFailed(env.BOOKINGS_DB, booking.id);
    logEvent({ event: 'confirm_mail_failed', bookingId: booking.id, rayId });
  }

  return jsonResponse({ status: 'confirmed', slotStart: booking.slotStartUtc }, 200);
};

const notAllowed: APIRoute = () => methodNotAllowed(['POST']);
export const GET = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
