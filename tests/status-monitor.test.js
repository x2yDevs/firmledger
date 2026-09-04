/**
 * FirmLedger — status monitor accuracy test.
 *
 *   node tests/status-monitor.test.js
 *
 * Pins down honest status reporting and the free, preconfigured monitor key:
 *
 *   A. Free status, preconfigured API health key — /status and /status/api
 *      need no key at all, and the API health probe authenticates with a
 *      *normal* API key the monitor provisions itself: an internal
 *      lifetime-Pro account created through the standard apikeys flow, the
 *      raw key stored in settings. No operator setup. Revoked or rejected
 *      keys are re-issued on the next probe; STATUS_API_KEY still overrides.
 *
 *   B. No false outages — even when the probe ends up keyless, the API's
 *      well-formed "key required" envelope means Operational, never an
 *      outage. Real failures (connection refused, HTTP 500, malformed or
 *      unexpected responses) still walk the degraded → partial_outage →
 *      major_outage ladder and heal on the next healthy probe. Incident
 *      handling is unchanged.
 *
 *   C. End-to-end — the real server boots against a throwaway database whose
 *      API component is pre-poisoned to major_outage; the first live probe
 *      heals it to Operational using its auto-provisioned key (verified in
 *      the DB), while /api/v1/health itself still refuses keyless requests.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ===================================================================== */
/* A. In-process monitor with a scripted network                        */
/* ===================================================================== */
const dataDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-status-'));
process.env.FIRMLEDGER_DATA_DIR = dataDirA;
process.env.BASE_URL = 'http://status-monitor.test';
delete process.env.STATUS_API_KEY;

const { db, getSetting } = require(path.join(ROOT, 'src/db.js'));
const mon = require(path.join(ROOT, 'src/lib/statusMonitor.js'));
const apikeys = require(path.join(ROOT, 'src/lib/apikeys.js'));
mon.ensureComponents();
const apiId = mon.componentBySlug('api').id;

/* Scripted fetch: every URL is answered by a responder; the last /api/v1/health
   call is recorded so tests can assert what the monitor actually sent. */
const realFetch = global.fetch;
let apiCall = null;
let apiResponder = () => jsonResponse(200, { ok: true });
function jsonResponse(status, body) {
  return { status, json: async () => body };
}
function htmlResponse(status) {
  return { status, json: async () => { throw new Error('not JSON'); } };
}
const enforcedEnvelope = (code) => jsonResponse(code === 'missing_key' ? 401 : 403, {
  error: { code, message: 'scripted envelope for the status monitor test' },
});
function connRefused() {
  const e = new TypeError('fetch failed');
  e.cause = { code: 'ECONNREFUSED' };
  throw e;
}
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/api/v1/health')) {
    apiCall = { url: u, headers: opts.headers || {} };
    return apiResponder();
  }
  return jsonResponse(200, {}); // homepage probe
};

const apiStatus = () => mon.componentBySlug('api').status;
const reset = () => mon.resetComponentStatus(apiId);
const storedKey = () => getSetting('status_monitor_api_key', '');
const sentBearer = () => String((apiCall && apiCall.headers.Authorization) || '').replace(/^Bearer /, '');

