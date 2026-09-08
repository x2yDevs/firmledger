/**
 * News about a listing — detection, member submissions and moderation.
 *
 * Three kinds of row live in `listing_news`:
 *
 *   auto    found by searching a public news index for the company. A story is
 *           only stored when it clears the accuracy gate in matchItem(): the
 *           company's own domain, or its full name as a phrase. Anything else
 *           is dropped — a near-miss is never "close enough".
 *   user    submitted by a signed-in member from the listing page. Always
 *           lands in `pending` and is invisible publicly until a moderator
 *           approves it.
 *   admin   written by the console. Published immediately.
 *
 * Bulk detection runs in the background (start()/jobState(), the same contract
 * as lib/techrefresh.js) so the console can sweep the whole directory without
 * blocking a request.
 */
const { db, getSetting, setSetting } = require('../db');
const notify = require('./notify');
const { escHtml, siteUrl } = require('./util');

/* Default: Google News RSS. Override with NEWS_SEARCH_URL — the literal ${q}
   is replaced with the URL-encoded query. */
const SEARCH_URL = process.env.NEWS_SEARCH_URL
  || 'https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en';
const UA = 'FirmLedgerBot/1.0 (+https://firmledger.co.ke/bot)';
const FETCH_TIMEOUT_MS = 8000;
const CONCURRENCY = 3;
const MAX_ERRORS = 5;
/** Approved stories kept per listing — the oldest auto ones roll off first. */
const PER_LISTING_CAP = 12;
const SUMMARY_KEY = 'news_last_run';

function today() {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------------------- text helpers */

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? stripTags(m[1]) : '';
}

