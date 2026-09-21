import { describe, expect, it } from 'vitest';
import { buildMailFailedAlertEmail } from './alert';

describe('buildMailFailedAlertEmail', () => {
  const params = { bookingId: 'booking-123', slotStartIso: '2026-07-20T09:00:00Z' };

  it('includes the booking id so Aisha can look it up', () => {
    expect(buildMailFailedAlertEmail(params).text).toContain('booking-123');
  });

  it('mentions the slot time in UK time', () => {
    expect(buildMailFailedAlertEmail(params).text).toContain('UK');
  });
});
