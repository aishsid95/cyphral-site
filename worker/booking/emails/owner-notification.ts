/**
 * New-booking notification (to Aisha). Internal/operational, so the voice
 * is terser than the booker-facing emails. Every visitor-supplied value is
 * HTML-escaped — this is the one email where the note is ever shown, and
 * it must always render as literal text, never as markup.
 */
import { escapeHtml, formatSlotTime, topicLabel, wrapHtml } from './shared';

export interface OwnerNotificationContent {
  subject: string;
  text: string;
  html: string;
}

export interface BuildOwnerNotificationParams {
  name: string;
  email: string;
  company: string;
  topic: string;
  note: string;
  slotStartIso: string;
  visitorTz: string;
}

export function buildOwnerNotificationEmail(params: BuildOwnerNotificationParams): OwnerNotificationContent {
  const visitorTime = formatSlotTime(params.slotStartIso, params.visitorTz);
  const ukTime = formatSlotTime(params.slotStartIso, 'Europe/London');
  const topic = topicLabel(params.topic);
  const company = params.company || '(not given)';
  const note = params.note || '(none)';

  const text = [
    'New call booked.',
    '',
    `Name: ${params.name}`,
    `Email: ${params.email}`,
    `Company: ${company}`,
    `Topic: ${topic}`,
    `Time: ${ukTime} (UK) / ${visitorTime} (their time, ${params.visitorTz})`,
    '',
    'Note:',
    note,
    '',
    'Calendar file attached. Add it, then send the video call link before you speak.',
  ].join('\n');

  const html = wrapHtml([
    '<p>New call booked.</p>',
    `<p>Name: ${escapeHtml(params.name)}<br>`,
    `Email: ${escapeHtml(params.email)}<br>`,
    `Company: ${escapeHtml(company)}<br>`,
    `Topic: ${escapeHtml(topic)}<br>`,
    `Time: ${escapeHtml(ukTime)} (UK) / ${escapeHtml(visitorTime)} (their time, ${escapeHtml(params.visitorTz)})</p>`,
    `<p>Note:<br>${escapeHtml(note).replace(/\n/g, '<br>')}</p>`,
    '<p>Calendar file attached. Add it, then send the video call link before you speak.</p>',
  ]);

  return { subject: `New call booked: ${ukTime}`, text, html };
}