(async () => {
  /* --- A1. Zero config: the monitor provisions its own normal API key --- */
  apiResponder = () => jsonResponse(200, { ok: true, service: 'FirmLedger API' });
  await mon.checkAll();
  const autoKey1 = storedKey();
  check('preconfigured: a monitor API key is auto-provisioned (no setup)', apikeys.isWellFormed(autoKey1), autoKey1 || 'none');
  check('preconfigured: probe authenticates with the auto key', sentBearer() === autoKey1 && autoKey1 !== '', sentBearer());
  check('preconfigured: API component Operational via authenticated 200', apiStatus() === 'operational', apiStatus());
  const internalUser = db.prepare("SELECT * FROM users WHERE email='status-monitor@firmledger.internal'").get();
  check('internal monitor account exists (lifetime Pro, member role)',
    Boolean(internalUser && internalUser.plan === 'pro' && !internalUser.plan_expires_at && internalUser.role === 'member'));
  check('internal account can never log in (marked non-bcrypt hash)',
    Boolean(internalUser && String(internalUser.password_hash).startsWith('!firmledger-internal:')));
  const keyRow = db.prepare('SELECT * FROM api_keys WHERE user_id=? AND revoked_at IS NULL').get(internalUser.id);
  check('auto key is a normal api_keys row (labeled, unrevoked)',
    Boolean(keyRow && keyRow.label === 'FirmLedger status monitor'), keyRow && keyRow.label);
  check('overall headline is All Systems Normal', mon.overallStatus() === 'operational', mon.overallStatus());

  /* --- A2. STATUS_API_KEY still overrides the auto key --- */
  const VALID_KEY = 'fl_live_' + 'a'.repeat(32);
  process.env.STATUS_API_KEY = VALID_KEY;
  await mon.checkAll();
  check('STATUS_API_KEY override: probe uses the env key', sentBearer() === VALID_KEY, sentBearer());
  check('STATUS_API_KEY override: API Operational', apiStatus() === 'operational', apiStatus());

  /* --- A3. A stale env key is retired; the auto key takes over --- */
  process.env.STATUS_API_KEY = 'fl_live_' + 'b'.repeat(32);
  apiResponder = () => enforcedEnvelope('invalid_key');
  await mon.checkAll();
  check('stale STATUS_API_KEY rejected → still Operational (no false outage)', apiStatus() === 'operational', apiStatus());
  apiResponder = () => jsonResponse(200, { ok: true });
  await mon.checkAll();
  check('retired env key → probe falls back to the auto key', sentBearer() === autoKey1, sentBearer());
  delete process.env.STATUS_API_KEY;

  /* --- A4. Auto key revoked somewhere → fresh one issued on next probe --- */
  const beforeRevoke = storedKey();
  const hitA4 = apikeys.lookup(beforeRevoke);
  apikeys.revokeKey(hitA4.key.id, hitA4.key.user_id);
  await mon.checkAll();
  const afterRevoke = storedKey();
  check('revoked auto key re-issued automatically', apikeys.isWellFormed(afterRevoke) && afterRevoke !== beforeRevoke);
  check('probe uses the re-issued key', sentBearer() === afterRevoke, sentBearer());
  check('API Operational after key re-issue', apiStatus() === 'operational', apiStatus());

  /* --- A5. Auto key rejected by the API → dropped and re-issued --- */
  const beforeReject = storedKey();
  apiResponder = () => enforcedEnvelope('pro_required');
  await mon.checkAll();
  check('rejected auto key → still Operational (no false outage)', apiStatus() === 'operational', apiStatus());
  const hitA5 = apikeys.lookup(beforeReject);
  check('rejected auto key was revoked', Boolean(hitA5 && hitA5.key.revoked_at));
  apiResponder = () => jsonResponse(200, { ok: true });
  await mon.checkAll();
  check('fresh auto key issued after rejection', apikeys.isWellFormed(storedKey()) && storedKey() !== beforeReject && sentBearer() === storedKey());

  /* --- B1. Real outage: consecutive failures walk the ladder --- */
  reset();
  apiResponder = connRefused;
  await mon.checkAll();
  check('real failure #1 → Degraded', apiStatus() === 'degraded', apiStatus());
  await mon.checkAll();
  check('real failure #2 → Partial Outage', apiStatus() === 'partial_outage', apiStatus());
  await mon.checkAll();
  check('real failure #3 → Major Outage', apiStatus() === 'major_outage', apiStatus());
  const snapOutage = mon.snapshot();
  check('real outage → headline flips to Major Outage', snapOutage.status === 'major_outage' && snapOutage.status_label === 'Major Outage', snapOutage.status_label);

  /* --- B2. Recovery heals on the next healthy probe --- */
  apiResponder = () => jsonResponse(200, { ok: true });
  await mon.checkAll();
  check('recovery → API heals back to Operational', apiStatus() === 'operational', apiStatus());
  check('recovery → headline back to All Systems Normal', mon.overallStatus() === 'operational', mon.overallStatus());

  /* --- B3. Other genuinely-broken responses still fail --- */
  reset();
  apiResponder = () => jsonResponse(500, { error: { code: 'boom' } });
  await mon.checkAll();
  check('HTTP 500 counts as a real failure', apiStatus() === 'degraded', apiStatus());

  reset();
  apiResponder = () => htmlResponse(404); // e.g. the API router got unmounted
  await mon.checkAll();
  check('malformed (non-JSON) response counts as a real failure', apiStatus() === 'degraded', apiStatus());

  reset();
  apiResponder = () => jsonResponse(400, { error: { code: 'mystery_code' } });
  await mon.checkAll();
  check('unexpected 4xx envelope code counts as a real failure', apiStatus() === 'degraded', apiStatus());
  reset();

  /* --- B4. Incident machinery untouched: open incident holds, resolve heals --- */
  apiResponder = () => jsonResponse(200, { ok: true });
  const inc = mon.createIncident({ title: 'Scripted API incident', severity: 'critical', component_id: apiId });
  check('critical incident forces Major Outage on its component', inc.ok && apiStatus() === 'major_outage', apiStatus());
  await mon.checkAll();
  check('open incident keeps component down even on a healthy probe', apiStatus() === 'major_outage', apiStatus());
  mon.resolveIncident(inc.id);
  check('resolving the incident heals the component', apiStatus() === 'operational', apiStatus());

  global.fetch = realFetch;

  /* ===================================================================== */
  /* C. End-to-end: real server, zero config, heals a poisoned outage      */
  /* ===================================================================== */
  console.log('\nC. Real server, zero config — poisoned Major Outage heals');

  const dataDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-status-b-'));
  const PORT = 4500 + (process.pid % 400);
  const BASE = `http://127.0.0.1:${PORT}`;

  const seed = `
process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(dataDirB)};
const mon = require('./src/lib/statusMonitor');
mon.ensureComponents();
const c = mon.componentBySlug('api');
mon.setComponentStatus(c.id, 'major_outage');
console.log('seeded:' + mon.componentBySlug('api').status);
`;
  const seedRes = spawnSync(process.execPath, ['-e', seed], { cwd: ROOT, encoding: 'utf8' });
  check('poisoned DB: API component seeded at major_outage', seedRes.status === 0 && /seeded:major_outage/.test(seedRes.stdout),
    (seedRes.stderr || '').split('\n')[0]);

  const env = {
    ...process.env,
    FIRMLEDGER_DATA_DIR: dataDirB, PORT: String(PORT), BASE_URL: BASE,
    STATUS_UPDATE_INTERVAL: '15',
  };
  delete env.STATUS_API_KEY;
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  let snap = null;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await sleep(700);
    try {
      const res = await fetch(`${BASE}/status/api`);
      if (!res.ok) continue;
      snap = await res.json();
      const api = (snap.components || []).find((c) => c.slug === 'api');
      if (api && api.status === 'operational') break;
    } catch { /* not up yet */ }
  }

  const apiComp = snap && (snap.components || []).find((c) => c.slug === 'api');
  check('live probe heals the poisoned Major Outage → API Operational',
    Boolean(apiComp && apiComp.status === 'operational'),
    apiComp ? apiComp.status : 'server never reported' + (serverLog ? ` — ${serverLog.split('\n')[0]}` : ''));
  check('overall headline is All Systems Normal', snap && snap.status === 'operational' && snap.status_label === 'All Systems Normal',
    snap ? snap.status_label : 'no snapshot');

  // The API itself must remain fully key-gated — the fix changes reporting, not auth.
  try {
    const h = await fetch(`${BASE}/api/v1/health`);
    const hb = await h.json().catch(() => ({}));
    check('/api/v1/health still refuses keyless requests (401 missing_key)',
      h.status === 401 && hb.error && hb.error.code === 'missing_key', `HTTP ${h.status}`);
  } catch (e) {
    check('/api/v1/health still refuses keyless requests (401 missing_key)', false, String(e.message));
  }

  try {
    const page = await fetch(`${BASE}/status`);
    const html = await page.text();
    check('public /status page renders All Systems Normal (free, no key)', page.status === 200 && html.includes('All Systems Normal'), `HTTP ${page.status}`);
  } catch (e) {
    check('public /status page renders All Systems Normal (free, no key)', false, String(e.message));
  }

  // The server's own DB must show the preconfigured key did the real work.
  const Database = require('better-sqlite3');
  const ro = new Database(path.join(dataDirB, 'firmledger.db'), { readonly: true });
  const liveKey = ro.prepare("SELECT value FROM settings WHERE key='status_monitor_api_key'").get();
  const liveUser = ro.prepare("SELECT * FROM users WHERE email='status-monitor@firmledger.internal'").get();
  const liveKeyRow = liveUser
    ? ro.prepare('SELECT * FROM api_keys WHERE user_id=? ORDER BY id DESC').all(liveUser.id).find((k) => !k.revoked_at)
    : null;
  check('server DB: auto-provisioned key persisted in settings',
    Boolean(liveKey && apikeys.isWellFormed(liveKey.value)), liveKey ? liveKey.value : 'none');
  check('server DB: internal account is lifetime Pro',
    Boolean(liveUser && liveUser.plan === 'pro' && !liveUser.plan_expires_at));
  check('server DB: the API health probe really used the key (usage recorded)',
    Boolean(liveKeyRow && liveKeyRow.total_requests >= 1), liveKeyRow ? `requests=${liveKeyRow.total_requests}` : 'no key row');
  ro.close();

  server.kill('SIGTERM');
  await sleep(500);
  try { fs.rmSync(dataDirA, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(dataDirB, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(`\n${'='.repeat(64)}`);
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  failures.forEach((f) => console.log('  • ' + f));
  console.log('='.repeat(64));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('status-monitor test crashed:', e);
  process.exit(1);
});
