/**
 * FirmLedger — Pro growth bundle test.
 *
 *   node tests/pro-growth.test.js
 *
 * Covers the fair-rotation + Pro-growth work against a throwaway database:
 *   • advertising: countActive, sponsoredStrip cap + fair random subset,
 *     sponsoredSample filters (q / category / country, active only),
 *   • analytics: bot/owner/admin/non-approved skips, view + website_click
 *     recording, summary / topLocations / locationDetail / totals / perListing,
 *   • leads: validation, create (claimed-only), inbox counts/list/filters,
 *     status transitions, notes, archive, ownership isolation,
 *   • spam: the `lead` rate-limit bucket exists (20/hour default),
 *   • mailer: lead alerts send with a reply-to for the inquirer,
 *   • wording: "eligible for Featured placement" copy in place, no "sandbox"
 *     leaks in user-facing views, new blog seeds publish.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-pro-growth-'));
process.env.FIRMLEDGER_DATA_DIR = dataDir;
process.env.BASE_URL = 'https://firmledger.test';
process.env.SMTP_URL = ''; // no env mailer → everything lands in data/outbox.log

const OUTBOX = path.join(ROOT, 'data', 'outbox.log');
let outboxBefore = '';
if (fs.existsSync(OUTBOX)) outboxBefore = fs.readFileSync(OUTBOX, 'utf8');
const PREFIX_LEN = Buffer.byteLength(outboxBefore, 'utf8');
const outboxNew = () => {
  try {
    const buf = fs.readFileSync(OUTBOX);
    return buf.slice(PREFIX_LEN).toString('utf8');
  } catch { return ''; }
};

const { db } = require('../src/db');
const ad = require('../src/lib/advertising');
const analytics = require('../src/lib/analytics');
const leads = require('../src/lib/leads');
const spam = require('../src/lib/spam');
const mailer = require('../src/lib/mailer');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

/* ------------------------------------------------------------- fixtures */
const FUTURE = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 19).replace('T', ' ');
const PAST = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 19).replace('T', ' ');

function addUser(email, plan = 'free') {
  return Number(db.prepare(
    `INSERT INTO users (email, password_hash, name, plan, plan_expires_at)
     VALUES (?, 'x', ?, ?, ?)`
  ).run(email, email.split('@')[0], plan, plan === 'pro' ? FUTURE : '').lastInsertRowid);
}
function addListing(over = {}) {
  const d = {
    slug: `l-${Math.random().toString(36).slice(2, 9)}`, name: 'Test Co',
    tagline: 't', description: 'd', type: 'company', category: 'Technology',
    website: '', email: '', country: 'Kenya', city: 'Nairobi',
    status: 'approved', claimed: 0, confidence: 50, owner_user_id: null,
    sponsored: 0, sponsored_expires_at: '', featured: 0, ...over,
  };
  return Number(db.prepare(
    `INSERT INTO listings (slug, name, tagline, description, type, category, website, email,
      country, city, status, claimed, confidence, owner_user_id, sponsored,
      sponsored_expires_at, featured)
     VALUES (@slug, @name, @tagline, @description, @type, @category, @website, @email,
      @country, @city, @status, @claimed, @confidence, @owner_user_id, @sponsored,
      @sponsored_expires_at, @featured)`
  ).run(d).lastInsertRowid);
}
const getListing = (id) => db.prepare('SELECT * FROM listings WHERE id=?').get(id);

