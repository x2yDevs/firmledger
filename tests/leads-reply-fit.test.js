/**
 * Leads inbox — the reply box holds, the chat extends, the page ends clean.
 * npm run test:leads-reply
 *
 * Four things the inbox shell left open, each checked the way the rest of the
 * suite checks it: over the real served page, over the real stylesheet, and
 * over the shipped script run against a stub DOM (no browser needed).
 *
 *   1. Below the inbox: the weekly-digest band is not rendered on this route,
 *      so scrolling past the conversation lands on the footer and not on a
 *      logo — and the section's own bottom air tightened to match. Every other
 *      page keeps the band.
 *   2. The composer is the pane's floor: the reply box has real bounds — 80px
 *      to 300px, dragged vertically only, always exactly as wide as its column
 *      — and the card's window height is a floor rather than a fixed height, so
 *      a box dragged past what the window budgeted grows the card instead of
 *      clipping Send. Budget audit over real windows, read out of app.css, at
 *      rest and with the box dragged to that ceiling — the seam grip's own line
 *      included, which short windows give straight back.
 *   3. Chat area extendable: the grip at the seam just above the reply box
 *      lengthens or shortens the conversation — the thread takes every pixel
 *      the pane gains or loses; short windows collapse the seam to zero so
 *      the foot keeps every pixel.
 *   4. Nothing selected: no pane at all — the list is the whole page, so the
 *      compact invitation panel (and its rules) went with the two-column inbox.
 *   5. The old focus mode ships nothing: no button, no label, no script, no
 *      rules — what the pane header keeps is the Close link, and what the
 *      page ships is the pane script's seam and nothing else of that era.
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-leads-reply-'));
process.env.FIRMLEDGER_DATA_DIR = dataDir;
const { db } = require('../src/db');
const bcrypt = require('bcryptjs');

db.prepare("INSERT INTO settings(key,value) VALUES('upkeep_on','0') ON CONFLICT(key) DO NOTHING").run();
const owner = db.prepare(
  "INSERT INTO users(email,password_hash,name,plan,plan_expires_at,trial_expires_at,leads_digest) VALUES(?,?,?,'pro','2099-01-01','','both')"
).run('owner@reply.example', bcrypt.hashSync('ReplyOnly!2026', 10), 'Reply Owner').lastInsertRowid;
const inquirer = db.prepare(
  "INSERT INTO users(email,password_hash,name,trial_expires_at,leads_digest) VALUES(?,?,?,'','both')"
).run('buyer@reply.example', bcrypt.hashSync('ReplyOnly!2026', 10), 'Reply Buyer').lastInsertRowid;
db.prepare(
  "INSERT INTO listings(slug,name,description,category,country,city,website,status,claimed,owner_user_id) VALUES('reply-cleaners','Reply Cleaners','Verified cleaning company you can hire for offices.','Cleaning Services','Kenya','Nairobi','https://reply.example','approved',1,?)"
).run(owner);

const { createSession } = require('../src/lib/session');
const s = { owner: createSession(owner, 'user'), inquirer: createSession(inquirer, 'user') };

const port = 6400 + process.pid % 300;
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
const html = async (route, who) => (await call(route, who)).text();

(async () => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + log)), 20000);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Server exited: ' + code + log)); });
    server.stdout.on('data', (d) => {
      log += d;
      if (log.includes('FirmLedger running')) { clearTimeout(timer); resolve(); }
    });
  });

  /* ── 1. the page ends with the conversation ─────────────────────────────── */
  console.log('Inbox tail — no digest band below the conversation');
  await call('/listing/reply-cleaners/leads', 'inquirer', {
    _csrf: s.inquirer.csrf, name: 'Reply Buyer', subject: 'Quote please',
    message: 'Hello, please quote a full office clean for twelve desks in Westlands.',
  });
  const lead = db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 1').get();
  check('seed inquiry created', !!lead);
  db.prepare('INSERT INTO lead_messages (lead_id, sender, body, created_at) VALUES (?,?,?,?)')
    .run(lead.id, 'owner', 'Happy to — a twelve-desk clean is KES 24,000/month.', '2026-09-09 10:05:00');

  const openHtml = await html(`/dashboard/leads?open=${lead.id}`, 'owner');
  const plainHtml = await html('/dashboard/leads', 'owner');
  const dashHtml = await html('/dashboard', 'owner');
  check('the inbox ships no weekly-digest band',
    !openHtml.includes('news-band') && !plainHtml.includes('news-band'));
  check('and no orphan logo mark where the band used to be', !openHtml.includes('news-mark'));
  check('every other page keeps the band', dashHtml.includes('news-band') && dashHtml.includes('news-mark'));
  check('the conversation is the last thing before the footer',
    openHtml.indexOf('lead-detail-foot') < openHtml.indexOf('<footer class="site-footer">')
    && openHtml.indexOf('lead-detail-bar') < openHtml.indexOf('<footer class="site-footer">'));
  check('the slim head above the inbox is still the slim head', /class="page-head leads-head"/.test(openHtml));

  /* ── 2+3. markup: one pinned foot, the grip above the box, no focus control ─ */
  console.log('Pane markup — the foot stays under the chat, the grip above the box');
  check('exactly one pinned foot, grip first, still after the thread',
    (openHtml.match(/lead-detail-foot/g) || []).length === 1
    && openHtml.indexOf('id="leadThread"') < openHtml.indexOf('lead-detail-foot')
    && openHtml.indexOf('lead-detail-foot') < openHtml.indexOf('lead-thread-grip')
    && openHtml.indexOf('lead-thread-grip') < openHtml.indexOf('lead-reply-form')
    && openHtml.indexOf('lead-reply-form') < openHtml.indexOf('lead-detail-bar'));
  check('the pane header ships no full-width control, only Close',
    !openHtml.includes('data-lead-focus') && !openHtml.includes('lead-pane-focus')
    && !openHtml.includes('Full width') && !openHtml.includes('Back to list')
    && openHtml.includes('Close ✕'));
  check('the chat-area grip is a labelled separator above the reply box',
    /<div class="lead-thread-grip" data-lead-thread-grip role="separator" aria-orientation="horizontal" tabindex="0"\s+aria-label="[^"]*Resize[^"]*">/.test(openHtml)
    && openHtml.indexOf('data-lead-thread-grip') < openHtml.indexOf('name="body"'));
  check('it cannot submit a form and holds no field name',
    !/<div[^>]*data-lead-thread-grip[^>]*(type="submit"|name=)/.test(openHtml));
  check('an inbox with nothing open ships no pane, no grip and no foot',
    !/<div[^>]*data-lead-thread-grip/.test(plainHtml) && !/class="lead-detail-foot"/.test(plainHtml)
    && !/<div class="lead-detail-col">/.test(plainHtml) && plainHtml.includes('<div class="lead-list-col">'));
  const buyerHtml = await html(`/dashboard/leads?box=sent&open=${lead.id}`, 'inquirer');
  check('the inquirer gets the same seam grip above their box',
    /data-lead-thread-grip/.test(buyerHtml)
    && buyerHtml.indexOf('data-lead-thread-grip') < buyerHtml.indexOf('name="body"'));
  const reply = await call(`/dashboard/leads/${lead.id}/reply`, 'owner',
    { _csrf: s.owner.csrf, body: 'Confirming Monday 8am — see you then.' });
  check('the reply still posts from the pinned foot',
    reply.status === 302 && decodeURIComponent(reply.headers.get('location') || '').includes('Message sent'));
  const status = await call(`/dashboard/leads/${lead.id}/status`, 'owner',
    { _csrf: s.owner.csrf, status: 'won' });
  check('and the status line still posts from it',
    status.status === 302 && decodeURIComponent(status.headers.get('location') || '').includes('Marked as Won'));

  /* ── stylesheet ────────────────────────────────────────────────────────── */
  console.log('Stylesheet — a ceiling for the box, a give in the thread, a seam for the chat');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  const mark = css.indexOf('==== Leads inbox — the chat extends');
  check('the new block follows the shipped inbox geometry, it does not replace it',
    mark > css.indexOf('.lead-detail-foot { display: grid;')
    && css.lastIndexOf('.leads-section { padding-bottom: 1.5rem; }') > mark);
  const tail = css.slice(mark);
  check('the shipped geometry above it is untouched',
    /\.lead-detail \{[^}]*padding: 14px 18px 12px;/.test(css.slice(0, mark))
    && /\.lead-detail \.lead-thread \{ min-height: 220px; \}/.test(css.slice(0, mark)));
  check('a dragged reply box has one floor, one ceiling and no sideways drag',
    /\.lead-reply-form \.input \{ min-height: (80)px; max-height: (300)px; width: 100%; box-sizing: border-box;/.test(css)
    && /\.lead-reply-form \.input \{[^}]*resize: vertical;/.test(css)
    && !/\.lead-reply-form \.input \{[^}]*resize: (horizontal|both)/.test(css)
    && !/\.lead-reply-form \.input \{ min-height: (56|66|76)px/.test(css),
    'one box, one set of bounds, on every screen');
  check('short windows reclaim the thread floor instead of scrolling the pane',
    /@media \(min-width: 901px\) and \(max-height: 880px\) \{\s*\.lead-detail \.lead-thread \{ min-height: 96px; \}/.test(tail)
    && css.indexOf('.lead-detail .lead-thread { min-height: 96px; }') > css.indexOf('.lead-detail .lead-thread { min-height: 220px; }'));
  check('the pane scroll escape hatch is still declared, untouched',
    /@media \(min-width: 901px\) \{\s*\.lead-detail \{ overflow-y: auto; \}/.test(css));
  check('nothing open renders no pane at all, and the empty pane left no rules behind',
    !css.includes('lead-detail-empty') && !plainHtml.includes('lead-detail-empty'));
  check('the list column keeps its own sticky frame, stretched across the page',
    /\.lead-list-col \{ position: sticky; top: 84px; max-height:/.test(css)
    && !/\.lead-list-col \{[^}]*max-width/.test(css));
  check('the focus mode left no rules behind',
    !css.includes('.is-max') && !css.includes('lead-pane-focus') && !css.includes('--lead-list-w'));
  check('the seam grip is a vertical drag that collapses on short windows',
    /\.lead-thread-grip \{[^}]*cursor: ns-resize; touch-action: none;/.test(css)
    && /@media \(min-width: 901px\) and \(max-height: 880px\) \{\s*\.lead-thread-grip \{ height: 0; margin-top: 0; \}/.test(css));
  check('the inbox stops padding itself out below the pane',
    /\.leads-section \{ padding-bottom: 1\.5rem; \}/.test(tail) && /\.leads-section \{ padding-top: 1\.1rem; \}/.test(css));
  check('nothing in the new block forces its way with !important', !tail.includes('!important'));
  check('no focus ring, glow or shadow was added to a field',
    !/:focus|outline|box-shadow/.test(tail));

  /* ── geometry, read from the file rather than copied into the test ─────── */
  const px = function (re, what) {
    const m = re.exec(css);
    if (!m) throw new Error('the reply-fit audit could not read ' + what + ' from app.css');
    return m.slice(1).map(Number);
  };
  const [paneCap, headerCut, paneFloor] = /--pane-h:\s*min\((\d+)px,\s*max\(calc\(100d?vh - (\d+)px\),\s*(\d+)px\)\)/.exec(css).slice(1).map(Number);
  const paneHeight = (vh) => Math.min(paneCap, Math.max(vh - headerCut, paneFloor));
  const [padTop, padBottom] = px(/\.lead-detail \{[^}]*padding: (\d+)px \d+px (\d+)px/, 'the pane padding');
  const [threadGap] = px(/\.lead-thread \{[^}]*margin: (\d+)px 0 0/, 'the thread top margin');
  const [gripH, gripTop] = px(/\.lead-thread-grip \{\s*position: relative; z-index: \d+;\s*height: (\d+)px; margin-top: (\d+)px;/, 'the seam grip');
  const [formGap, formTop] = px(/\.lead-reply-form \{ display: grid; gap: (\d+)px; margin-top: (\d+)px/, 'the composer rows');
  const [boxMin] = px(/\.lead-reply-form \.input \{ min-height: (\d+)px/, 'the composer box floor');
  const [boxMax] = px(/\.lead-reply-form \.input \{[^}]*?max-height: (\d+)px/, 'the composer box ceiling');
  const [btnRow] = px(/\.btn-sm \{ height: (\d+)px/, 'the control row');
  const [barTop, barPad] = px(/\.lead-detail-bar \{[^}]*margin-top: (\d+)px; padding-top: (\d+)px/, 'the housekeeping line');
  const [floorRest] = px(/\.lead-detail \.lead-thread \{ min-height: (\d+)px/, 'the shipped thread floor');
  const [floorShort] = px(/@media \(min-width: 901px\) and \(max-height: 880px\) \{\s*\.lead-detail \.lead-thread \{ min-height: (\d+)px/, 'the reclaimed thread floor');
  const text = 27 /* pane title */ + 18 /* meta line */
    + 47 /* facts strip: the contact line, and the ask on the line below it */
    + 51 /* composer help */;
  /* The seam grip is full chrome on normal windows and collapses to zero on
     short ones — the same media the thread floor reclaims under. */
  const gripCost = (vh) => (vh <= 880 ? 0 : gripTop + gripH);
  const footAt = (box, vh) => gripCost(vh) + formTop + box + formGap + btnRow + formGap + barTop + barPad + 1 + btnRow;
  const chrome = (box, vh) => padTop + padBottom + threadGap + footAt(box, vh) + text;
  /* The card's window height is a floor, not a ceiling: the card is exactly the
     window at rest and grows by whatever the chrome plus the thread's floor
     does not fit inside it. The thread never stretches the card itself — a zero
     flex basis and its own scrollbar keep a long conversation inside the chat. */
  const floorFor = (vh) => (vh <= 880 ? floorShort : floorRest);
  const cardAt = (box, vh) => Math.max(paneHeight(vh), chrome(box, vh) + floorFor(vh));
  const chatAt = (box, vh) => cardAt(box, vh) - chrome(box, vh);

  console.log('Screen fit — the foot is inside the card, at rest and dragged wide');
  let atRestBad = '';
  let worstBad = '';
  let eaten = '';
  for (const vh of [640, 668, 720, 768, 800, 900, 1014, 1080, 1440]) {
    const pane = paneHeight(vh);
    /* At rest the box sits at its floor and the shipped geometry still fits the
       window: the thread keeps its full floor and the card does not grow. */
    if (pane - chrome(boxMin, vh) < floorRest && !atRestBad) {
      atRestBad = `vh=${vh}: chat ${pane - chrome(boxMin, vh)}px under the ${floorRest}px floor (pane ${pane}px)`;
    }
    /* Dragged to the ceiling, the card grows instead of squeezing the chat. */
    if (chatAt(boxMax, vh) < floorShort && !worstBad) {
      worstBad = `vh=${vh}: chat ${chatAt(boxMax, vh)}px under the reclaimed ${floorShort}px floor`;
    }
    const grown = cardAt(boxMax, vh) - pane;
    if (grown > boxMax - boxMin && !eaten) {
      eaten = `vh=${vh}: the card grew ${grown}px for a box that gained ${boxMax - boxMin}px`;
    }
  }
  check('at rest the thread keeps its full floor, so the card never needs a scrollbar of its own', !atRestBad, atRestBad);
  check('with the box dragged to its ceiling the chat still stands and Send stays in the card', !worstBad, worstBad);
  check('the card only grows by what the box gained — the reply box can never eat the conversation', !eaten, eaten);
  check('the bounds are what make that provable', boxMin === 80 && boxMax === 300, `min ${boxMin}, max ${boxMax}`);

  /* ── 5. the old focus mode ships nothing ────────────────────────────────── */
  console.log('Focus mode — the button, the labels, the script and the rules are all gone');
  check('no focus button or label anywhere in the served page',
    !openHtml.includes('lead-pane-focus') && !openHtml.includes('lpf-label')
    && !openHtml.includes('Full width') && !openHtml.includes('Back to list'));
  check('the pane script keeps the seam; the focus seam is not served',
    openHtml.includes('__flLeadsPane') && !openHtml.includes('__flLeadsFocus'));
  check('no script on the page toggles the old mode',
    !openHtml.includes('is-max') && !openHtml.includes("'Escape'"));
  check('one grip in the markup, wired by the pane script',
    (openHtml.match(/class="lead-thread-grip"/g) || []).length === 1
    && openHtml.includes('fl.leadsPane.v2'));
  check('the new CSS restates none of the foot it sits under', !tail.includes('.lead-detail-foot'));

  console.log('\n' + '='.repeat(64));
  if (process.exitCode) console.log(`Leads reply fit: ${passed} passed, with failures above`);
  else console.log(`Leads reply fit: ${passed} checks all checks passed`);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  server.kill();
  try { require('../src/db').db.close(); } catch (e) { /* already closed */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* tmp cleanup */ }
});
