import { describe, expect, it } from 'vitest';
import { escapeHtml, formatSlotTime, friendlyTzName, stripCrlf, topicLabel, wrapHtml } from './shared';

describe('escapeHtml', () => {
  it('escapes the five dangerous characters', () => {
    expect(escapeHtml(`<img src=x onerror=alert(1)>&"'`)).toBe('&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;');
  });
});

describe('stripCrlf', () => {
  it('removes CR and LF', () => {
    expect(stripCrlf('a\r\nBcc: x@y.com')).toBe('aBcc: x@y.com');
  });
});

describe('formatSlotTime', () => {
  it('formats a slot in the given time zone as a readable 24-hour string', () => {
    expect(formatSlotTime('2026-07-20T09:00:00Z', 'Europe/London')).toBe('Monday 20 July at 10:00');
  });

  it('reflects a different time zone for the same instant, zero-padded', () => {
    expect(formatSlotTime('2026-07-20T09:00:00Z', 'America/New_York')).toBe('Monday 20 July at 05:00');
  });

  it('never renders an am/pm marker', () => {
    expect(formatSlotTime('2026-07-20T09:00:00Z', 'Europe/London')).not.toMatch(/am|pm/i);
  });
});

describe('friendlyTzName', () => {
  it('takes the last path segment of an IANA zone and appends "time"', () => {
    expect(friendlyTzName('Europe/Paris')).toBe('Paris time');
    expect(friendlyTzName('Asia/Kolkata')).toBe('Kolkata time');
  });

  it('replaces underscores with spaces', () => {
    expect(friendlyTzName('America/New_York')).toBe('New York time');
  });

  it('handles a three-segment zone by taking the final segment', () => {
    expect(friendlyTzName('America/Argentina/Buenos_Aires')).toBe('Buenos Aires time');
  });
});

describe('topicLabel', () => {
  it('maps every configured topic to a human label', () => {
    expect(topicLabel('ce-readiness')).toBe('Getting Cyber Essentials for the first time');
    expect(topicLabel('ce-renewal')).toBe('Renewing Cyber Essentials');
    expect(topicLabel('cyber-care')).toBe('Ongoing IT security support');
    expect(topicLabel('automation')).toBe('Automation');
    expect(topicLabel('not-sure')).toBe('Not sure yet');
  });

  it('falls back to the raw value for an unknown topic', () => {
    expect(topicLabel('something-else')).toBe('something-else');
  });
});

describe('wrapHtml', () => {
  it('wraps the given paragraphs in a minimal HTML document', () => {
    const html = wrapHtml(['<p>one</p>', '<p>two</p>']);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<p>one</p><p>two</p>');
  });
});
