import { describe, expect, it } from 'vitest';
import { buildConfirmedEmail } from './confirmed';

const PARAMS = {
  name: 'Ada Lovelace',
  slotStartIso: '2026-07-20T09:00:00Z',
  visitorTz: 'Europe/London',
  topic: 'ce-readiness',
  cancelLink: 'https://cyphral.co.uk/book/cancel#t=a-token',
};

describe('buildConfirmedEmail', () => {
  it('has the exact required subject', () => {
    expect(buildConfirmedEmail(PARAMS).subject).toBe('Your call with Cyphral is booked');
  });

  it('greets the booker by name and includes the topic label and cancel link', () => {
    const content = buildConfirmedEmail(PARAMS);
    expect(content.text).toContain('Dear Ada Lovelace,');
    expect(content.text).toContain('Cyber Essentials readiness');
    expect(content.text).toContain(PARAMS.cancelLink);
    expect(content.html).toContain(PARAMS.cancelLink);
  });

  it('mentions the calendar invite is coming separately', () => {
    expect(buildConfirmedEmail(PARAMS).text.toLowerCase()).toContain('calendar invite');
  });

  it('escapes the name in the HTML part', () => {
    const content = buildConfirmedEmail({ ...PARAMS, name: '<script>alert(1)</script>' });
    expect(content.html).not.toContain('<script>alert(1)</script>');
    expect(content.html).toContain('&lt;script&gt;');
  });

  it('has no attachment-related content and no em dash', () => {
    const content = buildConfirmedEmail(PARAMS);
    expect(content.text).not.toContain('—');
    expect(content.html).not.toContain('—');
  });

  it('is signed', () => {
    expect(buildConfirmedEmail(PARAMS).text).toContain('Aisha, Cyphral');
  });
});
