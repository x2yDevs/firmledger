/**
 * Leads pane — fixed conversation + chat-area resize, chat area kept.
 * npm run test:leads-pane
 *
 * Locks in the desktop conversation behaviour, without touching anything else:
 *   1. Chat kept: the thread renders every message in order (day separators,
 *      mine/theirs sides, escaped bodies, kept line breaks) for both roles,
 *      and reply + status still post from inside the new pinned foot.
 *   2. Markup: composer + housekeeping share exactly one .lead-detail-foot
 *      after #leadThread; the chat-area grip is a labelled separator in the
 *      foot, directly above the reply box.
 *   3. Stylesheet: the thread stays the flexible block, bubbles keep their
 *      sides, pane defaults resolve byte-identical to shipped (the new var
 *      fallback chains equal the original declarations), grip/dock rules are
 *      desktop-scoped with no !important.
 *   4. Viewport matrix: the SHIPPED script's own clamp/dock functions —
 *      extracted from the served page and run under vm — keep height inside
 *      420..min(1100, vh-96), and dock only past the header stop, never over
 *      the footer. A docked pane fits every window from 516px up, so Send
 *      needs no scroll; below that the pane scrolls instead of clipping.
 *   5. Wiring: drag/keyboard/double-click/reset/print/scroll listeners are
 *      all attached; a stubbed drag persists size, Ctrl+Home and
 *      double-click restore it, beforeprint undocks, stacked screens opt out.
 * `--browser` measures the same in a real Chromium on 4 devices.
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-leads-pane-'));
process.env.FIRMLEDGER_DATA_DIR = dataDir;
const { db } = require('../src/db');
const bcrypt = require('bcryptjs');

db.prepare("INSERT INTO settings(key,value) VALUES('upkeep_on','0') ON CONFLICT(key) DO NOTHING").run();
const owner = db.prepare(
  "INSERT INTO users(email,password_hash,name,plan,plan_expires_at,trial_expires_at,leads_digest) VALUES(?,?,?,'pro','2099-01-01','','both')"
).run('owner@pane.example', bcrypt.hashSync('PaneOnly!2026', 10), 'Pane Owner').lastInsertRowid;
const inquirer = db.prepare(
  "INSERT INTO users(email,password_hash,name,trial_expires_at,leads_digest) VALUES(?,?,?,'','both')"
).run('buyer@pane.example', bcrypt.hashSync('PaneOnly!2026', 10), 'Pane Buyer').lastInsertRowid;
db.prepare(
  "INSERT INTO listings(slug,name,description,category,country,city,website,status,claimed,owner_user_id) VALUES('pane-cleaners','Pane Cleaners','Verified cleaning company you can hire for offices.','Cleaning Services','Kenya','Nairobi','https://pane.example','approved',1,?)"
).run(owner);

const { createSession } = require('../src/lib/session');
const s = {
  owner: createSession(owner, 'user'),
  inquirer: createSession(inquirer, 'user'),
};

const port = 6100 + process.pid % 300;
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

  console.log('Leads pane — the chat area is well kept on both sides');
  await call('/listing/pane-cleaners/leads', 'inquirer', {
    _csrf: s.inquirer.csrf, name: 'Pane Buyer', subject: 'Quote please',
    message: 'Hello, please quote a full office clean for twelve desks in Westlands.',
  });
  const lead = db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 1').get();
  check('seed inquiry created', !!lead);
  /* A two-day thread with a line break and mark-up-looking text, so the
     render checks below have separators, escaping and <br> to find. */
  db.prepare('UPDATE lead_messages SET created_at = ? WHERE lead_id = ?')
    .run('2026-09-08 09:12:00', lead.id);
  const addMsg = db.prepare('INSERT INTO lead_messages (lead_id, sender, body, created_at) VALUES (?,?,?,?)');
  addMsg.run(lead.id, 'owner', 'Happy to — a twelve-desk clean is KES 24,000/month.', '2026-09-08 10:05:00');
  addMsg.run(lead.id, 'inquirer', 'Great.\nCan we start Monday?', '2026-09-09 08:15:00');
  addMsg.run(lead.id, 'owner', 'Monday works <b>fine</b> & we bring everything.', '2026-09-09 08:50:00');
  db.prepare('UPDATE leads SET updated_at = ? WHERE id = ?').run('2026-09-09 08:50:00', lead.id);

  const ownerHtml = await (await call(`/dashboard/leads?open=${lead.id}`, 'owner')).text();
  const bodies = [
    'Hello, please quote a full office clean for twelve desks in Westlands.',
    'Happy to — a twelve-desk clean is KES 24,000/month.',
    'Great.<br>Can we start Monday?',
    'Monday works &lt;b>fine&lt;/b> &amp; we bring everything.',
  ];
  const at = bodies.map((b) => ownerHtml.indexOf(b));
  check('thread renders every message in order', at.every((i) => i > -1)
    && at[0] < at[1] && at[1] < at[2] && at[2] < at[3]);
  check('two days get two separators', (ownerHtml.match(/class="lead-day"/g) || []).length === 2);
  check('owner sides are 2 mine / 2 theirs',
    (ownerHtml.match(/lead-bubble mine/g) || []).length === 2
    && (ownerHtml.match(/lead-bubble theirs/g) || []).length === 2);
  check('bodies are escaped, line breaks kept',
    ownerHtml.includes('&lt;b>fine&lt;/b> &amp;')
    && !ownerHtml.includes('<b>fine</b>')
    && ownerHtml.includes('Great.<br>Can we start Monday?'));
  check('every bubble keeps its author and timestamp',
    (ownerHtml.match(/lead-bubble-who/g) || []).length === 4
    && (ownerHtml.match(/lead-bubble-meta/g) || []).length === 4
    && ownerHtml.includes('>You<'));
  check('thread still opens on the newest message', ownerHtml.includes('t.scrollTop = t.scrollHeight'));
  check('Close link and facts strip intact',
    ownerHtml.includes('>Close') && ownerHtml.includes('class="lead-facts"'));

  const buyerHtml = await (await call(`/dashboard/leads?box=sent&open=${lead.id}`, 'inquirer')).text();
  check('inquirer sees the same thread, sides mirrored',
    at.every((_, i) => buyerHtml.includes(bodies[i]))
    && (buyerHtml.match(/class="lead-day"/g) || []).length === 2
    && (buyerHtml.match(/lead-bubble mine/g) || []).length === 2
    && (buyerHtml.match(/lead-bubble theirs/g) || []).length === 2);

  console.log('Leads pane — the foot wraps the composer without breaking it');
  check('composer + housekeeping share exactly one pinned foot, grip first',
    (ownerHtml.match(/lead-detail-foot/g) || []).length === 1
    && ownerHtml.indexOf('panel lead-detail') < ownerHtml.indexOf('lead-detail-foot')
    && ownerHtml.indexOf('id="leadThread"') < ownerHtml.indexOf('lead-detail-foot')
    && ownerHtml.indexOf('lead-detail-foot') < ownerHtml.indexOf('lead-thread-grip')
    && ownerHtml.indexOf('lead-thread-grip') < ownerHtml.indexOf('lead-reply-form')
    && ownerHtml.indexOf('lead-reply-form') < ownerHtml.indexOf('lead-detail-bar'));
  check('chat-area grip is a labelled separator that cannot submit a form',
    /<div class="lead-thread-grip" data-lead-thread-grip role="separator" aria-orientation="horizontal" tabindex="0"\s+aria-label="[^"]*Resize[^"]*">/.test(ownerHtml)
    && ownerHtml.indexOf('data-lead-thread-grip') < ownerHtml.indexOf('name="body"')
    && !/data-lead-thread-grip[^>]*(type="submit"|name=)/.test(ownerHtml));
  check('pane script ships its test seam',
    ownerHtml.includes('__flLeadsPane') && ownerHtml.includes('fl.leadsPane.v2'));
  check('the old corner grip and the width trade are gone',
    !ownerHtml.includes('data-lead-resize') && !ownerHtml.includes('class="lead-resize"')
    && !ownerHtml.includes('--lead-list-w'));
  const plainHtml = await (await call('/dashboard/leads', 'owner')).text();
  check('no-open pane ships no grip and no foot',
    !/<div[^>]*data-lead-thread-grip/.test(plainHtml)
    && !/class="lead-detail-foot"/.test(plainHtml)
    && plainHtml.includes('lead-detail-empty'));

  const reply = await call(`/dashboard/leads/${lead.id}/reply`, 'owner',
    { _csrf: s.owner.csrf, body: 'Confirming Monday 8am — see you then.' });
  check('reply posts from inside the pinned foot',
    reply.status === 302 && decodeURIComponent(reply.headers.get('location') || '').includes('Message sent'));
  const reopened = await (await call(`/dashboard/leads?open=${lead.id}`, 'owner')).text();
  check('the reply lands in the thread, newest last',
    reopened.indexOf('Confirming Monday 8am') > reopened.indexOf('Monday works'));
  const status = await call(`/dashboard/leads/${lead.id}/status`, 'owner',
    { _csrf: s.owner.csrf, status: 'won' });
  check('status posts from inside the pinned foot',
    status.status === 302 && decodeURIComponent(status.headers.get('location') || '').includes('Marked as Won'));
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=?').get(lead.id).status, 'won');
  const wonHtml = await (await call(`/dashboard/leads?open=${lead.id}`, 'owner')).text();
  check('the pane states the new status where it was set', wonHtml.includes('pill-lead-won'));

  console.log('Leads pane — the stylesheet keeps the chat, scopes the new');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  check('thread is still the one flexible block in the pane',
    /\.lead-thread \{\s+flex: 1 1 auto; min-height: 200px;\s+overflow-y: auto;/.test(css));
  check('bubbles keep their sides and measure',
    /\.lead-bubble\.mine \{ align-self: flex-end;/.test(css)
    && /\.lead-bubble\.theirs \{ align-self: flex-start;/.test(css)
    && /\.lead-bubble-text \{ font-size: \.95rem;/.test(css));
  check('day separators still pin to the thread top',
    /\.lead-day \{[^}]*position: sticky; top: 0;/.test(css));
  /* Default-identity proofs: with no stored size the new declarations must
     resolve to the shipped ones — shown by reducing the var() fallbacks. */
  const floorVar = /\.lead-detail \{[^}]*?min-height: ([^;]+);/.exec(css)[1];
  check('the card\'s window height is a floor, and a stored size simply replaces it',
    /\.lead-detail \{[^}]*height: auto;[^}]*min-height: var\(--pane-h, /.test(css)
    && css.includes(`min-height: var(--lead-user-h, ${floorVar});`)
    && /\.lead-detail \{\s*position: sticky; top: 84px;/.test(css));
  check('stacked screens drop the floor: the card is content-height there',
    /\.lead-detail \{ position: static; height: auto; min-height: 0; max-height: none; overflow: visible; \}/.test(css));
  check('the width trade left with the corner grip',
    !css.includes('--lead-list-w') && !/\.lead-resize\b/.test(css));
  const floorOrig = Number(/\.lead-detail \.lead-thread \{ min-height: (\d+)px/.exec(css)[1]);
  const floorNew = /\.lead-detail \.lead-thread \{[^}]*?min-height: clamp\((\d+)px, ([\d.]+)vh, (\d+)px\);/.exec(css)
    .slice(1).map(Number);
  check('thread floor keeps 220px, easing only on short windows',
    floorOrig === 220 && floorNew[2] === floorOrig && floorNew[0] === 140, `was ${floorOrig}, now clamp(${floorNew})`);
  /* A card whose height is content-driven needs a thread that cannot stretch
     it: zero basis on desktop (its own scrollbar, its floor), and the shipped
     flexible fill everywhere else, where the page — not the card — scrolls. */
  check('the thread keeps a zero basis on desktop, so a long chat never stretches the card',
    /\.lead-detail \.lead-thread \{ flex: 1 1 0%; min-height: clamp\(/.test(css)
    && /\.lead-thread \{\s+flex: 1 1 auto; min-height: 200px;/.test(css));
  check('foot wrapper adds no box of its own',
    css.includes('.lead-detail-foot { display: grid; gap: 0; margin: 0; padding: 0; min-width: 0; }')
    && css.includes('.lead-detail > .lead-detail-foot { flex: 0 0 auto; }'));
  /* The new block lives between its header comment and the blog header — every
     scoping assertion below runs against that slice, not the whole file. */
  const slice = css.slice(css.indexOf('fixed conversation + chat-area resize'), css.indexOf('============ Blog'));
  check('new block found', slice.length > 500 && !slice.includes('============ Blog'));
  const deskOnly = slice.slice(slice.indexOf('@media (min-width: 901px)'), slice.indexOf('@media (max-width: 900px)'));
  check('height, floor, foot, dock and resizing cursor are desktop-only',
    (slice.match(/@media \(min-width: 901px\)/g) || []).length === 2
    && deskOnly.includes('--lead-user-h') && !deskOnly.includes('--lead-list-w')
    && deskOnly.includes('.lead-detail .lead-thread { flex: 1 1 0%; min-height: clamp(')
    && deskOnly.includes('.lead-detail-foot { position: sticky; bottom: 0; z-index: 2; background: var(--surface); }')
    && deskOnly.includes('.lead-detail.is-docked { position: fixed; z-index: 30; margin: 0; }')
    && deskOnly.includes('.lead-detail.is-resizing { box-shadow: 0 0 0 2px var(--accent); }'));
  check('grip hides on stacked screens and in print, dock releases for print',
    slice.includes('@media (max-width: 900px) {\n  .lead-thread-grip { display: none; }\n}')
    && /\.lead-thread-grip \{[^}]*display: none;/.test(slice.slice(slice.indexOf('@media print')))
    && slice.includes('.lead-detail.is-docked { position: static; }'));
  check('no !important anywhere in the new block', !slice.includes('!important'));
  /* The grip is a full-width seam inside the foot (a normal child, not a
     corner overlay), so it can never cover a control — its whole layout cost
     is its own line, which short windows give straight back. */
  const gripRule = /\.lead-thread-grip \{[^}]*\}/.exec(slice)[0];
  check('grip is a vertical drag seam with a quiet bar',
    /cursor: ns-resize/.test(gripRule) && /touch-action: none/.test(gripRule)
    && /z-index: 3/.test(gripRule)
    && /\.lead-thread-grip \{ height: 0; margin-top: 0; \}/.test(slice)
    && /\.ltg-bar \{ position: absolute;/.test(slice));
  const zDay = Number(/\.lead-day \{[^}]*z-index: (\d+)/.exec(css)[1]);
  const zFoot = Number(/\.lead-detail-foot \{ position: sticky;[^}]*z-index: (\d+)/.exec(slice)[1]);
  const zGrip = Number(/\.lead-thread-grip \{[^}]*z-index: (\d+)/.exec(slice)[1]);
  check('z-order: day marker under foot under grip, docked pane at 30',
    zDay === 1 && zFoot === 2 && zGrip === 3
    && deskOnly.includes('.lead-detail.is-docked { position: fixed; z-index: 30; margin: 0; }'));

  console.log('Leads pane — the shipped script, run under vm over real viewports');
  /* The script under test is extracted from the served page — not a copy. */
  const scriptStart = ownerHtml.lastIndexOf('<script>', ownerHtml.indexOf('__flLeadsPane'));
  const paneJs = ownerHtml.slice(scriptStart + '<script>'.length, ownerHtml.indexOf('</script>', scriptStart));
  check('pane script extracted from the served page',
    ownerHtml.slice(scriptStart, scriptStart + 8) === '<script>'
    && paneJs.includes('fl.leadsPane.v2') && paneJs.includes('shouldDock'));

  /* Stub DOM: fake elements record listeners, classes and inline styles so the
     real handlers (drag, keys, dock, print) can run without a browser. */
  function fakeEl(extra = {}) {
    return {
      style: {
        _vars: {},
        setProperty(k, v) { this._vars[k] = v; },
        removeProperty(k) { delete this._vars[k]; },
      },
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
      },
      listeners: {},
      addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
      offsetHeight: 700,
      clientWidth: 1100,
      rect: { top: 999, bottom: 999, left: 0, width: 0 },
      getBoundingClientRect() { return this.rect; },
      closest() { return null; },
      ...extra,
    };
  }
  const paneEl = fakeEl();
  const gripEl = fakeEl();
  const colEl = fakeEl();
  const sectionEl = fakeEl();
  paneEl.closest = (sel) => ({
    '.lead-detail-col': colEl, '.leads-section': sectionEl,
  }[sel] || null);
  const store = {};
  const winListeners = {};
  const mqQueries = [];
  const mqObj = { matches: true, addEventListener() {}, addListener() {} };
  const sandbox = {
    window: {
      matchMedia(q) { mqQueries.push(q); return mqObj; },
      addEventListener(t, f) { (winListeners[t] = winListeners[t] || []).push(f); },
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
      },
      innerHeight: 900,
      innerWidth: 1400,
    },
    document: {
      querySelector: (sel) => ({
        '.lead-detail-col .lead-detail': paneEl, '[data-lead-thread-grip]': gripEl,
      }[sel] || null),
      body: fakeEl(),
    },
    setTimeout,
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(paneJs, sandbox);
  const P = sandbox.window.__flLeadsPane;
  check('test seam exposes the pure geometry', P
    && typeof P.clampH === 'function' && typeof P.shouldDock === 'function'
    && typeof P.state === 'function' && typeof P.reset === 'function');
  check('storage key and header stop are the contract', P.key === 'fl.leadsPane.v2' && P.dockTop === 84);
  check('desktop means min-width 901px', mqQueries.includes('(min-width: 901px)'));
  const gripKeys = Object.keys(gripEl.listeners).sort().join(',');
  check('grip wires drag, keys and double-click',
    gripKeys === 'dblclick,keydown,pointercancel,pointerdown,pointermove,pointerup', gripKeys);
  const winKeys = Object.keys(winListeners).sort().join(',');
  check('window wires scroll, resize and print', winKeys === 'afterprint,beforeprint,resize,scroll', winKeys);

  /* Height contract: 420..min(1100, vh-96), in-range sizes pass through. */
  const vhs = [480, 516, 600, 668, 720, 800, 900, 1080, 1440];
  const storedH = [0, 200, 419, 420, 500, 700, 900, 1100, 1500, 2000];
  let hBad = '';
  for (const vh of vhs) {
    const max = Math.min(1100, Math.max(420, vh - 96));
    for (const h of storedH) {
      const got = P.clampH(h, vh);
      const want = Math.min(Math.max(Math.round(h) || 0, 420), max);
      if (got !== want && !hBad) hBad = `h=${h} vh=${vh}: got ${got}, want ${want}`;
    }
  }
  check('every stored height lands inside its window clamp on every window', !hBad, hBad);
  let hIdent = '';
  for (const vh of vhs) {
    const max = Math.min(1100, Math.max(420, vh - 96));
    for (let h = 420; h <= max; h += 37) {
      if (P.clampH(h, vh) !== h && !hIdent) hIdent = `h=${h} vh=${vh} moved to ${P.clampH(h, vh)}`;
    }
  }
  check('in-range heights pass through untouched', !hIdent, hIdent);

  /* Dock contract: past the header stop, never over the footer. */
  const dockCases = [
    ['at rest the pane never docks', 200, 2000, 900, false],
    ['one pixel past the stop it docks', 83, 2000, 900, true],
    ['mid-section it stays docked', -500, 3000, 900, true],
    ['exactly at the stop it holds', 84, 2000, 900, false],
    ['near the footer it rejoins', 50, 940, 900, false],
    ['one pixel above the footer guard it docks', 50, 941, 900, true],
    ['a short section never docks', 50, 500, 900, false],
  ];
  for (const [label, top, bottom, vh, want] of dockCases) {
    check(label, P.shouldDock(top, bottom, vh) === want);
  }
  /* A docked pane parks at top:84 with maxHeight max(420, vh-96): its foot is
     on screen with no scroll from 516px windows up; below that the pane
     scrolls (overflow-y) instead of clipping. */
  let fitBad = '';
  for (const vh of [516, 600, 668, 720, 800, 900, 1080]) {
    const bottom = 84 + Math.max(420, vh - 96);
    if (bottom > vh && !fitBad) fitBad = `vh=${vh}: pane bottom ${bottom}px`;
  }
  check('a docked pane fits every window from 516px up', !fitBad, fitBad);
  check('below 516px the pane scrolls instead of clipping',
    84 + Math.max(420, 480 - 96) === 504
    && /@media \(min-width: 901px\) \{\s*\.lead-detail \{ overflow-y: auto; \}/.test(css));

  /* A real drag through the stubbed handlers: 90px longer. */
  const fire = (el, type, ev = {}) => el.listeners[type].forEach((f) => f({ preventDefault() {}, ...ev }));
  fire(gripEl, 'pointerdown', { clientX: 500, clientY: 200, pointerId: 1 });
  check('dragging marks the pane and the page', paneEl.classList.contains('is-resizing')
    && sandbox.document.body.classList.contains('is-lead-resizing'));
  fire(gripEl, 'pointermove', { clientX: 500, clientY: 290 });
  check('a downward drag lengthens the conversation',
    JSON.stringify(P.state()) === JSON.stringify({ h: 790 }), JSON.stringify(P.state()));
  check('the drag applies live, persisting only on release',
    paneEl.style._vars['--lead-user-h'] === '790px'
    && !(P.key in store));
  fire(gripEl, 'pointerup', {});
  check('releasing persists the size and clears the marks',
    JSON.stringify(JSON.parse(store[P.key])) === JSON.stringify({ h: 790 })
    && paneEl.style._vars['--lead-user-h'] === '790px'
    && !paneEl.classList.contains('is-resizing')
    && !sandbox.document.body.classList.contains('is-lead-resizing'));

  /* Keyboard from {h:790} on a 900px window (max 804). */
  fire(gripEl, 'keydown', { key: 'ArrowDown' });
  check('ArrowDown lengthens to the clamp', P.state().h === 804, JSON.stringify(P.state()));
  fire(gripEl, 'keydown', { key: 'Home' });
  check('plain Home is left alone for scrolling', P.state().h === 804);
  fire(gripEl, 'keydown', { key: 'Home', ctrlKey: true });
  check('Ctrl+Home restores the shipped size',
    JSON.stringify(P.state()) === JSON.stringify({ h: null })
    && store[P.key] === '{}'
    && !('--lead-user-h' in paneEl.style._vars));
  fire(gripEl, 'keydown', { key: 'ArrowUp' });
  check('ArrowUp shortens from the shipped size', P.state().h === 680, JSON.stringify(P.state()));
  fire(gripEl, 'dblclick', {});
  check('double-click restores the shipped size',
    JSON.stringify(P.state()) === JSON.stringify({ h: null }));

  /* Docking through the real handler: reset() re-evaluates the dock. */
  colEl.rect = { top: 50, left: 120, width: 740, bottom: 900 };
  sectionEl.rect = { top: -100, bottom: 2000 };
  P.reset();
  check('past the stop the pane parks over its own slot',
    paneEl.classList.contains('is-docked')
    && paneEl.style.left === '120px' && paneEl.style.width === '740px'
    && paneEl.style.top === '84px' && paneEl.style.maxHeight === '804px');
  check('the slot is held open behind the parked pane', colEl.style.minHeight === '700px');
  colEl.rect = { top: 200, left: 120, width: 740, bottom: 1050 };
  P.reset();
  check('back at rest the pane rejoins with no residue',
    !paneEl.classList.contains('is-docked')
    && paneEl.style.left === '' && paneEl.style.width === ''
    && paneEl.style.top === '' && paneEl.style.maxHeight === '' && colEl.style.minHeight === '');
  colEl.rect = { top: 50, left: 120, width: 740, bottom: 900 };
  P.reset();
  assert.ok(paneEl.classList.contains('is-docked'));
  winListeners.beforeprint.forEach((f) => f());
  check('beforeprint undocks for a clean page', !paneEl.classList.contains('is-docked'));
  mqObj.matches = false;
  P.reset();
  check('stacked screens never dock', !paneEl.classList.contains('is-docked'));
  mqObj.matches = true;

  /* ── Optional real-browser geometry ────────────────────────────────────────
     node tests/leads-pane-resize.test.js --browser   (needs a Chromium:
     `npx playwright install chromium`, or CHROMIUM_EXECUTABLE_PATH).
     Measures what a browser actually painted: grip visibility per breakpoint,
     a real pointer drag that persists across reload, double-click restore,
     the dock engaging mid-page, and Send on screen at the foot of the page. */
  const exe = process.env.CHROMIUM_EXECUTABLE_PATH;
  let haveBrowser = !!exe;
  if (!haveBrowser) {
    try { haveBrowser = fs.existsSync(require('playwright').chromium.executablePath()); } catch (e) { haveBrowser = false; }
  }
  if (process.argv.includes('--browser') && !haveBrowser) {
    console.log('Browser pane — SKIPPED: no Chromium found (npx playwright install chromium, or set CHROMIUM_EXECUTABLE_PATH)');
  }
  if (process.argv.includes('--browser') && haveBrowser) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({
      executablePath: exe || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const jsErrors = [];
    const devices = [
      ['phone', 390, 844], ['tablet', 768, 1024],
      ['laptop', 1366, 768], ['desktop', 1920, 1080],
    ];
    console.log('Browser pane — measured geometry, 4 devices');
    for (const [label, width, height] of devices) {
      const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
      await ctx.addCookies([{ name: 'fl_session', value: s.owner.token, url: base }]);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => jsErrors.push(`${label}: ${e.message}`));
      const route = `/dashboard/leads?open=${lead.id}`;
      const res = await page.goto(base + route);
      check(`${label} thread renders`, res.status() === 200, `HTTP ${res.status()}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => window.__flLeadsPane);
      check(`${label} has no sideways page scroll`,
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const pane = page.locator('.lead-detail').first();
      const grip = page.locator('[data-lead-thread-grip]');
      if (width <= 900) {
        check(`${label} grip stays hidden`, await grip.isHidden());
        check(`${label} stacked thread is long, not compressed`, await page.locator('#leadThread').evaluate(
          (t) => t.getBoundingClientRect().height >= Math.min(window.innerHeight * 0.55, 460)));
      } else {
        check(`${label} grip shows`, await grip.isVisible());
        const gap = await grip.evaluate((g) => {
          const form = g.closest('.lead-detail-foot').querySelector('.lead-reply-form');
          return form.getBoundingClientRect().top - g.getBoundingClientRect().bottom;
        });
        check(`${label} grip sits directly above the reply box`, gap >= 4 && gap <= 14, `${Math.round(gap)}px off`);
        /* The dock must engage at some scroll offset — found by scanning, so
           the check holds whatever the header and footer measure. */
        const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
        let docked = false;
        for (let y = 0; y <= max && !docked; y += 60) {
          await page.evaluate((yy) => window.scrollTo(0, yy), y);
          docked = await page.locator('.lead-detail.is-docked').count() > 0;
        }
        check(`${label} pane docks mid-page like the header`, docked);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        const sendBottom = await pane.locator('.lead-reply-form button[type="submit"]').evaluate(
          (el) => el.getBoundingClientRect().bottom);
        check(`${label} Send is on screen at the foot of the page`, sendBottom <= height + 1,
          `${Math.round(sendBottom)} > ${height}`);
        /* A real pointer drag: shorten the chat 100px, survive reload, restore.
           The list column must not move — the seam trades height only. */
        await page.evaluate(() => window.scrollTo(0, 0));
        const h0 = (await pane.boundingBox()).height;
        const w0 = (await page.locator('.lead-list-col').first().boundingBox()).width;
        const gb = await grip.boundingBox();
        await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
        await page.mouse.down();
        await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2 - 100, { steps: 5 });
        await page.mouse.up();
        const h1 = (await pane.boundingBox()).height;
        const w1 = (await page.locator('.lead-list-col').first().boundingBox()).width;
        check(`${label} drag resizes the chat, the list stays put`,
          Math.abs(h1 - (h0 - 100)) <= 12 && Math.abs(w1 - w0) <= 2,
          `pane ${Math.round(h0)}→${Math.round(h1)}, list ${Math.round(w0)}→${Math.round(w1)}`);
        await page.reload();
        await page.waitForFunction(() => window.__flLeadsPane);
        const h2 = (await pane.boundingBox()).height;
        check(`${label} size persists across reload`, Math.abs(h2 - h1) <= 1, `${Math.round(h2)} vs ${Math.round(h1)}`);
        await grip.dblclick();
        const h3 = (await pane.boundingBox()).height;
        check(`${label} double-click restores`, Math.abs(h3 - h0) <= 1, `${Math.round(h3)} vs ${Math.round(h0)}`);
      }
      await ctx.close();
    }
    check('no page JavaScript errors', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
    await browser.close();
  }

})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  server.kill();
  try { require('../src/db').db.close(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
  const label = process.exitCode ? 'FAIL' : 'all checks passed';
  console.log(`\nLeads pane resize: ${passed} checks ${label}`);
});
