/**
 * Leads housekeeping — permanent delete + one-email-per-conversation.
 * node tests/leads-housekeeping.test.js
 *
 * Drives the REAL server over HTTP with signed-in sessions and verifies:
 *   1. Email policy: each side of a Leads conversation is emailed exactly once
 *      (the opening inquiry for the owner, the first reply for the inquirer);
 *      every later response is an in-app notification only.
 *   2. Permanent delete: the owner (Pro) can delete a conversation for good —
 *      lead, messages and notes disappear for both sides; free owners are
 *      gated; the inquirer can delete their own copy (the business keeps its
 *      record) and stops receiving notifications afterwards.
 *   3. The notification settings page documents the reply/email behaviour.
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-leads-hk-'));
process.env.FIRMLEDGER_DATA_DIR = dataDir;
const { db } = require('../src/db');
const bcrypt = require('bcryptjs');

/* The mailer always appends to <repo>/data/outbox.log when no SMTP is set.
   The file is shared across suites and runs, so counts are deltas from the
   baseline captured when this suite starts. */
const OUTBOX = path.join(__dirname, '..', 'data', 'outbox.log');
function outboxRaw(email) {
  try {
    return fs.readFileSync(OUTBOX, 'utf8').split('\n').filter((l) => l.includes(` TO=${email}`)).length;
  } catch { return 0; }
}
const outboxBase = {};
function outboxCount(email) {
  if (!(email in outboxBase)) outboxBase[email] = outboxRaw(email);
  return outboxRaw(email) - outboxBase[email];
}
function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (fn()) return resolve(true);
      if (Date.now() - t0 > ms) return resolve(fn());
      setTimeout(tick, 100);
    };
    tick();
  });
}

/* ---------- seed ---------- */
db.prepare("INSERT INTO settings(key,value) VALUES('upkeep_on','0') ON CONFLICT(key) DO NOTHING").run();
const owner = db.prepare(
  "INSERT INTO users(email,password_hash,name,plan,plan_expires_at,trial_expires_at,leads_digest) VALUES(?,?,?,'pro','2099-01-01','','both')"
).run('owner@hk.example', bcrypt.hashSync('HouseKeep!2026', 10), 'HK Cleaners').lastInsertRowid;
const freeOwner = db.prepare(
  "INSERT INTO users(email,password_hash,name,trial_expires_at,leads_digest) VALUES(?,?,?,'','both')"
).run('free@hk.example', bcrypt.hashSync('HouseKeep!2026', 10), 'Free Repairs').lastInsertRowid;
const inquirer = db.prepare(
  "INSERT INTO users(email,password_hash,name,trial_expires_at,leads_digest) VALUES(?,?,?,'','both')"
).run('jane@hk.example', bcrypt.hashSync('HouseKeep!2026', 10), 'Jane HK').lastInsertRowid;
const stranger = db.prepare(
  "INSERT INTO users(email,password_hash,name,trial_expires_at) VALUES(?,?,?,'')"
).run('stranger@hk.example', bcrypt.hashSync('HouseKeep!2026', 10), 'Stranger').lastInsertRowid;
db.prepare(
  "INSERT INTO listings(slug,name,description,category,country,city,website,status,claimed,owner_user_id) VALUES('hk-cleaners','HK Cleaners','A claimed cleaning business.','Cleaning Services','Kenya','Nairobi','https://hk.example','approved',1,?)"
).run(owner);
db.prepare(
  "INSERT INTO listings(slug,name,description,category,country,city,status,claimed,owner_user_id) VALUES('hk-repairs','HK Repairs','A claimed free-plan repair shop.','Repairs','Kenya','Nakuru','approved',1,?)"
).run(freeOwner);

const { createSession } = require('../src/lib/session');
const s = {
  owner: createSession(owner, 'user'),
  free: createSession(freeOwner, 'user'),
  inquirer: createSession(inquirer, 'user'),
  stranger: createSession(stranger, 'user'),
};

const port = 5200 + process.pid % 400;
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: String(port), BASE_URL: base },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stderr.on('data', (d) => { log += d; });

