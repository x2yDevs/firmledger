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
