/**
 * FirmLedger — robots.txt and registration OAuth test.
 *
 *   node tests/robots-auth.test.js
 *
 * Tests:
 *   1. /robots.txt allows /login, /search, /claim, /register while disallowing
 *      private paths (/dashboard, /admin3119Musa, /removal/, /forgot) and
 *      blocking AI training scrapers.
 *   2. /register renders Google and LinkedIn OAuth buttons when configured,
 *      supporting ?next= forwarding and validation error handling.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-robots-auth-'));
const PORT = 4600 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;

const env = {
  ...process.env,
  FIRMLEDGER_DATA_DIR: dataDir,
  PORT: String(PORT),
  BASE_URL: 'https://firmledger.co.ke', // public origin to bypass staging guard in robotsTxt
  FORCE_INDEXABLE: '1',
  ADMIN_SECRET: 'test-secret',
  GOOGLE_CLIENT_ID: 'google-client-id-test',
  GOOGLE_CLIENT_SECRET: 'google-client-secret-test',
  LINKEDIN_CLIENT_ID: 'linkedin-client-id-test',
  LINKEDIN_CLIENT_SECRET: 'linkedin-client-secret-test',
};

const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`).catch(() => fetch(BASE));
      if (res) return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return false;
}

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

(async function main() {
  console.log('FirmLedger robots.txt & Registration OAuth test\n');
  const up = await waitForServer();
  if (!up) {
    console.log('server did not start:\n' + serverLog.slice(-2000));
    server.kill('SIGKILL');
    process.exit(1);
  }

  // 1. Test robots.txt
  console.log('A. robots.txt validation');
  const robotsRes = await fetch(`${BASE}/robots.txt`);
  check('robots.txt returns HTTP 200', robotsRes.status === 200);
  const robotsTxt = await robotsRes.text();

  // Check allowed paths
  check('robots.txt does not disallow /login', !/Disallow:\s*\/login\b/.test(robotsTxt));
  check('robots.txt does not disallow /search', !/Disallow:\s*\/search\b/.test(robotsTxt));
  check('robots.txt does not disallow /claim', !/Disallow:\s*\/claim\b/.test(robotsTxt));
  check('robots.txt does not disallow /register', !/Disallow:\s*\/register\b/.test(robotsTxt));

  // Check disallowed paths
  check('robots.txt disallows /dashboard', /Disallow:\s*\/dashboard\b/.test(robotsTxt));
  check('robots.txt disallows /admin3119Musa', /Disallow:\s*\/admin3119Musa\b/.test(robotsTxt));
  check('robots.txt disallows /removal/', /Disallow:\s*\/removal\//.test(robotsTxt));
  check('robots.txt disallows /forgot', /Disallow:\s*\/forgot\b/.test(robotsTxt));

  // Check AI blocks and sitemap
  check('robots.txt blocks GPTBot', /User-agent:\s*GPTBot\s*\nDisallow:\s*\//.test(robotsTxt));
  check('robots.txt blocks ClaudeBot', /User-agent:\s*ClaudeBot\s*\nDisallow:\s*\//.test(robotsTxt));
  check('robots.txt includes Sitemap', /Sitemap:\s*https:\/\/firmledger\.co\.ke\/sitemap\.xml/.test(robotsTxt));

  // 2. Test /register OAuth buttons
  console.log('\nB. /register OAuth buttons');
  const regRes = await fetch(`${BASE}/register?next=/dashboard/listings/new`);
  check('/register returns HTTP 200', regRes.status === 200);
  const regHtml = await regRes.text();

  check('/register renders Google OAuth button', /href="\/auth\/google\?next=%2Fdashboard%2Flistings%2Fnew"/.test(regHtml) && /Continue with Google/.test(regHtml));
  check('/register renders LinkedIn OAuth button', /href="\/auth\/linkedin\?next=%2Fdashboard%2Flistings%2Fnew"/.test(regHtml) && /Continue with LinkedIn/.test(regHtml));
  check('/register renders oauth divider', /oauth-divider/.test(regHtml));
  check('/register renders standard email registration form', /action="\/register"/.test(regHtml) && /name="password_confirm"/.test(regHtml));
  check('/register preserves next in hidden input', /<input type="hidden" name="next" value="\/dashboard\/listings\/new">/.test(regHtml));

  // 3. Test /login OAuth buttons for symmetry
  console.log('\nC. /login OAuth buttons symmetry');
  const loginRes = await fetch(`${BASE}/login?next=/dashboard/listings/new`);
  check('/login returns HTTP 200', loginRes.status === 200);
  const loginHtml = await loginRes.text();
  check('/login renders Google OAuth button', /href="\/auth\/google\?next=%2Fdashboard%2Flistings%2Fnew"/.test(loginHtml) && /Continue with Google/.test(loginHtml));
  check('/login renders LinkedIn OAuth button', /href="\/auth\/linkedin\?next=%2Fdashboard%2Flistings%2Fnew"/.test(loginHtml) && /Continue with LinkedIn/.test(loginHtml));

  /* ---- 4. Indexing: /search (and its ?q= URLs) must be indexable and
     self-canonical; the private half must stay noindex. Google Search Console
     reported "noindex detected" plus a /register canonical on /search — these
     checks lock the fix in. */
  console.log('\nD. /search indexing + canonical');
  const robotsMeta = (html) => (html.match(/<meta name="robots" content="([^"]*)"/) || [])[1] || '';
  const canonicalOf = (html) => (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1] || '';

  const searchRes = await fetch(`${BASE}/search`);
  check('/search returns HTTP 200', searchRes.status === 200);
  check('/search sends no noindex X-Robots-Tag header', !/noindex/i.test(searchRes.headers.get('x-robots-tag') || ''));
  const searchHtml = await searchRes.text();
  check('/search robots meta permits indexing', /^index,\s*follow$/i.test(robotsMeta(searchHtml)), `got "${robotsMeta(searchHtml)}"`);
  check('/search has no noindex in its robots meta', !/noindex/i.test(robotsMeta(searchHtml)));
  check('/search canonical is /search', canonicalOf(searchHtml) === 'https://firmledger.co.ke/search', `got "${canonicalOf(searchHtml)}"`);
  check('/search canonical is NOT /register', canonicalOf(searchHtml) !== 'https://firmledger.co.ke/register');

  for (const q of ['fintech', 'accounting', 'technology']) {
    const r = await fetch(`${BASE}/search?q=${q}`);
    const html = await r.text();
    const canon = canonicalOf(html);
    check(`/search?q=${q} returns HTTP 200`, r.status === 200);
    check(`/search?q=${q} is indexable`, !/noindex/i.test(robotsMeta(html)), `got "${robotsMeta(html)}"`);
    check(`/search?q=${q} is not canonicalised to /register`, canon !== 'https://firmledger.co.ke/register', `got "${canon}"`);
    /* A query with hits self-references; a query with none folds back to /search
       (no thin duplicates) — never to some unrelated page. */
    check(`/search?q=${q} canonical is self or /search`,
      canon === `https://firmledger.co.ke/search?q=${q}` || canon === 'https://firmledger.co.ke/search', `got "${canon}"`);
    check(`/search?q=${q} og:url matches canonical`, html.includes(`<meta property="og:url" content="${canon}">`));
  }

  /* A query that matches seeded content must self-canonicalise. */
  const hitHtml = await (await fetch(`${BASE}/search?q=verification`)).text();
  check('/search?q=verification self-canonicalises when it has results',
    canonicalOf(hitHtml) === 'https://firmledger.co.ke/search?q=verification', `got "${canonicalOf(hitHtml)}"`);

  const staticMap = await (await fetch(`${BASE}/sitemaps/static.xml`)).text();
  check('/search is listed in the static sitemap', /<loc>https:\/\/firmledger\.co\.ke\/search<\/loc>/.test(staticMap));

  console.log('\nE. /claim, /login and /register stay indexable');
  const claimHtml = await (await fetch(`${BASE}/claim`)).text();
  check('/claim is indexable', !/noindex/i.test(robotsMeta(claimHtml)), `got "${robotsMeta(claimHtml)}"`);
  check('/login is indexable', !/noindex/i.test(robotsMeta(loginHtml)), `got "${robotsMeta(loginHtml)}"`);
  check('/login canonical is /login', canonicalOf(loginHtml) === 'https://firmledger.co.ke/login');
  check('/register is indexable', !/noindex/i.test(robotsMeta(regHtml)), `got "${robotsMeta(regHtml)}"`);
  check('/register canonical is /register', canonicalOf(regHtml) === 'https://firmledger.co.ke/register');

  console.log('\nF. Private areas and AI rules unchanged');
  const adminHtml = await (await fetch(`${BASE}/admin3119Musa`)).text();
  const forgotHtml = await (await fetch(`${BASE}/forgot`)).text();
  check('/admin3119Musa stays noindex', /noindex/i.test(robotsMeta(adminHtml)));
  check('/forgot stays noindex', /noindex/i.test(robotsMeta(forgotHtml)));
  check('Google-Extended still blocked', /User-agent:\s*Google-Extended\s*\nDisallow:\s*\//.test(robotsTxt));
  check('Content-Signal line unchanged', /Content-Signal: search=yes, ai-train=no, use=reference/.test(robotsTxt));

  console.log(`\n${'='.repeat(64)}`);
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  failures.forEach((f) => console.log('  • ' + f));
  if (failures.length) console.log('\nserver log tail:\n' + serverLog.slice(-1500));
  console.log('='.repeat(64));

  server.kill('SIGKILL');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
})();
