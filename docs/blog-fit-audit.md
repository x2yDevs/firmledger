# Blog fit audit — 2026-09-12

## Scope

The blog area only: the blog index and all 10 published posts, on desktop (1440px) and mobile (390px). No other page, style or behaviour was in scope — and none was changed.

## Verified locally

- Real headless Chromium renders of all 11 pages at 1440×900 (1.5× DPR) and 390×844 (2× DPR), reduced-motion emulated so reveal animations render in their visible state.
- Page level: document `scrollWidth` equals the viewport width on all 22 page/viewport combinations — zero horizontal overflow.
- Content level: every element inside each post body (`.blog-body`) — headings, paragraphs, lists, links, inline code, both endpoint tables, all code blocks — measured against the prose column (716px desktop / 350px mobile) or its nearest scroll guard. No element escapes its column or the screen.
- The endpoint tables in both API posts fit inside their `.table-wrap` on both viewports, with every column readable.
- Code blocks stay inside their contained boxes; the single extra-long `curl` line scrolls horizontally *inside* its own box on mobile and never widens the page (the intentional scroll guard).
- Blog index grid: all 10 cards in a 3-column grid with equal card heights on desktop; a single full-width column on mobile.
- Every audited page returned HTTP 200.
- No code changes were needed: the blog area already fit well, so this branch carries no diff against `main` outside this document.

## Pages covered

Blog index; How to use the FirmLedger API — every endpoint needs a key; The FirmLedger API: a production guide to the ledger; Why we fetch from Wikipedia, and nothing else; DNS, meta tag or badge: choosing a verification method for your listing; How FirmLedger builds a trustworthy business record; News on FirmLedger: what a profile is allowed to say about the news; How Featured placement works on FirmLedger; How advertising works on FirmLedger; Turning your FirmLedger listing into leads; Where to list your startup in 2026 for Instant Verification & SEO.

## Artifacts

Screenshots were kept out of Git and are stored in `shotkit/shots/` next to the workspace:

- `blog-fit-desktop.png` / `blog-fit-mobile.png` — labelled contact sheets, all 11 pages, full page.
- `desktop-<slug>.png` / `mobile-<slug>.png` — full-page render of each page.
- `<viewport>-closeup-endpoints-table.png`, `<viewport>-closeup-code-block.png`, `<viewport>-closeup-heading.png` — full-resolution close-ups of the in-content elements that must fit.
