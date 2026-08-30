/* Newsletter subscribers, watchlist favorites and Pro jobs board.
 *
 * - newsletter_subscribers: every footer/register opt-in, one row per email,
 *   token-scoped one-click unsubscribe links.
 * - favorites: logged-in users star companies into a watchlist; edits on a
 *   watched listing fan out a branded "updated" digest to its watchers.
 * - jobs: Pro owners post openings; they surface on the listing page and the
 *   public /jobs board.
 *
 * sendWeeklyDigest() runs from an hourly process timer (server.js) and is a
 * no-op until 6.5 days have elapsed since the last run; the admin Settings
 * page can also force-send. */

const crypto = require('crypto');
const { db, getSetting, setSetting } = require('../db');
const { sendBranded } = require('./mailer');
const { siteUrl, escHtml, fmtDate } = require('./util');

/* ---------------- Newsletter ---------------- */
function subscribe(email, source = 'footer') {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) return null;
  const token = crypto.randomBytes(16).toString('hex');
  const prev = db.prepare('SELECT active FROM newsletter_subscribers WHERE email=?').get(e);
  db.prepare(
    `INSERT INTO newsletter_subscribers (email, source, token, active) VALUES (?,?,?,1)
     ON CONFLICT(email) DO UPDATE SET active=1, source=excluded.source`
  ).run(e, source, token);
  const row = db.prepare('SELECT * FROM newsletter_subscribers WHERE email=?').get(e);
  // welcome email fires only on a genuine (re)activation, never on a double-subscribe
  return { row, isNew: !prev || !prev.active };
}

/* Branded welcome + unsubscribe handle the moment someone subscribes (guest or account). */
async function sendSubscribeWelcome(email, token) {
  const unsubUrl = siteUrl(`/newsletter/unsubscribe?token=${token}`);
  await sendBranded(email, 'Welcome to the FirmLedger weekly digest', {
    kicker: 'Subscription confirmed',
    title: 'You are subscribed ✓',
    preheader: 'A short email every week — new verified companies and the freshest additions.',
    text: `You are subscribed to the FirmLedger weekly digest.\n\nEvery week we send one short email with the newest verified companies and freshly added listings on the ledger — no noise, unsubscribe in one click at any time.\n\nUnsubscribe anytime: ${unsubUrl}\nBrowse right now: ${siteUrl('/directory?sort=newest')}`,
    paragraphs: [
      'Every week we send <b>one short email</b> with the newest <b>verified companies</b> and <b>freshly added listings</b> on the ledger — nothing else, and no noise.',
      `You can browse right now at <a href="${siteUrl('/directory?sort=newest')}" style="color:#1D4ED8;">/directory</a> — the next digest lands in your inbox within the week.`,
    ],
    cta: { label: 'Browse the latest listings', url: siteUrl('/directory?sort=newest') },
    note: `One-click unsubscribe anytime: <a href="${unsubUrl}" style="color:#1D4ED8;">${unsubUrl}</a>`,
  }).catch(() => {});
}

function unsubscribe(token) {
  const t = String(token || '').trim();
  if (!t || t.length > 64) return false;
  const row = db.prepare('SELECT id FROM newsletter_subscribers WHERE token=?').get(t);
  if (!row) return false;
  db.prepare('UPDATE newsletter_subscribers SET active=0 WHERE id=?').run(row.id);
  return true;
}

function subCount(activeOnly = true) {
  return db.prepare(`SELECT COUNT(*) c FROM newsletter_subscribers ${activeOnly ? 'WHERE active=1' : ''}`).get().c;
}

/* Roundup window follows the chosen cadence (1 / 7 / 28 days). */
function weeklyRoundup(windowDays = 7) {
  const d = Math.max(1, Math.min(31, Number(windowDays) || 7));
  const verified = db.prepare(
    `SELECT name, slug, category, country, city, tagline, claimed, created_at, last_verified_at
       FROM listings WHERE status='approved' AND claimed=1
         AND COALESCE(last_verified_at, created_at) >= datetime('now','-${d} days')
       ORDER BY COALESCE(last_verified_at, created_at) DESC LIMIT 12`
  ).all();
  const fresh = db.prepare(
    `SELECT name, slug, category, country, city, tagline, claimed, created_at
       FROM listings WHERE status='approved' AND created_at >= datetime('now','-${d} days')
       ORDER BY created_at DESC LIMIT 14`
  ).all();
  // de-dupe: anything already in the verified list drops out of the fresh list
  const vSet = new Set(verified.map((v) => v.slug));
  return { verified, fresh: fresh.filter((f) => !vSet.has(f.slug)) };
}

