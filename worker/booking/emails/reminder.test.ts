import { describe, expect, it } from 'vitest';
import { buildReminderEmail } from './reminder';

const PARAMS = {
  name: 'Ada Lovelace',
  slotStartIso: '2026-07-20T09:00:00Z',
  visitorTz: 'Europe/London',
  cancelLink: 'https://cyphral.co.uk/book/cancel#t=a-token',
};

describe('buildReminderEmail', () => {
  it('has the exact required subject', () => {
    expect(buildReminderEmail(PARAMS).subject).toBe('Reminder: your call with Cyphral');
  });

  it('greets the booker by name (Hello, not Dear) and includes both time zones', () => {
    const content = buildReminderEmail(PARAMS);
    expect(content.text).toContain('Hello Ada Lovelace,');
    expect(content.text).not.toContain('Dear Ada Lovelace');
    expect(content.text).toContain('UK time');
  });

  it('shows the visitor time zone label distinct from the UK line', () => {
    const content = buildReminderEmail({ ...PARAMS, visitorTz: 'Europe/Paris' });
    expect(content.text).toContain('Paris time');
    expect(content.text).toContain('UK time');
  });

  it('describes the free gap check', () => {
    expect(buildReminderEmail(PARAMS).text).toContain("It's a free 30-minute Cyber Essentials gap check.");
  });

  it('invites a reply if anything has changed', () => {
    expect(buildReminderEmail(PARAMS).text).toContain('If anything has changed, just reply to this email.');
  });

  it('includes the cancel link in both text and html', () => {
    const content = buildReminderEmail(PARAMS);
    expect(content.text).toContain(`Cancel your call: ${PARAMS.cancelLink}`);
    expect(content.html).toContain(PARAMS.cancelLink);
  });

  it('is signed "Best wishes," then "Aisha, Cyphral"', () => {
    expect(buildReminderEmail(PARAMS).text).toContain('Best wishes,\nAisha, Cyphral');
  });

  it('escapes the name in the HTML part', () => {
    const content = buildReminderEmail({ ...PARAMS, name: '<script>alert(1)</script>' });
    expect(content.html).not.toContain('<script>alert(1)</script>');
    expect(content.html).toContain('&lt;script&gt;');
  });

  it('carries no user-supplied text beyond the name, and no em dash', () => {
    const content = buildReminderEmail(PARAMS);
    expect(content.text).not.toContain('—');
    expect(content.html).not.toContain('—');
  });
});
