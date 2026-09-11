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
