/**
 * Leads inbox — one column: an open conversation is a page, the list is a page.
 * npm run test:leads-thread
 *
 * The inbox used to be two columns at all times: a 220/300px list rail pinned
 * on the left and a pane beside it that held the conversation when one was
 * open, or an empty "select an inquiry" box when none was. So the thing being
 * read got the leftover two-thirds of the screen, and the list got a rail.
 * This suite locks in the single-column inbox it is now, without touching
 * anything else:
 *
 *   1. The conversation page: no list rail beside it, the column centred at a
 *      readable measure, and every feature the pane had still on it — thread,
 *      day separators, seam grip, pinned foot, composer with the server's
 *      limits, status, archive, delete, mailto/tel, Close, and the trail that
 *      names it and leads back to the list.
 *   2. The contact facts on the page they now live on: how to reach them
 *      first, and the ask on a line of its own below — never one run-on line.
 *   3. The list page: stretched across the whole container instead of a rail,
 *      with no pane and no empty hint box beside it — and its rows, pager,
 *      tabs, counts and empty state all still there.
 *   4. The round trips: a reply, a status change, a refused send, an archive
 *      and the email/notification deep links all land back on the conversation
 *      page — never on the list, never on a pane beside it.
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
/* The pane script names both columns in its selectors, so what gets asserted
   is the element the view renders, not the string somewhere on the page. */
