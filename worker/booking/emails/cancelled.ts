import { escapeHtml, formatSlotTime, wrapHtml } from './shared';

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export interface BuildCancelledBookerEmailParams {
  name: string;
  slotStartIso: string;
  visitorTz: string;
}

export function buildCancelledBookerEmail(params: BuildCancelledBookerEmailParams): EmailContent {
  const visitorTime = formatSlotTime(params.slotStartIso, params.visitorTz);

  const text = [
    `Dear ${params.name},`,
    '',
    `Your call (${visitorTime}, your time) has been cancelled.`,
    '',
    'If you would like to book another time, you can do so here: https://cyphral.co.uk/book',
    '',
    'Aisha, Cyphral',
  ].join('\n');

  const html = wrapHtml([
    `<p>Dear ${escapeHtml(params.name)},</p>`,
    `<p>Your call (${escapeHtml(visitorTime)}, your time) has been cancelled.</p>`,
    '<p>If you would like to book another time, you can do so at <a href="https://cyphral.co.uk/book">cyphral.co.uk/book</a>.</p>',
    '<p>Aisha, Cyphral</p>',
  ]);

  return { subject: 'Your call with Cyphral has been cancelled', text, html };
}

export interface BuildCancelledOwnerEmailParams {
  slotStartIso: string;
}

/** Reminds Aisha to delete the event from her own calendar — the system has no calendar integration to do that for her. */
export function buildCancelledOwnerEmail(params: BuildCancelledOwnerEmailParams): EmailContent {
  const ukTime = formatSlotTime(params.slotStartIso, 'Europe/London');

  const text = [`The call at ${ukTime} (UK) has been cancelled.`, '', 'Remember to delete it from your calendar.'].join('\n');
  const html = wrapHtml([
    `<p>The call at ${escapeHtml(ukTime)} (UK) has been cancelled.</p>`,
    '<p>Remember to delete it from your calendar.</p>',
  ]);

  return { subject: `Cancelled: ${ukTime}`, text, html };
}