function roundUpHtml(rows, urlQuery) {
  if (!rows.length) return '';
  return '<ul style="margin:6px 0 0;padding:0;list-style:none">' + rows.map((l) => {
    const place = [l.city, l.country].filter(Boolean).join(', ');
    return `<li style="padding:7px 0;border-bottom:1px solid #ece9e2">
      <a href="${siteUrl('/listing/' + l.slug + urlQuery)}" style="color:#0A1628;font-weight:700;text-decoration:none">${escHtml(l.name)}</a>
      <span style="color:#64748B;font-size:13px"> — ${escHtml(l.category)}${place ? ' · ' + escHtml(place) : ''}${l.claimed ? ' <span style="color:#1D4ED8">✓ verified</span>' : ''}</span>
      ${l.tagline ? `<div style="color:#3B4A5A;font-size:13px;margin-top:2px">${escHtml(l.tagline)}</div>` : ''}
    </li>`;
  }).join('') + '</ul>';
}

/* Cadence system: admin chooses how often the digest fires (Settings → Engagement).
   The trigger stays hourly — the gap decides when it actually goes out. */
const CADENCES = {
  daily:   { gap: 23 * 3600e3,   windowDays: 1,  whenLabel: 'today',      display: 'Daily' },
  weekly:  { gap: 6.5 * 86400e3, windowDays: 7,  whenLabel: 'this week',  display: 'Weekly' },
  monthly: { gap: 28 * 86400e3,  windowDays: 28, whenLabel: 'this month', display: 'Monthly' },
};

function digestCadence() {
  const c = getSetting('newsletter_cadence', 'weekly');
  return { key: CADENCES[c] ? c : 'weekly', ...(CADENCES[c] || CADENCES.weekly) };
}

/** Send the digest to all active subscribers when due. Returns a stats object. */
async function sendWeeklyDigest(force = false) {
  const cadence = digestCadence();
  const WEEK = cadence.gap;
  const last = Date.parse(getSetting('newsletter_last_sent', '')) || 0;
  if (!force && Date.now() - last < WEEK) return { sent: 0, reason: 'not_due' };
  const subs = db.prepare('SELECT * FROM newsletter_subscribers WHERE active=1').all();
  if (!subs.length) return { sent: 0, reason: 'no_subscribers' };
  const { verified, fresh } = weeklyRoundup(cadence.windowDays);
  if (!verified.length && !fresh.length) return { sent: 0, reason: 'nothing_new' };

  let sent = 0;
  for (const s of subs) {
    const unsubUrl = siteUrl(`/newsletter/unsubscribe?token=${s.token}`);
    const paragraphs = [];
    if (verified.length) {
      paragraphs.push(`<b>${verified.length} new verified ${verified.length === 1 ? 'company' : 'companies'} ${cadence.whenLabel}</b>${roundUpHtml(verified, 'verified-week')}`);
    }
    if (fresh.length) {
      paragraphs.push(`<b>Recently added to the ledger</b>${roundUpHtml(fresh, 'fresh-week')}`);
    }
    const rowLine = (l) => ` - ${l.name} — ${l.category}${(l.city || l.country) ? ' · ' + [l.city, l.country].filter(Boolean).join(', ') : ''}${l.claimed ? ' ✓ verified' : ''}: ${siteUrl('/listing/' + l.slug)}`;
    const textParts = [];
    if (verified.length) textParts.push(`${verified.length} new verified ${verified.length === 1 ? 'company' : 'companies'} ${cadence.whenLabel}:\n${verified.map(rowLine).join('\n')}`);
    if (fresh.length) textParts.push(`Recently added to the ledger:\n${fresh.map(rowLine).join('\n')}`);
    await sendBranded(s.email, `${verified.length ? `${verified.length} new verified companies` : `${fresh.length} new companies`} ${cadence.whenLabel} — FirmLedger digest`, {
      kicker: cadence.display + ' digest',
      title: 'New on the ledger ' + cadence.whenLabel,
      preheader: 'Freshly verified companies and the latest additions to FirmLedger.',
      text: `New on the ledger ${cadence.whenLabel}\n\n${textParts.join('\n\n')}\n\nBrowse the directory: ${siteUrl('/directory?sort=newest')}\nUnsubscribe in one click: ${unsubUrl}`,
      paragraphs,
      cta: { label: 'Browse the full directory', url: siteUrl('/directory?sort=newest') },
      note: `You receive this because you subscribed to the FirmLedger digest. <a href="${unsubUrl}" style="color:#1D4ED8;">Unsubscribe in one click</a> anytime.`,
    }).then(() => { sent += 1; }).catch(() => {});
  }
  setSetting('newsletter_last_sent', new Date().toISOString());
  return { sent, reason: 'ok', verified: verified.length, fresh: fresh.length };
}

