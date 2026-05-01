# Founding Client Tracker

Internal-only document. Not deployed to the website.

Offer ends: when 10th client signs, or 31 December 2026, whichever first.
Public counter source of truth: `src/data/founding-clients.json`.

## Slots

| # | Initials/Company | Service | Sign date | Discounted price | Testimonial received | Logo permission |
|---|---|---|---|---|---|---|
| 1 |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |
| 4 |  |  |  |  |  |  |
| 5 |  |  |  |  |  |  |
| 6 |  |  |  |  |  |  |
| 7 |  |  |  |  |  |  |
| 8 |  |  |  |  |  |  |
| 9 |  |  |  |  |  |  |
| 10 |  |  |  |  |  |  |

## Update process

When a client signs:
1. Fill the row above with their details.
2. Increment `taken` in `src/data/founding-clients.json`.
3. Commit with message `chore: founding client #N signed`.
4. Push — site rebuilds automatically.

When a testimonial arrives:
- Update the row above.
- Add the testimonial verbatim to the testimonials data file (created when first testimonial arrives).

When the 10th client signs OR 31 December 2026 arrives, whichever first:
- Remove the founding-client banner from the homepage.
- Remove discount badges from the Services page.
- Archive the offer terms at `/founding-offer-archive` for transparency.
