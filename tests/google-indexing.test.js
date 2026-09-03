/**
 * FirmLedger — Google Indexing API + homepage featured rail test.
 *
 *   node tests/google-indexing.test.js
 *
 * Two halves, both offline:
 *
 *   A. Library level — a stub replaces the `googleapis` package, so we can
 *      assert exactly what pingGoogleNewListing() sends: the URL_UPDATED payload,
 *      the audit-log entry, the "a pinged URL is never pinged again" ledger, the
 *      200/day quota and the batch runner.
 *
 *   B. HTTP level — the real server boots (same stub preloaded), an admin
 *      session uploads a service-account key through Admin → Settings, hits
 *      "Submit first 200 listings", clears the indexing log, deletes an incident
 *      and checks the homepage featured rail scrolls past 8 records.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'helpers', 'googleapis-stub.js');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A throwaway service-account key with a real (useless) RSA private key, so the
   credential parser is exercised exactly as it would be in production. */
function fakeServiceAccount(email = `indexing-bot@firmledger-test.iam.gserviceaccount.com`) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return JSON.stringify({
    type: 'service_account',
    project_id: 'firmledger-test',
    private_key_id: crypto.randomBytes(8).toString('hex'),
    private_key: privateKey,
    client_email: email,
    client_id: '123456789012345678901',
    token_uri: 'https://oauth2.googleapis.com/token',
  });
}

/* ===================================================================== */
/* A. Library level                                                       */
/* ===================================================================== */
const dataDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-gi-'));
const stubLogA = path.join(dataDirA, 'stub.log');
process.env.FIRMLEDGER_DATA_DIR = dataDirA;
process.env.GOOGLE_STUB_LOG = stubLogA;
process.env.BASE_URL = 'https://firmledger.test';

require(STUB); // install the googleapis stand-in before anything requires it
const gi = require(path.join(ROOT, 'src/lib/googleIndexing.js'));
const { db, getSetting, setSetting } = require(path.join(ROOT, 'src/db.js'));
const logLib = require(path.join(ROOT, 'src/lib/indexlog.js'));

function seedListings(n, { featured = 1 } = {}) {
  const ins = db.prepare(
    `INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,status,featured,confidence)
     VALUES (?,?,?,?,'company','Technology',?,?,'Kenya','approved',?,70)`
  );
  for (let i = 1; i <= n; i++) {
    ins.run(`gi-co-${i}`, `GI Co ${i}`, `Tagline ${i}`, `Seeded listing ${i} for the Google Indexing test.`,
      `https://gi${i}.example`, `hi@gi${i}.example`, featured);
  }
}

