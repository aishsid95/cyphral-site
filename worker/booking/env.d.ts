// Augments the generated Cloudflare.Env (worker-configuration.d.ts) with
// optional env vars that don't have a wrangler.jsonc binding or a required
// .dev.vars entry, so they're never in the generated file. Real ambient
// production env typing — unlike test-setup/env.d.ts, which is test-only.
declare namespace Cloudflare {
  interface Env {
    /** Global daily cap for booking mail, default 40 if unset — see mail.ts. */
    MAIL_DAILY_CAP?: string;
  }
}
