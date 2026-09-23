/**
 * Day-before reminder email (to the booker), sent by the cron job — see
 * worker/booking/cron.ts. Carries no user-supplied text beyond the name,
 * same as the other booker-facing emails.
 */
import { escapeHtml, formatSlotTime, friendlyTzName, wrapHtml } from './shared';

export interface ReminderEmailContent {
  subject: string;
  text: string;
  html: string;
}

export interface BuildReminderEmailParams {
  name: string;
  slotStartIso: string;
  visitorTz: string;
  cancelLink: string;
}

export function buildReminderEmail(params: BuildReminderEmailParams): ReminderEmailContent {
  const visitorTime = formatSlotTime(params.slotStartIso, params.visitorTz);
  const ukTime = formatSlotTime(params.slotStartIso, 'Europe/London');
  const visitorZoneLabel = friendlyTzName(params.visitorTz);

  const text = [
    `Hello ${params.name},`,
    '',
    'A reminder about your call with Cyphral.',
    '',
    `${visitorTime} (${visitorZoneLabel})`,
    `${ukTime} UK time`,
    '',
    "It's a free 30-minute Cyber Essentials gap check.",
    '',
    'If anything has changed, just reply to this email.',
    '',
    `Cancel your call: ${params.cancelLink}`,
    '',
    'Best wishes,',
    'Aisha, Cyphral',
  ].join('\n');

  const html = wrapHtml([
    `<p>Hello ${escapeHtml(params.name)},</p>`,
    '<p>A reminder about your call with Cyphral.</p>',
    `<p>${escapeHtml(visitorTime)} (${escapeHtml(visitorZoneLabel)})<br>${escapeHtml(ukTime)} UK time</p>`,
    `<p>It's a free 30-minute Cyber Essentials gap check.</p>`,
    '<p>If anything has changed, just reply to this email.</p>',
    `<p>Cancel your call: <a href="${escapeHtml(params.cancelLink)}">${escapeHtml(params.cancelLink)}</a></p>`,
    '<p>Best wishes,<br>Aisha, Cyphral</p>',
  ]);

  return { subject: 'Reminder: your call with Cyphral', text, html };
}
