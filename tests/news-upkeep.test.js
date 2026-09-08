/**
 * FirmLedger — listing news + automated upkeep test.
 *
 *   node tests/news-upkeep.test.js
 *
 * Offline throughout (helpers/fetch-stub.js answers both the company
 * homepages and the news-search feed):
 *
 *   A. Library level — RSS parsing, the accuracy gate (a story only survives
 *      when it carries the company's full name or sits on its domain),
 *      detection, member submission → pending, moderation, hand-written
 *      stories, the background sweep and the upkeep schedule.
 *
 *   B. HTTP level — the real server with an admin and a member session: the
 *      news queue page, a member submitting a story (invisible until approved),
 *      the console approving/adding/rejecting it, a detection sweep, the
 *      profile panel, CSRF, and the upkeep settings.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'helpers', 'fetch-stub.js');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => decodeURIComponent(String(s || '').replace(/\+/g, ' '));

/* Part A needs the stubbed fetch; part B talks to a real server. */
const realFetch = globalThis.fetch.bind(globalThis);

/* ===================================================================== */
/* A. Library level                                                       */
/* ===================================================================== */
const dataDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-news-'));
process.env.FIRMLEDGER_DATA_DIR = dataDirA;
process.env.BASE_URL = 'https://firmledger.test';

require(STUB);
const stub = require(STUB);
const { db, setSetting } = require(path.join(ROOT, 'src/db.js'));
const news = require(path.join(ROOT, 'src/lib/news.js'));
const upkeep = require(path.join(ROOT, 'src/lib/upkeep.js'));
const techrefresh = require(path.join(ROOT, 'src/lib/techrefresh.js'));

/* ---------------------------------------------------------------------------
 * The news feature is documented in the blog — the same way the API is. The
 * announcement post ships in the seed so every install gets it, and the copy has
 * to state the promises the code actually keeps: the accuracy gate, the
 * moderation queue for member submissions, and the "no summary, no link, no
 * story" rule.
 * ------------------------------------------------------------------------- */
const NEWS_POST_SLUG = 'news-on-firmledger-what-a-profile-is-allowed-to-say-about-the-news';
const newsPost = db.prepare('SELECT slug, status, body, excerpt FROM blog_posts WHERE slug=?').get(NEWS_POST_SLUG);
check('the news announcement post is seeded', Boolean(newsPost));
check('the news announcement post is published', Boolean(newsPost) && newsPost.status === 'published');
check('the news post explains the accuracy gate', /full name/i.test(newsPost?.body || '') && /own domain/i.test(newsPost?.body || ''));
check('the news post explains that member submissions wait for a human', /pending/i.test(newsPost?.body || '') && /moderat/i.test(newsPost?.body || ''));
check('the news post states that stories need a citable link', /link/i.test(newsPost?.body || ''));
check('the news post explains the scheduled upkeep', /hourly/i.test(newsPost?.body || ''));
check('the news post carries an excerpt for the /blog card', Boolean(newsPost && String(newsPost.excerpt || '').length > 40));

const mkListing = (slug, name, site, status = 'approved') => Number(db.prepare(
  `INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,status,confidence)
   VALUES (?,?,?,?,'company','Fintech',?,?,'Kenya',?,70)`
).run(slug, name, `${name} tagline`, `${name} is a seeded company for the news and upkeep test suite.`, site, `hi@${slug}.example`, status).lastInsertRowid);

const safariId = mkListing('safari-fintech', 'Safari Fintech', 'https://safari-fintech.example');
const temboId = mkListing('tembo-logistics', 'Tembo Logistics', 'https://tembo-logistics.example');
const pendingId = mkListing('pesa-bridge', 'Pesa Bridge', 'https://pesa-bridge.example', 'pending');
const memberId = Number(db.prepare(
  "INSERT INTO users (email,password_hash,name) VALUES ('member@example.com','x','Member One')"
).run().lastInsertRowid);

const row = (l) => db.prepare('SELECT * FROM listings WHERE id=?').get(l);
const story = (id) => db.prepare('SELECT * FROM listing_news WHERE id=?').get(id);
const stories = (l) => db.prepare('SELECT * FROM listing_news WHERE listing_id=? ORDER BY id').all(l);

