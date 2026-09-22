/**
 * Shared building blocks for the email templates in this directory: escaping,
 * time formatting, topic labels, and a minimal HTML wrapper. No sending
 * logic here — see ../mail.ts for Resend, budget, and attachment wiring.
 */

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

export function formatSlotTime(slotStartIso: string, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return formatter.format(new Date(slotStartIso));
}

/**
 * "Europe/Paris" -> "Paris". IANA zone IDs are Continent/City (or, for a few,
 * Continent/Region/City) by construction, so taking the last path segment
 * and swapping underscores for spaces gives a readable name for any zone a
 * visitor's browser reports, without a lookup table to maintain. Europe/
 * London is never passed through this — the UK line always reads "UK time"
 * as its own fixed string, everywhere it appears.
 */
export function friendlyTzCityName(timeZone: string): string {
  const lastSegment = timeZone.split('/').pop() ?? timeZone;
  return lastSegment.replace(/_/g, ' ');
}

/** "Europe/Paris" -> "Paris time" — friendlyTzCityName with " time" appended, for the "(Paris time)" phrasing. */
export function friendlyTzName(timeZone: string): string {
  return `${friendlyTzCityName(timeZone)} time`;
}

export const TOPIC_LABELS: Record<string, string> = {
  'ce-readiness': 'Getting Cyber Essentials for the first time',
  'ce-renewal': 'Renewing Cyber Essentials',
  'cyber-care': 'Ongoing IT security support',
  automation: 'Automation',
  'not-sure': 'Not sure yet',
};

export function topicLabel(topic: string): string {
  return TOPIC_LABELS[topic] ?? topic;
}

const BODY_STYLE =
  'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; ' +
  'font-size: 16px; line-height: 1.6; color: #12202e; max-width: 480px; margin: 0 auto; padding: 24px 16px;';

/** Wraps pre-escaped HTML fragments (each already a full block element) in a minimal, plain email shell. */
export function wrapHtml(paragraphs: string[]): string {
  return `<!doctype html><html><body style="${BODY_STYLE}">${paragraphs.join('')}</body></html>`;
}
