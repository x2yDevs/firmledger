/**
 * FirmLedger audience analytics (Pro).
 *
 * What it records:
 *   - 'view'                 a human opened a listing profile (GET /listing/:slug)
 *   - 'website_click'        a human clicked through to the business website
 *   - 'sponsored_impression' a human was shown a sponsored card for the listing
 *   - 'featured_impression'  a human was shown a featured card for the listing
 *
 * Impressions complete the conversion funnel — Sponsored/Featured exposure →
 * Views → Leads → Qualified → Won — so a Pro owner can see what their
 * visibility actually produced. Cards rendered for bots, admins or the
 * listing's own owner are never counted, exactly like views.
 *
 * What it never records: bot/crawler traffic, the listing owner's own views
 * and admin views — “audience” means other people, honestly counted.
 *
 * Location is taken from standard geo headers when the deployment provides
 * them (cf-ipcountry / cf-ipcity, x-vercel-ip-country / -city, x-country-code
 * / x-city, x-geo-country / x-geo-city) and left empty otherwise. Empty
 * renders as “Unknown” — locations are never guessed or fabricated.
 *
 * Profile clicks are views that arrived from inside FirmLedger discovery
 * (homepage, directory, search, category, compare, jobs, blog) — i.e. someone
 * found the listing on FirmLedger and opened the profile.
 */
const crypto = require('crypto');
const { db } = require('../db');
const { clientIp } = require('./spam');

const KINDS = ['view', 'website_click', 'sponsored_impression', 'featured_impression'];
const IMPRESSION_KINDS = ['sponsored_impression', 'featured_impression'];

/* Bots and link-preview fetchers must never inflate audience numbers. */
const BOT_UA = /bot|crawl|spider|slurp|mediapartners|baidu|yandex|sogou|exabot|facebot|facebookexternalhit|linkedinbot|embedly|quora|pinterest|slackbot|twitterbot|whatsapp|telegram|discordbot|applebot|semrush|ahrefs|mj12bot|dotbot|petalbot|bytespider|claudebot|gptbot|ccbot|amazonbot/i;

function isBot(req) {
  return BOT_UA.test(String((req.headers && req.headers['user-agent']) || ''));
}

function clean(s, max = 80) {
  return String(s || '').trim().replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Resolve viewer city/country from proxy geo headers. Empty when unknown. */
function locate(req) {
  const h = (req.headers || {});
  const pick = (...keys) => {
    for (const k of keys) {
      const v = h[k];
      if (v && String(v).trim()) return String(v).trim();
    }
    return '';
  };
  const country = clean(pick('cf-ipcountry', 'x-vercel-ip-country', 'x-country-code', 'x-geo-country'), 80);
  const city = clean(pick('cf-ipcity', 'x-vercel-ip-city', 'x-city', 'x-geo-city'), 80);
  /* Country headers are ISO codes — keep them uppercase so 'ke' and 'KE' group
     together and display as KE. Anything longer is a name: title-case it. */
  const countryOut = !country ? '' : country.length === 2 ? country.toUpperCase() : titleCase(country);
  return { city: city ? titleCase(city) : '', country: countryOut };
}

/** Stable per-visitor fingerprint (IP + user agent). Never stored raw. */
function visitorHash(req) {
  const ip = clientIp(req);
  const ua = String((req.headers && req.headers['user-agent']) || '').slice(0, 300);
  return crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 32);
}

/** Normalize a Referer header to “/path?query” so discovery sources are queryable. */
function referrerPath(req) {
  const raw = String((req.headers && (req.headers.referer || req.headers.referrer)) || '');
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return clean(u.pathname + (u.search || ''), 200);
  } catch {
    return clean(raw, 200);
  }
}

function shouldSkip(req, listing) {
  if (!listing || listing.status !== 'approved') return true;
  if (isBot(req)) return true;
  if (req.admin) return true;
  if (req.user && listing.owner_user_id && listing.owner_user_id === req.user.id) return true;
  return false;
}