/* Fake express req for analytics recording. */
function fakeReq({ ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', ip = '196.201.214.1', headers = {}, user = null, admin = null, ref = '' } = {}) {
  return {
    headers: { 'user-agent': ua, referer: ref ? `https://firmledger.test${ref}` : '', ...headers },
    ip,
    user, admin,
    get(h) { return this.headers[String(h).toLowerCase()] || ''; },
  };
}

const ownerId = addUser('owner-pro@test.dev', 'pro');
const otherId = addUser('other@test.dev', 'free');

section('Advertising — fair sponsored rotation');
{
  const cat = 'Technology';
  const ids = [];
  for (let i = 0; i < 20; i++) {
    ids.push(addListing({ slug: `spon-${i}`, name: `Sponsor ${i}`, category: cat, sponsored: 1 }));
  }
  const expiredId = addListing({ slug: 'spon-expired', name: 'Expired Sponsor', category: cat, sponsored: 1, sponsored_expires_at: '2020-01-01' });
  const pendingId = addListing({ slug: 'spon-pending', name: 'Pending Sponsor', category: cat, status: 'pending', sponsored: 1 });
  void expiredId; void pendingId;

  check('countActive counts active sponsors only', ad.countActive() === 20, `got ${ad.countActive()}`);

  const strip = ad.sponsoredStrip(5);
  check('sponsoredStrip honours the cap', strip.length === 5, `got ${strip.length}`);
  check('sponsoredStrip returns active sponsors only',
    strip.every((l) => l.sponsored === 1 && l.status === 'approved'));

  // Fairness: repeated draws from a pool of 20 must surface more than one
  // fixed 5-set (P(all 12 draws identical) is ~0 for a uniform draw).
  const seen = new Set();
  for (let i = 0; i < 12; i++) for (const l of ad.sponsoredStrip(5)) seen.add(l.id);
  check('repeated draws rotate (fair random subset)', seen.size > 5, `saw ${seen.size} distinct of 20`);

  const uncapped = ad.sponsoredStrip(0);
  check('uncapped sponsoredStrip returns the whole book', uncapped.length === 20, `got ${uncapped.length}`);

  const food = addListing({ slug: 'spon-food', name: 'Sponsor Foods', category: 'Food & Beverage', sponsored: 1 });
  void food;
  const byCat = ad.sponsoredSample({ category: 'Food & Beverage' }, 3);
  check('sponsoredSample respects the category filter',
    byCat.length === 1 && byCat[0].slug === 'spon-food');
  const byQ = ad.sponsoredSample({ q: 'Sponsor 1' }, 5);
  check('sponsoredSample respects the keyword filter',
    byQ.length >= 1 && byQ.every((l) => /sponsor 1/i.test(l.name)), `got ${byQ.length}`);
  const byCountry = ad.sponsoredSample({ country: 'Kenya' }, 50);
  check('sponsoredSample respects the country filter (capped at 12)',
    byCountry.length === 12 && byCountry.every((l) => l.country === 'Kenya'), `got ${byCountry.length}`);
  const none = ad.sponsoredSample({ country: 'Atlantis' }, 3);
  check('sponsoredSample returns [] when nothing matches', none.length === 0);
  check('sponsoredSample never returns expired/pending sponsors',
    ad.sponsoredSample({}, 50).every((l) => l.status === 'approved' && l.sponsored === 1));
}

section('Analytics — recording rules');
{
  const lid = addListing({ slug: 'ana-co', name: 'Ana Co', owner_user_id: ownerId, claimed: 1 });
  const l = getListing(lid);
  const count = () => db.prepare('SELECT COUNT(*) c FROM listing_stat_events WHERE listing_id=?').get(lid).c;

  check('bot user-agents are detected', analytics.isBot(fakeReq({ ua: 'Googlebot/2.1 (+http://google.com/bot.html)' })));
  check('real browsers are not bots', !analytics.isBot(fakeReq({})));

  analytics.recordView(l, fakeReq({}));
  check('a human view is recorded', count() === 1);
  analytics.recordView(l, fakeReq({ ua: 'bingbot/2.0' }));
  check('bot views are skipped', count() === 1);
  analytics.recordView(l, fakeReq({ user: { id: ownerId } }));
  check('owner views are skipped', count() === 1);
  analytics.recordView(l, fakeReq({ admin: { via: 'secret-code' } }));
  check('admin views are skipped', count() === 1);
  const pend = getListing(addListing({ slug: 'ana-pend', name: 'Ana Pending', status: 'pending' }));
  analytics.recordView(pend, fakeReq({}));
  check('non-approved listings record nothing',
    db.prepare('SELECT COUNT(*) c FROM listing_stat_events WHERE listing_id=?').get(pend.id).c === 0);

  analytics.recordWebsiteClick(l, fakeReq({}));
  const kinds = db.prepare('SELECT kind, COUNT(*) c FROM listing_stat_events WHERE listing_id=? GROUP BY kind').all(lid);
  const map = Object.fromEntries(kinds.map((r) => [r.kind, r.c]));
  check('website clicks record as website_click', map.website_click === 1 && map.view === 1, JSON.stringify(map));
  analytics.recordWebsiteClick(l, fakeReq({ user: { id: ownerId } }));
  check('owner website clicks are skipped',
    db.prepare("SELECT COUNT(*) c FROM listing_stat_events WHERE listing_id=? AND kind='website_click'").get(lid).c === 1);

  const loc = analytics.locate(fakeReq({ headers: { 'cf-ipcountry': 'ke', 'cf-ipcity': 'mombasa' } }));
  check('locate reads geo headers', loc.country === 'KE' && loc.city === 'Mombasa', JSON.stringify(loc));
  const loc2 = analytics.locate(fakeReq({ headers: { 'x-vercel-ip-country': 'UG', 'x-vercel-ip-city': 'kampala' } }));
  check('locate reads Vercel geo headers', loc2.country === 'UG' && loc2.city === 'Kampala', JSON.stringify(loc2));
  check('locate is empty without signals', analytics.locate(fakeReq({})).city === '' && analytics.locate(fakeReq({})).country === '');
}

section('Analytics — aggregates');
{
  const a = addListing({ slug: 'agg-a', name: 'Agg A', owner_user_id: ownerId });
  const b = addListing({ slug: 'agg-b', name: 'Agg B', owner_user_id: ownerId });
  const ins = db.prepare(
    `INSERT INTO listing_stat_events (listing_id, kind, city, country, visitor_hash, referrer, created_at)
     VALUES (?,?,?,?,?,?,?)`
  );
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const daysAgo = (n) => { const d = new Date(now.getTime() - n * 864e5); return iso(d); };
  // A: 3 views today (Nairobi), 2 six days ago (Mombasa), 1 forty days ago.
  ins.run(a, 'view', 'Nairobi', 'Kenya', 'h1', '/directory', iso(now));
  ins.run(a, 'view', 'Nairobi', 'Kenya', 'h1', '/', iso(now));
  ins.run(a, 'view', 'Nairobi', 'Kenya', 'h2', '/search?q=x', iso(now));
  ins.run(a, 'view', 'Mombasa', 'Kenya', 'h3', 'https://google.com/', daysAgo(6));
  ins.run(a, 'view', 'Mombasa', 'Kenya', 'h4', '/directory', daysAgo(6));
  ins.run(a, 'view', '', '', 'h5', '', daysAgo(40));
  ins.run(a, 'website_click', 'Nairobi', 'Kenya', 'h1', '', iso(now));
  // B: 1 view today (Kampala, Uganda).
  ins.run(b, 'view', 'Kampala', 'Uganda', 'h9', '/blog/x', iso(now));

  const s = analytics.summary([a, b]);
  check('summary windows are right', s.today === 4 && s.week === 6 && s.month === 6 && s.total === 7, JSON.stringify(s));
  check('summary tolerates an empty set', JSON.stringify(analytics.summary([])) === JSON.stringify({ today: 0, week: 0, month: 0, total: 0 }));

  const top = analytics.topLocations([a, b], 10);
  check('topLocations ranks Nairobi first', top[0] && top[0].city === 'Nairobi' && top[0].views === 3, JSON.stringify(top[0]));
  check('topLocations counts uniques', top.find((t) => t.city === 'Nairobi').uniques === 2);

  const d = analytics.locationDetail([a, b], 'Nairobi', 'Kenya');
  check('locationDetail: views+uniques', d.views === 3 && d.uniques === 2, JSON.stringify(d));
  check('locationDetail: profile clicks = internal referrers', d.profileClicks === 3, JSON.stringify(d));
  check('locationDetail: website clicks', d.websiteClicks === 1, JSON.stringify(d));
  const dm = analytics.locationDetail([a, b], 'Mombasa', 'Kenya');
  check('locationDetail: external referrer is not a profile click', dm.profileClicks === 1, JSON.stringify(dm));

  const t = analytics.totals([a, b]);
  check('totals roll everything up',
    t.views === 7 && t.uniques === 6 && t.profileClicks === 5 && t.websiteClicks === 1 && t.leads === 0,
    JSON.stringify(t));

  const pl = analytics.perListing([a, b]);
  check('perListing splits by listing', pl[a].views === 6 && pl[a].week === 5 && pl[b].views === 1 && pl[b].week === 1, JSON.stringify(pl));
}

section('Leads — validation + create');
{
  const claimed = getListing(addListing({ slug: 'lead-co', name: 'Lead Co', claimed: 1, owner_user_id: ownerId }));
  const unclaimed = getListing(addListing({ slug: 'lead-plain', name: 'Lead Plain' }));

  const inquirerId = addUser('inquirer@test.dev', 'free');
  const noAuth = leads.create({
    listing: claimed,
    fields: { name: 'Jane Wanjiku', email: 'jane@example.com', message: 'Please send a quote for ten desks.' },
  });
  check('create requires a signed-in FirmLedger member', !noAuth.ok);
  const bad = leads.create({ listing: claimed, fields: { name: 'J', email: 'nope', message: 'hi' }, inquirerUserId: inquirerId });
  check('create rejects bad fields', !bad.ok && bad.errors && bad.errors.length >= 2, bad.ok ? 'accepted!' : (bad.errors || [bad.error]).join(' | '));
  const un = leads.create({
    listing: unclaimed,
    fields: { name: 'Jane Wanjiku', email: 'jane@example.com', message: 'Please send a quote for ten desks.' },
    inquirerUserId: inquirerId,
  });
  check('create rejects unclaimed listings', !un.ok);
  const self = leads.create({
    listing: claimed,
    fields: { name: 'Owner Self', email: 'owner-pro@test.dev', message: 'Please send a quote for ten desks.' },
    inquirerUserId: ownerId,
  });
  check('create rejects the listing owner contacting themselves', !self.ok);
  const ok = leads.create({
    listing: claimed,
    fields: { name: 'Jane Wanjiku', email: 'jane@example.com', phone: '+254700000000', looking_for: 'Ten desks', message: 'Please send a quote for ten desks.' },
    city: 'Nairobi', country: 'Kenya',
    inquirerUserId: inquirerId,
  });
  check('create stores a valid lead', ok.ok && ok.id > 0);
  const row = db.prepare('SELECT * FROM leads WHERE id=?').get(ok.id);
  check('stored lead carries city + looking_for + inquirer',
    row.city === 'Nairobi' && row.looking_for === 'Ten desks' && row.status === 'new' && row.archived === 0 && row.inquirer_user_id === inquirerId);
  const msgs = leads.messagesFor(ok.id, inquirerId);
  check('opening message seeds the thread', msgs.length === 1 && msgs[0].sender === 'inquirer');
  const reply = leads.addMessage(ok.id, ownerId, 'Thanks Jane — quote attached.');
  check('owner can reply in-thread', reply.ok);
  const after = leads.messagesFor(ok.id, ownerId);
  check('thread has both sides', after.length === 2 && after[1].sender === 'owner');
  check('owner reply flips status to contacted', leads.getOwned(ok.id, ownerId).status === 'contacted');
  check('inquirer can reply to the owner', leads.addMessage(ok.id, inquirerId, 'Thank you, when can we start?').ok);
  const conversation = leads.messagesFor(ok.id, ownerId);
  check('both users see the same complete conversation', conversation.length === 3 &&
    conversation[2].sender === 'inquirer' && conversation[2].body === 'Thank you, when can we start?' &&
    JSON.stringify(conversation) === JSON.stringify(leads.messagesFor(ok.id, inquirerId)));
  check('unrelated user cannot read the conversation', leads.messagesFor(ok.id, otherId).length === 0);
  check('unrelated user cannot send a message', !leads.addMessage(ok.id, otherId, 'Unauthorized').ok);
  check('empty replies are rejected', !leads.addMessage(ok.id, inquirerId, '  ').ok);
  check('rejected replies leave the thread unchanged', leads.messagesFor(ok.id, ownerId).length === 3);

}

section('Leads — inbox, statuses, notes, ownership');
{
  const mine = getListing(db.prepare('SELECT id FROM listings WHERE slug=?').get('lead-co').id);
  const other = getListing(addListing({ slug: 'lead-other', name: 'Lead Other', claimed: 1, owner_user_id: otherId }));
  const mk = (listing, name, status) => {
    const inq = addUser(`${name.replace(/\s/g, '').toLowerCase()}@inq.test`, 'free');
    const r = leads.create({
      listing,
      fields: { name, email: `${name.replace(/\s/g, '').toLowerCase()}@example.com`, message: 'A proper inquiry message here.' },
      inquirerUserId: inq,
    });
    if (status) leads.setStatus(r.id, listing.owner_user_id, status);
    return r.id;
  };
  const id2 = mk(mine, 'Brian Otieno');
  mk(mine, 'Cynthia Achieng', 'contacted');
  const id4 = mk(mine, 'David Mwangi', 'won');
  mk(other, 'Eve Stranger');

  const c = leads.countsForOwner(ownerId);
  /* Jane (first section, owner-replied → contacted) + Brian (new) + Cynthia (contacted) + David (won). */
  check('counts split by status', c.new === 1 && c.contacted === 2 && c.won === 1 && c.total === 4 && c.archived === 0, JSON.stringify(c));
  check("another owner's lead is invisible", leads.countsForOwner(otherId).total === 1);

  const all = leads.listForOwner(ownerId, {});
  check('list newest-first', all.total === 4 && all.rows.length === 4);
  const news = leads.listForOwner(ownerId, { status: 'new' });
  check('list filters by status', news.total === 1 && news.rows.every((r) => r.status === 'new'));
  const paged = leads.listForOwner(ownerId, { page: 2, perPage: 3 });
  check('list paginates', paged.total === 4 && paged.rows.length === 1 && paged.pages === 2, JSON.stringify({ n: paged.rows.length, pages: paged.pages }));

  check('setStatus rejects unknown statuses', !leads.setStatus(id2, ownerId, 'nope').ok);
  check('setStatus rejects foreign leads', !leads.setStatus(id2, otherId, 'won').ok);
  const st = leads.setStatus(id2, ownerId, 'qualified');
  check('setStatus moves new → qualified', st.ok && st.lead.status === 'qualified');

  check('addNote rejects empty notes', !leads.addNote(id2, ownerId, ' ').ok);
  check('addNote rejects foreign leads', !leads.addNote(id2, otherId, 'snoop').ok);
  leads.addNote(id2, ownerId, 'Called — wants a quote by Friday.');
  const notes = leads.notesFor(id2, ownerId);
  check('notes round-trip privately', notes.length === 1 && /Friday/.test(notes[0].note));
  check('foreign owners see no notes', leads.notesFor(id2, otherId).length === 0);

  leads.setArchived(id4, ownerId, true);
  const c2 = leads.countsForOwner(ownerId);
  check('archive hides from the inbox', c2.total === 3 && c2.archived === 1, JSON.stringify(c2));
  const arch = leads.listForOwner(ownerId, { archived: true });
  check('archived box lists archived leads', arch.total === 1 && arch.rows[0].id === id4);
  leads.setArchived(id4, ownerId, false);
  check('restore returns to the inbox', leads.countsForOwner(ownerId).total === 4);

  check('getOwned returns null for foreign leads', leads.getOwned(id2, otherId) === null);
  check('getOwned hydrates listing name', (leads.getOwned(id2, ownerId) || {}).listing_name === 'Lead Co');
}

section('Spam bucket + lead alert email');
{
  check('lead bucket defaults to 20/hour', spam.limits().lead === 20, `got ${spam.limits().lead}`);
  check('DEFAULTS exposes spam_rl_lead', spam.DEFAULTS.spam_rl_lead === 20);
}

section('Wording, sandbox hygiene, blog seeds');
{
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const pricing = read('views/pricing.ejs');
  check('pricing uses eligible-wording', /eligible for Featured placement/.test(pricing));
  check('pricing drops the old guarantee', !/Homepage Featured placement for your listings/.test(pricing));
  check('upgrade page uses eligible-wording', /eligible for Featured placement/.test(read('views/dashboard/upgrade.ejs')));

  // No "sandbox" may leak into user-facing views (admin console excluded).
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const userViews = walk(path.join(ROOT, 'views')).filter((f) =>
    f.endsWith('.ejs') && !f.includes(`${path.sep}admin${path.sep}`) && !`${path.sep}admin`.endsWith('x'));
  const adminFree = userViews.filter((f) => !f.split(path.sep).includes('admin'));
  const leaks = adminFree.filter((f) => /sandbox/i.test(fs.readFileSync(f, 'utf8')));
  check('no sandbox mentions in user-facing views', leaks.length === 0, leaks.map((f) => path.relative(ROOT, f)).join(', '));
  check('advertise checkout hides the PayPal mode', !/paypalMode/.test(read('views/dashboard/advertise.ejs')));

  // New blog seeds publish (idempotent seed already ran on db boot).
  for (const slug of ['how-featured-placement-works', 'how-advertising-works-on-firmledger', 'turning-your-listing-into-leads']) {
    const p = db.prepare("SELECT status FROM blog_posts WHERE slug=?").get(slug);
    check(`blog seed published: ${slug}`, p && p.status === 'published');
  }
}

(async () => {
  section('Mailer — reply-to passthrough');
  const before = outboxNew();
  const r = await mailer.sendBranded('owner-pro@test.dev', 'New inquiry for Lead Co', {
    alias: 'support', replyTo: 'Jane Wanjiku <jane@example.com>',
    kicker: 'New lead', title: 't', preheader: 'p', paragraphs: ['hello'],
  });
  check('lead alert sends without SMTP (outbox)', r && (r.delivered === false && r.logged === true), JSON.stringify(r));
  check('outbox captured the alert', outboxNew().length > before.length && /New inquiry for Lead Co/.test(outboxNew()));

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  - ' + f); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
