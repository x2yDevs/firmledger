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
const llmLib = require('../src/lib/llm');

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


  /* ==================== Full admin surface (registry part two) ==================== */
  section('Site knowledge & settings (read-only)');
  await tool('get_site_overview', {}, (r) => {
    if (r.product.name !== 'FirmLedger') return 'product name missing';
    if (r.admin_console.length < 15) return 'admin console map too short';
    if (r.public_pages.length < 15) return 'public page map too short';
    if (r.ai.provider_id !== 'groq' || !r.ai.provider_label) return 'active AI provider missing';
    if (!r.feature_flags || typeof r.feature_flags.auto_approve !== 'boolean') return 'feature flags missing';
    return null;
  });
  await tool('get_settings', {}, (r) => {
    if (typeof r.site.auto_approve !== 'boolean') return 'site flags missing';
    if (typeof r.protection.limits.login !== 'number') return 'rate limits missing';
    if (!r.ai.providers_with_keys) return 'provider list missing';
    return null;
  });
  await tool('get_listing', { id_or_slug: 'gamma-group' }, (r) => {
    if (r.listing.id !== f.gamma) return 'wrong listing returned';
    if (!r.listing.slug || r.listing.url.indexOf('/listing/gamma-group') === -1) return 'listing url missing';
    if (!Array.isArray(r.relationships) || !Array.isArray(r.events)) return 'relations/events missing';
    return null;
  });
  await tool('get_listing', { id_or_slug: 'does-not-exist' }, null, { expectFail: true });
  await tool('get_user', { user: 'owner@example.com' }, (r) => (
    r.user.id === f.owner && Array.isArray(r.listings) && Array.isArray(r.payments) ? null : 'member detail incomplete'));
  await tool('get_user', { user: 'nobody@example.com' }, null, { expectFail: true });
  await tool('list_content', { what: 'plans' }, (r) => (r.count >= 2 ? null : 'plan offers not listed'));
  await tool('list_content', { what: 'categories' }, (r) => (r.count > 0 ? null : 'categories not listed'));
  await tool('list_content', { what: 'subscribers' }, (r) => (r.active_total >= 1 ? null : 'subscriber count wrong'));
  await tool('list_content', { what: 'nonsense' }, null, { expectFail: true });
  await tool('list_news_queue', {}, (r) => (r.counts && Array.isArray(r.stories) ? null : 'news queue shape wrong'));
  await tool('get_admin_inbox', {}, (r) => (typeof r.unread === 'number' && Array.isArray(r.notifications) ? null : 'inbox shape wrong'));
  await tool('get_payments_summary', {}, (r) => (Array.isArray(r.totals) && typeof r.pro_users === 'number' ? null : 'revenue shape wrong'));
  await tool('get_indexing_status', {}, (r) => (
    typeof r.indexnow.log_rows === 'number' && r.google && r.upkeep ? null : 'indexing shape wrong'));
  await tool('get_status_page', {}, (r) => (r.components.length > 0 && r.overall ? null : 'status components missing'));
  await tool('get_ai_playground', {}, (r) => {
    if (r.providers.length < 10) return 'provider list too short';
    if (r.active_provider !== 'groq') return 'active provider wrong';
    const withKeys = r.providers.filter((p) => p.configured).map((p) => p.id);
    if (JSON.stringify(withKeys) !== JSON.stringify(llmLib.configuredProviders())) return 'configured provider list mismatch';
    return null;
  });

  section('Listing edits, bulk actions, relations and timeline');
  await tool('create_listing', {
    name: 'Extended QA Ltd', tagline: 'A fixture company created by the admin tool conformance suite.',
    description: 'Extended QA Ltd exists only inside the throwaway database used by the FirmLedger AI tool conformance test suite, and it is deleted again at the end of that run.',
    website: 'https://extended-qa.example.com', category: 'Technology', type: 'company', country: 'Kenya', city: 'Nairobi',
  }, (r) => {
    const row = one('SELECT * FROM listings WHERE id=?', r.id);
    if (!row) return 'listing row not inserted';
    if (row.status !== 'pending' || row.country !== 'Kenya') return 'listing stored wrong';
    return null;
  });
  const qaListing = one('SELECT * FROM listings WHERE name=?', 'Extended QA Ltd');
  await tool('create_listing', {
    name: 'Bad', tagline: 'short', description: 'too short', website: 'no-protocol.example',
    category: 'Technology', type: 'company', country: 'Kenya',
  }, null, { expectFail: true });

  await tool('update_listing', { id_or_slug: String(qaListing.id), city: 'Mombasa', size: '11-50', tags: 'qa, testing' }, (r) => {
    const row = one('SELECT city, size, tags FROM listings WHERE id=?', qaListing.id);
    if (row.city !== 'Mombasa' || row.size !== '11-50') return 'fields not written';
    return r.changed.length === 3 ? null : 'changed list wrong';
  });
  await tool('update_listing', { id_or_slug: 'no-such-listing', city: 'X' }, null, { expectFail: true });
  await tool('update_listing', { id_or_slug: String(qaListing.id) }, null, { expectFail: true });

  await tool('bulk_listing_action', { action: 'feature', ids: [f.gamma, f.delta] }, () => (
    count('SELECT COUNT(*) c FROM listings WHERE featured=1 AND id IN (?,?)', f.gamma, f.delta) === 2
      ? null : 'bulk feature did not apply to both'));
  await tool('bulk_listing_action', { action: 'unfeature', ids: [f.gamma, f.delta] }, () => (
    count('SELECT COUNT(*) c FROM listings WHERE featured=1 AND id IN (?,?)', f.gamma, f.delta) === 0
      ? null : 'bulk unfeature did not clear both'));
  await tool('bulk_listing_action', { action: 'approve' }, null, { expectFail: true });
  await tool('bulk_listing_action', { action: 'sponsor', ids: [f.gamma], days: 30 }, () => {
    const row = one('SELECT sponsored, sponsored_expires_at FROM listings WHERE id=?', f.gamma);
    return row.sponsored === 1 && row.sponsored_expires_at ? null : 'sponsorship not applied';
  });
  await tool('bulk_listing_action', { action: 'unsponsor', ids: [f.gamma] }, () => (
    one('SELECT sponsored FROM listings WHERE id=?', f.gamma).sponsored === 0 ? null : 'sponsorship not cleared'));

  await tool('set_listing_relation', { id_or_slug: 'gamma-group', rel_type: 'subsidiary', target: 'delta-co', note: 'QA relation' }, () => (
    one('SELECT * FROM relationships WHERE listing_id=? AND rel_type=?', f.gamma, 'subsidiary') ? null : 'relation not stored'));
  const rel = one('SELECT * FROM relationships WHERE listing_id=? AND rel_type=?', f.gamma, 'subsidiary');
  await tool('set_listing_relation', { id_or_slug: 'gamma-group', action: 'remove', relation_id: rel.id }, () => (
    !one('SELECT * FROM relationships WHERE id=?', rel.id) ? null : 'relation not removed'));

  await tool('manage_listing_event', { id_or_slug: 'gamma-group', title: 'QA funding round', event_date: '2026-01-15', kind: 'funding' }, () => (
    one("SELECT * FROM listing_events WHERE listing_id=? AND title='QA funding round'", f.gamma) ? null : 'event not stored'));
  const ev = one("SELECT * FROM listing_events WHERE listing_id=? AND title='QA funding round'", f.gamma);
  await tool('manage_listing_event', { id_or_slug: 'gamma-group', action: 'delete', event_id: ev.id }, () => (
    !one('SELECT * FROM listing_events WHERE id=?', ev.id) ? null : 'event not deleted'));

  section('Content: blog, news, careers, promos, offers, adverts');
  db.prepare("INSERT INTO blog_posts (slug, title, excerpt, body, status) VALUES ('qa-post','QA Post','QA excerpt','QA body copy for the conformance suite.','draft')").run();
  const post = one("SELECT * FROM blog_posts WHERE slug='qa-post'");
  await tool('edit_blog_post', { id: post.id, title: 'QA Post Edited', status: 'published' }, () => {
    const row = one('SELECT title, status, published_at FROM blog_posts WHERE id=?', post.id);
    return row.title === 'QA Post Edited' && row.status === 'published' && row.published_at ? null : 'post not updated';
  });
  await tool('edit_blog_post', { id: 999999, title: 'Nope' }, null, { expectFail: true });

  await tool('create_news_story', { id_or_slug: 'gamma-group', title: 'Gamma Group opens a new office', url: 'https://newsroom.example/gamma-office', source: 'QA News', published_at: '2026-02-01', summary: 'A hand-written story added by the conformance suite.' }, () => (
    one("SELECT * FROM listing_news WHERE listing_id=? AND title='Gamma Group opens a new office'", f.gamma) ? null : 'story not stored'));
  const story = one("SELECT * FROM listing_news WHERE listing_id=? AND title='Gamma Group opens a new office'", f.gamma);
  await tool('delete_news_story', { id: story.id }, () => (
    !one('SELECT * FROM listing_news WHERE id=?', story.id) ? null : 'story not deleted'));
  await tool('set_news_settings', { review_auto: true }, () => (
    getSetting('news_review_auto', '0') === '1' ? null : 'news_review_auto not stored'));
  await tool('set_news_settings', { review_auto: false }, () => (
    getSetting('news_review_auto', '0') === '0' ? null : 'news_review_auto not cleared'));

  /* News sweep + IndexNow + status probes need the canned offline fetch stub.
     It was already required (and then restored) by the technology section, so
     drop it from the require cache to re-install the stubbed fetch. */
  const realFetch = globalThis.fetch;
  delete require.cache[require.resolve('./helpers/fetch-stub.js')];
  require('./helpers/fetch-stub.js');
  await tool('run_news_refresh', { action: 'one', id_or_slug: 'gamma-group' }, (r) => (
    r.added >= 1 && one('SELECT news_checked_at FROM listings WHERE id=?', f.gamma).news_checked_at ? null : 'no story matched the canned feed'));
  await tool('run_news_refresh', { action: 'cancel' }, (r) => (r.cancelled === false ? null : 'cancel should be a no-op with no job running'));
  await tool('ping_indexnow', { paths: ['/listing/gamma-group'] }, (r) => (
    r.submitted === 1 && count('SELECT COUNT(*) c FROM indexing_log') > 0 ? null : 'IndexNow ping not logged'));
  await tool('run_status_check', {}, (r) => (r.components.length > 0 && r.overall ? null : 'probe returned no components'));

  db.prepare("INSERT INTO careers (title, role_type, location, description, requirements, status) VALUES ('QA Engineer','Full-time','Nairobi','A quality engineer for the conformance suite fixture.','Write tests and ship them.','open')").run();
  const role = one("SELECT * FROM careers WHERE title='QA Engineer'");
  await tool('edit_career', { id: role.id, location: 'Remote', status: 'closed' }, () => {
    const row = one('SELECT location, status FROM careers WHERE id=?', role.id);
    return row.location === 'Remote' && row.status === 'closed' ? null : 'role not updated';
  });
  await tool('delete_career', { id: role.id }, () => (
    !one('SELECT * FROM careers WHERE id=?', role.id) ? null : 'role not deleted'));

  await tool('create_promo', { code: 'QASUITE', percent: 15, note: 'conformance' }, () => (
    one("SELECT * FROM promo_codes WHERE code='QASUITE'") ? null : 'promo not stored'));
  const promo = one("SELECT * FROM promo_codes WHERE code='QASUITE'");
  await tool('delete_promo', { id: promo.id }, () => (
    !one('SELECT * FROM promo_codes WHERE id=?', promo.id) ? null : 'promo not deleted'));

  await tool('create_plan_offer', { name: 'QA Deletable', price_usd: 5, duration_days: 30 }, () => (
    one("SELECT * FROM plans WHERE name='QA Deletable'") ? null : 'offer not created'));
  const doomed = one("SELECT * FROM plans WHERE name='QA Deletable'");
  await tool('delete_plan_offer', { id: doomed.id }, () => (
    !one('SELECT * FROM plans WHERE id=?', doomed.id) ? null : 'offer not deleted'));

  await tool('set_ad_package', { action: 'create', name: 'QA Spotlight', blurb: 'Conformance fixture', price_usd: 12, duration_days: 14 }, (r) => (
    one('SELECT * FROM ad_packages WHERE id=?', r.id) ? null : 'package not created'));
  const pkg = one("SELECT * FROM ad_packages WHERE name='QA Spotlight'");
  await tool('set_ad_package', { action: 'toggle', id: pkg.id }, () => (
    one('SELECT active FROM ad_packages WHERE id=?', pkg.id).active === 0 ? null : 'package not hidden'));
  await tool('set_ad_package', { action: 'delete', id: pkg.id }, () => (
    !one('SELECT * FROM ad_packages WHERE id=?', pkg.id) ? null : 'package not deleted'));

  section('Indexing, upkeep and background jobs');
  await tool('run_tech_refresh', { action: 'start', scope: 'selected', ids: [f.gamma] }, (r) => (
    r.queued === 1 && r.job.status === 'running' ? null : 'sweep did not start'));
  await tool('run_tech_refresh', { action: 'cancel' }, (r) => (
    r.cancelled === true ? null : 'running sweep was not cancellable'));
  await tool('run_upkeep_sweep', { force: true }, (r) => (r.tech || r.news ? null : 'sweep returned nothing'));
  await tool('set_upkeep_settings', { on: true, tech_limit: 12, news_limit: 9, news_max_age_days: 5 }, () => {
    const s = JSON.parse(getSetting('upkeep_last_run', '{}') || '{}');
    if (getSetting('upkeep_tech_limit', '') !== '12') return 'tech_limit not stored';
    if (getSetting('upkeep_news_limit', '') !== '9') return 'news_limit not stored';
    if (getSetting('upkeep_news_max_age_days', '') !== '5') return 'news_max_age_days not stored';
    if (getSetting('upkeep_on', '') !== '1') return 'upkeep master switch not stored';
    return null;
  });
  await tool('set_google_indexing', { on: true }, () => (
    getSetting('google_indexing_enabled', '0') === '1' ? null : 'google indexing flag not stored'));
  await tool('run_google_indexing_batch', { limit: 5 }, (r) => (r.quota && r.quota.limit === 200 ? null : 'quota not reported'));
  await tool('remove_google_credentials', {}, null, { expectFail: true });
  await tool('clear_indexing_logs', { all: true }, () => (
    count('SELECT COUNT(*) c FROM indexing_log') === 0 ? null : 'indexing log not cleared'));
  globalThis.fetch = realFetch;

  section('Status page, incidents and site settings');
  await tool('delete_incident', { id: one('SELECT id FROM incidents ORDER BY id DESC LIMIT 1').id }, (r) => (
    !one('SELECT * FROM incidents WHERE id=?', r.deleted) ? null : 'incident still present'));
  await tool('reset_status_component', { slug: 'web' }, (r) => (
    r.id && one('SELECT status FROM status_components WHERE id=?', r.id).status === 'operational' ? null : 'component not reset'));
  await tool('reset_status_component', { slug: 'no-such-component' }, null, { expectFail: true });
  await tool('set_weekly_status_report', { on: true }, () => (
    getSetting('status_weekly_report', '0') === '1' ? null : 'weekly report flag not stored'));
  await tool('set_site_setting', { key: 'auto_approve', value: '1' }, () => (
    getSetting('auto_approve', '0') === '1' ? null : 'auto_approve not stored'));
  await tool('set_site_setting', { key: 'newsletter_cadence', value: 'monthly' }, () => (
    getSetting('newsletter_cadence', '') === 'monthly' ? null : 'cadence not stored'));
  await tool('set_site_setting', { key: 'newsletter_cadence', value: 'hourly' }, null, { expectFail: true });
  await tool('set_site_setting', { key: 'not_a_setting', value: '1' }, null, { expectFail: true });
  await tool('set_site_setting', { key: 'auto_approve', value: '0' });

  section('Admin inbox, notifications and backups');
  await tool('notify_admin_inbox', { title: 'QA note', body: 'Left by the conformance suite.', url: '/admin3119Musa', kind: 'system' }, (r) => (
    one("SELECT * FROM notifications WHERE audience='admin' AND title='QA note'") ? null : 'notification not written'));
  const note = one("SELECT * FROM notifications WHERE audience='admin' AND title='QA note'");
  await tool('manage_notification', { action: 'read', id: note.id }, () => (
    one('SELECT read_at FROM notifications WHERE id=?', note.id).read_at ? null : 'not marked read'));
  await tool('manage_notification', { action: 'archive', id: note.id, duration: 'week' }, () => (
    one('SELECT deleted_at FROM notifications WHERE id=?', note.id).deleted_at ? null : 'not moved to trash'));
  await tool('manage_notification', { action: 'restore', id: note.id }, () => (
    !one('SELECT deleted_at FROM notifications WHERE id=?', note.id).deleted_at ? null : 'not restored'));
  await tool('manage_notification', { action: 'archive', id: note.id, duration: 'week' });
  await tool('manage_notification', { action: 'delete', id: note.id }, () => (
    !one('SELECT * FROM notifications WHERE id=?', note.id) ? null : 'not deleted for good'));
  await tool('export_backup', {}, (r) => {
    if (!r.path || !r.bytes) return 'no backup path returned';
    if (!require('fs').existsSync(r.path)) return 'backup file was not written';
    const head = JSON.parse(require('fs').readFileSync(r.path, 'utf8'));
    return head.kind === 'full-backup' ? null : 'backup payload is not a full backup';
  });
  await tool('set_admin_2fa_email', { email: 'qa-admin@example.com' }, () => (
    getSetting('admin_2fa_email', '') === 'qa-admin@example.com' ? null : 'OTP inbox not stored'));
  await tool('set_admin_2fa_email', { email: 'not-an-email' }, null, { expectFail: true });

  section('Email delivery, protection and credentials');
  await tool('set_mail_account', { action: 'add', provider: 'brevo', label: 'QA Brevo', host: 'smtp-relay.brevo.com', port: 587, username: 'qa@example.com', password: 'qa-secret', daily_limit: 100 }, () => (
    one("SELECT * FROM smtp_accounts WHERE label='QA Brevo'") ? null : 'SMTP account not stored'));
  const acct = one("SELECT * FROM smtp_accounts WHERE label='QA Brevo'");
  await tool('set_mail_account', { action: 'toggle', id: acct.id }, () => (
    one('SELECT active FROM smtp_accounts WHERE id=?', acct.id).active === 0 ? null : 'account not disabled'));
  await tool('set_mail_account', { action: 'delete', id: acct.id }, () => (
    !one('SELECT * FROM smtp_accounts WHERE id=?', acct.id) ? null : 'account not deleted'));
  await tool('set_mail_from', { from: 'FirmLedger QA <qa@firmledger.test>' }, () => (
    getSetting('smtp_from', '') === 'FirmLedger QA <qa@firmledger.test>' ? null : 'From address not stored'));
  await tool('set_mail_from', { from: 'nonsense' }, null, { expectFail: true });
  await tool('send_test_mail', { to: 'qa-admin@example.com' }, null, { expectFail: true });
  await tool('set_smtp_settings', { host: 'smtp.qa.test', port: 2525, username: 'qa', password: 'secret', secure: false, from: 'FirmLedger QA <qa@firmledger.test>' }, () => {
    if (getSetting('smtp_host', '') !== 'smtp.qa.test') return 'host not stored';
    if (getSetting('smtp_port', '') !== '2525') return 'port not stored';
    if (getSetting('smtp_user', '') !== 'qa') return 'username not stored';
    return null;
  });
  await tool('set_paypal_settings', { client_id: 'QA-CLIENT', client_secret: 'QA-SECRET', mode: 'sandbox' }, () => {
    if (getSetting('paypal_client_id', '') !== 'QA-CLIENT') return 'client id not stored';
    if (getSetting('paypal_mode', '') !== 'sandbox') return 'mode not stored';
    return null;
  });

  await tool('block_ip', { ip: '198.51.100.7', kind: 'block', note: 'qa' }, () => (
    one("SELECT * FROM spam_ip WHERE value='198.51.100.7'") ? null : 'ip rule not stored'));
  const ipRule = one("SELECT * FROM spam_ip WHERE value='198.51.100.7'");
  await tool('delete_spam_rule', { list: 'ip', id: ipRule.id }, () => (
    !one('SELECT * FROM spam_ip WHERE id=?', ipRule.id) ? null : 'ip rule not removed'));
  await tool('block_domain', { domain: 'qa-spam.example', kind: 'block', note: 'qa' }, () => (
    one("SELECT * FROM spam_domain WHERE value='qa-spam.example'") ? null : 'domain rule not stored'));
  const domRule = one("SELECT * FROM spam_domain WHERE value='qa-spam.example'");
  await tool('delete_spam_rule', { list: 'domain', id: domRule.id }, () => (
    !one('SELECT * FROM spam_domain WHERE id=?', domRule.id) ? null : 'domain rule not removed'));
  await tool('set_rate_limits', { login: 12, api_read_rpm: 90 }, () => {
    if (getSetting('spam_rl_login', '') !== '12') return 'login limit not stored';
    if (getSetting('api_read_rpm', '') !== '90') return 'api_read_rpm not stored';
    return null;
  });
  await tool('set_rate_limits', { login: 999999999 }, null, { expectFail: true });

  section('Sensitive actions always ask (never auto-run)');
  const SENSITIVE = tools.sensitiveTools();
  setSetting('ai_auto_tools', JSON.stringify(SENSITIVE));   // try to auto-run everything
  const leaked = SENSITIVE.filter((n) => tools.isAuto(n));
  if (leaked.length) {
    failures.push({ name: 'sensitive', why: 'sensitive tools became auto-run: ' + leaked.join(', ') });
    console.log('  ✗ sensitive tools auto-runnable: ' + leaked.join(', '));
  } else {
    passed++;
    console.log(`  ✓ all ${SENSITIVE.length} sensitive actions still require confirmation`);
  }
  const savedAuto = tools.saveAutoTools([...SENSITIVE, 'approve_listing', 'feature_listing']);
  if (savedAuto.some((n) => SENSITIVE.includes(n))) {
    failures.push({ name: 'saveAutoTools', why: 'sensitive names were persisted: ' + savedAuto.join(', ') });
    console.log('  ✗ saveAutoTools stored sensitive names');
  } else if (!savedAuto.includes('approve_listing') || !savedAuto.includes('feature_listing')) {
    failures.push({ name: 'saveAutoTools', why: 'ordinary write actions were dropped' });
    console.log('  ✗ saveAutoTools dropped ordinary actions');
  } else {
    passed++;
    console.log(`  ✓ saveAutoTools keeps ordinary writes and refuses sensitive ones (${savedAuto.length} saved)`);
  }
  const sensitiveCatalogue = tools.catalog().filter((t) => t.sensitive);
  if (sensitiveCatalogue.length !== SENSITIVE.length || sensitiveCatalogue.some((t) => t.auto)) {
    failures.push({ name: 'catalog', why: 'sensitive tools are not all flagged in the console catalogue' });
    console.log('  ✗ catalogue sensitive flags wrong');
  } else {
    passed++;
    console.log(`  ✓ console catalogue flags ${sensitiveCatalogue.length} actions as always-confirm`);
  }
  setSetting('ai_auto_tools', JSON.stringify([]));

  /* delete_* run last: they destroy fixtures */
  section('Destructive (run last)');
  await tool('delete_listing', { id_or_slug: 'beta-works' }, () => (
    !one('SELECT id FROM listings WHERE id=?', f.beta) ? null : 'listing still present'));
  await tool('delete_user', { user: 'member@example.com' }, () => (
    !one('SELECT id FROM users WHERE id=?', f.member) ? null : 'user still present'));

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
