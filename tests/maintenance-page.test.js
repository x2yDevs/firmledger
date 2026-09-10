/**
 * FirmLedger — maintenance holding page + animated error pages, for real.
 *
 *   node tests/maintenance-page.test.js
 *
 * Production-readiness gate for the two pages a visitor meets when things are
 * not “normal”:
 *
 *   • the maintenance holding page — flipped on by the admin personally (the
 *     real Protection form POST) and by the AI assistant in plain language
 *     (chat → proposal → confirm), every public page must answer 503 with the
 *     admin’s own custom title / message / ETA, full FirmLedger design tokens,
 *     the animated stage (grid, glows, scan, ring, progress), noindex +
 *     Retry-After, and the auto-reload poller — while /status, static assets,
 *     the public API and the whole admin console stay reachable.
 *   • the animated 404/500 error page — per-digit drop-in, ledger entry chip,
 *     “Not found” stamp, blinking caret, three CTAs, full site chrome; the 500
 *     branch is rendered through the real EJS view as well.
 *
 * Nothing is mocked: a real server is booted on a scratch database, the real
 * chat pipeline drives the AI, and every claim is verified against the DB,
 * the audit log and the served HTML.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = __dirname === '.' ? process.cwd() : path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-maintpage-'));
const PORT = 5600 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;
const AI = `${BASE}/admin3119Musa/ai`;

const env = {
  ...process.env,
  FIRMLEDGER_DATA_DIR: dataDir,
  PORT: String(PORT),
  BASE_URL: BASE,
  ADMIN_SECRET: 'maint-page-secret',
  SMTP_URL: '',
  STATUS_UPDATE_INTERVAL: '3600',
};

const adminToken = 'maint' + crypto.randomBytes(16).toString('hex');
const adminCsrf = crypto.randomBytes(12).toString('hex');
const memberToken = 'member' + crypto.randomBytes(16).toString('hex');

/* Custom copy the admin keeps (the whole point of the feature). */
const CUSTOM = {
  title: 'Ledger vault upgrade',
  message: 'We are rotating our secure ledger vault tonight. Every record is safe — the directory returns shortly.',
  eta: 'tonight at 21:00 EAT',
};
const AI_CUSTOM = {
  title: 'Search index rebuild',
  message: 'We are rebuilding our search index for faster company lookups. Every listing is safe.',
  eta: 'tonight 21:00 EAT',
};

/* ------------------------------------------------------------- fixtures */
execFileSync(process.execPath, ['-e', `
process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(dataDir)};
const { db } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
const run = (sql, ...p) => db.prepare(sql).run(...p);
const uid = run("INSERT INTO users (email,password_hash,name,plan) VALUES ('keeper@example.com','x','Kip Keeper','free')").lastInsertRowid;
run("INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,status,owner_user_id) VALUES ('apex-fintech','Apex Fintech','Ledgers','Apex Fintech builds reconciliation ledgers for Kenyan fintechs since 2018.','company','Technology','https://apex.co.ke','hi@apex.co.ke','Kenya','approved',?)", uid);
run("INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,status,owner_user_id) VALUES ('ghost-co','Ghost Co','x','Ghost Co must never render; it only feeds the 404 branch.','company','Technology','https://ghost.co.ke','hi@ghost.co.ke','Kenya','pending',?)", uid);
run("INSERT INTO sessions (token,user_id,csrf,kind,expires_at) VALUES (?,NULL,?,'admin', datetime('now','+1 day'))", ${JSON.stringify(adminToken)}, ${JSON.stringify(adminCsrf)});
run("INSERT INTO sessions (token,user_id,csrf,kind,expires_at) VALUES (?,?,'membercsrf','user', datetime('now','+1 day'))", ${JSON.stringify(memberToken)}, uid);
`], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });

