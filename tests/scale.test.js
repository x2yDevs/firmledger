/**
 * FirmLedger — realistic scale test for the fair-rotation bundle.
 *
 *   npm run test:scale
 *   SCALE_SPONSORED=800 SCALE_FEATURED=500 SCALE_ROUNDS=80 npm run test:scale
 *
 * NOT part of `npm test` (it boots a real server and hammers it for a minute
 * or two). Seeds hundreds of sponsored + Featured-eligible listings, then:
 *   • repeated homepage refreshes — rotation really rotates, no record is
 *     favoured (coverage + max-appearance bounds at HTTP level, chi-square
 *     uniformity at library level);
 *   • relevance — sponsored cards in directory/search/category always match
 *     the active filters;
 *   • concurrency — waves of simultaneous mixed requests, zero 500s;
 *   • repeated listing refreshes — views counted, lead posts accepted;
 *   • latency — per-endpoint avg/p95 table with generous budgets.
 *
 * Knobs (env): SCALE_SPONSORED (400), SCALE_FEATURED (300), SCALE_ORGANIC
 * (200), SCALE_ROUNDS (60 homepage rounds), SCALE_CONCURRENCY (16),
 * SCALE_PORT (3217).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const N_SPON = Math.max(50, parseInt(process.env.SCALE_SPONSORED || '400', 10));
const N_FEAT = Math.max(50, parseInt(process.env.SCALE_FEATURED || '300', 10));
const N_ORG = Math.max(20, parseInt(process.env.SCALE_ORGANIC || '200', 10));
const ROUNDS = Math.max(10, parseInt(process.env.SCALE_ROUNDS || '60', 10));
const CONC = Math.max(4, parseInt(process.env.SCALE_CONCURRENCY || '16', 10));
const PORT = parseInt(process.env.SCALE_PORT || '3217', 10);
const BASE = `http://127.0.0.1:${PORT}`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-scale-'));
process.env.FIRMLEDGER_DATA_DIR = dataDir;

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Latency ledger: endpoint -> [ms...] */
const lat = {};
function timed(key, ms) { (lat[key] = lat[key] || []).push(ms); }
async function get(p, ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ScaleTest/1.0') {
  const t0 = Date.now();
  const res = await fetch(BASE + p, { headers: { 'user-agent': ua } });
  const body = await res.text();
  timed(p.split('?')[0], Date.now() - t0);
  return { status: res.status, body };
}
function reportLat() {
  console.log('\n  endpoint latencies (ms):');
  for (const [k, v] of Object.entries(lat)) {
    const s = [...v].sort((a, b) => a - b);
    const avg = Math.round(s.reduce((a, b) => a + b, 0) / s.length);
    const p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
    console.log(`    ${k}: n=${s.length} avg=${avg} p95=${p95} max=${s[s.length - 1]}`);
  }
}
function p95Of(key) {
  const s = [...(lat[key] || [])].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : 0;
}

