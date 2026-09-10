/**
 * FirmLedger AI Playground — EVERY CONSOLE AREA, FOR REAL.
 *
 *   node tests/ai-areas.test.js
 *
 * Production-readiness gate for the admin assistant. Every area of the admin
 * console sidebar — Search, Inbox, Listings, News, Categories, Claims, Users,
 * Plan offers, Pricing, Advertising, Careers, Status, Promos, Protection,
 * Health, Removals, Tickets, Email, Blog, AI Playground, Settings and
 * Maintenance — is driven through the real chat pipeline in plain language:
 *
 *   chatTurn → proposal → “yes, run it” → DATABASE VERIFIED
 *
 * …never the reply text alone. Every executed step must also appear in the
 * audit log, every destructive action must still ask, and a typed “no” must
 * leave the record untouched.
 *
 * The conversational layer gets its own section: greetings that know the real
 * time of day (morning / afternoon / evening / night — with boundary checks),
 * clock questions (“what time is it”), small talk (“how are you”, “who are
 * you”), thanks — plus a guarantee that every command suggested by every
 * area menu actually parses.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-areas-'));
process.env.FIRMLEDGER_DATA_DIR = tmp;
process.env.BASE_URL = process.env.BASE_URL || 'https://firmledger.test';
process.env.SMTP_URL = '';

const { db, setSetting, getSetting } = require('../src/db');
const ai = require('../src/lib/ai');
const bot = require('../src/lib/assistant');
const tools = require('../src/lib/aitools');
const maintenance = require('../src/lib/maintenance');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const one = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- fixtures */
function seed() {
  const ops = run("INSERT INTO users (email,password_hash,name,plan) VALUES ('ops@example.com','x','Grace Ops','free')").lastInsertRowid;
  const pro = run("INSERT INTO users (email,password_hash,name,plan) VALUES ('spike@example.com','x','Sam Spike','pro')").lastInsertRowid;
  const acme = run(
    `INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,status,owner_user_id,created_at,updated_at)
     VALUES ('acme-cold-chain','Acme Cold Chain Ltd','Cold freight','Refrigerated freight between Mombasa and Kampala for horticulture exporters since 2019.','company','Logistics','https://acmecold.co.ke','hello@acmecold.co.ke','Kenya','pending',?,datetime('now'),datetime('now'))`, ops,
  ).lastInsertRowid;
  const zenith = run(
    `INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,status,owner_user_id,created_at,updated_at)
     VALUES ('zenith-digital','Zenith Digital','Studio','Zenith Digital is a product studio in Nairobi shipping web platforms for banks and insurers since 2015.','company','Technology','https://zenithdigital.co.ke','hello@zenith.co.ke','Kenya','approved',?,datetime('now'),datetime('now'))`, ops,
  ).lastInsertRowid;
  const ticket = run("INSERT INTO tickets (user_id, ref, subject, category, status) VALUES (?,?,?,?,'open')", ops, 'FL-AREA1', 'Cannot upload a logo', 'account').lastInsertRowid;
  const claim = run("INSERT INTO claims (listing_id, user_id, method, domain, token, status) VALUES (?,?,'dns',?,?,'pending')", zenith, ops, 'zenithdigital.co.ke', 'tok-areas').lastInsertRowid;
  const removal = run("INSERT INTO removal_requests (listing_id, name, email, reason, status) VALUES (?,?,?,?,'pending')", zenith, 'Zenith Legal', 'legal@zenith.co.ke', 'Company closed down.').lastInsertRowid;
  const news = run("INSERT INTO listing_news (listing_id, title, url, source, status) VALUES (?,?,?,?,'pending')", zenith, 'Zenith Digital raises seed round', 'https://news.example/zenith', 'news.example').lastInsertRowid;
  const notif = run("INSERT INTO notifications (audience, title, body) VALUES ('admin','Areas suite notice','unread on purpose')").lastInsertRowid;
  run("INSERT INTO payments (user_id, amount, currency, status, channel, reference) VALUES (?,3900,'USD','captured','paypal','AREAS-PAY-1')", pro).lastInsertRowid;
  return { ops, pro, acme, zenith, ticket, claim, removal, news, notif };
}
const F = seed();

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

/** Type a sentence, expect a proposal that includes `tool`, confirm it, and
 *  verify through `verify(execResult, proposal)` — return the exec result. */
