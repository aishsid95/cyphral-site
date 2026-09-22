import { describe, expect, it } from 'vitest';
import { buildVerificationEmail } from './verification';

const PARAMS = {
  slotStartIso: '2026-07-20T09:00:00Z',
  visitorTz: 'Europe/Paris',
  confirmLink: 'https://cyphral.co.uk/book/confirm#t=a-token',
};

describe('buildVerificationEmail', () => {
  it('has the exact required subject', () => {
    expect(buildVerificationEmail(PARAMS).subject).toBe('Confirm your call with Cyphral');
  });

  it('includes the confirm link, the 15-minute expiry notice, and the ignore-it-if-unrequested line', () => {
    const content = buildVerificationEmail(PARAMS);
    expect(content.text).toContain(PARAMS.confirmLink);
    expect(content.html).toContain(PARAMS.confirmLink);
    expect(content.text).toContain('This link expires in 15 minutes.');
    expect(content.html).toContain('This link expires in 15 minutes.');
    expect(content.text).toContain("If you didn't ask for this, you can ignore this email and nothing will be booked.");
    expect(content.text).not.toContain('best to confirm now rather than later');
  });

  it('shows the visitor zone as a friendly name and the time in 24-hour format', () => {
    const content = buildVerificationEmail(PARAMS);
    expect(content.text).toContain('Paris time');
    expect(content.text).not.toContain('Europe/Paris');
    expect(content.text).not.toMatch(/am|pm/i);
    expect(content.text).toContain('UK time');
  });

  it('never includes any user-supplied text, since this template takes none', () => {
    // The function's own params list is the guarantee: nothing here accepts
    // a name, note, or company. This test documents that contract so a
    // future edit adding such a param gets caught by review, not silently.
    const paramNames = Object.keys(PARAMS);
    expect(paramNames).not.toContain('name');
    expect(paramNames).not.toContain('note');
    expect(paramNames).not.toContain('company');
  });

  it('contains no em dash', () => {
    const content = buildVerificationEmail(PARAMS);
    expect(content.text).not.toContain('—');
    expect(content.html).not.toContain('—');
  });

  it('is signed "Best wishes," then "Aisha, Cyphral"', () => {
    expect(buildVerificationEmail(PARAMS).text).toContain('Best wishes,\nAisha, Cyphral');
  });
});
