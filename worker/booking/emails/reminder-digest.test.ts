import { describe, expect, it } from 'vitest';
import { buildReminderDigestEmail } from './reminder-digest';

const CALL_A = {
  slotStartIso: '2026-07-20T14:00:00Z',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company: 'Analytical Engines Ltd',
  topic: 'ce-readiness',
};
const CALL_B = {
  slotStartIso: '2026-07-20T09:00:00Z', // earlier in the day than CALL_A
  name: 'Grace Hopper',
  email: 'grace@example.com',
  company: '',
  topic: 'automation',
};

describe('buildReminderDigestEmail', () => {
  it('singular subject and wording for exactly one call', () => {
    const content = buildReminderDigestEmail([CALL_A]);
    expect(content.subject).toBe('Reminder sent: 1 call');
    expect(content.text).toContain('Reminders just went out for 1 call.');
  });

  it('plural subject and wording for more than one call', () => {
    const content = buildReminderDigestEmail([CALL_A, CALL_B]);
    expect(content.subject).toBe('Reminder sent: 2 calls');
    expect(content.text).toContain('Reminders just went out for 2 calls.');
  });

  it('lists every call with time, name, company, email, and topic', () => {
    const content = buildReminderDigestEmail([CALL_A]);
    expect(content.text).toContain('Name: Ada Lovelace');
    expect(content.text).toContain('Company: Analytical Engines Ltd');
    expect(content.text).toContain('Email: ada@example.com');
    expect(content.text).toContain('Getting Cyber Essentials for the first time');
  });

  it('sorts entries by call time, earliest first, regardless of input order', () => {
    const content = buildReminderDigestEmail([CALL_A, CALL_B]);
    const gracePos = content.text.indexOf('Grace Hopper');
    const adaPos = content.text.indexOf('Ada Lovelace');
    expect(gracePos).toBeGreaterThan(-1);
    expect(gracePos).toBeLessThan(adaPos); // CALL_B (09:00) sorts before CALL_A (14:00)
  });

  it('shows "(not given)" for an empty company', () => {
    const content = buildReminderDigestEmail([CALL_B]);
    expect(content.text).toContain('Company: (not given)');
  });

  it('escapes an HTML-injection attempt in the name and company', () => {
    const content = buildReminderDigestEmail([
      { ...CALL_A, name: '<img src=x onerror=alert(1)>', company: '<script>alert(1)</script>' },
    ]);
    expect(content.html).not.toContain('<img src=x onerror=alert(1)>');
    expect(content.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(content.html).not.toContain('<script>alert(1)</script>');
    expect(content.html).toContain('&lt;script&gt;');
  });

  it('has no em dash', () => {
    const content = buildReminderDigestEmail([CALL_A, CALL_B]);
    expect(content.text).not.toContain('—');
    expect(content.html).not.toContain('—');
  });
});
