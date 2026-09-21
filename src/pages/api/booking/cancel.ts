/**
 * POST /api/booking/cancel — cancels a confirmed booking whose slot hasn't
 * started yet. Rescheduling is cancel-then-rebook; there is no separate
 * reschedule flow.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { cancelConfirmedBooking, findConfirmedBookingByCancelTokenHash } from '../../../../worker/booking/db';
import { hashToken, isPlausibleToken } from '../../../../worker/booking/crypto';
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
import { sendCancellationEmails } from '../../../../worker/booking/mail';
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

  if (!isPlausibleToken(shapeResult.data.token)) return errorResponse('link_expired', 410);
  const cancelTokenHash = await hashToken(shapeResult.data.token);

  // Read first (for the email content) — the atomic UPDATE below is still
  // the sole source of truth for whether the cancellation itself succeeds.
  const booking = await findConfirmedBookingByCancelTokenHash(env.BOOKINGS_DB, cancelTokenHash);
  if (!booking) return errorResponse('link_expired', 410);

  const now = new Date();
  const nowIso = now.toISOString();

  const cancelResult = await cancelConfirmedBooking(env.BOOKINGS_DB, {
    cancelTokenHash,
    nowUtc: nowIso,
    cancelledAtUtc: nowIso,
  });
  if (!cancelResult.ok) return errorResponse('link_expired', 410);

  logEvent({ event: 'booking_cancelled', bookingId: booking.id, rayId });

  const emailResults = await sendCancellationEmails({
    apiKey: env.BOOKING_RESEND_API_KEY,
    bookerEmail: booking.email,
    bookerName: booking.name,
    ownerEmail: OWNER_EMAIL,
    slotStartIso: booking.slotStartUtc,
    visitorTz: booking.visitorTz,
    idempotencyKeyBooker: `${booking.id}:cancelled-booker`,
    idempotencyKeyOwner: `${booking.id}:cancelled-owner`,
  });
  if (!emailResults.booker.ok || !emailResults.owner.ok) {
    logEvent({ event: 'cancel_mail_failed', bookingId: booking.id, rayId });
  }

  return jsonResponse({ status: 'cancelled' }, 200);
};

const notAllowed: APIRoute = () => methodNotAllowed(['POST']);
export const GET = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
