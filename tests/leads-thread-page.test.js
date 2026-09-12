/**
 * Leads inbox — an open conversation is a page of its own.
 * npm run test:leads-thread
 *
 * Pressing an inquiry used to open the thread in the right-hand pane while the
 * list stayed pinned on the left, so the conversation got the leftover
 * two-thirds of the screen and its contact facts ran together on one line.
 * This suite locks in the page it is now, without touching anything else:
 *
 *   1. The conversation page: no list rail beside it, the column takes the
 *      whole width centred at a readable measure, and every feature the pane
 *      had is still on it — thread, day separators, seam grip, pinned foot,
 *      composer with the server's limits, status, archive, delete, mailto/tel,
 *      Close, and the trail that names it and leads back to the list.
 *   2. The contact facts: one per line, the email first and what the member is
 *      looking for below it — never the old single wrapping strip.
 *   3. The inbox list: untouched. Its rail, its hint pane, its tabs and its
 *      row links all render exactly as before, and the two-column geometry in
 *      the stylesheet is still there for it.
 *   4. The round trips: a reply, a status change, a refused send and the
 *      email/notification deep links all land back on the conversation page —
 *      never on the list, never on a pane beside it.
 *   5. Both roles: the business sees the member's address and phone; the
 *      member sees the same page with the business email still private.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-leads-thread-'));
process.env.FIRMLEDGER_DATA_DIR = dataDir;
const { db } = require('../src/db');
const bcrypt = require('bcryptjs');

db.prepare("INSERT INTO settings(key,value) VALUES('upkeep_on','0') ON CONFLICT(key) DO NOTHING").run();
const owner = db.prepare(
  "INSERT INTO users(email,password_hash,name,plan,plan_expires_at,trial_expires_at,leads_digest) VALUES(?,?,?,'pro','2099-01-01','','both')"
).run('owner@thread.example', bcrypt.hashSync('ThreadOnly!2026', 10), 'Thread Owner').lastInsertRowid;
const inquirer = db.prepare(
  "INSERT INTO users(email,password_hash,name,trial_expires_at,leads_digest) VALUES(?,?,?,'','both')"
).run('buyer@thread.example', bcrypt.hashSync('ThreadOnly!2026', 10), 'Thread Buyer').lastInsertRowid;
db.prepare(
  "INSERT INTO listings(slug,name,description,category,country,city,website,status,claimed,owner_user_id) VALUES('thread-cleaners','Thread Cleaners','Verified cleaning company you can hire for offices.','Cleaning Services','Kenya','Nairobi','https://thread.example','approved',1,?)"
).run(owner);

const { createSession } = require('../src/lib/session');
const s = {
  owner: createSession(owner, 'user'),
  inquirer: createSession(inquirer, 'user'),
};

const port = 6700 + process.pid % 300;
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
  return fetch(base + route, {
    redirect: 'manual',
    method: form ? 'POST' : 'GET',
    headers,
    body: form ? new URLSearchParams(form) : undefined,
  });
}
const text = (res) => res.text();
const loc = (res) => decodeURIComponent(res.headers.get('location') || '');

(async () => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + log)), 20000);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Server exited: ' + code + log)); });
    server.stdout.on('data', (d) => {
      log += d;
      if (log.includes('FirmLedger running')) { clearTimeout(timer); resolve(); }
    });
  });

  /* A thread worth opening: two days, a line break, mark-up-looking text. */
  console.log('Leads thread page — seeding one inquiry with a real conversation');
  await call('/listing/thread-cleaners/leads', 'inquirer', {
    _csrf: s.inquirer.csrf, name: 'Thread Buyer', phone: '+254 700 321 321',
    subject: 'Office cleaning quote',
    message: 'Hello, please quote a full office clean for twelve desks in Westlands.',
  });
  const lead = db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 1').get();
  check('seed inquiry created', !!lead);
  db.prepare('UPDATE lead_messages SET created_at = ? WHERE lead_id = ?').run('2026-09-08 09:12:00', lead.id);
  db.prepare('INSERT INTO lead_messages (lead_id, sender, body, created_at) VALUES (?,?,?,?)')
    .run(lead.id, 'owner', 'Happy to — a twelve-desk clean is KES 24,000/month.', '2026-09-09 10:05:00');
  db.prepare('UPDATE leads SET updated_at = ? WHERE id = ?').run('2026-09-09 10:05:00', lead.id);
  const threadUrl = `/dashboard/leads?open=${lead.id}`;
  const sentUrl = `/dashboard/leads?box=sent&open=${lead.id}`;

  const ownerHtml = await text(await call(threadUrl, 'owner'));
  const buyerHtml = await text(await call(sentUrl, 'inquirer'));
  const plainHtml = await text(await call('/dashboard/leads', 'owner'));
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

  console.log('Leads thread page — the conversation takes the page, not a pane beside the list');
  check('the thread page ships no list rail and no rows',
    !ownerHtml.includes('lead-list-col') && !ownerHtml.includes('class="lead-row')
    && !ownerHtml.includes('lead-list-scroll'));
  check('and it says so in the layout it renders',
    ownerHtml.includes('class="lead-layout lead-layout-thread"')
    && ownerHtml.indexOf('lead-layout-thread') < ownerHtml.indexOf('panel lead-detail'));
  check('the column is the whole width, centred at a readable measure',
    /\.lead-layout\.lead-layout-thread \{ grid-template-columns: minmax\(0, 1fr\); gap: 0; \}/.test(css)
    && /\.lead-layout-thread \.lead-detail-col \{[^}]*max-width: min\(1040px, 100%\);[^}]*margin-inline: auto;/.test(css));
  check('the measure is scoped to an open thread, never to the list',
    !/\.lead-layout \{[^}]*max-width/.test(css)
    && /\.lead-layout \{[^}]*grid-template-columns: minmax\(220px, 300px\) minmax\(0, 1fr\);/.test(css));
  check('the pane keeps the geometry it has always had',
    /\.lead-detail \{\s*position: sticky; top: 84px;/.test(css)
    && /\.lead-detail \{[^}]*height:\s*var\(--pane-h/.test(css));

  console.log('Leads thread page — every feature came with it');
  check('the whole thread is there, in order, with its day separators',
    ownerHtml.indexOf('twelve desks in Westlands') > -1
    && ownerHtml.indexOf('twelve desks in Westlands') < ownerHtml.indexOf('KES 24,000/month')
    && (ownerHtml.match(/class="lead-day"/g) || []).length === 2
    && ownerHtml.includes('lead-bubble mine') && ownerHtml.includes('lead-bubble theirs'));
  check('the composer is there with the server limits and its pinned foot',
    ownerHtml.includes(`action="/dashboard/leads/${lead.id}/reply"`)
    && /name="body"[^>]*data-max="4000"/.test(ownerHtml)
    && (ownerHtml.match(/lead-detail-foot/g) || []).length === 1
    && ownerHtml.indexOf('id="leadThread"') < ownerHtml.indexOf('lead-detail-foot')
    && ownerHtml.indexOf('lead-detail-foot') < ownerHtml.indexOf('lead-thread-grip')
    && ownerHtml.indexOf('lead-thread-grip') < ownerHtml.indexOf('lead-reply-form'));
  check('the chat-area seam grip came with it',
    /<div class="lead-thread-grip" data-lead-thread-grip role="separator"/.test(ownerHtml)
    && ownerHtml.includes('__flLeadsPane'));
  check('status, archive and permanent delete are all still on the page',
    ownerHtml.includes(`action="/dashboard/leads/${lead.id}/status"`)
    && ownerHtml.includes(`action="/dashboard/leads/${lead.id}/archive"`)
    && ownerHtml.includes(`action="/dashboard/leads/${lead.id}/delete"`)
    && ownerHtml.includes('Delete permanently')
    && ownerHtml.indexOf('lead-reply-form') < ownerHtml.indexOf('lead-detail-bar'));
  check('the status pill still states itself where it is set',
    ownerHtml.includes('data-lead-pill-current'));
  check('the direct routes survive: email and phone, and the way back',
    ownerHtml.includes('href="mailto:buyer@thread.example"')
    && ownerHtml.includes('href="tel:+254700321321"')
    && ownerHtml.includes('Email instead') && ownerHtml.includes('>Call<')
    && ownerHtml.includes('Close ✕'));

  console.log('Leads thread page — the trail names the conversation and leads back');
  const trail = /<nav class="breadcrumbs"[^>]*>([\s\S]*?)<\/nav>/.exec(ownerHtml)[1];
  check('the trail is Dashboard › Leads inbox › the inquiry',
    trail.includes('<a href="/dashboard">Dashboard</a>')
    && trail.includes(`<a href="/dashboard/leads">Leads inbox</a>`)
    && trail.includes('<span>Thread Buyer</span>')
    && trail.indexOf('Leads inbox') < trail.indexOf('Thread Buyer'));
  const filtered = await text(await call(`/dashboard/leads?status=new&open=${lead.id}`, 'owner'));
  check('opened from a filtered list, the trail leads back to that filter',
    /<a href="\/dashboard\/leads\?status=new">Leads inbox<\/a>/.test(filtered)
    && /href="\/dashboard\/leads\?status=new">Close ✕/.test(filtered));
  check('and the trail never leaves a stray trailing ?',
    !/href="\/dashboard\/leads\?">/.test(ownerHtml));

  console.log('Leads thread page — the contact facts read one per line');
  check('the facts block stacks instead of wrapping into one line',
    /\.lead-facts \{\s*display: flex; flex-direction: column; flex-wrap: nowrap;[^}]*\}/.test(css)
    && !/\.lead-facts \{[^}]*flex-wrap: wrap/.test(css));
  const emailAt = ownerHtml.indexOf('lf-k">Email</span>');
  const phoneAt = ownerHtml.indexOf('lf-k">Phone</span>');
  const wantAt = ownerHtml.indexOf('lf-k">Looking for</span>');
  check('the email is the first line', emailAt > -1 && emailAt < phoneAt && emailAt < wantAt);
  check('what they are looking for is a line of its own below it',
    wantAt > phoneAt && phoneAt > -1
    && (ownerHtml.match(/class="lf"/g) || []).length === 3
    && /lf-k">Looking for<\/span><b class="lf-v">Office cleaning quote<\/b>/.test(ownerHtml));
  check('each line keeps its own label and link, and nothing became a table',
    /lf-k">Email<\/span><a class="lf-v" href="mailto:buyer@thread\.example">buyer@thread\.example<\/a>/.test(ownerHtml)
    && /lf-k">Phone<\/span><a class="lf-v" href="tel:\+254700321321">\+254 700 321 321<\/a>/.test(ownerHtml)
    && !/<table class="facts">/.test(ownerHtml));

  console.log('Leads thread page — the member gets the same page, the address stays private');
  check('the Sent thread is a page too, with no rail beside it',
    buyerHtml.includes('lead-layout-thread') && !buyerHtml.includes('lead-list-col'));
  check('its trail names the business',
    /<a href="\/dashboard\/leads\?box=sent">Leads inbox<\/a><span aria-hidden="true">›<\/span><span>Thread Cleaners<\/span>/.test(buyerHtml));
  check('the same thread, sides mirrored',
    buyerHtml.includes('twelve desks in Westlands') && buyerHtml.includes('KES 24,000/month')
    && (buyerHtml.match(/lead-bubble mine/g) || []).length === 1
    && (buyerHtml.match(/lead-bubble theirs/g) || []).length === 1);
  check('the member sees the subject line, and never the business email',
    /lf-k">Looking for<\/span><b class="lf-v">Office cleaning quote<\/b>/.test(buyerHtml)
    && !buyerHtml.includes('lf-k">Email</span>')
    && !buyerHtml.includes('owner@thread.example'));
  check('and keeps their own housekeeping', buyerHtml.includes('Delete conversation'));

  console.log('Leads inbox list — the page the conversation is opened from is unchanged');
  check('the list still has its rail, its rows and its hint pane',
    plainHtml.includes('lead-list-col') && plainHtml.includes('lead-list-scroll')
    && plainHtml.includes('lead-detail-empty') && !plainHtml.includes('lead-layout-thread'));
  check('a row still links to the conversation',
    plainHtml.includes(`class="lead-row is-new" href="${threadUrl}"`)
    || plainHtml.includes(`href="${threadUrl}"`));
  check('the tabs and their counts are all still there',
    />Received <span class="lead-n">1<\/span>/.test(plainHtml)
    && /class="lead-tab[^"]*" href="\/dashboard\/leads\?box=sent">Sent/.test(plainHtml)
    && />Archived <span class="lead-n">0<\/span>/.test(plainHtml)
    && />New <span class="lead-n">1<\/span>/.test(plainHtml));
  check('the list page ships no facts block of its own', !plainHtml.includes('class="lead-facts"'));

  console.log('Leads thread page — every round trip lands back on the conversation');
  const reply = await call(`/dashboard/leads/${lead.id}/reply`, 'owner', {
    _csrf: s.owner.csrf, body: 'Confirming Monday 8am — see you then.',
    ctx_box: 'received', ctx_status: 'new', ctx_listing: '', ctx_page: '1',
  });
  check('a reply redirects back to the conversation, not to the list',
    reply.status === 302 && loc(reply).includes(`open=${lead.id}`) && loc(reply).includes('Message sent'), loc(reply));
  const afterReply = await text(await call(loc(reply).replace(/&?(ok|sent)=[^&]*/g, ''), 'owner'));
  check('and the page it lands on is still a page of its own',
    afterReply.includes('Confirming Monday 8am') && afterReply.includes('lead-layout-thread')
    && !afterReply.includes('lead-list-col'));

  const status = await call(`/dashboard/leads/${lead.id}/status`, 'owner', {
    _csrf: s.owner.csrf, status: 'won', ctx_box: 'received', ctx_status: 'new', ctx_page: '1',
  });
  check('a status change returns to the same filtered conversation',
    status.status === 302 && /\?status=new&open=\d+&ok=/.test(status.headers.get('location') || ''), loc(status));
  const afterStatus = await text(await call(`/dashboard/leads?open=${lead.id}`, 'owner'));
  check('the conversation states the new status where it was set',
    afterStatus.includes('data-lead-pill-current>Won<') && afterStatus.includes('lead-layout-thread'));

  const refused = await call(`/dashboard/leads/${lead.id}/reply`, 'owner', { _csrf: s.owner.csrf, body: 'a' });
  check('a refused reply is explained on the conversation page',
    refused.status === 302 && loc(refused).includes('cerr='));
  const refusedPage = await text(await call(loc(refused).replace(/^\/dashboard\/leads/, '/dashboard/leads'), 'owner'));
  check('inside the composer of a page with no rail beside it',
    /class="lead-reply-form has-error"/.test(refusedPage)
    && /Too short to send/.test(refusedPage)
    && refusedPage.includes('lead-layout-thread') && !refusedPage.includes('lead-list-col'));

  const notif = db.prepare("SELECT url FROM notifications WHERE user_id=? AND kind='lead' ORDER BY id DESC").get(owner);
  check('the notification deep link still opens the conversation',
    !!notif && notif.url === threadUrl);
  const fromNotif = await text(await call(notif.url, 'owner'));
  check('and that link lands on the page, not on a pane',
    fromNotif.includes('lead-layout-thread') && fromNotif.includes('twelve desks in Westlands'));

  const archive = await call(`/dashboard/leads/${lead.id}/archive`, 'owner', {
    _csrf: s.owner.csrf, archived: '1', ctx_box: 'received', ctx_page: '1',
  });
  check('archiving still returns to the received list',
    archive.status === 302 && (archive.headers.get('location') || '').includes('/dashboard/leads')
    && !(archive.headers.get('location') || '').includes('open='), loc(archive));
  const archivedThread = await text(await call(threadUrl, 'owner'));
  check('the archived conversation still opens as its own page',
    archivedThread.includes('lead-layout-thread') && archivedThread.includes('Restore to inbox'));

  console.log('\n' + '='.repeat(64));
  if (process.exitCode) console.log(`Leads thread page: ${passed} passed, with failures above`);
  else console.log(`Leads thread page: ${passed} checks all checks passed`);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  server.kill();
  try { require('../src/db').db.close(); } catch (e) { /* already closed */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* tmp cleanup */ }
});
