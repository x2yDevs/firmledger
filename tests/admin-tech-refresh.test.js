/**
 * FirmLedger — admin technology-radar maintenance test.
 *
 *   node tests/admin-tech-refresh.test.js
 *
 * Two halves, both offline (helpers/fetch-stub.js answers every homepage):
 *
 *   A. Library level — one listing at a time (row button / edit page), a
 *      selection, a whole filtered view, everything stale and the entire
 *      directory; the counters, the single-run lock, cancellation and the
 *      persisted last-run summary.
 *
 *   B. HTTP level — the real server boots with an admin session: the listings
 *      page carries the maintenance panel, the row button re-scans one record,
 *      the bulk select and "refresh all in this view" run in the background and
 *      report progress on /admin3119Musa/listings/tech-job.json, the edit page
 *      refresh stays on the record, CSRF still applies and the tech filter
 *      splits stale from fresh.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'helpers', 'fetch-stub.js');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Redirect targets are query strings — spaces arrive as %20 or +. */
const decode = (s) => decodeURIComponent(String(s || '').replace(/\+/g, ' '));

/* Part A needs the stubbed fetch; part B talks to a real server, so keep a
   handle on the genuine one before the stub replaces it. */
const realFetch = globalThis.fetch.bind(globalThis);

/* ===================================================================== */
/* A. Library level                                                       */
/* ===================================================================== */
const dataDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-tech-'));
process.env.FIRMLEDGER_DATA_DIR = dataDirA;
process.env.BASE_URL = 'https://firmledger.test';

require(STUB); // no network in tests — canned homepages only
const { db } = require(path.join(ROOT, 'src/db.js'));
const tech = require(path.join(ROOT, 'src/lib/techrefresh.js'));

const ins = db.prepare(
  `INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,status,confidence)
   VALUES (?,?,?,?,'company','Technology',?,?,'Kenya','approved',70)`
);
const nextId = Number(ins.run('next-co', 'Next Co', 'Tagline', 'A seeded listing for the technology refresh test.', 'https://next.example', 'hi@next.example').lastInsertRowid);
const wpId = Number(ins.run('wp-co', 'WP Co', 'Tagline', 'A seeded listing for the technology refresh test.', 'https://wp.example', 'hi@wp.example').lastInsertRowid);
const bareId = Number(ins.run('bare-co', 'Bare Co', 'Tagline', 'A seeded listing for the technology refresh test.', 'https://bare.example', 'hi@bare.example').lastInsertRowid);
const offlineId = Number(ins.run('offline-co', 'Offline Co', 'Tagline', 'A seeded listing for the technology refresh test.', 'https://offline.example', 'hi@offline.example').lastInsertRowid);
const noSiteId = Number(ins.run('nosite-co', 'No Site Co', 'Tagline', 'A seeded listing with no website at all.', '', 'hi@nosite.example').lastInsertRowid);
const slowId = Number(ins.run('slow-co', 'Slow Co', 'Tagline', 'A seeded listing whose homepage answers slowly.', 'https://slow.example', 'hi@slow.example').lastInsertRowid);

const row = (id) => db.prepare('SELECT * FROM listings WHERE id=?').get(id);
const today = new Date().toISOString().slice(0, 10);

