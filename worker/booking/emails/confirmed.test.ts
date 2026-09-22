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

  it('greets the booker by name (Hello, not Dear) and includes the topic label and cancel link', () => {
    const content = buildConfirmedEmail(PARAMS);
    expect(content.text).toContain('Hello Ada Lovelace,');
    expect(content.text).not.toContain('Dear Ada Lovelace');
    expect(content.text).toContain('Getting Cyber Essentials for the first time');
    expect(content.text).toContain(PARAMS.cancelLink);
    expect(content.html).toContain(PARAMS.cancelLink);
  });

  it('mentions the calendar invite is coming separately', () => {
    expect(buildConfirmedEmail(PARAMS).text.toLowerCase()).toContain('calendar invite');
  });

  it('describes the free gap check and invites a reply beforehand', () => {
    const text = buildConfirmedEmail(PARAMS).text;
    expect(text).toContain("It's a free 30-minute Cyber Essentials gap check.");
    expect(text).toContain('just reply to this email');
  });

  it('tells the booker to cancel and rebook to change the time, then labels the link below it', () => {
    const content = buildConfirmedEmail(PARAMS);
    expect(content.text).toContain('To change the time, cancel using the link below and book again.');
    expect(content.text).toContain(`Cancel your call: ${PARAMS.cancelLink}`);
    expect(content.html).toContain(`Cancel your call: <a href="${PARAMS.cancelLink}">`);
  });

  it('is signed "Best wishes," then "Aisha, Cyphral"', () => {
    expect(buildConfirmedEmail(PARAMS).text).toContain('Best wishes,\nAisha, Cyphral');
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
});
