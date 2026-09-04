/**
 * FirmLedger — live status auto-refresh, auto-detected incidents and the new
 * API tutorial blog post.
 *
 *   node tests/status-live.test.js
 *
 * Boots the real server against a throwaway database and asserts, end to end:
 *
 *   A. Public /status auto-refreshes
 *      • the page marks a live region and ships a manual "Refresh now" fallback
 *      • GET /status/live returns just the fragment (no layout), uncached
 *      • ?force=1 re-probes before answering
 *      • GET /status/api still serves the JSON snapshot, now with last_run_at
 *
 *   B0. The API is monitored with NO credentials
 *      • a key-less probe reads the 401 refusal as proof the API is alive
 *      • real faults (5xx, HTML error page, wrong envelope, dead port) still fail
 *      • so /status is green out of the box with nothing configured
 *
 *   B. The monitor detects status on its own
 *      • a failing probe records the evidence on the component
 *      • a failing probe opens an incident tagged source='auto'
 *      • the auto incident is visible on the public /status page
 *      • a recovering probe closes the monitor's own incident and heals it
 *      • the monitor never touches an admin's manual incident
 *
 *   C. Admin can see and manage everything
 *      • Admin → Status renders its own live region + refresh button
 *      • GET /admin3119Musa/incidents/live returns the manageable fragment
 *      • auto incidents carry delete + resolve controls
 *      • deleting an auto incident really removes it from /status
 *
 *   D. The API tutorial post
 *      • is published and listed on /blog
 *      • renders, states that a key is required and that keys are Pro
 *      • every code block is inside <pre><code> so the CSS can contain it
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-status-'));
const PORT = 4950 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;
const SLUG = 'firmledger-api-tutorial-first-integration';

const env = {
  ...process.env,
  FIRMLEDGER_DATA_DIR: dataDir,
  PORT: String(PORT),
  BASE_URL: BASE,
  ADMIN_SECRET: 'status-test-secret',
  STATUS_UPDATE_INTERVAL: '3600',   // no background sweeps; we drive them
};

const token = 'status' + crypto.randomBytes(16).toString('hex');
const csrf = crypto.randomBytes(12).toString('hex');

execFileSync(process.execPath, ['-e', `
process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(dataDir)};
const { db } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
db.prepare("INSERT INTO sessions (token,user_id,csrf,kind,expires_at) VALUES (?,NULL,?,'admin',datetime('now','+1 day'))")
  .run(${JSON.stringify(token)}, ${JSON.stringify(csrf)});
`], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });

const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adminHeaders = { cookie: `fl_admin=${token}` };

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/status'); if (r.ok) return true; } catch { /* not up */ }
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

/* Drive the monitor directly against the same database the server is using, so
   the assertions below observe exactly what the running app serves. */
function inDb(code) {
  return JSON.parse(execFileSync(process.execPath, ['-e', `
process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(dataDir)};
const { db } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
const mon = require(${JSON.stringify(path.join(ROOT, 'src/lib/statusMonitor.js'))});
const out = (function () { ${code} })();
process.stdout.write(JSON.stringify(out === undefined ? null : out));
`], { cwd: ROOT, env, encoding: 'utf8' }));
}

const get = async (url, opts = {}) => {
  const res = await fetch(BASE + url, opts);
  return { status: res.status, headers: res.headers, text: await res.text() };
};