async function act(say, text, tool, verify, opts = {}) {
  let r;
  try { r = await say(text); } catch (e) { check(`${tool} ← “${text}”`, false, `threw: ${e.message}`); return null; }
  const proposed = r.type === 'tool_proposal' ? (r.tool.steps || []).map((s) => s.name) : [];
  if (r.type !== 'tool_proposal' || !proposed.includes(tool)) {
    check(`${tool} ← “${text}”`, false, `expected a proposal for ${tool}, got ${r.type}${proposed.length ? ' ' + proposed.join('+') : ''}: ${r.text.slice(0, 140)}`);
    return null;
  }
  if (opts.argsCheck) { const bad = opts.argsCheck(r.tool.args); if (bad) { check(`${tool} ← “${text}” args`, false, `${bad} — ${JSON.stringify(r.tool.args)}`); return null; } }
  let ex;
  try { ex = await ai.executePending(r.pending_id); } catch (e) { check(`${tool} ← “${text}” execute`, false, e.message); return null; }
  if (opts.allowError) {
    check(`${tool} ← “${text}”`, ex.executed === true || opts.allowError.test(ex.error || ex.text || ''), ex.error || ai.stripContext(ex.content).slice(0, 140));
    return ex;
  }
  if (ex.executed !== true) { check(`${tool} ← “${text}” executed`, false, ex.error || ai.stripContext(ex.content).slice(0, 160)); return ex; }
  let v;
  try { v = verify ? await verify(ex, r) : null; } catch (e) { v = `verify threw: ${e.message}`; }
  check(`${tool} ← “${text}”`, v === null || v === undefined || v === true, typeof v === 'string' ? v : ai.stripContext(ex.content).slice(0, 160));
  const auditRow = one("SELECT ok FROM ai_audit_log WHERE kind='tool' AND action=? ORDER BY id DESC", tool);
  check(`${tool} audited`, Boolean(auditRow && auditRow.ok), 'no ok audit row for the action');
  return ex;
}

/** A read-only question: must answer immediately (no proposal) with `re` in the text. */
async function read(say, text, re, label) {
  let r;
  try { r = await say(text); } catch (e) { check(`${label || text} (read)`, false, `threw: ${e.message}`); return null; }
  check(`${label || text} (read)`, r.type === 'message' && re.test(r.text), `${r.type}: ${r.text.slice(0, 140)}`);
  return r;
}

