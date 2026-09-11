/**
 * Leads + notes + blog fit — regression audit over real HTTP.
 * npm run test:leads-fit
 *
 * Locks in the fixes, without touching existing behaviour:
 *   1. Notes: the owner form requires text client-side too, saves through the
 *      real route, shows for the owner, and never leaks to the inquirer.
 *   2. Sent honesty: a thread the business archived stays in the inquirer's
 *      Sent box AND in the Sent tab count, still readable and replyable.
 *   3. Inbox links carry no stray trailing "?" when no filter is active.
 *   4. Blog CSS keeps article rhythm (paragraph spacing, visible links,
 *      responsive headings) and a scroll guard for bare pasted tables.
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-leads-fit-'));
process.env.FIRMLEDGER_DATA_DIR = dataDir;
const { db } = require('../src/db');
const bcrypt = require('bcryptjs');

db.prepare("INSERT INTO settings(key,value) VALUES('upkeep_on','0') ON CONFLICT(key) DO NOTHING").run();
const owner = db.prepare(
  "INSERT INTO users(email,password_hash,name,plan,plan_expires_at,trial_expires_at,leads_digest) VALUES(?,?,?,'pro','2099-01-01','','both')"
).run('owner@fit.example', bcrypt.hashSync('FitOnly!2026', 10), 'Fit Owner').lastInsertRowid;
const inquirer = db.prepare(
  "INSERT INTO users(email,password_hash,name,trial_expires_at,leads_digest) VALUES(?,?,?,'','both')"
).run('buyer@fit.example', bcrypt.hashSync('FitOnly!2026', 10), 'Fit Buyer').lastInsertRowid;
const claimedId = db.prepare(
  "INSERT INTO listings(slug,name,description,category,country,city,website,status,claimed,owner_user_id) VALUES('fit-cleaners','Fit Cleaners','Verified cleaning company you can hire for offices.','Cleaning Services','Kenya','Nairobi','https://fit.example','approved',1,?)"
).run(owner).lastInsertRowid;

const { createSession } = require('../src/lib/session');
const s = {
  owner: createSession(owner, 'user'),
  inquirer: createSession(inquirer, 'user'),
};

const port = 5600 + process.pid % 300;
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

(async () => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + log)), 20000);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Server exited: ' + code + log)); });
    server.stdout.on('data', (d) => {
      log += d;
      if (log.includes('FirmLedger running')) { clearTimeout(timer); resolve(); }
    });
  });

  console.log('Leads fit — notes round trip, owner-only');
  await call('/listing/fit-cleaners/leads', 'inquirer', {
    _csrf: s.inquirer.csrf, name: 'Fit Buyer', subject: 'Quote please',
    message: 'Hello, please quote a full office clean for twelve desks in Westlands.',
  });
  const lead = db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 1').get();
  check('seed inquiry created', !!lead);

  const openHtml = await (await call(`/dashboard/leads?open=${lead.id}`, 'owner')).text();
  check('note form requires text before submit', /name="note"[^>]*required/.test(openHtml));
  check('note form caps length at 2000', /name="note"[^>]*maxlength="2000"/.test(openHtml));
  check('reply box requires a message', /name="body"[^>]*required/.test(openHtml));

  const note = await call(`/dashboard/leads/${lead.id}/note`, 'owner', { _csrf: s.owner.csrf, note: 'Prefers morning slots, M-Pesa on completion.' });
  check('note saves with confirmation', note.status === 302 && decodeURIComponent(note.headers.get('location')).includes('Note added'));
  const ownerAgain = await (await call(`/dashboard/leads?open=${lead.id}`, 'owner')).text();
  check('owner reads the private note', ownerAgain.includes('M-Pesa on completion'));
  const buyerView = await (await call(`/dashboard/leads?box=sent&open=${lead.id}`, 'inquirer')).text();
  check('inquirer never sees note text or form', !buyerView.includes('M-Pesa on completion') && !buyerView.includes('lead-note-form'));

  const empty = await call(`/dashboard/leads/${lead.id}/note`, 'owner', { _csrf: s.owner.csrf, note: '   ' });
  check('blank note rejected server-side', empty.status === 302 && decodeURIComponent(empty.headers.get('location')).includes('Write a note'));

  console.log('Leads fit — Sent stays honest after the business archives');
  await call(`/dashboard/leads/${lead.id}/archive`, 'owner', { _csrf: s.owner.csrf, archived: '1' });
  assert.equal(db.prepare('SELECT archived FROM leads WHERE id=?').get(lead.id).archived, 1);
  const leads = require('../src/lib/leads');
  check('Sent count still 1 after owner archive', leads.countsForInquirer(inquirer).total === 1);
  const sentHtml = await (await call('/dashboard/leads?box=sent', 'inquirer')).text();
  check('Sent tab badge still shows 1', />Sent <span class="lead-n">1<\/span>/.test(sentHtml));
  check('Sent list still shows the thread', sentHtml.includes('Quote please'));
  const stillOpen = await (await call(`/dashboard/leads?box=sent&open=${lead.id}`, 'inquirer')).text();
  check('archived thread still opens for the inquirer', stillOpen.includes('twelve desks'));
  const followUp = await call(`/dashboard/leads/${lead.id}/reply`, 'inquirer', { _csrf: s.inquirer.csrf, body: 'Following up — are mornings still free?' });
  check('inquirer can still reply post-archive', followUp.status === 302 && decodeURIComponent(followUp.headers.get('location')).includes('Message sent'));

  console.log('Leads fit — clean inbox links');
  check('thread Close link has no stray trailing ?', !/href="\/dashboard\/leads\?">Close/.test(ownerAgain));

  console.log('Blog fit — article CSS keeps rhythm on every screen');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  check('paragraphs get vertical rhythm', /\.blog-body p \{[^}]*margin:\s*0 0 1\.15em/.test(css));
  check('article links are visibly styled', /\.blog-body a \{[^}]*color:\s*var\(--accent2\)/.test(css));
  check('h2 scales down on narrow screens', /\.blog-body h2 \{[^}]*clamp\(/.test(css));
  check('bare pasted tables get a scroll container', /\.blog-body table:not\(\.table\) \{[^}]*overflow-x:\s*auto/.test(css));
  check('embeds scale proportionally', /\.blog-body video, \.blog-body iframe \{[^}]*height:\s*auto/.test(css));
  check('status pill never squeezes on narrow rows', /\.lead-row \.pill \{[^}]*flex:\s*0 0 auto/.test(css));
  const post = await (await call('/blog/where-to-list-your-startup-in-2026')).text();
  check('2026 guide renders inside the prose shell', post.includes('blog-prose-wrap') && post.includes('class="blog-body'));
  const index = await (await call('/blog')).text();
  check('blog index renders cards in the grid', index.includes('blog-grid') && index.includes('blog-card-link'));
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  server.kill();
  try { require('../src/db').db.close(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
  const label = process.exitCode ? 'FAIL' : 'all checks passed';
  console.log(`\nLeads + blog fit: ${passed} checks ${label}`);
});
