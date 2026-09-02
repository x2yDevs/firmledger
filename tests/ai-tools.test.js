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
