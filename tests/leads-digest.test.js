/**
 * FirmLedger — conversion funnel + weekly leads digest test.
 *
 *   node tests/leads-digest.test.js
 *
 * Against a throwaway database:
 *   • recordImpressions: batched insert, bot/admin/owner/non-approved skips,
 *     unknown kinds rejected;
 *   • funnel: exposure → views → website clicks → leads → qualified → won
 *     over a day window, rates, and the shared headline sentence;
 *   • hasActivity: true on events or leads, false on silence;
 *   • sendWeeklyLeadDigests: fires when due, per-owner channel preferences
 *     (both / email / notification / none), quiet weeks silent, Pro gets the
 *     full funnel while Free gets a teaser that leaks no exact analytics, a
 *     second run sends nothing, force bypasses the due check.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-leads-digest-'));
process.env.FIRMLEDGER_DATA_DIR = dataDir;
process.env.BASE_URL = 'https://firmledger.test';
process.env.SMTP_URL = ''; // unconfigured mail → email channel skipped, notifications still send

const { db, getSetting } = require('../src/db');
const analytics = require('../src/lib/analytics');
const leads = require('../src/lib/leads');
const digest = require('../src/lib/leadsdigest');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

/* ------------------------------------------------------------- fixtures */
const FUTURE = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 19).replace('T', ' ');