/* ---------------- Watchlist ---------------- */
function isWatched(userId, listingId) {
  return Boolean(db.prepare('SELECT id FROM favorites WHERE user_id=? AND listing_id=?').get(userId, listingId));
}
function toggleFavorite(userId, listingId) {
  const row = db.prepare('SELECT id FROM favorites WHERE user_id=? AND listing_id=?').get(userId, listingId);
  if (row) {
    db.prepare('DELETE FROM favorites WHERE id=?').run(row.id);
    return { watching: false };
  }
  db.prepare('INSERT OR IGNORE INTO favorites (user_id, listing_id) VALUES (?,?)').run(userId, listingId);
  return { watching: true };
}
function watchCount(userId) {
  return db.prepare('SELECT COUNT(*) c FROM favorites WHERE user_id=?').get(userId).c;
}

/** Branded digest to every watcher after a listing meaningfully changes. */
async function notifyWatchers(listingId, changes) {
  if (!changes || !changes.length) return;
  const l = db.prepare('SELECT id, name, slug, category, city, country FROM listings WHERE id=?').get(listingId);
  if (!l) return;
  const watchers = db.prepare(
    `SELECT u.email, u.name FROM favorites f JOIN users u ON u.id = f.user_id AND u.suspended=0 WHERE f.listing_id=?`
  ).all(listingId);
  if (!watchers.length) return;
  const place = [l.city, l.country].filter(Boolean).join(', ');
  const listHtml = '<ul style="margin:6px 0 0;padding-left:18px">' +
    changes.map((c) => `<li style="padding:2px 0">${c}</li>`).join('') + '</ul>';
  for (const w of watchers) {
    const changesPlain = changes.map((c) => c.replace(/<[^>]+>/g, ''));
    await sendBranded(w.email, `${l.name} updated its record — your watchlist`, {
      kicker: 'Watchlist update',
      title: `${escHtml(l.name)} changed on the ledger`,
      preheader: `A company on your FirmLedger watchlist updated its listing.`,
      text: `${l.name} changed on the ledger\n\n${w.name ? w.name.split(' ')[0] : 'there'} — ${l.name} (${l.category}${place ? ' · ' + place : ''}), which you follow on your watchlist, just updated its record:\n\n${changesPlain.map((c) => ' - ' + c).join('\n')}\n\nYou can review the refreshed profile below. If the listing drifted from what it should be, use the removal link at the bottom of its page and our moderation team will look.\n\n${l.name}: ${siteUrl(`/listing/${l.slug}`)}\nManage your watchlist: ${siteUrl('/dashboard/watchlist')}`,
      paragraphs: [
        `${escHtml(w.name ? w.name.split(' ')[0] : 'there')} — <b>${escHtml(l.name)}</b> (${escHtml(l.category)}${place ? ' · ' + escHtml(place) : ''}), which you follow on your watchlist, just updated its record:`,
        listHtml,
        'You can review the refreshed profile below. If the listing drifted from what it should be, use the removal link at the bottom of its page and our moderation team will look.',
      ],
      cta: { label: `View ${escHtml(l.name)}`, url: siteUrl(`/listing/${l.slug}`) },
      note: `Manage your full watchlist at <a href="${siteUrl('/dashboard/watchlist')}" style="color:#1D4ED8;">/dashboard/watchlist</a>.`,
    }).catch(() => {});
  }
}

