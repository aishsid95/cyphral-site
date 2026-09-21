/**
 * Booking-confirmed email (to the booker). The name may appear here —
 * unlike the verification email, the address has been verified by this
 * point, so there's no relay risk in greeting the person by name.
 */
import { escapeHtml, formatSlotTime, topicLabel, wrapHtml } from './shared';

export interface ConfirmedEmailContent {
  subject: string;
  text: string;
  html: string;
}

export interface BuildConfirmedEmailParams {
  name: string;
  slotStartIso: string;
  visitorTz: string;
  topic: string;
  cancelLink: string;
}

export function buildConfirmedEmail(params: BuildConfirmedEmailParams): ConfirmedEmailContent {
  const visitorTime = formatSlotTime(params.slotStartIso, params.visitorTz);
  const ukTime = formatSlotTime(params.slotStartIso, 'Europe/London');
  const topic = topicLabel(params.topic);

  const text = [
    `Dear ${params.name},`,
    '',
    'Your call with Cyphral is booked.',
    '',
    `${visitorTime} (${params.visitorTz})`,
    `${ukTime} UK time`,
    `Topic: ${topic}`,
    '',
    'I will send a calendar invite with the video call link before we speak.',
    '',
    `Need to change or cancel? ${params.cancelLink}`,
    '',
    'Aisha, Cyphral',
  ].join('\n');

  const html = wrapHtml([
    `<p>Dear ${escapeHtml(params.name)},</p>`,
    '<p>Your call with Cyphral is booked.</p>',
    `<p>${escapeHtml(visitorTime)} (${escapeHtml(params.visitorTz)})<br>${escapeHtml(ukTime)} UK time<br>Topic: ${escapeHtml(topic)}</p>`,
    '<p>I will send a calendar invite with the video call link before we speak.</p>',
    `<p>Need to change or cancel? <a href="${escapeHtml(params.cancelLink)}">Cancel your call</a></p>`,
    '<p>Aisha, Cyphral</p>',
  ]);

  return { subject: 'Your call with Cyphral is booked', text, html };
}