(async function main() {
  console.log('FirmLedger AI Playground — every console area, for real\n');

  /* ================================================== 1. Search */
  console.log('Search');
  {
    const say = conversation();
    await read(say, 'search everywhere for zenith', /Site-wide search: “zenith”/, 'global search');
    const r = await read(say, 'search everywhere for zenith', /(Listings|Members|Tickets)/, 'search hits real areas');
    check('search finds the listing by name', r && /Zenith Digital/.test(r.text), r && r.text.slice(0, 120));
    const r2 = await read(say, 'search ops@example.com', /Members/, 'search by email');
    check('search by email finds the member', r2 && /Grace Ops/.test(r2.text), r2 && r2.text.slice(0, 120));
    check('search suggests area commands', r2 && /Commands for this area/.test(r2.text), r2 && r2.text.slice(0, 200));
  }

  /* ================================================== 2. Inbox */
  console.log('Inbox');
  {
    const say = conversation();
    await read(say, 'show inbox', /Areas suite notice/, 'inbox lists the seeded notification');
    await act(say, 'leave a note: check the backups tonight', 'notify_admin_inbox', () => {
      const row = one("SELECT id FROM notifications WHERE audience='admin' AND title LIKE '%backups%'");
      return row ? true : 'the note never landed in the inbox';
    });
    await act(say, 'archive notification ' + F.notif, 'manage_notification', () => {
      const row = one('SELECT archived_at, archive_expires_at FROM notifications WHERE id=?', F.notif);
      return row && row.archived_at && row.archive_expires_at ? true : 'notification not archived';
    }, { argsCheck: (a) => (a.action === 'archive' ? null : `action ${a.action}`) });
    await act(say, 'mark inbox read', 'mark_admin_notifications_read', () => {
      const unread = one("SELECT COUNT(*) c FROM notifications WHERE audience='admin' AND read_at=''").c;
      return unread === 0 ? true : `${unread} admin notifications still unread`;
    });
  }

  /* ================================================== 3. Listings */
  console.log('Listings');
  {
    const say = conversation();
    await read(say, 'show pending listings', /Acme Cold Chain/, 'pending queue');
    await act(say, 'approve acme cold chain', 'approve_listing', () => {
      const l = one('SELECT status FROM listings WHERE id=?', F.acme);
      return l.status === 'approved' ? true : `status ${l.status}`;
    });
    await act(say, 'feature it', 'feature_listing', () => {
      const l = one('SELECT featured FROM listings WHERE id=?', F.acme);
      return l.featured ? true : 'not featured';
    });
    await read(say, 'show acme cold chain', /featured/, 'listing detail follows context');
  }

  /* ================================================== 4. News */
  console.log('News');
  {
    const say = conversation();
    await read(say, 'show pending news', /Zenith Digital raises seed round/, 'pending news queue');
    await act(say, 'approve story ' + F.news, 'approve_news', () => {
      const s = one('SELECT status FROM listing_news WHERE id=?', F.news);
      return s.status === 'approved' ? true : `status ${s.status}`;
    });
  }

  /* ================================================== 5. Categories */
  console.log('Categories');
  {
    const say = conversation();
    await read(say, 'show categories', /categories:/, 'category list');
    await act(say, 'create category Quantum Computing', 'create_category', () => {
      const c = one("SELECT id FROM categories WHERE name='Quantum Computing'");
      if (!c) return 'category was not created';
      F.cat = c.id; return true;
    });
    await act(say, 'rename category Quantum Computing to Quantum Tech', 'rename_category', () => {
      const c = one("SELECT id FROM categories WHERE name='Quantum Tech'");
      return c && c.id === F.cat ? true : 'rename did not land';
    });
    await act(say, 'delete category Quantum Tech', 'delete_category', () => {
      const c = one("SELECT id FROM categories WHERE name='Quantum Tech'");
      return c ? 'category still exists' : true;
    });
  }

  /* ================================================== 6. Claims */
  console.log('Claims');
  {
    const say = conversation();
    await read(say, 'show pending claims', /zenithdigital\.co\.ke/, 'pending claims queue');
    await act(say, 'recheck claim ' + F.claim, 'recheck_claim', null, { allowError: /No pending claim|fetch|ENOTFOUND|ECONN|network|offline|DNS/i });
    await act(say, 'reject claim ' + F.claim, 'reject_claim', () => {
      const c = one('SELECT status FROM claims WHERE id=?', F.claim);
      return c.status === 'rejected' ? true : `status ${c.status}`;
    });
  }

  /* ================================================== 7. Users */
  console.log('Users');
  {
    const say = conversation();
    await read(say, 'show users', /Grace Ops/, 'user list');
    await read(say, 'show user ops@example.com', /Grace Ops/, 'user detail');
    await act(say, 'suspend ops@example.com', 'suspend_user', () => {
      const u = one('SELECT suspended FROM users WHERE id=?', F.ops);
      return u.suspended ? true : 'not suspended';
    });
    await act(say, 'unsuspend them', 'unsuspend_user', () => {
      const u = one('SELECT suspended FROM users WHERE id=?', F.ops);
      return u.suspended ? 'still suspended' : true;
    });
    await act(say, 'give ops@example.com pro for 30 days', 'grant_user_pro', () => {
      const u = one('SELECT plan FROM users WHERE id=?', F.ops);
      return u.plan === 'pro' ? true : `plan ${u.plan}`;
    });
    await act(say, 'revoke their pro', 'revoke_user_pro', () => {
      const u = one('SELECT plan FROM users WHERE id=?', F.ops);
      return u.plan === 'free' ? true : `plan ${u.plan}`;
    });
  }

  /* ================================================== 8. Plan offers & Pricing */
  console.log('Plan offers & Pricing');
  {
    const say = conversation();
    await read(say, 'show plans', /plan offers?/, 'plan offer list');
    await read(say, 'show pricing', /plan offers?/, 'pricing reads the same catalogue');
    await act(say, 'create plan offer "Pro Quarter" $39 for 90 days', 'create_plan_offer', (ex) => {
      const p = one("SELECT * FROM plans WHERE name='Pro Quarter'");
      if (!p) return 'offer was not created';
      if (p.price_cents !== 3900 || p.duration_days !== 90) return `price ${p.price_cents} / ${p.duration_days} days`;
      F.plan = p.id; return true;
    });
    await act(say, 'hide plan ' + F.plan, 'toggle_plan_offer', () => {
      const p = one('SELECT active FROM plans WHERE id=?', F.plan);
      return p.active === 0 ? true : 'still active';
    });
    await act(say, 'show plan ' + F.plan, 'toggle_plan_offer', () => {
      const p = one('SELECT active FROM plans WHERE id=?', F.plan);
      return p.active === 1 ? true : 'not re-activated';
    });
    await act(say, 'delete plan ' + F.plan, 'delete_plan_offer', () => {
      const p = one('SELECT id FROM plans WHERE id=?', F.plan);
      return p ? 'offer still exists' : true;
    });
    await read(say, 'show revenue', /Captured:/, 'revenue summary');
  }

  /* ================================================== 9. Advertising */
  console.log('Advertising');
  {
    const say = conversation();
    await read(say, 'show ad packages', /advert packages?/, 'ad package list');
    await read(say, 'show advertising', /advert packages?/, 'advertising synonym lists packages');
    await act(say, 'create ad package "Homepage Spotlight" $99 for 30 days', 'set_ad_package', () => {
      const p = one("SELECT * FROM ad_packages WHERE name='Homepage Spotlight'");
      if (!p) return 'package was not created';
      if (p.price_cents !== 9900 || p.duration_days !== 30) return `price ${p.price_cents} / ${p.duration_days} days`;
      F.ad = p.id; return true;
    }, { argsCheck: (a) => (a.action === 'create' ? null : `action ${a.action}`) });
    await act(say, 'hide package ' + F.ad, 'set_ad_package', () => {
      const p = one('SELECT active FROM ad_packages WHERE id=?', F.ad);
      return p.active === 0 ? true : 'still shown';
    }, { argsCheck: (a) => (a.action === 'toggle' ? null : `action ${a.action}`) });
    await act(say, 'delete package ' + F.ad, 'set_ad_package', () => {
      const p = one('SELECT id FROM ad_packages WHERE id=?', F.ad);
      return p ? 'package still exists' : true;
    }, { argsCheck: (a) => (a.action === 'delete' ? null : `action ${a.action}`) });
  }

  /* ================================================== 10. Careers */
  console.log('Careers');
  {
    const say = conversation();
    await read(say, 'show roles', /(No career roles|roles)/, 'careers list');
    await act(say, 'post a role title="Support Engineer" location=Nairobi description="Join the support team and help members every day." requirements="Node.js, SQL and patience." apply_email=jobs@example.com', 'create_career', (ex) => {
      const r = one("SELECT * FROM careers WHERE title='Support Engineer'");
      if (!r) return 'role was not posted';
      if (r.status !== 'open' || r.location !== 'Nairobi') return `status ${r.status} / ${r.location}`;
      F.role = r.id; return true;
    });
    await act(say, 'close role ' + F.role, 'toggle_career', () => {
      const r = one('SELECT status FROM careers WHERE id=?', F.role);
      return r.status === 'closed' ? true : `status ${r.status}`;
    });
    await act(say, 'reopen role ' + F.role, 'toggle_career', () => {
      const r = one('SELECT status FROM careers WHERE id=?', F.role);
      return r.status === 'open' ? true : `status ${r.status}`;
    });
    await act(say, 'delete role ' + F.role, 'delete_career', () => {
      const r = one('SELECT id FROM careers WHERE id=?', F.role);
      return r ? 'role still exists' : true;
    });
  }

  /* ================================================== 11. Status */
  console.log('Status');
  {
    const say = conversation();
    await read(say, 'status page', /(Overall|Web Application)/, 'status page summary');
    await act(say, 'open incident titled "API latency" major', 'create_incident', (ex) => {
      const i = one("SELECT * FROM incidents WHERE title='API latency'");
      if (!i) return 'incident was not created';
      if (i.severity !== 'major' || i.status !== 'investigating') return `${i.severity}/${i.status}`;
      F.incident = i.id; return true;
    });
    await act(say, 'update incident ' + F.incident + ' saying: fix deployed, monitoring', 'update_incident', () => {
      const u = one('SELECT status FROM incident_updates WHERE incident_id=? ORDER BY id DESC', F.incident);
      const i = one('SELECT status FROM incidents WHERE id=?', F.incident);
      if (!u) return 'no incident update recorded';
      return i.status === 'monitoring' ? true : `incident status ${i.status}`;
    });
    await act(say, 'resolve incident ' + F.incident, 'resolve_incident', () => {
      const i = one('SELECT status FROM incidents WHERE id=?', F.incident);
      return i.status === 'resolved' ? true : `status ${i.status}`;
    });
    await act(say, 'run the status check', 'run_status_check', (ex) => {
      const r = ex.result || {};
      return (r.components || []).length >= 4 ? true : `probe returned ${JSON.stringify(r).slice(0, 120)}`;
    });
  }

  /* ================================================== 12. Promos */
  console.log('Promos');
  {
    const say = conversation();
    await read(say, 'show promos', /(promo|No promo)/, 'promo list');
    await act(say, 'create promo AREAS20 20% off max 50 uses expires 2027-01-31', 'create_promo', () => {
      const p = one("SELECT * FROM promo_codes WHERE code='AREAS20'");
      if (!p) return 'promo was not created';
      if (p.percent !== 20 || p.max_uses !== 50 || p.expires_at !== '2027-01-31') return `${p.percent}% ${p.max_uses} ${p.expires_at}`;
      return true;
    });
    await act(say, 'pause promo AREAS20', 'toggle_promo', () => {
      const p = one("SELECT active FROM promo_codes WHERE code='AREAS20'");
      return p.active === 0 ? true : 'still active';
    }, { argsCheck: (a) => (a.on === false ? null : `on=${a.on}`) });
    await act(say, 'resume promo AREAS20', 'toggle_promo', () => {
      const p = one("SELECT active FROM promo_codes WHERE code='AREAS20'");
      return p.active === 1 ? true : 'not re-activated';
    });
    await act(say, 'delete promo AREAS20', 'delete_promo', () => {
      const p = one("SELECT id FROM promo_codes WHERE code='AREAS20'");
      return p ? 'promo still exists' : true;
    });
  }

  /* ================================================== 13. Protection */
  console.log('Protection');
  {
    const say = conversation();
    await read(say, 'show blocked ips', /IP rules/, 'ip rule list');
    await read(say, 'show spam rules', /(IP rules|Domain rules)/, 'spam rule list');
    await act(say, 'block ip 203.0.113.9', 'block_ip', () => {
      const r = one("SELECT kind FROM spam_ip WHERE value='203.0.113.9'");
      return r && r.kind === 'block' ? true : 'no block rule row';
    }, { argsCheck: (a) => (a.kind === 'block' ? null : `kind ${a.kind}`) });
    await act(say, 'allow ip 198.51.100.7', 'block_ip', () => {
      const r = one("SELECT kind FROM spam_ip WHERE value='198.51.100.7'");
      return r && r.kind === 'allow' ? true : 'no allow rule row';
    }, { argsCheck: (a) => (a.kind === 'allow' ? null : `kind ${a.kind}`) });
    await act(say, 'unblock ip 203.0.113.9', 'delete_spam_rule', () => {
      const r = one("SELECT id FROM spam_ip WHERE value='203.0.113.9'");
      return r ? 'rule still exists' : true;
    });
    await act(say, 'block domain spam.example', 'block_domain', () => {
      const r = one("SELECT kind FROM spam_domain WHERE value='spam.example'");
      return r && r.kind === 'block' ? true : 'no domain rule row';
    });
    await act(say, 'set rate limit login=7', 'set_rate_limits', () => {
      const v = getSetting('spam_rl_login', '');
      return String(v) === '7' ? true : `login limit ${v}`;
    });
    await act(say, 'set rate limit login=10', 'set_rate_limits', () => {
      const v = getSetting('spam_rl_login', '');
      return String(v) === '10' ? true : `login limit ${v}`;
    });
  }

  /* ================================================== 14. Health */
  console.log('Health');
  {
    const say = conversation();
    await read(say, 'health', /(Server|Memory|Disk)/, 'health report');
    await read(say, 'show health', /(Server|Memory|Disk)/, 'health via “show health”');
  }

  /* ================================================== 15. Removals */
  console.log('Removals');
  {
    const say = conversation();
    await read(say, 'show removal requests', /Zenith Legal/, 'removal queue');
    await act(say, 'dismiss removal ' + F.removal, 'dismiss_removal', () => {
      const r = one('SELECT status FROM removal_requests WHERE id=?', F.removal);
      return r.status === 'dismissed' ? true : `status ${r.status}`;
    });
  }

  /* ================================================== 16. Tickets */
  console.log('Tickets');
  {
    const say = conversation();
    await read(say, 'show open tickets', /FL-AREA1/, 'open ticket queue');
    await read(say, 'open ticket FL-AREA1', /Cannot upload a logo/, 'ticket detail');
    await act(say, 'reply to FL-AREA1 saying: we are on it, a fix is coming today', 'reply_ticket', () => {
      const m = one("SELECT body FROM ticket_messages WHERE ticket_id=? ORDER BY id DESC", F.ticket);
      return m && /fix is coming today/.test(m.body) ? true : 'no reply message recorded';
    });
    await act(say, 'mark FL-AREA1 solved', 'set_ticket_status', () => {
      const t = one('SELECT status FROM tickets WHERE id=?', F.ticket);
      return t.status === 'solved' ? true : `status ${t.status}`;
    });
    await act(say, 'reopen FL-AREA1', 'set_ticket_status', () => {
      const t = one('SELECT status FROM tickets WHERE id=?', F.ticket);
      return t.status === 'open' ? true : `status ${t.status}`;
    });
  }

  /* ================================================== 17. Email */
  console.log('Email');
  {
    const say = conversation();
    await read(say, 'email settings', /(From:|SMTP)/, 'email settings read');
    await act(say, 'email ops@example.com subject: "Areas check" message: "Hello from the areas suite."', 'email_users', async () => {
      await sleep(120);
      const m = one("SELECT * FROM admin_mail_log WHERE to_email='ops@example.com' AND subject='Areas check'");
      return m ? true : 'no admin_mail_log row — the mail never queued';
    });
    /* No SMTP configured in the suite environment: the test send must report
     * that honestly rather than pretend it went out. */
    await act(say, 'send a test email to ops@example.com', 'send_test_mail', null, { allowError: /SMTP/i });
  }

  /* ================================================== 18. Blog */
  console.log('Blog');
  {
    const say = conversation();
    await read(say, 'show blog posts', /blog posts/, 'blog list');
    await act(say, 'create blog post title="Areas suite post" body="A real body written by the areas suite." published', 'create_blog_post', () => {
      const p = one("SELECT * FROM blog_posts WHERE title='Areas suite post'");
      if (!p) return 'post was not created';
      if (p.status !== 'published') return `status ${p.status}`;
      F.post = p.id; return true;
    });
    await act(say, 'unpublish post ' + F.post, 'toggle_blog_post', () => {
      const p = one('SELECT status FROM blog_posts WHERE id=?', F.post);
      return p.status === 'draft' ? true : `status ${p.status}`;
    });
    await act(say, 'publish post ' + F.post, 'toggle_blog_post', () => {
      const p = one('SELECT status FROM blog_posts WHERE id=?', F.post);
      return p.status === 'published' ? true : `status ${p.status}`;
    });
    await act(say, 'delete post ' + F.post, 'delete_blog_post', () => {
      const p = one('SELECT id FROM blog_posts WHERE id=?', F.post);
      return p ? 'post still exists' : true;
    });
  }

  /* ================================================== 19. AI Playground */
  console.log('AI Playground');
  {
    const say = conversation();
    await read(say, 'assistant status', /rule engine/, 'assistant status');
    await read(say, 'show audit log', /(entries|audit)/i, 'audit log read');
    await read(say, 'moderation rules', /(Rules|rules)/, 'moderation rules read');
    await act(say, 'block term casino', 'edit_moderation_rules', () => {
      const rules = getSetting('ai_moderation_rules', ai.DEFAULT_MODERATION_RULES);
      return /block:\s*casino/i.test(rules) ? true : 'rule not saved';
    });
    await act(say, 'set approve threshold to 80', 'set_moderation_thresholds', () => {
      return getSetting('ai_moderation_approve_at', '75') === '80' ? true : `threshold ${getSetting('ai_moderation_approve_at')}`;
    });
    await act(say, 'set approve threshold to 75', 'set_moderation_thresholds', () => {
      return getSetting('ai_moderation_approve_at', '75') === '75' ? true : `threshold ${getSetting('ai_moderation_approve_at')}`;
    });
    await act(say, 'auto moderation on', 'set_ai_moderation', () => {
      return ai.isModerationOn() ? true : 'moderation still off';
    });
    await act(say, 'auto moderation off', 'set_ai_moderation', () => {
      return ai.isModerationOn() ? 'moderation still on' : true;
    });
    await read(say, 'what did I just do', /(audit|entries)/i, 'audit follow-up phrase');
  }

  /* ================================================== 20. Settings */
  console.log('Settings');
  {
    const say = conversation();
    await read(say, 'show settings', /(Site settings|auto-approve)/, 'settings snapshot');
    await act(say, 'set newsletter monthly', 'set_newsletter_cadence', () => {
      return getSetting('newsletter_cadence', 'weekly') === 'monthly' ? true : `cadence ${getSetting('newsletter_cadence')}`;
    });
    await act(say, 'set newsletter weekly', 'set_newsletter_cadence', () => {
      return getSetting('newsletter_cadence', 'weekly') === 'weekly' ? true : `cadence ${getSetting('newsletter_cadence')}`;
    });
    await act(say, 'auto approve on', 'set_auto_approve', () => {
      return getSetting('auto_approve', '0') === '1' ? true : `auto_approve ${getSetting('auto_approve')}`;
    });
    await act(say, 'auto approve off', 'set_auto_approve', () => {
      return getSetting('auto_approve', '0') === '0' ? true : `auto_approve ${getSetting('auto_approve')}`;
    });
    await act(say, 'backup now', 'export_backup', (ex) => {
      const p = ex.result && ex.result.path;
      return p && fs.existsSync(p) ? true : `no backup file at ${p}`;
    });
  }

  /* ================================================== 21. Maintenance */
  console.log('Maintenance');
  {
    const say = conversation();
    /* status questions are READS — they must never propose flipping the site */
    const st = await read(say, 'maintenance status', /Maintenance mode is \*\*off\*\*/, 'maintenance status reads');
    check('maintenance status is not a proposal', st && st.type === 'message' && !st.executed, st && st.type);
    await read(say, 'show maintenance', /Maintenance mode is \*\*off\*\*/, 'show maintenance reads');
    await read(say, 'is maintenance on', /Maintenance mode is \*\*off\*\*/, '“is maintenance on” reads');
    /* the real flip: sensitive → always confirms → typed yes executes → DB + middleware state */
    await act(say, 'maintenance on', 'set_maintenance_mode', () => {
      const on = getSetting('maintenance_on', '0') === '1' && maintenance.isOn();
      return on ? true : 'maintenance_on setting / middleware disagree';
    }, { argsCheck: (a) => (a.on === true ? null : `on=${a.on}`) });
    await read(say, 'maintenance status', /Maintenance mode is \*\*ON\*\*/, 'status reflects the real flip');
    await act(say, 'maintenance off', 'set_maintenance_mode', () => {
      const off = getSetting('maintenance_on', '1') === '0' && !maintenance.isOn();
      return off ? true : 'maintenance still on';
    }, { argsCheck: (a) => (a.on === false ? null : `on=${a.on}`) });
    /* a typed “no” cancels and leaves everything untouched */
    const say2 = conversation();
    const prop = await say2('maintenance on');
    const before = getSetting('maintenance_on', '0');
    const propTools = prop.type === 'tool_proposal' ? (prop.tool.steps || []).map((s) => s.name) : [];
    check('maintenance on proposes (sensitive)', prop.type === 'tool_proposal' && propTools.includes('set_maintenance_mode'), prop.type);
    const no = await say2('no');
    check('typed “no” cancels', no.type === 'message' && (no.cancelled === true || /cancel/i.test(no.text)), no.text.slice(0, 80));
    check('cancel left maintenance untouched', getSetting('maintenance_on', '0') === before, `was ${before}, now ${getSetting('maintenance_on', '0')}`);
  }

  /* ================================================== 22. Area menus */
  console.log('Area menus');
  {
    /* Every line the assistant suggests for a bare area name must parse to a
     * real command (plan or a clarifying question) — never an “I did not
     * catch an action” dead end. Placeholders are filled with fixture data. */
    const FILL = [
      [/<name, email or word>/g, 'acme'],
      [/<listing>/g, 'Acme Cold Chain'],
      [/<FL-…>/g, 'FL-AREA1'],
      [/<code or id>/g, 'AREAS20'],
      [/<address>/g, '198.51.100.7'],
      [/<domain>/g, 'spam.example'],
      [/<email>/g, 'ops@example.com'],
      [/<slug>/g, 'web'],
      [/<term>/g, 'acme'],
      [/url=…/g, 'url=https://news.example/x'],
      [/client_id=…/g, 'client_id=abc123'],
      [/client_secret=…/g, 'client_secret=shh456'],
      [/host=…/g, 'host=smtp.example.com'],
      [/username=…/g, 'username=smtpuser'],
      [/password=…/g, 'password=smtppass'],
      [/via <provider>/g, 'via brevo'],
      [/"…"/g, '"A perfectly cromulent headline"'],
      [/saying: …/g, 'saying: everything looks fine'],
      [/leave a note: …/g, 'leave a note: rotate the backups'],
      [/tagline="…"/g, 'tagline="Cold chain experts"'],
      [/title="…"/g, 'title="A new title"'],
      [/<id>/g, String(F.claim)],
      [/<name>/g, 'Fintech'],
    ];
    const fill = (line) => FILL.reduce((s, [re, v]) => s.replace(re, v), line).trim();
    /* “a / b” lines are alternatives. When the right side starts with its own
     * verb it is a whole command; when it is a fragment (“on / off”, “sandbox
     * / live”) it rewrites the last word of the left side. */
    const VERBS = new Set(('show count approve reject delete feature unfeature sponsor unsponsor suspend unsuspend grant revoke set rename create send email reply solved closed reopen start run refresh block allow make assign transfer unclaim markread maintenance open post draft cancel stop help reset backup ping archive restore hide unpublish verify dismiss resolve passwordreset testmail news auto keep google leave search pause resume close publish edit score review mark update leave').split(' '));
    const expand = (rawLine) => {
      const parts = rawLine.split(' / ').map((x) => x.trim()).filter(Boolean);
      const out = [];
      for (const p of parts) {
        if (!out.length || VERBS.has(p.split(' ')[0].toLowerCase())) out.push(p);
        else {
          const words = out[0].split(' ');
          words[words.length - 1] = p;
          out.push(words.join(' '));
        }
      }
      return out;
    };
    let lines = 0; let bad = [];
    const menus = ai.TOPIC_ACTIONS;
    const keys = Object.keys(menus);
    check('every console area has a menu', keys.length >= 23, `${keys.length} menus: ${keys.join(', ')}`);
    for (const key of keys) {
      for (const rawLine of menus[key].lines) {
        for (const alt of expand(rawLine)) {
          const line = fill(alt);
          if (!line) continue;
          lines++;
          const p = bot.parseCommand(line);
          if (p.type !== 'plan' && p.type !== 'ask') bad.push(`${key}: “${line}” → ${p.type}`);
        }
      }
    }
    check(`every suggested menu command parses (${lines} lines)`, bad.length === 0, bad.slice(0, 6).join(' · '));
    /* and a sample of menus actually render through the chat */
    const say = conversation();
    for (const bare of ['pricing', 'careers', 'advertising', 'promos', 'protection', 'status', 'blog', 'inbox', 'plan offers', 'ai playground', 'maintenance']) {
      const r = await say(bare);
      check(`bare “${bare}” opens its action menu`, r.type === 'message' && /Choose an action below/.test(r.text) && !/Settings & operations/.test(r.text), r.text.slice(0, 70));
    }
  }

  /* ================================================== 23. Greetings, clock & small talk */
  console.log('Greetings, clock & small talk');
  {
    const at = (h, m) => new Date(2026, 8, 10, h, m || 0); /* Thursday 10 September 2026 */
    const parts = [
      [9, 15, 'morning'], [13, 15, 'afternoon'], [18, 15, 'evening'], [23, 15, 'night'],
      [2, 40, 'night'], [5, 0, 'morning'], [11, 59, 'morning'], [12, 0, 'afternoon'],
      [16, 59, 'afternoon'], [17, 0, 'evening'], [20, 59, 'evening'], [21, 0, 'night'],
    ];
    for (const [h, m, part] of parts) {
      check(`timeOfDay ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} → ${part}`, bot.timeOfDay(at(h, m)) === part, bot.timeOfDay(at(h, m)));
    }
    const greet = async (msg, when, must, label) => {
      bot.__setTestNow(when);
      try {
        const say = conversation();
        const r = await say(msg);
        check(label, r.type === 'message' && must.every((re) => re.test(r.text)), r.text.slice(0, 120));
      } finally { bot.__setTestNow(null); }
    };
    await greet('hello', at(9, 15), [/good morning/i, /09:15/, /Thursday, 10 September 2026/], '“hello” at 09:15 greets the morning with the real clock');
    await greet('hello', at(13, 15), [/good afternoon/i, /13:15/], '“hello” at 13:15 greets the afternoon');
    await greet('hello', at(18, 15), [/good evening/i, /18:15/], '“hello” at 18:15 greets the evening');
    await greet('hello', at(23, 15), [/good night/i, /23:15/], '“hello” at 23:15 greets the night');
    await greet('good morning', at(9, 15), [/Good morning!/], '“good morning” in the morning matches');
    await greet('good afternoon', at(13, 30), [/Good afternoon!/], '“good afternoon” in the afternoon matches');
    await greet('good evening', at(18, 45), [/Good evening!/], '“good evening” in the evening matches');
    await greet('good night', at(23, 10), [/Good night!/], '“good night” at night matches');
    await greet('good morning', at(15, 0), [/though my clock says 15:00/, /afternoon/], '“good morning” at 15:00 is gently corrected to the real time');
    await greet('good evening', at(8, 0), [/though my clock says 08:00/, /morning/], '“good evening” at 08:00 is gently corrected');
    await greet('hi', at(5, 30), [/good morning/i, /05:30/], '“hi” at 05:30 knows it is morning');
    await greet('greetings', at(21, 5), [/good night/i, /21:05/], '“greetings” at 21:05 knows it is night');
    await greet('what time is it?', at(14, 7), [/14:07/, /afternoon/, /Thursday, 10 September 2026/], '“what time is it?” answers from the real clock');
    await greet('what time is it', at(3, 12), [/03:12/, /night/], 'clock question at 03:12 says night');
    await greet('what day is it?', at(10, 0), [/Thursday, 10 September 2026/], '“what day is it?” answers with the real date');
    await greet('what is the date today', at(10, 0), [/Thursday, 10 September 2026/], 'date question answers');
    {
      const say = conversation();
      const r = await say('how are you?');
      check('“how are you?” is conversation, not a search', r.type === 'message' && !/Site-wide search/.test(r.text) && /thank you/i.test(r.text), r.text.slice(0, 100));
      const r2 = await say('who are you?');
      check('“who are you?” describes the rule engine', r2.type === 'message' && /rule engine/i.test(r2.text) && /audit log/.test(r2.text), r2.text.slice(0, 100));
      const r3 = await say('are you a robot?');
      check('“are you a robot?” is answered honestly', r3.type === 'message' && /rule engine/i.test(r3.text) && !/Site-wide search/.test(r3.text), r3.text.slice(0, 100));
      const r4 = await say('are you chatgpt');
      check('“are you chatgpt” is answered honestly', r4.type === 'message' && /rule engine/i.test(r4.text) && !/Site-wide search/.test(r4.text), r4.text.slice(0, 100));
      const r5 = await say('thanks');
      check('bare “thanks” is thanked, not greeted', r5.type === 'message' && !/^Hello/.test(r5.text) && bot.SAY.thanks.includes(r5.text.trim()), r5.text.slice(0, 60));
      const r6 = await say('thank you');
      check('“thank you” works mid-conversation', r6.type === 'message' && bot.SAY.thanks.includes(r6.text.trim()), r6.text.slice(0, 60));
      /* a greeting after real work still works and keeps suggestions */
      await say('how many pending');
      const r7 = await say('good evening');
      check('greeting works after real work', r7.type === 'message' && /Good evening|good evening|clock/.test(r7.text), r7.text.slice(0, 90));
      check('greeting offers useful quick replies', (r7.quick_replies || []).some((q) => /briefing|pending|help/i.test(q)), JSON.stringify(r7.quick_replies));
    }
  }

  /* ================================================== 24. Safety invariants */
  console.log('Safety invariants');
  {
    /* Danger across areas: with the default (empty) auto-run list every
     * mutating phrase must PROPOSE, never execute. */
    const danger = [
      ['suspend spike@example.com', 'suspend_user'],
      ['delete listing zenith digital', 'delete_listing'],
      ['delete user spike@example.com', 'delete_user'],
      ['email everyone subject: "Test" message: "Hello."', 'email_all_users'],
      ['approve all pending listings', 'accept_all_pending_listings'],
      ['maintenance on', 'set_maintenance_mode'],
    ];
    for (const [text, tool] of danger) {
      const before = one('SELECT COUNT(*) c FROM ai_pending_actions').c;
      const say = conversation();
      const r = await say(text);
      const steps = r.type === 'tool_proposal' ? (r.tool.steps || []).map((s) => s.name) : [];
      check(`“${text}” proposes ${tool} (nothing runs)`, r.type === 'tool_proposal' && steps.includes(tool) && !r.executed, `${r.type}: ${r.text.slice(0, 90)}`);
      const after = one('SELECT COUNT(*) c FROM ai_pending_actions').c;
      check(`“${text}” parked its proposal`, after === before + 1, `pending ${before} → ${after}`);
      await ai.cancelPending(r.pending_id); /* tidy up */
    }
    /* auto-run: an opted-in non-sensitive write runs at once; a sensitive one
     * still asks no matter what the admin ticked. */
    tools.saveAutoTools(['feature_listing', 'delete_listing']);
    const say = conversation();
    const fr = await say('feature zenith digital');
    check('auto-run tool executes immediately', fr.executed === true, fr.text.slice(0, 90));
    const z = one('SELECT featured FROM listings WHERE id=?', F.zenith);
    check('auto-run feature really happened', z.featured === 1, 'not featured');
    const dr = await say('delete zenith digital');
    check('sensitive tool still asks despite auto-run', dr.type === 'tool_proposal' && !dr.executed, dr.text.slice(0, 90));
    const z2 = one('SELECT id FROM listings WHERE id=?', F.zenith);
    check('nothing was deleted', Boolean(z2), 'listing vanished');
    await ai.cancelPending(dr.pending_id);
    tools.saveAutoTools([]);
    /* no orphaned pending rows at the end of a clean run */
    const left = one('SELECT COUNT(*) c FROM ai_pending_actions').c;
    check('no orphaned pending proposals', left === 0, `${left} rows left`);
  }

  const bar = '='.repeat(64);
  console.log('\n' + bar);
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  console.log(bar);
  if (failures.length) { console.log('\nFailed:'); failures.forEach((f) => console.log('  ✗ ' + f)); }
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
