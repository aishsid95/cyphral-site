/**
 * Booking-confirmed email (to the booker). The name may appear here since
 * this only ever goes to the address the booker themselves typed in —
 * there's no third-party relay risk in greeting them by name. The address
 * itself is DNS-checked (see validation.ts's validateEmail), not ownership-
 * verified — there's no click-to-confirm step any more.
 */
import { escapeHtml, formatSlotTime, friendlyTzName, topicLabel, wrapHtml } from './shared';

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
  const visitorZoneLabel = friendlyTzName(params.visitorTz);
  const topic = topicLabel(params.topic);

  const text = [
    `Hello ${params.name},`,
    '',
    'Your call with Cyphral is booked.',
    '',
    `${visitorTime} (${visitorZoneLabel})`,
    `${ukTime} UK time`,
    `Topic: ${topic}`,
    '',
    "It's a free 30-minute Cyber Essentials gap check. If there's anything you'd like me to look at beforehand, just reply to this email.",
    '',
    'I will send a calendar invite with the video call link before we speak.',
    '',
    'To change the time, cancel using the link below and book again.',
    '',
    `Cancel your call: ${params.cancelLink}`,
    '',
    'Best wishes,',
    'Aisha, Cyphral',
  ].join('\n');

  const html = wrapHtml([
    `<p>Hello ${escapeHtml(params.name)},</p>`,
    '<p>Your call with Cyphral is booked.</p>',
    `<p>${escapeHtml(visitorTime)} (${escapeHtml(visitorZoneLabel)})<br>${escapeHtml(ukTime)} UK time<br>Topic: ${escapeHtml(topic)}</p>`,
    `<p>It's a free 30-minute Cyber Essentials gap check. If there's anything you'd like me to look at beforehand, just reply to this email.</p>`,
    '<p>I will send a calendar invite with the video call link before we speak.</p>',
    `<p>To change the time, cancel using the link below and book again.</p>`,
    `<p>Cancel your call: <a href="${escapeHtml(params.cancelLink)}">${escapeHtml(params.cancelLink)}</a></p>`,
    '<p>Best wishes,<br>Aisha, Cyphral</p>',
  ]);

  return { subject: 'Your call with Cyphral is booked', text, html };
}
