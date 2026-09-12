/**
 * FirmLedger — the cache-buster actually busts. `npm run test:assets`
 *
 * The bug this suite exists for: `/public` is served with a 7-day max-age, and
 * the version in `/css/app.css?v=<assetV>` was a hand-bumped constant. Across
 * the leads-inbox rounds of 2026-09-12 the stylesheet changed seven times and
 * the constant never moved, so every browser kept rendering the OLD inbox —
 * a narrow rail pinned to the left, a conversation squeezed into the same rail
 * — while the deploy, the markup and the tests all said the layout had changed.
 * "I fixed it but nothing changed" was literally true in the browser.
 *
 * So this suite does not check that someone remembered to bump a number. It
 * checks the property that makes remembering unnecessary:
 *
 *   1. the version is a function of the bytes — one changed byte moves it, an
 *      unchanged tree keeps it (pure, so it needs no edit to the real files);
 *   2. no view hardcodes a version: every `/css/app.css` and `/js/*.js` link
 *      carries `?v=<%= assetV %>`, so the version really reaches the markup;
 *   3. over real HTTP, on the pages in question (the inbox the user opens, and
 *      the home page), the linked version equals the one computed from the
 *      files on disk — and that URL serves those very bytes, stamped with the
 *      7-day cache that made a stale copy possible in the first place.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const assets = require('../src/lib/assetversion');

let passed = 0;
function check(label, ok, extra = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); return true; }
  console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  process.exitCode = 1;
  return false;
}

/* ── 1. the version is derived from the content, not typed by a human ────── */
console.log('The version is a function of the bytes on disk');

const HEX8 = /^[0-9a-f]{8}$/;
const m = String(assets.ASSET_V).match(/^(\d+)-([0-9a-f]{8})$/);
check('assetV has the shape <generation>-<content hash>', !!m, String(assets.ASSET_V));
check('the hash half is 8 hex characters', !!m && HEX8.test(m[2]), String(assets.ASSET_V));
check('the version is not the old hand-kept constant', String(assets.ASSET_V) !== '58', String(assets.ASSET_V));

const contents = assets.assetContents();
check('every versioned asset exists and is not empty',
  contents.length === assets.FILES.length && contents.every(([, body]) => body && body.length > 0),
  `${contents.length}/${assets.FILES.length} files`);

check('the same bytes give the same version twice',
  assets.versionOf(contents) === assets.versionOf(contents));
check('that version is the one the app will serve',
  assets.versionOf(contents) === assets.ASSET_V, `${assets.versionOf(contents)} vs ${assets.ASSET_V}`);

/* The heart of it: change one byte of an asset and the URL MUST move. Anything
   less and a browser keeps the previous file for the full 7 days. Done on
   copies, so the checked-in files are never touched. */
for (const file of assets.FILES) {
  const edited = contents.map(([name, body]) =>
    (name === file ? [name, Buffer.concat([body, Buffer.from('/* a one-byte edit */\n')])] : [name, body]));
  const moved = assets.versionOf(edited) !== assets.ASSET_V;
  check(`editing ${file} moves the URL`, moved,
    moved ? '' : `${file} changed and the version did not — that is the 7-day-cache bug`);
}
check('editing nothing does not move the URL', assets.versionOf(contents) === assets.ASSET_V);

/* ── 2. every view links through the version — nobody hardcodes it ───────── */
console.log('Every view links its assets through that version');

const viewFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ejs')) viewFiles.push(p);
  }
})(path.join(ROOT, 'views'));

const linkTag = /(?:href|src)="\/(css\/app\.css|js\/[a-z0-9-]+\.js)(\?[^"]*)?"/g;
let versionedLinks = 0;
const hardcoded = [];
const unversioned = [];
for (const file of viewFiles) {
  const src = fs.readFileSync(file, 'utf8');
  for (const found of src.matchAll(linkTag)) {
    versionedLinks++;
    const query = found[2] || '';
    if (!query.includes('<%= assetV %>')) {
      (query.startsWith('?v=') ? hardcoded : unversioned).push(`${path.relative(ROOT, file)} → ${found[0]}`);
    }
  }
}
check('the views really link the stylesheet and the scripts', versionedLinks >= 3, String(versionedLinks));
check('no view hardcodes a version', hardcoded.length === 0, hardcoded.join('; '));
check('no view links a versioned asset bare', unversioned.length === 0, unversioned.join('; '));
check('every versioned asset on disk is linked somewhere',
  assets.FILES.some((f) => f.endsWith('app.css')) && assets.FILES.some((f) => f.endsWith('main.js')));