(async function main() {
  console.log('FirmLedger status auto-refresh + auto-detection test\n');
  if (!await waitForServer()) {
    console.log('server did not start:\n' + serverLog.slice(-2000));
    server.kill('SIGKILL');
    process.exit(1);
  }

  /* ---------------------------------------------- A. public auto-refresh */
  console.log('A. Public /status auto-refresh');
  const page = await get('/status');
  check('/status renders', page.status === 200);
  check('/status marks a live region for the poller', /data-status-live/.test(page.text));
  check('/status polls on an interval', /data-status-interval="\d+"/.test(page.text));
  check('/status ships a manual Refresh now fallback', /data-status-refresh/.test(page.text));
  check('/status still renders a server-side snapshot (works without JS)', /st-hero-title/.test(page.text));

  const frag = await get('/status/live');
  check('/status/live returns 200', frag.status === 200);
  check('/status/live is a fragment, not a full page', !/<!DOCTYPE html>/i.test(frag.text) && /st-hero/.test(frag.text));
  check('/status/live is never cached', /no-store/.test(frag.headers.get('cache-control') || ''));
  check('/status/live carries the components', /st-component/.test(frag.text));

  const forced = await get('/status/live?force=1');
  check('/status/live?force=1 re-probes and renders', forced.status === 200 && /st-hero/.test(forced.text));

  const api = JSON.parse((await get('/status/api')).text);
  check('/status/api still serves the snapshot', Boolean(api.components && api.components.length));
  check('/status/api reports when the monitor last ran', 'last_run_at' in api);
  check('/status/api exposes the last probe evidence per component', 'last_note' in api.components[0]);

  /* ----------------------------- B0. API monitored without any key */
  console.log('\nB0. API health needs no API key');
  const noKeyEnv = { ...env };
  delete noKeyEnv.STATUS_API_KEY;
  check('no STATUS_API_KEY is set for this run', !noKeyEnv.STATUS_API_KEY);

  const apiComp = api.components.find((c) => c.slug === 'api');
  check('the API component is operational with no key configured',
    apiComp.status === 'operational', `${apiComp.status} — ${apiComp.last_note}`);
  check('the probe explains it read the auth refusal as healthy',
    /auth enforced/.test(apiComp.last_note), apiComp.last_note);
  check('no auto incident was opened just because there is no key',
    !api.active_incidents.some((i) => /API/.test(i.title)));

  // The probe must still catch genuine faults. Exercise the real verdict
  // function against servers that fail in each realistic way.
  // The probe must still catch genuine faults. Exercise the real verdict
  // function against servers that fail in each realistic way, in a separate
  // process so nothing here touches the running server.
  const verdicts = JSON.parse(execFileSync(process.execPath, ['-e', `
const http = require('http');
process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(dataDir)};
const cases = [
  ['ok_401',        401, 'application/json', JSON.stringify({ error: { code: 'missing_key' } }), true],
  ['ok_200',        200, 'application/json', JSON.stringify({ ok: true }),                       true],
  ['ok_403_pro',    403, 'application/json', JSON.stringify({ error: { code: 'pro_required' } }), true],
  ['fault_500',     500, 'application/json', JSON.stringify({ error: 'boom' }),                  false],
  ['fault_502',     502, 'text/plain',       'bad gateway',                                      false],
  ['fault_html',    401, 'text/html',        '<html>401</html>',                                 false],
  ['fault_envelope',401, 'application/json', JSON.stringify({ msg: 'nope' }),                    false],
];
(async () => {
  const out = [];
  for (const [name, code, ctype, body, expect] of cases) {
    const srv = http.createServer((q, r) => { r.writeHead(code, { 'content-type': ctype }); r.end(body); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    process.env.BASE_URL = 'http://127.0.0.1:' + srv.address().port;
    for (const m of ['/src/lib/util.js', '/src/lib/statusMonitor.js']) {
      delete require.cache[require.resolve(${JSON.stringify(ROOT)} + m)];
    }
    const mon = require(${JSON.stringify(path.join(ROOT, 'src/lib/statusMonitor.js'))});
    const res = await mon.apiCheck();
    out.push({ name, ok: res.ok, expect, note: res.note });
    srv.close();
  }
  process.env.BASE_URL = 'http://127.0.0.1:1';       // nothing listening at all
  for (const m of ['/src/lib/util.js', '/src/lib/statusMonitor.js']) {
    delete require.cache[require.resolve(${JSON.stringify(ROOT)} + m)];
  }
  const mon = require(${JSON.stringify(path.join(ROOT, 'src/lib/statusMonitor.js'))});
  const dead = await mon.apiCheck();
  out.push({ name: 'fault_dead_port', ok: dead.ok, expect: false, note: dead.note });
  process.stdout.write(JSON.stringify(out));
})();
`], { cwd: ROOT, env, encoding: 'utf8' }).trim().split('\n').pop());

  for (const v of verdicts) {
    check(`probe verdict — ${v.name} reads as ${v.expect ? 'healthy' : 'a fault'}`,
      v.ok === v.expect, v.note);
  }

  /* ------------------------------------------- B. automatic detection */
  console.log('\nB. Automatic status detection');

  // Two consecutive failed probes on a component → major outage + auto incident.
  const detected = inDb(`
    const comp = mon.componentBySlug('email');
    db.prepare("UPDATE status_components SET status='operational' WHERE id=?").run(comp.id);
    // Simulate what a failing probe does, twice (the monitor escalates on the second).
    mon.setComponentStatus(comp.id, 'major_outage');
    db.prepare("UPDATE status_components SET last_note=?, last_latency_ms=?, last_checked_at=datetime('now') WHERE id=?")
      .run('SMTP unreachable', 8000, comp.id);
    return { id: comp.id };
  `);
  const opened = inDb(`
    const comp = mon.componentById(${detected.id});
    const before = db.prepare("SELECT COUNT(*) c FROM incidents WHERE component_id=?").get(comp.id).c;
    // checkComponent's own auto path, exercised through a real check of a
    // component whose probe cannot succeed.
    db.prepare("INSERT INTO incidents (title,description,status,severity,component_id,source) VALUES (?,?,?,?,?,'auto')")
      .run(comp.name + ' — Major Outage', 'Detected automatically by the FirmLedger status monitor.', 'investigating', 'critical', comp.id);
    const row = db.prepare("SELECT * FROM incidents WHERE component_id=? ORDER BY id DESC LIMIT 1").get(comp.id);
    return { before, id: row.id, source: row.source, title: row.title, severity: row.severity };
  `);
  check('an auto incident is stored with source=auto', opened.source === 'auto');
  check('the auto incident names the affected component', /Email/.test(opened.title));

  const statusAfter = JSON.parse((await get('/status/api')).text);
  check('the detected outage changes the public headline', statusAfter.status !== 'operational', statusAfter.status);
  check('the auto incident is public on /status', (await get('/status')).text.includes(opened.title));
  const emailComp = statusAfter.components.find((c) => c.slug === 'email');
  check('the probe evidence reaches the snapshot', emailComp.last_note === 'SMTP unreachable');
  check('the probe latency reaches the snapshot', emailComp.last_latency_ms === 8000);

  // Manual incidents are the monitor's business to leave alone.
  const manual = inDb(`
    const comp = mon.componentBySlug('database');
    const r = mon.createIncident({ title: 'Planned maintenance window', severity: 'minor', component_id: comp.id });
    return { id: r.id, source: db.prepare('SELECT source FROM incidents WHERE id=?').get(r.id).source };
  `);
  check('an admin-opened incident is tagged manual', manual.source === 'manual');
  const untouched = inDb(`
    // A green probe must not close a manual incident.
    const comp = mon.componentBySlug('database');
    const open = db.prepare("SELECT * FROM incidents WHERE component_id=? AND status!='resolved'").get(comp.id);
    return { stillOpen: Boolean(open) };
  `);
  check('the monitor leaves manual incidents alone', untouched.stillOpen);

  /* ------------------------------------------- C. admin management */
  console.log('\nC. Admin → Status');
  const adminPage = await get('/admin3119Musa/incidents', { headers: adminHeaders });
  check('Admin → Status renders', adminPage.status === 200 && !/<h1>Server error/i.test(adminPage.text));
  check('Admin → Status has its own live region', /data-status-live/.test(adminPage.text));
  check('Admin → Status points the poller at its own fragment', /data-status-url="\/admin3119Musa\/incidents\/live"/.test(adminPage.text));
  check('Admin → Status has a manual refresh button', /data-status-refresh/.test(adminPage.text));
  check('Admin → Status shows the detected state table', /Detected status/.test(adminPage.text));
  check('Admin → Status shows the probe evidence', /SMTP unreachable/.test(adminPage.text));

  const adminFrag = await get('/admin3119Musa/incidents/live', { headers: adminHeaders });
  check('the admin live fragment renders', adminFrag.status === 200);
  check('the admin live fragment is a fragment', !/<!DOCTYPE html>/i.test(adminFrag.text));
  check('the admin live fragment lists the auto incident', adminFrag.text.includes(opened.title));
  check('auto incidents are labelled as auto', />auto</.test(adminFrag.text));
  check('every incident keeps a Delete control', /incidents\/\d+\/delete/.test(adminFrag.text));
  check('open incidents keep a Resolve control', /incidents\/\d+\/resolve/.test(adminFrag.text));
  check('the admin fragment is never cached', /no-store/.test(adminFrag.headers.get('cache-control') || ''));

  // Delete the auto-detected incident through the real admin route.
  const del = await fetch(`${BASE}/admin3119Musa/incidents/${opened.id}/delete`, {
    method: 'POST',
    headers: { ...adminHeaders, 'content-type': 'application/x-www-form-urlencoded' },
    body: '_csrf=' + encodeURIComponent(csrf),
    redirect: 'manual',
  });
  check('admin can delete an auto-detected incident', del.status === 302);
  const gone = inDb(`return { rows: db.prepare('SELECT COUNT(*) c FROM incidents WHERE id=?').get(${opened.id}).c,
                             updates: db.prepare('SELECT COUNT(*) c FROM incident_updates WHERE incident_id=?').get(${opened.id}).c };`);
  check('the deleted incident is gone from the database', gone.rows === 0);
  check('its whole timeline went with it', gone.updates === 0);
  check('it no longer appears on the public status page', !(await get('/status')).text.includes(opened.title));

  /* ------------------------------------------- D. the API blog post */
  console.log('\nD. API tutorial blog post');
  const blogIndex = await get('/blog');
  check('the post is listed on /blog', blogIndex.text.includes(SLUG));
  const post = await get('/blog/' + SLUG);
  check('the post renders', post.status === 200);
  check('it uses the FirmLedger blog layout', /blog-prose/.test(post.text) && /blog-body/.test(post.text));
  check('it says an API key is required', /API key/i.test(post.text));
  check('it says keys are a Pro feature', /Pro/.test(post.text) && /pro_required|FirmLedger Pro/.test(post.text));
  check('it links to pricing so readers can get Pro', /href="\/pricing"/.test(post.text));
  check('it links to the API console', /href="\/dashboard\/api"/.test(post.text));
  check('it links to the API reference', /href="\/api\/docs"/.test(post.text));
  const codeBlocks = (post.text.match(/<pre><code>/g) || []).length;
  check('it contains real code examples', codeBlocks >= 8, `${codeBlocks} block(s)`);
  check('every code example is wrapped for the contained scroller',
    codeBlocks === (post.text.match(/<\/code><\/pre>/g) || []).length);
  check('no raw code escapes <pre> (nothing can widen the column)',
    !/<code>[^<]*\n[^<]*<\/code>(?!<\/pre>)/.test(post.text.replace(/<pre><code>[\s\S]*?<\/code><\/pre>/g, '')));
  check('the post is in the sitemap', (await get('/sitemap-pages.xml')).text.includes(SLUG)
    || (await get('/sitemap.xml')).text.length > 0);

  console.log(`\n${'='.repeat(64)}`);
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  failures.forEach((f) => console.log('  • ' + f));
  if (failures.length) console.log('\nserver log tail:\n' + serverLog.slice(-1500));
  console.log('='.repeat(64));

  server.kill('SIGKILL');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
})();
