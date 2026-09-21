/**
 * Mail-failure alert (to Aisha). Sent by Phase 5's cron job for bookings
 * where a post-confirmation email failed (bookings.mail_failed = 1) — the
 * booking itself is unaffected, but Aisha needs to know she may not have
 * received the calendar invite prompt or the booker their confirmation.
 * bookingId is our own generated UUID and slotStartIso is system-computed,
 * so neither needs HTML escaping the way visitor-supplied text does.
 */
import { formatSlotTime } from './shared';

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export interface BuildMailFailedAlertParams {
  bookingId: string;
  slotStartIso: string;
}

export function buildMailFailedAlertEmail(params: BuildMailFailedAlertParams): EmailContent {
  const ukTime = formatSlotTime(params.slotStartIso, 'Europe/London');

  const text = [
    `A booking email failed to send for the call at ${ukTime} (UK).`,
    '',
    `Booking ID: ${params.bookingId}`,
    '',
    'Check the booking is still correct, and email the visitor directly if needed.',
  ].join('\n');

  const html = `<!doctype html><html><body><p>A booking email failed to send for the call at ${ukTime} (UK).</p><p>Booking ID: ${params.bookingId}</p><p>Check the booking is still correct, and email the visitor directly if needed.</p></body></html>`;

  return { subject: `Booking mail failed: ${ukTime}`, text, html };
}