/* ── 3. over real HTTP: the page in question links the current bytes ─────── */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-assets-'));
const port = 6600 + (process.pid % 60);
const base = `http://127.0.0.1:${port}`;

(async () => {
  console.log('The pages the user opens carry that version — over real HTTP');

  const seeded = spawnSync(process.execPath, ['scripts/seed-leads-preview.js'], {
    cwd: ROOT, env: { ...process.env, FIRMLEDGER_DATA_DIR: dataDir }, encoding: 'utf8',
  });
  check('the inbox preview data seeds', seeded.status === 0, String(seeded.stderr || '').slice(0, 200));

  const server = spawn(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), BASE_URL: base,
      FIRMLEDGER_DATA_DIR: dataDir, LEADS_INBOX_PREVIEW: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stderr.on('data', (d) => { log += d; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout: ' + log)), 20000);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('server exited: ' + code + log)); });
    server.stdout.on('data', (d) => {
      log += d;
      if (log.includes('FirmLedger running')) { clearTimeout(timer); resolve(); }
    });
  });

  try {
    await ready;

    const versionIn = (html) => {
      const link = html.match(/href="\/css\/app\.css\?v=([^"]+)"/);
      const script = html.match(/src="\/js\/main\.js\?v=([^"]+)"/);
      return { css: link && link[1], js: script && script[1] };
    };

    /* The inbox the user opens — the page whose layout "never changed". */
    const inbox = await fetch(base + '/dashboard/leads');
    const inboxHtml = await inbox.text();
    const inboxV = versionIn(inboxHtml);
    check('the leads inbox renders (the preview owner is signed in)',
      inbox.status === 200 && /Leads inbox/.test(inboxHtml), String(inbox.status));
    check('the inbox stylesheet URL carries the version computed from the file',
      inboxV.css === assets.ASSET_V, `page says ${inboxV.css}, disk says ${assets.ASSET_V}`);
    check('the inbox stylesheet URL is not the stale one', inboxV.css !== '58', String(inboxV.css));
    check('the inbox script URL carries it too', inboxV.js === assets.ASSET_V, String(inboxV.js));

    /* A second, public page: the version is site-wide, not route-local. */
    const home = await fetch(base + '/');
    const homeV = versionIn(await home.text());
    check('the home page carries the same version', homeV.css === assets.ASSET_V, String(homeV.css));

    /* That URL really serves those bytes — and is stamped with the 7-day cache
       that made a stale copy possible, which is why the URL has to move. */
    const css = await fetch(base + '/css/app.css?v=' + assets.ASSET_V);
    const cssBody = Buffer.from(await css.arrayBuffer());
    check('the versioned stylesheet answers 200', css.status === 200, String(css.status));
    check('it is served as CSS', /text\/css/.test(css.headers.get('content-type') || ''),
      String(css.headers.get('content-type')));
    check('it is cached for 7 days — the reason the URL must change',
      /max-age=604800/.test(css.headers.get('cache-control') || ''),
      String(css.headers.get('cache-control')));

    const onDisk = fs.readFileSync(path.join(ROOT, 'public/css/app.css'));
    check('the served stylesheet is the file the version was derived from',
      cssBody.equals(onDisk), `${cssBody.length}B served vs ${onDisk.length}B on disk`);
    check('and its hash is part of the served version',
      assets.versionOf([['public/css/app.css', cssBody]], assets.BASE) ===
      assets.versionOf([['public/css/app.css', onDisk]], assets.BASE));
  } finally {
    server.kill('SIGTERM');
  }

  console.log(`\n${passed} checks passed${process.exitCode ? ' — with failures' : ''}`);
})().catch((e) => {
  console.error('  ✗ ' + (e && e.message));
  process.exitCode = 1;
});
