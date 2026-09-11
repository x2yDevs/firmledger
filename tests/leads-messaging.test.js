/**
 * Leads messaging — the full two-user conversation, over real HTTP.
 * npm run test:leads-chat
 *
 * Everything here drives the REAL server with signed-in sessions, CSRF and
 * redirects exactly like a browser would:
 *   1. First contact from the listing page (anonymous, honeypot, validation,
 *      success) — the lead lands in the owner's inbox with the opening message.
 *   2. The owner replies in Dashboard → Leads; the inquirer gets a
 *      notification, sees the reply under Sent and answers; several rounds.
 *   3. Both rendered inboxes show the identical, ordered timeline with the
 *      right "You" side, statuses auto-flip new → contacted on the owner's
 *      first reply, and lead counts stay true.
 *   4. Guards: CSRF, strangers locked out, empty replies rejected, private
 *      notes never reach the inquirer, Pro gating for the owner's tools while
 *      the conversation itself stays open to both sides.
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-leads-chat-'));
process.env.FIRMLEDGER_DATA_DIR = dataDir;
const { db } = require('../src/db');
const bcrypt = require('bcryptjs');

/* ---------- seed: one claimed listing + three members ---------- */
db.prepare("INSERT INTO settings(key,value) VALUES('upkeep_on','0') ON CONFLICT(key) DO NOTHING").run();
const owner = db.prepare(
  "INSERT INTO users(email,password_hash,name,plan,plan_expires_at,trial_expires_at,leads_digest) VALUES(?,?,?,'pro','2099-01-01','','both')"
).run('owner@chat.example', bcrypt.hashSync('ChatOnly!2026', 10), 'Wanjiku Cleaners').lastInsertRowid;
const inquirer = db.prepare(
  "INSERT INTO users(email,password_hash,name,trial_expires_at,leads_digest) VALUES(?,?,?,'','both')"
).run('jane@chat.example', bcrypt.hashSync('ChatOnly!2026', 10), 'Jane Wanjiku').lastInsertRowid;
const stranger = db.prepare(
  "INSERT INTO users(email,password_hash,name,trial_expires_at) VALUES(?,?,?,'')"
).run('stranger@chat.example', bcrypt.hashSync('ChatOnly!2026', 10), 'Total Stranger').lastInsertRowid;
const claimedId = db.prepare(
  "INSERT INTO listings(slug,name,description,category,country,city,website,status,claimed,owner_user_id) VALUES('sunrise-cleaners','Sunrise Cleaners','Verified cleaning company you can hire for offices.','Cleaning Services','Kenya','Nairobi','https://sunrise.example','approved',1,?)"
).run(owner).lastInsertRowid;
db.prepare(
  "INSERT INTO listings(slug,name,description,category,country,status,claimed) VALUES('unclaimed-ltd','Unclaimed Ltd','Nobody has claimed this record yet.','Other','Kenya','approved',0)"
).run();

const { createSession } = require('../src/lib/session');
const s = {
  owner: createSession(owner, 'user'),
  inquirer: createSession(inquirer, 'user'),
  stranger: createSession(stranger, 'user'),
};

const port = 5100 + process.pid % 400;
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

/** GET or POST as a signed-in member (or anonymous when who is null). */
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
const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

