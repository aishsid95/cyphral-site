/**
 * GET /api/booking/slots — the list of currently bookable slot starts.
 * Never returns block labels, reasons, busy intervals, or booking counts:
 * only free slot starts, which is all a visitor needs to pick one.
 */
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import bankHolidayData from '../../../../worker/booking/bank-holidays.json';
import { computeAvailableSlots } from '../../../../worker/booking/availability';
import { BOOKING } from '../../../../worker/booking/config';
import { hmacHex } from '../../../../worker/booking/crypto';
import { listLiveBookingIntervals } from '../../../../worker/booking/db';
import {
  errorResponse,
  getClientIp,
  getRayId,
  isBookingEnabled,
  jsonResponse,
  logEvent,
  methodNotAllowed,
} from '../../../../worker/booking/http';
import { isRateLimited, RATE_LIMITS, recordRateLimitEvent } from '../../../../worker/booking/rate-limit';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const rayId = getRayId(request);

  if (!isBookingEnabled(env)) return errorResponse('booking_unavailable', 503);

  const now = new Date();
  const nowIso = now.toISOString();
  const ipHash = await hmacHex(env.RATE_HMAC_SECRET, getClientIp(request));

  if (await isRateLimited(env.BOOKINGS_DB, ipHash, nowIso, [RATE_LIMITS.slotsPerIp])) {
    return errorResponse('rate_limited', 429, { 'Retry-After': '600' });
  }
  await recordRateLimitEvent(env.BOOKINGS_DB, RATE_LIMITS.slotsPerIp.bucket, ipHash, nowIso);

  const liveBookings = await listLiveBookingIntervals(env.BOOKINGS_DB);
  const slots = computeAvailableSlots({
    config: BOOKING,
    now,
    bankHolidayDates: bankHolidayData.dates,
    liveBookings,
  });

  logEvent({ event: 'slots_viewed', rayId });

  return jsonResponse(
    {
      businessTimeZone: BOOKING.businessTimeZone,
      durationMinutes: BOOKING.durationMinutes,
      slots,
      generatedAt: nowIso,
    },
    200,
  );
};

const notAllowed: APIRoute = () => methodNotAllowed(['GET']);
export const POST = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
