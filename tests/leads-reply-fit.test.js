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
 *   2. The composer is the pane's floor: the reply box has a ceiling, and the
 *      thread gives height back on a short window instead of making the pane
 *      scroll. Budget audit over real windows, read out of app.css, at rest
 *      and with the box dragged to that ceiling.
 *   3. Chat area extendable: one button in the pane header hands the
 *      conversation the whole window — the list column steps aside, the pane
 *      fills the viewport, the corner grip stands down; stacked screens and
 *      print opt out. Nothing persists: the next load is the two-column inbox
 *      with the list in hand again.
 *   4. Nothing selected: a compact invitation, not a window-tall white box.
 *   5. The shipped focus script, under vm: the button engages and parks the
 *      pane, Esc releases it, a narrow window refuses and clears, and a page
 *      with no open conversation runs no handler at all.
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
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

  /* ── 2+3. markup: one pinned foot, one focus button in the header ──────── */
  console.log('Pane markup — the foot stays under the chat, the focus control above it');
  check('exactly one pinned foot, still after the thread',
    (openHtml.match(/lead-detail-foot/g) || []).length === 1
    && openHtml.indexOf('id="leadThread"') < openHtml.indexOf('lead-detail-foot')
    && openHtml.indexOf('lead-detail-foot') < openHtml.indexOf('lead-reply-form')
    && openHtml.indexOf('lead-reply-form') < openHtml.indexOf('lead-detail-bar')
    && openHtml.indexOf('lead-detail-bar') < openHtml.indexOf('data-lead-resize'));
  check('the focus control is a labelled toggle in the pane header',
    /<button class="btn btn-ghost btn-sm lead-pane-focus" type="button" data-lead-focus\s+aria-pressed="false" aria-controls="leadThread"/.test(openHtml));
  check('it names itself and parks beside Close, above the chat',
    openHtml.includes('<span class="lpf-label">Full width</span>')
    && openHtml.indexOf('data-lead-focus') < openHtml.indexOf('id="leadThread"')
    && openHtml.indexOf('data-lead-focus') < openHtml.indexOf('Close ✕'));
  check('it cannot submit a form and holds no field name',
    !/<button[^>]*data-lead-focus[^>]*(type="submit"|name=)/.test(openHtml));
  check('an inbox with nothing open ships no toggle and no foot',
    !/<button[^>]*data-lead-focus/.test(plainHtml) && !/class="lead-detail-foot"/.test(plainHtml)
    && plainHtml.includes('lead-detail-empty'));
  const buyerHtml = await html(`/dashboard/leads?box=sent&open=${lead.id}`, 'inquirer');
  check('the inquirer gets the same pane tools', /data-lead-focus/.test(buyerHtml)
    && buyerHtml.indexOf('data-lead-focus') < buyerHtml.indexOf('id="leadThread"'));
  const reply = await call(`/dashboard/leads/${lead.id}/reply`, 'owner',
    { _csrf: s.owner.csrf, body: 'Confirming Monday 8am — see you then.' });
  check('the reply still posts from the pinned foot',
    reply.status === 302 && decodeURIComponent(reply.headers.get('location') || '').includes('Message sent'));
  const status = await call(`/dashboard/leads/${lead.id}/status`, 'owner',
    { _csrf: s.owner.csrf, status: 'won' });
  check('and the status line still posts from it',
    status.status === 302 && decodeURIComponent(status.headers.get('location') || '').includes('Marked as Won'));
  check('the focus script is its own block, after the pane script',
    openHtml.indexOf('__flLeadsPane') < openHtml.indexOf('__flLeadsFocus')
    && openHtml.includes("'Escape'"));

  /* ── stylesheet ────────────────────────────────────────────────────────── */
  console.log('Stylesheet — a ceiling for the box, a give in the thread, a scoped focus mode');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  const mark = css.indexOf('==== Leads inbox — the chat extends');
  check('the new block follows the shipped inbox geometry, it does not replace it',
    mark > css.indexOf('.lead-detail-foot { display: grid;') && css.lastIndexOf('.lead-detail.is-max {') > mark);
  const tail = css.slice(mark);
  check('the shipped geometry above it is untouched',
    /\.lead-detail \{[^}]*padding: 14px 18px 12px;/.test(css.slice(0, mark))
    && /\.lead-detail \.lead-thread \{ min-height: 220px; \}/.test(css.slice(0, mark)));
  check('a dragged reply box stops at the ceiling the script already sizes to',
    /\.lead-reply-form \.input \{ max-height: (240)px; \}/.test(tail)
    && /\.lead-reply-form \.input \{ min-height: 66px/.test(css));
  check('short windows reclaim the thread floor instead of scrolling the pane',
    /@media \(min-width: 901px\) and \(max-height: 880px\) \{\s*\.lead-detail \.lead-thread \{ min-height: 96px; \}/.test(tail)
    && css.indexOf('.lead-detail .lead-thread { min-height: 96px; }') > css.indexOf('.lead-detail .lead-thread { min-height: 220px; }'));
  check('the pane scroll escape hatch is still declared, untouched',
    /@media \(min-width: 901px\) \{\s*\.lead-detail \{ overflow-y: auto; \}/.test(css));
  check('an empty pane is compact, not window-tall',
    /\.lead-detail\.lead-detail-empty \{ height: auto; min-height: 208px; padding: 26px 18px; \}/.test(tail));
  check('the list column keeps its own sticky frame beside it',
    /\.lead-list-col \{ position: sticky; top: 84px; max-height:/.test(css));
  check('focus mode takes the width, the list steps aside, the pane fills the window',
    /\.lead-layout\.is-max \{ grid-template-columns: minmax\(0, 1fr\); \}/.test(tail)
    && /\.lead-layout\.is-max \.lead-list-col \{ display: none; \}/.test(tail)
    && /\.lead-detail\.is-max \{ height: max\((\d+)px, calc\(100vh - (\d+)px\)\); \}/.test(tail)
    && /@supports \(height: 100dvh\) \{\s*\.lead-detail\.is-max \{ height: max\(480px, calc\(100dvh - 96px\)\); \}/.test(tail));
  check('the corner grip stands down in focus mode',
    /\.lead-layout\.is-max \.lead-resize \{ display: none; \}/.test(tail));
  check('the Send row keeps one line in the wider pane',
    /\.lead-detail\.is-max \.lead-reply-actions \{ flex-wrap: nowrap; \}/.test(tail));
  check('the pressed state says so, in the accent',
    /\.lead-pane-focus\[aria-pressed="true"\] \{ border-color: var\(--accent\)/.test(tail));
  check('stacked screens neither offer the control nor inherit the mode',
    /@media \(max-width: 900px\) \{\s*\.lead-pane-focus \{ display: none; \}\s*\.lead-layout\.is-max \{ grid-template-columns: 1fr; \}\s*\.lead-layout\.is-max \.lead-list-col \{ display: flex; \}\s*\.lead-detail\.is-max \{ height: auto; \}/.test(tail));
  check('print gets the list back and no fixed height',
    /@media print \{\s*\.lead-layout\.is-max \.lead-list-col \{ display: flex; \}\s*\.lead-detail\.is-max \{ height: auto; \}/.test(tail));
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
  const [formGap, formTop] = px(/\.lead-reply-form \{ display: grid; gap: (\d+)px; margin-top: (\d+)px/, 'the composer rows');
  const [boxMin] = px(/\.lead-reply-form \.input \{ min-height: (\d+)px/, 'the composer box floor');
  const [boxMax] = px(/\.lead-reply-form \.input \{ max-height: (\d+)px/, 'the composer box ceiling');
  const [btnRow] = px(/\.btn-sm \{ height: (\d+)px/, 'the control row');
  const [barTop, barPad] = px(/\.lead-detail-bar \{[^}]*margin-top: (\d+)px; padding-top: (\d+)px/, 'the housekeeping line');
  const [floorRest] = px(/\.lead-detail \.lead-thread \{ min-height: (\d+)px/, 'the shipped thread floor');
  const [floorShort] = px(/@media \(min-width: 901px\) and \(max-height: 880px\) \{\s*\.lead-detail \.lead-thread \{ min-height: (\d+)px/, 'the reclaimed thread floor');
  const [maxFloor, maxCut] = px(/\.lead-detail\.is-max \{ height: max\((\d+)px, calc\(100vh - (\d+)px\)\)/, 'the focus-mode pane height');
  const text = 27 /* pane title */ + 18 /* meta line */ + 47 /* facts strip over two rows */ + 51 /* composer help */;
  const footAt = (box) => formTop + box + formGap + btnRow + formGap + barTop + barPad + 1 + btnRow;
  const chrome = (box) => padTop + padBottom + threadGap + footAt(box) + text;
  const atRest = chrome(boxMin);
  const worst = chrome(boxMax);

  console.log('Screen fit — the foot is inside the pane, at rest and dragged wide');
  let atRestBad = '';
  let worstBad = '';
  let eaten = '';
  let maxBad = '';
  for (const vh of [640, 668, 720, 768, 800, 900, 1014, 1080, 1440]) {
    const pane = paneHeight(vh);
    if (pane - atRest < floorRest && !atRestBad) atRestBad = `vh=${vh}: chat ${pane - atRest}px under the ${floorRest}px floor (pane ${pane}px)`;
    const left = pane - worst;
    if (left < floorShort && !worstBad) worstBad = `vh=${vh}: chat ${left}px under the reclaimed ${floorShort}px floor`;
    if (left < 60 && !eaten) eaten = `vh=${vh}: the composer leaves only ${left}px of chat`;
    const mp = Math.max(maxFloor, vh - maxCut);
    if (84 + mp > vh + 4 && !maxBad) maxBad = `vh=${vh}: focus pane runs to ${84 + mp}px, past the ${vh}px window`;
  }
  check('at rest the thread keeps its full floor, so the pane never needs a scrollbar of its own', !atRestBad, atRestBad);
  check('with the box dragged to its ceiling the chat still stands and Send stays in the pane', !worstBad, worstBad);
  check('the reply box can never eat the conversation', !eaten, eaten);
  check('focus mode fills the window without pushing the reply box past it', !maxBad, maxBad);
  check('focus mode hands the whole width to the chat, list at 0',
    maxFloor === 480 && maxCut === 96, `floor ${maxFloor}, cut ${maxCut}`);
  check('the ceiling is what makes that provable', boxMax === 240 && boxMin < boxMax, `min ${boxMin}, max ${boxMax}`);

  /* ── 4. the shipped focus script, under vm ────────────────────────────── */
  console.log('Focus script — engaged by the button, released by Esc, inert when it must be');
  const scriptStart = openHtml.lastIndexOf('<script>', openHtml.indexOf('__flLeadsFocus'));
  const focusJs = openHtml.slice(scriptStart + '<script>'.length, openHtml.indexOf('</script>', scriptStart));
  check('focus script extracted from the served page',
    openHtml.slice(scriptStart, scriptStart + 8) === '<script>'
    && focusJs.includes('__flLeadsFocus') && focusJs.includes("addEventListener('click'"));
  check('it is its own block: the resize script is not in here',
    !focusJs.includes('fl.leadsPane.v1') && !focusJs.includes('dockTick'));
  check('the new CSS restates none of the foot it sits under',
    !tail.includes('.lead-detail-foot'));
  check('it stores nothing: focus mode is a view, not a setting',
    !/localStorage|sessionStorage/.test(focusJs));

  function node(extra = {}) {
    return {
      style: {}, attrs: {}, listeners: {}, textContent: '',
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
        toggle(c, on) { if (on === undefined) on = !this._s.has(c); if (on) this._s.add(c); else this._s.delete(c); return on; },
      },
      getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      fire(t, ev) { (this.listeners[t] || []).forEach((fn) => fn(ev || { preventDefault() {}, key: '' })); },
      querySelector() { return null; },
      focus() { this.focused = true; },
      getBoundingClientRect() { return this.rect; },
      ...extra,
    };
  }
  function rig(opts = {}) {
    const scrolled = [];
    const events = [];
    const docListeners = {};
    const rect = opts.rect || { top: 300, bottom: 1240, left: 40, width: 860 };
    const label = node({ textContent: 'Full width' });
    const btn = node({ querySelector: (sel) => (sel === '.lpf-label' ? label : null) });
    const pane = node({ rect });
    const layout = node({ querySelector: (sel) => (sel === '.lead-detail' ? pane : null) });
    const doc = {
      querySelector: (sel) => ({ '.lead-layout': layout, '[data-lead-focus]': btn }[sel] || null),
      addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
    };
    const mq = { matches: opts.wide !== false, _l: {}, addEventListener(t, fn) { this._l[t] = fn; } };
    const win = {
      innerWidth: opts.innerWidth || 1400,
      scrollY: opts.scrollY === undefined ? 40 : opts.scrollY,
      scrollTo(x, y) { scrolled.push([x, y]); },
      Event: function Event(type) { this.type = type; },
      dispatchEvent(ev) { events.push(ev.type); },
      matchMedia: () => mq,
    };
    const sandbox = { window: win, document: doc };
    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(focusJs, sandbox);
    return { layout, btn, pane, label, scrolled, events, docListeners, mq, F: sandbox.window.__flLeadsFocus };
  }

  {
    const t = rig();
    check('the mode starts off', !t.layout.classList.contains('is-max')
      && t.btn.getAttribute('aria-pressed') === 'false' && t.label.textContent === 'Full width');
    t.btn.fire('click');
    check('one click gives the conversation the whole window',
      t.layout.classList.contains('is-max') && t.pane.classList.contains('is-max')
      && t.btn.getAttribute('aria-pressed') === 'true' && t.label.textContent === 'Back to list');
    check('and parks the pane at the header stop',
      t.scrolled.length === 1 && t.scrolled[0][1] === 256, JSON.stringify(t.scrolled));
    t.btn.fire('click');
    check('the same button hands the width back to the list',
      !t.layout.classList.contains('is-max') && !t.pane.classList.contains('is-max')
      && t.label.textContent === 'Full width' && t.scrolled.length === 1);
    t.btn.fire('click');
    (t.docListeners.keydown || []).forEach((fn) => fn({ key: 'Escape' }));
    check('Esc leaves focus mode', !t.layout.classList.contains('is-max')
      && t.btn.getAttribute('aria-pressed') === 'false');
    t.btn.fire('click');
    (t.docListeners.keydown || []).forEach((fn) => fn({ key: 'a' }));
    check('and only Esc does that', t.layout.classList.contains('is-max'));
    t.pane.style.left = '120px';
    t.pane.style.width = '740px';
    t.btn.fire('click');
    check('a toggled pane drops the dock\u2019s stale numbers and asks to be re-measured',
      t.pane.style.left === '' && t.pane.style.width === '' && t.events.includes('scroll'),
      JSON.stringify([t.pane.style.left, t.pane.style.width, t.events]));
    check('the seam reports and drives the mode',
      typeof t.F.isOn === 'function' && t.F.top === 84
      && t.F.leave() === false && t.F.enter() === true && t.F.isOn() === true);
  }
  {
    const t = rig({ wide: false });
    check('a stacked window refuses to hide the list',
      t.F.enter() === false && !t.layout.classList.contains('is-max') && t.scrolled.length === 0);
    const t2 = rig();
    t2.F.enter();
    const change = t2.mq._l.change;
    t2.mq.matches = false;
    if (change) change();
    check('resizing down mid-focus gives the list back at once',
      typeof change === 'function' && !t2.layout.classList.contains('is-max')
      && !t2.pane.classList.contains('is-max') && t2.btn.getAttribute('aria-pressed') === 'false');
  }
  {
    const t = rig({ rect: { top: 84, bottom: 900, left: 0, width: 900 } });
    t.F.enter();
    check('a pane already at the stop is not scrolled at all', t.scrolled.length === 0,
      JSON.stringify(t.scrolled));
  }
  {
    /* Nothing open: no layout, no button — the block must run and do nothing. */
    let threw = '';
    try {
      const doc = { querySelector: () => null, addEventListener() {} };
      const sandbox = { window: { matchMedia: () => ({ matches: true, addEventListener() {} }), scrollTo() {} }, document: doc };
      sandbox.window.window = sandbox.window;
      vm.createContext(sandbox);
      vm.runInContext(focusJs, sandbox);
      check('a page with no open conversation runs the script as a no-op',
        sandbox.window.__flLeadsFocus === undefined);
    } catch (e) { threw = e.message; }
    check('and never throws for it', !threw, threw);
  }

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