/** The publisher link Google News-style feeds carry on <source url="…">. */
function pickAttr(block, tag, attr) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*${attr}=["']([^"']+)["']`, 'i'));
  return m ? m[1].trim() : '';
}

/** Google News titles read "Headline - Publisher" — split the two apart. */
function splitTitle(raw, source) {
  const t = String(raw || '').trim();
  const m = t.match(/^(.*\S)\s+-\s+([^-]{2,40})$/);
  if (m && !source) return { title: m[1].trim(), source: m[2].trim() };
  return { title: t, source: source || '' };
}

/**
 * Minimal RSS reader — no dependency, only what an <item> carries.
 * Returns [{ title, url, source, published_at, summary }].
 */
function parseRss(xml) {
  const out = [];
  const blocks = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    const rawTitle = pick(block, 'title');
    if (!rawTitle) continue;
    const rawSource = pick(block, 'source');
    const sourceUrl = pickAttr(block, 'source', 'url');
    const { title, source } = splitTitle(rawTitle, rawSource);
    const url = (block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i) || [])[1]
      || (block.match(/<guid\b[^>]*>(https?:\/\/[^\s<]+)<\/guid>/i) || [])[1]
      || '';
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({
      title: title.slice(0, 220),
      url: url.trim(),
      source: (source || hostOf(sourceUrl) || hostOf(url)).slice(0, 80),
      source_url: sourceUrl.slice(0, 500),
      published_at: isoDay(pick(block, 'pubDate')),
      summary: pick(block, 'description').slice(0, 400),
    });
  }
  return out;
}

/** Any common date format → YYYY-MM-DD, or '' when it cannot be trusted. */
function isoDay(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function hostOf(rawUrl) {
  try { return new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

/* ------------------------------------------------------------ accuracy gate */

/** Lowercase, alphanumeric-only, single-spaced — the shape matching runs on. */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/* Legal/household suffixes stripped before matching: "Safari Fintech Ltd" and
   "Safari Fintech Limited" must be the same company to a news search. */
const NAME_SUFFIXES = /\b(limited|ltd|llc|inc|incorporated|plc|gmbh|bv|nv|sa|sas|ag|co|company|group|holdings|holding| ventures|partners|enterprises|international)\b/g;

function coreName(name) {
  let n = norm(name);
  for (let i = 0; i < 3; i++) n = n.replace(NAME_SUFFIXES, ' ').replace(/\s+/g, ' ').trim();
  return n;
}

function containsPhrase(haystack, phrase) {
  if (!phrase) return false;
  const rx = new RegExp(`(^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(\\s|$)`);
  return rx.test(haystack);
}

/**
 * Does this story actually concern this company?
 * Returns { match: 'domain' | 'name' } or null — null means "drop it".
 */
function matchItem(listing, item) {
  const domain = hostOf(listing.website || '');
  const hayNorm = norm(`${item.title} ${item.summary}`);
  /* Google News-style feeds wrap the real link, so the publisher URL on
     <source url="…"> is part of what counts as "citing the company". */
  const raw = `${item.title} ${item.summary} ${item.url} ${item.source_url || ''}`;

  // 1. The story is on (or explicitly cites) the company's own domain.
  if (domain && domain.length > 4) {
    const itemHost = hostOf(item.url);
    if (itemHost && (itemHost === domain || itemHost.endsWith(`.${domain}`))) return { match: 'domain' };
    if (raw.toLowerCase().includes(domain)) return { match: 'domain' };
  }

  // 2. The company's full name appears as a phrase in the headline or summary.
  const name = coreName(listing.name);
  if (name.length >= 4 && (containsPhrase(norm(item.title), name) || containsPhrase(hayNorm, name))) {
    return { match: 'name' };
  }
  return null;
}

/* --------------------------------------------------------------- row access */

const SELECT_APPROVED = `SELECT * FROM listing_news
  WHERE listing_id = ? AND status = 'approved'
  ORDER BY CASE WHEN published_at <> '' THEN published_at ELSE date(created_at) END DESC, id DESC`;

function approvedFor(listingId, limit = 8) {
  return db.prepare(`${SELECT_APPROVED} LIMIT ?`).all(listingId, limit);
}

function allFor(listingId) {
  return db.prepare(
    `SELECT * FROM listing_news WHERE listing_id = ?
     ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,
              CASE WHEN published_at <> '' THEN published_at ELSE date(created_at) END DESC, id DESC`
  ).all(listingId);
}

function pendingQueue(limit = 200) {
  return db.prepare(
    `SELECT n.*, l.name AS listing_name, l.slug AS listing_slug, u.email AS submitter_email_addr, u.name AS submitter_name
     FROM listing_news n
     JOIN listings l ON l.id = n.listing_id
     LEFT JOIN users u ON u.id = n.submitted_by
     WHERE n.status = 'pending'
     ORDER BY n.created_at DESC LIMIT ?`
  ).all(limit);
}

function recent(status = '', limit = 200) {
  if (status === 'pending' || status === 'approved' || status === 'rejected') {
    return db.prepare(
      `SELECT n.*, l.name AS listing_name, l.slug AS listing_slug
       FROM listing_news n JOIN listings l ON l.id = n.listing_id
       WHERE n.status = ? ORDER BY n.created_at DESC LIMIT ?`
    ).all(status, limit);
  }
  return db.prepare(
    `SELECT n.*, l.name AS listing_name, l.slug AS listing_slug
     FROM listing_news n JOIN listings l ON l.id = n.listing_id
     ORDER BY n.created_at DESC LIMIT ?`
  ).all(limit);
}

function counts() {
  const row = (sql) => db.prepare(sql).get().c;
  return {
    pending: row("SELECT COUNT(*) c FROM listing_news WHERE status='pending'"),
    approved: row("SELECT COUNT(*) c FROM listing_news WHERE status='approved'"),
    rejected: row("SELECT COUNT(*) c FROM listing_news WHERE status='rejected'"),
    auto: row("SELECT COUNT(*) c FROM listing_news WHERE origin='auto' AND status='approved'"),
    member: row("SELECT COUNT(*) c FROM listing_news WHERE origin='user' AND status='approved'"),
    listingsWithNews: row("SELECT COUNT(DISTINCT listing_id) c FROM listing_news WHERE status='approved'"),
    listingsUnscanned: row(
      "SELECT COUNT(*) c FROM listings WHERE status='approved' AND (news_checked_at IS NULL OR news_checked_at = '')"
    ),
    listingsTotal: row("SELECT COUNT(*) c FROM listings WHERE status='approved'"),
  };
}

/** Auto items are published straight away unless the console asks for review. */
function autoStatus() {
  return getSetting('news_review_auto', '0') === '1' ? 'pending' : 'approved';
}

function insertRow(listing, item, { origin, status, match, user, note }) {
  const url = String(item.url || '').trim().slice(0, 500);
  if (url) {
    const dupe = db.prepare('SELECT id FROM listing_news WHERE listing_id=? AND url=?').get(listing.id, url);
    if (dupe) return { inserted: false, id: dupe.id };
  } else {
    const dupe = db.prepare('SELECT id FROM listing_news WHERE listing_id=? AND title=?').get(listing.id, item.title);
    if (dupe) return { inserted: false, id: dupe.id };
  }
  const info = db.prepare(
    `INSERT INTO listing_news
       (listing_id, title, url, source, published_at, summary, origin, status, match,
        submitted_by, submitter_email, submitter_note, reviewed_by, reviewed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    listing.id,
    String(item.title || '').trim().slice(0, 220),
    url,
    String(item.source || '').trim().slice(0, 80),
    isoDay(item.published_at),
    String(item.summary || '').trim().slice(0, 400),
    origin, status, match || '',
    user ? user.id : null,
    user ? String(user.email || '').slice(0, 200) : String(item.submitter_email || '').slice(0, 200),
    String(note || '').slice(0, 500),
    origin === 'admin' ? 'admin' : '',
    origin === 'admin' ? new Date().toISOString() : '',
  );
  return { inserted: true, id: Number(info.lastInsertRowid) };
}

