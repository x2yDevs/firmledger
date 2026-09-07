/**
 * FirmLedger — indexing health.
 *
 *   node tests/indexing-health.test.js
 *
 * Nothing here is about features — it is about what a search crawler meets:
 * every check guards something that, broken, shows up in Search Console as
 * "Page fetch failed", "Duplicate without user-selected canonical",
 * "Crawl anomaly" or "Invalid URL" and quietly keeps pages out of the index.
 *
 *   A. One URL per page: /about/ 301s onto /about (root "/" untouched),
 *      query strings ride along, POSTs are never redirected.
 *   B. One host per site: www.<canonical> 301s onto the apex origin.
 *   C. Sitemap hygiene: index + sub-sitemaps are well-formed, every <loc> is
 *      absolute, no fragment (#) URLs, no fabricated "today" lastmod, and
 *      every URL in static/listings/categories sitemaps answers HTTP 200.
 *   D. robots.txt keeps welcoming crawlers (no accidental blanket Disallow).
 *   E. Rate limiting never blocks indexing:
 *      - robots.txt / sitemaps / feed.xml / IndexNow key stay 200 even with
 *        the scrape bucket exhausted;
 *      - the 429 page carries Retry-After;
 *      - a spoofed Googlebot UA does NOT earn the free pass (reverse DNS
 *        cannot verify it) while a genuinely verified bot does — proven
 *        against a stubbed DNS resolver.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-indexing-health-'));
const PORT = 4900 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'https://firmledger.co.ke';

/* This process touches src/db.js too (allow-list toggle, IndexNow key) — it
   must resolve to the SAME data dir as the spawned server, never ./data. */
process.env.FIRMLEDGER_DATA_DIR = dataDir;

const env = {
  ...process.env,
  FIRMLEDGER_DATA_DIR: dataDir,
  PORT: String(PORT),
  BASE_URL: ORIGIN,
  FORCE_INDEXABLE: '1',
  ADMIN_SECRET: 'test-secret',
};

/* Seed listings (and allow-list the loopback IP so sections A–D can crawl
   freely; section E removes it to test the limiter itself). */
const seed = `
const { db } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
const ins = db.prepare(
  \`INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,city,status,featured,confidence)
   VALUES (?,?,?,?,'company','Fintech','https://ih.example','hi@ih.example','Kenya','Nairobi','approved',0,72)\`);
for (let i = 1; i <= 12; i++) {
  ins.run('ih-co-' + i, 'IH Co ' + i, 'Tagline ' + i, 'Seeded listing ' + i + ' for the indexing-health test.');
}
db.prepare("INSERT INTO spam_ip (value, kind, note) VALUES ('127.0.0.1', 'allow', 'indexing-health test crawler')").run();
console.log('seeded');
`;
const seedRes = spawnSync(process.execPath, ['-e', seed], { cwd: ROOT, env, encoding: 'utf8' });
if (seedRes.status !== 0) {
  console.error('SEED FAILED:\n' + (seedRes.stderr || '').slice(0, 2000));
  process.exit(1);
}

