# Privacy & Cookie policy updates for the booking feature

Drafted, **not applied** to `src/pages/privacy.astro` or `src/pages/cookies.astro` — per the build instructions, these are proposed diffs for Aisha (and the solicitor, alongside the rest of the AI-drafted legal pages already in `docs/legal-todo.md`) to review before either page is touched.

Both pages already carry the "draft policy pending professional legal review" footer required by `CLAUDE.md`; nothing below changes that.

## `/privacy` — proposed changes

### "The personal data we collect" — extend to cover booking

**Current:**
> The only personal data we collect is information you choose to provide when you contact us, whether through the contact form on this website or by email: your name, your email address, and the content of your message.

**Proposed:**
> The only personal data we collect is information you choose to provide directly: your name, your email address, and the content of your message when you contact us through the contact form or by email; and, if you book a call, your name, email address, company name if given, the topic you select, any note you add, your time zone, and the time of the call itself.

### "Cookies and analytics" — Turnstile is no longer covered by a blanket "no cookies" claim

**Current:**
> This website uses no cookies. Our analytics provider, Cloudflare Web Analytics, is cookieless: it does not set cookies, does not fingerprint visitors, and does not track individuals across websites. It provides only aggregate, anonymous usage statistics.

**Proposed:**
> This website sets no cookies of its own. Our analytics provider, Cloudflare Web Analytics, is cookieless: it does not set cookies, does not fingerprint visitors, and does not track individuals across websites. It provides only aggregate, anonymous usage statistics.
>
> The booking page (`/book`) uses Cloudflare Turnstile to tell human visitors from bots before a booking request is accepted. Turnstile may set a cookie or use similar browser storage on that page only, strictly for that security purpose — never for advertising, analytics, or tracking you across other sites. Further detail is set out in our Cookie Policy.

### "How we use your data and our lawful basis" — add a booking purpose/basis alongside the existing enquiry one

**Proposed addition to the `<dl>`, as a second Purpose/basis pair:**
> **Purpose:** To arrange a call you have asked to book, communicate with you about it (confirmation, calendar details, cancellation if you need it), and to carry out any work that follows if you choose to engage us.
>
> **Lawful basis under UK GDPR:** Necessary to take steps, at your request, before entering into a contract with us. Booking a call is exactly that — a step you've asked for while deciding whether to engage Cyphral. Where we go on to provide services to you, processing is also necessary for the performance of a contract.

**My reasoning, for the solicitor:** the contact form's existing basis is "legitimate interests" (responding to a communication you initiated). Booking is a closer fit for UK GDPR Article 6(1)(b)'s pre-contractual limb specifically, since the entire mechanism *is* the visitor requesting a defined pre-contractual step (a discovery call) — a more precise basis than the legitimate-interests balancing test the contact form relies on. Worth the solicitor confirming this is the right call rather than just extending the existing legitimate-interests language to cover booking too.

### "Who we share your data with" — name Turnstile and D1 explicitly

**Current:**
> We rely on a small number of service providers who process data on our behalf, strictly under our instructions and under written terms: Cloudflare, for website hosting, email routing, and cookieless analytics, and Resend, for delivery of email. These act as our data processors.

**Proposed:**
> We rely on a small number of service providers who process data on our behalf, strictly under our instructions and under written terms: Cloudflare, for website hosting, our database, email routing, bot verification (Turnstile) on the booking page, and cookieless analytics, and Resend, for delivery of email. These act as our data processors.

### "International transfers" — note booking data's EU storage

**Proposed addition:**
> Booking data specifically is stored in Cloudflare's EU region. Some of our other providers may process data outside the UK; where they do, the transfer is protected by appropriate safeguards recognised under UK data protection law.

### "How long we keep your data" — add the booking retention period

**Proposed addition to the existing paragraph:**
> Booking details are kept for 90 days after the call, then deleted automatically, unless an engagement follows — in which case the retention above applies instead.

## `/cookies` — proposed rewrite

**Current page states unconditionally that the site uses no cookies at all.** That's no longer accurate once `/book` exists. Proposed replacement text:

> This website sets no cookies of its own, and we use no cookies for advertising, tracking, or behavioural analytics anywhere on the site.
>
> The one exception is the booking page (`/book`), which uses Cloudflare Turnstile to check that a booking request comes from a person, not a bot. Turnstile may set a cookie or use similar browser storage on that page only, strictly for this security purpose — never for advertising, analytics, or tracking you across other sites.
>
> Our analytics provider, Cloudflare Web Analytics, remains cookieless everywhere on the site: it does not use cookies, does not fingerprint visitors, and does not track people across sites.
>
> Because Turnstile's use is strictly necessary for security rather than for tracking, it does not require consent under UK cookie law (PECR), and we do not show a cookie banner for it. If this ever changes, we will update this page and introduce appropriate controls before any non-essential cookie is set.

**Open item, flagged rather than guessed at:** the build instructions asked for this to be verified "in browser devtools" — i.e. actually load `/book`, submit a booking, and inspect Application → Cookies and Local Storage. I don't have a way to do that in this environment (no interactive browser). What's above is based on Cloudflare's own published documentation, which confirms Turnstile uses at least a "pre-clearance cookie" mechanism for its challenge flow, but I have not personally observed the exact cookie name, domain, or expiry on this specific integration. **Please do that check on a preview deployment before publishing this page** — replace the generic "a cookie or similar browser storage" language with the specific, observed detail once you have it.