(async () => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + log)), 20000);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Server exited: ' + code + log)); });
    server.stdout.on('data', (d) => {
      log += d;
      if (log.includes('FirmLedger running')) { clearTimeout(timer); resolve(); }
    });
  });
  console.log('Leads messaging — first contact from the listing page');

  /* --- anonymous visitors are asked to sign in, no lead is created --- */
  const anon = await call(`/listing/sunrise-cleaners/leads`, null, { name: 'Anon', email: 'anon@x.example', subject: 'Quote', message: 'Please quote me for weekly office cleaning.' });
  check('anonymous POST is sent to sign-in', anon.status === 302 && (anon.headers.get('location') || '').startsWith('/login'));
  check('anonymous POST created no lead', db.prepare('SELECT COUNT(*) c FROM leads').get().c === 0);

  /* --- honeypot silently swallows bots --- */
  const bot = await call(`/listing/sunrise-cleaners/leads`, 'inquirer', { _csrf: s.inquirer.csrf, company_site: 'http://spam.example', name: 'Bot', email: 'jane@chat.example', subject: 'Spam', message: 'Buy my thing now please.' });
  check('honeypot submission redirects without a lead', bot.status === 302 && db.prepare('SELECT COUNT(*) c FROM leads').get().c === 0);

  /* --- too-short messages are bounced back to the form --- */
  const short = await call(`/listing/sunrise-cleaners/leads`, 'inquirer', { _csrf: s.inquirer.csrf, name: 'Jane Wanjiku', subject: 'Quote', message: 'hi' });
  check('short message bounces with an error', short.status === 302 && decodeURIComponent(short.headers.get('location')).includes('at least 10 characters'));
  check('short message created no lead', db.prepare('SELECT COUNT(*) c FROM leads').get().c === 0);

  /* --- the owner cannot inquire on their own listing --- */
  const self = await call(`/listing/sunrise-cleaners/leads`, 'owner', { _csrf: s.owner.csrf, name: 'Wanjiku Cleaners', subject: 'Quote', message: 'Contacting my own listing for a test message.' });
  check('own-listing inquiry is refused', self.status === 302 && decodeURIComponent(self.headers.get('location')).includes('own listing'));

  /* --- unclaimed listings cannot receive inquiries --- */
  const unclaimed = await call(`/listing/unclaimed-ltd/leads`, 'inquirer', { _csrf: s.inquirer.csrf, name: 'Jane Wanjiku', subject: 'Quote', message: 'Is this business still operating please?' });
  check('unclaimed listing refuses inquiries', unclaimed.status === 302 && decodeURIComponent(unclaimed.headers.get('location')).includes('cannot receive inquiries'));

  /* --- THE real first contact --- */
  const ok = await call(`/listing/sunrise-cleaners/leads`, 'inquirer', {
    _csrf: s.inquirer.csrf,
    name: 'Jane Wanjiku',
    phone: '+254 700 000 001',
    subject: 'Office cleaning quote',
    message: 'Hello, we need our 12-desk office cleaned twice a week. Could you send a quote?',
  });
  check('valid inquiry redirects back with success', ok.status === 302 && (ok.headers.get('location') || '').includes('lead_sent=1'));
  const lead = db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 1').get();
  check('lead row stored with the account email', !!lead && lead.email === 'jane@chat.example' && lead.listing_id === claimedId);
  check('lead starts as New and unarchived', lead.status === 'new' && lead.archived === 0);
  const opening = db.prepare('SELECT * FROM lead_messages WHERE lead_id=? ORDER BY id').all(lead.id);
  check('opening message is seeded on the thread', opening.length === 1 && opening[0].sender === 'inquirer' && /12-desk office/.test(opening[0].body));
  const ownerNotifs = db.prepare("SELECT * FROM notifications WHERE user_id=? AND kind='lead' ORDER BY id DESC").all(owner);
  check('owner notified of the new inquiry', ownerNotifs.length === 1 && ownerNotifs[0].url === `/dashboard/leads?open=${lead.id}`);

  /* --- the listing page now shows the sent state and the Sent shortcut --- */
  const listingHtml = await (await call(`/listing/sunrise-cleaners?lead_sent=1&lead_ok=${encodeURIComponent('Your inquiry was sent to Sunrise Cleaners.')}`, 'inquirer')).text();
  check('listing page confirms the inquiry was sent', listingHtml.includes('Your inquiry was sent') && /Follow the conversation/.test(listingHtml));

  console.log('Leads messaging — owner reads and replies');
  /* --- owner inbox --- */
  const inbox = await (await call('/dashboard/leads', 'owner')).text();
  check('received inbox lists the inquirer by name', inbox.includes('Jane Wanjiku') && inbox.includes('Office cleaning quote'));
  check('inbox shows the New pill', inbox.includes('pill-lead-new'));
  const openHtml = await (await call(`/dashboard/leads?open=${lead.id}`, 'owner')).text();
  check('owner thread shows the opening message', openHtml.includes('cleaned twice a week'));
  check('owner sees the inquirer facts card', openHtml.includes('jane@chat.example') && openHtml.includes('+254 700 000 001'));
  check('owner reply box is rendered', openHtml.includes(`action="/dashboard/leads/${lead.id}/reply"`));

  /* --- CSRF is enforced --- */
  const noCsrf = await call(`/dashboard/leads/${lead.id}/reply`, 'owner', { body: 'CSRF-less message attempt' });
  check('reply without CSRF is rejected 403', noCsrf.status === 403);
  check('CSRF rejection created no message', db.prepare('SELECT COUNT(*) c FROM lead_messages WHERE lead_id=?').get(lead.id).c === 1);

  /* --- owner replies --- */
  const r1 = await call(`/dashboard/leads/${lead.id}/reply`, 'owner', { _csrf: s.owner.csrf, body: 'Hi Jane — yes we cover Westlands. Ballpark KES 28,000/month, quote attached tomorrow.' });
  check('owner reply redirects with success', r1.status === 302 && decodeURIComponent(r1.headers.get('location')).includes('Message sent'));
  let msgs = db.prepare('SELECT * FROM lead_messages WHERE lead_id=? ORDER BY id').all(lead.id);
  check('second message stored from the owner', msgs.length === 2 && msgs[1].sender === 'owner' && /28,000/.test(msgs[1].body));
  check('owner reply flips the lead to Contacted', db.prepare('SELECT status FROM leads WHERE id=?').get(lead.id).status === 'contacted');
  const janeNotif = db.prepare("SELECT * FROM notifications WHERE user_id=? AND kind='lead' ORDER BY id DESC").all(inquirer)[0];
  check('inquirer notified of the business reply', !!janeNotif && janeNotif.title.includes('Sunrise Cleaners') && janeNotif.url.includes('box=sent'));

  console.log('Leads messaging — the conversation continues, both directions');
  /* --- inquirer keeps talking from Sent --- */
  const sentHtml = await (await call(`/dashboard/leads?box=sent&open=${lead.id}`, 'inquirer')).text();
  check('sent thread shows both sides', sentHtml.includes('cleaned twice a week') && sentHtml.includes('28,000'));
  check('sent thread labels the business reply with the listing name', sentHtml.includes('lead-bubble-who">Sunrise Cleaners'));
  const r2 = await call(`/dashboard/leads/${lead.id}/reply`, 'inquirer', { _csrf: s.inquirer.csrf, body: 'That works — could you start on Monday and include window cleaning?' });
  check('inquirer reply accepted', r2.status === 302 && decodeURIComponent(r2.headers.get('location')).includes('Message sent'));
  const r3 = await call(`/dashboard/leads/${lead.id}/reply`, 'owner', { _csrf: s.owner.csrf, body: 'Monday it is, windows included. I have booked the team.' });
  check('owner second reply accepted', r3.status === 302);
  /* the alternate field name the route accepts */
  const r4 = await call(`/dashboard/leads/${lead.id}/reply`, 'inquirer', { _csrf: s.inquirer.csrf, message: 'Perfect, thank you Wanjiku Cleaners!' });
  check('reply via the message field also lands', r4.status === 302 && decodeURIComponent(r4.headers.get('location')).includes('Message sent'));

  const thread = db.prepare('SELECT sender, body FROM lead_messages WHERE lead_id=? ORDER BY id').all(lead.id);
  check('five messages in exact order', thread.length === 5
    && JSON.stringify(thread.map((m) => m.sender)) === JSON.stringify(['inquirer', 'owner', 'inquirer', 'owner', 'inquirer'])
    && thread[4].body.includes('Perfect, thank you'));

  /* --- both rendered inboxes show the same timeline, each with the right own-side --- */
  for (const [who, box, otherName] of [['owner', '', 'Jane Wanjiku'], ['inquirer', 'box=sent&', 'Sunrise Cleaners']]) {
    const html = await (await call(`/dashboard/leads?${box}open=${lead.id}`, who)).text();
    const whoLine = html.match(/lead-bubble-who">([^<]*)</g) || [];
    const mine = html.match(/lead-bubble mine/g) || [];
    check(`${who} sees all 5 messages`, whoLine.length === 5, `saw ${whoLine.length}`);
    const ownCount = who === 'owner' ? 2 : 3;
    check(`${who} sees ${ownCount} own bubbles`, mine.length === ownCount, `saw ${mine.length}`);
    check(`${who} sees the other party named on their bubbles`, whoLine.join('').includes(otherName));
    for (const fragment of ['cleaned twice a week', '28,000', 'window cleaning', 'booked the team', 'Perfect, thank you']) {
      check(`${who} sees “${fragment.slice(0, 22)}…”`, html.includes(fragment));
    }
  }

  /* --- owner's latest-reply notification --- */
  const ownerNotifs2 = db.prepare("SELECT * FROM notifications WHERE user_id=? AND kind='lead' ORDER BY id DESC").all(owner);
  check('owner notified again on the inquirer replies', ownerNotifs2.length >= 3 && ownerNotifs2[0].title.includes('Jane Wanjiku'));

  console.log('Leads messaging — guards and privacy');
  /* --- strangers are locked out --- */
  const strangerReply = await call(`/dashboard/leads/${lead.id}/reply`, 'stranger', { _csrf: s.stranger.csrf, body: 'Let me inject myself into this conversation.' });
  check('stranger reply redirected as not found', strangerReply.status === 302 && decodeURIComponent(strangerReply.headers.get('location')).includes('Conversation not found'));
  check('stranger reply created no message', db.prepare('SELECT COUNT(*) c FROM lead_messages WHERE lead_id=?').get(lead.id).c === 5);
  const strangerOpen = await (await call(`/dashboard/leads?open=${lead.id}`, 'stranger')).text();
  check('stranger sees no thread at all', !strangerOpen.includes('cleaned twice a week'));
  const strangerSent = await (await call(`/dashboard/leads?box=sent&open=${lead.id}`, 'stranger')).text();
  check('stranger sent box shows nothing of the thread', !strangerSent.includes('28,000'));

  /* --- empty replies are rejected, thread untouched --- */
  const empty = await call(`/dashboard/leads/${lead.id}/reply`, 'owner', { _csrf: s.owner.csrf, body: '   ' });
  check('empty reply bounces with an error', empty.status === 302 && decodeURIComponent(empty.headers.get('location')).includes('Write a message'));
  check('thread still has 5 messages', db.prepare('SELECT COUNT(*) c FROM lead_messages WHERE lead_id=?').get(lead.id).c === 5);

  /* --- nonexistent lead --- */
  const ghost = await call('/dashboard/leads/999999/reply', 'owner', { _csrf: s.owner.csrf, body: 'Hello ghost thread.' });
  check('replying to a missing lead says not found', ghost.status === 302 && decodeURIComponent(ghost.headers.get('location')).includes('Conversation not found'));

  /* --- private notes never reach the inquirer --- */
  const note = await call(`/dashboard/leads/${lead.id}/note`, 'owner', { _csrf: s.owner.csrf, note: 'Called Jane — prefers early mornings.' });
  check('owner note saved', note.status === 302 && db.prepare('SELECT COUNT(*) c FROM lead_notes WHERE lead_id=?').get(lead.id).c === 1);
  const ownerAgain = await (await call(`/dashboard/leads?open=${lead.id}`, 'owner')).text();
  check('owner sees the private note', ownerAgain.includes('prefers early mornings'));
  const janeAgain = await (await call(`/dashboard/leads?box=sent&open=${lead.id}`, 'inquirer')).text();
  check('inquirer never sees the private note', !janeAgain.includes('prefers early mornings') && !janeAgain.includes('lead-note-form'));

  console.log('Leads messaging — inbox management');
  /* --- status + archive via the dashboard --- */
  const st = await call(`/dashboard/leads/${lead.id}/status`, 'owner', { _csrf: s.owner.csrf, status: 'won' });
  check('status update to Won accepted', st.status === 302 && db.prepare('SELECT status FROM leads WHERE id=?').get(lead.id).status === 'won');
  const wonHtml = await (await call('/dashboard/leads?status=won', 'owner')).text();
  check('Won filter lists the lead', wonHtml.includes('Jane Wanjiku') && wonHtml.includes('pill-lead-won'));
  const arch = await call(`/dashboard/leads/${lead.id}/archive`, 'owner', { _csrf: s.owner.csrf, archived: '1' });
  check('archive accepted', arch.status === 302 && db.prepare('SELECT archived FROM leads WHERE id=?').get(lead.id).archived === 1);
  const recvAfter = await (await call('/dashboard/leads', 'owner')).text();
  check('archived lead left the received inbox', !recvAfter.includes('Office cleaning quote'));
  const archHtml = await (await call('/dashboard/leads?box=archived', 'owner')).text();
  check('archived box shows the lead', archHtml.includes('Jane Wanjiku'));
  await call(`/dashboard/leads/${lead.id}/archive`, 'owner', { _csrf: s.owner.csrf, archived: '0' });
  check('restore puts the lead back', db.prepare('SELECT archived FROM leads WHERE id=?').get(lead.id).archived === 0);

  /* --- counts stay truthful --- */
  const leads = require('../src/lib/leads');
  const c = leads.countsForOwner(owner);
  check('owner counts: 1 total, 0 new, 1 won', c.total === 1 && c.new === 0 && c.won === 1);
  check('inquirer sent count is 1', leads.countsForInquirer(inquirer).total === 1);
  check('newCount reflects the restored non-new lead', leads.newCount(owner) === 0);

  console.log('Leads messaging — Pro gating keeps the conversation open');
  /* --- downgrade the owner to Free: the thread must keep working, tools must not --- */
  db.prepare("UPDATE users SET plan='', plan_expires_at='' WHERE id=?").run(owner);
  const blockedReply = await call(`/dashboard/leads/${lead.id}/reply`, 'owner', { _csrf: s.owner.csrf, body: 'Trying to reply while on Free.' });
  check('free owner reply is gated with the upgrade notice', blockedReply.status === 302 && decodeURIComponent(blockedReply.headers.get('location')).includes('Pro feature'));
  check('gated reply created no message', db.prepare('SELECT COUNT(*) c FROM lead_messages WHERE lead_id=?').get(lead.id).c === 5);
  const freeNote = await call(`/dashboard/leads/${lead.id}/note`, 'owner', { _csrf: s.owner.csrf, note: 'Note while on Free plan.' });
  check('free owner note gated', decodeURIComponent(freeNote.headers.get('location')).includes('Pro feature'));
  const freeInq = await call(`/dashboard/leads/${lead.id}/reply`, 'inquirer', { _csrf: s.inquirer.csrf, body: 'Free-plan owners should still receive my follow-up here.' });
  check('inquirer (free) can still send messages', freeInq.status === 302 && decodeURIComponent(freeInq.headers.get('location')).includes('Message sent'));
  check('inquirer message stored', db.prepare('SELECT COUNT(*) c FROM lead_messages WHERE lead_id=?').get(lead.id).c === 6);
  db.prepare("UPDATE users SET plan='pro', plan_expires_at='2099-01-01' WHERE id=?").run(owner);
  const proAgain = await call(`/dashboard/leads/${lead.id}/reply`, 'owner', { _csrf: s.owner.csrf, body: 'Back on Pro — confirming Monday 8am start.' });
  check('Pro owner can reply again', proAgain.status === 302 && decodeURIComponent(proAgain.headers.get('location')).includes('Message sent'));

  /* --- a second conversation proves repeat leads work end to end --- */
  const lead2res = await call(`/listing/sunrise-cleaners/leads`, 'inquirer', {
    _csrf: s.inquirer.csrf, name: 'Jane Wanjiku', subject: 'Car wash bay',
    message: 'Second inquiry — do you also service car wash bays on Fridays?',
  });
  check('second inquiry accepted', lead2res.status === 302 && (lead2res.headers.get('location') || '').includes('lead_sent=1'));
  const lead2 = db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 1').get();
  check('second lead is separate and New', lead2.id !== lead.id && lead2.status === 'new');
  const inbox2 = await (await call('/dashboard/leads', 'owner')).text();
  check('received inbox shows both leads, newest first', inbox2.includes('Car wash bay') && inbox2.indexOf('Car wash bay') < inbox2.indexOf('Office cleaning quote'));
  const sent2 = await (await call('/dashboard/leads?box=sent', 'inquirer')).text();
  check('sent inbox lists both conversations', sent2.includes('Car wash bay') && sent2.includes('Office cleaning quote'));
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  server.kill();
  try { require('../src/db').db.close(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
  const label = process.exitCode ? 'FAIL' : 'all checks passed';
  console.log(`\nLeads messaging: ${passed} checks ${label}`);
});
