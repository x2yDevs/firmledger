# User-area validation — 2026-09-11

## Verified locally

- `npm test`: all 22 suites pass, including old/fresh/repeated database migrations.
- `npm run test:user-area:browser`: Chromium browser audit passes.
- 19 owner screens at 320, 390, 768 and 1440px widths (76 page/viewport checks).
- Every audited page returns HTTP 200 and has no document-width overflow or browser JavaScript errors.
- Notification inbox and archive content fit their scroll containers, including an unbroken long reference.
- Advertising dropdown fits mobile cards and has no duplicate focus ring.
- Normal password login and saving digest settings through browser controls work.
- HTTP tests cover populated owner screens and applicable Free-user/empty screens, digest subscribe/unsubscribe and all lead-report channel choices, notification read/archive/restore/delete and ownership protection, watchlist remove/add, and two-way replies visible to both users.
- Unconfigured advertising checkout fails safely without creating a payment.

## Screens covered

Dashboard; Watchlist; Advertise; notification/digest settings; Notifications; Archived notifications; Security; Support; New ticket; support conversation; New listing; Edit listing; listing jobs; Developer API; API playground; Upgrade; Audience analytics; Leads inbox/detail; Delete account.

The suite renders destructive/security/payment screens but does not execute account deletion, enroll 2FA, purchase a subscription, or make a live advertising payment. It does not exhaust every field combination, browser engine or device.

## Layout changes

Shared Watchlist-style dashboard breadcrumbs and compact headings; mobile advertising checkout cards instead of an off-screen table control; wrapping notification content; wrapping job actions and headers at narrow widths. Scope-specific workspace styles avoid changing public marketing pages.

## Reproduce

```sh
npm ci
npm test
npx playwright install --with-deps chromium
npm run test:user-area:browser
```

For a preinstalled browser, set `CHROMIUM_EXECUTABLE_PATH` to its executable. In Arena, bundled Chromium 152 was used because the browser CDN was unavailable; the normal Playwright install command is the portable setup. Browser binaries, test databases, sessions, outboxes and screenshots are not committed.

## Deployment gates still requiring the production environment

- Merge the PR and run the migration against a backed-up copy of the actual deployment database.
- Confirm the deployed origin, secure cookies, HTTPS, backups and process restart behavior.
- Verify configured PayPal credentials, callback URLs and a complete payment/capture flow.
- Verify real SMTP delivery and scheduled digest execution; local tests use the outbox/stubs.
- Check OAuth and 2FA with the deployment's providers, and visually spot-check Safari/iOS and Android.

These results establish local regression coverage, not a blanket guarantee that every production integration is ready. No production database or account was modified during this audit.

---

# Inbox + blog screen fit — 2026-09-12

## What changed

- **Leads inbox is now a window-sized shell.** Both panes take one height from
  `.lead-layout` (`--pane-h` = window height − 100px, floor 640px, cap 1060px)
  instead of the old `min(92vh, 980px)` block, which started ~380px down the
  page and was therefore taller than the space actually on screen. The chat
  thread is the only flexible block in the pane; the title line, the contact
  facts, the composer and the status/archive/delete line are all fixed height,
  so everything they do not use belongs to the conversation.
- **The contact facts became a compact strip** (`.lead-facts`) instead of a
  three-row `<table class="facts">`. Same labels, same `mailto:`/`tel:` links,
  roughly a quarter of the height — the difference goes to the chat.
- **The head above the inbox is slim** (`.leads-head`, `.leads-section`),
  scoped to this page only; every other page keeps its own head.
- **Stacked screens (≤900px) give the thread a long, uncapped run** of
  `min(62vh, 520px)` (`min(64vh, 480px)` ≤640px) instead of a 400–420px box
  with a `max-height` cap, so nothing is compressed into a second scrollbar.
- **Blog**: one roomy card column, a smaller article measure and tighter table
  cells ≤480px; `.blog-body .table-wrap` scrolls horizontally and seeded
  `<th>` cells wrap, so no article can push a phone page sideways.

## Verified locally

- `npm test`: all 29 suites pass.
- `npm run test:leads-fit`: 42 checks, including a height-budget audit that
  reads the pane expression, the thread floor and every declared fixed height
  back out of `app.css` and asserts the chat keeps at least 40% of the pane at
  window heights of 600, 668, 720, 768, 800, 900, 1080 and 1440px (272–692px of
  chat). Restoring the old geometry makes 5 of those 8 windows fail, so the
  audit is not vacuous.
- Real HTTP: the owner and inquirer panes render the facts strip with every
  contact detail and link, and `/blog`, `/blog/:slug` render their cards and
  prose shell.

## Not verified here

`npm run test:leads-fit:browser` measures the same guarantees as real geometry
(pane clipping, chat height, Send and the housekeeping line on screen, no
sideways page scroll) across 10 device viewports. **It did not run in this
session**: no Chromium is installed in the sandbox and the Playwright/CDN
download hosts are unreachable from it. Run it locally with
`npx playwright install chromium && npm run test:leads-fit:browser`, or point
`CHROMIUM_EXECUTABLE_PATH` at an existing browser. Visual spot-checks on
Safari/iOS and Android are still outstanding.

---

# Leads inbox — the reply box holds, the chat extends — 2026-09-12

## What changed

- **The reply box is the pane's floor, and now behaves like one.** Its textarea
  had a ceiling in script only (`autoSize` stops at 160px) — a hand-dragged
  one could still outgrow the pane and push Send out of it. `.lead-reply-form
  .input` now carries `max-height: 240px`, so the box can be made comfortable
  but the pane always pays for it.
