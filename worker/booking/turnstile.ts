/**
 * Cloudflare Turnstile server-side verification. A failed or malformed
 * response is always treated as a failure — never assume success on any
 * kind of error, timeout, or unexpected shape from Cloudflare's endpoint.
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5000;

export interface VerifyTurnstileParams {
  token: string;
  remoteIp: string;
  secretKey: string;
  /** The site hostname Turnstile should report back — "cyphral.co.uk" in production. */
  expectedHostname: string;
  expectedAction: string;
  fetchImpl?: typeof fetch;
}

export type VerifyTurnstileResult = { ok: true } | { ok: false };

interface SiteverifyResponse {
  success: boolean;
  hostname?: string;
  action?: string;
  'error-codes'?: string[];
}

export async function verifyTurnstile(params: VerifyTurnstileParams): Promise<VerifyTurnstileResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const body = new URLSearchParams({
      secret: params.secretKey,
      response: params.token,
      remoteip: params.remoteIp,
    });
    const res = await fetchImpl(SITEVERIFY_URL, { method: 'POST', body, signal: controller.signal });
    if (!res.ok) return { ok: false };

    const data = (await res.json()) as SiteverifyResponse;
    if (data.success !== true) return { ok: false };
    if (data.hostname !== params.expectedHostname) return { ok: false };
    if (data.action !== params.expectedAction) return { ok: false };

    return { ok: true };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}
