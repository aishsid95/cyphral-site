/**
 * Booking email transport: Resend sending, idempotency, timeout, budget
 * enforcement, and the ICS attachment on the owner notification. Content
 * itself lives in worker/booking/emails/*.ts — this file is orchestration
 * only (which template, which recipient, which reply-to, what to attach).
 */
import { buildBookingIcs, icsToBase64 } from './ics';
import { isRateLimited, RATE_LIMITS, recordRateLimitEvent } from './rate-limit';
import { countRateEvents } from './db';
import { buildCancelledBookerEmail, buildCancelledOwnerEmail } from './emails/cancelled';
import { buildConfirmedEmail } from './emails/confirmed';
import { buildMailFailedAlertEmail } from './emails/alert';
import { buildOwnerNotificationEmail } from './emails/owner-notification';
import { buildVerificationEmail } from './emails/verification';
import { stripCrlf, topicLabel } from './emails/shared';

const FROM_ADDRESS = '"Aisha, Cyphral" <bookings@send.cyphral.co.uk>';
const OWNER_REPLY_TO = 'hello@cyphral.co.uk';
const RESEND_TIMEOUT_MS = 5000;
const RESEND_URL = 'https://api.resend.com/emails';

// ---------------------------------------------------------------------------
// Budget: the shared Resend account quota must never be exhausted by the
// booking system at the expense of Aisha's own outreach mail.
// ---------------------------------------------------------------------------

export interface MailBudgetParams {
  db: D1Database;
  recipientSubjectHash: string;
  nowUtc: string;
  dailyCapGlobal: number;
}

/**
 * True if sending one more email is within budget. Checks the global cap
 * against a UTC-calendar-day window (matching Resend's own quota reset,
 * per their docs — a rolling 24h window could under-count near midnight)
 * and the per-recipient caps as rolling windows.
 */
export async function isWithinMailBudget(params: MailBudgetParams): Promise<boolean> {
  const utcDayStart = `${params.nowUtc.slice(0, 10)}T00:00:00Z`;
  const globalCount = await countRateEvents(params.db, {
    bucket: 'mail:global',
    subjectHash: 'global',
    sinceUtc: utcDayStart,
  });
  if (globalCount >= params.dailyCapGlobal) return false;

  const recipientLimited = await isRateLimited(params.db, params.recipientSubjectHash, params.nowUtc, [
    RATE_LIMITS.mailPerRecipientHour,
    RATE_LIMITS.mailPerRecipientDay,
  ]);
  return !recipientLimited;
}

/** Call once for every email actually sent, so future budget checks see accurate usage. */
export async function recordMailSent(db: D1Database, recipientSubjectHash: string, nowUtc: string): Promise<void> {
  await recordRateLimitEvent(db, 'mail:global', 'global', nowUtc);
  await recordRateLimitEvent(db, 'mail:recipient', recipientSubjectHash, nowUtc);
}

// ---------------------------------------------------------------------------
// Low-level send
// ---------------------------------------------------------------------------

export interface ResendAttachment {
  filename: string;
  /** Base64-encoded. */
  content: string;
  content_type: string;
}

export interface SendViaResendInput {
  apiKey: string;
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
  attachments?: ResendAttachment[];
  fetchImpl?: typeof fetch;
}

export type SendResult = { ok: true } | { ok: false };

export async function sendViaResend(input: SendViaResendInput): Promise<SendResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
  try {
    const res = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [input.to],
        reply_to: stripCrlf(input.replyTo),
        subject: stripCrlf(input.subject),
        text: input.text,
        html: input.html,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      }),
      signal: controller.signal,
    });
    return res.ok ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Orchestration: one function per email, wiring content + recipient + reply-to
// (+ attachment, for the owner notification) into a Resend send.
// ---------------------------------------------------------------------------

export interface VerificationEmailParams {
  apiKey: string;
  to: string;
  slotStartIso: string;
  visitorTz: string;
  confirmToken: string;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
}

export async function sendVerificationEmail(params: VerificationEmailParams): Promise<SendResult> {
  const content = buildVerificationEmail({
    slotStartIso: params.slotStartIso,
    visitorTz: params.visitorTz,
    confirmLink: `https://cyphral.co.uk/book/confirm#t=${encodeURIComponent(params.confirmToken)}`,
  });
  return sendViaResend({
    apiKey: params.apiKey,
    to: params.to,
    replyTo: OWNER_REPLY_TO,
    ...content,
    idempotencyKey: params.idempotencyKey,
    fetchImpl: params.fetchImpl,
  });
}

