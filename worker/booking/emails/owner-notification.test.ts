import { describe, expect, it } from 'vitest';
import { buildOwnerNotificationEmail } from './owner-notification';

const PARAMS = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company: 'Analytical Engines Ltd',
  topic: 'automation',
  note: 'Looking forward to it',
  slotStartIso: '2026-07-20T09:00:00Z',
  visitorTz: 'Europe/Paris',
};

describe('buildOwnerNotificationEmail', () => {
  it('subject is computed (UK time), not free user text', () => {
    expect(buildOwnerNotificationEmail(PARAMS).subject).toMatch(/^New call booked: /);
  });

  it('includes name, email, company, topic, note, and both time zones as friendly names', () => {
    const content = buildOwnerNotificationEmail(PARAMS);
    expect(content.text).toContain('Ada Lovelace');
    expect(content.text).toContain('ada@example.com');
    expect(content.text).toContain('Analytical Engines Ltd');
    expect(content.text).toContain('Automation');
    expect(content.text).toContain('Looking forward to it');
    expect(content.text).toContain('UK');
    expect(content.text).toContain('(their time: Paris)');
    expect(content.text).not.toContain('Europe/Paris');
    expect(content.text).not.toContain('Paris time');
  });

  it('shows (not given) and (none) for absent company/note', () => {
    const content = buildOwnerNotificationEmail({ ...PARAMS, company: '', note: '' });
    expect(content.text).toContain('(not given)');
    expect(content.text).toContain('(none)');
  });

  it('escapes an HTML-injection attempt in the note', () => {
    const content = buildOwnerNotificationEmail({ ...PARAMS, note: '<img src=x onerror=alert(1)>' });
    expect(content.html).not.toContain('<img src=x onerror=alert(1)>');
    expect(content.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // The plain-text part is not HTML, so the literal text is fine there.
    expect(content.text).toContain('<img src=x onerror=alert(1)>');
  });

  it('preserves newlines in a multi-line note as <br> in HTML', () => {
    const content = buildOwnerNotificationEmail({ ...PARAMS, note: 'line one\nline two' });
    expect(content.html).toContain('line one<br>line two');
  });

  it('contains no em dash', () => {
    const content = buildOwnerNotificationEmail(PARAMS);
    expect(content.text).not.toContain('—');
    expect(content.html).not.toContain('—');
  });
});
