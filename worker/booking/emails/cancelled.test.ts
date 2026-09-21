import { describe, expect, it } from 'vitest';
import { buildCancelledBookerEmail, buildCancelledOwnerEmail } from './cancelled';

describe('buildCancelledBookerEmail', () => {
  const params = { name: 'Ada Lovelace', slotStartIso: '2026-07-20T09:00:00Z', visitorTz: 'Europe/London' };

  it('has the exact required subject', () => {
    expect(buildCancelledBookerEmail(params).subject).toBe('Your call with Cyphral has been cancelled');
  });

  it('links to /book to rebook', () => {
    expect(buildCancelledBookerEmail(params).text).toContain('https://cyphral.co.uk/book');
  });

  it('escapes the name in HTML', () => {
    const content = buildCancelledBookerEmail({ ...params, name: '<script>x</script>' });
    expect(content.html).not.toContain('<script>x</script>');
  });
});

describe('buildCancelledOwnerEmail', () => {
  const params = { slotStartIso: '2026-07-20T09:00:00Z' };

  it('subject starts with Cancelled: and the UK time', () => {
    expect(buildCancelledOwnerEmail(params).subject).toMatch(/^Cancelled: /);
  });

  it('reminds Aisha to delete the event from her calendar', () => {
    expect(buildCancelledOwnerEmail(params).text.toLowerCase()).toContain('delete it from your calendar');
  });
});
