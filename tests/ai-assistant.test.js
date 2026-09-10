/**
 * FirmLedger admin assistant suite — the rule-based bot (no model, no API).
 *
 *   node tests/ai-assistant.test.js
 *
 * Runs against a throwaway database and checks, by DB state:
 *   • understanding: synonyms, typos, slot filling (ids, emails, refs, dates,
 *     percentages, quoted payloads), multi-command sentences
 *   • memory: pronouns ("approve it", "show them"), disambiguation questions,
 *     follow-up slot filling, a fresh command abandoning an open question
 *   • safety: writes always propose first; yes/no resolves the proposal;
 *     cancel leaves the record untouched; every step is audited
 *   • auto-moderation: rule scoring approves, rejects or holds — no model
 *   • honest recovery: unknown text gets suggestions, never a silent guess
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-assistant-'));
process.env.FIRMLEDGER_DATA_DIR = tmp;
process.env.BASE_URL = process.env.BASE_URL || 'https://firmledger.test';
process.env.SMTP_URL = '';

const { db, setSetting } = require('../src/db');
const ai = require('../src/lib/ai');
const bot = require('../src/lib/assistant');

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
const bob = run("INSERT INTO users (email,password_hash,name,plan) VALUES ('bob@example.com','x','Bob Otieno','free')").lastInsertRowid;
run("INSERT INTO users (email,password_hash,name,plan) VALUES ('bob2@example.com','x','Bob Kamau','pro')");
const acme = run("INSERT INTO listings (slug,name,tagline,description,type,category,website,country,status,owner_user_id) VALUES ('acme-cold-chain','Acme Cold Chain Ltd','Cold freight','Refrigerated freight between Mombasa and Kampala for horticulture exporters since 2019.','company','Logistics','https://acmecold.co.ke','Kenya','pending',?)", bob).lastInsertRowid;
const beta = run("INSERT INTO listings (slug,name,tagline,description,type,category,website,country,status) VALUES ('beta-labs','Beta Labs','Software','Beta Labs builds accounting software for SMEs in Nairobi.','company','Technology','https://betalabs.io','Kenya','approved')").lastInsertRowid;
run("INSERT INTO listings (slug,name,tagline,description,type,category,website,country,status) VALUES ('acme-studio','Acme Studio','Design','Brand design studio.','company','Design','https://acmestudio.co.ke','Kenya','pending')");
run("INSERT INTO tickets (user_id, ref, subject, category, status) VALUES (?,?,?,?,'open')", bob, 'FL-1A2B', 'Cannot log in', 'account');

/* A tiny conversation harness mirroring what the browser does: it echoes the
   assistant's full content (with the hidden context marker) back in history. */
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
const plan = (text, ctx = {}) => { const r = bot.parseCommand(text, ctx); return r.type === 'plan' ? { plan: { tool: r.tool, args: r.args || {} }, guess: r.guess } : { plan: null, guess: r.guess, raw: r }; };