function insertEvent(listingId, kind, req) {
  const { city, country } = locate(req);
  db.prepare(
    `INSERT INTO listing_stat_events (listing_id, kind, visitor_hash, city, country, referrer)
     VALUES (?,?,?,?,?,?)`
  ).run(Number(listingId) || 0, kind, visitorHash(req), city, country, referrerPath(req));
}

/** Record a profile view. Best-effort — analytics never breaks the page. */
function recordView(listing, req) {
  try {
    if (shouldSkip(req, listing)) return false;
    insertEvent(listing.id, 'view', req);
    return true;
  } catch {
    return false;
  }
}

/** Record an outbound website click (JS beacon from the profile). */
function recordWebsiteClick(listing, req) {
  try {
    if (shouldSkip(req, listing)) return false;
    insertEvent(listing.id, 'website_click', req);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record card impressions for one rendered strip (homepage, directory, search
 * or category). One batched INSERT per strip — not one write per card — with
 * the same honesty rules as views: bots, admins, non-approved listings and
 * the owner's own listings are skipped. Returns the number recorded.
 */
function recordImpressions(listings, kind, req) {
  try {
    if (!IMPRESSION_KINDS.includes(kind)) return 0;
    if (!Array.isArray(listings) || !listings.length) return 0;
    if (!req || isBot(req) || req.admin) return 0;
    const mine = req.user ? req.user.id : 0;
    const ids = [];
    for (const l of listings) {
      if (!l || l.status !== 'approved') continue;
      if (mine && l.owner_user_id && l.owner_user_id === mine) continue;
      ids.push(Number(l.id) || 0);
    }
    if (!ids.length) return 0;
    const { city, country } = locate(req);
    const vh = visitorHash(req);
    const ref = referrerPath(req);
    const rows = ids.map(() => '(?,?,?,?,?,?)').join(',');
    const params = [];
    for (const id of ids) params.push(id, kind, vh, city, country, ref);
    db.prepare(
      `INSERT INTO listing_stat_events (listing_id, kind, visitor_hash, city, country, referrer)
       VALUES ${rows}`
    ).run(...params);
    return ids.length;
  } catch {
    return 0;
  }
}

function placeholders(ids) {
  return ids.map(() => '?').join(',');
}

/** Views today / this week / this month across a set of listings. */
function summary(listingIds) {
  const zero = { today: 0, week: 0, month: 0, total: 0 };
  if (!listingIds.length) return zero;
  const marks = placeholders(listingIds);
  try {
    const row = db.prepare(
      `SELECT
         SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END) AS today,
         SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS week,
         SUM(CASE WHEN created_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) AS month,
         COUNT(*) AS total
       FROM listing_stat_events
       WHERE listing_id IN (${marks}) AND kind='view'`
    ).get(...listingIds);
    return {
      today: (row && row.today) || 0,
      week: (row && row.week) || 0,
      month: (row && row.month) || 0,
      total: (row && row.total) || 0,
    };
  } catch {
    return zero;
  }
}

/**
 * Top viewer locations across a set of listings.
 * Empty city/country renders as “Unknown” in the view.
 */
function topLocations(listingIds, limit = 10) {
  if (!listingIds.length) return [];
  const marks = placeholders(listingIds);
  try {
    return db.prepare(
      `SELECT city, country, COUNT(*) AS views,
              COUNT(DISTINCT visitor_hash) AS uniques
       FROM listing_stat_events
       WHERE listing_id IN (${marks}) AND kind='view'
       GROUP BY city, country
       ORDER BY views DESC, uniques DESC
       LIMIT ?`
    ).all(...listingIds, Math.max(1, Math.min(50, Number(limit) || 10)));
  } catch {
    return [];
  }
}

function discoveryClause() {
  /* Internal discovery surfaces — a view that arrived from one of these is a
     “profile click” (found on FirmLedger, opened the profile). */
  return `(referrer = '/' OR referrer LIKE '/directory%' OR referrer LIKE '/search%'
           OR referrer LIKE '/compare%' OR referrer LIKE '/jobs%' OR referrer LIKE '/blog%')`;
}

/**
 * Drill-down for one location: views, unique visitors, profile clicks,
 * website clicks and leads from that location.
 */
function locationDetail(listingIds, city, country) {
  const zero = { views: 0, uniques: 0, profileClicks: 0, websiteClicks: 0, leads: 0 };
  if (!listingIds.length) return zero;
  const marks = placeholders(listingIds);
  const c = city || '';
  const co = country || '';
  try {
    const v = db.prepare(
      `SELECT COUNT(*) AS views,
              COUNT(DISTINCT visitor_hash) AS uniques,
              SUM(CASE WHEN ${discoveryClause()} THEN 1 ELSE 0 END) AS profile_clicks
       FROM listing_stat_events
       WHERE listing_id IN (${marks}) AND kind='view' AND city=? AND country=?`
    ).get(...listingIds, c, co);
    const w = db.prepare(
      `SELECT COUNT(*) AS c FROM listing_stat_events
       WHERE listing_id IN (${marks}) AND kind='website_click' AND city=? AND country=?`
    ).get(...listingIds, c, co);
    const l = db.prepare(
      `SELECT COUNT(*) AS c FROM leads
       WHERE listing_id IN (${marks}) AND city=? AND country=?`
    ).get(...listingIds, c, co);
    return {
      views: (v && v.views) || 0,
      uniques: (v && v.uniques) || 0,
      profileClicks: (v && v.profile_clicks) || 0,
      websiteClicks: (w && w.c) || 0,
      leads: (l && l.c) || 0,
    };
  } catch {
    return zero;
  }
}

/** Totals across a set of listings (used for the “all locations” row). */
function totals(listingIds) {
  const zero = { views: 0, uniques: 0, profileClicks: 0, websiteClicks: 0, leads: 0 };
  if (!listingIds.length) return zero;
  const marks = placeholders(listingIds);
  try {
    const v = db.prepare(
      `SELECT COUNT(*) AS views,
              COUNT(DISTINCT visitor_hash) AS uniques,
              SUM(CASE WHEN ${discoveryClause()} THEN 1 ELSE 0 END) AS profile_clicks
       FROM listing_stat_events
       WHERE listing_id IN (${marks}) AND kind='view'`
    ).get(...listingIds);
    const w = db.prepare(
      `SELECT COUNT(*) AS c FROM listing_stat_events
       WHERE listing_id IN (${marks}) AND kind='website_click'`
    ).get(...listingIds);
    const l = db.prepare(
      `SELECT COUNT(*) AS c FROM leads WHERE listing_id IN (${marks})`
    ).get(...listingIds);
    return {
      views: (v && v.views) || 0,
      uniques: (v && v.uniques) || 0,
      profileClicks: (v && v.profile_clicks) || 0,
      websiteClicks: (w && w.c) || 0,
      leads: (l && l.c) || 0,
    };
  } catch {
    return zero;
  }
}

/** Per-listing view totals for an owner's listings (small multiples). */
function perListing(listingIds) {
  if (!listingIds.length) return {};
  const marks = placeholders(listingIds);
  try {
    const rows = db.prepare(
      `SELECT listing_id,
              COUNT(*) AS views,
              SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS week
       FROM listing_stat_events
       WHERE listing_id IN (${marks}) AND kind='view'
       GROUP BY listing_id`
    ).all(...listingIds);
    const out = {};
    for (const r of rows) out[r.listing_id] = { views: r.views || 0, week: r.week || 0 };
    return out;
  } catch {
    return {};
  }
}

/**
 * The conversion funnel for a set of listings over the last `days` days:
 * Sponsored/Featured exposure → profile views → website clicks → leads →
 * qualified → won. Leads are counted by arrival window; statuses are their
 * CURRENT state (archived leads still count — archiving is inbox tidying,
 * not un-receiving). Rates are percentages with one decimal, or null when
 * the denominator is zero.
 */
function funnel(listingIds, days = 30) {
  const d = Math.max(1, Math.min(365, Number(days) || 30));
  const zero = {
    days: d,
    impressions: 0, sponsoredImpressions: 0, featuredImpressions: 0,
    views: 0, websiteClicks: 0,
    leads: 0, byStatus: { new: 0, contacted: 0, qualified: 0, won: 0, lost: 0 },
    contactRate: null, qualifyRate: null, winRate: null,
  };
  if (!listingIds.length) return zero;
  const marks = placeholders(listingIds);
  try {
    const e = db.prepare(
      `SELECT kind, COUNT(*) AS c FROM listing_stat_events
       WHERE listing_id IN (${marks}) AND created_at >= datetime('now', ?)
       GROUP BY kind`
    ).all(...listingIds, `-${d} days`);
    const byKind = Object.fromEntries(e.map((r) => [r.kind, r.c]));
    const s = db.prepare(
      `SELECT status, COUNT(*) AS c FROM leads
       WHERE listing_id IN (${marks}) AND created_at >= datetime('now', ?)
       GROUP BY status`
    ).all(...listingIds, `-${d} days`);
    const byStatus = { ...zero.byStatus };
    for (const r of s) if (r.status in byStatus) byStatus[r.status] = r.c;
    const sponsored = byKind.sponsored_impression || 0;
    const featured = byKind.featured_impression || 0;
    const views = byKind.view || 0;
    const leads = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const pct = (n, den) => (den > 0 ? Math.round((n / den) * 1000) / 10 : null);
    return {
      days: d,
      impressions: sponsored + featured,
      sponsoredImpressions: sponsored, featuredImpressions: featured,
      views, websiteClicks: byKind.website_click || 0,
      leads, byStatus,
      contactRate: pct(leads, views),
      qualifyRate: pct(byStatus.qualified + byStatus.won, leads),
      winRate: pct(byStatus.won, leads),
    };
  } catch {
    return zero;
  }
}

/** Any funnel activity (events or leads) for these listings in `days` days? */
function hasActivity(listingIds, days = 7) {
  if (!listingIds.length) return false;
  const d = Math.max(1, Math.min(365, Number(days) || 7));
  const marks = placeholders(listingIds);
  try {
    const e = db.prepare(
      `SELECT COUNT(*) c FROM listing_stat_events
       WHERE listing_id IN (${marks}) AND created_at >= datetime('now', ?)`
    ).get(...listingIds, `-${d} days`).c;
    if (e > 0) return true;
    return db.prepare(
      `SELECT COUNT(*) c FROM leads
       WHERE listing_id IN (${marks}) AND created_at >= datetime('now', ?)`
    ).get(...listingIds, `-${d} days`).c > 0;
  } catch {
    return false;
  }
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

/**
 * The Pro justification sentence: “Your FirmLedger listing generated 37
 * leads in the last 30 days, including 6 qualified leads and 2 won
 * opportunities.” Shared by the dashboard and the weekly digest so the
 * numbers always read the same in both places.
 */
function funnelHeadline(f, listingCount = 1) {
  const what = listingCount === 1 ? 'listing' : 'listings';
  const window = f.days === 7 ? 'last 7 days' : `last ${f.days} days`;
  let s = `Your FirmLedger ${what} generated ${plural(f.leads, 'lead', 'leads')} in the ${window}`;
  const parts = [];
  if (f.byStatus.qualified > 0) parts.push(plural(f.byStatus.qualified, 'qualified lead', 'qualified leads'));
  if (f.byStatus.won > 0) parts.push(plural(f.byStatus.won, 'won opportunity', 'won opportunities'));
  if (parts.length) s += `, including ${parts.join(' and ')}`;
  return s + '.';
}

/* Retention — raw stat events older than every analytics window (the funnel
   accepts at most 365 days) are deleted by the scheduled jobs. Returns the
   number of rows removed. */
function purgeOldEvents(retentionDays = 400) {
  const d = Math.max(366, Math.min(3650, Number(retentionDays) || 400));
  try {
    return db.prepare(
      `DELETE FROM listing_stat_events WHERE created_at < datetime('now', ?)`
    ).run(`-${d} days`).changes || 0;
  } catch {
    return 0;
  }
}

module.exports = {
  KINDS, IMPRESSION_KINDS,
  isBot, locate, visitorHash, referrerPath,
  recordView, recordWebsiteClick, recordImpressions,
  summary, topLocations, locationDetail, totals, perListing,
  funnel, funnelHeadline, hasActivity, purgeOldEvents,
};
