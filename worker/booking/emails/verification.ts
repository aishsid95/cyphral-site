/**
 * Verification email (to the booker). Deliberately carries no user-supplied
 * text at all — not even the name — so the booking form can never be used
 * to relay an attacker's chosen message through cyphral.co.uk's domain to
 * an arbitrary third party.
 */
import { escapeHtml, formatSlotTime, friendlyTzName, wrapHtml } from './shared';

export interface VerificationEmailContent {
  subject: string;
  text: string;
  html: string;
}

export interface BuildVerificationEmailParams {
  slotStartIso: string;
  visitorTz: string;
  confirmLink: string;
}

export function buildVerificationEmail(params: BuildVerificationEmailParams): VerificationEmailContent {
  const visitorTime = formatSlotTime(params.slotStartIso, params.visitorTz);
  const ukTime = formatSlotTime(params.slotStartIso, 'Europe/London');
  const visitorZoneLabel = friendlyTzName(params.visitorTz);

  const text = [
    'Thanks for booking a call with Cyphral.',
    '',
    `${visitorTime} (${visitorZoneLabel})`,
    `${ukTime} UK time`,
    '',
    `Confirm your call: ${params.confirmLink}`,
    '',
    "This link expires in 15 minutes. If you didn't ask for this, you can ignore this email and nothing will be booked.",
    '',
    'Best wishes,',
    'Aisha, Cyphral',
  ].join('\n');

  const html = wrapHtml([
    '<p>Thanks for booking a call with Cyphral.</p>',
    `<p>${escapeHtml(visitorTime)} (${escapeHtml(visitorZoneLabel)})<br>${escapeHtml(ukTime)} UK time</p>`,
    `<p><a href="${escapeHtml(params.confirmLink)}">Confirm your call</a></p>`,
    `<p>This link expires in 15 minutes. If you didn't ask for this, you can ignore this email and nothing will be booked.</p>`,
    '<p>Best wishes,<br>Aisha, Cyphral</p>',
  ]);

  return { subject: 'Confirm your call with Cyphral', text, html };
}
