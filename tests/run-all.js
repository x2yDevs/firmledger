/**
 * FirmLedger test runner — `npm test`.
 *
 * Runs every suite in order and prints one summary. Each suite is a plain Node
 * script (no test framework, no dev dependencies) that exits non-zero on failure:
 *
 *   ai-tools     every admin action the AI assistant can take, executed for real
 *                against a throwaway database and verified by DB state.
 *   ai-agent     the assistant's agent loop: chaining, batched confirmation,
 *                cancellation and honest failure reporting (Groq stubbed).
 *   backup       .firmledger round trip — users, all listings + configuration.
 *   admin-pages  every admin page renders and its long list scrolls in place.
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
  ['AI agent loop', 'ai-agent.test.js'],
  ['AI providers & console', 'ai-providers.test.js'],
  ['Backup round trip', 'backup.test.js'],
  ['Admin pages', 'admin-pages.test.js'],
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