/** Keep the freshest stories only; auto rows are the first to roll off. */
function trimListing(listingId, cap = PER_LISTING_CAP) {
  const ids = db.prepare(
    `SELECT id FROM listing_news WHERE listing_id = ? AND status = 'approved'
     ORDER BY CASE WHEN published_at <> '' THEN published_at ELSE date(created_at) END DESC, id DESC`
  ).all(listingId);
  if (ids.length <= cap) return 0;
  const doomed = db.prepare(
    `SELECT id FROM listing_news WHERE listing_id = ? AND status = 'approved' AND origin <> 'user'
     ORDER BY CASE WHEN published_at <> '' THEN published_at ELSE date(created_at) END ASC, id ASC LIMIT ?`
  ).all(listingId, ids.length - cap).map((r) => r.id);
  if (!doomed.length) return 0;
  const del = db.prepare('DELETE FROM listing_news WHERE id = ?');
  for (const id of doomed) del.run(id);
  return doomed.length;
}

/* -------------------------------------------------------------- detection */

async function fetchFor(listing, { limit = 20 } = {}) {
  if (!listing || !String(listing.name || '').trim()) {
    return { ok: false, skipped: 'no-name', scanned: 0, matched: 0, added: 0 };
  }
  const url = SEARCH_URL.replace('${q}', encodeURIComponent(`"${listing.name}"`));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let items = [];
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'application/rss+xml, application/xml, text/xml, */*' },
    });
    if (!res.ok) {
      db.prepare("UPDATE listings SET news_checked_at = ? WHERE id = ?").run(today(), listing.id);
      return { ok: false, skipped: 'source-error', scanned: 0, matched: 0, added: 0, error: `news source returned ${res.status}` };
    }
    items = parseRss(await res.text()).slice(0, limit);
  } catch (e) {
    db.prepare("UPDATE listings SET news_checked_at = ? WHERE id = ?").run(today(), listing.id);
    return { ok: false, skipped: 'unreachable', scanned: 0, matched: 0, added: 0, error: e && e.message };
  } finally {
    clearTimeout(timer);
  }

  const status = autoStatus();
  let matched = 0; let added = 0;
  for (const item of items) {
    const m = matchItem(listing, item);
    if (!m) continue; // accuracy gate — a near-miss is never stored
    matched += 1;
    const r = insertRow(listing, item, { origin: 'auto', status, match: m.match });
    if (r.inserted) added += 1;
  }
  db.prepare("UPDATE listings SET news_checked_at = ? WHERE id = ?").run(today(), listing.id);
  if (status === 'approved') trimListing(listing.id);
  return { ok: true, scanned: items.length, matched, added, status };
}

/* ------------------------------------------------------- member submission */

