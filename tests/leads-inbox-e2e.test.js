/**
 * Leads inbox — the member → claimed-owner → chat round trip, locked in.
 * npm run test:leads-inbox
 *
 * This suite pins the exact behaviour a business relies on, over real HTTP:
 *
 *   1. A member types a message in “Contact this business” on a CLAIMED
 *      listing and submits it.
 *   2. That message really lands with the claimed owner — the lead row is
 *      owned by the listing's verified owner and the text is preserved
 *      verbatim on the shared thread.
 *   3. The claimed owner opens Dashboard → Leads, reads the message and
 *      replies from the inbox.
 *   4. The member sees the reply under Sent and answers back — both sides
 *      keep talking on the one thread.
 *   5. The whole conversation is persisted in order, and the owner's email
 *      is never exposed to the member.
 *
 * The member is created through the REAL public sign-up (register → emailed
 * OTP → verify) rather than a seeded session, so the path a real user takes
 * is what is exercised here.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-leads-inbox-'));
process.env.FIRMLEDGER_DATA_DIR = dataDir;
process.env.SMTP_URL = '';

const { db } = require('../src/db');
const bcrypt = require('bcryptjs');

/* A claimed listing with its verified owner — the state claimflow produces. */
db.prepare("INSERT INTO settings(key,value) VALUES('upkeep_on','0') ON CONFLICT(key) DO NOTHING").run();
const ownerId = db.prepare(
  "INSERT INTO users(email,password_hash,name,plan,plan_expires_at,leads_digest) VALUES(?,?,?,'pro','2099-01-01','both')"
).run('owner@inbox.example', bcrypt.hashSync('InboxOnly!2026', 10), 'Wanjiku Cleaners').lastInsertRowid;
db.prepare(
  "INSERT INTO listings(slug,name,tagline,description,category,country,city,website,status,claimed,owner_user_id,confidence) VALUES('wanjiku-cleaners','Wanjiku Cleaners','t','Verified cleaning company.','Cleaning Services','Kenya','Nairobi','https://wanjiku.example','approved',1,?,80)"
).run(ownerId);

const port = 6400 + (process.pid % 80);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['--no-warnings', 'server.js'], {
  cwd: ROOT,
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

const post = (route, form, cookie) =>
  fetch(base + route, {
    redirect: 'manual',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookie || '' },
    body: new URLSearchParams(form),
  });
const get = (route, cookie) =>
  fetch(base + route, { redirect: 'manual', headers: { cookie: cookie || '' } });
const cookiesFrom = (res) => (res.headers.getSetCookie ? res.headers.getSetCookie() : [])
  .map((c) => c.split(';')[0]).join('; ');

const MESSAGE = 'Hello, we need our 12-desk office cleaned twice a week. Could you send a quote?';
const OWNER_REPLY = 'Yes — a twice-weekly clean of a 12-desk office is KES 28,000/month. We can start Monday.';
const MEMBER_REPLY = 'Perfect, book us in for Monday at 8am. Thank you!';

