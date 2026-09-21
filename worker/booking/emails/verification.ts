/**
 * Verification email (to the booker). Deliberately carries no user-supplied
 * text at all — not even the name — so the booking form can never be used
 * to relay an attacker's chosen message through cyphral.co.uk's domain to
 * an arbitrary third party.
 */
import { escapeHtml, formatSlotTime, wrapHtml } from './shared';

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

  const text = [
    'Thanks for booking a call with Cyphral.',
    '',
    `${visitorTime} (${params.visitorTz})`,
    `${ukTime} UK time`,
    '',
    `Confirm your call: ${params.confirmLink}`,
    '',
    'This link expires in 15 minutes, so it is best to confirm now rather than later.',
    '',
    'Aisha, Cyphral',
  ].join('\n');

  const html = wrapHtml([
    '<p>Thanks for booking a call with Cyphral.</p>',
    `<p>${escapeHtml(visitorTime)} (${escapeHtml(params.visitorTz)})<br>${escapeHtml(ukTime)} UK time</p>`,
    `<p><a href="${escapeHtml(params.confirmLink)}">Confirm your call</a></p>`,
    '<p>This link expires in 15 minutes, so it is best to confirm now rather than later.</p>',
    '<p>Aisha, Cyphral</p>',
  ]);

  return { subject: 'Confirm your call with Cyphral', text, html };
}
