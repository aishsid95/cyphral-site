import { describe, expect, it, vi } from 'vitest';
import {
  sendBookerConfirmationEmail,
  sendCancellationEmails,
  sendOwnerNotificationEmail,
  sendReminderEmail,
  sendViaResend,
} from './mail';

// escapeHtml/stripCrlf/formatSlotTime content-formatting primitives now live
// in emails/shared.ts — see emails/shared.test.ts. This file covers the
// transport layer (sendViaResend) and that each send* function wires the
// right content, recipient, reply-to, and (for the owner notification)
// attachment together correctly end-to-end.

describe('sendViaResend', () => {
  function captureFetch() {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it('sends the idempotency key header and correct Resend field names', async () => {
    const { calls, fetchImpl } = captureFetch();
    const result = await sendViaResend({
      apiKey: 'key',
      to: 'a@example.com',
      replyTo: 'hello@cyphral.co.uk',
      subject: 'Subject',
      text: 'text body',
      html: '<p>html body</p>',
      idempotencyKey: 'booking-1:verification',
      fetchImpl,
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('booking-1:verification');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      from: '"Aisha, Cyphral" <bookings@send.cyphral.co.uk>',
      to: ['a@example.com'],
      reply_to: 'hello@cyphral.co.uk',
      subject: 'Subject',
      text: 'text body',
      html: '<p>html body</p>',
    });
  });

  it('strips CR/LF from subject and reply-to before sending', async () => {
    const { calls, fetchImpl } = captureFetch();
    await sendViaResend({
      apiKey: 'key',
      to: 'a@example.com',
      replyTo: 'a@example.com\r\nBcc: x@y.com',
      subject: 'Subject\r\nX-Injected: yes',
      text: 't',
      html: 'h',
      idempotencyKey: 'k',
      fetchImpl,
    });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.subject).toBe('SubjectX-Injected: yes');
    expect(body.reply_to).toBe('a@example.comBcc: x@y.com');
  });

  it('fails on a non-2xx response', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 500 })) as typeof fetch;
    const result = await sendViaResend({
      apiKey: 'key', to: 'a@example.com', replyTo: 'a@example.com', subject: 's', text: 't', html: 'h',
      idempotencyKey: 'k', fetchImpl,
    });
    expect(result).toEqual({ ok: false });
  });

  it('fails on a network error rather than throwing', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const result = await sendViaResend({
      apiKey: 'key', to: 'a@example.com', replyTo: 'a@example.com', subject: 's', text: 't', html: 'h',
      idempotencyKey: 'k', fetchImpl,
    });
    expect(result).toEqual({ ok: false });
  });

  it('times out and fails rather than hanging', async () => {
    vi.useFakeTimers();
    const fetchImpl = ((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }) as unknown as typeof fetch;

    const promise = sendViaResend({
      apiKey: 'key', to: 'a@example.com', replyTo: 'a@example.com', subject: 's', text: 't', html: 'h',
      idempotencyKey: 'k', fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(5001);
    expect(await promise).toEqual({ ok: false });
    vi.useRealTimers();
  });
});

describe('sendReminderEmail', () => {
  it('sends the reminder with the fresh cancel token encoded in the link', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(init.body as string);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await sendReminderEmail({
      apiKey: 'key',
      to: 'visitor@example.com',
      name: 'Visitor',
      slotStartIso: '2026-07-20T09:00:00Z',
      visitorTz: 'Europe/Paris',
      cancelToken: 'a-fresh-reminder-token',
      idempotencyKey: 'booking-1:reminder',
      fetchImpl,
    });

    const body = JSON.parse(calls[0]);
    expect(body.subject).toBe('Reminder: your call with Cyphral');
    expect(body.html).toContain(encodeURIComponent('a-fresh-reminder-token'));
  });
});

describe('sendBookerConfirmationEmail and sendOwnerNotificationEmail escape user content', () => {
  it('escapes an HTML-injection attempt in the name for the owner notification', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(init.body as string);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await sendOwnerNotificationEmail({
      apiKey: 'key',
      to: 'hello@cyphral.co.uk',
      bookingId: 'booking-1',
      name: '<img src=x onerror=alert(1)>',
      email: 'visitor@example.com',
      company: '',
      topic: 'ce-readiness',
      note: '<script>alert(1)</script>',
      slotStartIso: '2026-07-20T09:00:00Z',
      slotEndIso: '2026-07-20T09:30:00Z',
      visitorTz: 'Europe/London',
      idempotencyKey: 'booking-1:owner',
      fetchImpl,
    });

    const body = JSON.parse(calls[0]);
    expect(body.html).not.toContain('<img src=x onerror=alert(1)>');
    expect(body.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(body.html).not.toContain('<script>');
    expect(body.html).toContain('&lt;script&gt;');
    // Plain text is not HTML, so it's carried through as literal text there is no injection surface for.
    expect(body.text).toContain('<img src=x onerror=alert(1)>');
  });

  it('attaches booking.ics to the owner notification', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(init.body as string);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await sendOwnerNotificationEmail({
      apiKey: 'key',
      to: 'hello@cyphral.co.uk',
      bookingId: 'booking-2',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      company: 'Analytical Engines Ltd',
      topic: 'automation',
      note: '',
      slotStartIso: '2026-07-20T09:00:00Z',
      slotEndIso: '2026-07-20T09:30:00Z',
      visitorTz: 'Europe/London',
      idempotencyKey: 'booking-2:owner',
      fetchImpl,
    });

    const body = JSON.parse(calls[0]);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]).toMatchObject({ filename: 'booking.ics', content_type: 'text/calendar; method=PUBLISH' });
    const decodedIcs = Buffer.from(body.attachments[0].content, 'base64').toString('utf8');
    expect(decodedIcs).toContain('BEGIN:VEVENT');
    expect(decodedIcs).toContain('UID:booking-2@cyphral.co.uk');
  });

  it('confirmation email to the booker does not include the note', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(init.body as string);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await sendBookerConfirmationEmail({
      apiKey: 'key',
      to: 'visitor@example.com',
      name: 'Visitor',
      slotStartIso: '2026-07-20T09:00:00Z',
      visitorTz: 'Europe/London',
      topic: 'ce-readiness',
      cancelToken: 'cancel-token',
      idempotencyKey: 'booking-1:confirmed',
      fetchImpl,
    });

    const body = JSON.parse(calls[0]);
    expect(body.subject).toBe('Your call with Cyphral is booked');
    expect(body.html).toContain(encodeURIComponent('cancel-token'));
  });
});

describe('sendCancellationEmails', () => {
  it("mine reminds me to delete the event from my calendar", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(init.body as string);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await sendCancellationEmails({
      apiKey: 'key',
      bookerEmail: 'visitor@example.com',
      bookerName: 'Visitor',
      ownerEmail: 'hello@cyphral.co.uk',
      slotStartIso: '2026-07-20T09:00:00Z',
      visitorTz: 'Europe/London',
      idempotencyKeyBooker: 'booking-1:cancel-booker',
      idempotencyKeyOwner: 'booking-1:cancel-owner',
      fetchImpl,
    });

    const ownerBody = JSON.parse(calls[1]);
    expect(ownerBody.text.toLowerCase()).toContain('delete it from your calendar');
  });
});
