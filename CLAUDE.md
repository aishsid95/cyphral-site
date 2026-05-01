# CLAUDE.md — Cyphral Website

## Project context
Cyphral is a UK sole-trader cybersecurity consultancy. This repo is the marketing
website at cyphral.co.uk. Founder: Aisha. Stack: Astro + Tailwind, deployed to
Cloudflare Workers with static assets. Contact form via Resend.

Brand: modern + human. Navy primary, turquoise accent. Typography-led, no stock photos.

## Critical rules — never violate

1. **Path A only.** Cyphral helps SMEs *prepare* for Cyber Essentials. Cyphral does
   NOT certify clients. Never write copy that implies certification authority.
   "Readiness", "preparation", "support" — yes. "Certification", "we certify",
   "accredited assessor" — no.
2. **No interest-bearing services.** Halal compliance: never integrate Klarna,
   Affirm, BNPL, or any interest-based payment provider. Stripe one-off payments
   are fine; subscriptions must be optional and clearly disclosed.
3. **Privacy by default.** No third-party tracking scripts. No Google Analytics.
   No Facebook Pixel. Cloudflare Web Analytics only (cookieless).
4. **Secrets discipline.** Resend API key, any future API keys: only as Cloudflare
   Worker secrets via `wrangler secret put`. Never in `.env` committed to git.
   `.env` is in `.gitignore`. Verify before every push.
5. **Legal page status.** Privacy / Cookies / Terms are AI-drafted and pending
   solicitor review. Every legal page footer has: "This is a draft policy
   pending professional legal review."
6. **ICO number.** The footer shows "ICO registration: [number]" only when the
   number is known. Otherwise omit the registration line entirely.
7. **Real claims only.** Never invent partnerships, certifications, client logos,
   or testimonials. Aisha's only credential as of v1 is MSc from Kingston.
8. **Pricing discipline.** Listed prices are the headline (e.g. "from £395").
   The founding-client discount is shown as a clearly-marked offer badge, NOT as
   the headline price. Do not invert this. Do not show only the discounted price.
9. **Founding-client terms are binding once published.** If terms need to change,
   document the change with a date; do not silently rewrite the historical offer.
10. **Pricing source of truth is `src/data/pricing.json`.** Never hardcode a
    price in a template. If a price needs changing, update the JSON and ensure
    every page rebuilds.

## Conventions

- Astro components in PascalCase: `Hero.astro`, `ServiceCard.astro`
- Pages in lowercase kebab-case: `services.astro`, `about.astro`
- Tailwind classes ordered: layout → spacing → typography → colour → state
- Use design tokens (CSS variables in `tailwind.config`) — no hardcoded hex
- Markdown blog posts in `src/content/blog/YYYY-MM-DD-slug.md`
- All copy is British English: "centre" not "center", "behaviour" not "behavior"
- Currency: GBP only, "£395" with no trailing decimals for whole pounds

## Pricing source of truth

- `src/data/pricing.json` — all prices on the site. Components import; never hardcode.
- `src/data/founding-clients.json` — `{ "taken": N, "total": 10, "offerEndsOn": "..." }`.
  Components import this for the founding-client banner.

## Verification requirements

- Every PR must `npm run build` cleanly with zero warnings
- Lighthouse a11y ≥ 95 on changed pages
- Run `npx astro check` before committing — type errors block merge
- Test contact form end-to-end before any deploy that touches `/api/contact`
- If `pricing.json` or `founding-clients.json` changes, manually verify the
  rendered Services page and Home banner before deploying

## Session continuity

Read `/docs/project-state.md` at the start of EVERY session. Update it at the
end of every completed task with: what was built, decisions made, current
state, next expected task.

## Known mistakes to avoid

- Don't use `<form action="/api/contact">` without `method="POST"` — Astro
  treats GET differently
- Don't import Node.js `fs` or `path` in any file under `/src/pages/api/` —
  Cloudflare Workers runtime doesn't support most node:* APIs without the
  `nodejs_compat` flag, and even then prefer Web APIs (fetch, crypto)
- Don't add `client:load` to components that don't need interactivity — defeats
  Astro's zero-JS-by-default
- Don't commit `wrangler.toml` with secrets — use `wrangler secret put`
- Don't put `<script>` tags with inline JS without a `nonce` — breaks CSP later
- Don't show ONLY the founding-client discount price anywhere — always pair with
  the listed price as the headline

## Skills, agents, commands

See `.claude/skills/`, `.claude/agents/`, `.claude/commands/` for project-
specific tooling (added in later tasks). Personal-level Claude Code config is
at `~/.claude/`.

## Permissions

Pre-allowed bash commands are in `.claude/settings.json`. Do not pass
`--dangerously-skip-permissions`. If you need a command not on the allowlist,
ask Aisha to add it.
