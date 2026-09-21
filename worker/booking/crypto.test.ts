import { describe, expect, it } from 'vitest';
import { generateToken, hashToken, hmacHex, isPlausibleToken } from './crypto';

describe('generateToken', () => {
  it('produces a 43-character base64url string (32 random bytes, unpadded)', () => {
    const token = generateToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces different tokens each call', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });
});

describe('hashToken', () => {
  it('is deterministic and matches a known SHA-256 hex digest', async () => {
    // echo -n "abc" | sha256sum
    expect(await hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('produces different hashes for different tokens', async () => {
    const a = await hashToken(generateToken());
    const b = await hashToken(generateToken());
    expect(a).not.toBe(b);
  });
});

describe('hmacHex', () => {
  it('is deterministic for the same secret and value', async () => {
    const a = await hmacHex('secret', '203.0.113.5');
    const b = await hmacHex('secret', '203.0.113.5');
    expect(a).toBe(b);
  });

  it('differs when the secret differs (so a leaked hash cannot be reversed without it)', async () => {
    const a = await hmacHex('secret-one', '203.0.113.5');
    const b = await hmacHex('secret-two', '203.0.113.5');
    expect(a).not.toBe(b);
  });

  it('differs when the value differs', async () => {
    const a = await hmacHex('secret', 'a@example.com');
    const b = await hmacHex('secret', 'b@example.com');
    expect(a).not.toBe(b);
  });
});

describe('isPlausibleToken', () => {
  it('accepts a real generated token', () => {
    expect(isPlausibleToken(generateToken())).toBe(true);
  });

  it('rejects obviously wrong shapes', () => {
    expect(isPlausibleToken('')).toBe(false);
    expect(isPlausibleToken('too-short')).toBe(false);
    expect(isPlausibleToken('has spaces in it padded out to length!!')).toBe(false);
    expect(isPlausibleToken('a'.repeat(200))).toBe(false);
  });
});
