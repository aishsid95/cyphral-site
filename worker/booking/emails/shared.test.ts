import { describe, expect, it } from 'vitest';
import { escapeHtml, formatSlotTime, stripCrlf, topicLabel, wrapHtml } from './shared';

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
  it('formats a slot in the given time zone as a readable string', () => {
    expect(formatSlotTime('2026-07-20T09:00:00Z', 'Europe/London')).toBe('Monday 20 July at 10:00 am');
  });

  it('reflects a different time zone for the same instant', () => {
    expect(formatSlotTime('2026-07-20T09:00:00Z', 'America/New_York')).toBe('Monday 20 July at 5:00 am');
  });
});

describe('topicLabel', () => {
  it('maps every configured topic to a human label', () => {
    expect(topicLabel('ce-readiness')).toBe('Cyber Essentials readiness');
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
