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
   indexing     Google Indexing API (stubbed) + the homepage featured rail:
                URL_UPDATED pings, the never-ping-twice ledger, the 200/day
                quota and the admin console wired to all of it.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const suites = [
  ['AI admin tools', 'ai-tools.test.js'],
  ['AI agent loop', 'ai-agent.test.js'],
  ['Backup round trip', 'backup.test.js'],
  ['Admin pages', 'admin-pages.test.js'],
  ['API surface & discovery', 'api.test.js'],
  ['Google Indexing + featured rail', 'google-indexing.test.js'],
  ['Robots & Auth OAuth', 'robots-auth.test.js'],
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