let passed = 0;
function check(label, ok, extra = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); return; }
  console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  process.exitCode = 1;
}

async function call(route, who = null, form = null) {
  const headers = {};
  if (who) headers.cookie = `fl_session=${s[who].token}`;
  const res = await fetch(base + route, {
    redirect: 'manual',
    method: form ? 'POST' : 'GET',
    headers,
    body: form ? new URLSearchParams(form) : undefined,
  });
  return res;
}

const notifCount = (uid) => db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND kind='lead'").get(uid).c;

(async () => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + log)), 20000);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Server exited: ' + code + log)); });
    server.stdout.on('data', (d) => {
      log += d;
      if (log.includes('FirmLedger running')) { clearTimeout(timer); resolve(); }
    });
  });

  console.log('Leads housekeeping — one email per conversation, then site notifications');

  /* Capture the shared-outbox baseline before any mail flows. */
  outboxCount('owner@hk.example');
  outboxCount('jane@hk.example');

  /* The opening inquiry is the owner's single email. */
  const created = await call('/listing/hk-cleaners/leads', 'inquirer', {
    _csrf: s.inquirer.csrf, name: 'Jane HK', subject: 'Quote',
    message: 'Hello, I would like a quote for weekly office cleaning please.',
  });
  check('inquiry accepted', created.status === 302 && (created.headers.get('location') || '').includes('lead_sent=1'));
  const lead = db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 1').get();
  check('owner email flagged at creation', lead.owner_emailed === 1 && lead.inquirer_emailed === 0);
  check('owner got exactly the first email', await waitFor(() => outboxCount('owner@hk.example') === 1));

  /* Owner's first reply is the inquirer's single email. */
  const reply1 = await call(`/dashboard/leads/${lead.id}/reply`, 'owner', { _csrf: s.owner.csrf, body: 'Thanks Jane — we can do Tuesdays. Sending a quote.' });
  check('owner reply accepted', reply1.status === 302 && decodeURIComponent(reply1.headers.get('location')).includes('Message sent'));
  check('inquirer got their one email on the first reply', await waitFor(() => outboxCount('jane@hk.example') === 1));
  check('inquirer also got a site notification', notifCount(inquirer) === 1);

  /* Later owner replies: notifications only, no more email. */
  await call(`/dashboard/leads/${lead.id}/reply`, 'owner', { _csrf: s.owner.csrf, body: 'Following up — the quote is attached in your inbox.' });
  await new Promise((r) => setTimeout(r, 500));
  check('second reply did NOT email the inquirer', outboxCount('jane@hk.example') === 1);
  check('second reply is a site notification', notifCount(inquirer) === 2);
  check('inquirer email flag set once', db.prepare('SELECT inquirer_emailed FROM leads WHERE id=?').get(lead.id).inquirer_emailed === 1);

  /* Inquirer replies back: owner already used their email at creation. */
  const back = await call(`/dashboard/leads/${lead.id}/reply`, 'inquirer', { _csrf: s.inquirer.csrf, body: 'Tuesday works, please proceed.' });
  check('inquirer reply accepted', back.status === 302);
  await new Promise((r) => setTimeout(r, 500));
  check('owner NOT emailed again (first one was the inquiry)', outboxCount('owner@hk.example') === 1);
  check('owner got the reply as a site notification', notifCount(owner) === 2);

  console.log('Leads housekeeping — permanent delete');

  /* Both sides see a permanent delete control on the open conversation. */
  const ownerView = await (await call(`/dashboard/leads/${lead.id}`, 'owner')).text();
  const inqView = await (await call(`/dashboard/leads/${lead.id}?box=sent`, 'inquirer')).text();
  check('owner sees “Delete permanently”', ownerView.includes('Delete permanently') && ownerView.includes(`/dashboard/leads/${lead.id}/delete`));
  check('inquirer sees “Delete conversation”', inqView.includes('Delete conversation') && inqView.includes(`/dashboard/leads/${lead.id}/delete`));

  /* Strangers cannot touch it. */
  const strangerDel = await call(`/dashboard/leads/${lead.id}/delete`, 'stranger', { _csrf: s.stranger.csrf });
  check('stranger delete says not found', strangerDel.status === 302 && decodeURIComponent(strangerDel.headers.get('location')).includes('not found'));
  check('stranger delete changed nothing', !!db.prepare('SELECT id FROM leads WHERE id=?').get(lead.id));

  /* Inquirer deletes their copy: gone from Sent, owner keeps the record. */
  const inqDel = await call(`/dashboard/leads/${lead.id}/delete`, 'inquirer', { _csrf: s.inquirer.csrf });
  check('inquirer delete redirects to Sent with ok', inqDel.status === 302 && (inqDel.headers.get('location') || '').includes('box=sent'));
  const afterDetach = db.prepare('SELECT * FROM leads WHERE id=?').get(lead.id);
  check('owner keeps the record after inquirer delete', !!afterDetach && afterDetach.inquirer_user_id === null);
  const sentBox = await (await call('/dashboard/leads?box=sent', 'inquirer')).text();
  check('conversation left the inquirer Sent box', !sentBox.includes('HK Cleaners'));

  /* After detach the owner's replies create no more inquirer notifications. */
  await call(`/dashboard/leads/${lead.id}/reply`, 'owner', { _csrf: s.owner.csrf, body: 'One more note after detach.' });
  await new Promise((r) => setTimeout(r, 400));
  check('detached inquirer gets no further notifications', notifCount(inquirer) === 2);
  check('detached inquirer gets no further email', outboxCount('jane@hk.example') === 1);

  /* Owner permanently deletes: the whole conversation disappears for both. */
  const ownerDel = await call(`/dashboard/leads/${lead.id}/delete`, 'owner', { _csrf: s.owner.csrf });
  check('owner permanent delete redirects with ok', ownerDel.status === 302 && decodeURIComponent(ownerDel.headers.get('location')).includes('permanently deleted'));
  check('lead row is gone', !db.prepare('SELECT id FROM leads WHERE id=?').get(lead.id));
  check('thread messages are gone', db.prepare('SELECT COUNT(*) c FROM lead_messages WHERE lead_id=?').get(lead.id).c === 0);
  const ownerBox = await (await call('/dashboard/leads', 'owner')).text();
  check('received inbox no longer lists the conversation', !ownerBox.includes('Jane HK'));

  /* Free owners are Pro-gated, exactly like the other inbox tools. */
  const freeLead = await call('/listing/hk-repairs/leads', 'inquirer', {
    _csrf: s.inquirer.csrf, name: 'Jane HK', subject: 'Fix',
    message: 'My laptop hinge is broken, can you fix it this week?',
  });
  check('free-owner inquiry accepted', freeLead.status === 302);
  const fl = db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 1').get();
  const freeDel = await call(`/dashboard/leads/${fl.id}/delete`, 'free', { _csrf: s.free.csrf });
  check('free owner delete is Pro-gated', freeDel.status === 302 && decodeURIComponent(freeDel.headers.get('location')).includes('Pro'));
  check('gated delete left the conversation intact', !!db.prepare('SELECT id FROM leads WHERE id=?').get(fl.id));

  console.log('Leads housekeeping — notification settings documents the rules');
  const settingsHtml = await (await call('/dashboard/settings', 'owner')).text();
  check('settings page renders', settingsHtml.includes('Notification settings'));
  check('settings page explains email-first-then-notifications', settingsHtml.includes('Leads conversation replies') && settingsHtml.includes('only the first message to you is emailed'));
  check('settings page mentions permanent delete in Leads', settingsHtml.includes('delete a conversation permanently'));
  check('settings page uses the shared dashboard layout', settingsHtml.includes('settings-grid') && settingsHtml.includes('page-head'));

  const statusHtml = await (await call('/status', 'owner')).text();
  check('status page renders with the shared container', statusHtml.includes('st-container'));

  console.log(`\nLeads housekeeping: ${passed} checks${process.exitCode ? ' (FAILURES)' : ' all checks passed'}`);
  server.kill();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FATAL', e, log.slice(-1500)); server.kill(); process.exit(1); });
