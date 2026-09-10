/**
 * FirmLedger test runner — `npm test`.
 *
 * Runs every suite in order and prints one summary. Each suite is a plain Node
 * script (no test framework, no dev dependencies) that exits non-zero on failure:
 *
 *   ai-tools     every admin action the AI assistant can take, executed for real
 *                against a throwaway database and verified by DB state.
 *   ai-assistant the rule-based admin assistant (no model, no API): intent
 *                understanding, slot filling, pronoun memory, disambiguation,
 *                confirm/cancel flows, audit logging and rule-based
 *                auto-moderation actually moving listing state.
 *   ai-e2e       every console action driven through the chat endpoint in
 *                plain language — proposal, confirm, execute — and verified by
 *                the resulting database rows (147 checks).
 *   ai-http      the real HTTP surface: session + CSRF, the chat/execute/cancel
 *                contract, hostile input (XSS, forged context markers, SQL-ish
 *                text, malformed JSON) never executing or 500ing, audit rows,
 *                and latency/concurrency budgets.
 *   ai-areas     production readiness per console area: Search, Inbox,
 *                Listings, News, Categories, Claims, Users, Plan offers,
 *                Pricing, Advertising, Careers, Status, Promos, Protection,
 *                Health, Removals, Tickets, Email, Blog, AI Playground,
 *                Settings and Maintenance — each driven through the chat
 *                pipeline and verified in the database, plus the
 *                conversational layer: time-of-day greetings (morning /
 *                afternoon / evening / night), clock questions, small talk,
 *                and every suggested menu command parsing.
 *   backup       .firmledger round trip — users, all listings + configuration.
 *   mail-providers Emitlo/Maileroo/Mailjet removed from presets and stored
 *                accounts; Admin → Email pins a bulk send to one provider
 *                (grouped picker, remembered choice, paused/unknown fallback).
 *   admin-pages  every admin page renders and its long list scrolls in place.
   trial-reminders  free-trial countdown ladder: half-way, 3-day and final-day
                reminders plus the trial-ended notice — each an email AND an
                in-app notification, once per trial, no double sends.
   tech-refresh admin technology-radar maintenance: one listing, a selection,
                a filtered view, everything stale or the whole directory —
                counters, the single-run lock, cancellation and CSRF, offline.
   news-upkeep  listing news: the accuracy gate (name or domain or nothing),
                member submissions held for moderation, console moderation and
                hand-written stories, background sweeps and the hourly
                upkeep schedule that refreshes tech and news on its own.
   admin-2fa    the admin sign-in chain end to end, nothing stubbed: secret ->
                emailed OTP (admin@firmledger.co.ke, codes harvested from the
                real mail outbox) -> authenticator/recovery, QR scanned exactly
                once, enrollment surviving restarts, throttles and resend
                cooldowns, the OTP inbox editable in Settings.
   indexing     Google Indexing API (stubbed) + the homepage featured rail:
                URL_UPDATED pings, the never-ping-twice ledger, the 200/day
                quota and the admin console wired to all of it.
   health       what a search crawler meets: one URL per page (trailing-slash
                301s), one host per site (www → apex), sitemap hygiene (no
                fragment URLs, no fake lastmod, every loc answers 200) and a
                rate limiter that never blocks robots.txt, sitemaps, the feed,
                the IndexNow key or a reverse-DNS-verified search bot.
   status       /status accuracy: no false "Major Outage" without a monitor
                API key, real failures walk the outage ladder and heal,
                and a poisoned state self-heals on the live server.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const suites = [
  ['AI admin tools', 'ai-tools.test.js'],
  ['AI admin assistant', 'ai-assistant.test.js'],
  ['AI assistant end-to-end (every admin action via chat)', 'ai-e2e.test.js'],
  ['AI assistant HTTP / production hardening', 'ai-http.test.js'],
  ['AI Playground — every console area + conversation & clock', 'ai-areas.test.js'],
  ['Maintenance holding page + animated error pages', 'maintenance-page.test.js'],
  ['Backup round trip', 'backup.test.js'],
  ['Mail providers', 'mail-providers.test.js'],
  ['Admin pages', 'admin-pages.test.js'],
  ['Free trial reminders', 'trial-reminders.test.js'],
  ['Admin technology refresh', 'admin-tech-refresh.test.js'],
  ['Listing news & upkeep', 'news-upkeep.test.js'],
  ['Admin 2FA chain', 'admin-2fa.test.js'],
  ['API surface & discovery', 'api.test.js'],
  ['Google Indexing + featured rail', 'google-indexing.test.js'],
  ['Indexing health (crawl view)', 'indexing-health.test.js'],
  ['Robots & Auth OAuth', 'robots-auth.test.js'],
  ['Status monitor accuracy', 'status-monitor.test.js'],
];

const results = [];
for (const [label, file] of suites) {
  console.log(`\n${'━'.repeat(70)}\n▶ ${label}  (tests/${file})\n${'━'.repeat(70)}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  results.push({ label, ok: r.status === 0 });
}

console.log(`\n${'═'.repeat(70)}\nSUMMARY`);
for (const r of results) console.log(`  ${r.ok ? '✓ pass' : '✗ FAIL'}  ${r.label}`);
console.log('═'.repeat(70));
process.exit(results.every((r) => r.ok) ? 0 : 1);