function addUser(email, plan = 'free', pref = 'both') {
  return Number(db.prepare(
    `INSERT INTO users (email, password_hash, name, plan, plan_expires_at, leads_digest)
     VALUES (?, 'x', ?, ?, ?, ?)`
  ).run(email, email.split('@')[0], plan, plan === 'pro' ? FUTURE : '', pref).lastInsertRowid);
}
function addListing(over = {}) {
  const d = {
    slug: `ld-${Math.random().toString(36).slice(2, 9)}`, name: 'Test Co',
    tagline: 't', description: 'd', type: 'company', category: 'Technology',
    website: '', email: '', country: 'Kenya', city: 'Nairobi',
    status: 'approved', claimed: 0, confidence: 50, owner_user_id: null,
    sponsored: 0, sponsored_expires_at: '', featured: 0, ...over,
  };
  return Number(db.prepare(
    `INSERT INTO listings (slug, name, tagline, description, type, category, website, email,
      country, city, status, claimed, confidence, owner_user_id, sponsored,
      sponsored_expires_at, featured)
     VALUES (@slug, @name, @tagline, @description, @type, @category, @website, @email,
      @country, @city, @status, @claimed, @confidence, @owner_user_id, @sponsored,
      @sponsored_expires_at, @featured)`
  ).run(d).lastInsertRowid);
}
const getListing = (id) => db.prepare('SELECT * FROM listings WHERE id=?').get(id);
function fakeReq({ ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', user = null, admin = null } = {}) {
  return { headers: { 'user-agent': ua }, ip: '196.201.214.1', user, admin, get() { return ''; } };
}
const notifsFor = (uid) => db.prepare(
  "SELECT * FROM notifications WHERE audience='user' AND user_id=? ORDER BY id DESC"
).all(uid);

section('Impression recording');
{
  const oid = addUser('imp@test.dev', 'pro', 'none'); // opted out: must not receive the digest below
  const a = getListing(addListing({ slug: 'imp-a', owner_user_id: oid }));
  const b = getListing(addListing({ slug: 'imp-b', owner_user_id: oid }));
  const pending = getListing(addListing({ slug: 'imp-pend', status: 'pending' }));
  const count = (kind) => db.prepare(
    'SELECT COUNT(*) c FROM listing_stat_events WHERE kind=?'
  ).get(kind).c;

  const n = analytics.recordImpressions([a, b, pending], 'sponsored_impression', fakeReq({}));
  check('one batched insert records the approved cards', n === 2 && count('sponsored_impression') === 2, `n=${n}`);
  check('bots record nothing', analytics.recordImpressions([a], 'sponsored_impression', fakeReq({ ua: 'Googlebot/2.1' })) === 0);
  check('admins record nothing', analytics.recordImpressions([a], 'sponsored_impression', fakeReq({ admin: { via: 'x' } })) === 0);
  check("owners don't impress themselves", analytics.recordImpressions([a, b], 'featured_impression', fakeReq({ user: { id: oid } })) === 0);
  check('unknown kinds are rejected', analytics.recordImpressions([a], 'view', fakeReq({})) === 0);
  check('empty strips are a no-op', analytics.recordImpressions([], 'featured_impression', fakeReq({})) === 0);
  const other = getListing(addListing({ slug: 'imp-c' }));
  check('featured impressions record under their own kind',
    analytics.recordImpressions([other], 'featured_impression', fakeReq({})) === 1 && count('featured_impression') === 1);
}

section('Funnel aggregates + headline');
{
  const oid = addUser('fun@test.dev', 'pro', 'none'); // opted out: must not receive the digest below
  const lid = addListing({ slug: 'fun-co', owner_user_id: oid, claimed: 1 });
  const l = getListing(lid);
  const ins = db.prepare(
    `INSERT INTO listing_stat_events (listing_id, kind, city, country, visitor_hash, referrer, created_at)
     VALUES (?,?,?,?,?,?,?)`
  );
  const iso = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const now = new Date();
  const daysAgo = (n) => iso(new Date(now.getTime() - n * 864e5));
  // 10 sponsored + 6 featured impressions, 5 views, 2 website clicks (all fresh).
  for (let i = 0; i < 10; i++) ins.run(lid, 'sponsored_impression', '', '', `s${i}`, '/', iso(now));
  for (let i = 0; i < 6; i++) ins.run(lid, 'featured_impression', '', '', `f${i}`, '/', iso(now));
  for (let i = 0; i < 5; i++) ins.run(lid, 'view', 'Nairobi', 'Kenya', `v${i}`, '/directory', iso(now));
  for (let i = 0; i < 2; i++) ins.run(lid, 'website_click', '', '', `w${i}`, '', iso(now));
  // Stale events (60 days old) must not leak into the 30-day funnel.
  ins.run(lid, 'view', '', '', 'old', '', daysAgo(60));
  ins.run(lid, 'sponsored_impression', '', '', 'old2', '', daysAgo(60));
  // 4 leads: 1 qualified, 1 won, 1 new, 1 lost (1 stale lead excluded).
  const mk = (name, status, ago = 0) => {
    const r = leads.create({ listing: l, fields: { name, email: `${name}@example.com`, message: 'A proper inquiry message here.' } });
    if (ago) db.prepare('UPDATE leads SET created_at=? WHERE id=?').run(daysAgo(ago), r.id);
    if (status) leads.setStatus(r.id, oid, status);
    return r.id;
  };
  mk('ann', 'qualified'); mk('bob', 'won'); mk('cat', null); mk('dan', 'lost'); mk('eli', null, 60);

  const f = analytics.funnel([lid], 30);
  check('funnel counts exposure split', f.impressions === 16 && f.sponsoredImpressions === 10 && f.featuredImpressions === 6, JSON.stringify(f));
  check('funnel counts views + clicks', f.views === 5 && f.websiteClicks === 2);
  check('funnel counts leads by status',
    f.leads === 4 && f.byStatus.qualified === 1 && f.byStatus.won === 1 && f.byStatus.new === 1 && f.byStatus.lost === 1,
    JSON.stringify(f.byStatus));
  check('funnel rates are right', f.contactRate === 80 && f.qualifyRate === 50 && f.winRate === 25, JSON.stringify({ c: f.contactRate, q: f.qualifyRate, w: f.winRate }));
  check('7-day funnel is a subset view', analytics.funnel([lid], 7).views === 5);
  check('empty set funnels to zero', analytics.funnel([], 30).leads === 0 && analytics.funnel([], 30).contactRate === null);
  const h = analytics.funnelHeadline(f, 1);
  check('headline reads like the Pro pitch',
    h === 'Your FirmLedger listing generated 4 leads in the last 30 days, including 1 qualified lead and 1 won opportunity.',
    h);
  check('headline pluralises listings', analytics.funnelHeadline(f, 3).startsWith('Your FirmLedger listings generated 4 leads'));
  check('headline omits empty stages', analytics.funnelHeadline(analytics.funnel([], 30), 1) === 'Your FirmLedger listing generated 0 leads in the last 30 days.');

  check('hasActivity true on events+leads', analytics.hasActivity([lid], 7));
  const quiet = addListing({ slug: 'fun-quiet', owner_user_id: oid });
  check('hasActivity false on silence', !analytics.hasActivity([quiet], 7));
  check('hasActivity tolerates empty sets', !analytics.hasActivity([], 7));
}

(async () => {
  section('Weekly digest — channels, quiet weeks, Pro vs Free');
  // NOTE: no SMTP is configured in tests, so the email channel is skipped and
  // only in-app notifications are asserted. Channel preference is still fully
  // exercised: 'email'-only owners get nothing without SMTP, 'notification'
  // and 'both' owners get the in-app report, 'none' owners get silence.
  const proId = addUser('digest-pro@test.dev', 'pro', 'both');
  const freeId = addUser('digest-free@test.dev', 'free', 'both');
  const mailOnlyId = addUser('digest-mail@test.dev', 'pro', 'email');
  const notifOnlyId = addUser('digest-notif@test.dev', 'pro', 'notification');
  const offId = addUser('digest-off@test.dev', 'pro', 'none');
  const quietId = addUser('digest-quiet@test.dev', 'pro', 'both');

  const mkActive = (owner, slug, status) => {
    const id = addListing({ slug, owner_user_id: owner, claimed: 1 });
    analytics.recordView(getListing(id), fakeReq({}));
    const r = leads.create({
      listing: getListing(id),
      fields: { name: 'Inquirer Person', email: 'inq@example.com', message: 'Please send a detailed quotation.' },
    });
    if (status) leads.setStatus(r.id, owner, status);
    return id;
  };
  mkActive(proId, 'digest-pro-co', 'qualified');
  mkActive(freeId, 'digest-free-co', null); // stays new → the teaser reports it waiting
  mkActive(mailOnlyId, 'digest-mail-co', true);
  mkActive(notifOnlyId, 'digest-notif-co', true);
  mkActive(offId, 'digest-off-co', true);
  addListing({ slug: 'digest-quiet-co', owner_user_id: quietId }); // no activity

  const r1 = await digest.sendWeeklyLeadDigests(true);
  check('force run delivers to active owners', r1.sent === 3, JSON.stringify(r1));
  check('quiet weeks stay silent', r1.quiet >= 1 && notifsFor(quietId).length === 0, JSON.stringify(r1));
  check("'none' owners get nothing", notifsFor(offId).length === 0);
  check("'email'-only owners get nothing without SMTP", notifsFor(mailOnlyId).length === 0);

  const proN = notifsFor(proId);
  check('Pro owner gets the in-app report', proN.length === 1 && proN[0].kind === 'lead_digest');
  check('Pro report links analytics', proN.length === 1 && proN[0].url === '/dashboard/analytics');
  check('Pro report carries the funnel numbers',
    proN.length === 1 && /1 qualified/.test(proN[0].body) && /Last 7 days/.test(proN[0].body), proN[0] && proN[0].body);
  const freeN = notifsFor(freeId);
  check('Free owner gets the teaser', freeN.length === 1);
  check('teaser links the upgrade page', freeN.length === 1 && freeN[0].url === '/dashboard/upgrade');
  check('teaser leaks no exact analytics',
    freeN.length === 1 && !/\d+ profile view/.test(freeN[0].body) && !/Last 7 days:/.test(freeN[0].body) && /waiting/.test(freeN[0].body),
    freeN[0] && freeN[0].body);
  check("'notification'-only owners get the report", notifsFor(notifOnlyId).length === 1);
  check('last-sent is stamped', Boolean(Date.parse(getSetting('leads_digest_last_sent', ''))));

  const r2 = await digest.sendWeeklyLeadDigests(false);
  check('second run is a no-op (not due)', r2.sent === 0 && r2.reason === 'not_due', JSON.stringify(r2));
  check('no duplicate notifications', notifsFor(proId).length === 1);

  section('Stat-event retention');
  const lid = db.prepare('SELECT id FROM listings WHERE slug=?').get('fun-co').id;
  db.prepare(`INSERT INTO listing_stat_events (listing_id, kind, created_at) VALUES (?, 'view', datetime('now','-401 days'))`).run(lid);
  db.prepare(`INSERT INTO listing_stat_events (listing_id, kind, created_at) VALUES (?, 'view', datetime('now','-10 days'))`).run(lid);
  const before = db.prepare('SELECT COUNT(*) c FROM listing_stat_events WHERE listing_id=?').get(lid).c;
  const purged = analytics.purgeOldEvents();
  const after = db.prepare('SELECT COUNT(*) c FROM listing_stat_events WHERE listing_id=?').get(lid).c;
  check('purge removes only events past retention', purged === 1 && after === before - 1, `purged=${purged} ${before}→${after}`);
  check('recent events survive the purge',
    db.prepare("SELECT COUNT(*) c FROM listing_stat_events WHERE listing_id=? AND created_at >= datetime('now','-30 days')").get(lid).c >= 1);
  check('purge floor never touches reporting windows', analytics.purgeOldEvents(30) === 0);

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