const LIST_COL = '<div class="lead-list-col">';
const DETAIL_COL = '<div class="lead-detail-col">';

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
    !ownerHtml.includes(LIST_COL) && !ownerHtml.includes('class="lead-row')
    && !ownerHtml.includes('lead-list-scroll'));
  check('the inbox renders one column, and it is the conversation',
    ownerHtml.includes('class="lead-layout"') && ownerHtml.includes(DETAIL_COL)
    && ownerHtml.indexOf(DETAIL_COL) < ownerHtml.indexOf('panel lead-detail'));
  check('the conversation keeps a readable measure, centred in the container',
    /\.lead-detail-col \{ width: 100%; max-width: min\(1040px, 100%\); margin-inline: auto; \}/.test(css));
  check('the grid is one column now, whichever side is showing',
    /\.lead-layout \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\);\s*gap: 0;/.test(css)
    && !css.includes('minmax(220px, 300px)')
    && !/\.lead-layout \{[^}]*max-width/.test(css));
  check('the card keeps the geometry it has always had — sticky, window-tall, growing',
    /\.lead-detail \{\s*position: sticky; top: 84px;/.test(css)
    && /\.lead-detail \{[^}]*height: auto;[^}]*min-height: var\(--pane-h/.test(css));

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
    && trail.includes('<a href="/dashboard/leads">Leads inbox</a>')
    && trail.includes('<span>Thread Buyer</span>')
    && trail.indexOf('Leads inbox') < trail.indexOf('Thread Buyer'));
  const filtered = await text(await call(`/dashboard/leads?status=new&open=${lead.id}`, 'owner'));
  check('opened from a filtered list, the trail leads back to that filter',
    /<a href="\/dashboard\/leads\?status=new">Leads inbox<\/a>/.test(filtered)
    && /href="\/dashboard\/leads\?status=new">Close ✕/.test(filtered));
  check('and the trail never leaves a stray trailing ?',
    !/href="\/dashboard\/leads\?">/.test(ownerHtml));

  console.log('Leads thread page — the contact facts keep their two lines');
  const emailAt = ownerHtml.indexOf('lf-k">Email</span>');
  const phoneAt = ownerHtml.indexOf('lf-k">Phone</span>');
  const wantAt = ownerHtml.indexOf('lf-k">Looking for</span>');
  check('how to reach them is the first line: the email, then the phone',
    emailAt > -1 && emailAt < phoneAt && phoneAt < wantAt);
  check('and the ask is a line of its own below it, never the tail of the address',
    /class="lf lf-look"><span class="lf-k">Looking for/.test(ownerHtml)
    && ownerHtml.indexOf('lf lf-look') > emailAt
    && /\.lead-facts \.lf-look \{ flex: 0 0 100%; \}/.test(css)
    && /lf-k">Looking for<\/span><b class="lf-v">Office cleaning quote<\/b>/.test(ownerHtml));
  check('each line keeps its own label and link, and nothing became a table',
    /lf-k">Email<\/span><a class="lf-v" href="mailto:buyer@thread\.example">buyer@thread\.example<\/a>/.test(ownerHtml)
    && /lf-k">Phone<\/span><a class="lf-v" href="tel:\+254700321321">\+254 700 321 321<\/a>/.test(ownerHtml)
    && (ownerHtml.match(/class="lf[ "]/g) || []).length === 3
    && !/<table class="facts">/.test(ownerHtml));

  console.log('Leads thread page — the member gets the same page, the address stays private');
  check('the Sent thread is a page too, with no rail beside it',
    buyerHtml.includes(DETAIL_COL) && !buyerHtml.includes(LIST_COL));
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

  console.log('Leads inbox list — nothing open, the list is the whole page');
  check('the list keeps its frame and its rows',
    plainHtml.includes(LIST_COL) && plainHtml.includes('lead-list-scroll')
    && plainHtml.includes('class="lead-row is-new"'));
  check('and ships no pane, no rail and no empty hint box beside them',
    !plainHtml.includes(DETAIL_COL) && !plainHtml.includes('panel lead-detail')
    && !plainHtml.includes('lead-detail-empty') && !css.includes('lead-detail-empty'));
  check('it stretches the container instead of sitting in a 300px rail',
    !/\.lead-list-col \{[^}]*max-width/.test(css)
    && /\.lead-list-col \{ position: sticky; top: 84px; max-height:/.test(css)
    && /\.lead-list-col \{[^}]*max-height:\s*var\(--pane-h/.test(css));
  check('on stacked screens the list runs the page, not a capped box',
    /@media \(max-width: 900px\) \{[\s\S]{0,400}?\.lead-list-col \{ max-height: none; \}/.test(css)
    && !css.includes('min(34vh, 300px)'));
  check('a row still links to the conversation',
    plainHtml.includes(`class="lead-row is-new" href="${threadUrl}"`));
  check('the tabs and their counts are all still there',
    />Received <span class="lead-n">1<\/span>/.test(plainHtml)
    && /class="lead-tab[^"]*" href="\/dashboard\/leads\?box=sent">Sent/.test(plainHtml)
    && />Archived <span class="lead-n">0<\/span>/.test(plainHtml)
    && />New <span class="lead-n">1<\/span>/.test(plainHtml));
  check('the list page ships no facts block of its own', !plainHtml.includes('class="lead-facts"'));
  const noneHtml = await text(await call('/dashboard/leads?status=lost', 'owner'));
  check('a filter with nothing in it says so, across the full width',
    noneHtml.includes(LIST_COL) && noneHtml.includes('No lost leads')
    && noneHtml.includes('Clear filters') && !noneHtml.includes(DETAIL_COL));

  console.log('Leads thread page — every round trip lands back on the conversation');
  const reply = await call(`/dashboard/leads/${lead.id}/reply`, 'owner', {
    _csrf: s.owner.csrf, body: 'Confirming Monday 8am — see you then.',
    ctx_box: 'received', ctx_status: 'new', ctx_listing: '', ctx_page: '1',
  });
  check('a reply redirects back to the conversation, not to the list',
    reply.status === 302 && loc(reply).includes(`open=${lead.id}`) && loc(reply).includes('Message sent'), loc(reply));
  const afterReply = await text(await call(loc(reply).replace(/&?(ok|sent)=[^&]*/g, ''), 'owner'));
  check('and the page it lands on is still the conversation alone',
    afterReply.includes('Confirming Monday 8am') && afterReply.includes(DETAIL_COL)
    && !afterReply.includes(LIST_COL));

  const status = await call(`/dashboard/leads/${lead.id}/status`, 'owner', {
    _csrf: s.owner.csrf, status: 'won', ctx_box: 'received', ctx_status: 'new', ctx_page: '1',
  });
  check('a status change returns to the same filtered conversation',
    status.status === 302 && /\?status=new&open=\d+&ok=/.test(status.headers.get('location') || ''), loc(status));
  const afterStatus = await text(await call(`/dashboard/leads?open=${lead.id}`, 'owner'));
  check('the conversation states the new status where it was set',
    afterStatus.includes('data-lead-pill-current>Won<') && !afterStatus.includes('lead-list-col'));

  const refused = await call(`/dashboard/leads/${lead.id}/reply`, 'owner', { _csrf: s.owner.csrf, body: 'a' });
  check('a refused reply is explained on the conversation page',
    refused.status === 302 && loc(refused).includes('cerr='));
  const refusedPage = await text(await call(loc(refused).replace(/^\/dashboard\/leads/, '/dashboard/leads'), 'owner'));
  check('inside the composer of a page with no rail beside it',
    /class="lead-reply-form has-error"/.test(refusedPage)
    && /Too short to send/.test(refusedPage)
    && refusedPage.includes(DETAIL_COL) && !refusedPage.includes(LIST_COL));

  const notif = db.prepare("SELECT url FROM notifications WHERE user_id=? AND kind='lead' ORDER BY id DESC").get(owner);
  check('the notification deep link still opens the conversation',
    !!notif && notif.url === threadUrl);
  const fromNotif = await text(await call(notif.url, 'owner'));
  check('and that link lands on the conversation, not on a list',
    fromNotif.includes(DETAIL_COL) && fromNotif.includes('twelve desks in Westlands')
    && !fromNotif.includes(LIST_COL));

  const archive = await call(`/dashboard/leads/${lead.id}/archive`, 'owner', {
    _csrf: s.owner.csrf, archived: '1', ctx_box: 'received', ctx_page: '1',
  });
  check('archiving still returns to the received list',
    archive.status === 302 && (archive.headers.get('location') || '').includes('/dashboard/leads')
    && !(archive.headers.get('location') || '').includes('open='), loc(archive));
  const backToList = await text(await call(archive.headers.get('location').split('?')[0] + '?box=archived', 'owner'));
  check('and the archived list is the whole page too',
    backToList.includes(LIST_COL) && backToList.includes('Thread Buyer')
    && !backToList.includes(DETAIL_COL));
  const archivedThread = await text(await call(threadUrl, 'owner'));
  check('the archived conversation still opens as its own page',
    archivedThread.includes(DETAIL_COL) && archivedThread.includes('Restore to inbox'));

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