const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const adminJson = { cookie: `fl_admin=${adminToken}`, 'x-csrf-token': adminCsrf, 'content-type': 'application/json', accept: 'application/json' };
async function postJson(url, body, headers = adminJson) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json, headers: res.headers };
}
async function postForm(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: headers || { cookie: `fl_admin=${adminToken}`, 'x-csrf-token': adminCsrf, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}
async function get(url, headers) {
  const res = await fetch(url, { headers, redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}
const strip = (s) => String(s || '').replace(/\u2063ctx:[\s\S]*?\u2063/g, '').trim();

function dbq(sql) {
  return JSON.parse(execFileSync(process.execPath, ['-e', `
process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(dataDir)};
const { db } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
console.log(JSON.stringify(db.prepare(${JSON.stringify(sql)}).all()));
`], { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop());
}

function holdingPageChecks(html, label, custom) {
  const c = custom || CUSTOM;
  check(`${label}: 503 with the custom title in <h1>`, /class="maint-title"/.test(html) && html.includes(c.title), html.match(/<h1[^>]*>([^<]*)</)?.[1]);
  check(`${label}: custom message kept verbatim`, html.includes(c.message));
  check(`${label}: ETA chip with clock`, /class="maint-eta"/.test(html) && html.includes('Expected back:') && html.includes(c.eta));
  check(`${label}: animated stage (grid, glows, scan)`, /maint-grid/.test(html) && /maint-glow maint-glow-a/.test(html) && /maint-glow maint-glow-b/.test(html) && /maint-scan/.test(html));
  check(`${label}: logo inside the rotating rings`, /maint-ring/.test(html) && /\/assets\/logo-white\.png/.test(html) && /maint-logo/.test(html));
  check(`${label}: typing-dots kicker + live dot`, /maint-kdot/.test(html) && /maint-dots/.test(html) && /Scheduled maintenance/.test(html));
  check(`${label}: indeterminate progress bar`, /maint-bar/.test(html) && /Applying the update/.test(html));
  check(`${label}: auto-reload poller present`, /maintAuto/.test(html) && /Auto-refreshing/.test(html) && /visibilitychange/.test(html));
  check(`${label}: links to live status only (standalone page)`, /href="\/status"/.test(html) && !/href="\/directory"/.test(html) && !/href="\/pricing"/.test(html));
  check(`${label}: brand footer strip`, /maint-foot/.test(html) && /the business record layer/.test(html));
}

(async function main() {
  console.log('FirmLedger — maintenance holding page + animated error pages\n');
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(BASE + '/', { redirect: 'manual' }); up = r.status > 0; } catch { await sleep(250); } }
  check('server boots', up, serverLog.slice(-400));
  if (!up) { server.kill(); process.exit(1); }

  /* ================================================= 1. site live, animated 404 */
  console.log('\n1 · Site live, animated 404');
  let r = await get(BASE + '/');
  check('home renders 200 while maintenance is off', r.status === 200 && /FirmLedger/.test(r.text), String(r.status));
  r = await get(BASE + '/directory');
  check('directory renders 200', r.status === 200, String(r.status));

  r = await get(BASE + '/no-such-page');
  check('404 status served', r.status === 404, String(r.status));
  check('404: each digit in its own drop-in span', (r.text.match(/class="err-digit err-d/g) || []).length === 3
    && /class="err-digit err-d0" aria-hidden="true">4</.test(r.text) && /err-d1" aria-hidden="true">0</.test(r.text) && /err-d2" aria-hidden="true">4</.test(r.text), (r.text.match(/err-digit/g) || []).length + ' digit spans');
  check('404: “Not found” stamp', /class="err-stamp"/.test(r.text) && /Not found/.test(r.text));
  check('404: ledger entry chip + blinking caret', /ENTRY&nbsp;#000404/.test(r.text) && /no match in this ledger/.test(r.text) && /err-caret/.test(r.text));
  check('404: drifting background shapes', /class="err-bg"/.test(r.text) && (r.text.match(/<i><\/i>/g) || []).length >= 3);
  check('404: kicker + heading + message', /err-kicker/.test(r.text) && /Page not found/.test(r.text) && /does not exist or was moved/.test(r.text));
  check('404: three CTAs (home / directory / search)', /class="btn btn-primary" href="\/"/.test(r.text) && /btn-ghost" href="\/directory"/.test(r.text) && /btn-gold" href="\/search"/.test(r.text));
  check('404: keeps full site chrome (partials)', /container/.test(r.text) && /favicon/.test(r.text) && /css\/app\.css/.test(r.text));
  check('404: noindex', /noindex/.test(r.text));

  r = await get(BASE + '/listing/ghost-co');
  check('unknown listing slug → same animated 404', r.status === 404 && /err-digit/.test(r.text) && /err-stamp/.test(r.text), String(r.status));

  const css = await get(BASE + '/css/app.css');
  check('app.css serves with the new animation section', css.status === 200 && /maintenance holding page \+ animated 404\/500/.test(css.text), String(css.status));
  check('CSS: maintenance + error keyframes shipped', ['maintGrid', 'maintScan', 'maintBar', 'errDrop', 'errFloat', 'errStamp', 'errBlink'].every((k) => css.text.includes(`@keyframes ${k}`)));
  check('CSS: reduced-motion respects the visitor', /prefers-reduced-motion: reduce/.test(css.text) && /maint-scan[\s\S]{0,400}animation: none/.test(css.text) && /err-digit[\s\S]{0,200}animation: none/.test(css.text));

  /* ================================================= 2. admin form ON */
  console.log('\n2 · Admin personally flips maintenance on (Protection form)');
  r = await postForm(`${BASE}/admin3119Musa/protection/maintenance`, {
    maintenance_on: '1',
    maintenance_title: CUSTOM.title,
    maintenance_message: CUSTOM.message,
    maintenance_eta: CUSTOM.eta,
  });
  check('form POST accepted (redirect)', r.status === 301 || r.status === 302 || r.status === 303, String(r.status));
  const formRows = Object.fromEntries(dbq("SELECT key, value FROM settings WHERE key LIKE 'maintenance_%'").map((x) => [x.key, x.value]));
  check('DB: maintenance_on=1 with the custom copy', formRows.maintenance_on === '1' && formRows.maintenance_title === CUSTOM.title && formRows.maintenance_message === CUSTOM.message && formRows.maintenance_eta === CUSTOM.eta, JSON.stringify(formRows).slice(0, 200));

  r = await get(BASE + '/');
  check('home → 503 + Retry-After 3600', r.status === 503 && r.headers.get('retry-after') === '3600', `${r.status} / ${r.headers.get('retry-after')}`);
  check('home: noindex,nofollow + dark theme meta', /<meta name="robots" content="noindex,nofollow">/.test(r.text) && /#0A1628/.test(r.text));
  check('home: custom title in <title> tag too', r.text.includes(`${CUSTOM.title} — FirmLedger`));
  holdingPageChecks(r.text, 'home');

  for (const [pathn, label] of [['/directory', 'directory'], ['/pricing', 'pricing'], ['/search?q=apex', 'search'], ['/listing/apex-fintech', 'listing page'], ['/listing/ghost-co', 'unknown listing'], ['/blog', 'blog'], ['/docs', 'docs']]) {
    const p = await get(BASE + pathn);
    check(`${label} → 503 with holding page`, p.status === 503 && /maint-title/.test(p.text), String(p.status));
    check(`${label}: admin’s custom message shown`, p.text.includes(CUSTOM.message));
    check(`${label}: Retry-After set`, p.headers.get('retry-after') === '3600');
  }
  const postSearch = await postForm(`${BASE}/search`, { q: 'apex' }, { 'content-type': 'application/x-www-form-urlencoded' });
  check('POST /search → 503 too (gate covers all verbs)', postSearch.status === 503 && /maint-title/.test(postSearch.text), String(postSearch.status));

  console.log('\n  What must stay reachable during maintenance');
  r = await get(BASE + '/status');
  check('/status stays live (200)', r.status === 200 && !/maint-title/.test(r.text), String(r.status));
  r = await get(BASE + '/robots.txt');
  check('/robots.txt stays live', r.status === 200, String(r.status));
  r = await get(BASE + '/sitemap.xml');
  check('/sitemap.xml stays live', r.status === 200, String(r.status));
  r = await get(BASE + '/assets/logo-white.png');
  check('logo asset stays live', r.status === 200, String(r.status));
  r = await get(BASE + '/api/v1/health');
  check('public API (mounted before the gate) stays live', r.status !== 503 && !/maint-title/.test(r.text), String(r.status));
  r = await get(BASE + '/admin3119Musa');
  check('admin console reachable without session (no 503)', r.status !== 503 && !/maint-title/.test(r.text), String(r.status));
  r = await get(BASE + '/admin3119Musa', { cookie: `fl_admin=${adminToken}` });
  check('admin console admits the signed-in admin (no 503)', r.status !== 503 && !/maint-title/.test(r.text), String(r.status));
  r = await get(BASE + '/', { cookie: `fl_session=${memberToken}` });
  check('signed-in member still sees the holding page', r.status === 503 && /maint-title/.test(r.text), String(r.status));
  const aiDuring = await postJson(`${AI}/chat`, { text: 'maintenance status' });
  check('AI chat keeps working during maintenance', aiDuring.status === 200 && aiDuring.json && aiDuring.json.ok === true, String(aiDuring.status));

  /* ================================================= 3. admin form OFF */
  console.log('\n3 · Admin flips it back off');
  r = await postForm(`${BASE}/admin3119Musa/protection/maintenance`, { maintenance_on: '0', maintenance_title: CUSTOM.title, maintenance_message: CUSTOM.message, maintenance_eta: CUSTOM.eta });
  check('form POST accepted', r.status === 301 || r.status === 302 || r.status === 303, String(r.status));
  r = await get(BASE + '/');
  check('site is live again (200 home)', r.status === 200 && !/maint-title/.test(r.text), String(r.status));

  /* ================================================= 4. via AI */
  console.log('\n4 · Via the AI assistant, in plain language');
  let hist = [];
  const say = async (text) => {
    const res = await postJson(`${AI}/chat`, { text, messages: hist });
    if (res.json && res.json.content) { hist.push({ role: 'user', content: text }, { role: 'assistant', content: res.json.content }); }
    return res;
  };

  r = await say(`maintenance on title "${AI_CUSTOM.title}" message "${AI_CUSTOM.message}" eta "${AI_CUSTOM.eta}"`);
  check('plain-language command → set_maintenance_mode proposal', r.json && r.json.type === 'tool_proposal' && r.json.tool && r.json.tool.name === 'set_maintenance_mode', r.text.slice(0, 160));
  const args = (r.json && r.json.tool && r.json.tool.args) || {};
  check('proposal carries on/title', args.on === true && args.title === AI_CUSTOM.title, JSON.stringify(args).slice(0, 120));
  check('proposal carries the full custom message', args.message === AI_CUSTOM.message, JSON.stringify(args.message).slice(0, 120));
  check('proposal carries the eta (chip, not inside the message)', args.eta === AI_CUSTOM.eta && !String(args.message || '').includes('21:00'), JSON.stringify({ eta: args.eta, message: args.message }).slice(0, 160));
  check('sensitive: nothing changed before confirmation', (dbq("SELECT value FROM settings WHERE key='maintenance_on'")[0] || {}).value !== '1');

  const pid = r.json && r.json.pending_id;
  let ex = await postJson(`${AI}/execute`, { pending_id: pid });
  check('confirm executes the flip', ex.status === 200 && ex.json && ex.json.executed === true, ex.text.slice(0, 160));
  const rows = dbq("SELECT key, value FROM settings WHERE key IN ('maintenance_on','maintenance_title','maintenance_message','maintenance_eta')");
  const map = Object.fromEntries(rows.map((x) => [x.key, x.value]));
  check('DB: on + custom title + message + eta written by the tool', map.maintenance_on === '1' && map.maintenance_title === AI_CUSTOM.title && map.maintenance_message === AI_CUSTOM.message && map.maintenance_eta === AI_CUSTOM.eta, JSON.stringify(map).slice(0, 200));
  check('receipt tells the admin what visitors now see', /holding page|503|ON/.test(strip(ex.json && ex.json.content || '')), strip(ex.json && ex.json.content).slice(0, 120));

  r = await get(BASE + '/directory');
  check('directory → 503 again', r.status === 503, String(r.status));
  holdingPageChecks(r.text, 'AI flip', AI_CUSTOM);

  const audit = dbq("SELECT ok FROM ai_audit_log WHERE kind='tool' AND action='set_maintenance_mode' ORDER BY id DESC");
  check('the flip is audited', audit.length > 0 && audit[0].ok === 1, JSON.stringify(audit));

  hist = [];
  r = await say('maintenance status');
  const status = strip(r.json && r.json.content);
  check('status read shows the custom copy', /ON/.test(status) && status.includes(AI_CUSTOM.title) && status.includes(AI_CUSTOM.eta), status.slice(0, 160));

  hist = [];
  r = await say('maintenance off');
  check('“maintenance off” proposes the flip back', r.json && r.json.type === 'tool_proposal' && r.json.tool && r.json.tool.name === 'set_maintenance_mode' && r.json.tool.args.on === false, r.text.slice(0, 160));
  ex = await postJson(`${AI}/execute`, { pending_id: r.json.pending_id });
  check('confirm executes the off flip', ex.status === 200 && ex.json && ex.json.executed === true, ex.text.slice(0, 160));
  r = await get(BASE + '/');
  check('site live again after the AI off flip', r.status === 200 && !/maint-title/.test(r.text), String(r.status));

  /* ================================================= 5. 500 branch of the error view */
  console.log('\n5 · Animated error view — 500 branch (real EJS render)');
  const rendered = await new Promise((resolve) => {
    const ejs = require(path.join(ROOT, 'node_modules', 'ejs'));
    const locals = {
      meta: { title: 'Something went wrong — FirmLedger', description: '', robots: 'noindex', canonical: BASE + '/bogus' },
      code: 500, heading: 'Something went wrong', message: 'An unexpected error occurred. Our team has been notified.',
      SITE: BASE, assetV: 'test', csrfToken: 't', flash: {}, nav: '', user: null, userUnread: 0,
      ICONS: require(path.join(ROOT, 'src/lib/socialicons')).ICONS, SITE_SOCIALS: [], todayIso: new Date().toISOString().slice(0, 10),
      nlFlash: '', nlFlashKind: 'ok',
      fmtDate: (x) => String(x || ''), truncate: (s) => String(s || ''),
      perksActive: () => false, isProUser: () => false, proAccess: () => false, initials: () => 'FL',
      categories: [], footerCats: [], footerPosts: [], verifiedBadge: null,
    };
    ejs.renderFile(path.join(ROOT, 'views', 'error.ejs'), locals, { views: [path.join(ROOT, 'views')] })
      .then(resolve).catch((e) => resolve({ __error: e.message }));
  });
  if (rendered.__error) check('500 branch renders', false, rendered.__error.slice(0, 200));
  else {
    check('500 branch renders', /err-digit/.test(rendered));
    check('500: digits split 5-0-0', /err-d0" aria-hidden="true">5</.test(rendered) && /err-d1" aria-hidden="true">0</.test(rendered) && /err-d2" aria-hidden="true">0</.test(rendered));
    check('500: no “Not found” stamp', !/err-stamp/.test(rendered));
    check('500: ledger entry wording swaps', /ENTRY&nbsp;#000500/.test(rendered) && /this entry could not be read/.test(rendered));
    check('500: caret + CTAs still there', /err-caret/.test(rendered) && /btn-gold" href="\/search"/.test(rendered));
    check('500: real heading carried through', /Something went wrong/.test(rendered));
  }

  /* ================================================= wrap up */
  console.log('\n================================================================');
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  console.log('================================================================');
  if (failures.length) { console.log('\nfailed:'); failures.forEach((f) => console.log('  ✗ ' + f)); }
  server.kill();
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); server.kill(); process.exit(1); });