function stubRecords() {
  if (!fs.existsSync(stubLogA)) return [];
  return fs.readFileSync(stubLogA, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

async function partA() {
  console.log('A. Google Indexing API — library level\n');

  /* --- credentials ---------------------------------------------------- */
  check('rejects a malformed key', gi.saveServiceAccount('{ not json').ok === false);
  const bad = gi.saveServiceAccount(JSON.stringify({ type: 'service_account', project_id: 'x' }));
  check('rejects a key with no client_email/private_key', bad.ok === false, bad.error);
  check('no key is configured yet', gi.status().configured === false);
  const noKey = await gi.pingGoogleNewListing('/listing/gi-co-1');
  check('a ping with no key configured is a clean no-op', noKey.ok === false && noKey.skipped === true);
  check('a skipped ping is not recorded as a failure', logLib.count() === 0);

  const email = 'indexing-bot@firmledger-test.iam.gserviceaccount.com';
  const saved = gi.saveServiceAccount(fakeServiceAccount(email));
  check('accepts and permanently stores a service-account key', saved.ok === true, saved.error);
  check('key file exists on disk', fs.existsSync(gi.storedPath()));
  check('key file is private (0600)', (fs.statSync(gi.storedPath()).mode & 0o777) === 0o600);
  check('status reports the service account', gi.status().client_email === email);
  check('status reports the key source', gi.status().source === 'uploaded');

  /* --- a single ping -------------------------------------------------- */
  seedListings(3);
  const url = 'https://firmledger.test/listing/gi-co-1';
  const r1 = await gi.pingGoogleNewListing('/listing/gi-co-1');
  check('pingGoogleNewListing() accepts a site path and resolves it', r1.url === url, r1.url);
  check('pingGoogleNewListing() succeeds', r1.ok === true, r1.error);
  check('pingGoogleNewListing() reports the API status code', Number(r1.status) === 200, String(r1.status));

  const publish = stubRecords().filter((e) => e.kind === 'publish');
  check('publishes { url, type: "URL_UPDATED" }', publish.length === 1
    && publish[0].url === url && publish[0].type === 'URL_UPDATED',
  JSON.stringify(publish[0] || null));
  const authed = stubRecords().filter((e) => e.kind === 'auth');
  check('authenticates with google.auth.GoogleAuth + the indexing scope',
    authed.length >= 1 && authed[0].client_email === email
    && authed[0].scopes.includes('https://www.googleapis.com/auth/indexing'),
  JSON.stringify(authed[0] || null));

  const logs = logLib.recent(10);
  check('writes an indexing-log entry', logs.length === 1 && logs[0].channel === 'google' && logs[0].ok === 1 && logs[0].http_status === 200);
  check('logs the target url', logs[0].url === url);

  /* --- never ping the same url twice ---------------------------------- */
  check('records the url as submitted', gi.isSubmitted(url) === true);
  check('a pinged listing drops out of the pending queue',
    gi.pendingListings(10).every((p) => p.url !== url));
  check('pending count falls to the un-pinged listings', gi.pendingCount() === 2, String(gi.pendingCount()));
  check('submitted count is tracked', gi.submittedCount() === 1);

  /* --- quota ---------------------------------------------------------- */
  check('quota starts at 200/day', gi.quota().limit === 200 && gi.quota().remaining === 199, JSON.stringify(gi.quota()));

  /* --- batch: the first 200 never-submitted listings ------------------ */
  const run = gi.startBatch(200);
  check('batch run starts', run.ok === true, run.error);
  for (let i = 0; i < 60 && gi.jobState().running; i++) await sleep(100);
  const state = gi.jobState();
  check('batch submits only un-submitted listings', state.total === 2 && state.ok === 2 && state.failed === 0, JSON.stringify(state));
  check('quota counts the batch', gi.quota().used === 3, JSON.stringify(gi.quota()));
  check('nothing is left pending', gi.pendingCount() === 0);

  const run2 = gi.startBatch(200);
  check('a second run has nothing to do', run2.ok === true);
  for (let i = 0; i < 40 && gi.jobState().running; i++) await sleep(100);
  check('second run attempts nothing (pinged urls never reappear)',
    gi.lastRunSummary() && gi.lastRunSummary().attempted === 0 && gi.lastRunSummary().note === 'nothing-pending',
  JSON.stringify(gi.lastRunSummary()));

  /* --- failure logging ------------------------------------------------ */
  process.env.GOOGLE_STUB_FAIL = 'gi-co-2';
  const before = logLib.recent(500).length;
  const fail = await gi.pingGoogleNewListing('https://firmledger.test/listing/gi-co-2');
  check('a failing ping resolves (never throws)', fail.ok === false && fail.status === 429, JSON.stringify(fail));
  const failLog = logLib.recent(500);
  check('failures are logged to the indexing log', failLog.length === before + 1
    && failLog[0].ok === 0 && failLog[0].http_status === 429 && /quota/i.test(failLog[0].message),
  JSON.stringify(failLog[0] || null));
  delete process.env.GOOGLE_STUB_FAIL;

  /* --- switches ------------------------------------------------------- */
  setSetting('google_indexing_enabled', '0');
  const off = await gi.pingGoogleNewListing('https://firmledger.test/listing/gi-co-3');
  check('the admin switch turns Google pings off', off.ok === false && off.skipped === true && off.error === 'disabled');
  setSetting('google_indexing_enabled', '1');

  process.env.GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON = fakeServiceAccount('env-bot@firmledger-test.iam.gserviceaccount.com');
  check('the environment variable wins over the saved file',
    gi.loadCredentials().source === 'environment'
    && gi.loadCredentials().creds.client_email === 'env-bot@firmledger-test.iam.gserviceaccount.com');
  delete process.env.GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON;
  check('and the saved file is used again once it is unset', gi.loadCredentials().source === 'uploaded');

  /* --- log maintenance ------------------------------------------------ */
  const n = logLib.recent(500).length;
  check('log entries can be deleted one by one', logLib.remove(logLib.recent(1)[0].id) === 1 && logLib.recent(500).length === n - 1);
  logLib.clearAll();
  check('the whole log can be cleared', logLib.count() === 0);

  gi.removeServiceAccount();
  check('the saved key can be removed', gi.status().configured === false && !fs.existsSync(gi.storedPath()));
}

/* ===================================================================== */
/* B. HTTP level — the real server, admin console, homepage              */
/* ===================================================================== */
async function partB() {
  console.log('\nB. Admin console + homepage — HTTP level\n');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-gi-http-'));
  const stubLog = path.join(dataDir, 'stub.log');
  const PORT = 4400 + (process.pid % 400);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    FIRMLEDGER_DATA_DIR: dataDir,
    PORT: String(PORT),
    BASE_URL: BASE,
    ADMIN_SECRET: 'smoke-test-secret',
    GOOGLE_STUB_LOG: stubLog,
    STATUS_UPDATE_INTERVAL: '3600',
  };
  delete env.GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON;
  delete env.GOOGLE_STUB_FAIL;

  const token = 'gi' + crypto.randomBytes(12).toString('hex');
  const csrf = crypto.randomBytes(12).toString('hex');

  const seed = `
process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(dataDir)};
const { db, setSetting } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
const run = (sql, ...p) => db.prepare(sql).run(...p);
for (let i = 1; i <= 12; i++) {
  run(\`INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,status,featured,confidence)
       VALUES (?,?,?,?,'company','Technology',?,?,'Kenya','approved',1,70)\`,
    'web-co-' + i, 'Web Co ' + i, 'Tagline ' + i, 'Seeded listing ' + i + ' for the featured rail.',
    'https://web' + i + '.example', 'hi@web' + i + '.example');
}
run(\`INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,status,confidence)
     VALUES ('awaiting-co','Awaiting Co','Waiting','A pending listing waiting for moderation.','company','Technology','https://awaiting.example','a@example.com','Kenya','pending',55)\`);
run("INSERT INTO incidents (title,description,status,severity) VALUES ('Seeded outage','Broke','investigating','major')");
run("INSERT INTO incident_updates (incident_id,status,message) VALUES (1,'investigating','Looking')");
run("INSERT INTO sessions (token,user_id,csrf,kind,expires_at) VALUES (?,NULL,?,'admin',datetime('now','+1 day'))", ${JSON.stringify(token)}, ${JSON.stringify(csrf)});
`;
  const seedRes = spawnSync(process.execPath, ['-e', seed], { cwd: ROOT, env, encoding: 'utf8' });
  if (seedRes.status !== 0) {
    check('seed the test database', false, (seedRes.stderr || '').slice(0, 400));
    return;
  }

  const server = spawn(process.execPath, ['-r', STUB, 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const res = await fetch(`${BASE}/healthz`).catch(() => fetch(BASE)); if (res) up = true; } catch { /* not yet */ }
    if (!up) await sleep(250);
  }
  if (!up) {
    check('server starts', false, serverLog.slice(-800));
    server.kill('SIGKILL');
    return;
  }

  const admin = (url, opts = {}) => fetch(BASE + url, {
    ...opts,
    headers: { cookie: `fl_admin=${token}`, ...(opts.headers || {}) },
    redirect: 'manual',
  });
  const post = (url, body) => admin(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, ...body }).toString(),
  });

  try {
    /* --- homepage featured rail ------------------------------------- */
    const home = await (await fetch(BASE + '/')).text();
    check('homepage renders', /Featured records/.test(home));
    check('more than 8 featured records scroll horizontally', /class="featured-rail is-marquee"/.test(home));
    check('the rail renders two passes of every card',
      (home.match(/featured-card"/g) || []).length === 24 || (home.match(/class="l-card featured-card/g) || []).length === 24,
    String((home.match(/class="l-card featured-card/g) || []).length));
    check('the rail has a pause control', /data-rail-toggle[^>]*data-rail-target="\.featured-rail"/.test(home));

    // Drop back to 8 or fewer featured records → the plain grid returns.
    const trim = `
process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(dataDir)};
const { db } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
db.prepare("UPDATE listings SET featured=0 WHERE slug IN ('web-co-9','web-co-10','web-co-11','web-co-12')").run();
`;
    spawnSync(process.execPath, ['-e', trim], { cwd: ROOT, env });
    const home2 = await (await fetch(BASE + '/')).text();
    check('8 or fewer featured records render as the normal grid',
      /class="list-grid"/.test(home2) && !/featured-rail is-marquee/.test(home2));
    check('the grid shows at most 8 cards', (home2.match(/class="l-card featured-card/g) || []).length === 8,
      String((home2.match(/class="l-card featured-card/g) || []).length));

    /* --- settings page ------------------------------------------------ */
    const settings = await (await admin('/admin3119Musa/settings')).text();
    check('settings renders the Google Indexing API card', /Google Indexing API/.test(settings));
    check('settings shows the "Submit first 200 listings" action', /Submit first 200 listings/.test(settings));
    check('settings starts with no service account', /Not configured/.test(settings));

    /* --- upload the key ----------------------------------------------- */
    const form = new FormData();
    form.append('_csrf', csrf);
    form.append('service_account', new Blob([fakeServiceAccount()], { type: 'application/json' }), 'service-account.json');
    const up2 = await admin('/admin3119Musa/settings/google/service-account', { method: 'POST', body: form });
    check('uploading the key redirects', up2.status === 302, `HTTP ${up2.status}`);
    const settings2 = await (await admin('/admin3119Musa/settings')).text();
    check('the uploaded key is reported as connected', /Connected/.test(settings2) && /indexing-bot@firmledger-test\.iam\.gserviceaccount\.com/.test(settings2));
    check('the backlog is counted', /approved listing/.test(settings2));

    /* --- approve a listing → Google gets pinged ----------------------- */
    const row = spawnSync(process.execPath, ['-e',
      `process.env.FIRMLEDGER_DATA_DIR=${JSON.stringify(dataDir)};const {db}=require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
       const l=db.prepare("SELECT id,slug FROM listings WHERE slug='awaiting-co'").get();
       console.log(JSON.stringify(l));`], { cwd: ROOT, env, encoding: 'utf8' });
    const listing = JSON.parse(row.stdout.trim());
    const appr = await post(`/admin3119Musa/listings/${listing.id}/approve`, {});
    check('approving a listing redirects', appr.status === 302, `HTTP ${appr.status}`);
    await sleep(1200);
    const sent = fs.existsSync(stubLog)
      ? fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    check('an approved listing pings Google in the background',
      sent.some((e) => e.kind === 'publish' && e.url === `${BASE}/listing/${listing.slug}` && e.type === 'URL_UPDATED'),
    JSON.stringify(sent.filter((e) => e.kind === 'publish').slice(0, 3)));

    /* --- submit the first 200 ----------------------------------------- */
    const sub = await post('/admin3119Musa/settings/google/submit-200', {});
    check('the batch endpoint redirects', sub.status === 302, `HTTP ${sub.status}`);
    for (let i = 0; i < 100; i++) {
      const j = await (await admin('/admin3119Musa/settings/google/job.json')).json();
      if (!j.job.running) break;
      await sleep(250);
    }
    const after = await (await admin('/admin3119Musa/settings/google/job.json')).json();
    check('every approved listing is submitted (12 seeded + 1 approved)', after.submitted === 13, JSON.stringify(after));
    check('nothing is left pending', after.pending === 0, JSON.stringify(after));
    check('the run respects the 200/day quota', after.quota.used === 13 && after.quota.remaining === 187, JSON.stringify(after.quota));
    const published = fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.kind === 'publish');
    check('Google received each url exactly once',
      published.length === 13 && new Set(published.map((p) => p.url)).size === 13,
    `${published.length} calls, ${new Set(published.map((p) => p.url)).size} unique`);

    /* --- indexing log -------------------------------------------------- */
    const settings3 = await (await admin('/admin3119Musa/settings')).text();
    check('the indexing log lists the pings', /\/admin3119Musa\/indexing\/logs\/\d+\/delete/.test(settings3));
    check('the log is a contained scroller', /class="scroll-table"/.test(settings3));
    const firstId = (settings3.match(/\/admin3119Musa\/indexing\/logs\/(\d+)\/delete/) || [])[1];
    if (firstId) {
      const del = await post(`/admin3119Musa/indexing/logs/${firstId}/delete`, {});
      const settings4 = await (await admin('/admin3119Musa/settings')).text();
      check('a single log entry can be deleted',
        del.status === 302 && !settings4.includes(`/admin3119Musa/indexing/logs/${firstId}/delete`));
    } else {
      check('a single log entry can be deleted', false, 'no log row found');
    }
    const cleared = await post('/admin3119Musa/indexing/logs/clear', {});
    const settings5 = await (await admin('/admin3119Musa/settings')).text();
    check('the whole log can be cleared',
      cleared.status === 302 && !/\/admin3119Musa\/indexing\/logs\/\d+\/delete/.test(settings5));

    /* --- incidents ------------------------------------------------------ */
    const incidents = await (await admin('/admin3119Musa/incidents')).text();
    check('incidents page offers a permanent delete', /\/admin3119Musa\/incidents\/1\/delete/.test(incidents));
    const del2 = await post('/admin3119Musa/incidents/1/delete', {});
    const incidents2 = await (await admin('/admin3119Musa/incidents')).text();
    check('deleting an incident removes it from the console',
      del2.status === 302 && !/Seeded outage/.test(incidents2));
    const statusPage = await (await fetch(BASE + '/status')).text();
    check('the deleted incident is gone from the public status page', !/Seeded outage/.test(statusPage));
  } finally {
    server.kill('SIGKILL');
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

(async function main() {
  console.log('FirmLedger Google Indexing + featured rail test\n');
  await partA();
  await partB();

  console.log(`\n${'='.repeat(64)}`);
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  failures.forEach((f) => console.log('  • ' + f));
  console.log('='.repeat(64));
  try { fs.rmSync(dataDirA, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
})();