const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/about`); if (r.status === 200) return true; } catch {}
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
const finish = () => {
  console.log(`\n================================================================\nchecks passed: ${passed}   failed: ${failures.length}`);
  if (failures.length) console.log(failures.map((f) => '  ✗ ' + f).join('\n'));
  server.kill('SIGKILL');
  process.exit(failures.length ? 1 : 0);
};

async function collectSitemaps() {
  const urls = [];
  const idxBody = await (await fetch(`${BASE}/sitemap.xml`)).text();
  for (const m of idxBody.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const subBody = await (await fetch(m[1].replace(ORIGIN, BASE))).text();
    for (const mm of subBody.matchAll(/<loc>([^<]+)<\/loc>/g)) urls.push(mm[1]);
  }
  return { idxBody, urls };
}

/* fetch() (undici) refuses to override the Host header — raw request for the
   host-canonicalisation checks. */
const http = require('http');
function rawGet(pathWithQs, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: pathWithQs, method: 'GET', headers: { host: hostHeader } },
      (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location || '' }); }
    );
    req.on('error', reject);
    req.end();
  });
}

(async function main() {
  console.log('FirmLedger indexing-health test\n');
  if (!(await waitUp())) {
    console.log('server did not start:\n' + serverLog.slice(-2000));
    server.kill('SIGKILL');
    process.exit(1);
  }

  /* ---------- A. one URL per page ---------- */
  console.log('A. trailing-slash canonicalisation');
  {
    const r = await fetch(`${BASE}/about/`, { redirect: 'manual' });
    check('/about/ answers 301', r.status === 301, `got ${r.status}`);
    check('/about/ redirects to /about', (r.headers.get('location') || '') === '/about', r.headers.get('location'));
  }
  {
    const r = await fetch(`${BASE}/directory/c/fintech/?sort=newest`, { redirect: 'manual' });
    check('query string rides along on the 301',
      r.status === 301 && r.headers.get('location') === '/directory/c/fintech?sort=newest',
      `${r.status} → ${r.headers.get('location')}`);
  }
  {
    const r = await fetch(`${BASE}/listing/ih-co-1/`, { redirect: 'manual' });
    check('/listing/x/ answers 301 onto /listing/x',
      r.status === 301 && r.headers.get('location') === '/listing/ih-co-1',
      `${r.status} → ${r.headers.get('location')}`);
  }
  {
    const r = await fetch(`${BASE}/`, { redirect: 'manual' });
    check('root "/" stays 200 (never redirected)', r.status === 200, `got ${r.status}`);
  }
  {
    const r = await fetch(`${BASE}/robots.txt`, { redirect: 'manual' });
    check('robots.txt is served, not slash-redirected', r.status === 200, `got ${r.status}`);
  }

  /* ---------- B. one host per site ---------- */
  console.log('B. www → apex canonicalisation');
  {
    const r = await rawGet('/pricing?x=1', 'www.firmledger.co.ke');
    check('www host answers 301',
      r.status === 301 && r.location === `${ORIGIN}/pricing?x=1`,
      `${r.status} → ${r.location}`);
  }
  {
    const r = await rawGet('/listing/ih-co-2', 'firmledger.onrender.com');
    check('onrender host still 301s to the apex',
      r.status === 301 && r.location === `${ORIGIN}/listing/ih-co-2`,
      `${r.status} → ${r.location}`);
  }
  {
    const r = await fetch(`${BASE}/about`, { redirect: 'manual' });
    check('the apex itself never redirects', r.status === 200, `got ${r.status}`);
  }

  /* ---------- C. sitemap hygiene ---------- */
  console.log('C. sitemap hygiene');
  const { idxBody, urls } = await collectSitemaps();
  check('sitemap index lists the four sub-sitemaps', idxBody.includes('/sitemaps/static.xml') && idxBody.includes('/sitemaps/listings.xml')
    && idxBody.includes('/sitemaps/categories.xml') && idxBody.includes('/sitemaps/locations.xml'));
  {
    const staticBlock = idxBody.split('<sitemap>').find((s) => s.includes('/sitemaps/static.xml')) || '';
    check('static.xml carries no fabricated lastmod', !staticBlock.includes('<lastmod>'), staticBlock.trim().slice(0, 120));
  }
  check('every <loc> is absolute on the site origin', urls.length > 0 && urls.every((u) => u.startsWith(ORIGIN + '/')), `${urls.filter((u) => !u.startsWith(ORIGIN + '/')).length} relative`);
  check('no fragment (#) URLs in any sitemap', urls.every((u) => !u.includes('#')), urls.filter((u) => u.includes('#')).slice(0, 3).join(' '));
  check('the careers page itself is in the sitemap', urls.some((u) => u === `${ORIGIN}/careers`));
  {
    let bad = [];
    for (const u of urls) {
      const r = await fetch(u.replace(ORIGIN, BASE), { redirect: 'manual' });
      if (r.status !== 200) bad.push(`${u} → ${r.status}`);
    }
    check(`every sitemap URL answers 200 (${urls.length} urls)`, bad.length === 0, bad.slice(0, 5).join(', '));
  }
  {
    const r = await fetch(`${BASE}/sitemap.xml`);
    check('sitemap content-type is XML', (r.headers.get('content-type') || '').includes('xml'), r.headers.get('content-type'));
  }

  /* ---------- D. robots.txt ---------- */
  console.log('D. robots.txt');
  {
    const body = await (await fetch(`${BASE}/robots.txt`)).text();
    check('robots.txt does not blanket-Disallow the site', !/^User-agent: \*\s*\nDisallow: \/\s*$/m.test(body.replace(/\r/g, '')));
    check('robots.txt still points at the sitemap', body.includes(`Sitemap: ${ORIGIN}/sitemap.xml`));
    check('robots.txt keeps the private paths out', /Disallow: \/dashboard/.test(body) && /Disallow: \/admin3119Musa/.test(body));
  }

  /* ---------- E. rate limiting never blocks indexing ---------- */
  console.log('E. crawler vs rate limiter');
  const { db } = require(path.join(ROOT, 'src/db.js'));
  db.prepare("DELETE FROM spam_ip WHERE value='127.0.0.1'").run(); // step out of the allow list

  /* Exhaust the anonymous scrape bucket (default 180/min) on a cheap page. */
  let saw429 = false;
  let retryAfter = '';
  for (let i = 0; i < 200 && !saw429; i++) {
    const r = await fetch(`${BASE}/login`, { redirect: 'manual' });
    if (r.status === 429) { saw429 = true; retryAfter = r.headers.get('retry-after') || ''; break; }
  }
  check('an anonymous burst eventually meets 429', saw429);
  check('the 429 carries Retry-After', saw429 && /^\d+$/.test(retryAfter), JSON.stringify(retryAfter));

  {
    const r = await fetch(`${BASE}/login`, { redirect: 'manual' });
    check('throttled client stays throttled', r.status === 429, `got ${r.status}`);
  }
  {
    const r = await fetch(`${BASE}/robots.txt`);
    check('robots.txt is 200 even mid-throttle', r.status === 200, `got ${r.status}`);
  }
  {
    const r = await fetch(`${BASE}/sitemap.xml`);
    check('sitemap.xml is 200 even mid-throttle', r.status === 200, `got ${r.status}`);
  }
  {
    const r = await fetch(`${BASE}/sitemaps/listings.xml`);
    check('sub-sitemaps are 200 even mid-throttle', r.status === 200, `got ${r.status}`);
  }
  {
    const r = await fetch(`${BASE}/feed.xml`);
    check('feed.xml is 200 even mid-throttle', r.status === 200, `got ${r.status}`);
  }
  {
    const key = require(path.join(ROOT, 'src/lib/indexing.js')).getIndexNowKey();
    const r = await fetch(`${BASE}/${key}.txt`);
    check('the IndexNow key file is 200 even mid-throttle', r.status === 200, `got ${r.status} for /${key}.txt`);
  }
  {
    /* Spoofed Googlebot: reverse DNS for 127.0.0.1 cannot verify, so the
       request must fall back to the normal limits — no free pass for fakes. */
    const r = await fetch(`${BASE}/login`, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' } });
    check('a spoofed Googlebot UA gets no free pass', r.status === 429, `got ${r.status}`);
  }

  /* verifySearchBot against a stubbed resolver — the genuine-bot path. */
  {
    const dns = require('dns');
    const spam = require(path.join(ROOT, 'src/lib/spam.js'));
    const origReverse = dns.promises.reverse;
    const origResolve = dns.promises.resolve;
    dns.promises.reverse = (ip) => Promise.resolve(ip === '66.249.66.1' ? ['crawl-66-249-66-1.googlebot.com'] : ['something-else.example.com']);
    dns.promises.resolve = (host) => Promise.resolve(host === 'crawl-66-249-66-1.googlebot.com' ? ['66.249.66.1'] : ['203.0.113.9']);
    const t = await spam.verifySearchBot('66.249.66.1').catch(() => false);
    check('reverse+forward DNS match verifies a real Googlebot IP', t === true);
    const f = await spam.verifySearchBot('66.249.66.2').catch(() => false);
    check('an IP whose reverse DNS is not a bot domain is not verified', f === false);
    dns.promises.reverse = () => Promise.reject(new Error('no DNS'));
    const e = await spam.verifySearchBot('66.249.66.3').catch(() => false);
    check('a failing resolver never verifies (fails closed)', e === false);
    dns.promises.reverse = origReverse;
    dns.promises.resolve = origResolve;
  }
  {
    const spam = require(path.join(ROOT, 'src/lib/spam.js'));
    check('SEO files are recognised by the gate', spam.isSeoFilePath('/robots.txt') && spam.isSeoFilePath('/sitemap.xml')
      && spam.isSeoFilePath('/sitemaps/static.xml') && spam.isSeoFilePath('/feed.xml') && spam.isSeoFilePath('/' + 'a'.repeat(32) + '.txt'));
    check('ordinary pages are not treated as SEO files', !spam.isSeoFilePath('/about') && !spam.isSeoFilePath('/directory'));
  }

  finish();
})().catch((e) => {
  console.error('test crashed:', e);
  server.kill('SIGKILL');
  process.exit(1);
});