(async () => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + log)), 20000);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Server exited: ' + code + log)); });
    server.stdout.on('data', (d) => {
      log += d;
      if (log.includes('FirmLedger running')) { clearTimeout(timer); resolve(); }
    });
  });
  console.log('Leads inbox — the member types a message on the listing page');

  /* --- 1. a real member signs up through the public flow --- */
  let r = await post('/register', {
    name: 'Jane Wanjiku', email: 'jane@inbox.example',
    password: 'InboxOnly!2026', password_confirm: 'InboxOnly!2026',
  });
  check('register redirects to email verification', r.status === 302 && (r.headers.get('location') || '').includes('/register/verify'));
  const otp = db.prepare('SELECT code FROM reg_otps WHERE email=? ORDER BY id DESC LIMIT 1').get('jane@inbox.example');
  check('verification code was emailed (stored)', !!otp);
  r = await post('/register/verify', { email: 'jane@inbox.example', code: otp.code });
  check('verification signs the member in', r.status === 302 && (r.headers.get('location') || '').includes('/dashboard'));
  const janeCookie = cookiesFrom(r);
  check('member session cookie issued', /fl_session=/.test(janeCookie));

  /* --- the claimed owner signs in --- */
  r = await post('/login', { email: 'owner@inbox.example', password: 'InboxOnly!2026' });
  check('claimed owner signs in', r.status === 302);
  const ownerCookie = cookiesFrom(r);
  check('owner session cookie issued', /fl_session=/.test(ownerCookie));

  /* --- 2. the member types and sends the message --- */
  const page = await (await get('/listing/wanjiku-cleaners', janeCookie)).text();
  check('contact form renders on the listing', page.includes('id="contact-business"') && page.includes('Send inquiry'));
  check('account email is locked into the form', page.includes('value="jane@inbox.example"'));
  const csrf = (page.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  check('form carries a CSRF token', !!csrf);

  r = await post('/listing/wanjiku-cleaners/leads', {
    _csrf: csrf, name: 'Jane Wanjiku', phone: '+254 700 111 222',
    subject: 'Office cleaning quote', message: MESSAGE,
  }, janeCookie);
  check('submission is accepted (lead_sent=1)', r.status === 302 && (r.headers.get('location') || '').includes('lead_sent=1'));

  const lead = db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 1').get();
  const memberId = db.prepare('SELECT id FROM users WHERE email=?').get('jane@inbox.example').id;
  check('the message really lands with the CLAIMED owner', !!lead && lead.owner_user_id === ownerId && lead.listing_id > 0);
  check('the lead records the member who sent it', lead.inquirer_user_id === memberId && lead.email === 'jane@inbox.example');
  check('the typed message is preserved verbatim', lead.message === MESSAGE);

  /* --- 3. the claimed owner reads it in the Leads inbox --- */
  const inbox = await (await get(`/dashboard/leads?open=${lead.id}`, ownerCookie)).text();
  check('owner received inbox lists the member by name', inbox.includes('Jane Wanjiku'));
  check('owner sees the typed message verbatim', inbox.includes(MESSAGE));
  check('owner sees the reply box', inbox.includes('Send message'));
  const ownerCsrf = (inbox.match(/name="_csrf" value="([^"]+)"/) || [])[1];

  /* --- 4. the owner replies; the member answers back --- */
  console.log('Leads inbox — the two sides answer each other in-thread');
  r = await post(`/dashboard/leads/${lead.id}/reply`, { _csrf: ownerCsrf, body: OWNER_REPLY }, ownerCookie);
  check('owner reply accepted', r.status === 302 && decodeURIComponent(r.headers.get('location') || '').includes('Message sent'));

  const sent = await (await get(`/dashboard/leads?box=sent&open=${lead.id}`, janeCookie)).text();
  check('member Sent box shows the owner reply verbatim', sent.includes(OWNER_REPLY));
  check('owner email never leaks to the member', !sent.includes('owner@inbox.example'));
  const janeCsrf = (sent.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  r = await post(`/dashboard/leads/${lead.id}/reply`, { _csrf: janeCsrf, body: MEMBER_REPLY }, janeCookie);
  check('member reply back accepted', r.status === 302 && decodeURIComponent(r.headers.get('location') || '').includes('Message sent'));

  const inbox2 = await (await get(`/dashboard/leads?open=${lead.id}`, ownerCookie)).text();
  check('owner sees the member follow-up verbatim', inbox2.includes(MEMBER_REPLY));

  /* --- 5. the persisted thread is the one conversation, in order --- */
  const thread = db.prepare('SELECT sender, body FROM lead_messages WHERE lead_id=? ORDER BY id').all(lead.id);
  check('thread has exactly the three messages', thread.length === 3);
  check('sender order is inquirer → owner → inquirer',
    thread.map((m) => m.sender).join(',') === 'inquirer,owner,inquirer');
  check('every body stored verbatim',
    thread[0].body === MESSAGE && thread[1].body === OWNER_REPLY && thread[2].body === MEMBER_REPLY);
  check('lead flipped new → contacted on the owner reply',
    db.prepare('SELECT status FROM leads WHERE id=?').get(lead.id).status === 'contacted');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  server.kill();
  try { require('../src/db').db.close(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
  const label = process.exitCode ? 'FAIL' : 'all checks passed';
  console.log(`\nLeads inbox: ${passed} checks ${label}`);
});
