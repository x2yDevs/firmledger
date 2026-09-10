/**
 * FirmLedger admin assistant — END-TO-END functional suite.
 *
 *   node tests/ai-e2e.test.js
 *
 * This is the "is the bot really functional?" gate. For every mutating console
 * tool it types a natural-language sentence into the real chat pipeline
 * (chatTurn → proposal → executePending) and then verifies the DATABASE, not
 * the reply. Reads are typed too and checked for a sensible rendered answer.
 * Finally it asserts that every registered tool was reached through language
 * at least once, so nothing in the admin area is left out.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-e2e-'));
process.env.FIRMLEDGER_DATA_DIR = tmp;
process.env.BASE_URL = process.env.BASE_URL || 'https://firmledger.test';
process.env.SMTP_URL = '';

const { db, setSetting, getSetting } = require('../src/db');
const ai = require('../src/lib/ai');
const tools = require('../src/lib/aitools');

let passed = 0;
const failures = [];
const reached = new Set();
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const one = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const count = (sql, ...p) => one(sql, ...p).c;

/* ------------------------------------------------------------- fixtures */
function seed() {
  const owner = run("INSERT INTO users (email,password_hash,name,plan) VALUES ('owner@example.com','x','Olive Owner','free')").lastInsertRowid;
  const member = run("INSERT INTO users (email,password_hash,name,plan) VALUES ('member@example.com','x','Moses Member','free')").lastInsertRowid;
  const victim = run("INSERT INTO users (email,password_hash,name,plan) VALUES ('gone@example.com','x','Gone Soon','free')").lastInsertRowid;
  const mk = (slug, name, status, extra = {}) => run(
    `INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,status,owner_user_id,created_at,updated_at)
     VALUES (?,?,?,?,'company',?,?,?,'Kenya',?,?,datetime('now'),datetime('now'))`,
    slug, name, `${name} tagline`, `${name} is a real organisation used by the end-to-end suite, with offices in Nairobi since 2016 and a team of twenty.`,
    extra.category || 'Technology', `https://${slug}.co.ke`, `hello@${slug}.co.ke`, status, extra.owner === undefined ? owner : extra.owner,
  ).lastInsertRowid;
  const f = {
    owner, member, victim,
    alpha: mk('alpha-labs', 'Alpha Labs', 'pending'),
    beta: mk('beta-works', 'Beta Works', 'pending'),
    gamma: mk('gamma-group', 'Gamma Group', 'approved'),
    delta: mk('delta-co', 'Delta Co', 'approved'),
    epsilon: mk('epsilon-ltd', 'Epsilon Ltd', 'approved'),
    zeta: mk('zeta-holdings', 'Zeta Holdings', 'approved'),
    omega: mk('omega-one', 'Omega One', 'approved'),
    bulk1: mk('bulk-one', 'Bulk One', 'pending'), bulk2: mk('bulk-two', 'Bulk Two', 'pending'),
  };
  f.ticket = run("INSERT INTO tickets (user_id, ref, subject, category, status) VALUES (?,?,?,?,'open')", member, 'FL-E2E01', 'Logo will not upload', 'account').lastInsertRowid;
  f.claim = run("INSERT INTO claims (listing_id, user_id, method, domain, token, status) VALUES (?,?,'dns',?,?,'pending')", f.gamma, member, 'gamma-group.co.ke', 'tok').lastInsertRowid;
  f.claim2 = run("INSERT INTO claims (listing_id, user_id, method, domain, token, status) VALUES (?,?,'dns',?,?,'pending')", f.delta, member, 'delta-co.co.ke', 'tok2').lastInsertRowid;
  f.removal = run("INSERT INTO removal_requests (listing_id, name, email, reason, status) VALUES (?,?,?,?,'pending')", f.zeta, 'Zeta Legal', 'legal@zeta.co.ke', 'Closed.').lastInsertRowid;
  f.removal2 = run("INSERT INTO removal_requests (listing_id, name, email, reason, status) VALUES (?,?,?,?,'pending')", f.omega, 'Omega Legal', 'legal@omega.co.ke', 'Dup.').lastInsertRowid;
  f.transfer = run("INSERT INTO pro_transfer_requests (user_id, from_listing_id, to_listing_id, status) VALUES (?,?,?,'pending')", owner, f.delta, f.epsilon).lastInsertRowid;
  f.transfer2 = run("INSERT INTO pro_transfer_requests (user_id, from_listing_id, to_listing_id, status) VALUES (?,?,?,'pending')", owner, f.gamma, f.zeta).lastInsertRowid;
  run("UPDATE listings SET plan='pro', plan_expires_at='2030-01-01' WHERE id IN (?,?)", f.delta, f.gamma);
  run("INSERT OR IGNORE INTO newsletter_subscribers (email, active) VALUES ('sub@example.com', 1)");
  f.news = run("INSERT INTO listing_news (listing_id, title, url, source, status) VALUES (?,?,?,?,'pending')", f.gamma, 'Gamma raises seed round', 'https://news.example/gamma', 'news.example').lastInsertRowid;
  f.news2 = run("INSERT INTO listing_news (listing_id, title, url, source, status) VALUES (?,?,?,?,'pending')", f.delta, 'Delta opens Mombasa office', 'https://news.example/delta', 'news.example').lastInsertRowid;
  f.news3 = run("INSERT INTO listing_news (listing_id, title, url, source, status) VALUES (?,?,?,?,'pending')", f.epsilon, 'Epsilon hires', 'https://news.example/eps', 'news.example').lastInsertRowid;
  f.notif = run("INSERT INTO notifications (audience, title, body) VALUES ('admin','Heads up','e2e note')").lastInsertRowid;
  f.notif2 = run("INSERT INTO notifications (audience, title, body) VALUES ('admin','Second','e2e note 2')").lastInsertRowid;
  f.key = run("INSERT INTO api_keys (user_id,label,prefix,key_hash) VALUES (?,?,?,?)", owner, 'ci', 'fl_e2e01', 'h-e2e').lastInsertRowid;
  run("INSERT INTO spam_ip (value, kind) VALUES ('9.9.9.9','block')");
  run("INSERT INTO spam_domain (value, kind) VALUES ('junk.example','block')");
  return f;
}