export interface BookerConfirmationParams {
  apiKey: string;
  to: string;
  name: string;
  slotStartIso: string;
  visitorTz: string;
  topic: string;
  cancelToken: string;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
}

export async function sendBookerConfirmationEmail(params: BookerConfirmationParams): Promise<SendResult> {
  const content = buildConfirmedEmail({
    name: params.name,
    slotStartIso: params.slotStartIso,
    visitorTz: params.visitorTz,
    topic: params.topic,
    cancelLink: `https://cyphral.co.uk/book/cancel#t=${encodeURIComponent(params.cancelToken)}`,
  });
  return sendViaResend({
    apiKey: params.apiKey,
    to: params.to,
    replyTo: OWNER_REPLY_TO,
    ...content,
    idempotencyKey: params.idempotencyKey,
    fetchImpl: params.fetchImpl,
  });
}

export interface OwnerNotificationParams {
  apiKey: string;
  to: string;
  bookingId: string;
  name: string;
  email: string;
  company: string;
  topic: string;
  note: string;
  slotStartIso: string;
  slotEndIso: string;
  visitorTz: string;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the real current instant. */
  nowIso?: string;
}

export async function sendOwnerNotificationEmail(params: OwnerNotificationParams): Promise<SendResult> {
  const content = buildOwnerNotificationEmail({
    name: params.name,
    email: params.email,
    company: params.company,
    topic: params.topic,
    note: params.note,
    slotStartIso: params.slotStartIso,
    visitorTz: params.visitorTz,
  });

  const ics = buildBookingIcs({
    bookingId: params.bookingId,
    slotStartUtcIso: params.slotStartIso,
    slotEndUtcIso: params.slotEndIso,
    dtstampUtcIso: params.nowIso ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    name: params.name,
    email: params.email,
    company: params.company,
    topicLabel: topicLabel(params.topic),
    note: params.note,
  });

  return sendViaResend({
    apiKey: params.apiKey,
    to: params.to,
    replyTo: params.email,
    ...content,
    idempotencyKey: params.idempotencyKey,
    attachments: [{ filename: 'booking.ics', content: icsToBase64(ics), content_type: 'text/calendar; method=PUBLISH' }],
    fetchImpl: params.fetchImpl,
  });
}

export interface CancellationEmailsParams {
  apiKey: string;
  bookerEmail: string;
  bookerName: string;
  ownerEmail: string;
  slotStartIso: string;
  visitorTz: string;
  idempotencyKeyBooker: string;
  idempotencyKeyOwner: string;
  fetchImpl?: typeof fetch;
}

export async function sendCancellationEmails(
  params: CancellationEmailsParams,
): Promise<{ booker: SendResult; owner: SendResult }> {
  const bookerContent = buildCancelledBookerEmail({
    name: params.bookerName,
    slotStartIso: params.slotStartIso,
    visitorTz: params.visitorTz,
  });
  const ownerContent = buildCancelledOwnerEmail({ slotStartIso: params.slotStartIso });

  const booker = await sendViaResend({
    apiKey: params.apiKey,
    to: params.bookerEmail,
    replyTo: OWNER_REPLY_TO,
    ...bookerContent,
    idempotencyKey: params.idempotencyKeyBooker,
    fetchImpl: params.fetchImpl,
  });

  const owner = await sendViaResend({
    apiKey: params.apiKey,
    to: params.ownerEmail,
    replyTo: params.bookerEmail,
    ...ownerContent,
    idempotencyKey: params.idempotencyKeyOwner,
    fetchImpl: params.fetchImpl,
  });

  return { booker, owner };
}

export interface MailFailedAlertParams {
  apiKey: string;
  to: string;
  bookingId: string;
  slotStartIso: string;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
}

/** Used by Phase 5's cron job — not called anywhere yet. */
export async function sendMailFailedAlert(params: MailFailedAlertParams): Promise<SendResult> {
  const content = buildMailFailedAlertEmail({ bookingId: params.bookingId, slotStartIso: params.slotStartIso });
  return sendViaResend({
    apiKey: params.apiKey,
    to: params.to,
    replyTo: OWNER_REPLY_TO,
    ...content,
    idempotencyKey: params.idempotencyKey,
    fetchImpl: params.fetchImpl,
  });
}
