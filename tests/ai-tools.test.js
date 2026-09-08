/**
 * FirmLedger — AI Playground admin-tool conformance test.
 *
 *   node tests/ai-tools.test.js
 *
 * Every tool the admin assistant can call is executed for real against a
 * throwaway database (FIRMLEDGER_DATA_DIR) and the resulting *database state*
 * is asserted. A tool that merely returns a happy-looking object without
 * changing anything fails here — the assistant must never claim work it did
 * not do.
 *
 * No network and no Groq key are required: the tools themselves are pure
 * server-side operations; only the natural-language wrapper needs Groq.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-tools-'));
process.env.FIRMLEDGER_DATA_DIR = tmp;
process.env.BASE_URL = process.env.BASE_URL || 'https://firmledger.test';
process.env.SMTP_URL = '';           // mail lands in the outbox log, never the wire
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || '';

const { db, getSetting, setSetting } = require('../src/db');
const tools = require('../src/lib/aitools');

/* ---------------------------------------------------------------- harness */
let passed = 0;
const failures = [];
const covered = new Set();

function fmt(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 160 ? s.slice(0, 160) + '…' : s;
}

/** Run one tool and assert both the envelope and the real database effect. */
async function tool(name, args, verify, opts = {}) {
  covered.add(name);
  let res;
  try {
    res = await tools.execute(name, args);
  } catch (e) {
    failures.push({ name, why: 'threw: ' + e.message });
    console.log(`  ✗ ${name} — threw ${e.message}`);
    return null;
  }
  const wantOk = opts.expectFail ? false : true;
  if (Boolean(res.ok) !== wantOk) {
    failures.push({ name, why: `expected ok=${wantOk}, got ${fmt(res.error || res.result)}` });
    console.log(`  ✗ ${name} — ${fmt(res.error || JSON.stringify(res))}`);
    return res;
  }
  if (verify) {
    let why = null;
    try { why = verify(res.result, res); } catch (e) { why = 'verify threw: ' + e.message; }
    if (why) {
      failures.push({ name, why });
      console.log(`  ✗ ${name} — ${why}`);
      return res;
    }
  }
  passed++;
  console.log(`  ✓ ${name}`);
  return res;
}

function section(title) { console.log(`\n${title}`); }
const one = (sql, ...p) => db.prepare(sql).get(...p);
const count = (sql, ...p) => (db.prepare(sql).get(...p) || {}).c || 0;

/* ---------------------------------------------------------------- fixtures */
function seed() {
  const now = new Date().toISOString();
  const mkUser = (email, name, plan = 'free') => db.prepare(
    "INSERT INTO users (email, password_hash, name, plan, plan_expires_at, created_at) VALUES (?,?,?,?,'',?)"
  ).run(email, '$2a$10$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV', name, plan, now).lastInsertRowid;

  const owner = mkUser('owner@example.com', 'Owner One');
  const member = mkUser('member@example.com', 'Member Two');
  const proUser = mkUser('pro@example.com', 'Pro Three', 'pro');

  const mkListing = (slug, name, status = 'pending', extra = {}) => db.prepare(
    `INSERT INTO listings (slug, name, tagline, description, type, category, website, email, country, status, owner_user_id, created_at, updated_at)
     VALUES (?,?,?,?,'company',?,?,?,'Kenya',?,?,datetime('now'),datetime('now'))`
  ).run(
    slug, name, `${name} tagline for the ledger`,
    `${name} is a verified organisation used by the FirmLedger admin-tool conformance test suite. It exists only inside a throwaway database.`,
    extra.category || 'Technology', `https://${slug}.example.com`, `hello@${slug}.example.com`,
    status, extra.owner === undefined ? owner : extra.owner,
  ).lastInsertRowid;

  const alpha = mkListing('alpha-labs', 'Alpha Labs', 'pending');
  const beta = mkListing('beta-works', 'Beta Works', 'pending');
  const gamma = mkListing('gamma-group', 'Gamma Group', 'approved');
  const delta = mkListing('delta-co', 'Delta Co', 'approved');
  const epsilon = mkListing('epsilon-ltd', 'Epsilon Ltd', 'approved');
  const zeta = mkListing('zeta-holdings', 'Zeta Holdings', 'approved');

  const ticket = db.prepare(
    "INSERT INTO tickets (user_id, ref, subject, category, status) VALUES (?,?,?,?,'open')"
  ).run(member, 'FL-TEST01', 'Cannot update my listing logo', 'account').lastInsertRowid;

  const claim = db.prepare(
    "INSERT INTO claims (listing_id, user_id, method, domain, token, status) VALUES (?,?,'dns',?,?,'pending')"
  ).run(gamma, member, 'gamma-group.example.com', 'firmledger-verify-token-test').lastInsertRowid;

  const removal = db.prepare(
    "INSERT INTO removal_requests (listing_id, name, email, reason, status) VALUES (?,?,?,?,'pending')"
  ).run(zeta, 'Zeta Legal', 'legal@zeta.example.com', 'Company closed down.').lastInsertRowid;

  const transfer = db.prepare(
    "INSERT INTO pro_transfer_requests (user_id, from_listing_id, to_listing_id, status) VALUES (?,?,?,'pending')"
  ).run(owner, delta, epsilon).lastInsertRowid;
  db.prepare("UPDATE listings SET plan='pro', plan_expires_at='2030-01-01' WHERE id=?").run(delta);

  db.prepare("INSERT OR IGNORE INTO newsletter_subscribers (email, active) VALUES ('sub@example.com', 1)").run();

  return { owner, member, proUser, alpha, beta, gamma, delta, epsilon, zeta, ticket, claim, removal, transfer };
}

