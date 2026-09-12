/**
 * Leads — the inbox is the list of inquiries, a conversation is a page.
 * npm run test:leads-thread
 *
 * The inbox used to draw the conversation beside the list — a rail, then a
 * pane — so the thing being read got the leftover width, and the list was
 * squeezed into a column. This suite locks in what it is now, without touching
 * anything else:
 *
 *   1. The inbox page is the LIST and nothing else: every inquiry a row of its
 *      own, one below the last, edge to edge across the container — no pane,
 *      no rail, no empty hint box beside them, no thread, no composer.
 *   2. A row reads across the page: who it is and where it stands on the first
 *      line, what they asked for on the second, where it came from and when it
 *      moved on the third, and it links to the conversation's own page.
 *   3. Opening an inquiry opens that page: /dashboard/leads/<id> — the thread
 *      filling the window, the composer under it, and the whole of the
 *      conversation's housekeeping (status, archive, delete, email, call) with
 *      it. The trail names it and leads back to the list it was opened from.
 *   4. Old links still work: /dashboard/leads?open=<id> (the deep links in
 *      notifications and emails already sent) redirect to the page, carrying
 *      the view they were opened from.
 *   5. Every round trip — reply, status change, refused send, notification deep
 *      link — lands back on the conversation, never on the list. Archiving and
 *      deleting close the conversation and return to the list.
 *   6. Both roles: the business sees the member's address and phone and sets
 *      the status; the member sees the same page with the business email still
 *      private.
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
/* The page script names both columns in its selectors, so what gets asserted
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

  const threadUrl = `/dashboard/leads/${lead.id}`;
  const sentUrl = `/dashboard/leads/${lead.id}?box=sent`;
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

  const plainHtml = await text(await call('/dashboard/leads', 'owner'));
  const ownerHtml = await text(await call(threadUrl, 'owner'));
  const buyerHtml = await text(await call(sentUrl, 'inquirer'));

  console.log('Leads inbox — the list is the page, and it is inquiries only');
  check('the inbox lists the inquiry and ships no conversation beside it',
    plainHtml.includes(LIST_COL) && plainHtml.includes('lead-list-scroll')
    && plainHtml.includes('class="lead-row is-new"')
    && !plainHtml.includes(DETAIL_COL) && !plainHtml.includes('panel lead-detail')
    && !plainHtml.includes('lead-detail-empty') && !css.includes('lead-detail-empty'));
  check('no thread, no composer and no grip are drawn on the list page',
    !plainHtml.includes('id="leadThread"') && !plainHtml.includes('lead-reply-form')
    && !plainHtml.includes('data-lead-thread-grip') && !plainHtml.includes('lead-detail-foot')
    && !plainHtml.includes('lead-detail-bar') && !plainHtml.includes('class="lead-facts"'));
  check('one inquiry per row, and every row opens the conversation’s own page',
    (plainHtml.match(/class="lead-row[ "]/g) || []).length === 1
    && plainHtml.includes(`class="lead-row is-new" href="${threadUrl}"`)
    && !plainHtml.includes('?open='));
  check('a row reads across the page: who, what they asked for, where and when',
    /lead-row-title">\s*<b>Thread Buyer<\/b>/.test(plainHtml)
    && /class="lead-row-ask">Office cleaning quote</.test(plainHtml)
    && /lead-row-from">Thread Cleaners · /.test(plainHtml)
    && plainHtml.indexOf('lead-row-title') < plainHtml.indexOf('lead-row-ask')
    && plainHtml.indexOf('lead-row-ask') < plainHtml.indexOf('lead-row-from'));
  check('the status pill rides the first line beside the name',
    /lead-row-title">\s*<b>Thread Buyer<\/b>\s*<span class="pill pill-lead-new">New<\/span>/.test(plainHtml)
    && /\.lead-row-title \{ display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; \}/.test(css));
  check('and the row is a full-width grid that wraps instead of truncating',
    /\.lead-row \{\s*display: grid; grid-template-columns: minmax\(0, 1fr\) auto;/.test(css)
    && /\.lead-row-ask \{[^}]*-webkit-line-clamp: 2;/.test(css)
    && !/\.lead-row-main small \{[^}]*white-space: nowrap;/.test(css));
  check('the list stretches the container instead of sitting in a rail',
    !/\.lead-list-col \{[^}]*max-width/.test(css)
    && /\.lead-list-col \{ position: sticky; top: 84px; max-height:/.test(css)
    && /\.lead-list-col \{[^}]*max-height:\s*var\(--pane-h/.test(css));
  check('the list is cut to the window, so the page does not scroll to read it',
    /class="section-tight leads-section leads-inbox-page"/.test(plainHtml)
    && /\.leads-inbox-page \.lead-layout \{ --pane-h: min\(1060px, max\(calc\(100vh - 320px\), 520px\)\); \}/.test(css)
    && /@supports \(height: 100dvh\) \{\s*\.leads-inbox-page \.lead-layout \{ --pane-h: min\(1060px, max\(calc\(100dvh - 320px\), 520px\)\); \}/.test(css));
  check('on stacked screens the list runs the page, not a capped box',
    /@media \(max-width: 900px\) \{[\s\S]{0,400}?\.lead-list-col \{ max-height: none; \}/.test(css)
    && !css.includes('min(34vh, 300px)'));
  check('the tabs and their counts are all still there',
    />Received <span class="lead-n">1<\/span>/.test(plainHtml)
    && /class="lead-tab[^"]*" href="\/dashboard\/leads\?box=sent">Sent/.test(plainHtml)
    && />Archived <span class="lead-n">0<\/span>/.test(plainHtml)
    && />New <span class="lead-n">1<\/span>/.test(plainHtml));
  const noneHtml = await text(await call('/dashboard/leads?status=lost', 'owner'));
  check('a filter with nothing in it says so, across the full width',
    noneHtml.includes(LIST_COL) && noneHtml.includes('No lost leads')
    && noneHtml.includes('Clear filters') && !noneHtml.includes(DETAIL_COL));

  console.log('Leads thread page — the conversation is a page of its own');
  check('the page ships no list rail and no rows',
    !ownerHtml.includes(LIST_COL) && !ownerHtml.includes('class="lead-row')
    && !ownerHtml.includes('lead-list-scroll'));
  check('the conversation is the one column on it',
    ownerHtml.includes('class="lead-layout"') && ownerHtml.includes(DETAIL_COL)
    && ownerHtml.indexOf(DETAIL_COL) < ownerHtml.indexOf('panel lead-detail'));
  check('the page fits the window instead of inheriting the inbox’s tall card',
    /\.leads-thread-page \.lead-layout \{ --pane-h: min\(1060px, max\(calc\(100vh - 260px\), 520px\)\); \}/.test(css)
    && /@supports \(height: 100dvh\) \{\s*\.leads-thread-page \.lead-layout \{ --pane-h: min\(1060px, max\(calc\(100dvh - 260px\), 520px\)\); \}/.test(css));
  check('the conversation keeps a readable measure, centred in the container',
    /\.lead-detail-col \{ width: 100%; max-width: min\(1040px, 100%\); margin-inline: auto; \}/.test(css));
  check('the grid is one column now, whichever page is showing',
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
    && ownerHtml.includes('Close ✕') && ownerHtml.includes('Back to inbox'));

  console.log('Leads thread page — the trail names the conversation and leads back');
  const trail = /<nav class="breadcrumbs"[^>]*>([\s\S]*?)<\/nav>/.exec(ownerHtml)[1];
  check('the trail is Dashboard › Leads inbox › the inquiry',
    trail.includes('<a href="/dashboard">Dashboard</a>')
    && trail.includes('<a href="/dashboard/leads">Leads inbox</a>')
    && trail.includes('<span>Thread Buyer</span>')
    && trail.indexOf('Leads inbox') < trail.indexOf('Thread Buyer'));
  const filtered = await text(await call(`/dashboard/leads/${lead.id}?status=new`, 'owner'));
  check('opened from a filtered list, the trail leads back to that filter',
    /<a href="\/dashboard\/leads\?status=new">Leads inbox<\/a>/.test(filtered)
    && /href="\/dashboard\/leads\?status=new">Close ✕/.test(filtered)
    && /href="\/dashboard\/leads\?status=new"[^>]*>← Back to inbox/.test(filtered));
  check('and the trail never leaves a stray trailing ?',
    !/href="\/dashboard\/leads\?"/.test(ownerHtml));

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
  check('the Sent conversation is a page too, with no rail beside it',
    buyerHtml.includes(DETAIL_COL) && !buyerHtml.includes(LIST_COL));
  check('its trail names the business and leads back to Sent',
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

  console.log('Leads thread page — the old ?open= links still open it');
  const legacy = await call(`/dashboard/leads?open=${lead.id}`, 'owner');
  check('an old inbox link redirects to the conversation page',
    legacy.status === 302 && loc(legacy) === threadUrl, loc(legacy));
  const legacyFiltered = await call(`/dashboard/leads?status=new&open=${lead.id}&page=1`, 'owner');
  check('and carries the view it was opened from',
    legacyFiltered.status === 302 && loc(legacyFiltered) === `/dashboard/leads/${lead.id}?status=new`,
    loc(legacyFiltered));
  const legacySent = await call(`/dashboard/leads?box=sent&open=${lead.id}`, 'inquirer');
  check('a Sent deep link redirects to the same page, in its Sent context',
    legacySent.status === 302 && loc(legacySent) === sentUrl, loc(legacySent));
  const ghost = await call('/dashboard/leads?open=999999', 'owner');
  check('a link to a lead that is gone renders the list instead of bouncing',
    ghost.status === 200 && !(await text(ghost)).includes(DETAIL_COL));
  const stranger = await call(`/dashboard/leads/${lead.id}`, null);
  check('no session, no conversation', stranger.status === 302
    && /\/login/.test(stranger.headers.get('location') || ''), stranger.headers.get('location'));

  console.log('Leads thread page — every round trip lands back on the conversation');
  const reply = await call(`/dashboard/leads/${lead.id}/reply`, 'owner', {
    _csrf: s.owner.csrf, body: 'Confirming Monday 8am — see you then.',
    ctx_box: 'received', ctx_status: 'new', ctx_listing: '', ctx_page: '1',
  });
  check('a reply redirects back to the conversation page, not to the list',
    reply.status === 302 && loc(reply).startsWith(threadUrl) && loc(reply).includes('Message sent'), loc(reply));
  const afterReply = await text(await call(loc(reply).replace(/&?(ok|sent)=[^&]*/g, ''), 'owner'));
  check('and the page it lands on is still the conversation alone',
    afterReply.includes('Confirming Monday 8am') && afterReply.includes(DETAIL_COL)
    && !afterReply.includes(LIST_COL));

  const status = await call(`/dashboard/leads/${lead.id}/status`, 'owner', {
    _csrf: s.owner.csrf, status: 'won', ctx_box: 'received', ctx_status: 'new', ctx_page: '1',
  });
  check('a status change returns to the same filtered conversation',
    status.status === 302 && new RegExp(`^/dashboard/leads/${lead.id}\\?status=new&ok=`).test(loc(status)), loc(status));
  const afterStatus = await text(await call(`/dashboard/leads/${lead.id}?status=new`, 'owner'));
  check('the conversation states the new status where it was set',
    afterStatus.includes('data-lead-pill-current>Won<') && !afterStatus.includes('lead-list-col'));

  const refused = await call(`/dashboard/leads/${lead.id}/reply`, 'owner', { _csrf: s.owner.csrf, body: 'a' });
  check('a refused reply is explained on the conversation page',
    refused.status === 302 && loc(refused).includes('cerr=') && loc(refused).startsWith(threadUrl));
  const refusedPage = await text(await call(loc(refused).replace(/\/dashboard\/leads/, '/dashboard/leads'), 'owner'));
  check('inside the composer of a page with no list beside it',
    /class="lead-reply-form has-error"/.test(refusedPage)
    && /Too short to send/.test(refusedPage)
    && refusedPage.includes(DETAIL_COL) && !refusedPage.includes(LIST_COL));

  const notif = db.prepare("SELECT url FROM notifications WHERE user_id=? AND kind='lead' ORDER BY id DESC").get(owner);
  check('the notification deep link points at the conversation page',
    !!notif && notif.url === threadUrl, notif && notif.url);
  const fromNotif = await text(await call(notif.url, 'owner'));
  check('and that link opens the conversation, not a list',
    fromNotif.includes(DETAIL_COL) && fromNotif.includes('twelve desks in Westlands')
    && !fromNotif.includes(LIST_COL));

  const archive = await call(`/dashboard/leads/${lead.id}/archive`, 'owner', {
    _csrf: s.owner.csrf, archived: '1', ctx_box: 'received', ctx_page: '1',
  });
  check('archiving closes the conversation and returns to the list',
    archive.status === 302 && loc(archive).startsWith('/dashboard/leads')
    && !loc(archive).includes(`/leads/${lead.id}`), loc(archive));
  const backToList = await text(await call('/dashboard/leads?box=archived', 'owner'));
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