(async function partA() {
  console.log('A. Library level\n');

  /* ---- one listing at a time (the row button and the edit page) ---- */
  const r1 = await tech.refreshOne(nextId);
  check('refreshing one listing detects its stack', r1.ok && r1.count >= 2, `count=${r1.count}`);
  check('detected stack names Next.js', JSON.stringify(r1.tech.map((t) => t.n)).includes('Next.js'));
  check('detected stack names Stripe', JSON.stringify(r1.tech.map((t) => t.n)).includes('Stripe'));
  check('a first scan reports the change', r1.changed === true);
  check('scan date is stamped', row(nextId).tech_checked_at === today, `stamped ${row(nextId).tech_checked_at}`);
  check('hiring link is captured', /greenhouse/.test(row(nextId).hiring_url || ''), row(nextId).hiring_url);

  const r1b = await tech.refreshOne(nextId);
  check('re-scanning an unchanged site reports no change', r1b.ok && r1b.changed === false);

  const r2 = await tech.refreshOne(wpId);
  check('CMS signatures are detected too', JSON.stringify(r2.tech.map((t) => t.n)).includes('WordPress'));

  const r3 = await tech.refreshOne(bareId);
  check('a plain homepage is reported honestly as empty', r3.ok && r3.count === 0);

  const r4 = await tech.refreshOne(offlineId);
  check('an unreachable homepage scans to zero instead of throwing', r4.ok && r4.count === 0);

  const r5 = await tech.refreshOne(noSiteId);
  check('a listing without a website is skipped, never counted as scanned',
    r5.ok === false && r5.skipped === 'no-website');
  check('skipping leaves no scan date', !row(noSiteId).tech_checked_at);

  const r6 = await tech.refreshOne(999999);
  check('a missing listing is skipped', r6.ok === false && r6.skipped === 'missing');

  /* ---- who is stale ---- */
  /* Wipe the slow listing's scan so the run below can prove "nothing stale"
     honestly, and give WP an outdated stack so the run has a real change. */
  await tech.refreshOne(slowId);
  const oldDay = new Date(Date.now() - (tech.STALE_DAYS + 5) * 86400000).toISOString().slice(0, 10);
  db.prepare('UPDATE listings SET tech = ?, tech_checked_at = ? WHERE id = ?')
    .run(JSON.stringify([{ n: 'Drupal', c: 'CMS' }]), oldDay, wpId);
  check('a snapshot older than the stale window is reported stale', tech.staleIds().includes(wpId));
  check('a listing with no website is never stale', !tech.staleIds().includes(noSiteId));
  const staleBefore = tech.staleCount();
  check('stale count covers never-scanned and outdated records',
    staleBefore === 1, `counted ${staleBefore}`);
  check('stale count matches the id list', staleBefore === tech.staleIds().length);

  /* ---- a bulk run over a selection ---- */
  const started = tech.start([nextId, wpId, bareId, noSiteId], 'selected');
  check('a run starts', started.ok === true && started.job.total === 4);
  check('starting two runs at once is refused', tech.start([nextId], 'selected').ok === false);
  const stateMid = tech.jobState();
  check('job state reports a live run', stateMid.running === true && stateMid.total === 4);

  for (let i = 0; i < 100 && tech.jobState().running; i++) await sleep(50);
  const done = tech.jobState();
  check('the run finishes', done.running === false && done.status === 'done', `status=${done.status}`);
  check('every queued listing was attempted', done.done === 4, `done=${done.done}`);
  check('listings without a website are counted as skipped, not failed',
    done.skipped === 1 && done.failed === 0, `skipped=${done.skipped} failed=${done.failed}`);
  check('a listing whose stack really changed is counted as changed',
    done.changed === 1 && done.unchanged === 2, JSON.stringify(done));
  check('the outdated stack was replaced', JSON.stringify(tech.parseTech(row(wpId).tech)).includes('WordPress'));
  check('nothing is stale right after a full run', tech.staleCount() === 0, `${tech.staleCount()} left`);

  const last = tech.lastRun();
  check('the run summary is persisted for the console', last && last.attempted === 4 && last.scope === 'selected');
  check('the summary is timestamped', !!(last && last.finished_at));

  /* ---- the whole directory ---- */
  const all = tech.allIds();
  check('"refresh everything" only queues listings with a website',
    all.length === 5 && !all.includes(noSiteId), `queued ${all.length}`);
  const counts = tech.counts();
  check('counts separate scanned from scannable',
    counts.withWebsite === 5 && counts.checked >= 4 && counts.stale === 0,
    JSON.stringify(counts));

  /* ---- cancellation ---- */
  tech.start([slowId, slowId], 'all');
  check('a slow run reports itself as running', tech.jobState().running === true);
  check('cancelling a running job is accepted', tech.cancel() === true);
  for (let i = 0; i < 200 && tech.jobState().running; i++) await sleep(50);
  const stopped = tech.jobState();
  check('a cancelled run ends as cancelled, not done', stopped.status === 'cancelled', `status=${stopped.status}`);
  check('cancelling twice is harmless', tech.cancel() === false);

  console.log('');
})()
/* ===================================================================== */
/* B. HTTP level                                                          */
/* ===================================================================== */
  .then(async function partB() {
    console.log('B. HTTP level\n');

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-tech-http-'));
    const PORT = 4400 + (process.pid % 400);
    const BASE = `http://127.0.0.1:${PORT}`;
    const token = 'tech' + crypto.randomBytes(16).toString('hex');
    const csrf = crypto.randomBytes(12).toString('hex');

    const seed = `
process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(dataDir)};
const { db } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
const run = (sql, ...p) => db.prepare(sql).run(...p);
const ins = db.prepare("INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,status,confidence) VALUES (?,?,?,?,'company','Technology',?,?,'Kenya',?,70)");
const a = ins.run('http-next','HTTP Next','Tagline','A seeded listing for the technology refresh HTTP test.','https://next.example','hi@next.example','approved').lastInsertRowid;
const b = ins.run('http-wp','HTTP WP','Tagline','A seeded listing for the technology refresh HTTP test.','https://wp.example','hi@wp.example','approved').lastInsertRowid;
const c = ins.run('http-bare','HTTP Bare','Tagline','A seeded listing for the technology refresh HTTP test.','https://bare.example','hi@bare.example','pending').lastInsertRowid;
const d = ins.run('http-nosite','HTTP No Site','Tagline','A seeded listing with no website.','','hi@nosite.example','approved').lastInsertRowid;
run("INSERT INTO sessions (token,user_id,csrf,kind,expires_at) VALUES (?,NULL,?,'admin',datetime('now','+1 day'))", ${JSON.stringify(token)}, ${JSON.stringify(csrf)});
console.log(JSON.stringify({ a: Number(a), b: Number(b), c: Number(c), d: Number(d) }));
`;
    const seeded = execFileSync(process.execPath, ['-e', seed], { cwd: ROOT, encoding: 'utf8' });
    const ids = JSON.parse(String(seeded).trim().split('\n').pop());
    const { a: idNext, b: idWp, c: idBare, d: idNoSite } = ids;

    const stubLog = path.join(dataDir, 'fetched.log');
    const env = {
      ...process.env,
      FIRMLEDGER_DATA_DIR: dataDir,
      PORT: String(PORT),
      BASE_URL: BASE,
      ADMIN_SECRET: 'tech-test-secret',
      SMTP_URL: 'smtp://user:pass@smtp.example.test:587',
      FETCH_STUB_LOG: stubLog,
      FETCH_STUB_DELAY_MS: '150',
    };
    delete env.FIRMLEDGER_DATA_DIR_A;

    const server = spawn(process.execPath, ['-r', STUB, 'server.js'], {
      cwd: ROOT, env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    server.stdout.on('data', (d) => { serverLog += d; });
    server.stderr.on('data', (d) => { serverLog += d; });

    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      try { const r = await realFetch(`${BASE}/healthz`).catch(() => null); if (r) up = true; } catch { /* wait */ }
      if (!up) await sleep(250);
    }
    if (!up) {
      check('server boots', false, serverLog.slice(-800));
      server.kill('SIGKILL');
      return finish(dataDir);
    }

    const adminCookie = { cookie: `fl_admin=${token}` };
    const readDb = () => new (require('better-sqlite3'))(path.join(dataDir, 'firmledger.db'), { readonly: true });

    /* ---- the page itself ---- */
    const page = await realFetch(`${BASE}/admin3119Musa/listings`, { headers: adminCookie });
    const html = await page.text();
    check('listings page renders', page.status === 200 && !/<h1>Server error/i.test(html), `HTTP ${page.status}`);
    check('the maintenance panel is on the page', /id="tech-maintenance"/.test(html));
    check('"refresh all in this view" is offered', /name="scope" value="view"/.test(html) && /Refresh all 4 in this view/.test(html));
    check('"refresh stale" is offered with its count', /name="scope" value="stale"/.test(html) && /Refresh \d+ stale/.test(html));
    check('"refresh the entire directory" is offered', /name="scope" value="all"/.test(html));
    check('every row can be selected, not only pending ones',
      (html.match(/name="ids" value="\d+" form="bulkForm"/g) || []).length === 4);
    check('each scannable row has its own refresh button',
      (html.match(/listings\/\d+\/refresh-tech/g) || []).length >= 3);
    check('the bulk select offers the technology refresh', /value="refresh_tech"/.test(html));
    check('the tech column shows who has never been scanned', /never<\/span>/.test(html));

    /* ---- the dashboard shortcut, while snapshots are still missing ---- */
    const dashStale = await (await realFetch(`${BASE}/admin3119Musa/dashboard`, { headers: adminCookie })).text();
    check('the dashboard surfaces radar maintenance while records are stale',
      /Technology radar maintenance/.test(dashStale) && /Refresh 3 stale/.test(dashStale));
    check('the dashboard links into the stale queue', /listings\?tech=stale/.test(dashStale));

    /* ---- one listing, straight from the row ---- */
    const one = await realFetch(`${BASE}/admin3119Musa/listings/${idNext}/refresh-tech`, {
      method: 'POST', redirect: 'manual',
      headers: { ...adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, f: 'status=approved' }).toString(),
    });
    check('a single refresh redirects', one.status === 302, `HTTP ${one.status}`);
    const loc = one.headers.get('location') || '';
    const locDecoded = decode(loc);
    check('it reports what it found', /ok=Technology radar refreshed — \d+ technolog/.test(locDecoded), locDecoded);
    check('it returns the admin to the filtered view', /status=approved/.test(loc), loc);
    {
      const ro = readDb();
      const r = ro.prepare('SELECT tech, tech_checked_at FROM listings WHERE id=?').get(idNext);
      check('the snapshot was written', JSON.parse(r.tech || '[]').length >= 2 && r.tech_checked_at === today,
        `${r.tech} @ ${r.tech_checked_at}`);
      ro.close();
    }

    /* ---- CSRF still guards the new routes ---- */
    const noCsrf = await realFetch(`${BASE}/admin3119Musa/listings/${idWp}/refresh-tech`, {
      method: 'POST', redirect: 'manual',
      headers: { ...adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'f=status=approved',
    });
    check('a refresh without CSRF is refused', noCsrf.status === 403, `HTTP ${noCsrf.status}`);

    /* ---- a selection, run in the background ---- */
    const bulk = await realFetch(`${BASE}/admin3119Musa/listings/bulk`, {
      method: 'POST', redirect: 'manual',
      headers: { ...adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: (() => {
        const p = new URLSearchParams({ _csrf: csrf, f: 'status=approved', bulk_action: 'refresh_tech' });
        p.append('ids', String(idWp));
        p.append('ids', String(idNoSite));
        return p.toString();
      })(),
    });
    const bulkLoc = decode(bulk.headers.get('location') || '');
    check('a selection refresh is accepted', bulk.status === 302 && /ok=Technology radar refresh started/.test(bulkLoc),
      bulkLoc || `HTTP ${bulk.status}`);
    const jobAfterBulk = await (await realFetch(`${BASE}/admin3119Musa/listings/tech-job.json`, { headers: adminCookie })).json();
    check('the progress endpoint reports the run',
      jobAfterBulk.job && jobAfterBulk.job.total === 2 && jobAfterBulk.job.scope === 'selected',
      JSON.stringify(jobAfterBulk.job));

    await waitForJob(BASE, adminCookie, 1);
    {
      const ro = readDb();
      const r = ro.prepare('SELECT tech, tech_checked_at FROM listings WHERE id=?').get(idWp);
      check('the selected listing was scanned', r.tech_checked_at === today && JSON.parse(r.tech || '[]').length >= 1);
      const n = ro.prepare('SELECT tech_checked_at FROM listings WHERE id=?').get(idNoSite);
      check('the website-less selection was left alone', !n.tech_checked_at);
      ro.close();
    }

    /* ---- refresh everything in the current view ---- */
    const viewRun = await realFetch(`${BASE}/admin3119Musa/listings/refresh-tech`, {
      method: 'POST', redirect: 'manual',
      headers: { ...adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, f: 'status=approved', scope: 'view' }).toString(),
    });
    check('"refresh this view" is accepted', viewRun.status === 302 && /ok=/.test(viewRun.headers.get('location') || ''),
      viewRun.headers.get('location') || `HTTP ${viewRun.status}`);
    const viewJob = await (await realFetch(`${BASE}/admin3119Musa/listings/tech-job.json`, { headers: adminCookie })).json();
    check('the view run queues exactly the filtered rows', viewJob.job.total === 3, JSON.stringify(viewJob.job));
    const settled = await waitForJob(BASE, adminCookie, 3);
    check('the view run reports every row it attempted', settled.attempted === 3 || settled.done === 3,
      JSON.stringify(settled));
    check('listings without a website are reported, not hidden', (settled.skipped || 0) === 1, JSON.stringify(settled));

    /* ---- the tech filter ---- */
    const fresh = await (await realFetch(`${BASE}/admin3119Musa/listings?tech=fresh`, { headers: adminCookie })).text();
    const never = await (await realFetch(`${BASE}/admin3119Musa/listings?tech=never`, { headers: adminCookie })).text();
    check('the fresh filter keeps the freshly scanned rows', /HTTP Next/.test(fresh) && !/Never scanned/.test(fresh.slice(fresh.indexOf('<tbody>'))));
    check('the never filter drops them', !/HTTP Next/.test(never));

    /* ---- the edit page refresh stays on the record ---- */
    const editRun = await realFetch(`${BASE}/admin3119Musa/listings/${idBare}/refresh-tech`, {
      method: 'POST', redirect: 'manual',
      headers: { ...adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, back: 'edit' }).toString(),
    });
    const editLoc = editRun.headers.get('location') || '';
    check('the edit page refresh returns to the record',
      editLoc.includes(`/admin3119Musa/listings/${idBare}/edit#tech`), editLoc);
    const editPage = await (await realFetch(`${BASE}/admin3119Musa/listings/${idBare}/edit`, { headers: adminCookie })).text();
    check('the edit page shows the radar panel', /id="tech"/.test(editPage) && /Technology radar/.test(editPage));
    check('the edit page reports the scan date', /Last scanned/.test(editPage));

    /* ---- the dashboard shortcut ---- */
    const dash = await (await realFetch(`${BASE}/admin3119Musa/dashboard`, { headers: adminCookie })).text();
    check('the dashboard keeps counting stale snapshots', /Stale tech scans/.test(dash));
    check('the dashboard hides the shortcut once everything is fresh', !/Technology radar maintenance/.test(dash));

    /* ---- the homepage was actually fetched, not faked ---- */
    const fetched = fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8') : '';
    check('the scanner really requested the homepages', /next\.example/.test(fetched) && /wp\.example/.test(fetched));

    server.kill('SIGKILL');
    return finish(dataDir, serverLog);
  })
  .catch((e) => {
    console.log('\nharness crashed:', e && e.stack);
    process.exit(1);
  });

async function waitForJob(BASE, headers, expected) {
  for (let i = 0; i < 200; i++) {
    const d = await (await realFetch(`${BASE}/admin3119Musa/listings/tech-job.json`, { headers })).json();
    if (d && d.job && !d.job.running) {
      if (expected && d.job.done < expected) return d.job;
      return Object.assign({}, d.job, d.last || {});
    }
    await sleep(150);
  }
  return { running: true };
}

let reported = false;
function finish(dataDir, serverLog) {
  if (reported) return;
  reported = true;
  console.log(`\n${'='.repeat(64)}`);
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  failures.forEach((f) => console.log('  • ' + f));
  if (failures.length && serverLog) console.log('\nserver log tail:\n' + serverLog.slice(-1500));
  console.log('='.repeat(64));
  try { if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(dataDirA, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
}
