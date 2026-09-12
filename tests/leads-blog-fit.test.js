/**
 * Leads + notes + blog fit — regression audit over real HTTP.
 * npm run test:leads-fit
 *
 * Locks in the fixes, without touching existing behaviour:
 *   1. The composer: it requires text client-side, states the real limits,
 *      keeps its explanation inline, and owns a pane with no notes block.
 *   2. Sent honesty: a thread the business archived stays in the inquirer's
 *      Sent box AND in the Sent tab count, still readable and replyable.
 *   3. Inbox links carry no stray trailing "?" when no filter is active.
 *   4. Screen fit: the conversation pane is sized by the window, the chat is
 *      the only block in it that flexes, and the fixed chrome around it can
 *      never add up to more than the pane has to give (budget audit over a
 *      matrix of real device viewports). `--browser` adds the same audit as
 *      measured geometry in a real Chromium.
 *   5. Blog CSS keeps article rhythm (paragraph spacing, visible links,
 *      responsive headings) and a scroll guard for pasted tables, wide or
 *      phone-sized.
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

  console.log('Leads fit — the composer explains itself, and the thread owns the pane');
  await call('/listing/fit-cleaners/leads', 'inquirer', {
    _csrf: s.inquirer.csrf, name: 'Fit Buyer', subject: 'Quote please',
    message: 'Hello, please quote a full office clean for twelve desks in Westlands.',
  });
  const lead = db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 1').get();
  check('seed inquiry created', !!lead);

  const openHtml = await (await call(`/dashboard/leads/${lead.id}`, 'owner')).text();
  check('reply box requires a message', /name="body"[^>]*required/.test(openHtml));
  check('the reply box carries the server limits, not a hard maxlength', /name="body"[^>]*data-max="4000"/.test(openHtml) && !/name="body"[^>]*maxlength/.test(openHtml));
  check('the composer explains the window it accepts', /Between 2 and 4,000 characters/.test(openHtml));
  check('a hidden reason block is present for a refused send', /class="lead-reply-error"[^>]*role="alert"[^>]*hidden/.test(openHtml));

  /* Nothing but the conversation sits under the thread: the private-notes block
     was retired so the chat owns the pane, on both sides and in the stylesheet. */
  const inboxCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  check('no notes UI is rendered for the owner', !openHtml.includes('Private notes') && !openHtml.includes('lead-note-form'));
  const buyerView = await (await call(`/dashboard/leads/${lead.id}?box=sent`, 'inquirer')).text();
  check('no notes UI is rendered for the inquirer', !buyerView.includes('Private notes') && !buyerView.includes('lead-note-form'));
  check('no notes styles are left behind', !/\.lead-notes|\.lead-note-form/.test(inboxCss));
  check('the thread is the one flexible block in the pane', /\.lead-thread \{\s*flex: 1 1 auto; min-height: 200px/.test(inboxCss));
  check('the contact facts are a compact strip, not a table', /class="lead-facts"/.test(openHtml)
    && !/<table class="facts">/.test(openHtml)
    && /class="lead-facts"/.test(buyerView));
  check('the facts strip keeps every contact detail and link', /lf-k">Email<\/span><a class="lf-v" href="mailto:/.test(openHtml)
    && /lf-k">Looking for<\/span><b class="lf-v">/.test(openHtml));
  /* Two lines, in this order: how to reach them, then what they want. One
     run-on line reads as though the ask were the tail of the email address. */
  check('the ask sits on its own line below the contact details',
    /class="lf lf-look"><span class="lf-k">Looking for/.test(openHtml)
    && openHtml.indexOf('lf-k">Email') < openHtml.indexOf('lf lf-look')
    && /\.lead-facts \.lf-look \{ flex: 0 0 100%; \}/.test(inboxCss)
    && /class="lf lf-look"/.test(buyerView));
  check('the head above the inbox is slim and scoped to it', /class="page-head leads-head"/.test(openHtml)
    && /class="section-tight leads-section leads-thread-page"/.test(openHtml)
    && /\.leads-head h1 \{[^}]*clamp\(1\.45rem/.test(inboxCss));
  check('refusals are styled inline under the box', /\.lead-reply-error \{[^}]*var\(--bad-soft\)/.test(inboxCss));
  check('the counter warns before the limit is hit', /\.lead-reply-count\.is-near \{ color: var\(--warn\)/.test(inboxCss));

  const ownerAgain = openHtml;

  console.log('Leads fit — the pane is sized by the window, so the chat keeps the height');
  /* Both panes take one height expression from .lead-layout: the window minus
     the sticky header, clamped to a floor and a cap. The numbers are read back
     out of the stylesheet, so this audit follows the CSS rather than a copy. */
  const paneExpr = /--pane-h:\s*min\((\d+)px,\s*max\(calc\(100d?vh - (\d+)px\),\s*(\d+)px\)\)/.exec(inboxCss);
  check('one viewport-derived height drives both panes', !!paneExpr
    && /\.lead-detail \{[^}]*height:\s*var\(--pane-h/.test(inboxCss)
    && /\.lead-list-col \{[^}]*max-height:\s*var\(--pane-h/.test(inboxCss)
    && /\.lead-detail \{[^}]*position: sticky; top: 84px/.test(inboxCss));

  /* Everything in the pane except the thread has a fixed height. What the
     stylesheet declares is read from it; only the four text blocks (title
     line, meta line, facts strip, composer help) are estimated, at their worst
     realistic wrap in a ~500px column. */
  const px = function (re, what) {
    const m = re.exec(inboxCss);
    if (!m) throw new Error('screen-fit audit could not read ' + what + ' from app.css');
    return m.slice(1).map(Number);
  };
  const [paneCap, headerCut, paneFloor] = paneExpr.slice(1).map(Number);
  const paneHeight = (vh) => Math.min(paneCap, Math.max(vh - headerCut, paneFloor));
  const [threadFloor] = px(/\.lead-detail \.lead-thread \{ min-height: (\d+)px/, 'the thread floor');
  const [padTop, padBottom] = px(/\.lead-detail \{[^}]*padding: (\d+)px \d+px (\d+)px/, 'the pane padding');
  const [threadGap] = px(/\.lead-thread \{[^}]*margin: (\d+)px 0 0/, 'the thread top margin');
  const [boxMin] = px(/\.lead-reply-form \.input \{ min-height: (\d+)px/, 'the composer box');
  const [formGap] = px(/\.lead-reply-form \{ display: grid; gap: (\d+)px/, 'the composer row gap');
  const [formTop] = px(/\.lead-reply-form \{[^}]*margin-top: (\d+)px/, 'the composer top margin');
  const [btnRow] = px(/\.btn-sm \{ height: (\d+)px/, 'the control row');
  const [barTop, barPad] = px(/\.lead-detail-bar \{[^}]*margin-top: (\d+)px; padding-top: (\d+)px/, 'the housekeeping line');
  const declared = padTop + padBottom
    + threadGap
    + formTop + boxMin + formGap + btnRow + formGap
    + barTop + barPad + 1 + btnRow;
  const text = 27 /* pane title line + its margin */
    + 18 /* "For <listing> · date · city" */
    + 47 /* facts strip wrapped over two rows */
    + 51 /* composer help wrapped over three lines */;
  const chrome = declared + text;

  /* The bug this replaces: a pane of min(92vh, 980px) starting 380px down the
     page, holding 448px of chrome and a 420px thread floor — so the composer
     fell below the fold and the pane grew a second scrollbar. */
  const windows = [600, 668, 720, 768, 800, 900, 1080, 1440];
  for (const vh of windows) {
    const pane = paneHeight(vh);
    const chat = pane - chrome;
    check(`a ${vh}px-tall window leaves the chat ${chat}px of a ${pane}px pane`,
      chat >= threadFloor && chat >= pane * 0.4,
      `chat ${chat}px is under ${Math.max(threadFloor, Math.round(pane * 0.4))}px (chrome ${chrome}px)`);
  }
  check('stacked screens give the conversation a long uncapped run',
    /\.lead-detail \.lead-thread \{ min-height: min\(62vh, 520px\); max-height: none; \}/.test(inboxCss)
    && /\.lead-detail \.lead-thread \{ min-height: min\(64vh, 480px\); \}/.test(inboxCss)
    && !/max-height: min\((80|76)vh/.test(inboxCss),
    'a capped thread is a compressed thread');

  console.log('Leads fit — Sent stays honest after the business archives');
  await call(`/dashboard/leads/${lead.id}/archive`, 'owner', { _csrf: s.owner.csrf, archived: '1' });
  assert.equal(db.prepare('SELECT archived FROM leads WHERE id=?').get(lead.id).archived, 1);
  const leads = require('../src/lib/leads');
  check('Sent count still 1 after owner archive', leads.countsForInquirer(inquirer).total === 1);
  const sentHtml = await (await call('/dashboard/leads?box=sent', 'inquirer')).text();
  check('Sent tab badge still shows 1', />Sent <span class="lead-n">1<\/span>/.test(sentHtml));
  check('Sent list still shows the thread', sentHtml.includes('Quote please'));
  const stillOpen = await (await call(`/dashboard/leads/${lead.id}?box=sent`, 'inquirer')).text();
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
  const apiPost = await (await call('/blog/introducing-the-firmledger-api')).text();
  check('a wide seeded table ships inside its scroll wrapper', apiPost.includes('class="table-wrap"') && apiPost.includes('class="table"'));
  check('a phone blog index is one roomy column', /@media \(max-width: 480px\) \{\s*\.blog-grid \{ gap: 14px; grid-template-columns: minmax\(0, 1fr\); \}/.test(css));
  check('the phone article measure shrinks with the screen', /\.blog-prose h1 \{ font-size: clamp\(25px, 7\.2vw, 32px\); \}/.test(css)
    && /\.blog-body \{ font-size: 14\.8px; \}/.test(css));
  check('the table wrapper takes the scroll, the page never does', /\.blog-body \.table-wrap \{[^}]*overflow-x: auto/.test(css)
    && /\.blog-body \.table thead th \{ white-space: normal; \}/.test(css));
  const post = await (await call('/blog/where-to-list-your-startup-in-2026')).text();
  check('2026 guide renders inside the prose shell', post.includes('blog-prose-wrap') && post.includes('class="blog-body'));
  const index = await (await call('/blog')).text();
  check('blog index renders cards in the grid', index.includes('blog-grid') && index.includes('blog-card-link'));

  /* ── Optional real-browser geometry ────────────────────────────────────────
     node tests/leads-blog-fit.test.js --browser   (needs a Chromium:
     `npx playwright install chromium`, or CHROMIUM_EXECUTABLE_PATH).
     Everything above reads the stylesheet; this measures what a browser
     actually painted on the same matrix, so the budget audit is checked
     against reality rather than against arithmetic. It is opt-in so `npm
     test` still runs on a machine with no browser installed. */
  const exe = process.env.CHROMIUM_EXECUTABLE_PATH;
  let haveBrowser = !!exe;
  if (!haveBrowser) {
    try { haveBrowser = fs.existsSync(require('playwright').chromium.executablePath()); } catch (e) { haveBrowser = false; }
  }
  if (process.argv.includes('--browser') && !haveBrowser) {
    console.log('Browser fit — SKIPPED: no Chromium found (npx playwright install chromium, or set CHROMIUM_EXECUTABLE_PATH)');
  }
  if (process.argv.includes('--browser') && haveBrowser) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({
      executablePath: exe || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const jsErrors = [];
    const devices = [
      ['iPhone SE landscape', 568, 320], ['Android small', 360, 800], ['iPhone 14', 390, 844],
      ['iPhone 14 Pro Max', 430, 932], ['iPad portrait', 768, 1024], ['iPad landscape', 1024, 768],
      ['small laptop', 1280, 720], ['1366 laptop', 1366, 768], ['1440 desktop', 1440, 900],
      ['1920 desktop', 1920, 1080],
    ];
    const pages = [
      '/blog',
      '/blog/introducing-the-firmledger-api',
      `/dashboard/leads/${lead.id}`,
      `/dashboard/leads/${lead.id}?box=sent`,
    ];
    console.log('Browser fit — measured geometry, 10 devices × 4 pages');
    for (const [label, width, height] of devices) {
      const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
      for (const who of ['owner', 'inquirer']) {
        await ctx.addCookies([{ name: 'fl_session', value: s[who].token, url: base }]);
      }
      const page = await ctx.newPage();
      page.on('pageerror', (e) => jsErrors.push(`${label} ${page.url()}: ${e.message}`));
      for (const route of pages) {
        const res = await page.goto(base + route);
        check(`${label} ${route} renders`, res.status() === 200, `HTTP ${res.status()}`);
        await page.evaluate(() => document.fonts.ready);
        check(`${label} ${route} has no sideways page scroll`,
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

        if (route.startsWith('/dashboard/leads')) {
          if (width <= 900) {
            /* Stacked: the conversation gets a long, uncapped run of the page. */
            const tall = await page.locator('#leadThread').evaluate(
              (t) => t.getBoundingClientRect().height >= Math.min(window.innerHeight * 0.55, 460));
            check(`${label} stacked thread is long, not compressed`, tall);
          } else {
            const pane = page.locator('.lead-detail').first();
            await pane.scrollIntoViewIfNeeded();
            const m = await pane.evaluate((p) => {
              const t = p.querySelector('.lead-thread');
              return {
                clipped: p.scrollHeight - p.clientHeight,
                chat: t ? t.clientHeight : 0,
                height: p.getBoundingClientRect().height,
                innerHeight: window.innerHeight,
              };
            });
            /* The whole point: the pane is exactly as tall as its content, so
               the chat is never the thing that gets squeezed to make room. */
            check(`${label} the pane needs no scrollbar of its own`, m.clipped <= 1, `${m.clipped}px clipped`);
            check(`${label} the chat keeps real height`, m.chat >= 200, `${m.chat}px`);
            if (m.innerHeight >= m.height + 84) {
              check(`${label} the whole pane fits the window`, await pane.evaluate((p) => {
                const r = p.getBoundingClientRect();
                return r.top >= 0 && r.bottom <= window.innerHeight + 1;
              }));
            }
            /* Reachable without a second scrollbar: bring the pane's foot to
               the fold, and Send and the housekeeping line must be on screen. */
            await pane.evaluate((p) => window.scrollTo(0, Math.max(0,
              window.scrollY + p.getBoundingClientRect().bottom - window.innerHeight)));
            const foot = await pane.evaluate((p) => {
              const send = p.querySelector('.lead-reply-form button[type="submit"]');
              const bar = p.querySelector('.lead-detail-bar');
              const bottom = (el) => (el ? el.getBoundingClientRect().bottom : null);
              return { send: bottom(send), bar: bottom(bar), innerHeight: window.innerHeight };
            });
            check(`${label} Send is on screen with the chat`, foot.send !== null && foot.send <= foot.innerHeight + 1,
              `${Math.round(foot.send)} > ${foot.innerHeight}`);
            check(`${label} status/archive/delete are on screen`, foot.bar === null || foot.bar <= foot.innerHeight + 1,
              `${Math.round(foot.bar)} > ${foot.innerHeight}`);
          }
        } else {
          check(`${label} the article column fits`, await page.evaluate(() => {
            const w = document.querySelector('.blog-prose-wrap, .blog-grid');
            return !!w && w.getBoundingClientRect().right <= innerWidth + 1;
          }));
          check(`${label} wide code and tables scroll inside themselves`, await page.evaluate(() => {
            const wide = Array.from(document.querySelectorAll('.blog-body pre, .blog-body .table-wrap'));
            return wide.every((el) => el.scrollWidth <= el.clientWidth + 1
              || getComputedStyle(el).overflowX === 'auto');
          }));
        }
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
  console.log(`\nLeads + blog fit: ${passed} checks ${label}`);
});
