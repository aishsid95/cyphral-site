# Cyphral Site — Project State

This file is the sole memory between Claude Code sessions. Read it at the
start of every session. Update it at the end of every completed task with:
what was built, decisions made, current state, next expected task.

## Current phase
Phase 1 — Brand and Design Tokens (CLOSED)
Next phase: Phase 2 — Page content

## Latest update
2026-05-05 — Phase 1 closed. Brand identity, design tokens, Layout, FoundingClientBanner, PriceBlock, maroon palette pivot, footer redesign, fluid hero all live. Site visually established.

## Live infrastructure

- **Production URL**: https://cyphral.co.uk
- **WWW redirect**: https://www.cyphral.co.uk
- **Workers.dev fallback**: https://cyphral-site.aishsid95.workers.dev
- **Inbound email**: hello@cyphral.co.uk, aisha@cyphral.co.uk → aishsid95@gmail.com
- **Outbound email domain** (verified, ready for Phase 4): send.cyphral.co.uk via Resend
- **Repo**: https://github.com/aishsid95/cyphral-site (public, main branch auto-deploys)

## Phase 0 progress

| Task | Description | Status |
|---|---|---|
| 1 | Verify dev environment (Node 22 LTS, npm, git on macOS) | done |
| 2 | ICO data protection registration | deferred — see notes |
| 3 | Cloudflare Email Routing (hello@, aisha@ → aishsid95@gmail.com) | done |
| 4 | Resend account + send.cyphral.co.uk domain verified | done |
| 5 | GitHub repo cyphral-site (public) created | done |
| 6 | Astro + Tailwind + Cloudflare adapter scaffolded, pushed to main | done |
| 7 | CLAUDE.md, .claude/settings.json, project-state.md, pricing.json, founding-clients.json | done |
| 8 | Connect Cloudflare Workers Builds → auto-deploy main → cyphral.co.uk | done — cyphral.co.uk + www.cyphral.co.uk live over HTTPS via Cloudflare Workers, auto-deploy from main configured |

## Key decisions made

- **Node 22 LTS**, not v25. Astro supports even-numbered Node only; v25 unsupported.
- **Cloudflare Workers**, not Pages. Cloudflare's recommended path for new Astro projects (2026). The Astro Cloudflare adapter no longer supports Pages.
- **Resend** for outbound email, on subdomain `send.cyphral.co.uk`. Keeps SPF on apex clean for Cloudflare Email Routing.
- **Cloudflare Email Routing** for inbound: `hello@cyphral.co.uk` and `aisha@cyphral.co.uk` → aishsid95@gmail.com. Catch-all set to Drop.
- **Astro `minimal` template**, not blog. Content collection added manually in Phase 2.
- **Tailwind v4** via `@tailwindcss/vite` plugin (current 2026).
- **`.wrangler/`** in `.gitignore` — local Miniflare runtime state never in git.
- **DMARC `p=none`** initially. Tighten to quarantine/reject post-launch once delivery verified clean.
- **Pricing source of truth**: `src/data/pricing.json`. Components import; never hardcode.
- **Founding-client counter source of truth**: `src/data/founding-clients.json`.
- **ICO**: self-assessment on 2026-05-01 returned "not yet trading, exempt for now". Will register at Phase 4 trigger when contact form goes live. Tier 1, £52/yr (£47 direct debit).

## Files of note

- `/CLAUDE.md` — project rules, conventions, critical-never-violate list
- `/.claude/settings.json` — Claude Code permissions allowlist + denylist
- `/docs/project-state.md` — this file
- `/docs/founding-clients.md` — founding client tracker (private, not deployed)
- `/docs/legal-todo.md` — solicitor-review backlog
- `/src/data/pricing.json` — pricing source of truth
- `/src/data/founding-clients.json` — founding-client counter source of truth

## Phase 1 progress (CLOSED)

| Task | Description | Status |
|---|---|---|
| 1.5 | Wordmark + favicon (Switzer Semibold, no geometric mark) | done |
| 1.6 | Navy colour lift #0B1B2B → #1A365D; preserve deep as --color-navy-deep | done |
| 2 | Full design token system: navy/turquoise/neutral scales, type scale, semantic aliases, base styles | done |
| 3 | Base Layout.astro: head meta, sticky header, skip link, footer, slot | done |
| 4 | FoundingClientBanner.astro: hero + inline variants, build-time offer gate | done |
| 4.5 | Brand palette pivot: turquoise → maroon (UK institutional register) | done |
| 4.7 | Footer redesign: centred-stack, middot link row, remove sole-trader disclosure | done |
| 4.8 | Footer compact spacing | done |
| — | Layout widening: max-w-[1600px], scaling padding, fluid hero clamp(4.5rem, 14vw, 14rem) | done |
| 5 | PriceBlock.astro: listed headline + founding badge + IASME disclosure, closed-offer gate | done |

## Outstanding non-build TODOs

- ICO data protection registration when contact form goes live (Phase 4 trigger).
- Solicitor review of legal pages once budget allows. See /docs/legal-todo.md.
- Update CLAUDE.md and footer to include ICO registration number once received.
- Professional indemnity insurance to research and obtain before first paid client.
- Confirm self-employment permissibility with OISC-registered adviser.
- HMRC self-assessment registration as sole trader (parallel workstream, separate from this build).

## Deferred work — post-launch

- **Geometric logo mark.** v1 ships wordmark-only (Switzer Semibold "Cyphral"). The geometric mark — intended to carry layered meaning in the spirit of Aisha's father's Fumzas logo (Latin/Arabic letterform crossover, hand-drawn warmth) — is deferred. Two paths to revisit: (a) Aisha sketches concepts by hand and we vectorise; (b) hire a logo designer (Fiverr, ~£25-60, one-off purchase, halal-clean). Do not commission cold geometric SaaS marks. Reference: `/docs/logo-brief.md` (to be created when work resumes).

## Next expected task
Phase 2 Task 1 — Home page copy drafting. Approach: copy-first in orchestrator window (Option B), then single Claude Code prompt to create all 5 page files with locked copy.