function submit({ listing, user, title, url, source, published_at, summary, note }) {
  const clean = {
    title: String(title || '').trim().slice(0, 220),
    url: String(url || '').trim().slice(0, 500),
    source: String(source || '').trim().slice(0, 80) || hostOf(url),
    published_at: isoDay(published_at),
    summary: String(summary || '').trim().slice(0, 400),
  };
  if (!clean.title) return { ok: false, error: 'Give the story a headline.' };
  if (clean.url && !/^https?:\/\//i.test(clean.url)) return { ok: false, error: 'That link is not a web address (http/https).' };
  const r = insertRow(listing, clean, { origin: 'user', status: 'pending', match: 'submitted', user, note });
  if (!r.inserted) return { ok: false, error: 'That story has already been submitted for this company.' };

  const who = user ? (user.email || 'a member') : 'a visitor';
  notify.notifyAdmin({
    kind: 'listing',
    title: `News submitted — ${listing.name}`,
    body: `${who} submitted “${clean.title}”${clean.source ? ` (${clean.source})` : ''}. It is waiting in Admin → News.`,
    url: '/admin3119Musa/news?status=pending',
  });
  if (listing.owner_user_id && (!user || listing.owner_user_id !== user.id)) {
    notify.notifyUser(listing.owner_user_id, {
      kind: 'listing',
      title: `News submitted for ${listing.name}`,
      body: `“${clean.title}” was submitted and is waiting for moderation before it appears on your profile.`,
      url: `/listing/${listing.slug}`,
    });
  }
  return { ok: true, id: r.id, pending: true };
}

/* ------------------------------------------------------------- moderation */

function byId(id) {
  return db.prepare('SELECT * FROM listing_news WHERE id = ?').get(Number(id));
}

function approve(id, by = 'admin') {
  const n = byId(id);
  if (!n) return { ok: false, error: 'That story no longer exists.' };
  db.prepare("UPDATE listing_news SET status='approved', reviewed_by=?, reviewed_at=?, updated_at=datetime('now') WHERE id=?")
    .run(by, new Date().toISOString(), n.id);
  trimListing(n.listing_id);
  if (n.submitted_by) {
    const l = db.prepare('SELECT name, slug FROM listings WHERE id = ?').get(n.listing_id) || {};
    notify.notifyUser(n.submitted_by, {
      kind: 'listing',
      title: 'Your news story is live',
      body: `“${escHtml(n.title)}” now appears on ${l.name || 'the listing'}'s profile.`,
      url: `/listing/${l.slug || ''}`,
    });
  }
  return { ok: true, id: n.id };
}

function reject(id, by = 'admin') {
  const n = byId(id);
  if (!n) return { ok: false, error: 'That story no longer exists.' };
  db.prepare("UPDATE listing_news SET status='rejected', reviewed_by=?, reviewed_at=?, updated_at=datetime('now') WHERE id=?")
    .run(by, new Date().toISOString(), n.id);
  if (n.submitted_by) {
    const l = db.prepare('SELECT name, slug FROM listings WHERE id = ?').get(n.listing_id) || {};
    notify.notifyUser(n.submitted_by, {
      kind: 'listing',
      title: 'Your news story was not published',
      body: `“${escHtml(n.title)}” did not pass moderation for ${l.name || 'the listing'} — it needs a clearer, citable source.`,
      url: `/listing/${l.slug || ''}`,
    });
  }
  return { ok: true, id: n.id };
}

function remove(id) {
  const n = byId(id);
  if (!n) return { ok: false, error: 'That story no longer exists.' };
  db.prepare('DELETE FROM listing_news WHERE id = ?').run(n.id);
  return { ok: true, id: n.id };
}

/** Console-written story — published the moment it is saved. */
function addManual({ listing, title, url, source, published_at, summary }) {
  const clean = {
    title: String(title || '').trim().slice(0, 220),
    url: String(url || '').trim().slice(0, 500),
    source: String(source || '').trim().slice(0, 80) || hostOf(url),
    published_at: isoDay(published_at),
    summary: String(summary || '').trim().slice(0, 400),
  };
  if (!clean.title) return { ok: false, error: 'Give the story a headline.' };
  if (clean.url && !/^https?:\/\//i.test(clean.url)) return { ok: false, error: 'That link is not a web address (http/https).' };
  const r = insertRow(listing, clean, { origin: 'admin', status: 'approved', match: 'manual' });
  if (!r.inserted) return { ok: false, error: 'That story is already on this listing.' };
  trimListing(listing.id);
  return { ok: true, id: r.id };
}

/* --------------------------------------------------------- background sweep */

/** Listings whose news is missing or older than `maxAgeDays` — oldest first. */
function staleListingIds({ limit = 50, maxAgeDays = 7 } = {}) {
  const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString().slice(0, 10);
  const cap = Math.max(1, Math.min(2000, Number(limit) || 50));
  return db.prepare(
    `SELECT id FROM listings
      WHERE status = 'approved' AND name <> ''
        AND (news_checked_at IS NULL OR news_checked_at = '' OR news_checked_at < ?)
      ORDER BY CASE WHEN news_checked_at IS NULL OR news_checked_at = '' THEN 0 ELSE 1 END, news_checked_at ASC, id ASC
      LIMIT ?`
  ).all(cutoff, cap).map((r) => r.id);
}

let job = null;

function jobState() {
  if (!job) return { running: false };
  return {
    running: job.status === 'running',
    status: job.status,
    scope: job.scope,
    total: job.total,
    done: job.done,
    found: job.found,
    added: job.added,
    unchanged: job.unchanged,
    failed: job.failed,
    errors: job.errors.slice(0, MAX_ERRORS),
    started_at: job.started_at,
    finished_at: job.finished_at,
    current: job.current,
  };
}

function lastRun() {
  const raw = getSetting(SUMMARY_KEY, '');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function start(ids, scope = 'selected') {
  if (job && job.status === 'running') {
    return { ok: false, error: 'A news sweep is already running.', job: jobState() };
  }
  const queue = [...new Set((ids || []).map((n) => Number(n)).filter((n) => n > 0))].slice(0, 2000);
  job = {
    status: 'running', scope, total: queue.length,
    done: 0, found: 0, added: 0, unchanged: 0, failed: 0,
    errors: [], current: '',
    started_at: new Date().toISOString(), finished_at: '', cancel: false,
  };
  console.log(`[news] sweep started — ${queue.length} listing(s), scope=${scope}`);
  run(queue).catch((e) => {
    console.error('[news] sweep crashed:', e && e.message);
    if (job) { job.status = 'error'; job.finished_at = new Date().toISOString(); }
  });
  return { ok: true, job: jobState() };
}

function cancel() {
  if (job && job.status === 'running') { job.cancel = true; return true; }
  return false;
}

async function run(queue) {
  if (!queue.length) {
    job.status = 'done';
    job.finished_at = new Date().toISOString();
    return finish(job);
  }
  let cursor = 0;
  async function worker() {
    for (;;) {
      if (job.cancel) return;
      const idx = cursor; cursor += 1;
      if (idx >= queue.length) return;
      const id = queue[idx];
      const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(id);
      try {
        if (!l) { job.done += 1; continue; }
        job.current = l.name;
        const r = await fetchFor(l);
        job.done += 1;
        if (!r.ok) {
          if (r.skipped === 'no-name') job.unchanged += 1;
          else {
            job.failed += 1;
            if (job.errors.length < MAX_ERRORS) job.errors.push(`${l.name} — ${r.error || r.skipped}`);
          }
        } else {
          job.found += r.matched || 0;
          job.added += r.added || 0;
          if (!r.added) job.unchanged += 1;
        }
      } catch (e) {
        job.done += 1;
        job.failed += 1;
        if (job.errors.length < MAX_ERRORS) job.errors.push(`${l ? l.name : id} — ${e && e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  job.current = '';
  job.status = job.cancel ? 'cancelled' : 'done';
  job.finished_at = new Date().toISOString();
  return finish(job);
}

function finish(j) {
  const summary = {
    scope: j.scope, total: j.total, attempted: j.done,
    found: j.found, added: j.added, unchanged: j.unchanged, failed: j.failed,
    status: j.status, started_at: j.started_at, finished_at: j.finished_at,
    errors: j.errors.slice(0, MAX_ERRORS),
  };
  setSetting(SUMMARY_KEY, JSON.stringify(summary));
  console.log(`[news] sweep ${j.status} — ${j.added} new stor${j.added === 1 ? 'y' : 'ies'} from ${j.found} match(es), ${j.failed} failed`);
  try {
    notify.notifyAdmin({
      kind: 'system',
      title: `News sweep ${j.status}`,
      body: `${j.done} of ${j.total} listing${j.total === 1 ? '' : 's'} scanned — ${j.added} new stor${j.added === 1 ? 'y' : 'ies'} added, ${j.failed} failed.`,
      url: '/admin3119Musa/news',
    });
  } catch { /* best-effort */ }
  return summary;
}

/** Public, human-readable label for where a story came from. */
function originLabel(n) {
  if (n.origin === 'user') return 'Submitted by a member';
  if (n.origin === 'admin') return 'Added by FirmLedger';
  return n.match === 'domain' ? 'Matched the company domain' : 'Matched the company name';
}

module.exports = {
  SEARCH_URL, PER_LISTING_CAP,
  parseRss, matchItem, coreName, norm, hostOf, isoDay,
  approvedFor, allFor, pendingQueue, recent, counts,
  fetchFor, submit, approve, reject, remove, addManual, byId,
  staleListingIds, start, cancel, jobState, lastRun, trimListing,
  autoStatus, originLabel, siteUrl,
};
