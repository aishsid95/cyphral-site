/**
 * Booking email: sending via Resend, budget enforcement, and the actual
 * email content.
 *
 * The content here is functionally complete and follows every hard rule
 * from the spec (verification email carries no user-supplied text at all,
 * every interpolated value is HTML-escaped, subjects carry no free-text
 * user input), but is plain and unstyled. Phase 4 replaces these bodies
 * with the full branded HTML/text templates and attaches the .ics file to
 * the owner notification — the wiring (budget checks, idempotency, timeout,
 * from/reply-to addresses) is not expected to change.
 */
import { isRateLimited, RATE_LIMITS, recordRateLimitEvent } from './rate-limit';
import { countRateEvents } from './db';

const FROM_ADDRESS = '"Aisha, Cyphral" <bookings@send.cyphral.co.uk>';
const OWNER_REPLY_TO = 'hello@cyphral.co.uk';
const RESEND_TIMEOUT_MS = 5000;
const RESEND_URL = 'https://api.resend.com/emails';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Defence in depth for anything header-bound — inputs are already validated not to contain these. */
export function stripCrlf(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

function formatSlotTime(slotStartIso: string, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return formatter.format(new Date(slotStartIso));
}

export const TOPIC_LABELS: Record<string, string> = {
  'ce-readiness': 'Cyber Essentials readiness',
  'ce-renewal': 'Cyber Essentials renewal',
  'cyber-care': 'Cyber Care',
  automation: 'Automation',
  'not-sure': 'Not sure yet',
};

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

export interface SendViaResendInput {
  apiKey: string;
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
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
// Email content
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

/** No user-supplied text anywhere in this email — not even the name — so the form can't be used to relay an attacker's message through our domain. */
export async function sendVerificationEmail(params: VerificationEmailParams): Promise<SendResult> {
  const visitorTime = formatSlotTime(params.slotStartIso, params.visitorTz);
  const ukTime = formatSlotTime(params.slotStartIso, 'Europe/London');
  const link = `https://cyphral.co.uk/book/confirm#t=${encodeURIComponent(params.confirmToken)}`;

  const text = [
    'Please confirm your call with Cyphral.',
    '',
    `Time: ${visitorTime} (your time)`,
    `UK time: ${ukTime}`,
    '',
    `Confirm here: ${link}`,
    '',
    'This link expires in 15 minutes.',
  ].join('\n');

  const html = [
    '<p>Please confirm your call with Cyphral.</p>',
    `<p>Time: ${escapeHtml(visitorTime)} (your time)<br>UK time: ${escapeHtml(ukTime)}</p>`,
    `<p><a href="${escapeHtml(link)}">Confirm your call</a></p>`,
    '<p>This link expires in 15 minutes.</p>',
  ].join('\n');

  return sendViaResend({
    apiKey: params.apiKey,
    to: params.to,
    replyTo: OWNER_REPLY_TO,
    subject: 'Confirm your call with Cyphral',
    text,
    html,
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

/** The name may appear here — the address has been verified by this point. */
export async function sendBookerConfirmationEmail(params: BookerConfirmationParams): Promise<SendResult> {
  const visitorTime = formatSlotTime(params.slotStartIso, params.visitorTz);
  const ukTime = formatSlotTime(params.slotStartIso, 'Europe/London');
  const link = `https://cyphral.co.uk/book/cancel#t=${encodeURIComponent(params.cancelToken)}`;
  const topicLabel = TOPIC_LABELS[params.topic] ?? params.topic;

  const text = [
    `Dear ${params.name},`,
    '',
    'Your call with Cyphral is booked.',
    '',
    `Time: ${visitorTime} (your time)`,
    `UK time: ${ukTime}`,
    `Topic: ${topicLabel}`,
    '',
    'I will send a calendar invite with the video call link before the call.',
    '',
    `Need to cancel? ${link}`,
    '',
    'Aisha, Cyphral',
  ].join('\n');

  const html = [
    `<p>Dear ${escapeHtml(params.name)},</p>`,
    '<p>Your call with Cyphral is booked.</p>',
    `<p>Time: ${escapeHtml(visitorTime)} (your time)<br>UK time: ${escapeHtml(ukTime)}<br>Topic: ${escapeHtml(topicLabel)}</p>`,
    '<p>I will send a calendar invite with the video call link before the call.</p>',
    `<p>Need to cancel? <a href="${escapeHtml(link)}">Cancel your call</a></p>`,
    '<p>Aisha, Cyphral</p>',
  ].join('\n');

  return sendViaResend({
    apiKey: params.apiKey,
    to: params.to,
    replyTo: OWNER_REPLY_TO,
    subject: 'Your call with Cyphral is booked',
    text,
    html,
    idempotencyKey: params.idempotencyKey,
    fetchImpl: params.fetchImpl,
  });
}

export interface OwnerNotificationParams {
  apiKey: string;
  to: string;
  name: string;
  email: string;
  company: string;
  topic: string;
  note: string;
  slotStartIso: string;
  visitorTz: string;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
}

/** TODO (Phase 4): attach booking.ics (text/calendar; method=PUBLISH). */
export async function sendOwnerNotificationEmail(params: OwnerNotificationParams): Promise<SendResult> {
  const visitorTime = formatSlotTime(params.slotStartIso, params.visitorTz);
  const ukTime = formatSlotTime(params.slotStartIso, 'Europe/London');
  const topicLabel = TOPIC_LABELS[params.topic] ?? params.topic;
  const company = params.company || '(not given)';
  const note = params.note || '(none)';

  const text = [
    'New call booked.',
    '',
    `Name: ${params.name}`,
    `Email: ${params.email}`,
    `Company: ${company}`,
    `Topic: ${topicLabel}`,
    `Time: ${ukTime} (UK) / ${visitorTime} (their time, ${params.visitorTz})`,
    '',
    'Note:',
    note,
  ].join('\n');

  const html = [
    '<p>New call booked.</p>',
    `<p>Name: ${escapeHtml(params.name)}<br>`,
    `Email: ${escapeHtml(params.email)}<br>`,
    `Company: ${escapeHtml(company)}<br>`,
    `Topic: ${escapeHtml(topicLabel)}<br>`,
    `Time: ${escapeHtml(ukTime)} (UK) / ${escapeHtml(visitorTime)} (their time, ${escapeHtml(params.visitorTz)})</p>`,
    `<p>Note:<br>${escapeHtml(note).replace(/\n/g, '<br>')}</p>`,
  ].join('\n');

  return sendViaResend({
    apiKey: params.apiKey,
    to: params.to,
    replyTo: params.email,
    subject: `New call booked: ${ukTime}`,
    text,
    html,
    idempotencyKey: params.idempotencyKey,
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
  const visitorTime = formatSlotTime(params.slotStartIso, params.visitorTz);
  const ukTime = formatSlotTime(params.slotStartIso, 'Europe/London');

  const booker = await sendViaResend({
    apiKey: params.apiKey,
    to: params.bookerEmail,
    replyTo: OWNER_REPLY_TO,
    subject: 'Your call with Cyphral has been cancelled',
    text: [
      `Dear ${params.bookerName},`,
      '',
      `Your call (${visitorTime}, your time) has been cancelled.`,
      '',
      'If you would like to rebook, you can do so at https://cyphral.co.uk/book.',
      '',
      'Aisha, Cyphral',
    ].join('\n'),
    html: [
      `<p>Dear ${escapeHtml(params.bookerName)},</p>`,
      `<p>Your call (${escapeHtml(visitorTime)}, your time) has been cancelled.</p>`,
      '<p>If you would like to rebook, you can do so at <a href="https://cyphral.co.uk/book">cyphral.co.uk/book</a>.</p>',
      '<p>Aisha, Cyphral</p>',
    ].join('\n'),
    idempotencyKey: params.idempotencyKeyBooker,
    fetchImpl: params.fetchImpl,
  });

  const owner = await sendViaResend({
    apiKey: params.apiKey,
    to: params.ownerEmail,
    replyTo: params.bookerEmail,
    subject: `Cancelled: ${ukTime}`,
    text: [`The call at ${ukTime} (UK) has been cancelled.`, '', 'Remember to delete it from your calendar.'].join('\n'),
    html: [
      `<p>The call at ${escapeHtml(ukTime)} (UK) has been cancelled.</p>`,
      '<p>Remember to delete it from your calendar.</p>',
    ].join('\n'),
    idempotencyKey: params.idempotencyKeyOwner,
    fetchImpl: params.fetchImpl,
  });

  return { booker, owner };
}