(async function partA() {
  console.log('A. Library level\n');

  /* ---- RSS parsing ---- */
  const feed = stub.newsFeed('"Safari Fintech"');
  const items = news.parseRss(feed);
  check('the feed parses into items', items.length === 4, `parsed ${items.length}`);
  check('every item carries a usable link', items.every((i) => /^https:\/\//.test(i.url)));
  check('publication dates are normalised', items[0].published_at === '2026-08-03', items[0].published_at);
  check('the publication is read from the feed', items[0].source === 'Business Daily', items[0].source);
  check('encoded google-news html is stripped from the summary',
    /closed a Sh200m/.test(items[0].summary || '') && !/<a href/i.test(items[0].summary || '')
    && !/news\.google\.com/.test(items[0].summary || '') && !/CBMitgFBVV95cUx/.test(items[0].summary || ''),
    items[0].summary);

  const googleXml = `<?xml version="1.0"?><rss version="2.0"><channel>
    <item>
      <title>Safari Fintech raises Sh200m - Business Daily</title>
      <link>https://news.google.com/rss/articles/CBMitgFBVV95cUxORWwyb2VYS01UaXdLZWdVWl9ZTGx4TmZaNWpxRjMxSTYzUDVEbjV5Y2huY3k2bGVNV3lUMUJpVDZtZU9NMHdLV0VKZzRkR1pxU</link>
      <pubDate>Mon, 03 Aug 2026 06:00:00 GMT</pubDate>
      <source url="https://www.businessdailyafrica.com">Business Daily</source>
      <description>&lt;a href="https://news.google.com/rss/articles/CBMitgFBVV95cUxORWwyb2VYS01UaXdLZWdVWl9ZTGx4TmZaNWpxRjMxSTYzUDVEbjV5Y2huY3k2bGVNV3lUMUJpVDZtZU9NMHdLV0VKZzRkR1pxU" target="_blank"&gt;Safari Fintech raises Sh200m&lt;/a&gt;&nbsp;&nbsp;&lt;font color="#6f6f6f"&gt;Business Daily&lt;/font&gt;</description>
    </item>
    <item>
      <title>Coast expansion confirmed - Nation</title>
      <link>https://news.google.com/rss/articles/CBMiotherlongid</link>
      <pubDate>Tue, 04 Aug 2026 06:00:00 GMT</pubDate>
      <source url="https://nation.africa">Nation</source>
      <description><![CDATA[<a href="https://news.google.com/rss/articles/CBMiotherlongid">Safari Fintech has closed a Sh200m round led by regional investors.</a>&nbsp;&nbsp;<font color="#6f6f6f">Nation</font>]]></description>
    </item>
  </channel></rss>`;
  const gItems = news.parseRss(googleXml);
  check('a google-news feed still parses', gItems.length === 2, `parsed ${gItems.length}`);
  check('the headline is kept, not the wrapper markup',
    /Safari Fintech raises Sh200m/.test(gItems[0].title) && !/<a href/i.test(gItems[0].title),
    gItems[0].title);
  check('a description that is only the headline+publisher is dropped', !gItems[0].summary, gItems[0].summary);
  check('cdata html keeps the real sentence and drops the wrapper url',
    /closed a Sh200m/.test(gItems[1].summary || '') && !/news\.google\.com/.test(gItems[1].summary || '')
    && !/<a href/i.test(gItems[1].summary || ''),
    gItems[1].summary);
  check('cleanSummary never returns raw href markup',
    !/<a href/i.test(news.cleanSummary('&lt;a href="https://news.google.com/rss/articles/CBMitgFBVV95cUx"&gt;Hello&lt;/a&gt;'))
    && !/news\.google\.com/.test(news.cleanSummary('<a href="https://news.google.com/rss/articles/CBMitgFBVV95cUx">Hello</a>')));

  /* ---- the accuracy gate ---- */
  const safari = row(safariId);
  const matched = items.map((i) => news.matchItem(safari, i));
  check('a headline carrying the full company name matches', matched[0] && matched[0].match === 'name');
  check('a story on the company domain matches even without the name', matched[1] && matched[1].match === 'domain');
  check('a partial name ("Safari" for "Safari Fintech") is rejected', matched[2] === null);
  check('an unrelated story is rejected', matched[3] === null);
  check('the gate is scoped to the company — another listing does not inherit the match',
    news.matchItem(row(temboId), items[0]) === null);
  check('legal suffixes are ignored when matching names',
    news.coreName('Safari Fintech Limited') === news.coreName('Safari Fintech Ltd'));
  /* Google News wraps the real link — the publisher URL still counts. */
  check('a wrapped link still matches on the publisher domain',
    (news.matchItem(safari, {
      title: 'Quarterly results', url: 'https://news.google.com/rss/articles/abc',
      source_url: 'https://safari-fintech.example/news/q3', summary: '',
    }) || {}).match === 'domain');

  /* ---- detection ---- */
  const run1 = await news.fetchFor(safari);
  check('detection scans the feed', run1.ok && run1.scanned === 4, JSON.stringify(run1));
  check('only the stories about the company are kept', run1.matched === 2 && run1.added === 2, JSON.stringify(run1));
  check('the listing is stamped as checked', row(safariId).news_checked_at === new Date().toISOString().slice(0, 10));
  check('detected stories publish immediately', stories(safariId).every((n) => n.status === 'approved'));
  check('they are visible on the public profile', news.approvedFor(safariId).length === 2);
  check('detected summaries never carry google-news wrapper urls',
    news.approvedFor(safariId).every((n) => !/news\.google\.com/.test(n.summary || '') && !/<a href/i.test(n.summary || '')));

  const junkId = Number(db.prepare(
    `INSERT INTO listing_news (listing_id, title, url, source, published_at, summary, origin, status, match)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    temboId, 'Stored junk headline', 'https://newsroom.example/tembo/x', 'Daily', '2026-08-01',
    '<a href="https://news.google.com/rss/articles/CBMitgFBVV95cUxORWwyb2VYS01UaXdLZWdVWl9ZTGx4TmZaNWpxRjMxSTYzUDVEbjV5Y2huY3k2bGVNV3lUMUJpVDZtZU9NMHdLV0VKZzRkR1pxU">Stored junk headline</a>',
    'auto', 'approved', 'name',
  ).lastInsertRowid);
  const shownJunk = news.approvedFor(temboId).find((n) => n.id === junkId);
  check('already-stored html summaries are cleaned when read for a profile',
    Boolean(shownJunk) && !shownJunk.summary && !/news\.google\.com/.test(JSON.stringify(shownJunk)),
    shownJunk && shownJunk.summary);
  db.prepare('DELETE FROM listing_news WHERE id=?').run(junkId);

  const run2 = await news.fetchFor(row(safariId));
  check('a second sweep adds nothing — stories are never duplicated',
    run2.ok && run2.added === 0 && stories(safariId).length === 2, JSON.stringify(run2));

  setSetting('news_review_auto', '1');
  check('detected stories can be held for review', news.autoStatus() === 'pending');
  const run3 = await news.fetchFor(row(temboId));
  check('held stories wait in pending, not on the profile',
    run3.added === 2 && stories(temboId).every((n) => n.status === 'pending')
    && news.approvedFor(temboId).length === 0, JSON.stringify(run3));
  setSetting('news_review_auto', '0');

  /* ---- member submission ---- */
  const member = db.prepare('SELECT * FROM users WHERE id=?').get(memberId);
  const sub = news.submit({
    listing: safari, user: member, title: 'Safari Fintech opens a Mombasa office',
    url: 'https://newsroom.example/safari/mombasa', source: 'Coast Weekly',
    published_at: '2026-07-14', summary: 'A second branch on the coast.', note: 'I work there.',
  });
  check('a member can submit a story', sub.ok && sub.pending === true, JSON.stringify(sub));
  check('the submission waits for moderation', story(sub.id).status === 'pending');
  check('it is marked as a member submission', story(sub.id).origin === 'user' && story(sub.id).submitted_by === memberId);
  check('it is not on the public profile yet',
    !news.approvedFor(safariId).some((n) => n.id === sub.id));
  check('it lands in the moderation queue', news.pendingQueue().some((n) => n.id === sub.id));

  const dupe = news.submit({
    listing: safari, user: member, title: 'Safari Fintech opens a Mombasa office',
    url: 'https://newsroom.example/safari/mombasa',
  });
  check('the same story cannot be submitted twice', dupe.ok === false, JSON.stringify(dupe));
  const bad = news.submit({ listing: safari, user: member, title: '  ', url: '' });
  check('an empty headline is refused', bad.ok === false);

  /* ---- moderation ---- */
  const notifsBefore = db.prepare('SELECT COUNT(*) c FROM notifications').get().c;
  news.approve(sub.id, 'admin');
  check('approving publishes the story', story(sub.id).status === 'approved');
  check('it now appears on the profile', news.approvedFor(safariId).some((n) => n.id === sub.id));
  check('the submitter is told', db.prepare('SELECT COUNT(*) c FROM notifications').get().c > notifsBefore);
  check('the approval is recorded', story(sub.id).reviewed_by === 'admin' && Boolean(story(sub.id).reviewed_at));

  const sub2 = news.submit({
    listing: safari, user: member, title: 'Safari Fintech rumoured to be raising again',
    url: 'https://rumour.example/safari', source: 'Rumour Mill',
  });
  news.reject(sub2.id, 'admin');
  check('rejecting keeps the story off the profile', story(sub2.id).status === 'rejected');
  check('a rejected story never shows publicly', !news.approvedFor(safariId).some((n) => n.id === sub2.id));

  /* ---- written by hand ---- */
  const manual = news.addManual({
    listing: row(temboId), title: 'Tembo Logistics fleet doubles', url: 'https://tembo-logistics.example/news/fleet',
    source: 'Tembo Newsroom', published_at: '2026-06-01',
  });
  check('a story written in the console publishes at once',
    manual.ok && story(manual.id).status === 'approved' && story(manual.id).origin === 'admin', JSON.stringify(manual));
  check('it shows on that profile', news.approvedFor(temboId).some((n) => n.id === manual.id));

  /* ---- the cap ---- */
  const capped = news.trimListing(safariId, 1);
  check('the freshest stories survive the per-listing cap', capped > 0 && news.approvedFor(safariId).length === 1);

  /* ---- background sweep ---- */
  const sweep = news.start([safariId, temboId], 'selected');
  check('a sweep starts', sweep.ok === true && sweep.job.total === 2);
  check('two sweeps never overlap', news.start([safariId], 'selected').ok === false);
  check('the sweep reports progress', news.jobState().running === true);
  for (let i = 0; i < 200 && news.jobState().running; i++) await sleep(50);
  const done = news.jobState();
  check('the sweep finishes', done.running === false && done.status === 'done', `status=${done.status}`);
  check('every queued listing was checked', done.done === 2, JSON.stringify(done));
  check('the run summary is kept for the console',
    news.lastRun() && news.lastRun().attempted === 2 && news.lastRun().scope === 'selected');

  /* ---- scheduled upkeep ---- */
  const defaults = upkeep.settings();
  check('upkeep ships on with sane hourly caps',
    defaults.on === true && defaults.tech_on === true && defaults.news_on === true
    && defaults.tech_limit === 25 && defaults.news_limit === 20, JSON.stringify(defaults));

  setSetting('upkeep_on', '0');
  const off = await upkeep.runSweep();
  check('a disabled schedule does nothing', off.ok === false && off.skipped === 'disabled', JSON.stringify(off));

  setSetting('upkeep_on', '1');
  setSetting('upkeep_tech_limit', '3');
  setSetting('upkeep_news_limit', '2');
  /* Make both queues due: stale tech snapshots and unchecked news. */
  db.prepare("UPDATE listings SET tech_checked_at='2020-01-01', news_checked_at='' WHERE 1=1").run();
  const forced = await upkeep.runSweep();
  check('the sweep queues technology work', forced.ok && forced.tech.queued === 3, JSON.stringify(forced.tech));
  check('the sweep queues news work', forced.ok && forced.news.queued === 2, JSON.stringify(forced.news));
  check('the sweep hands the work to the background runners',
    techrefresh.jobState().running === true || news.jobState().running === true);
  const idle = await upkeep.waitForIdle({ timeoutMs: 60000 });
  check('both runners go quiet again', idle === true);
  check('the upkeep run is recorded', upkeep.lastRun() && upkeep.lastRun().tech.queued === 3);

  const saved = upkeep.save({
    upkeep_on: '1', upkeep_tech_on: '1', upkeep_news_on: '0',
    upkeep_tech_limit: '9999', upkeep_news_limit: '5', upkeep_news_max_age_days: '14',
  });
  check('settings are clamped, not trusted', saved.tech_limit === 500 && saved.news_max_age_days === 14, JSON.stringify(saved));
  check('a job can be switched off', saved.news_on === false);
  const dryRun = await upkeep.runSweep();
  check('switched-off jobs queue nothing', dryRun.news === null, JSON.stringify(dryRun.news));
  upkeep.save({ upkeep_on: '1', upkeep_tech_on: '1', upkeep_news_on: '1', upkeep_tech_limit: '25', upkeep_news_limit: '20', upkeep_news_max_age_days: '7' });

  console.log('');
})()
/* ===================================================================== */
/* B. HTTP level                                                          */
/* ===================================================================== */
  .then(async function partB() {
    console.log('B. HTTP level\n');

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-news-http-'));
    const PORT = 4600 + (process.pid % 300);
    const BASE = `http://127.0.0.1:${PORT}`;
    const adminToken = 'news-admin-' + crypto.randomBytes(12).toString('hex');
    const adminCsrf = crypto.randomBytes(12).toString('hex');
    const userToken = 'news-user-' + crypto.randomBytes(12).toString('hex');
    const userCsrf = crypto.randomBytes(12).toString('hex');

    const seed = `
process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(dataDir)};
const { db } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
const run = (sql, ...p) => db.prepare(sql).run(...p);
const ins = db.prepare("INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,status,confidence) VALUES (?,?,?,?,'company','Fintech',?,?,'Kenya','approved',70)");
const a = Number(ins.run('http-safari','Safari Fintech','Tagline','A seeded company for the news HTTP test.','https://safari-fintech.example','hi@safari.example').lastInsertRowid);
const b = Number(ins.run('http-tembo','Tembo Logistics','Tagline','A seeded company for the news HTTP test.','https://tembo-logistics.example','hi@tembo.example').lastInsertRowid);
const u = Number(run("INSERT INTO users (email,password_hash,name) VALUES ('member@example.com','x','Member One')").lastInsertRowid);
run("INSERT INTO sessions (token,user_id,csrf,kind,expires_at) VALUES (?,NULL,?,'admin',datetime('now','+7 days'))", ${JSON.stringify(adminToken)}, ${JSON.stringify(adminCsrf)});
run("INSERT INTO sessions (token,user_id,csrf,kind,expires_at) VALUES (?,?,?,'user',datetime('now','+7 days'))", ${JSON.stringify(userToken)}, u, ${JSON.stringify(userCsrf)});
console.log(JSON.stringify({ a, b, u }));
`;
    const seeded = execFileSync(process.execPath, ['-e', seed], { cwd: ROOT, encoding: 'utf8' });
    const ids = JSON.parse(String(seeded).trim().split('\n').pop());

    const env = {
      ...process.env,
      FIRMLEDGER_DATA_DIR: dataDir,
      PORT: String(PORT),
      BASE_URL: BASE,
      ADMIN_SECRET: 'news-test-secret',
      SMTP_URL: 'smtp://user:pass@smtp.example.test:587',
      FETCH_STUB_DELAY_MS: '50',
    };
    const server = spawn(process.execPath, ['-r', STUB, 'server.js'], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    server.stdout.on('data', (d) => { serverLog += d; });
    server.stderr.on('data', (d) => { serverLog += d; });

    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      try { const r = await realFetch(`${BASE}/healthz`).catch(() => null); if (r) up = true; } catch { /* wait */ }
      if (!up) await sleep(250);
    }
    if (!up) {
      check('server boots', false, serverLog.slice(-800));
      server.kill('SIGKILL');
      return finish(dataDir, serverLog);
    }

    const admin = { cookie: `fl_admin=${adminToken}` };
    const member = { cookie: `fl_session=${userToken}` };
    const form = (cookie, fields) => ({
      method: 'POST', redirect: 'manual',
      headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

    /* ---- the console queue ---- */
    const queue = await realFetch(`${BASE}/admin3119Musa/news`, { headers: admin });
    const queueHtml = await queue.text();
    check('the news page renders', queue.status === 200 && !/<h1>Server error/i.test(queueHtml), `HTTP ${queue.status}`);
    check('it offers detection runs', /name="scope" value="due"/.test(queueHtml) && /name="scope" value="all"/.test(queueHtml));
    check('it explains the accuracy gate', /only what is genuinely about them/.test(queueHtml));
    check('it can hold detected stories for review', /news_review_auto/.test(queueHtml));
    check('it can add a story by hand', /admin3119Musa\/news\/add/.test(queueHtml));
    check('the nav carries the news tab', /admin3119Musa\/news/.test(queueHtml));

    /* ---- a member submits ---- */
    const guestForm = await realFetch(`${BASE}/listing/http-safari/news`, { redirect: 'manual' });
    check('guests are sent to sign in before submitting',
      guestForm.status === 302 && /\/login/.test(guestForm.headers.get('location') || ''),
      `${guestForm.status} ${guestForm.headers.get('location')}`);
    const guestPost = await realFetch(`${BASE}/listing/http-safari/news`, form({}, { title: 'Sneaky', url: 'https://x.example/a' }));
    check('a guest cannot post a story', guestPost.status === 302 && /\/login/.test(guestPost.headers.get('location') || ''));

    const memberPage = await realFetch(`${BASE}/listing/http-safari/news`, { headers: member });
    check('a signed-in member gets the submit form', memberPage.status === 200 && /Submit news about/.test(await memberPage.text()));

    const post = await realFetch(`${BASE}/listing/http-safari/news`, form(member, {
      _csrf: userCsrf, title: 'Safari Fintech opens a Mombasa office',
      url: 'https://newsroom.example/safari/mombasa', source: 'Coast Weekly',
      published_at: '2026-07-14', summary: 'A second branch on the coast.',
    }));
    const postLoc = decode(post.headers.get('location') || '');
    check('the submission is accepted', post.status === 302 && /ok=Thank you/.test(postLoc),
      postLoc || `HTTP ${post.status}`);

    const profileBefore = await (await realFetch(`${BASE}/listing/http-safari`)).text();
    check('a pending story is NOT on the public profile', !/Mombasa office/.test(profileBefore));
    check('the profile offers a way to submit news', /listing\/http-safari\/news/.test(profileBefore));

    const queuedHtml = await (await realFetch(`${BASE}/admin3119Musa/news?status=pending`, { headers: admin })).text();
    check('the story is waiting in the moderation queue', /Mombasa office/.test(queuedHtml));
    check('it is labelled as a member submission', /member/.test(queuedHtml));

    /* ---- CSRF ---- */
    const noCsrf = await realFetch(`${BASE}/listing/http-safari/news`, form(member, { title: 'No token', url: 'https://x.example/b' }));
    check('a submission without CSRF is refused', noCsrf.status === 403, `HTTP ${noCsrf.status}`);

    /* ---- moderation from the console ---- */
    const ro = () => new (require('better-sqlite3'))(path.join(dataDir, 'firmledger.db'), { readonly: true });
    let pendingId;
    {
      const db2 = ro();
      pendingId = db2.prepare("SELECT id FROM listing_news WHERE title LIKE 'Safari Fintech opens a Mombasa office%'").get().id;
      db2.close();
    }
    const approved = await realFetch(`${BASE}/admin3119Musa/news/${pendingId}/approve`, form(admin, { _csrf: adminCsrf, status: 'pending' }));
    check('the console approves the story', approved.status === 302 && /ok=Story\+approved/.test(approved.headers.get('location') || ''),
      approved.headers.get('location') || `HTTP ${approved.status}`);
    const profileAfter = await (await realFetch(`${BASE}/listing/http-safari`)).text();
    check('the approved story now shows on the profile', /Mombasa office/.test(profileAfter));
    check('it is inside the news panel', /<h3>News<\/h3>/.test(profileAfter));

    /* ---- written by hand ---- */
    const hand = await realFetch(`${BASE}/admin3119Musa/news/add`, form(admin, {
      _csrf: adminCsrf, listing_id: String(ids.b), title: 'Tembo Logistics fleet doubles',
      url: 'https://tembo-logistics.example/news/fleet', source: 'Tembo Newsroom', published_at: '2026-06-01',
    }));
    check('a hand-written story is published', hand.status === 302 && /ok=Story\+added/.test(hand.headers.get('location') || ''),
      hand.headers.get('location') || `HTTP ${hand.status}`);
    const temboProfile = await (await realFetch(`${BASE}/listing/http-tembo`)).text();
    check('it appears on that profile immediately', /fleet doubles/.test(temboProfile));

    /* ---- automatic detection through the console ---- */
    const sweepPost = await realFetch(`${BASE}/admin3119Musa/news/refresh`, form(admin, { _csrf: adminCsrf, scope: 'due' }));
    check('a detection sweep is accepted', sweepPost.status === 302 && /ok=News\+sweep\+started/.test(sweepPost.headers.get('location') || ''),
      sweepPost.headers.get('location') || `HTTP ${sweepPost.status}`);
    const jobState = await (await realFetch(`${BASE}/admin3119Musa/news/job.json`, { headers: admin })).json();
    check('the sweep reports what it queued', jobState.job && jobState.job.total === 2, JSON.stringify(jobState.job));
    for (let i = 0; i < 200; i++) {
      const j = await (await realFetch(`${BASE}/admin3119Musa/news/job.json`, { headers: admin })).json();
      if (j.job && !j.job.running) break;
      await sleep(100);
    }
    const safariProfile = await (await realFetch(`${BASE}/listing/http-safari`)).text();
    check('detected stories appear on the profile', /raises Sh200m/.test(safariProfile));
    check('unrelated coverage is not shown', !/shilling firms against the dollar/.test(safariProfile));
    check('near-miss coverage is not shown', !/long-distance service/.test(safariProfile));

    /* ---- upkeep settings ---- */
    const settingsSave = await realFetch(`${BASE}/admin3119Musa/settings/upkeep`, form(admin, {
      _csrf: adminCsrf, upkeep_on: '1', upkeep_tech_on: '1', upkeep_news_on: '1',
      upkeep_tech_limit: '7', upkeep_news_limit: '9', upkeep_news_max_age_days: '3',
    }));
    check('the upkeep schedule saves', settingsSave.status === 302, `HTTP ${settingsSave.status}`);
    const settingsPage = await (await realFetch(`${BASE}/admin3119Musa/settings`, { headers: admin })).text();
    check('the settings page carries the upkeep section', /Automated upkeep/.test(settingsPage));
    check('it shows the saved caps', /name="upkeep_tech_limit"[^>]*value="7"/.test(settingsPage) && /name="upkeep_news_limit"[^>]*value="9"/.test(settingsPage));
    const upkeepRun = await realFetch(`${BASE}/admin3119Musa/settings/upkeep/run`, form(admin, { _csrf: adminCsrf }));
    const upkeepLoc = decode(upkeepRun.headers.get('location') || '');
    check('upkeep can be run on demand', upkeepRun.status === 302 && /ok=Upkeep run queued/.test(upkeepLoc),
      upkeepLoc || `HTTP ${upkeepRun.status}`);

    /* ---- the dashboard counts it ---- */
    const dash = await (await realFetch(`${BASE}/admin3119Musa/dashboard`, { headers: admin })).text();
    check('the dashboard counts stories waiting for moderation', /News to moderate/.test(dash));

    server.kill('SIGKILL');
    return finish(dataDir, serverLog);
  })
  .catch((e) => {
    console.log('\nharness crashed:', e && e.stack);
    process.exit(1);
  });

let reported = false;
function finish(dataDir, serverLog) {
  if (reported) return;
  reported = true;
  console.log(`\n${'='.repeat(64)}`);
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  failures.forEach((f) => console.log('  • ' + f));
  if (failures.length && serverLog) console.log('\nserver log tail:\n' + serverLog.slice(-1500));
  console.log('='.repeat(64));
  try { if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(dataDirA, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
}