- **The chat area is extendable at both ends.** On a short desktop window the
  thread floor gives way (`.lead-detail .lead-thread { min-height: 96px }`
  under 880px of height) instead of the pane growing a second scrollbar, so
  the conversation keeps everything above the composer and the composer stays
  on screen. One button in the pane header — `⤢ Full width`, `Esc` to release —
  extends the conversation over the whole window: the grid collapses to one
  column, the list steps aside, the pane measures `max(480px, 100dvh − 96px)`
  from the header stop to 12px above the bottom, and the corner grip stands
  down because there is nothing left to trade. Stacked screens do not offer it;
  print and a resize through 900px both hand the list back.
- **Nothing selected no longer fills the window.** The empty invitation is a
  compact `min-height: 208px` panel rather than a `--pane-h` white box beside
  a three-row list.
- **The page ends with the conversation.** The site's weekly-digest band —
  logo mark, copy, subscribe form — is skipped on this route (`hideNews` in
  `src/routes/dashboard.js`, the same escape hatch the maintenance page uses),
  and `.leads-section` bottom padding tightened from 3.5rem to 1.5rem. Every
  other page keeps the band.

## Kept exactly as it was

The thread still renders every message with day separators, mine/theirs sides
and escaped bodies; the composer, its counter, its inline refusal, the status
pill, `Update`, `Archive` and `Delete` still post from inside the one pinned
foot and return to the same filtered inbox view; the corner grip still
persists per browser; and with no stored size and no scroll the shipped
geometry still computes to the same pixels. `npm run test:leads-pane` (64
checks) and `npm run test:leads-fit` (42) pass unchanged, including their
default-identity proofs and their height budgets.

## Verified locally

- `npm test`: all 31 suites pass.
- `npm run test:leads-reply`: 54 checks — the band (present elsewhere, absent
  here), the focus control's markup and its order relative to the thread and
  Close, the stylesheet scoping above, a window-by-window budget audit read
  back out of `app.css` (at rest the thread keeps its full 220px floor; with
  the box dragged to its 240px ceiling the chat still stands and the foot is
  still inside the pane), and the shipped focus script run under `vm` against a
  stub DOM: click engages and parks, `Esc` releases, only `Esc` does, a stacked
  window refuses and a mid-focus resize clears, and a page with no open
  conversation runs the block as a no-op.

## Not verified here

No Chromium exists in this sandbox and the Playwright download hosts are
unreachable from it, so nothing here is a measured-pixels result: `npm run
test:leads-fit:browser` (and any visual check of focus mode, the dock and the
composer on Safari/iOS and Android) still needs one local run.

---

# Leads inbox — the reply box resizes by hand, the card grows with it — 2026-09-12

## What changed

- **The reply box has one floor and one ceiling, everywhere.** `.lead-reply-form
  .input` is `min-height: 80px; max-height: 300px; width: 100%; box-sizing:
  border-box; resize: vertical`. The short-window (56px) and stacked (76px)
  floors that used to override it are gone, so the field a member drags is the
  same field on every screen, and a sideways drag cannot happen at all.
- **A hand drag is kept, not undone.** `autoSize` reads the bounds back from
  `getComputedStyle`, and a height the member dragged to outranks the
  typed-text growth (which still stops at 160px): the box holds the dragged
  size, clamped to the same bounds, and the choice is kept for the tab under
  `fl.leadReply.h.<thread>` so it comes back with the page after a send. An
  inline width left behind by a drag is dropped — the column owns the width.
- **The card grows instead of clipping.** `.lead-detail` is `height: auto` with
  `min-height: var(--lead-user-h, var(--pane-h, …))`: exactly the window at
  rest, taller when the composer needs it, with `Send message` always inside
  it. The thread's zero flex basis (`flex: 1 1 0%`, desktop) keeps a long
  conversation on its own scrollbar so it can never stretch the card; stacked
  screens drop the floor and stay content-height.
- **The facts above the box read as two lines.** Email (and the phone, when
  there is one) on the first, `Looking for` on the line below it (`.lf-look`).

## Kept exactly as it was

The pane's sticky top, the seam grip and its persisted size, the dock, the
pinned foot, the thread's bubbles and day separators, the composer's counter
and inline refusal, and the status/archive/delete line — with no stored size
and no drag the card computes to the same pixels it did before.

## Verified locally

- `npm test`: all 31 suites pass.
- `npm run test:leads-chat`: 113 checks, including 8 new ones over the shipped
  composer script run against a stub DOM whose box has an inline style and
  whose `getComputedStyle` answers with the bounds read out of `app.css`:
  the box opens at the floor, typed text grows it only to the script's cap, a
  dragged height survives the next keystroke and the send after it, drags past
  the ceiling and below the floor are clamped, and a sideways drag is dropped.
- `npm run test:leads-reply`: 35 checks — the bounds are declared once, with no
  leftover per-screen floors, and the window-by-window budget audit (read back
  out of `app.css`) shows the card at rest still leaving the thread its full
  220px floor from a 640px window up, and, with the box dragged to 300px, the
  card growing by no more than the box gained.
- `npm run test:leads-pane`: 64 checks — the floor model, the thread's zero
  basis on desktop and its flexible fill everywhere else, the clamp/dock
  geometry and the seam drag.
- `npm run test:leads-fit`: 43 checks — the two-line facts strip in the served
  markup (owner and inquirer) and its rule in the stylesheet.
- Served page and stylesheet checked over HTTP with the preview seed
  (`LEADS_INBOX_PREVIEW=1`): `lf lf-look` renders under the contact line and
  the composer rule ships 80/300.

## Not verified here

No Chromium exists in this sandbox and the Playwright download hosts are
unreachable from it, so no measured pixels: a real drag of the reply handle,
the card growing past a short window, and the docked pane scrolling with Send
pinned still need one local run of `npm run test:leads-pane:browser` (and a
look on Safari/iOS and Android).
