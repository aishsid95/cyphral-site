/**
 * Reminder-digest email (to Aisha), sent once per cron run that sends at
 * least one booker reminder — not once per booking. Lists every call the
 * reminder step just emailed a booker about, so there's one place to check
 * the video-call link has gone out for each before the call happens. Every
 * visitor-supplied value is HTML-escaped, same as owner-notification.ts —
 * this is another place a name or company field could carry markup.
 */
import { escapeHtml, formatSlotTime, topicLabel, wrapHtml } from './shared';

export interface ReminderDigestEntry {
  slotStartIso: string;
  name: string;
  email: string;
  company: string;
  topic: string;
}

export interface ReminderDigestContent {
  subject: string;
  text: string;
  html: string;
}

export function buildReminderDigestEmail(calls: ReminderDigestEntry[]): ReminderDigestContent {
  const sorted = [...calls].sort((a, b) => a.slotStartIso.localeCompare(b.slotStartIso));
  const count = sorted.length;
  const plural = count === 1 ? 'call' : 'calls';

  const textEntries = sorted.map((c) => {
    const ukTime = formatSlotTime(c.slotStartIso, 'Europe/London');
    return [
      `${ukTime} (UK)`,
      `Name: ${c.name}`,
      `Company: ${c.company || '(not given)'}`,
      `Email: ${c.email}`,
      `Topic: ${topicLabel(c.topic)}`,
    ].join('\n');
  });

  const text = [`Reminders just went out for ${count} ${plural}.`, '', textEntries.join('\n\n')].join('\n');

  const htmlEntries = sorted.map((c) => {
    const ukTime = formatSlotTime(c.slotStartIso, 'Europe/London');
    return `<p>${escapeHtml(ukTime)} (UK)<br>Name: ${escapeHtml(c.name)}<br>Company: ${escapeHtml(c.company || '(not given)')}<br>Email: ${escapeHtml(c.email)}<br>Topic: ${escapeHtml(topicLabel(c.topic))}</p>`;
  });

  const html = wrapHtml([`<p>Reminders just went out for ${count} ${plural}.</p>`, ...htmlEntries]);

  return { subject: `Reminder sent: ${count} ${plural}`, text, html };
}
