/**
 * Contact form backend — Cloudflare Worker (Astro API route).
 *
 * Runs on the same Worker as the site (see astro.config.mjs / wrangler.jsonc).
 * Receives the POST from the contact form, validates it, then via Resend:
 *   1. emails the submission to CONTACT_TO (reply-to set to the submitter), and
 *   2. sends the submitter a warm confirmation.
 *
 * Privacy: nothing is persisted. We do not log message bodies or email
 * addresses. The only side effect is sending the two emails.
 *
 * Secret required: RESEND_API_KEY (Cloudflare Worker secret). See README notes
 * in the PR / the report that accompanied this change.
 */
import type { APIRoute } from 'astro';
// Astro 6 on Cloudflare exposes Worker bindings/secrets via this module
// (Astro.locals.runtime.env was removed in v6).
import { env } from 'cloudflare:workers';

// This endpoint must run on-demand, never be prerendered.
export const prerender = false;

// --- Configuration -------------------------------------------------------

/** Where enquiry notifications are delivered. */
const CONTACT_TO = 'aishsid95@gmail.com';

/**
 * From address for both emails.
 *
 * NOTE ON DOMAIN VERIFICATION: Resend requires the FROM domain to be verified.
 * We send from the verified subdomain `send.cyphral.co.uk` (free plan).
 * Verifying the root domain `cyphral.co.uk` would need a paid Resend plan,
 * which we are not using, so do not switch this back to `@cyphral.co.uk`.
 */
const FROM_EMAIL = 'Cyphral <hello@send.cyphral.co.uk>';

/** Reply address shown in the confirmation email. */
const REPLY_CONTACT = 'hello@cyphral.co.uk';

// Field length caps to prevent abuse.
const MAX_NAME = 100;
const MAX_EMAIL = 254;
const MAX_MESSAGE = 5000;

// --- Lightweight per-isolate rate limiting -------------------------------
//
// Cloudflare Workers does not give us a free, zero-config persistent counter,
// so this is a best-effort in-memory limiter scoped to a single Worker isolate.
// It throttles bursts from one IP without any paid binding. Because isolates are
// ephemeral and there can be several at once, it is not a hard global guarantee.
// If stronger limiting is ever needed, swap this for Cloudflare's free
// Rate Limiting binding ([[ratelimits]] in wrangler.jsonc) or a KV namespace.
const RATE_LIMIT_MAX = 5; // submissions allowed...
const RATE_LIMIT_WINDOW_MS = 60_000; // ...per IP per this window
const ipHits = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (ipHits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    ipHits.set(ip, recent);
    return true;
  }
  recent.push(now);
  ipHits.set(ip, recent);
  return false;
}

// --- Helpers -------------------------------------------------------------

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Deliberately permissive: a real address is confirmed by the confirmation
// email actually arriving, not by clever regex. This only catches obvious junk.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function resolveApiKey(): string | undefined {
  // Production Worker secret, and `.dev.vars` under `astro dev` (workerd).
  const fromWorker = (env as { RESEND_API_KEY?: string }).RESEND_API_KEY;
  if (fromWorker) return fromWorker;

  // Secondary fallback: value from a local `.env` file.
  return (import.meta.env as Record<string, string | undefined>).RESEND_API_KEY;
}

async function readFields(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const data = (await request.json()) as Record<string, unknown>;
    return {
      name: typeof data.name === 'string' ? data.name : '',
      email: typeof data.email === 'string' ? data.email : '',
      message: typeof data.message === 'string' ? data.message : '',
      company: typeof data.company === 'string' ? data.company : '',
    };
  }
  // Fallback for standard form encodings.
  const form = await request.formData();
  return {
    name: String(form.get('name') ?? ''),
    email: String(form.get('email') ?? ''),
    message: String(form.get('message') ?? ''),
    company: String(form.get('company') ?? ''),
  };
}

async function sendEmail(
  apiKey: string,
  payload: {
    to: string;
    subject: string;
    text: string;
    reply_to?: string;
  },
): Promise<boolean> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [payload.to],
      subject: payload.subject,
      text: payload.text,
      ...(payload.reply_to ? { reply_to: payload.reply_to } : {}),
    }),
  });
  return res.ok;
}

// --- POST handler --------------------------------------------------------

export const POST: APIRoute = async ({ request, clientAddress }) => {
  // Rate limit per IP (best-effort, see note above).
  const ip = clientAddress || 'unknown';
  if (isRateLimited(ip)) {
    return json({ error: 'Too many requests. Please try again shortly.' }, 429);
  }

  let fields: Record<string, string>;
  try {
    fields = await readFields(request);
  } catch {
    return json({ error: 'Could not read the submission.' }, 400);
  }

  // Honeypot: a real visitor never fills "company" (it is visually hidden and
  // aria-hidden). If it is filled, treat as a bot: pretend success, send nothing.
  if (fields.company.trim() !== '') {
    return json({ ok: true }, 200);
  }

  const name = fields.name.trim();
  const email = fields.email.trim();
  const message = fields.message.trim();

  // Validation.
  if (!name) return json({ error: 'Please enter your name.' }, 400);
  if (name.length > MAX_NAME) return json({ error: 'Your name is too long.' }, 400);
  if (!email || !EMAIL_RE.test(email) || email.length > MAX_EMAIL) {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }
  if (!message) return json({ error: 'Please enter a message.' }, 400);
  if (message.length > MAX_MESSAGE) return json({ error: 'Your message is too long.' }, 400);

  const apiKey = resolveApiKey();
  if (!apiKey) {
    // Misconfiguration, not the visitor's fault. Do not leak detail.
    return json({ error: 'The contact service is temporarily unavailable.' }, 500);
  }

  // 1. Notify Aisha. Reply-to is the submitter so a reply goes straight to them.
  const notifyOk = await sendEmail(apiKey, {
    to: CONTACT_TO,
    subject: `New enquiry from ${name}`,
    reply_to: email,
    text: [
      `New enquiry via the Cyphral contact form.`,
      ``,
      `Name:  ${name}`,
      `Email: ${email}`,
      ``,
      `Message:`,
      message,
    ].join('\n'),
  });

  if (!notifyOk) {
    return json({ error: 'Sorry, something went wrong sending your message.' }, 502);
  }

  // 2. Confirmation to the submitter. Warm, plain, no marketing, no extra links.
  await sendEmail(apiKey, {
    to: email,
    subject: 'Thanks for getting in touch with Cyphral',
    text: [
      `Dear ${name},`,
      ``,
      `Thank you for getting in touch. I have received your message and will`,
      `reply within one working day.`,
      ``,
      `If anything else comes to mind in the meantime, you can reach me at`,
      `${REPLY_CONTACT}.`,
      ``,
      `Best Regards,`,
      `Aisha,`,
      `Cyphral`,
    ].join('\n'),
  });
  // The confirmation is best-effort: if it fails, the enquiry still reached
  // Aisha, so we still report success to the visitor.

  return json({ ok: true }, 200);
};

// --- Reject non-POST methods with 405 ------------------------------------

const methodNotAllowed: APIRoute = () =>
  new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', Allow: 'POST' },
  });

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