/* ---------------- Jobs ---------------- */
const JOB_TYPES = ['Full-time', 'Part-time', 'Contract', 'Internship', 'Remote'];

function createJob(listing, userId, { title, role_type, location, apply_url, description }) {
  const t = String(title || '').trim().slice(0, 80);
  const type = JOB_TYPES.includes(role_type) ? role_type : 'Full-time';
  const loc = String(location || '').trim().slice(0, 80);
  const url = String(apply_url || '').trim().slice(0, 400);
  const desc = String(description || '').trim().slice(0, 600);
  const errors = [];
  if (t.length < 3) errors.push('Give the role a proper title (3+ characters).');
  if (!loc) errors.push('Location is required — city name or "Remote".');
  if (!url || !/^https?:\/\//i.test(url)) errors.push('Apply URL must be a full https:// link (job post or careers page).');
  if (!desc || desc.length < 30) errors.push('Add at least 30 characters describing the role.');
  if (errors.length) return { errors };
  if (db.prepare("SELECT id FROM jobs WHERE listing_id=? AND status='open'").all(listing.id).length >= 5) {
    return { errors: ['Each listing can keep up to 5 open positions — close one before posting another.'] };
  }
  const info = db.prepare(
    `INSERT INTO jobs (listing_id, owner_user_id, title, role_type, location, apply_url, description)
     VALUES (?,?,?,?,?,?,?)`
  ).run(listing.id, userId, t, type, loc, url, desc);
  return { id: info.lastInsertRowid, errors: [] };
}

function closeJob(jobId, userId) {
  db.prepare('UPDATE jobs SET status=\'closed\' WHERE id=? AND owner_user_id=?').run(jobId, userId);
}

function jobsForListing(listingId) {
  return db.prepare("SELECT * FROM jobs WHERE listing_id=? AND status='open' ORDER BY created_at DESC").all(listingId);
}

/* Board listing with search + filters. filters: { q, type, category, country, featured } */
function boardJobs(filters = {}) {
  const where = ["j.status='open'", "l.status='approved'"];
  const args = [];
  const q = String(filters.q || '').trim();
  if (q) {
    const like = `%${q.slice(0, 60)}%`;
    where.push('(j.title LIKE ? OR j.description LIKE ? OR l.name LIKE ?)');
    args.push(like, like, like);
  }
  const type = String(filters.type || '').trim();
  if (type && JOB_TYPES.includes(type)) { where.push('j.role_type = ?'); args.push(type); }
  const category = String(filters.category || '').trim();
  if (category) { where.push('l.category = ?'); args.push(category.slice(0, 60)); }
  const country = String(filters.country || '').trim();
  if (country) { where.push('l.country = ?'); args.push(country.slice(0, 60)); }
  if (filters.featured) where.push('j.featured = 1');
  const jobs = db.prepare(
    `SELECT j.*, l.name AS company, l.slug AS slug, l.logo_url, l.category, l.country, l.city, l.claimed
       FROM jobs j JOIN listings l ON l.id = j.listing_id
      WHERE ${where.join(' AND ')}
      ORDER BY j.featured DESC, j.created_at DESC LIMIT 200`
  ).all(...args);
  return jobs;
}

/* Facet options for the board filters (from currently open jobs only). */
function boardFacets() {
  return db.prepare(
    `SELECT DISTINCT l.category, l.country
       FROM jobs j JOIN listings l ON l.id = j.listing_id
      WHERE j.status='open' AND l.status='approved'`
  ).all();
}

module.exports = {
  subscribe, unsubscribe, subCount, weeklyRoundup, sendWeeklyDigest, sendSubscribeWelcome, digestCadence,
  isWatched, toggleFavorite, watchCount, notifyWatchers,
  JOB_TYPES, createJob, closeJob, jobsForListing, boardJobs, boardFacets,
};