(async function main() {
  console.log('FirmLedger admin assistant suite (rule engine)\n');

  /* 1 — understanding */
  console.log('Understanding');
  let p = plan('pls aprove listing 1');
  check('typo + synonym → approve_listing', p.plan && p.plan.tool === 'approve_listing' && String(p.plan.args.id_or_slug) === '1', JSON.stringify(p.plan));
  p = plan('make beta labs featured');
  check('name lookup fills the listing id', p.plan && p.plan.tool === 'feature_listing' && String(p.plan.args.id_or_slug) === String(beta), JSON.stringify(p.plan));
  p = plan('suspend bob@example.com');
  check('email slot → suspend_user', p.plan && p.plan.tool === 'suspend_user' && p.plan.args.user === 'bob@example.com', JSON.stringify(p.plan));
  p = plan('reply to FL-1A2B saying: please reset your password from the login page');
  check('ticket ref + quoted payload', p.plan && p.plan.tool === 'reply_ticket' && /reset your password/.test(p.plan.args.message), JSON.stringify(p.plan));
  p = plan('create promo LAUNCH25 25% off max 100 uses expires 2026-12-31');
  check('promo slots (code, percent, uses, date)', p.plan && p.plan.tool === 'create_promo' && p.plan.args.code === 'LAUNCH25' && Number(p.plan.args.percent) === 25 && Number(p.plan.args.max_uses) === 100 && /2026-12-31/.test(p.plan.args.expires_at || ''), JSON.stringify(p.plan));
  p = plan('open incident titled "API latency" major');
  check('incident title + severity', p.plan && p.plan.tool === 'create_incident' && /API latency/.test(p.plan.args.title), JSON.stringify(p.plan));
  p = plan('take the site down for maintenance');
  check('idiom → set_maintenance_mode on', p.plan && p.plan.tool === 'set_maintenance_mode' && p.plan.args.on !== false, JSON.stringify(p.plan));
  p = plan('who signed up this week');
  check('recency phrase → list_users since 7 days', p.plan && p.plan.tool === 'list_users' && Number(p.plan.args.since_days) === 7, JSON.stringify(p.plan));
  p = plan('listings owned by bob@example.com');
  check('owner filter on list_listings', p.plan && p.plan.tool === 'list_listings' && ['bob@example.com', String(bob)].includes(String(p.plan.args.owner)), JSON.stringify(p.plan));
  p = plan('set approve threshold to 80');
  check('moderation threshold intent', p.plan && p.plan.tool === 'set_moderation_thresholds' && p.plan.args.approve_at === 80, JSON.stringify(p.plan));
  p = plan('block term casino');
  check('moderation rule intent', p.plan && p.plan.tool === 'edit_moderation_rules' && p.plan.args.kind === 'block' && p.plan.args.term === 'casino', JSON.stringify(p.plan));
  p = plan('score beta labs');
  check('dry-run score intent', p.plan && p.plan.tool === 'review_listing_now' && p.plan.args.dry_run === true, JSON.stringify(p.plan));
  p = plan('whitelist 8.8.8.8');
  check('whitelist → allow ip', p.plan && p.plan.tool === 'block_ip' && p.plan.args.kind === 'allow' && p.plan.args.ip === '8.8.8.8', JSON.stringify(p.plan));
  p = plan('show blocked ips');
  check('protection list intent', p.plan && p.plan.tool === 'list_protection_rules', JSON.stringify(p.plan));
  p = plan("what's pending");
  check('contraction + queue phrase', p.plan && p.plan.tool === 'get_listing_stats', JSON.stringify(p.plan));
  p = plan('listings in Technology');
  check('bare plural + category filter', p.plan && p.plan.tool === 'list_listings' && p.plan.args.category === 'Technology', JSON.stringify(p.plan));
  p = plan('what did I just do');
  check('audit log phrase', p.plan && p.plan.tool === 'get_audit_log', JSON.stringify(p.plan));
  p = plan('approve listings 1 2 3');
  check('explicit id list → bulk action', p.plan && p.plan.tool === 'bulk_listing_action' && JSON.stringify(p.plan.args.ids) === '[1,2,3]', JSON.stringify(p.plan));
  p = plan('suspnd bob@example.com');
  check('one-edit typo repaired', p.plan && p.plan.tool === 'suspend_user', JSON.stringify(p.plan));
  const parts = bot.splitCommands('approve listing 1 and then feature it');
  check('multi-command sentence splits in two', parts.length === 2, JSON.stringify(parts));
  p = plan('flibbertigibbet the wombat');
  check('nonsense is not silently executed', !p.plan || p.guess === true, JSON.stringify(p));

  /* 2 — memory & disambiguation */
  console.log('\nMemory & disambiguation');
  const say = conversation();
  let r = await say('show acme');
  check('ambiguous name → asks which one', r.type === 'message' && /Acme Cold Chain/.test(r.text) && /Acme Studio/.test(r.text), r.text.slice(0, 160));
  const idx = r.text.indexOf('Acme Cold Chain') < r.text.indexOf('Acme Studio') ? 'first' : 'second';
  r = await say(`the ${idx} one`);
  check('ordinal answer resolves the question', /Acme Cold Chain Ltd/.test(r.text) && /pending/.test(r.text), r.text.slice(0, 160));
  r = await say('approve it');
  check('"it" resolves to the listing just shown → proposal', r.type === 'tool_proposal' && r.tool.name === 'approve_listing' && String(r.tool.args.id_or_slug) === String(acme), JSON.stringify(r.tool));
  check('a write is proposed, not executed', one('SELECT status FROM listings WHERE id=?', acme).status === 'pending');
  r = await say('yes');
  check('typed "yes" runs the proposal', r.executed === true, r.text.slice(0, 160));
  check('listing is really approved', one('SELECT status FROM listings WHERE id=?', acme).status === 'approved');
  check('execution audited', Boolean(one("SELECT 1 FROM ai_audit_log WHERE action LIKE '%approve_listing'")));
  r = await say('show bob@example.com');
  check('member card renders', /Bob Otieno/.test(r.text), r.text.slice(0, 120));
  r = await say('show their listings');
  check('"their" → owner filter', /Acme Cold Chain/.test(r.text) && !/Beta Labs/.test(r.text), r.text.slice(0, 200));
  r = await say('email bob@example.com');
  check('missing subject/message → slot-fill question', r.type === 'message' && /subject|message|say/i.test(r.text), r.text.slice(0, 160));
  r = await say('how many pending');
  check('a fresh command abandons the open question', /pending/i.test(r.text) && !/subject/i.test(r.text), r.text.slice(0, 160));

  /* 3 — confirmation & cancellation */
  console.log('\nConfirmation & cancellation');
  r = await say('delete beta labs');
  check('destructive action proposes first', r.type === 'tool_proposal' && r.tool.name === 'delete_listing' && r.pending_id, JSON.stringify(r.tool));
  const cancelled = await ai.cancelPending(r.pending_id);
  check('cancel endpoint acknowledges', cancelled.cancelled === true, JSON.stringify(cancelled).slice(0, 120));
  check('nothing was deleted', Boolean(one('SELECT 1 FROM listings WHERE id=?', beta)));
  let expired = null;
  try { expired = await ai.executePending(r.pending_id); } catch (e) { expired = { executed: false, error: e.message, status: e.status }; }
  check('a cancelled proposal cannot be executed later', expired.executed !== true && expired.status === 410, JSON.stringify(expired).slice(0, 120));
  r = await say('suspend bob@example.com');
  r = await say('no');
  check('typed "no" cancels', /cancel/i.test(r.text) && one('SELECT suspended FROM users WHERE id=?', bob).suspended === 0, r.text.slice(0, 120));
  r = await say('feature beta labs');
  const ex = await ai.executePending(r.pending_id);
  check('execute endpoint runs the step', ex.executed === true && one('SELECT featured FROM listings WHERE id=?', beta).featured === 1, JSON.stringify(ex).slice(0, 160));
  check('proposal row cleared after execution', !one('SELECT 1 FROM ai_pending_actions WHERE id=?', r.pending_id));

  /* 4 — reads & help */
  console.log('\nReads & help');
  r = await say('help tickets');
  check('topic help answers', /ticket/i.test(r.text) && r.quick_replies.length > 0, r.text.slice(0, 120));
  r = await say('status page');
  check('status page summary', /operational|status|component/i.test(r.text), r.text.slice(0, 120));
  r = await say('show settings');
  check('settings snapshot', /maintenance|auto.?approve|indexing/i.test(r.text), r.text.slice(0, 120));
  r = await say('briefing');
  check('briefing template lists what needs attention', /needs you|caught up|Nothing waiting|Queue is clear/i.test(r.text), r.text.slice(0, 120));
  r = await say('health');
  check('health template renders memory/disk', /Memory|Disk/.test(r.text), r.text.slice(0, 120));
  r = await say('asdf qwerty zxcv');
  check('unknown input recovers with suggestions', r.quick_replies.length >= 2 && /not sure|did you mean|help/i.test(r.text), r.text.slice(0, 120));

  /* 5 — auto-moderation without a model */
  console.log('\nRule-based auto-moderation');
  setSetting('ai_moderation_on', '1');
  setSetting('ai_moderation_email', '0');
  const goodId = run("INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,status) VALUES ('good-co','Good Co','Quality audits','Good Co provides ISO quality audits for food processors across Nairobi and Mombasa, founded 2018 with a team of 15 auditors.','company','Consulting','https://goodco.co.ke','hello@goodco.co.ke','Kenya','pending')").lastInsertRowid;
  const spamId = run("INSERT INTO listings (slug,name,tagline,description,type,category,website,country,status) VALUES ('casino-win','Casino Win','Win big','Best online casino, free bets, click here to win now!!! http://bit.ly/x','company','Other','http://bit.ly/x','','pending')").lastInsertRowid;
  const unsureId = run("INSERT INTO listings (slug,name,tagline,description,type,category,website,country,status) VALUES ('midway-traders','Midway Traders','','Supplies office stationery and cleaning products to businesses.','company','Other','https://midway.co.ke','','pending')").lastInsertRowid;
  const good = await ai.moderateListing(goodId);
  check('good listing approved by rules', one('SELECT status FROM listings WHERE id=?', goodId).status === 'approved', JSON.stringify(good));
  check('moderation log row exists', Boolean(one("SELECT 1 FROM ai_moderation_log WHERE listing_id=? AND decision='approve'", goodId)));
  const spam = await ai.moderateListing(spamId);
  check('spam listing rejected by rules', one('SELECT status FROM listings WHERE id=?', spamId).status === 'rejected', JSON.stringify(spam));
  await ai.moderateListing(unsureId);
  check('borderline listing held for human review', one('SELECT status FROM listings WHERE id=?', unsureId).status === 'pending');
  const autoId = run("INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,status) VALUES ('auto-review','Auto Review Co','Audits','Auto Review Co runs food safety audits for processors in Nairobi, founded 2021, twelve staff, HACCP certified.','company','Consulting','https://autoreview.co.ke','ops@autoreview.co.ke','Kenya','pending')").lastInsertRowid;
  ai.scheduleModeration(autoId);
  let approved = false;
  for (let i = 0; i < 40 && !approved; i++) { await sleep(100); approved = one('SELECT status FROM listings WHERE id=?', autoId).status === 'approved'; }
  check('scheduled review runs on its own', approved);
  setSetting('ai_moderation_on', '0');

  /* 8 — newest phrases + robustness */
  console.log('\nNewest phrases & robustness');
  p = plan('turn keepalive off');
  check('mail keep-alive toggle', p.plan && p.plan.tool === 'set_mail_keepalive' && p.plan.args.on === false, JSON.stringify(p.plan));
  p = plan('set keepalive to every 7 days');
  check('mail keep-alive cadence', p.plan && p.plan.tool === 'set_mail_keepalive' && Number(p.plan.args.days) === 7, JSON.stringify(p.plan));
  p = plan('rotate the indexnow key');
  check('IndexNow key rotation', p.plan && p.plan.tool === 'regenerate_indexnow_key', JSON.stringify(p.plan));
  const parts2 = bot.splitCommands('approve it and email the owner saying: "thanks and welcome aboard"');
  check('quoted "and" never splits a payload', parts2.length === 2 && /welcome aboard/.test(parts2[1]), JSON.stringify(parts2));
  let crashed = false;
  try { await ai.chatTurn([{ role: 'user', content: "'; DROP TABLE listings; --" }]); } catch { crashed = true; }
  check('SQL-looking garbage gets a reply, not a crash', !crashed && one("SELECT COUNT(*) c FROM sqlite_master WHERE name='listings'").c === 1);

  console.log('\n================================================================');
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  failures.forEach((f) => console.log(`  • ${f}`));
  console.log('================================================================');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
