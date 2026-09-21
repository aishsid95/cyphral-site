/**
 * POST /api/booking/hold — HTTP shell only. The actual step-by-step
 * orchestration (honeypot, validation, Turnstile, rate limits, mail
 * budget, availability recheck, atomic insert, verification email) lives
 * in worker/booking/hold-handler.ts, which takes its D1/mail/Turnstile
 * calls as injected dependencies specifically so their ordering — nothing
 * expensive runs until everything cheaper has passed — is unit-testable.
 * See hold-handler.test.ts.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handleHoldRequest } from '../../../../worker/booking/hold-handler';
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
import { parseHoldRequestShape } from '../../../../worker/booking/validation';

export const prerender = false;

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

  const result = await handleHoldRequest({
    body: shapeResult.data,
    now: new Date(),
    clientIp: getClientIp(request),
    db: env.BOOKINGS_DB,
    rateHmacSecret: env.RATE_HMAC_SECRET,
    turnstileSecretKey: env.TURNSTILE_SECRET_KEY,
    turnstileExpectedHostname: env.ENVIRONMENT === 'development' ? 'localhost' : 'cyphral.co.uk',
    bookingResendApiKey: env.BOOKING_RESEND_API_KEY,
    mailDailyCapGlobal: env.MAIL_DAILY_CAP ? Number(env.MAIL_DAILY_CAP) : undefined,
  });

  if (result.logEvent) {
    logEvent({ event: result.logEvent, bookingId: result.bookingId, rayId });
  }

  const extraHeaders = result.retryAfterSeconds ? { 'Retry-After': String(result.retryAfterSeconds) } : undefined;
  return jsonResponse(result.body, result.status, extraHeaders);
};

const notAllowed: APIRoute = () => methodNotAllowed(['POST']);
export const GET = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
