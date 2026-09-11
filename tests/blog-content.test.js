/**
 * Blog content — leads guide accuracy, stale-content refresh, new 2026 guide.
 * node tests/blog-content.test.js
 *
 * Verifies over real HTTP + the seed module itself:
 *   1. The leads guide no longer claims guests can inquire — inquiries are a
 *      signed-in member feature — and documents the one-email-per-conversation
 *      rule plus permanent delete.
 *   2. The new "Where to List Your Startup in 2026" post is published, covers
 *      Google Business, Crunchbase, Product Hunt and FirmLedger (canonical
 *      record + confidence scoring), and links the claim page and directory
 *      with descriptive anchor text.
 *   3. Already-seeded databases get the corrected leads post on next boot
 *      (stale-marker refresh) while admin-reworded copies stay untouched.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-blog-'));
process.env.FIRMLEDGER_DATA_DIR = dataDir;
const { db } = require('../src/db');

const port = 5300 + process.pid % 400;
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
const get = (p) => fetch(base + p).then((r) => ({ status: r.status, text: () => r.text() }));

(async () => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + log)), 20000);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Server exited: ' + code + log)); });
    server.stdout.on('data', (d) => {
      log += d;
      if (log.includes('FirmLedger running')) { clearTimeout(timer); resolve(); }
    });
  });

  console.log('Blog content — leads guide matches the shipped product');
  const leadsPost = db.prepare("SELECT * FROM blog_posts WHERE slug='turning-your-listing-into-leads'").get();
  check('leads guide is published', leadsPost && leadsPost.status === 'published');
  check('no guest-inquiry claim remains', !leadsPost.body.includes('guests can inquire'));
  check('says inquiries need a signed-in member account', /signed-in FirmLedger member/i.test(leadsPost.body));
  check('documents one email per conversation', /one email per conversation/.test(leadsPost.body));
  check('documents permanent delete', /permanent delete/.test(leadsPost.body));
  const leadsPage = await (await get('/blog/turning-your-listing-into-leads')).text();
  check('leads guide page renders the corrected copy', leadsPage.includes('signed-in FirmLedger member') && !leadsPage.includes('guests can inquire'));

  console.log('Blog content — new 2026 listing guide');
  const guide = db.prepare("SELECT * FROM blog_posts WHERE slug='where-to-list-your-startup-in-2026'").get();
  check('2026 guide is published', guide && guide.status === 'published');
  for (const topic of ['Google Business Profile', 'Crunchbase', 'Product Hunt', 'G2', 'FirmLedger']) {
    check(`2026 guide covers ${topic}`, guide.body.includes(topic));
  }
  check('2026 guide explains canonical record + confidence score', /canonical profile per company/.test(guide.body) && /confidence score/.test(guide.body));
  check('directory link uses descriptive anchor', /<a href="\/directory">explore the business intelligence data<\/a>/.test(guide.body));
  check('claim link uses descriptive anchor', /<a href="\/claim">claim your verified business profile<\/a>/.test(guide.body));
  check('no salesy superlatives', !/(#1|number one|best platform ever|guarantee)/i.test(guide.body));

  const blogIndex = await (await get('/blog')).text();
  check('blog index lists the 2026 guide', blogIndex.includes('Where to List Your Startup in 2026'));
  const guidePage = await (await get('/blog/where-to-list-your-startup-in-2026')).text();
  check('2026 guide page renders', guidePage.includes('Where to List Your Startup in 2026') && guidePage.includes('Crunchbase'));

  console.log('Blog content — stale seeds refresh on boot, admin edits survive');
  const { seedBlog } = require('../src/lib/blogseed');
  /* Simulate an old deployment still holding the pre-fix leads body. */
  db.prepare("UPDATE blog_posts SET body = 'OLD SEED. No account required — guests can inquire as easily as members — old body.' WHERE slug='turning-your-listing-into-leads'").run();
  seedBlog(db);
  const refreshed = db.prepare("SELECT body FROM blog_posts WHERE slug='turning-your-listing-into-leads'").get();
  check('stale seed body is rewritten on boot', !refreshed.body.includes('guests can inquire') && refreshed.body.includes('signed-in FirmLedger member'));

  /* The trust-record post's stale IndexNow timing refreshes the same way. */
  db.prepare("UPDATE blog_posts SET body = 'OLD seed copy — pushed to search engines via IndexNow within about ten hours.' WHERE slug='how-firmledger-builds-a-trustworthy-record'").run();
  seedBlog(db);
  const record = db.prepare("SELECT body FROM blog_posts WHERE slug='how-firmledger-builds-a-trustworthy-record'").get();
  check('stale IndexNow timing is refreshed on boot', !record.body.includes('within about ten hours') && record.body.includes('re-ping thirty minutes later'));

  /* An admin-reworded copy (marker gone) must NOT be clobbered. */
  db.prepare("UPDATE blog_posts SET body='Edited by a human editor — custom copy about leads.' WHERE slug='turning-your-listing-into-leads'").run();
  seedBlog(db);
  const edited = db.prepare("SELECT body FROM blog_posts WHERE slug='turning-your-listing-into-leads'").get();
  check('admin-reworded post is left alone', edited.body === 'Edited by a human editor — custom copy about leads.');

  console.log(`\nBlog content: ${passed} checks${process.exitCode ? ' (FAILURES)' : ' all checks passed'}`);
  server.kill();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FATAL', e, log.slice(-1500)); server.kill(); process.exit(1); });
