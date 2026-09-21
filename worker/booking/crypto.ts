/**
 * Token and hashing primitives for the booking system, built on Web Crypto
 * (`crypto.subtle`, `crypto.getRandomValues`) so they run identically in the
 * Cloudflare Workers runtime and in plain Node — no dependency needed.
 *
 * Nothing here talks to D1; see db.ts for storage.
 */

const BASE64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A fresh 32-byte random token, base64url-encoded (no padding). */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

/** SHA-256 of `token`, as lowercase hex. Store only this — never the raw token. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(digest));
}

/**
 * HMAC-SHA256 of `value` under `secret`, as lowercase hex. Used to derive
 * rate-limit subject hashes from IPs/emails — the raw value is never stored.
 */
export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(signature));
}

/** Shape check for a token arriving from a client, before hashing/lookup: base64url, 32 bytes. */
export function isPlausibleToken(value: string): boolean {
  if (value.length < 40 || value.length > 48) return false; // 32 bytes base64url, no padding, is 43 chars
  for (const ch of value) {
    if (!BASE64URL_CHARS.includes(ch)) return false;
  }
  return true;
}
