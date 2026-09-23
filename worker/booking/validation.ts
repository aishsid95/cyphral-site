/**
 * Field-level validation for booking API input. Two layers: Valibot enforces
 * shape (strict object, correct primitive types, no extra keys — on top of
 * the dangerous-key and array-vs-object checks already done in http.ts
 * before this runs); the functions below enforce the actual business rules
 * (length, character set, format) from the spec.
 *
 * Every string is normalised the same way before any rule is applied:
 * NFC-normalise, trim, strip control/format characters, trim again (a
 * stripped leading/trailing format character can otherwise re-expose
 * whitespace `trim()` had no reason to remove the first time).
 */
import * as v from 'valibot';
import { BOOKING } from './config';
import { isValidTimeZone } from './timezone';

const CONTROL_OR_FORMAT_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

export function normalizeInput(value: string): string {
  return value.normalize('NFC').trim().replace(CONTROL_OR_FORMAT_RE, '').trim();
}

export const SLOT_START_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;

/** Format only — whether the slot is actually currently offered is a separate, business-logic check. */
export function isValidSlotStartFormat(raw: string): boolean {
  if (!SLOT_START_RE.test(raw)) return false;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return false;
  // Round-trips to the same minute: rejects e.g. "2026-02-30T10:00:00Z", which
  // Date normalises forward rather than rejecting.
  return date.toISOString().slice(0, 16) === raw.slice(0, 16);
}

const NAME_RE = /^[\p{L}\p{M}'’ .-]+$/u;
const NAME_BLOCK_RE = /http|www\.|@|\w+\.(com|net|org|ru|io|xyz|co\.uk)\b/i;

export function validateName(raw: string): string | null {
  const name = normalizeInput(raw);
  if (name.length < 1 || name.length > 80) return null;
  if (!NAME_RE.test(name)) return null;
  if (NAME_BLOCK_RE.test(name)) return null;
  return name;
}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/;

export interface ValidEmail {
  /** As typed, for sending. */
  email: string;
  /** Fully lowercased, for storage/limits/duplicate checks. */
  emailKey: string;
}

function isOwnDomain(domain: string): boolean {
  return domain === 'cyphral.co.uk' || domain.endsWith('.cyphral.co.uk');
}

export interface EmailValidationOptions {
  /** Optional DNS-over-HTTPS MX/A check. Off by default — callers that want it must opt in explicitly. */
  checkDns?: boolean;
  fetchImpl?: typeof fetch;
}

export async function validateEmail(raw: string, options: EmailValidationOptions = {}): Promise<ValidEmail | null> {
  const email = normalizeInput(raw);
  if (email.length > 254) return null;
  const atIndex = email.indexOf('@');
  if (atIndex === -1 || email.slice(0, atIndex).length > 64) return null;
  if (!EMAIL_RE.test(email)) return null;

  const emailKey = email.toLowerCase();
  const domain = emailKey.slice(emailKey.indexOf('@') + 1);
  if (isOwnDomain(domain)) return null;

  if (options.checkDns) {
    const hasRecords = await domainHasMxOrA(domain, options.fetchImpl ?? fetch);
    if (!hasRecords) return null;
  }

  return { email, emailKey };
}

/**
 * DNS-over-HTTPS lookup against 1.1.1.1, 1.5s timeout. On timeout or any
 * network error, allow — this is an anti-typo signal, not a hard gate, and
 * must never turn a Cloudflare/DNS blip into a wrongly-rejected real address.
 */
async function domainHasMxOrA(domain: string, fetchImpl: typeof fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const headers = { accept: 'application/dns-json' };
    const [mxRes, aRes] = await Promise.all([
      fetchImpl(`https://1.1.1.1/dns-query?name=${encodeURIComponent(domain)}&type=MX`, { headers, signal: controller.signal }),
      fetchImpl(`https://1.1.1.1/dns-query?name=${encodeURIComponent(domain)}&type=A`, { headers, signal: controller.signal }),
    ]);
    const [mxJson, aJson] = (await Promise.all([mxRes.json(), aRes.json()])) as [
      { Answer?: unknown[] },
      { Answer?: unknown[] },
    ];
    return (mxJson.Answer?.length ?? 0) > 0 || (aJson.Answer?.length ?? 0) > 0;
  } catch {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/** Optional field: an empty string means "not provided" and is always valid; anything over 120 chars is rejected. */
export function validateCompany(raw: string): string | null {
  const company = normalizeInput(raw);
  return company.length <= 120 ? company : null;
}

export function isValidTopic(raw: string): raw is (typeof BOOKING.topics)[number] {
  return (BOOKING.topics as readonly string[]).includes(raw);
}

export function validateNote(raw: string): string | null {
  const note = normalizeInput(raw);
  return note.length <= 500 ? note : null;
}

/** Falls back to Europe/London for anything too long or not a real IANA zone. Display only, never a security boundary. */
export function normalizeVisitorTz(raw: string): string {
  const tz = raw.trim();
  if (tz.length > 64 || !isValidTimeZone(tz)) return 'Europe/London';
  return tz;
}

export function isValidTurnstileToken(raw: string): boolean {
  return raw.length >= 1 && raw.length <= 2048;
}

// ---------------------------------------------------------------------------
// Shape schemas (Valibot). These check types and strictness only — no
// business rules — so unknown/renamed fields and wrong types fail fast and
// uniformly before the field-by-field checks above ever run.
// ---------------------------------------------------------------------------

export const BookRequestShape = v.strictObject({
  slotStart: v.string(),
  name: v.string(),
  email: v.string(),
  company: v.string(),
  topic: v.string(),
  note: v.string(),
  visitorTz: v.string(),
  website: v.string(),
  turnstileToken: v.string(),
});
export type BookRequestShape = v.InferOutput<typeof BookRequestShape>;

export const TokenRequestShape = v.strictObject({
  token: v.string(),
});
export type TokenRequestShape = v.InferOutput<typeof TokenRequestShape>;

export type ParseShapeResult<T> = { ok: true; data: T } | { ok: false };

export function parseBookRequestShape(data: unknown): ParseShapeResult<BookRequestShape> {
  const result = v.safeParse(BookRequestShape, data);
  return result.success ? { ok: true, data: result.output } : { ok: false };
}

export function parseTokenRequestShape(data: unknown): ParseShapeResult<TokenRequestShape> {
  const result = v.safeParse(TokenRequestShape, data);
  return result.success ? { ok: true, data: result.output } : { ok: false };
}
