/**
 * FirmLedger — status monitor accuracy test.
 *
 *   node tests/status-monitor.test.js
 *
 * Pins down both halves of honest status reporting:
 *
 *   A. No false outages — with no STATUS_API_KEY (the fresh-deploy default)
 *      the API component must report Operational as long as /api/v1/health
 *      answers with the API's well-formed "key required" envelope: a missing
 *      monitor key is not an outage. Same for a stale key the API rejects —
 *      it is retired so the probe can't brute-force-lock its own host's IP.
 *
 *   B. Real outages are still reported — connection refused, HTTP 500 and
 *      malformed responses must walk the API component down the
 *      degraded → partial_outage → major_outage ladder over consecutive
 *      failing probes, flip the headline to "Major Outage", and heal back to
 *      operational on the next healthy probe. Incident handling is unchanged.
 *
 * Part A runs the real monitor in-process with scripted network responses.
 * Part B boots the real server against a throwaway database whose API
 * component is pre-poisoned to major_outage and verifies the first live
 * keyless probe heals it to Operational — while /api/v1/health itself still
 * refuses keyless requests (the API stays fully key-gated).
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

const mon = require(path.join(ROOT, 'src/lib/statusMonitor.js'));
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
const VALID_KEY = 'fl_live_' + 'a'.repeat(32);

(async () => {
  /* --- A1. No key at all: the auth-enforcing 401 is NOT an outage --- */
  apiResponder = () => enforcedEnvelope('missing_key');
  await mon.checkAll();
  check('no STATUS_API_KEY + auth-enforcing 401 → API Operational', apiStatus() === 'operational', apiStatus());
  check('no STATUS_API_KEY → overall stays All Systems Normal', mon.overallStatus() === 'operational', mon.overallStatus());
  check('no STATUS_API_KEY → probe sent keyless', !apiCall.headers.Authorization);
  const snapKeyless = mon.snapshot();
  check('no STATUS_API_KEY → snapshot headline is All Systems Normal', snapKeyless.status === 'operational' && snapKeyless.status_label === 'All Systems Normal', snapKeyless.status_label);

  /* --- A2. A valid key still gets the fully-authenticated 200 check --- */
  process.env.STATUS_API_KEY = VALID_KEY;
  apiResponder = () => jsonResponse(200, { ok: true, service: 'FirmLedger API' });
  await mon.checkAll();
  check('valid STATUS_API_KEY → API Operational via HTTP 200', apiStatus() === 'operational', apiStatus());
  check('valid STATUS_API_KEY → probe authenticates', apiCall.headers.Authorization === `Bearer ${VALID_KEY}`);

  /* --- A3. A stale key: reported healthy, retired, never retried --- */
  const STALE_KEY = 'fl_live_' + 'b'.repeat(32);
  process.env.STATUS_API_KEY = STALE_KEY;
  apiResponder = () => enforcedEnvelope('invalid_key');
  await mon.checkAll();
  check('stale STATUS_API_KEY rejected → API still Operational (not outage)', apiStatus() === 'operational', apiStatus());
  apiCall = null;
  apiResponder = () => enforcedEnvelope('missing_key');
  await mon.checkAll();
  check('rejected key retired → next probe goes out keyless', apiCall && !apiCall.headers.Authorization);
  const FRESH_KEY = 'fl_live_' + 'c'.repeat(32);
  process.env.STATUS_API_KEY = FRESH_KEY;
  apiResponder = () => jsonResponse(200, { ok: true });
  await mon.checkAll();
  check('a fresh STATUS_API_KEY is tried again (200)', apiCall.headers.Authorization === `Bearer ${FRESH_KEY}` && apiStatus() === 'operational');
  delete process.env.STATUS_API_KEY;

  /* --- A4. Real outage: consecutive failures walk the ladder --- */
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

  /* --- A5. Recovery heals on the next healthy probe --- */
  apiResponder = () => enforcedEnvelope('missing_key');
  await mon.checkAll();
  check('recovery → API heals back to Operational', apiStatus() === 'operational', apiStatus());
  check('recovery → headline back to All Systems Normal', mon.overallStatus() === 'operational', mon.overallStatus());

  /* --- A6/A7/A8. Other genuinely-broken responses still fail --- */
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

  /* --- A9. Incident machinery untouched: open incident holds, resolve heals --- */
  apiResponder = () => enforcedEnvelope('missing_key');
  const inc = mon.createIncident({ title: 'Scripted API incident', severity: 'critical', component_id: apiId });
  check('critical incident forces Major Outage on its component', inc.ok && apiStatus() === 'major_outage', apiStatus());
  await mon.checkAll();
  check('open incident keeps component down even on a healthy probe', apiStatus() === 'major_outage', apiStatus());
  mon.resolveIncident(inc.id);
  check('resolving the incident heals the component', apiStatus() === 'operational', apiStatus());

  global.fetch = realFetch;

  /* ===================================================================== */
  /* B. End-to-end: real server, keyless, heals a poisoned Major Outage    */
  /* ===================================================================== */
  console.log('\nB. Real server, keyless — poisoned Major Outage heals');

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
  check('live keyless probe heals the poisoned Major Outage → API Operational',
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
    check('public /status page renders All Systems Normal', page.status === 200 && html.includes('All Systems Normal'), `HTTP ${page.status}`);
  } catch (e) {
    check('public /status page renders All Systems Normal', false, String(e.message));
  }

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
