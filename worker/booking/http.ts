/**
 * Shared HTTP plumbing for every /api/booking/* route: response shaping,
 * the CSRF origin check, content-type/body-size enforcement, and logging
 * that can never leak personal data.
 */
import { BOOKING } from './config';

export const MAX_BODY_BYTES = 8 * 1024;

const COMMON_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

export function jsonResponse(body: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...COMMON_HEADERS,
      ...extraHeaders,
    },
  });
}

/** `{ "error": "<code>" }` — a stable code only, never a message, stack, or detail. */
export function errorResponse(code: string, status: number, extraHeaders?: Record<string, string>): Response {
  return jsonResponse({ error: code }, status, extraHeaders);
}

export function methodNotAllowed(allowed: string[]): Response {
  return errorResponse('method_not_allowed', 405, { Allow: allowed.join(', ') });
}

/**
 * The CSRF control for these routes, since there are no cookies: POST must
 * carry an Origin the site actually serves from. `env.ENVIRONMENT` is only
 * ever `"development"` under `astro dev` / local testing.
 */
export function checkOrigin(request: Request, env: { ENVIRONMENT?: string }): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  if (origin === 'https://cyphral.co.uk') return true;
  if (env.ENVIRONMENT === 'development' && origin === 'http://localhost:4321') return true;
  return false;
}

/** Exact media type match; parameters (e.g. charset) are ignored. */
export function checkJsonContentType(request: Request): boolean {
  const contentType = request.headers.get('Content-Type');
  if (!contentType) return false;
  return contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}

export type ReadJsonBodyResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: 'too_large' | 'invalid_json' };

/**
 * Reads and parses a JSON body, capped at MAX_BODY_BYTES regardless of what
 * (or whether) Content-Length claims — a streaming byte count is the actual
 * enforcement, Content-Length is only a fast-path early exit.
 */
export async function readJsonBody(request: Request): Promise<ReadJsonBodyResult> {
  const declaredLength = request.headers.get('Content-Length');
  if (declaredLength && Number(declaredLength) > MAX_BODY_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  if (!request.body) return { ok: false, reason: 'invalid_json' };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return { ok: false, reason: 'too_large' };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { ok: true, data: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True if `value` is a plain object (not array/null) carrying a dangerous own key. */
export function hasDangerousKeys(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.keys(value as Record<string, unknown>).some((key) => DANGEROUS_KEYS.has(key));
}

export function getClientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? '';
}

export function getRayId(request: Request): string {
  return request.headers.get('CF-Ray') ?? '';
}

export interface BookingEnv {
  BOOKINGS_DB: D1Database;
  BOOKING_ENABLED?: string;
  ENVIRONMENT?: string;
  RATE_HMAC_SECRET: string;
  TURNSTILE_SECRET_KEY: string;
  BOOKING_RESEND_API_KEY: string;
  /** Global daily cap for booking mail, default 40 if unset — see mail.ts. */
  MAIL_DAILY_CAP?: string;
}

export function isBookingEnabled(env: BookingEnv): boolean {
  return BOOKING.enabled && env.BOOKING_ENABLED !== 'false';
}

/**
 * Structured, PII-free event logging. Never pass names, emails, notes,
 * tokens, IPs, or Turnstile tokens here — only identifiers and outcomes.
 */
export function logEvent(params: { event: string; bookingId?: string; errorCode?: string; rayId: string }): void {
  console.log(
    JSON.stringify({
      event: params.event,
      bookingId: params.bookingId,
      errorCode: params.errorCode,
      rayId: params.rayId,
    }),
  );
}