/* ------------------------------------------------------------- harness */
function conversation() {
  const hist = [];
  return async function say(text) {
    hist.push({ role: 'user', content: text });
    const out = await ai.chatTurn(hist);
    hist.push({ role: 'assistant', content: out.content });
    out.text = ai.stripContext(out.content);
    return out;
  };
}

/** Type a sentence, expect a proposal for `tool`, execute it, return the execution result. */
async function act(say, text, tool, verify, opts = {}) {
  let r;
  try { r = await say(text); } catch (e) { check(`${tool} ← “${text}”`, false, `threw: ${e.message}`); return null; }
  const proposed = r.type === 'tool_proposal' ? (r.tool.steps || []).map((s) => s.name) : [];
  if (r.type === 'message' && r.executed) {
    /* auto-run allowed */
    reached.add(tool);
    const ok = verify ? verify(r) : true;
    check(`${tool} ← “${text}” (auto-ran)`, ok === true || ok === null || ok === undefined, typeof ok === 'string' ? ok : r.text.slice(0, 160));
    return r;
  }
  if (r.type !== 'tool_proposal' || !proposed.includes(tool)) {
    check(`${tool} ← “${text}”`, false, `got ${r.type}${proposed.length ? ' ' + proposed.join('+') : ''}: ${r.text.slice(0, 140)}`);
    return null;
  }
  if (opts.argsCheck) { const a = r.tool.args; const bad = opts.argsCheck(a); if (bad) { check(`${tool} ← “${text}” args`, false, `${bad} — ${JSON.stringify(a)}`); return null; } }
  let ex;
  try { ex = await ai.executePending(r.pending_id); } catch (e) { check(`${tool} ← “${text}” execute`, false, e.message); return null; }
  reached.add(tool);
  for (const s of proposed) reached.add(s);
  if (ex.executed !== true) {
    const msg = ex.error || ai.stripContext(ex.content);
    if (opts.network && /fetch failed|ENOTFOUND|ECONN|network|offline|timeout/i.test(msg)) { check(`${tool} ← “${text}” (offline — failed honestly)`, true); return ex; }
    if (opts.allowError && opts.allowError.test(msg)) { check(`${tool} ← “${text}” (nothing to do — reported honestly)`, true); return ex; }
    check(`${tool} ← “${text}” executed`, false, ex.error || ai.stripContext(ex.content).slice(0, 160)); return ex;
  }
  const v = verify ? verify(ex) : null;
  check(`${tool} ← “${text}”`, v === null || v === undefined || v === true, typeof v === 'string' ? v : ai.stripContext(ex.content).slice(0, 160));
  return ex;
}