/* ---------------------------------------------------------------- the run */
(async function main() {
  console.log(`FirmLedger AI admin-tool conformance suite\ndata dir: ${tmp}\n`);
  const f = seed();

  /* ============================ Lookups ============================ */
  section('Lookups (read-only)');
  await tool('get_listing_stats', {}, (r) => {
    if (r.total_listings !== count('SELECT COUNT(*) c FROM listings')) return 'total_listings does not match the table';
    if (r.pending !== count("SELECT COUNT(*) c FROM listings WHERE status='pending'")) return 'pending count wrong';
    if (r.users !== count('SELECT COUNT(*) c FROM users')) return 'user count wrong';
    return null;
  });
  await tool('get_health', {}, (r) => (r && (r.uptime || r.memory) ? null : 'no health snapshot returned'));
  await tool('search_listings', { q: 'alpha' }, (r) => (r.count === 1 && r.listings[0].slug === 'alpha-labs' ? null : 'did not find Alpha Labs'));
  await tool('search_listings', { q: 'a', status: '' }, null, { expectFail: true });
  await tool('search_users', { q: 'member@example.com' }, (r) => (r.count === 1 && r.users[0].id === f.member ? null : 'member lookup failed'));
  await tool('search_users', { q: String(f.owner) }, (r) => (r.count === 1 && r.users[0].email === 'owner@example.com' ? null : 'id lookup failed'));
  await tool('search_admin', { q: 'example' }, (r) => (r.users.length && r.listings.length ? null : 'global search returned nothing'));
  await tool('list_open_tickets', {}, (r) => (r.count === 1 && r.tickets[0].ref === 'FL-TEST01' ? null : 'open ticket missing'));
  await tool('list_pending_claims', {}, (r) => (r.count === 1 && r.claims[0].id === f.claim ? null : 'pending claim missing'));
  await tool('list_pending_removals', {}, (r) => (r.count === 1 && r.removals[0].id === f.removal ? null : 'pending removal missing'));

  /* ============================ Listings ============================ */
  section('Listings');
  await tool('approve_listing', { id_or_slug: 'alpha-labs' }, () => (
    one('SELECT status FROM listings WHERE id=?', f.alpha).status === 'approved' ? null : 'listing not approved in DB'));
  await tool('reject_listing', { id_or_slug: String(f.beta) }, () => (
    one('SELECT status FROM listings WHERE id=?', f.beta).status === 'rejected' ? null : 'listing not rejected in DB'));
  await tool('approve_listing', { id_or_slug: 'no-such-listing' }, null, { expectFail: true });

  db.prepare("UPDATE listings SET status='pending' WHERE id IN (?,?)").run(f.alpha, f.beta);
  await tool('accept_all_pending_listings', {}, () => (
    count("SELECT COUNT(*) c FROM listings WHERE status='pending'") === 0 ? null : 'pending listings remain'));

  /* Technology radar refresh — canned homepages, no network, fetch restored after. */
  const savedFetch = globalThis.fetch;
  require('./helpers/fetch-stub.js');
  const scannedToday = new Date().toISOString().slice(0, 10);
  await tool('refresh_listing_tech', { id_or_slug: 'gamma-group' }, () => (
    one('SELECT tech_checked_at FROM listings WHERE id=?', f.gamma).tech_checked_at === scannedToday
      ? null : 'technology scan date not stamped in DB'));
  await tool('refresh_listing_tech', { id_or_slug: 'no-such-listing' }, null, { expectFail: true });
  db.prepare("UPDATE listings SET website='' WHERE id=?").run(f.zeta);
  await tool('refresh_listing_tech', { id_or_slug: 'zeta-holdings' }, null, { expectFail: true });
  db.prepare('UPDATE listings SET website=? WHERE id=?').run('https://zeta-holdings.example.com', f.zeta);
  globalThis.fetch = savedFetch;

  await tool('feature_listing', { id_or_slug: 'gamma-group', featured: true }, () => (
    one('SELECT featured FROM listings WHERE id=?', f.gamma).featured === 1 ? null : 'featured flag not set'));
  await tool('feature_listing', { id_or_slug: 'gamma-group' }, () => (
    one('SELECT featured FROM listings WHERE id=?', f.gamma).featured === 0 ? null : 'toggle did not clear featured'));

  await tool('set_listing_owner', { id_or_slug: 'gamma-group', user: 'member@example.com' }, () => (
    one('SELECT owner_user_id FROM listings WHERE id=?', f.gamma).owner_user_id === f.member ? null : 'owner not transferred'));
  await tool('set_listing_owner', { id_or_slug: 'gamma-group', user: '' }, () => (
    one('SELECT owner_user_id, claimed FROM listings WHERE id=?', f.gamma).owner_user_id === null ? null : 'owner not cleared'));
  db.prepare('UPDATE listings SET owner_user_id=? WHERE id=?').run(f.owner, f.gamma);

  await tool('grant_listing_pro', { id_or_slug: 'gamma-group', days: 30 }, () => {
    const l = one('SELECT plan, plan_expires_at FROM listings WHERE id=?', f.gamma);
    return l.plan === 'pro' && l.plan_expires_at > new Date().toISOString().slice(0, 10) ? null : 'listing Pro not applied';
  });
  await tool('revoke_listing_pro', { id_or_slug: 'gamma-group' }, () => (
    one('SELECT plan FROM listings WHERE id=?', f.gamma).plan === 'free' ? null : 'listing Pro not revoked'));
  await tool('grant_listing_pro', { id_or_slug: 'gamma-group', lifetime: true }, () => {
    const l = one('SELECT plan, plan_expires_at FROM listings WHERE id=?', f.gamma);
    return l.plan === 'pro' && !l.plan_expires_at ? null : 'lifetime Pro not applied';
  });

  await tool('sponsor_listing', { id_or_slug: 'gamma-group', days: 14 }, () => (
    one('SELECT sponsored FROM listings WHERE id=?', f.gamma).sponsored === 1 ? null : 'sponsorship not recorded'));
  await tool('unsponsor_listing', { id_or_slug: 'gamma-group' }, () => (
    one('SELECT sponsored FROM listings WHERE id=?', f.gamma).sponsored === 0 ? null : 'sponsorship not removed'));

  await tool('create_category', { name: 'Conformance Testing' }, () => (
    one('SELECT id FROM categories WHERE name=?', 'Conformance Testing') ? null : 'category row missing'));
  db.prepare('UPDATE listings SET category=? WHERE id=?').run('Conformance Testing', f.delta);
  await tool('rename_category', { from: 'Conformance Testing', to: 'Conformance QA' }, () => {
    if (!one('SELECT id FROM categories WHERE name=?', 'Conformance QA')) return 'renamed category missing';
    return one('SELECT category FROM listings WHERE id=?', f.delta).category === 'Conformance QA' ? null : 'listings not moved';
  });
  await tool('delete_category', { name: 'Conformance QA' }, () => {
    if (one('SELECT id FROM categories WHERE name=?', 'Conformance QA')) return 'category still present';
    return one('SELECT category FROM listings WHERE id=?', f.delta).category === 'Other' ? null : 'listings not moved to Other';
  });

  /* ============================ Users & billing ============================ */
  section('Users & billing');
  await tool('suspend_user', { user: 'member@example.com' }, () => (
    one('SELECT suspended FROM users WHERE id=?', f.member).suspended === 1 ? null : 'user not suspended'));
  await tool('unsuspend_user', { user: 'member@example.com' }, () => (
    one('SELECT suspended FROM users WHERE id=?', f.member).suspended === 0 ? null : 'user not reinstated'));

  await tool('grant_user_pro', { user: 'member@example.com', days: 30 }, () => {
    const u = one('SELECT plan, plan_expires_at FROM users WHERE id=?', f.member);
    return u.plan === 'pro' && u.plan_expires_at ? null : 'account Pro not granted';
  });
  await tool('revoke_user_pro', { user: 'member@example.com' }, () => (
    one('SELECT plan FROM users WHERE id=?', f.member).plan === 'free' ? null : 'account Pro not revoked'));
  await tool('grant_user_pro', { user: 'member@example.com', lifetime: true }, () => {
    const u = one('SELECT plan, plan_expires_at FROM users WHERE id=?', f.member);
    return u.plan === 'pro' && !u.plan_expires_at ? null : 'lifetime Pro not granted';
  });
  await tool('revoke_user_pro', { user: 'member@example.com' });

  await tool('grant_trial', { user: 'member@example.com', days: 7 }, () => (
    one('SELECT trial_expires_at FROM users WHERE id=?', f.member).trial_expires_at ? null : 'trial not started'));
  await tool('revoke_trial', { user: 'member@example.com' }, () => (
    !one('SELECT trial_expires_at FROM users WHERE id=?', f.member).trial_expires_at ? null : 'trial not revoked'));

  await tool('send_password_reset', { user: 'member@example.com' }, () => (
    one('SELECT token FROM resets WHERE email=?', 'member@example.com') ? null : 'no reset token stored'));

  await tool('create_plan_offer', { name: 'QA Monthly', price_usd: 9.5, duration_days: 30, blurb: 'Test offer' }, () => {
    const p = one('SELECT * FROM plans WHERE name=?', 'QA Monthly');
    if (!p) return 'plan offer not inserted';
    return p.price_cents === 950 && p.duration_days === 30 && p.active === 1 ? null : 'plan offer stored wrong';
  });
  const qaPlan = one('SELECT * FROM plans WHERE name=?', 'QA Monthly');
  await tool('toggle_plan_offer', { id: qaPlan.id }, () => (
    one('SELECT active FROM plans WHERE id=?', qaPlan.id).active === 0 ? null : 'offer not hidden'));

  await tool('approve_pro_transfer', { id: f.transfer }, () => {
    const req = one('SELECT status FROM pro_transfer_requests WHERE id=?', f.transfer);
    const to = one('SELECT plan FROM listings WHERE id=?', f.epsilon);
    const from = one('SELECT plan FROM listings WHERE id=?', f.delta);
    if (req.status !== 'approved') return 'request not marked approved';
    return to.plan === 'pro' && from.plan === 'free' ? null : 'Pro not moved between listings';
  });
  const transfer2 = db.prepare(
    "INSERT INTO pro_transfer_requests (user_id, from_listing_id, to_listing_id, status) VALUES (?,?,?,'pending')"
  ).run(f.owner, f.epsilon, f.delta).lastInsertRowid;
  await tool('reject_pro_transfer', { id: transfer2 }, () => (
    one('SELECT status FROM pro_transfer_requests WHERE id=?', transfer2).status === 'rejected' ? null : 'request not rejected'));

  /* ============================ Claims, tickets, removals ============================ */
  section('Claims, tickets, removals');
  await tool('recheck_claim', { id: f.claim }, (r) => (typeof r.verified === 'boolean' ? null : 'no verification verdict returned'));
  if (one('SELECT status FROM claims WHERE id=?', f.claim).status !== 'pending') {
    db.prepare("UPDATE claims SET status='pending' WHERE id=?").run(f.claim);
  }
  await tool('reject_claim', { id: f.claim }, () => (
    one('SELECT status FROM claims WHERE id=?', f.claim).status === 'rejected' ? null : 'claim not rejected'));

  await tool('reply_ticket', { id_or_ref: 'FL-TEST01', message: 'Thanks — we have re-uploaded the logo for you.' }, () => (
    count('SELECT COUNT(*) c FROM ticket_messages WHERE ticket_id=?', f.ticket) === 1 ? null : 'reply not stored'));
  await tool('set_ticket_status', { id_or_ref: String(f.ticket), status: 'solved' }, () => (
    one('SELECT status FROM tickets WHERE id=?', f.ticket).status === 'solved' ? null : 'status not set'));
  await tool('set_ticket_status', { id_or_ref: 'FL-TEST01', status: 'closed' }, () => (
    one('SELECT status FROM tickets WHERE id=?', f.ticket).status === 'closed' ? null : 'status not closed'));

  const removal2 = db.prepare(
    "INSERT INTO removal_requests (listing_id, name, email, reason, status) VALUES (?,?,?,?,'pending')"
  ).run(f.epsilon, 'Eps Legal', 'legal@epsilon.example.com', 'Duplicate record.').lastInsertRowid;
  await tool('dismiss_removal', { id: removal2 }, () => (
    one('SELECT status FROM removal_requests WHERE id=?', removal2).status === 'dismissed' ? null : 'not dismissed'));
  await tool('fulfill_removal', { id: f.removal }, () => {
    if (one('SELECT id FROM listings WHERE id=?', f.zeta)) return 'listing was not deleted';
    return one('SELECT status FROM removal_requests WHERE id=?', f.removal).status === 'removed' ? null : 'request not closed';
  });

  /* News moderation — a member-submitted story, then the assistant's verdict. */
  const newsLib = require('../src/lib/news.js');
  const submitted = newsLib.submit({
    listing: one('SELECT * FROM listings WHERE id=?', f.gamma),
    user: one('SELECT * FROM users WHERE id=?', f.member),
    title: 'Gamma Group signs a nationwide distribution deal',
    url: 'https://newsroom.example/gamma/distribution', source: 'Business Daily',
    published_at: '2026-05-02',
  });
  await tool('approve_news', { id: String(submitted.id) }, () => (
    one('SELECT status FROM listing_news WHERE id=?', submitted.id).status === 'approved' ? null : 'story not approved in DB'));
  await tool('approve_news', { id: '999999' }, null, { expectFail: true });

  const submitted2 = newsLib.submit({
    listing: one('SELECT * FROM listings WHERE id=?', f.gamma),
    user: one('SELECT * FROM users WHERE id=?', f.member),
    title: 'Gamma Group rumoured to be raising again', url: 'https://rumour.example/gamma',
  });
  await tool('reject_news', { id: String(submitted2.id) }, () => (
    one('SELECT status FROM listing_news WHERE id=?', submitted2.id).status === 'rejected' ? null : 'story not rejected in DB'));

  /* ============================ Content ============================ */
  section('Content');
  await tool('email_users', { audience: 'all', subject: 'Ledger maintenance', message: 'A short scheduled-maintenance note for every member.' },
    (r) => (r.queued === count('SELECT COUNT(*) c FROM users') ? null : 'wrong recipient count'));
  await tool('email_users', { audience: 'nobody@nowhere.example', subject: 'x', message: 'A message body long enough.' }, null, { expectFail: true });
  await tool('email_all_users', { subject: 'Everyone', message: 'A broadcast to the whole member base.' },
    (r) => (r.queued === count('SELECT COUNT(*) c FROM users') ? null : 'broadcast recipient count wrong'));

  await tool('create_blog_post', { title: 'How FirmLedger verifies companies', body: 'Body copy for the conformance suite.', status: 'published' }, () => {
    const p = one("SELECT * FROM blog_posts WHERE slug='how-firmledger-verifies-companies'");
    return p && p.status === 'published' && p.published_at ? null : 'post not published';
  });
  await tool('toggle_blog_post', { id_or_slug: 'how-firmledger-verifies-companies' }, () => (
    one("SELECT status FROM blog_posts WHERE slug='how-firmledger-verifies-companies'").status === 'draft' ? null : 'toggle failed'));
  await tool('delete_blog_post', { id_or_slug: 'how-firmledger-verifies-companies' }, () => (
    !one("SELECT id FROM blog_posts WHERE slug='how-firmledger-verifies-companies'") ? null : 'post not deleted'));

  await tool('create_promo', { code: 'QA25', percent: 25, max_uses: 10, note: 'suite' }, () => {
    const p = one("SELECT * FROM promo_codes WHERE code='QA25'");
    return p && p.percent === 25 && p.active === 1 ? null : 'promo not created';
  });
  await tool('toggle_promo', { code_or_id: 'QA25' }, () => (
    one("SELECT active FROM promo_codes WHERE code='QA25'").active === 0 ? null : 'promo not deactivated'));

  await tool('create_career', {
    title: 'Data Verification Analyst', location: 'Nairobi', role_type: 'Full-time',
    description: 'Verify company records and keep the ledger accurate every single day.',
    requirements: 'Attention to detail; two years of research experience.',
  }, () => (one("SELECT id FROM careers WHERE title='Data Verification Analyst'") ? null : 'career not created'));
  const career = one("SELECT * FROM careers WHERE title='Data Verification Analyst'");
  await tool('toggle_career', { id: career.id }, () => (
    one('SELECT status FROM careers WHERE id=?', career.id).status === 'closed' ? null : 'career not closed'));

  /* ============================ Ops ============================ */
  section('Site operations');
  await tool('set_maintenance_mode', { on: true, title: 'Scheduled upkeep', message: 'Back in an hour.' }, () => (
    getSetting('maintenance_on', '0') === '1' && getSetting('maintenance_title', '') === 'Scheduled upkeep'
      ? null : 'maintenance settings not stored'));
  await tool('set_maintenance_mode', { on: false }, () => (getSetting('maintenance_on', '1') === '0' ? null : 'maintenance not lifted'));
  await tool('set_auto_approve', { on: true }, () => (getSetting('auto_approve', '0') === '1' ? null : 'auto_approve not set'));
  await tool('set_auto_approve', { on: false }, () => (getSetting('auto_approve', '1') === '0' ? null : 'auto_approve not cleared'));
  await tool('set_ai_moderation', { on: true }, () => (getSetting('ai_moderation_on', '0') === '1' ? null : 'ai_moderation_on not set'));
  await tool('set_ai_moderation', { on: false });
  await tool('set_indexing', { on: false }, () => (getSetting('indexing_enabled', '1') === '0' ? null : 'indexing flag not set'));
  await tool('set_indexing', { on: true });
  await tool('set_newsletter_cadence', { cadence: 'monthly' }, () => (
    getSetting('newsletter_cadence', '') === 'monthly' ? null : 'cadence not stored'));
  await tool('set_newsletter_cadence', { cadence: 'yearly' }, null, { expectFail: true });
  await tool('send_newsletter_digest', {}, (r, res) => (res.ok || res.error ? null : 'digest returned nothing'), { expectAny: true })
    .catch(() => {});

  await tool('block_ip', { ip: '203.0.113.9', kind: 'block', note: 'suite' }, () => (
    one("SELECT * FROM spam_ip WHERE value='203.0.113.9'") ? null : 'ip rule not stored'));
  await tool('block_domain', { domain: 'spam-qa.example', kind: 'block', note: 'suite' }, () => (
    one("SELECT * FROM spam_domain WHERE value='spam-qa.example'") ? null : 'domain rule not stored'));

  await tool('create_incident', { title: 'Search latency', description: 'Elevated latency on directory search.', severity: 'minor', status: 'investigating' }, () => (
    one("SELECT id FROM incidents WHERE title='Search latency'") ? null : 'incident not opened'));
  const inc = one("SELECT * FROM incidents WHERE title='Search latency'");
  await tool('update_incident', { id: inc.id, message: 'Cause identified — a slow query plan.', status: 'identified' }, () => {
    const fresh = one('SELECT status FROM incidents WHERE id=?', inc.id);
    const updates = count('SELECT COUNT(*) c FROM incident_updates WHERE incident_id=?', inc.id);
    return fresh.status === 'identified' && updates >= 1 ? null : 'incident update not applied';
  });
  await tool('resolve_incident', { id: inc.id }, () => (
    one('SELECT status FROM incidents WHERE id=?', inc.id).status === 'resolved' ? null : 'incident not resolved'));

  db.prepare("INSERT INTO notifications (audience, user_id, kind, title, body, url) VALUES ('admin', NULL, 'system', 'QA', 'QA body', '/')").run();
  await tool('mark_admin_notifications_read', {}, () => (
    count("SELECT COUNT(*) c FROM notifications WHERE audience='admin' AND read_at IS NULL") === 0
      ? null : 'admin notifications still unread'));

  /* ============================ Site understanding ============================ */
  section('Site understanding (the assistant knows this installation)');
  await tool('site_overview', {}, (r) => (
    typeof r.briefing === 'string' && r.briefing.includes('FirmLedger') && Array.isArray(r.topics)
      ? null : 'no live briefing returned'));
  await tool('site_overview', { topic: 'schema' }, (r) => (
    r.topic === 'schema' && /listings/.test(JSON.stringify(r)) ? null : 'schema topic missing the listings table'));
  await tool('site_overview', { topic: 'rules' }, (r) => (r.topic === 'rules' ? null : 'rules topic not returned'));
  await tool('site_overview', { topic: 'nonsense' }, null, { expectFail: true });

  await tool('get_site_schema', {}, (r) => (
    r.tables >= 40 && r.schema.some((x) => x.table === 'listings' && x.columns.length)
      ? null : 'schema did not describe the listings table'));
  await tool('get_site_schema', { tables: 'users,tickets', with_columns: false }, (r) => (
    r.schema.length === 2 && r.schema.every((t) => !t.columns || !t.columns.length)
      ? null : 'table filter or with_columns=false not honoured'));

  await tool('get_settings', {}, (r) => (
    r.flags && typeof r.flags.maintenance_on === 'boolean' && Array.isArray(r.settings)
      && r.settings.some((x) => x.key === 'auto_approve')
      && !r.settings.some((x) => x.key === 'groq_api_key' && x.value)
      ? null : 'settings inventory wrong or a secret value leaked'));

  await tool('query_database', { sql: 'SELECT id, slug FROM listings ORDER BY id LIMIT 3' }, (r) => (
    r.count === 3 && r.columns.join(',') === 'id,slug' ? null : 'read-only query returned the wrong rows'));
  await tool('query_database', { sql: "SELECT COUNT(*) c FROM listings WHERE status='approved'" }, (r) => (
    r.rows[0].c === count("SELECT COUNT(*) c FROM listings WHERE status='approved'") ? null : 'aggregate wrong'));
  await tool('query_database', { sql: 'DELETE FROM listings' }, null, { expectFail: true });
  await tool('query_database', { sql: "UPDATE listings SET name='x'" }, null, { expectFail: true });
  await tool('query_database', { sql: 'SELECT 1; DROP TABLE users' }, null, { expectFail: true });
  await tool('query_database', { sql: 'SELECT * FROM no_such_table' }, null, { expectFail: true });

  /* ============================ Read-only console lookups ============================ */
  section('Console lookups');
  await tool('get_listing', { id_or_slug: 'gamma-group' }, (r) => (
    r.listing.id === f.gamma && r.listing.slug === 'gamma-group' && r.listing.status === 'approved'
      ? null : 'listing record not returned'));
  await tool('get_listing', { id_or_slug: String(f.gamma) }, (r) => (r.listing.slug === 'gamma-group' ? null : 'id lookup failed'));
  await tool('get_listing', { id_or_slug: 'missing-slug' }, null, { expectFail: true });

  await tool('get_user', { user: 'owner@example.com' }, (r) => (
    r.user.id === f.owner && Array.isArray(r.listings_owned) && r.listings_owned.length > 0
      ? null : 'user record or owned listings missing'));
  await tool('get_user', { user: 'nobody@example.com' }, null, { expectFail: true });

  await tool('list_listings', { status: 'approved' }, (r) => (
    r.count === count("SELECT COUNT(*) c FROM listings WHERE status='approved'") ? null : 'approved filter wrong'));
  await tool('list_listings', { q: 'delta', country: 'Kenya' }, (r) => (
    r.count >= 1 && r.listings.every((l) => /delta/i.test(l.name)) ? null : 'search filter wrong'));
  await tool('list_listings', { plan: 'pro' }, (r) => (
    r.listings.every((l) => l.plan === 'pro') ? null : 'plan filter wrong'));

  await tool('list_users', { plan: 'pro' }, (r) => (
    r.users.some((u) => u.id === f.proUser) ? null : 'pro member missing from the list'));
  await tool('list_users', { with_listings: true }, (r) => (
    r.users.some((u) => u.id === f.owner) ? null : 'owner with listings missing'));

  await tool('list_categories', {}, (r) => (
    r.count === count('SELECT COUNT(*) c FROM categories')
      && r.categories.every((c) => typeof c.in_use === 'number') ? null : 'category list wrong'));
  await tool('list_blog_posts', {}, (r) => (r.count === count('SELECT COUNT(*) c FROM blog_posts') ? null : 'post count wrong'));
  await tool('list_plan_offers', {}, (r) => (
    r.count >= 1 && r.offers.every((o) => typeof o.price_usd === 'string') ? null : 'plan offers wrong'));
  await tool('list_promos', {}, (r) => (r.count === count('SELECT COUNT(*) c FROM promo_codes') ? null : 'promo count wrong'));
  await tool('list_careers', {}, (r) => (r.count === count('SELECT COUNT(*) c FROM careers') ? null : 'career count wrong'));
  await tool('list_careers', { status: 'open' }, (r) => (
    r.roles.every((c) => c.status === 'open') ? null : 'career status filter wrong'));
  await tool('list_ad_packages', {}, (r) => (
    Array.isArray(r.packages) && Array.isArray(r.sponsored) ? null : 'advertising snapshot missing'));
  await tool('list_payments', {}, (r) => (
    r.count === count('SELECT COUNT(*) c FROM payments') ? null : 'payment count wrong'));
  await tool('list_payments', { status: 'success' }, (r) => (
    r.payments.every((p) => p.status === 'success') ? null : 'payment filter wrong'));
  await tool('list_pro_transfers', { status: 'pending' }, (r) => (
    r.count === count("SELECT COUNT(*) c FROM pro_transfer_requests WHERE status='pending'") ? null : 'transfer count wrong'));
  await tool('list_removals', {}, (r) => (
    r.count === count('SELECT COUNT(*) c FROM removal_requests') && r.removals.some((x) => x.id === f.removal)
      ? null : 'removal queue wrong'));
  await tool('list_claims', {}, (r) => (
    r.count === count('SELECT COUNT(*) c FROM claims') && r.claims.some((c) => c.id === f.claim)
      ? null : 'claim queue wrong'));
  await tool('list_tickets', {}, (r) => (
    r.count === count('SELECT COUNT(*) c FROM tickets') && r.tickets.some((x) => x.ref === 'FL-TEST01')
      ? null : 'ticket queue wrong'));
  await tool('get_ticket', { id_or_ref: 'FL-TEST01' }, (r) => (
    r.ticket.id === f.ticket && r.messages.length >= 1 ? null : 'ticket thread not returned'));
  await tool('get_ticket', { id_or_ref: String(f.ticket) }, (r) => (r.ticket.ref === 'FL-TEST01' ? null : 'ticket id lookup failed'));
  await tool('get_ticket', { id_or_ref: 'FL-NOPE' }, null, { expectFail: true });
  await tool('list_notifications', {}, (r) => (
    typeof r.unread === 'number' && Array.isArray(r.notifications) ? null : 'inbox snapshot missing'));
  await tool('list_deletion_requests', { status: 'pending' }, (r) => (
    r.count === count("SELECT COUNT(*) c FROM deletion_requests WHERE status='pending'") ? null : 'deletion request count wrong'));

  await tool('get_status', {}, (r) => (
    r.components.length > 0 && typeof r.overall === 'string' ? null : 'status page snapshot missing'));
  await tool('get_indexing', {}, (r) => (
    typeof r.indexnow_enabled === 'boolean' && r.google_quota && typeof r.log_entries === 'number'
      ? null : 'indexing snapshot missing'));
  await tool('get_protection', {}, (r) => (
    r.limits && typeof r.limits.login === 'number' && Array.isArray(r.ips) ? null : 'protection snapshot missing'));
  await tool('get_mail_status', {}, (r) => (
    typeof r.configured === 'boolean' && Array.isArray(r.hops) && Array.isArray(r.recent) ? null : 'mail snapshot missing'));
  await tool('get_newsletter', {}, (r) => (
    r.subscribers === count('SELECT COUNT(*) c FROM newsletter_subscribers WHERE active=1') ? null : 'subscriber count wrong'));
  await tool('get_upkeep', {}, (r) => (
    r.settings && typeof r.running === 'boolean' && r.tech_job ? null : 'upkeep snapshot missing'));
  await tool('get_backup_state', {}, (r) => (
    r.users_included === count('SELECT COUNT(*) c FROM users') ? null : 'backup snapshot wrong'));
  await tool('get_ai_state', {}, (r) => (
    r.active_provider === 'groq' && r.providers.length >= 10 && Array.isArray(r.tool_groups)
      ? null : 'AI state snapshot missing providers'));
  await tool('get_api_usage', { days: 7 }, (r) => (
    typeof r.keys === 'number' && Array.isArray(r.daily) ? null : 'API usage snapshot missing'));

  await tool('find_duplicate_listings', { name: 'Gamma Group' }, (r) => (
    r.duplicate === true && r.name_matches.some((m) => m.id === f.gamma) ? null : 'name duplicate not detected'));
  await tool('find_duplicate_listings', { website: 'https://delta-co.example.com/pricing' }, (r) => (
    r.duplicate === true && r.checked_domain === 'delta-co.example.com' ? null : 'domain duplicate not detected'));
  await tool('find_duplicate_listings', { name: 'Totally Unique Name Ltd' }, (r) => (
    r.duplicate === false ? null : 'false positive duplicate'));
  await tool('find_duplicate_listings', {}, null, { expectFail: true });

  /* ============================ Listing editor ============================ */
  section('Listing editor, graph, technology and news');
  await tool('edit_listing', {
    id_or_slug: 'gamma-group', tagline: 'Rebuilt by the conformance suite',
    city: 'Mombasa', phone: '+254700000000', tags: 'fintech, verified', status: 'approved', confidence: 88,
  }, () => {
    const l = one('SELECT tagline, city, phone, tags, status, confidence FROM listings WHERE id=?', f.gamma);
    return l.city === 'Mombasa' && l.confidence === 88 && l.tags === 'fintech, verified' && l.status === 'approved'
      ? null : 'edits not written to the listings row';
  });
  await tool('edit_listing', { id_or_slug: 'gamma-group', category: 'Conformance Testing' }, () => (
    one('SELECT category FROM listings WHERE id=?', f.gamma).category === 'Conformance Testing'
      ? null : 'category not changed'));
  await tool('edit_listing', { id_or_slug: 'gamma-group', website: 'https://delta-co.example.com' }, null, { expectFail: true });
  await tool('edit_listing', { id_or_slug: 'gamma-group', status: 'nonsense' }, null, { expectFail: true });
  await tool('edit_listing', { id_or_slug: 'no-such' }, null, { expectFail: true });
  db.prepare("UPDATE listings SET category='Technology' WHERE id=?").run(f.gamma);

  await tool('create_listing', {
    name: 'Conformance Fintech', tagline: 'Created by the tool suite',
    description: 'A company created by the FirmLedger admin-tool conformance suite to prove create_listing really writes a row.',
    website: 'https://conformance-fintech.example', country: 'Kenya', city: 'Nairobi',
    category: 'Technology', email: 'hi@conformance-fintech.example', sources: 'https://registry.example/1,https://news.example/2',
  }, (r) => {
    const row = one("SELECT * FROM listings WHERE slug=?", r.listing ? r.listing.slug : 'conformance-fintech');
    if (!row) return 'listing row was not inserted';
    if (row.status !== 'pending') return 'new listing should start pending';
    if (!JSON.parse(row.sources || '[]').length) return 'sources were not stored';
    return null;
  });
  const created = one("SELECT * FROM listings WHERE name='Conformance Fintech'");
  await tool('create_listing', {
    name: 'Conformance Fintech', tagline: 'Duplicate', description: 'A duplicate name that must be refused by the same guard the dashboard uses.',
    website: 'https://other.example', country: 'Kenya',
  }, null, { expectFail: true });
  await tool('create_listing', {
    name: 'Brand New Co', tagline: 'Duplicate domain', description: 'A duplicate website domain that must be refused by the same guard the dashboard uses.',
    website: 'https://conformance-fintech.example/about', country: 'Kenya',
  }, null, { expectFail: true });
  await tool('create_listing', { name: 'No Country Co', tagline: 'x', description: 'A listing without the required country field must be refused.', website: 'https://x.example' }, null, { expectFail: true });

  await tool('add_listing_event', { id_or_slug: String(created.id), title: 'Series A announced', event_date: '2026-02-11', kind: 'funding' }, () => (
    count('SELECT COUNT(*) c FROM listing_events WHERE listing_id=?', created.id) === 1 ? null : 'event not written'));
  const ev = one('SELECT * FROM listing_events WHERE listing_id=?', created.id);
  await tool('delete_listing_event', { event_id: ev.id }, () => (
    count('SELECT COUNT(*) c FROM listing_events WHERE listing_id=?', created.id) === 0 ? null : 'event not deleted'));
  await tool('delete_listing_event', { event_id: 999999 }, null, { expectFail: true });

  await tool('add_relationship', { id_or_slug: String(created.id), rel_type: 'subsidiary', target: 'gamma-group', note: 'Owned by Gamma Group.' }, () => (
    count('SELECT COUNT(*) c FROM relationships WHERE listing_id=?', created.id) === 1 ? null : 'relationship not written'));
  const rel = one('SELECT * FROM relationships WHERE listing_id=?', created.id);
  await tool('add_relationship', { id_or_slug: String(created.id), rel_type: 'not-a-type', target: 'gamma-group' }, null, { expectFail: true });
  await tool('delete_relationship', { relation_id: rel.id }, () => (
    count('SELECT COUNT(*) c FROM relationships WHERE listing_id=?', created.id) === 0 ? null : 'relationship not deleted'));

  db.prepare('UPDATE listings SET confidence=10 WHERE id=?').run(created.id);
  await tool('recalculate_listing_confidence', { id_or_slug: String(created.id) }, (r) => (
    one('SELECT confidence FROM listings WHERE id=?', created.id).confidence === r.confidence
      ? null : 'confidence not recomputed and stored'));
  await tool('recalculate_listing_confidence', { id_or_slug: 'no-such' }, null, { expectFail: true });

  await tool('bulk_update_listings', { action: 'approve', ids: [String(created.id)] }, () => (
    one('SELECT status FROM listings WHERE id=?', created.id).status === 'approved' ? null : 'bulk approve did not write'));
  await tool('bulk_update_listings', { action: 'reject', ids: [String(created.id)] }, () => (
    one('SELECT status FROM listings WHERE id=?', created.id).status === 'rejected' ? null : 'bulk reject did not write'));
  await tool('bulk_update_listings', { action: 'feature', ids: [String(created.id)] }, () => (
    one('SELECT featured FROM listings WHERE id=?', created.id).featured === 1 ? null : 'bulk feature did not write'));
  await tool('bulk_update_listings', { action: 'unfeature', ids: [String(created.id)] }, () => (
    one('SELECT featured FROM listings WHERE id=?', created.id).featured === 0 ? null : 'bulk unfeature did not write'));
  /* A filter with no constraint would touch the whole ledger — it must refuse. */
  await tool('bulk_update_listings', { action: 'delete' }, null, { expectFail: true });
  await tool('bulk_update_listings', { action: 'nonsense', ids: [String(created.id)] }, null, { expectFail: true });
  db.prepare("UPDATE listings SET status='approved' WHERE id=?").run(created.id);

  /* Technology radar + listing news — canned pages/RSS, no real network.
     The stub installs itself on require, so drop it from the cache first: an
     earlier section already required and then restored the real fetch. */
  const stubFetch = globalThis.fetch;
  const stubPath = require.resolve('./helpers/fetch-stub.js');
  const installStub = () => { delete require.cache[stubPath]; require('./helpers/fetch-stub.js'); };
  installStub();
  await tool('refresh_listing_news', { id_or_slug: 'gamma-group' }, () => (
    one('SELECT news_checked_at FROM listings WHERE id=?', f.gamma).news_checked_at
      ? null : 'news_checked_at not stamped'));
  await tool('refresh_listing_news', { id_or_slug: 'no-such' }, null, { expectFail: true });
  const stories = db.prepare('SELECT * FROM listing_news WHERE listing_id=? ORDER BY id').all(f.gamma);
  if (stories.length) {
    await tool('reject_news', { id: String(stories[0].id) }, () => (
      one('SELECT status FROM listing_news WHERE id=?', stories[0].id).status === 'rejected' ? null : 'story not rejected'));
    await tool('approve_news', { id: String(stories[0].id) }, () => (
      one('SELECT status FROM listing_news WHERE id=?', stories[0].id).status === 'approved' ? null : 'story not approved'));
    await tool('delete_news', { id: stories[0].id }, () => (
      !one('SELECT id FROM listing_news WHERE id=?', stories[0].id) ? null : 'story not deleted'));
  } else {
    await tool('approve_news', { id: '1' }, null, { expectFail: true });
    await tool('reject_news', { id: '1' }, null, { expectFail: true });
    await tool('delete_news', { id: 1 }, null, { expectFail: true });
  }
  await tool('list_news', { listing: 'gamma-group' }, (r) => (
    r.listing === 'Gamma Group' && Array.isArray(r.stories) ? null : 'listing news list wrong'));
  await tool('list_news', { status: 'approved' }, (r) => (
    r.stories.every((s) => s.status === 'approved') ? null : 'news status filter wrong'));

  await tool('add_news_story', {
    id_or_slug: 'gamma-group', title: 'Gamma Group opens a new office',
    url: 'https://newsroom.example/gamma-office', source: 'Business Daily',
    published_at: '2026-03-02', summary: 'The company opened a third office in Kisumu.',
  }, () => (
    count("SELECT COUNT(*) c FROM listing_news WHERE listing_id=? AND origin='admin'", f.gamma) >= 1
      ? null : 'hand-written story not stored'));
  const manual = one("SELECT * FROM listing_news WHERE listing_id=? AND origin='admin' ORDER BY id DESC", f.gamma);
  await tool('add_news_story', { id_or_slug: 'no-such', title: 'x' }, null, { expectFail: true });
  await tool('set_news_settings', { review_auto: true }, () => (
    getSetting('news_review_auto', '0') === '1' ? null : 'news auto-review flag not stored'));
  await tool('set_news_settings', { review_auto: false }, () => (
    getSetting('news_review_auto', '1') === '0' ? null : 'news auto-review flag not cleared'));

  /* Bulk sweeps start a background job; cancel it straight away. */
  await tool('cancel_tech_job', {}, null, { expectFail: true });
  await tool('cancel_news_job', {}, null, { expectFail: true });
  /* Every stubbed request is slowed down so a sweep is genuinely still in
     flight when the cancel lands — otherwise the job would finish first and the
     cancel test would be measuring nothing. */
  const stubbedFetch = globalThis.fetch;
  globalThis.fetch = async function slowStub(...a) {
    await new Promise((r) => setTimeout(r, 160));
    return stubbedFetch(...a);
  };
  const sweepStatus = async (lib, ms) => {
    await new Promise((r) => setTimeout(r, ms));
    return require(lib).jobState().status;
  };

  db.prepare('UPDATE listings SET website=? WHERE id=?').run('https://slow.example', f.gamma);
  await tool('refresh_tech_bulk', { scope: 'selected', ids: ['gamma-group'] }, (r) => (
    r.queued >= 1 && r.job ? null : 'technology sweep was not queued'));
  await tool('cancel_tech_job', {}, (r) => (r.ok ? null : 'cancel was refused while the sweep was running'));
  if (await sweepStatus('../src/lib/techrefresh', 1500) !== 'cancelled') {
    failures.push({ name: 'cancel_tech_job', why: 'the sweep did not finish as cancelled' });
    console.log('  ✗ cancel_tech_job — sweep ended ' + require('../src/lib/techrefresh').jobState().status);
  } else { passed++; console.log('  ✓ cancel_tech_job stopped the sweep'); }
  await tool('cancel_tech_job', {}, null, { expectFail: true });   // nothing running now
  await tool('refresh_tech_bulk', { scope: 'selected', ids: ['no-such-listing'] }, null, { expectFail: true });
  db.prepare('UPDATE listings SET website=? WHERE id=?').run('https://gamma-group.example.com', f.gamma);

  await tool('refresh_news_bulk', { scope: 'all' }, (r) => (
    r.queued >= 1 ? null : 'news sweep was not queued'));
  await tool('cancel_news_job', {}, (r) => (r.ok ? null : 'cancel was refused while the sweep was running'));
  if (await sweepStatus('../src/lib/news', 1500) !== 'cancelled') {
    failures.push({ name: 'cancel_news_job', why: 'the news sweep did not finish as cancelled' });
    console.log('  ✗ cancel_news_job — sweep ended ' + require('../src/lib/news').jobState().status);
  } else { passed++; console.log('  ✓ cancel_news_job stopped the sweep'); }
  await tool('cancel_news_job', {}, null, { expectFail: true });
  await tool('refresh_news_bulk', { scope: 'selected', ids: [] }, null, { expectFail: true });
  globalThis.fetch = stubbedFetch;
  globalThis.fetch = stubFetch;

  /* ============================ Users & billing ============================ */
  section('Users, plans and billing');
  await tool('update_user', { user: 'pro@example.com', name: 'Pro Three Renamed' }, () => (
    one('SELECT name FROM users WHERE id=?', f.proUser).name === 'Pro Three Renamed' ? null : 'name not updated'));
  await tool('update_user', { user: String(f.proUser), email: 'pro-renamed@example.com' }, () => (
    one('SELECT email FROM users WHERE id=?', f.proUser).email === 'pro-renamed@example.com' ? null : 'email not updated'));
  await tool('update_user', { user: 'pro-renamed@example.com', email: 'not-an-email' }, null, { expectFail: true });
  await tool('update_user', { user: 'pro-renamed@example.com', email: 'owner@example.com' }, null, { expectFail: true });
  await tool('update_user', { user: 'ghost@example.com', name: 'Nobody' }, null, { expectFail: true });

  await tool('set_user_plan', { user: 'owner@example.com', plan: 'pro', expires_at: '2030-06-01', note: 'Conformance suite grant' }, () => {
    const u = one('SELECT plan, plan_expires_at FROM users WHERE id=?', f.owner);
    return u.plan === 'pro' && u.plan_expires_at === '2030-06-01' ? null : 'plan not applied';
  });
  await tool('set_user_plan', { user: 'owner@example.com', plan: 'pro', lifetime: true }, () => {
    const u = one('SELECT plan, plan_expires_at FROM users WHERE id=?', f.owner);
    return u.plan === 'pro' && !u.plan_expires_at ? null : 'lifetime plan not applied';
  });
  await tool('set_user_plan', { user: 'owner@example.com', plan: 'free' }, () => (
    one('SELECT plan FROM users WHERE id=?', f.owner).plan === 'free' ? null : 'plan not reverted to free'));
  await tool('set_user_plan', { user: 'owner@example.com', plan: 'enterprise' }, null, { expectFail: true });

  const offers = db.prepare('SELECT * FROM plans ORDER BY id').all();
  await tool('update_plan_offer', { id: offers[0].id, name: 'Suite Pro Monthly', price_usd: 21.5, duration_days: 31, blurb: 'Renamed by the suite.', sort: 4 }, () => {
    const p = one('SELECT * FROM plans WHERE id=?', offers[0].id);
    return p.name === 'Suite Pro Monthly' && p.price_cents === 2150 && p.duration_days === 31 && p.sort === 4
      ? null : 'plan offer not updated';
  });
  await tool('update_plan_offer', { id: offers[0].id, price_usd: -5 }, null, { expectFail: true });
  await tool('update_plan_offer', { id: 999999, name: 'Ghost' }, null, { expectFail: true });

  db.prepare("INSERT INTO plans (name, price_cents, duration_days, blurb, active, sort) VALUES ('Suite Throwaway', 500, 7, 'x', 1, 9)").run();
  const throwaway = one("SELECT * FROM plans WHERE name='Suite Throwaway'");
  await tool('delete_plan_offer', { id: throwaway.id }, () => (
    !one('SELECT id FROM plans WHERE id=?', throwaway.id) ? null : 'unused plan offer not deleted'));
  db.prepare(
    "INSERT INTO payments (user_id, plan_id, duration_days, order_id, reference, amount, currency, status, channel, email)\n     VALUES (?,?,30,'ORD-SUITE-1','REF-SUITE-1',1500,'USD','success','paypal','owner@example.com')"
  ).run(f.owner, offers[0].id);
  await tool('delete_plan_offer', { id: offers[0].id }, () => {
    const p = one('SELECT active FROM plans WHERE id=?', offers[0].id);
    return p && p.active === 0 ? null : 'a paid plan must be deactivated, never deleted';
  });

  db.prepare("INSERT INTO sessions (token, user_id, csrf, kind, expires_at) VALUES ('suite-session-1', ?, 'csrf-1', 'user', datetime('now','+1 day'))").run(f.proUser);
  await tool('revoke_user_sessions', { user: 'pro-renamed@example.com' }, () => (
    count('SELECT COUNT(*) c FROM sessions WHERE user_id=?', f.proUser) === 0 ? null : 'sessions not revoked'));
  await tool('revoke_user_sessions', { user: 'ghost@example.com' }, null, { expectFail: true });

  db.prepare("INSERT INTO user_totp (user_id, secret, recovery_codes, enabled) VALUES (?, 'JBSWY3DPEHPK3PXP', '[\"a\",\"b\"]', 1)").run(f.proUser);
  await tool('reset_user_2fa', { user: 'pro-renamed@example.com' }, () => {
    const row = one('SELECT * FROM user_totp WHERE user_id=?', f.proUser);
    return !row || row.enabled === 0 ? null : 'two-factor was not reset';
  });
  await tool('reset_user_2fa', { user: 'ghost@example.com' }, null, { expectFail: true });

  await tool('notify_user', { user: 'pro-renamed@example.com', title: 'Suite notice', body: 'Written by the conformance suite.', url: '/dashboard', kind: 'system' }, () => (
    count("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND title='Suite notice'", f.proUser) === 1
      ? null : 'member notification not written'));
  await tool('notify_user', { user: 'ghost@example.com', title: 'Nobody' }, null, { expectFail: true });

  await tool('create_backup', {}, (r) => {
    const file = path.join(tmp, 'backups', r.file);
    if (!fs.existsSync(file)) return 'backup file was not written to data/backups';
    if (getSetting('last_backup_at', '') === '') return 'last_backup_at not stamped';
    if (r.listings !== count('SELECT COUNT(*) c FROM listings')) return 'backup listing count wrong';
    return null;
  });

  /* ============================ Moderation ============================ */
  section('Moderation queue');
  db.prepare("UPDATE tickets SET updated_at=datetime('now','-40 days') WHERE id=?").run(f.ticket);
  await tool('auto_close_stale_tickets', {}, () => (
    one('SELECT status FROM tickets WHERE id=?', f.ticket).status !== 'open' ? null : 'stale ticket was not closed'));

  /* ============================ Content ============================ */
  section('Content, email and advertising');
  const post = one("SELECT * FROM blog_posts WHERE slug='suite-post'") || one('SELECT * FROM blog_posts ORDER BY id DESC');
  await tool('update_blog_post', { id_or_slug: post.slug, title: 'Edited by the suite', excerpt: 'New excerpt.', body: 'New body copy for the conformance suite.', status: 'draft' }, () => {
    const p = one('SELECT * FROM blog_posts WHERE id=?', post.id);
    return p.title === 'Edited by the suite' && p.status === 'draft' ? null : 'post edits not stored';
  });
  await tool('update_blog_post', { id_or_slug: post.slug, status: 'published' }, () => (
    one('SELECT status FROM blog_posts WHERE id=?', post.id).status === 'published' ? null : 'post not republished'));
  await tool('update_blog_post', { id_or_slug: 'no-such-post', title: 'x' }, null, { expectFail: true });

  /* Mail: nothing is configured in this suite, so the honest failure is the contract. */
  await tool('send_test_email', { to: 'not-an-email' }, null, { expectFail: true });
  await tool('send_test_email', { to: 'admin@example.com' }, null, { expectFail: true });
  await tool('set_mail_from', { from: 'FirmLedger Suite <suite@example.com>' }, () => (
    getSetting('smtp_from', '') === 'FirmLedger Suite <suite@example.com>' ? null : 'global from address not stored'));
  await tool('set_mail_from', { from: 'broken' }, null, { expectFail: true });

  await tool('manage_smtp_account', {
    action: 'add', provider: 'zoho', label: 'Suite hop', host: 'smtp.zoho.com',
    port: 587, secure: false, username: 'suite@example.com', password: 'secret', daily_limit: 200, sort: 3,
  }, () => {
    const row = one("SELECT * FROM smtp_accounts WHERE label='Suite hop'");
    return row && row.host === 'smtp.zoho.com' && row.daily_limit === 200 && row.active === 1
      ? null : 'SMTP account not stored';
  });
  const hop = one("SELECT * FROM smtp_accounts WHERE label='Suite hop'");
  await tool('manage_smtp_account', { action: 'toggle', id: hop.id }, () => (
    one('SELECT active FROM smtp_accounts WHERE id=?', hop.id).active === 0 ? null : 'hop not disabled'));
  await tool('manage_smtp_account', { action: 'toggle', id: hop.id }, () => (
    one('SELECT active FROM smtp_accounts WHERE id=?', hop.id).active === 1 ? null : 'hop not re-enabled'));
  await tool('manage_smtp_account', { action: 'add', provider: 'zoho' }, null, { expectFail: true });
  await tool('manage_smtp_account', { action: 'delete', id: hop.id }, () => (
    !one('SELECT id FROM smtp_accounts WHERE id=?', hop.id) ? null : 'hop not deleted'));
  /* Deleting the last hop puts mail back into the outbox-only state the rest of
     the suite expects, so keep it that way. */

  const promo = one("SELECT * FROM promo_codes ORDER BY id DESC");
  await tool('delete_promo', { code_or_id: promo.code }, () => (
    !one('SELECT id FROM promo_codes WHERE id=?', promo.id) ? null : 'promo code not deleted'));
  await tool('delete_promo', { code_or_id: 'NOPE' }, null, { expectFail: true });

  const careerRow = one('SELECT * FROM careers ORDER BY id DESC');
  await tool('update_career', { id: careerRow.id, title: 'Suite Engineer', location: 'Remote', apply_email: 'jobs@example.com' }, () => {
    const c = one('SELECT * FROM careers WHERE id=?', careerRow.id);
    return c.title === 'Suite Engineer' && c.location === 'Remote' ? null : 'role not updated';
  });
  await tool('update_career', { id: careerRow.id, apply_email: 'not-an-email' }, null, { expectFail: true });
  await tool('update_career', { id: 999999, title: 'Ghost' }, null, { expectFail: true });

  await tool('manage_ad_package', { action: 'create', name: 'Suite Spotlight', blurb: 'Top of the directory.', price_usd: 49, duration_days: 30, sort: 2 }, () => (
    one("SELECT * FROM ad_packages WHERE name='Suite Spotlight'") ? null : 'ad package not created'));
  const pkg = one("SELECT * FROM ad_packages WHERE name='Suite Spotlight'");
  await tool('manage_ad_package', { action: 'update', id: pkg.id, price_usd: 59.99, blurb: 'Updated by the suite.' }, () => {
    const p = one('SELECT * FROM ad_packages WHERE id=?', pkg.id);
    return p.price_cents === 5999 && p.blurb === 'Updated by the suite.' ? null : 'ad package not updated';
  });
  await tool('manage_ad_package', { action: 'toggle', id: pkg.id }, () => (
    one('SELECT active FROM ad_packages WHERE id=?', pkg.id).active === 0 ? null : 'ad package not deactivated'));
  await tool('manage_ad_package', { action: 'create', name: 'Bad Package', price_usd: -3 }, null, { expectFail: true });
  await tool('manage_ad_package', { action: 'delete', id: pkg.id }, () => (
    !one('SELECT id FROM ad_packages WHERE id=?', pkg.id) ? null : 'ad package not deleted'));

  const before = count('SELECT COUNT(*) c FROM notifications');
  await tool('notify_members', { audience: 'all', title: 'Suite broadcast', body: 'A broadcast written by the conformance suite.', url: '/blog', kind: 'system' }, () => (
    count('SELECT COUNT(*) c FROM notifications') > before ? null : 'broadcast wrote no notifications'));
  await tool('notify_members', { audience: 'nobody', title: 'x' }, null, { expectFail: true });
  await tool('notify_members', { audience: 'all', title: '' }, null, { expectFail: true });

  await tool('post_admin_notification', { title: 'Suite console note', body: 'For the admin inbox.', url: '/admin3119Musa', kind: 'system' }, () => (
    count("SELECT COUNT(*) c FROM notifications WHERE audience='admin' AND title='Suite console note'") === 1
      ? null : 'console notification not written'));

  await tool('manage_newsletter_subscriber', { action: 'add', email: 'suite-sub@example.com' }, () => (
    one("SELECT active FROM newsletter_subscribers WHERE email='suite-sub@example.com'").active === 1
      ? null : 'subscriber not added'));
  await tool('manage_newsletter_subscriber', { action: 'add', email: 'broken' }, null, { expectFail: true });
  await tool('manage_newsletter_subscriber', { action: 'remove', email: 'suite-sub@example.com' }, () => {
    const row = one("SELECT * FROM newsletter_subscribers WHERE email='suite-sub@example.com'");
    return !row || row.active === 0 ? null : 'subscriber not removed';
  });

  /* ============================ Operations ============================ */
  section('Site operations, protection, indexing and AI');
  await tool('update_settings', {
    auto_approve: true, indexing_enabled: false, admin_email: 'suite-admin@example.com',
    newsletter_cadence: 'weekly', upkeep_on: true, upkeep_tech_limit: 12, upkeep_news_max_age_days: 21,
  }, () => {
    if (getSetting('auto_approve', '0') !== '1') return 'auto_approve not stored';
    if (getSetting('indexing_enabled', '1') !== '0') return 'indexing_enabled not stored';
    if (getSetting('admin_email', '') !== 'suite-admin@example.com') return 'admin_email not stored';
    if (getSetting('newsletter_cadence', '') !== 'weekly') return 'newsletter_cadence not stored';
    if (getSetting('upkeep_on', '') !== '1') return 'upkeep_on not stored';
    if (getSetting('upkeep_tech_limit', '') !== '12') return 'upkeep_tech_limit not stored';
    return null;
  });
  await tool('update_settings', { newsletter_cadence: 'hourly' }, null, { expectFail: true });
  await tool('update_settings', {}, null, { expectFail: true });
  await tool('update_settings', { auto_approve: false, indexing_enabled: true });

  await tool('set_rate_limits', { login: 7, register: 4, listing: 12, api_read_rpm: 90 }, () => {
    const l = require('../src/lib/spam').limits();
    return l.login === 7 && l.register === 4 && l.listing === 12 && l.api_read_rpm === 90
      ? null : 'rate limits not stored';
  });
  await tool('set_rate_limits', { login: -3 }, null, { expectFail: true });
  await tool('set_rate_limits', { nonsense: 5 }, null, { expectFail: true });
  await tool('set_rate_limits', {}, null, { expectFail: true });

  const ipRule = one("SELECT * FROM spam_ip WHERE value='203.0.113.9'");
  const domRule = one("SELECT * FROM spam_domain WHERE value='spam-qa.example'");
  await tool('delete_ip_rule', { id: ipRule.id }, () => (
    !one('SELECT id FROM spam_ip WHERE id=?', ipRule.id) ? null : 'ip rule not deleted'));
  await tool('delete_domain_rule', { id: domRule.id }, () => (
    !one('SELECT id FROM spam_domain WHERE id=?', domRule.id) ? null : 'domain rule not deleted'));
  await tool('delete_ip_rule', { id: 999999 }, null, { expectFail: true });
  await tool('delete_domain_rule', { id: 999999 }, null, { expectFail: true });

  const oldKey = getSetting('indexnow_key', '');
  await tool('regen_indexnow_key', {}, () => {
    const k = getSetting('indexnow_key', '');
    return k && k !== oldKey && /^[0-9a-f]{32}$/.test(k) ? null : 'IndexNow key not regenerated';
  });

  installStub();
  await tool('ping_indexnow', { urls: ['/listing/gamma-group', '/blog'] }, (r) => (
    r.submitted === 2 ? null : 'IndexNow ping did not report both URLs'));
  await tool('ping_indexnow', { urls: [] }, null, { expectFail: true });
  const logRow = one('SELECT * FROM indexing_log ORDER BY id DESC');
  if (logRow) {
    await tool('delete_indexing_log_entry', { id: logRow.id }, () => (
      !one('SELECT id FROM indexing_log WHERE id=?', logRow.id) ? null : 'log entry not deleted'));
  } else {
    await tool('delete_indexing_log_entry', { id: 999999 }, null, { expectFail: true });
  }
  await tool('clear_indexing_log', {}, () => (
    count('SELECT COUNT(*) c FROM indexing_log') === 0 ? null : 'indexing log not cleared'));
  await tool('run_google_indexing_batch', {}, null, { expectFail: true });   // no service account in the suite
  await tool('remove_google_service_account', {}, (r) => (
    typeof r.still_configured === 'boolean' ? null : 'Google indexing state not reported'));

  await tool('run_upkeep', { force: true }, (r) => (
    getSetting('upkeep_last_run', '') !== '' || r.tech || r.news ? null : 'upkeep sweep did not run'));

  const comps = db.prepare('SELECT * FROM status_components ORDER BY id').all();
  await tool('set_component_status', { id_or_slug: comps[0].slug, status: 'degraded' }, () => (
    one('SELECT status FROM status_components WHERE id=?', comps[0].id).status === 'degraded'
      ? null : 'component status not stored'));
  await tool('set_component_status', { id_or_slug: comps[0].slug, status: 'nonsense' }, null, { expectFail: true });
  await tool('set_component_status', { id_or_slug: 'no-such-component', status: 'degraded' }, null, { expectFail: true });
  await tool('reset_component_status', { id_or_slug: comps[0].slug }, () => (
    one('SELECT status FROM status_components WHERE id=?', comps[0].id).status === 'operational'
      ? null : 'component status not reset'));
  installStub();
  await tool('run_status_probes', {}, (r) => (
    typeof r.overall === 'string' && Array.isArray(r.results) && r.results.length > 0
      ? null : 'probes did not report every component'));
  await tool('set_status_digest', { weekly_report: false }, () => (
    getSetting('status_weekly_report', '1') === '0' ? null : 'status digest flag not stored'));
  await tool('set_status_digest', { weekly_report: true }, () => (
    getSetting('status_weekly_report', '0') === '1' ? null : 'status digest flag not restored'));

  const note = one("SELECT * FROM notifications WHERE audience='admin' AND title='Suite console note'");
  await tool('manage_notification', { action: 'read', id: note.id }, () => (
    Boolean(one('SELECT read_at FROM notifications WHERE id=?', note.id).read_at) ? null : 'entry not marked read'));
  await tool('manage_notification', { action: 'archive', id: note.id, duration: '7d' }, () => {
    const n = one('SELECT archived_at, deleted_at, archive_expires_at FROM notifications WHERE id=?', note.id);
    return n.deleted_at && n.archive_expires_at ? null : 'entry not moved to trash with an expiry';
  });
  await tool('manage_notification', { action: 'restore', id: note.id }, () => (
    !one('SELECT deleted_at FROM notifications WHERE id=?', note.id).deleted_at ? null : 'entry not restored'));
  await tool('manage_notification', { action: 'archive', id: note.id, duration: '30d' });
  db.prepare("UPDATE notifications SET archive_expires_at=datetime('now','-1 day') WHERE id=?").run(note.id);
  await tool('purge_expired_notifications', {}, () => (
    !one('SELECT id FROM notifications WHERE id=?', note.id) ? null : 'expired trash entry not purged'));
  await tool('manage_notification', { action: 'nonsense', id: 1 }, null, { expectFail: true });
  await tool('manage_notification', { action: 'read', id: 999999 }, null, { expectFail: true });

  db.prepare("UPDATE users SET subscription_status='trialing', trial_expires_at=datetime('now','-1 day') WHERE id=?").run(f.proUser);
  await tool('expire_trials_now', {}, () => (
    one('SELECT subscription_status FROM users WHERE id=?', f.proUser).subscription_status !== 'trialing'
      ? null : 'finished trial was not expired'));

  await tool('set_paypal_credentials', { client_id: 'suite-client-id', client_secret: 'suite-secret', mode: 'sandbox' }, () => (
    getSetting('paypal_client_id', '') === 'suite-client-id' && getSetting('paypal_mode', '') === 'sandbox'
      ? null : 'PayPal credentials not stored'));
  await tool('set_paypal_credentials', { mode: 'nonsense' }, null, { expectFail: true });
  await tool('set_paypal_credentials', { clear: true }, () => (
    getSetting('paypal_client_id', 'x') === '' ? null : 'PayPal credentials not cleared'));

  await tool('set_smtp_credentials', { host: 'smtp.suite.example', port: 465, user: 'suite@example.com', password: 'secret', secure: true, from: 'Suite <suite@example.com>' }, () => {
    if (getSetting('smtp_host', '') !== 'smtp.suite.example') return 'smtp_host not stored';
    if (getSetting('smtp_port', '') !== '465') return 'smtp_port not stored';
    if (getSetting('smtp_secure', '') !== '1') return 'smtp_secure not stored';
    return null;
  });
  await tool('set_smtp_credentials', { host: 'smtp.suite.example', port: 99999 }, null, { expectFail: true });
  await tool('set_smtp_credentials', { clear_password: true }, () => (
    getSetting('smtp_pass', 'x') === '' ? null : 'SMTP password not cleared'));
  db.prepare("DELETE FROM settings WHERE key IN ('smtp_host','smtp_port','smtp_user','smtp_secure','smtp_from')").run();

  setSetting('admin_totp_secret', 'JBSWY3DPEHPK3PXP');
  setSetting('admin_recovery_codes', '["aaaa","bbbb"]');
  await tool('reset_admin_2fa', {}, () => (
    getSetting('admin_totp_secret', 'x') === '' && getSetting('admin_recovery_codes', 'x') === '[]'
      ? null : 'console two-factor not reset'));
  await tool('set_admin_otp_email', { email: 'codes@example.com' }, () => (
    getSetting('admin_2fa_email', '') === 'codes@example.com' ? null : 'console OTP inbox not stored'));
  await tool('set_admin_otp_email', { email: 'broken' }, null, { expectFail: true });
  await tool('set_admin_otp_email', { email: '' }, () => (
    getSetting('admin_2fa_email', 'x') === '' ? null : 'console OTP inbox not cleared'));

  await tool('test_ai_provider', { provider: 'groq' }, null, { expectFail: true });   // no key in the suite
  await tool('test_ai_provider', { provider: 'not-a-provider' }, null, { expectFail: true });
  /* Switching provider is only allowed once a key exists — store a fake one, the
     way the console would, then check the switch is really persisted. */
  setSetting('groq_api_key', 'gsk-suite-conformance-key');
  await tool('set_ai_provider', { provider: 'groq', model: 'openai/gpt-oss-20b', failover: false, rate_limit_per_min: 25 }, () => {
    if (getSetting('ai_provider', '') !== 'groq') return 'active provider not stored';
    if (getSetting('ai_model_groq', '') !== 'openai/gpt-oss-20b') return 'model not stored';
    if (getSetting('ai_failover', '1') !== '0') return 'failover flag not stored';
    if (getSetting('ai_rate_limit_per_min', '') !== '25') return 'rate cap not stored';
    return null;
  });
  await tool('set_ai_provider', { provider: 'not-a-provider' }, null, { expectFail: true });
  await tool('set_ai_provider', { provider: 'openai' }, null, { expectFail: true });   // connected but no key
  await tool('set_ai_provider', { rate_limit_per_min: 9000 }, null, { expectFail: true });
  await tool('set_ai_provider', { provider: 'groq', model: 'openai/gpt-oss-120b', failover: true, rate_limit_per_min: 40 }, () => (
    getSetting('ai_failover', '0') === '1' && getSetting('ai_model_groq', '') === 'openai/gpt-oss-120b'
      ? null : 'provider settings not restored'));
  setSetting('groq_api_key', '');

  await tool('manage_ai_models', { action: 'add', provider: 'groq', model: 'suite/custom-model-1' }, () => (
    JSON.parse(getSetting('ai_custom_models_groq', '[]')).includes('suite/custom-model-1')
      ? null : 'custom model id not stored'));
  await tool('manage_ai_models', { action: 'remove', provider: 'groq', model: 'suite/custom-model-1' }, () => (
    !JSON.parse(getSetting('ai_custom_models_groq', '[]')).includes('suite/custom-model-1')
      ? null : 'custom model id not removed'));
  await tool('manage_ai_models', { action: 'add', provider: 'groq', model: '' }, null, { expectFail: true });
  await tool('manage_ai_models', { action: 'sync', provider: 'groq' }, null, { expectFail: true });  // no key → nothing to sync

  db.prepare("INSERT INTO ai_audit_log (kind, action, payload, result, ok) VALUES ('settings','save','{}','suite',1)").run();
  db.prepare("INSERT INTO ai_moderation_log (listing_id, listing_name, decision, reason, model) VALUES (1,'Suite','approve','suite','m')").run();
  const auditRow = one('SELECT * FROM ai_audit_log ORDER BY id DESC');
  const modRow = one('SELECT * FROM ai_moderation_log ORDER BY id DESC');
  await tool('delete_ai_log_entry', { kind: 'audit', id: auditRow.id }, () => (
    !one('SELECT id FROM ai_audit_log WHERE id=?', auditRow.id) ? null : 'audit entry not deleted'));
  await tool('delete_ai_log_entry', { kind: 'moderation', id: modRow.id }, () => (
    !one('SELECT id FROM ai_moderation_log WHERE id=?', modRow.id) ? null : 'moderation entry not deleted'));
  await tool('delete_ai_log_entry', { kind: 'nonsense', id: 1 }, null, { expectFail: true });
  db.prepare("INSERT INTO ai_audit_log (kind, action, payload, result, ok) VALUES ('settings','save','{}','suite',1)").run();
  db.prepare("INSERT INTO ai_moderation_log (listing_id, listing_name, decision, reason, model) VALUES (1,'Suite','approve','suite','m')").run();
  await tool('clear_ai_logs', { kind: 'audit' }, () => (
    count('SELECT COUNT(*) c FROM ai_audit_log') === 0 ? null : 'audit log not cleared'));
  await tool('clear_ai_logs', { kind: 'both' }, () => (
    count('SELECT COUNT(*) c FROM ai_moderation_log') === 0 ? null : 'moderation log not cleared'));
  await tool('clear_ai_logs', { kind: 'nonsense' }, null, { expectFail: true });

  /* ---- The last three console actions: restore, Google key, recovery codes ---- */
  section('Backup restore, Google Indexing key, console recovery codes');
  const backupRes = await tool('create_backup', {}, (r) => (fs.existsSync(path.join(tmp, 'backups', r.file)) ? null : 'no backup file'));
  await tool('import_backup', { file: backupRes.result.file }, (r) => (
    typeof r.users_created === 'number' && typeof r.users_updated === 'number' ? null : 'import did not report what it did'));
  await tool('import_backup', { file: 'no-such-backup.firmledger' }, null, { expectFail: true });
  await tool('import_backup', { file: '../../../etc/passwd' }, null, { expectFail: true });
  await tool('import_backup', { payload: '{ not a firmledger export' }, null, { expectFail: true });
  await tool('import_backup', {}, null, { expectFail: true });

  await tool('set_google_service_account', { json: '{ "type": "service_account", "project_id": "suite" }' }, null, { expectFail: true });
  await tool('set_google_service_account', { json: '' }, null, { expectFail: true });
  /* A structurally valid key (the crypto pair is generated, never hard-coded). */
  const { generateKeyPairSync } = require('crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const saJson = JSON.stringify({
    type: 'service_account', project_id: 'firmledger-suite', private_key_id: 'keyid1',
    private_key: privateKey, client_email: 'indexer@firmledger-suite.iam.gserviceaccount.com',
    client_id: '100000000000000000001', token_uri: 'https://oauth2.googleapis.com/token',
  });
  await tool('set_google_service_account', { json: saJson }, (r) => {
    if (r.configured !== true) return 'Google Indexing did not report itself as connected';
    if (/BEGIN PRIVATE KEY/.test(JSON.stringify(r))) return 'the private key was echoed back';
    return null;
  });
  await tool('remove_google_service_account', {}, (r) => (
    r.still_configured === false ? null : 'the saved key was not removed'));

  setSetting('admin_totp_secret', 'JBSWY3DPEHPK3PXP');
  setSetting('admin_2fa_email', 'codes@example.com');
  await tool('regen_admin_recovery_codes', {}, (r) => {
    const stored = JSON.parse(getSetting('admin_recovery_codes', '[]'));
    if (stored.length !== 10) return `expected 10 hashed codes, found ${stored.length}`;
    if (stored.some((c) => !c.h || c.used !== 0)) return 'codes were not stored hashed and unused';
    if (r.emailed_to !== 'codes@example.com') return 'the codes were not sent to the console inbox';
    if (Array.isArray(r.codes) || JSON.stringify(r).includes('-----')) return 'the tool leaked the codes themselves';
    return null;
  });
  setSetting('admin_totp_secret', '');
  await tool('regen_admin_recovery_codes', {}, null, { expectFail: true });

  /* delete_* run last: they destroy fixtures */
  section('Destructive (run last)');
  await tool('delete_listing', { id_or_slug: 'beta-works' }, () => (
    !one('SELECT id FROM listings WHERE id=?', f.beta) ? null : 'listing still present'));
  await tool('delete_user', { user: 'member@example.com' }, () => (
    !one('SELECT id FROM users WHERE id=?', f.member) ? null : 'user still present'));

  const role = one('SELECT * FROM careers ORDER BY id DESC');
  await tool('delete_career', { id: role.id }, () => (
    !one('SELECT id FROM careers WHERE id=?', role.id) ? null : 'career role still present'));
  await tool('delete_career', { id: 999999 }, null, { expectFail: true });

  await tool('delete_incident', { id: inc.id }, () => (
    !one('SELECT id FROM incidents WHERE id=?', inc.id) ? null : 'incident still present'));
  await tool('delete_incident', { id: 999999 }, null, { expectFail: true });

  /* The bulk delete refuses to run without a target set — then obeys one. */
  const doomed = one("SELECT * FROM listings WHERE name='Conformance Fintech'");
  await tool('bulk_update_listings', { action: 'delete', ids: [String(doomed.id)] }, () => (
    !one('SELECT id FROM listings WHERE id=?', doomed.id) ? null : 'bulk delete did not remove the listing'));

  /* ============================ Coverage ============================ */
  section('Coverage');
  const missing = tools.TOOLS.map((t) => t.name).filter((n) => !covered.has(n));
  if (missing.length) {
    failures.push({ name: 'coverage', why: 'tools never exercised: ' + missing.join(', ') });
    console.log('  ✗ untested tools: ' + missing.join(', '));
  } else {
    passed++;
    console.log(`  ✓ all ${tools.TOOLS.length} registered tools exercised`);
  }

  /* ============================ Report ============================ */
  console.log(`\n${'='.repeat(64)}`);
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  if (failures.length) {
    for (const x of failures) console.log(`  • ${x.name}: ${x.why}`);
  }
  console.log('='.repeat(64));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
})();