const featSlugs = (html) => [...html.matchAll(/l-card featured-card" href="\/listing\/([^"]+)"/g)].map((m) => m[1]);
const sponSlugs = (html) => [...html.matchAll(/l-card sponsor-card" href="\/listing\/([^"]+)"/g)].map((m) => m[1]);

(async () => {
  /* ---------------- seed ---------------- */
  section(`Seeding (${N_SPON} sponsored, ${N_FEAT} Featured-eligible, ${N_ORG} organic)`);
  const CATS = ['Software & SaaS', 'E-commerce & Retail', 'Travel & Hospitality', 'Health & Wellness', 'Finance & Investment'];
  const seed = `
process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(dataDir)};
const { db } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
const proId = db.prepare("INSERT INTO users (email,password_hash,name,plan,plan_expires_at) VALUES ('scale-pro@test.dev','x','Scale Pro','pro',date('now','+30 days'))").run().lastInsertRowid;
const ownId = db.prepare("INSERT INTO users (email,password_hash,name) VALUES ('scale-own@test.dev','x','Scale Owner')").run().lastInsertRowid;
const ins = db.prepare(\`INSERT INTO listings (slug,name,tagline,description,type,category,country,city,status,claimed,confidence,owner_user_id,sponsored,sponsored_expires_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)\`);
const CATS = ${JSON.stringify(CATS)};
for (let i = 0; i < ${N_SPON}; i++) {
  const tech = i % 2 === 0;
  ins.run('spon-' + i, (tech ? 'TechSponsor ' : 'Sponsor ') + i,
    tech ? 'tech services company' : 'general services company',
    'Seeded sponsored listing ' + i + ' for the scale test.', 'company',
    tech ? 'Software & SaaS' : CATS[1 + (i % (CATS.length - 1))],
    'Kenya', 'Nairobi', 'approved', 1, 60, ownId, 1, '');
}
for (let i = 0; i < ${N_FEAT}; i++) {
  ins.run('feat-' + i, 'Featured Co ' + i, 'pro owned company ' + i,
    'Seeded Featured-eligible listing ' + i + ' for the scale test.', 'company',
    CATS[i % CATS.length], 'Kenya', 'Nairobi', 'approved', 0, 55, proId, 0, '');
}
for (let i = 0; i < ${N_ORG}; i++) {
  ins.run('org-' + i, 'Organic Ltd ' + i, 'ordinary listing ' + i,
    'Seeded organic listing ' + i + ' for the scale test.', 'company',
    CATS[i % CATS.length], 'Kenya', 'Nairobi', 'approved', 0, 40, null, 0, '');
}
console.log('seeded');
`;
  const seedRes = spawnSync(process.execPath, ['-e', seed], { cwd: ROOT, encoding: 'utf8' });
  check('seed the scale database', seedRes.status === 0, (seedRes.stderr || '').slice(0, 300));
  if (seedRes.status !== 0) process.exit(1);

  // Library-level access to the same DB (WAL: concurrent readers are fine).
  const ad = require('../src/lib/advertising');

  /* ---------------- boot ---------------- */
  section('Booting the real server');
  const env = { ...process.env, PORT: String(PORT), BASE_URL: `http://127.0.0.1:${PORT}` };
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { const r = await fetch(BASE + '/'); if (r) up = true; } catch { /* not yet */ }
    if (!up) await sleep(250);
  }
  check('server boots with the seeded data', up, serverLog.slice(-500));
  if (!up) { server.kill('SIGKILL'); process.exit(1); }

  try {
    /* ---------------- rotation fairness (HTTP) ---------------- */
    section(`Homepage rotation over ${ROUNDS} refreshes`);
    const featSeen = new Map();
    const sponSeen = new Map();
    let ok200 = 0, eight = 0, twelve = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const { status, body } = await get('/');
      if (status !== 200) continue;
      ok200++;
      const f = featSlugs(body);
      const s = sponSlugs(body).slice(0, 12); // marquee renders the draw twice
      if (f.length === 8) eight++;
      if (new Set(s).size === 12) twelve++;
      for (const slug of f) featSeen.set(slug, (featSeen.get(slug) || 0) + 1);
      for (const slug of new Set(s)) sponSeen.set(slug, (sponSeen.get(slug) || 0) + 1);
    }
    check('every refresh renders 200', ok200 === ROUNDS, `${ok200}/${ROUNDS}`);
    check('every refresh shows exactly 8 featured cards', eight === ROUNDS, `${eight}/${ROUNDS}`);
    check('every refresh shows 12 distinct sponsored cards', twelve === ROUNDS, `${twelve}/${ROUNDS}`);
    // Coupon-collector expectation for a uniform draw: N*(1-e^(-slots/N)).
    // Anything ≥80% of that expectation rules out a stuck/biased rotation.
    const expCover = (n, slots) => n * (1 - Math.exp(-slots / n));
    check('featured rotation covers the pool',
      featSeen.size >= Math.min(N_FEAT, expCover(N_FEAT, ROUNDS * 8) * 0.8),
      `${featSeen.size}/${N_FEAT} seen (uniform expectation ~${Math.round(expCover(N_FEAT, ROUNDS * 8))})`);
    check('sponsored rotation covers the pool',
      sponSeen.size >= Math.min(N_SPON, expCover(N_SPON, ROUNDS * 12) * 0.8),
      `${sponSeen.size}/${N_SPON} seen (uniform expectation ~${Math.round(expCover(N_SPON, ROUNDS * 12))})`);
    const featMax = Math.max(...featSeen.values());
    const sponMax = Math.max(...sponSeen.values());
    // Expected appearances per record: ROUNDS*8/N_FEAT ≈ 1.6, ROUNDS*12/N_SPON ≈ 1.8.
    // Anything ≤10 rules out systematic favouritism with huge margin.
    check('no featured record is favoured', featMax <= 10, `max appearances: ${featMax} (expected ~${(ROUNDS * 8 / N_FEAT).toFixed(1)})`);
    check('no sponsored record is favoured', sponMax <= 10, `max appearances: ${sponMax} (expected ~${(ROUNDS * 12 / N_SPON).toFixed(1)})`);

    /* ---------------- uniformity (library, chi-square) ---------------- */
    section('Chi-square uniformity of the sponsored draw');
    {
      const pool = db_prepare_ids();
      const DRAWS = 400, K = 12;
      const counts = new Map(pool.map((id) => [id, 0]));
      let foreign = 0;
      for (let i = 0; i < DRAWS; i++) {
        for (const l of ad.sponsoredStrip(K)) {
          if (counts.has(l.id)) counts.set(l.id, counts.get(l.id) + 1);
          else foreign++;
        }
      }
      const E = (DRAWS * K) / pool.length;
      let chi2 = 0;
      let covered = 0;
      for (const c of counts.values()) { chi2 += ((c - E) ** 2) / E; if (c > 0) covered++; }
      check('draws only ever return active pool members', foreign === 0, `${foreign} foreign`);
      check('coverage is (near-)complete', covered / pool.length >= 0.99, `${covered}/${pool.length}`);
      // χ² over k buckets: mean ≈ k, sd ≈ √(2k). Threshold = mean + 7σ —
      // a uniform draw never lands there; a stuck/favouring draw always does.
      const chiLimit = pool.length + 7 * Math.sqrt(2 * pool.length);
      check('chi-square shows a uniform draw', chi2 < chiLimit, `χ²=${chi2.toFixed(1)} over ${pool.length} buckets (limit ${Math.round(chiLimit)})`);
    }

    /* ---------------- relevance ---------------- */
    section('Sponsored relevance under filters');
    {
      const techRe = /^spon-(\d+)$/;
      const isTechSpon = (slug) => { const m = techRe.exec(slug); return m && Number(m[1]) % 2 === 0; };
      const dir = await get('/directory?category=' + encodeURIComponent('Software & SaaS'));
      check('directory renders', dir.status === 200);
      const dirSpon = [...new Set(sponSlugs(dir.body))];
      check('directory sponsored matches the category filter',
        dirSpon.length > 0 && dirSpon.every(isTechSpon), `${dirSpon.length} cards: ${dirSpon.slice(0, 3).join(',')}`);
      const sea = await get('/search?q=' + encodeURIComponent('tech services'));
      check('search renders', sea.status === 200);
      const seaSpon = [...sea.body.matchAll(/search-row--sponsored" href="\/listing\/([^"]+)"/g)].map((m) => m[1]);
      check('search sponsored matches the query',
        seaSpon.length > 0 && seaSpon.every(isTechSpon), `${seaSpon.length} cards: ${seaSpon.slice(0, 3).join(',')}`);
      const cat = await get('/directory/c/software-saas');
      check('category page renders', cat.status === 200);
      const catSpon = [...new Set(sponSlugs(cat.body))];
      check('category sponsored matches the category',
        catSpon.length > 0 && catSpon.every(isTechSpon), `${catSpon.length} cards: ${catSpon.slice(0, 3).join(',')}`);
    }

    /* ---------------- concurrency ---------------- */
    section(`${CONC} simultaneous users × 4 waves`);
    {
      const urls = ['/', '/directory', '/directory?page=3', '/search?q=company',
        '/directory/c/software-saas', '/listing/spon-0', '/listing/feat-5', '/pricing', '/blog'];
      let bad = 0, total = 0;
      for (let w = 0; w < 4; w++) {
        const batch = [];
        for (let i = 0; i < CONC; i++) batch.push(urls[(w * CONC + i) % urls.length]);
        const res = await Promise.all(batch.map((u) => get(u).catch(() => ({ status: 0, body: '' }))));
        for (const r of res) { total++; if (r.status !== 200) bad++; }
      }
      check('zero failed responses under concurrency', bad === 0, `${bad}/${total} non-200`);
    }

    /* ---------------- repeated refreshes + lead post ---------------- */
    section('Repeated refreshes + inquiry under load');
    {
      const before = JSON.parse(countEvents());
      for (let i = 0; i < 25; i++) await get('/listing/spon-2');
      const after = JSON.parse(countEvents());
      check('25 refreshes record 25 views', after.views - before.views === 25, `+${after.views - before.views}`);
      const post = await fetch(BASE + '/listing/spon-2/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 ScaleTest/1.0' },
        body: new URLSearchParams({
          name: 'Scale Prospect', email: 'prospect-scale@test.dev', subject: 'Bulk order',
          message: 'We would like a bulk quotation for five hundred units, please.',
          company_site: '',
        }).toString(),
        redirect: 'manual',
      });
      check('inquiry post accepted (302 → lead_sent)',
        post.status === 302 && String(post.headers.get('location') || '').includes('lead_sent=1'),
        `status=${post.status}`);
    }

    /* ---------------- latency budgets ---------------- */
    section('Latency budgets');
    reportLat();
    for (const [k, budget] of [['/', 3000], ['/directory', 3000], ['/search', 3000], ['/listing/spon-2', 3000]]) {
      check(`p95 ${k} under ${budget}ms`, p95Of(k) < budget, `${p95Of(k)}ms`);
    }
  } finally {
    server.kill('SIGKILL');
  }

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }

  /* Helpers that query the seeded DB from this process. */
  function db_prepare_ids() {
    const { db } = require('../src/db');
    return db.prepare("SELECT id FROM listings WHERE status='approved' AND sponsored=1 AND (sponsored_expires_at='' OR sponsored_expires_at >= date('now'))")
      .all().map((r) => r.id);
  }
  function countEvents() {
    const { db } = require('../src/db');
    const lid = db.prepare('SELECT id FROM listings WHERE slug=?').get('spon-2').id;
    const views = db.prepare("SELECT COUNT(*) c FROM listing_stat_events WHERE listing_id=? AND kind='view'").get(lid).c;
    return JSON.stringify({ views });
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