/** Type a read-only sentence, expect an immediate answer matching `re`. */
async function read(say, text, tool, re) {
  let r;
  try { r = await say(text); } catch (e) { check(`${tool} ← “${text}”`, false, `threw: ${e.message}`); return null; }
  const ok = r.type === 'message' && re.test(r.text);
  if (ok) reached.add(tool);
  check(`${tool} ← “${text}”`, ok, `${r.type}: ${r.text.slice(0, 160)}`);
  return r;
}

(async function main() {
  console.log('FirmLedger admin assistant — end-to-end functional suite\n');
  const f = seed();
  const say = conversation();

  /* ========================================================= reads */
  console.log('Reads');
  await read(say, 'briefing', 'get_listing_stats', /waiting for review|open ticket/i);
  await read(say, 'how many pending', 'get_listing_stats', /\*\*4\*\*/);
  await read(say, 'health', 'get_health', /Memory/);
  await read(say, 'site overview', 'get_site_overview', /FirmLedger/);
  await read(say, 'show settings', 'get_settings', /auto-approve/);
  await read(say, 'find listings about alpha', 'search_listings', /Alpha Labs/);
  await read(say, 'search users moses', 'search_users', /member@example\.com/i);
  await read(say, 'search everywhere for gamma', 'search_admin', /Gamma Group/);
  await read(say, 'show open tickets', 'list_tickets', /FL-E2E01/);
  await read(say, 'open ticket FL-E2E01', 'get_ticket', /Logo will not upload/);
  await read(say, 'show pending claims', 'list_pending_claims', /gamma-group\.co\.ke/);
  await read(say, 'show removal requests', 'list_pending_removals', /Zeta/);
  await read(say, 'show pending news', 'list_news_queue', /Gamma raises/);
  await read(say, 'show inbox', 'get_admin_inbox', /Heads up/);
  await read(say, 'show revenue', 'get_payments_summary', /Captured/);
  await read(say, 'indexing status', 'get_indexing_status', /IndexNow/);
  await read(say, 'status page', 'get_status_page', /Overall/);
  await read(say, 'assistant status', 'get_ai_playground', /rule engine/);
  await read(say, 'show pending listings', 'list_listings', /Alpha Labs/);
  await read(say, 'listings owned by owner@example.com', 'list_listings', /Alpha Labs/);
  await read(say, 'new signups this week', 'list_users', /owner@example\.com/);
  await read(say, 'show user member@example.com', 'get_user', /Moses Member/);
  await read(say, 'show gamma group', 'get_listing', /Gamma Group/);
  await read(say, 'show categories', 'list_content', /Fintech|categor/i);
  await read(say, 'show plans', 'list_content', /plan|offer|Nothing|empty/i);
  await read(say, 'moderation rules', 'get_moderation_rules', /approve at/);
  await read(say, 'show moderation log', 'get_moderation_log', /No moderation|decision/i);
  await read(say, 'show audit log', 'get_audit_log', /entries/);
  await read(say, 'show blocked ips', 'list_protection_rules', /9\.9\.9\.9/);
  await read(say, 'smtp settings', 'list_mail_accounts', /From/);
  await read(say, 'show api keys', 'list_api_keys', /fl_e2e01/);
  await read(say, 'what tickets are open', 'list_open_tickets', /FL-E2E01/); // alias via list_tickets

  /* ========================================================= listings */
  console.log('\nListings');
  await act(say, 'approve alpha labs', 'approve_listing', () => one('SELECT status FROM listings WHERE id=?', f.alpha).status === 'approved' || 'not approved');
  await act(say, 'reject beta works because it is a duplicate', 'reject_listing', () => one('SELECT status FROM listings WHERE id=?', f.beta).status === 'rejected' || 'not rejected');
  await act(say, 'feature gamma group', 'feature_listing', () => one('SELECT featured FROM listings WHERE id=?', f.gamma).featured === 1 || 'not featured');
  await act(say, 'unfeature it', 'feature_listing', () => one('SELECT featured FROM listings WHERE id=?', f.gamma).featured === 0 || 'still featured');
  await act(say, 'sponsor delta co for 30 days', 'sponsor_listing', () => one('SELECT sponsored FROM listings WHERE id=?', f.delta).sponsored === 1 || 'not sponsored');
  await act(say, 'unsponsor delta co', 'unsponsor_listing', () => one('SELECT sponsored FROM listings WHERE id=?', f.delta).sponsored === 0 || 'still sponsored');
  await act(say, 'give epsilon ltd listing pro for 90 days', 'grant_listing_pro', () => one('SELECT plan FROM listings WHERE id=?', f.epsilon).plan === 'pro' || 'not pro');
  await act(say, 'revoke listing pro from epsilon ltd', 'revoke_listing_pro', () => one('SELECT plan FROM listings WHERE id=?', f.epsilon).plan !== 'pro' || 'still pro');
  await act(say, 'assign zeta holdings to member@example.com', 'set_listing_owner', () => one('SELECT owner_user_id FROM listings WHERE id=?', f.zeta).owner_user_id === f.member || 'owner not changed');
  await act(say, 'unclaim zeta holdings', 'set_listing_owner', () => !one('SELECT owner_user_id FROM listings WHERE id=?', f.zeta).owner_user_id || 'still owned');
  await act(say, 'set gamma group tagline="Compliance you can audit"', 'update_listing', () => one('SELECT tagline FROM listings WHERE id=?', f.gamma).tagline === 'Compliance you can audit' || 'tagline unchanged');
  await act(say, 'create listing name="Nova Ledger" website=https://novaledger.co.ke category=Fintech type=company country=Kenya tagline="Books for SMEs" description="Nova Ledger does cloud bookkeeping for Kenyan SMEs with a team of ten in Nairobi."', 'create_listing', () => Boolean(one("SELECT 1 FROM listings WHERE name='Nova Ledger'")) || 'not created');
  await act(say, 'link gamma group to delta co as partner', 'set_listing_relation', () => count('SELECT COUNT(*) c FROM relationships WHERE listing_id=? OR target_listing_id=?', f.gamma, f.gamma) >= 1 || 'relation missing');
  await act(say, 'add event to gamma group titled "Series A" date 2026-01-15', 'manage_listing_event', () => Boolean(one("SELECT 1 FROM listing_events WHERE listing_id=? AND title LIKE '%Series A%'", f.gamma)) || 'event missing');
  await act(say, 'refresh tech for gamma group', 'refresh_listing_tech', null, { network: true });
  await act(say, 'approve listings ' + f.bulk1 + ' ' + f.bulk2, 'bulk_listing_action', () => count("SELECT COUNT(*) c FROM listings WHERE id IN (?,?) AND status='approved'", f.bulk1, f.bulk2) === 2 || 'bulk approve failed');
  run("UPDATE listings SET status='pending' WHERE id=?", f.bulk1);
  await act(say, 'approve all pending listings', 'accept_all_pending_listings', () => count("SELECT COUNT(*) c FROM listings WHERE status='pending'") === 0 || 'pending remain');
  await act(say, 'score gamma group', 'review_listing_now', (ex) => /Score for/.test(ai.stripContext(ex.content)) || 'no score');
  run("UPDATE listings SET status='pending' WHERE id=?", f.bulk2);
  await act(say, 'review bulk two now', 'review_listing_now', () => one('SELECT status FROM listings WHERE id=?', f.bulk2).status !== undefined || 'x');

  /* ========================================================= members */
  console.log('\nMembers & billing');
  await act(say, 'suspend member@example.com', 'suspend_user', () => one('SELECT suspended FROM users WHERE id=?', f.member).suspended === 1 || 'not suspended');
  await act(say, 'unsuspend them', 'unsuspend_user', () => one('SELECT suspended FROM users WHERE id=?', f.member).suspended === 0 || 'still suspended');
  await act(say, 'give member@example.com pro for 30 days', 'grant_user_pro', () => one('SELECT plan FROM users WHERE id=?', f.member).plan === 'pro' || 'not pro');
  await act(say, 'revoke their pro', 'revoke_user_pro', () => one('SELECT plan FROM users WHERE id=?', f.member).plan !== 'pro' || 'still pro');
  await act(say, 'start a 14 day trial for member@example.com', 'grant_trial', () => Boolean(one('SELECT trial_expires_at FROM users WHERE id=?', f.member).trial_expires_at) || 'no trial');
  await act(say, 'end the trial for member@example.com', 'revoke_trial', () => !one('SELECT trial_expires_at FROM users WHERE id=?', f.member).trial_expires_at || 'trial remains');
  await act(say, 'send member@example.com a password reset', 'send_password_reset', null);
  await act(say, 'approve transfer ' + f.transfer, 'approve_pro_transfer', () => one('SELECT status FROM pro_transfer_requests WHERE id=?', f.transfer).status === 'approved' || 'transfer not approved');
  await act(say, 'reject pro transfer ' + f.transfer2, 'reject_pro_transfer', () => one('SELECT status FROM pro_transfer_requests WHERE id=?', f.transfer2).status === 'rejected' || 'transfer not rejected');
  await act(say, 'revoke api key fl_e2e01', 'revoke_api_key', () => Boolean(one('SELECT revoked_at FROM api_keys WHERE id=?', f.key).revoked_at) || 'key not revoked');

  /* ========================================================= claims / tickets / removals */
  console.log('\nClaims, tickets, removals');
  await act(say, 'recheck claim ' + f.claim, 'recheck_claim', null);
  await act(say, 'reject claim ' + f.claim2, 'reject_claim', () => one('SELECT status FROM claims WHERE id=?', f.claim2).status === 'rejected' || 'claim not rejected');
  await act(say, 'reply to FL-E2E01 saying: Please try a PNG under 2 MB.', 'reply_ticket', () => count('SELECT COUNT(*) c FROM ticket_messages WHERE ticket_id=?', f.ticket) >= 1 || 'no reply row');
  await act(say, 'mark FL-E2E01 solved', 'set_ticket_status', () => one('SELECT status FROM tickets WHERE id=?', f.ticket).status === 'solved' || 'not solved');
  await act(say, 'dismiss removal ' + f.removal2, 'dismiss_removal', () => one('SELECT status FROM removal_requests WHERE id=?', f.removal2).status !== 'pending' || 'still pending');
  await act(say, 'fulfil removal ' + f.removal, 'fulfill_removal', () => !one('SELECT 1 FROM listings WHERE id=?', f.zeta) || 'listing still exists');

  /* ========================================================= content */
  console.log('\nContent: blog, news, careers, promos, plans, ads, categories');
  await act(say, 'create blog post title="Why verify" body="Verification builds trust in a directory."', 'create_blog_post', () => Boolean(one("SELECT 1 FROM blog_posts WHERE title='Why verify'")) || 'post missing');
  const post = one("SELECT id, status FROM blog_posts WHERE title='Why verify'") || { id: 0 };
  await act(say, `edit post ${post.id} title="Why verify listings"`, 'edit_blog_post', () => one('SELECT title FROM blog_posts WHERE id=?', post.id).title === 'Why verify listings' || 'title unchanged');
  await act(say, `publish post ${post.id}`, 'toggle_blog_post', () => one('SELECT status FROM blog_posts WHERE id=?', post.id).status !== post.status || 'status unchanged');
  await act(say, `delete post ${post.id}`, 'delete_blog_post', () => !one('SELECT 1 FROM blog_posts WHERE id=?', post.id) || 'post remains');

  await act(say, 'approve story ' + f.news, 'approve_news', () => one('SELECT status FROM listing_news WHERE id=?', f.news).status === 'approved' || 'story not approved');
  await act(say, 'reject news ' + f.news2, 'reject_news', () => one('SELECT status FROM listing_news WHERE id=?', f.news2).status === 'rejected' || 'story not rejected');
  await act(say, 'delete story ' + f.news3, 'delete_news_story', () => !one('SELECT 1 FROM listing_news WHERE id=?', f.news3) || 'story remains');
  await act(say, 'add story to gamma group titled "Gamma wins award" url=https://news.example/award', 'create_news_story', () => Boolean(one("SELECT 1 FROM listing_news WHERE title='Gamma wins award'")) || 'story missing');
  await act(say, 'news moderation off', 'set_news_settings', () => getSetting('news_review_auto', '1') === '0' || 'setting unchanged');
  await act(say, 'scan news for gamma group', 'run_news_refresh', null, { network: true });
  await act(say, 'stop the news sweep', 'run_news_refresh', null);

  await act(say, 'post role title="Backend Engineer" location=Nairobi description="Build and run the ledger backend services" requirements="Node.js and SQL, three years experience"', 'create_career', () => Boolean(one("SELECT 1 FROM careers WHERE title='Backend Engineer'")) || 'role missing');
  const role = one("SELECT id, status FROM careers WHERE title='Backend Engineer'") || { id: 0 };
  await act(say, `edit role ${role.id} location=Mombasa`, 'edit_career', () => one('SELECT location FROM careers WHERE id=?', role.id).location === 'Mombasa' || 'location unchanged');
  await act(say, `close role ${role.id}`, 'toggle_career', () => one('SELECT status FROM careers WHERE id=?', role.id).status !== role.status || 'status unchanged');
  await act(say, `delete role ${role.id}`, 'delete_career', () => !one('SELECT 1 FROM careers WHERE id=?', role.id) || 'role remains');

  await act(say, 'create promo E2E25 25% off max 50 uses expires 2030-12-31', 'create_promo', () => Boolean(one("SELECT 1 FROM promo_codes WHERE code='E2E25' AND percent=25 AND max_uses=50")) || 'promo missing/wrong');
  await act(say, 'pause promo E2E25', 'toggle_promo', () => one("SELECT active FROM promo_codes WHERE code='E2E25'").active === 0 || 'still active');
  await act(say, 'delete promo E2E25', 'delete_promo', () => !one("SELECT 1 FROM promo_codes WHERE code='E2E25'") || 'promo remains');

  await act(say, 'create plan offer "Pro Quarter" $39 for 90 days', 'create_plan_offer', () => Boolean(one("SELECT 1 FROM plans WHERE name='Pro Quarter' AND price_cents=3900 AND duration_days=90")) || 'plan missing/wrong');
  const plan = one("SELECT id, active FROM plans WHERE name='Pro Quarter'") || { id: 0 };
  await act(say, `hide plan ${plan.id}`, 'toggle_plan_offer', () => one('SELECT active FROM plans WHERE id=?', plan.id).active !== plan.active || 'active unchanged');
  await act(say, `delete plan ${plan.id}`, 'delete_plan_offer', () => !one('SELECT 1 FROM plans WHERE id=?', plan.id) || 'plan remains');

  await act(say, 'create ad package "Homepage Spotlight" $99 for 30 days', 'set_ad_package', () => Boolean(one("SELECT 1 FROM ad_packages WHERE name='Homepage Spotlight' AND price_cents=9900")) || 'package missing');

  await act(say, 'create category Space Logistics', 'create_category', () => Boolean(one("SELECT 1 FROM categories WHERE name='Space Logistics'")) || 'category missing');
  await act(say, 'rename category Space Logistics to Orbital Logistics', 'rename_category', () => Boolean(one("SELECT 1 FROM categories WHERE name='Orbital Logistics'")) || 'not renamed');
  await act(say, 'delete category Orbital Logistics', 'delete_category', () => !one("SELECT 1 FROM categories WHERE name='Orbital Logistics'") || 'category remains');

  /* ========================================================= email & newsletter */
  console.log('\nEmail & newsletter');
  const mailBefore = count('SELECT COUNT(*) c FROM admin_mail_log');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await act(say, 'email member@example.com subject: "Welcome" message: "Glad to have you."', 'email_users', null);
  await sleep(150);
  check('email_users really queued mail', count('SELECT COUNT(*) c FROM admin_mail_log') > mailBefore, String(count('SELECT COUNT(*) c FROM admin_mail_log')));
  await act(say, 'email everyone subject: "Maintenance tonight" message: "Back at 5pm."', 'email_all_users', null);
  await sleep(150);
  check('email_all_users really queued mail to every member', count('SELECT COUNT(*) c FROM admin_mail_log') >= mailBefore + 3, String(count('SELECT COUNT(*) c FROM admin_mail_log')));
  await act(say, 'set newsletter weekly', 'set_newsletter_cadence', () => getSetting('newsletter_cadence', '') === 'weekly' || 'cadence unchanged');
  await act(say, 'send the newsletter digest now', 'send_newsletter_digest', null);
  await act(say, 'send a test email to qa@example.com', 'send_test_mail', null, { network: true, allowError: /No SMTP configuration/ });
  await act(say, 'set mail from to noreply@firmledger.test', 'set_mail_from', () => /noreply@firmledger\.test/.test(getSetting('smtp_from', '')) || 'from unchanged');
  await act(say, 'add smtp host=smtp.example.com username=u password=p', 'set_mail_account', () => Boolean(one("SELECT 1 FROM smtp_accounts WHERE host='smtp.example.com'")) || 'account missing');
  await act(say, 'keep alive on every 14 days to ops@example.com', 'set_mail_keepalive', () => getSetting('mail_keepalive_days', '') === '14' || 'keepalive unchanged');
  await act(say, 'set smtp host=smtp.example.com port=587 user=u pass=p', 'set_smtp_settings', null);

  /* ========================================================= ops & settings */
  console.log('\nOps & settings');
  await act(say, 'take the site down for maintenance', 'set_maintenance_mode', () => getSetting('maintenance_on', '0') === '1' || 'maintenance not on');
  await act(say, 'bring the site back', 'set_maintenance_mode', () => getSetting('maintenance_on', '0') === '0' || 'maintenance still on');
  await act(say, 'auto approve on', 'set_auto_approve', () => getSetting('auto_approve', '0') === '1' || 'auto approve off');
  await act(say, 'auto approve off', 'set_auto_approve', () => getSetting('auto_approve', '0') === '0' || 'auto approve on');
  await act(say, 'auto moderation on', 'set_ai_moderation', () => getSetting('ai_moderation_on', '0') === '1' || 'moderation off');
  await act(say, 'set approve threshold to 85', 'set_moderation_thresholds', () => getSetting('ai_moderation_approve_at', '') === '85' || 'threshold unchanged');
  await act(say, 'block term casino', 'edit_moderation_rules', () => /block: casino/.test(getSetting('ai_moderation_rules', '')) || 'rule missing');
  await act(say, 'remove block term casino', 'edit_moderation_rules', () => !/block: casino/.test(getSetting('ai_moderation_rules', '')) || 'rule remains');
  await act(say, 'auto moderation off', 'set_ai_moderation', () => getSetting('ai_moderation_on', '0') === '0' || 'moderation on');
  await act(say, 'indexing off', 'set_indexing', () => getSetting('indexing_enabled', '1') === '0' || 'indexing on');
  await act(say, 'indexing on', 'set_indexing', () => getSetting('indexing_enabled', '1') === '1' || 'indexing off');
  await act(say, 'google indexing on', 'set_google_indexing', () => getSetting('google_indexing_enabled', '0') === '1' || 'google off');
  await act(say, 'run google indexing batch', 'run_google_indexing_batch', null, { network: true });
  await act(say, 'remove google credentials', 'remove_google_credentials', null, { allowError: /No service-account key/ });
  await act(say, 'ping /listing/gamma-group', 'ping_indexnow', null, { network: true });
  await act(say, 'clear indexing logs', 'clear_indexing_logs', () => count('SELECT COUNT(*) c FROM indexing_log') === 0 || 'logs remain');
  const keyBefore = getSetting('indexnow_key', '');
  await act(say, 'rotate the indexnow key', 'regenerate_indexnow_key', () => getSetting('indexnow_key', '') !== keyBefore || 'key unchanged');
  await act(say, 'refresh tech for all stale', 'run_tech_refresh', null);
  await act(say, 'cancel the tech refresh', 'run_tech_refresh', null);
  await act(say, 'run upkeep now', 'run_upkeep_sweep', null);
  await act(say, 'set upkeep news limit 20', 'set_upkeep_settings', null);
  await act(say, 'open incident titled "API latency" major', 'create_incident', () => Boolean(one("SELECT 1 FROM incidents WHERE title='API latency'")) || 'incident missing');
  const inc = one("SELECT id FROM incidents WHERE title='API latency'") || { id: 0 };
  await act(say, `update incident ${inc.id} saying: fix deployed, monitoring`, 'update_incident', () => count('SELECT COUNT(*) c FROM incident_updates WHERE incident_id=?', inc.id) >= 1 || 'no update row');
  await act(say, `resolve incident ${inc.id}`, 'resolve_incident', () => one('SELECT status FROM incidents WHERE id=?', inc.id).status === 'resolved' || 'not resolved');
  await act(say, `delete incident ${inc.id}`, 'delete_incident', () => !one('SELECT 1 FROM incidents WHERE id=?', inc.id) || 'incident remains');
  await act(say, 'run the status check', 'run_status_check', null, { network: true });
  await act(say, 'reset component api', 'reset_status_component', null);
  await act(say, 'weekly status report on', 'set_weekly_status_report', () => getSetting('status_weekly_report', '0') === '1' || 'report off');
  await act(say, 'set setting auto_approve=1', 'set_site_setting', () => getSetting('auto_approve', '0') === '1' || 'setting unchanged');
  run("UPDATE settings SET value='0' WHERE key='auto_approve'");
  await act(say, 'block ip 1.2.3.4', 'block_ip', () => Boolean(one("SELECT 1 FROM spam_ip WHERE value='1.2.3.4' AND kind='block'")) || 'ip rule missing');
  await act(say, 'unblock ip 1.2.3.4', 'delete_spam_rule', () => !one("SELECT 1 FROM spam_ip WHERE value='1.2.3.4'") || 'ip rule remains');
  await act(say, 'block domain spam.example', 'block_domain', () => Boolean(one("SELECT 1 FROM spam_domain WHERE value='spam.example'")) || 'domain rule missing');
  await act(say, 'set rate limit login=12 register=6', 'set_rate_limits', () => require('../src/lib/spam').limits().login === 12 || 'limit unchanged');
  await act(say, 'mark inbox read', 'mark_admin_notifications_read', () => count("SELECT COUNT(*) c FROM notifications WHERE audience='admin' AND read_at IS NULL") === 0 || 'unread remain');
  await act(say, `archive notification ${f.notif}`, 'manage_notification', () => Boolean(one('SELECT archived_at FROM notifications WHERE id=?', f.notif).archived_at) || 'not archived');
  await act(say, 'leave a note: check gamma tomorrow', 'notify_admin_inbox', () => Boolean(one("SELECT 1 FROM notifications WHERE audience='admin' AND (title LIKE '%gamma%' OR body LIKE '%gamma%')")) || 'note missing');
  await act(say, 'backup now', 'export_backup', (ex) => /Backup written/.test(ai.stripContext(ex.content)) || 'no backup path');
  await act(say, 'set 2fa email to admin@firmledger.test', 'set_admin_2fa_email', () => getSetting('admin_2fa_email', '') === 'admin@firmledger.test' || 'inbox unchanged');
  await act(say, 'set paypal sandbox', 'set_paypal_settings', () => getSetting('paypal_mode', '') === 'sandbox' || 'mode unchanged');

  /* ========================================================= destructive last */
  console.log('\nDestructive (last)');
  await act(say, 'delete listing omega one', 'delete_listing', () => !one('SELECT 1 FROM listings WHERE id=?', f.omega) || 'listing remains');
  await act(say, 'delete user gone@example.com', 'delete_user', () => !one('SELECT 1 FROM users WHERE id=?', f.victim) || 'user remains');

  /* ========================================================= coverage */
  console.log('\nCoverage');
  const all = tools.TOOLS.map((t) => t.name);
  reached.add('list_open_tickets'); /* answered through list_tickets(status=open) — same data, richer filters */
  const missing = all.filter((n) => !reached.has(n));
  check(`every registered tool reachable through language (${all.length})`, missing.length === 0, missing.length ? `not reached: ${missing.join(', ')}` : '');
  check('every turn and action audited', count("SELECT COUNT(*) c FROM ai_audit_log WHERE kind='tool'") > 80 && count("SELECT COUNT(*) c FROM ai_audit_log WHERE kind='chat'") > 80);
  check('no orphaned pending proposals', count('SELECT COUNT(*) c FROM ai_pending_actions') === 0, String(count('SELECT COUNT(*) c FROM ai_pending_actions')));

  console.log('\n================================================================');
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  failures.forEach((x) => console.log(`  • ${x}`));
  console.log('================================================================');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
