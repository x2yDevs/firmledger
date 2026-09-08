/**
 * Admin assistant tool registry — every action the admin console can take.
 *
 * Adding a tool: push an entry to TOOLS with { name, group, label, description,
 * parameters, mutating, sensitive, neverAuto, summarize, run }. Provider tool
 * schemas are derived automatically (src/lib/llm.js adapts them to OpenAI,
 * Anthropic and Gemini wire formats).
 *
 * Confirmation policy — three levels, evaluated by isAuto():
 *   read      (mutating:false)  runs immediately, never asks.
 *   write     (mutating:true)   asks first, unless the admin ticked it under
 *                               Settings → Auto-run.
 *   sensitive (sensitive:true)  ALWAYS asks. Deletions, bulk actions, anything
 *                               that mails every member, credentials, security
 *                               and site-wide switches. It cannot be auto-run.
 * `neverAuto` is the older spelling of the same rule and is honoured too.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('../db');
const { sendBranded, mailConfigured } = require('./mailer');
const mailer = require('./mailer');
const { submitForIndexing, getIndexNowKey } = require('./indexing');
const googleIndexing = require('./googleIndexing');
const { deleteLogo } = require('./upload');
const notify = require('./notify');
const { siteUrl, escHtml, normalizeUrl, slugify, randomToken, domainOf, confidenceScore, isEmail } = require('./util');
const catLib = require('./categories');
const plans = require('./plans');
const ad = require('./advertising');
const careers = require('./careers');
const backup = require('./backup');
const support = require('./support');
const promos = require('./promos');
const spam = require('./spam');
const mon = require('./statusMonitor');
const nl = require('./newsletter');
const health = require('./health');
const { runCheck } = require('./verify');
const { finalizeVerifiedClaim } = require('./claimflow');
const listingEvents = require('./listingevents');
const techrefresh = require('./techrefresh');
const news = require('./news');
const upkeep = require('./upkeep');
const indexlog = require('./indexlog');
const graphLib = require('./graph');
const notificationsLib = require('./notifications');
const sitecontext = require('./sitecontext');
const llm = require('./llm');
const paypal = require('./paypal');
const svc = require('./apilistings');
const { TYPES, SIZES } = require('./taxonomy');

/* Small safe-read helpers — a lookup tool must never throw at the model. */
function safeAll(sql, ...params) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}
function safeOne(sql, ...params) {
  try {
    const row = db.prepare(sql).get(...params);
    return row === undefined ? null : (row && Object.keys(row).length === 1 ? row[Object.keys(row)[0]] : row);
  } catch { return null; }
}
function safeCount(sql, ...params) {
  try { return db.prepare(sql).get(...params).c; } catch { return 0; }
}

/** A ticket by numeric id or by its FL-XXXX reference. */
function findTicket(idOrRef) {
  const raw = String(idOrRef || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return db.prepare('SELECT * FROM tickets WHERE id=?').get(Number(raw)) || null;
  return db.prepare('SELECT * FROM tickets WHERE ref=? COLLATE NOCASE').get(raw) || null;
}

/**
 * Insert a listing row the way Admin → Listings → Add does: unique slug,
 * confidence from the record, optional owner (which implies claimed),
 * sources stored as a JSON array. Returns the fresh row.
 */
function createListingRow(f, { status = 'pending', ownerId = null, sources = [], featured = 0 } = {}) {
  let slug = slugify(f.name) || 'listing';
  let n = 2;
  while (db.prepare('SELECT id FROM listings WHERE slug=?').get(slug)) slug = `${slugify(f.name)}-${n++}`;
  const confidence = confidenceScore(f);
  const srcList = Array.isArray(sources) ? sources.filter(Boolean) : [];
  const info = db.prepare(
    `INSERT INTO listings (slug, name, tagline, description, type, category, website, email, phone,
       country, city, region, address, logo_url, founded, size, tags, socials, sources, status,
       featured, claimed, confidence, owner_user_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    slug, f.name, f.tagline, f.description, f.type || 'company',
    catLib.ensure(f.category || 'Other').name,
    f.website, f.email || '', f.phone || '',
    f.country, f.city || '', f.region || '', f.address || '',
    f.logo_url || '', f.founded || '', f.size || '', f.tags || '',
    f.socials || '{}', JSON.stringify(srcList),
    status, featured ? 1 : 0, ownerId ? 1 : 0, confidence, ownerId || null,
  );
  const row = db.prepare('SELECT * FROM listings WHERE id=?').get(info.lastInsertRowid);
  listingEvents.fresh(row);
  try {
    notify.notifyAdmin({
      kind: 'listing',
      title: `New listing — ${row.name}`,
      body: status === 'pending' ? 'Added by the admin assistant, waiting for review.' : 'Added and published by the admin assistant.',
      url: status === 'pending' ? '/admin3119Musa/listings?status=pending' : `/listing/${row.slug}`,
    });
  } catch { /* notifications are best-effort */ }
  return row;
}

/**
 * Validate a From header: either "address" or "Display Name <address>".
 * Mail sent under a malformed From is rejected by most providers, so the
 * console refuses it instead of storing something that cannot send.
 */
function validFromAddress(raw) {
  const from = String(raw == null ? '' : raw).trim().slice(0, 200);
  if (!from) return { ok: true, from: '' };
  const addr = from.includes('<') ? from.replace(/^.*<([^>]*)>.*$/, '$1').trim() : from;
  if (!isEmail(addr)) return { ok: false, error: `"${from}" is not a valid From address. Use "address" or "Display Name <address>".` };
  return { ok: true, from };
}

/** Hand a freshly created pending listing to AI auto-moderation when it is on. */
function scheduleRowModeration(listingId) {
  try { require('./ai').scheduleModeration(listingId); } catch { /* moderation is best-effort */ }
}

function findListing(idOrSlug) {
  const raw = String(idOrSlug || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return db.prepare('SELECT * FROM listings WHERE id=?').get(Number(raw));
  return db.prepare('SELECT * FROM listings WHERE slug=? COLLATE NOCASE OR name=? COLLATE NOCASE').get(raw, raw);
}

function findUser(q) {
  const raw = String(q || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return db.prepare('SELECT * FROM users WHERE id=?').get(Number(raw));
  return db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(raw)
    || db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(raw)
    || db.prepare('SELECT * FROM users WHERE email LIKE ? OR name LIKE ? ORDER BY id DESC LIMIT 1')
      .get(`%${raw.replace(/[%_]/g, '')}%`, `%${raw.replace(/[%_]/g, '')}%`);
}

function approveListingRow(l) {
  const firstApproval = l.status !== 'approved';
  db.prepare("UPDATE listings SET status='approved', last_verified_at=?, updated_at=datetime('now') WHERE id=?")
    .run(new Date().toISOString(), l.id);
  if (firstApproval) listingEvents.approved(db.prepare('SELECT * FROM listings WHERE id=?').get(l.id), true);
  if (firstApproval) {
    const catSlug = (db.prepare('SELECT slug FROM categories WHERE name = ?').get(l.category) || {}).slug;
    submitForIndexing([`/listing/${l.slug}`, catSlug ? `/directory/c/${catSlug}` : null].filter(Boolean));
    googleIndexing.pingGoogleNewListingBackground(`/listing/${l.slug}`);
    if (l.owner_user_id) {
      notify.notifyUser(l.owner_user_id, {
        kind: 'listing',
        title: `${l.name} is live`,
        body: 'Your listing passed review and is now public in the directory.',
        url: `/listing/${l.slug}`,
      });
    }
  }
  return { id: l.id, slug: l.slug, name: l.name, firstApproval };
}

function rejectListingRow(l) {
  db.prepare("UPDATE listings SET status='rejected', updated_at=datetime('now') WHERE id=?").run(l.id);
  if (l.status !== 'rejected') listingEvents.rejected(db.prepare('SELECT * FROM listings WHERE id=?').get(l.id));
  if (l.owner_user_id) {
    notify.notifyUser(l.owner_user_id, {
      kind: 'listing',
      title: `${l.name} was not approved`,
      body: 'Update the listing and resubmit — common reasons are incomplete contact details or a duplicate record.',
      url: `/dashboard/listings/${l.id}/edit`,
    });
  }
  return { id: l.id, slug: l.slug, name: l.name };
}

function queueMail(recipients, subject, message) {
  const paragraphs = String(message).split(/\n\s*\n/).map((p) => escHtml(p).replace(/\n/g, '<br>')).filter(Boolean);
  const ins = db.prepare('INSERT INTO admin_mail_log (to_email, subject, body, delivered) VALUES (?,?,?,?)');
  setImmediate(async () => {
    for (const email of recipients) {
      try {
        const r = await sendBranded(email, `[FirmLedger] ${subject}`, {
          kicker: 'Announcement',
          title: escHtml(subject),
          preheader: subject,
          paragraphs,
          note: 'You received this because you hold a FirmLedger account.',
        });
        ins.run(email, subject, message, r.delivered ? 1 : 0);
      } catch {
        try { ins.run(email, subject, message, 0); } catch { /* ignore */ }
      }
    }
  });
  return {
    queued: recipients.length,
    smtp_configured: mailConfigured(),
    note: mailConfigured()
      ? `Queued branded email to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}.`
      : `No SMTP configured — ${recipients.length} message(s) will land in data/outbox.log.`,
  };
}

const GROUPS = [
  { id: 'site', label: 'Site understanding (always run, no confirm)' },
  { id: 'read', label: 'Lookups (always run, no confirm)' },
  { id: 'listings', label: 'Listings, news & technology' },
  { id: 'users', label: 'Users & billing' },
  { id: 'moderation', label: 'Claims, tickets, removals' },
  { id: 'content', label: 'Blog, email, careers, promos, advertising' },
  { id: 'ops', label: 'Site operations, protection, indexing, AI' },
];

/** Which tool groups the assistant may use. Empty/unset = everything. */
function enabledGroups() {
  let arr = [];
  try { arr = JSON.parse(getSetting('ai_tool_groups', '[]') || '[]'); } catch { arr = []; }
  if (!Array.isArray(arr) || !arr.length) return GROUPS.map((g) => g.id);
  const known = new Set(GROUPS.map((g) => g.id));
  const clean = [...new Set(arr.map(String).filter((g) => known.has(g)))];
  return clean.length ? clean : GROUPS.map((g) => g.id);
}

function saveEnabledGroups(groups) {
  const known = new Set(GROUPS.map((g) => g.id));
  const list = [...new Set((Array.isArray(groups) ? groups : [groups]).map(String).filter((g) => known.has(g)))];
  /* An empty selection would leave the assistant with no hands at all. */
  setSetting('ai_tool_groups', JSON.stringify(list.length ? list : GROUPS.map((g) => g.id)));
  return enabledGroups();
}

const TOOLS = [
  /* ---------------- Lookups ---------------- */
  {
    name: 'get_listing_stats', group: 'read', label: 'Platform stats', mutating: false,
    description: 'Return counts of listings by status, claimed, featured, plus user, ticket, claim, promo and incident totals. Use for “how many pending” and dashboard questions.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Read platform statistics.'; },
    run() {
      const row = (sql) => { try { return db.prepare(sql).get().c; } catch { return 0; } };
      return {
        pending: row("SELECT COUNT(*) c FROM listings WHERE status='pending'"),
        approved: row("SELECT COUNT(*) c FROM listings WHERE status='approved'"),
        rejected: row("SELECT COUNT(*) c FROM listings WHERE status='rejected'"),
        claimed: row('SELECT COUNT(*) c FROM listings WHERE claimed=1'),
        featured: row('SELECT COUNT(*) c FROM listings WHERE featured=1'),
        sponsored: row('SELECT COUNT(*) c FROM listings WHERE sponsored=1'),
        total_listings: row('SELECT COUNT(*) c FROM listings'),
        users: row('SELECT COUNT(*) c FROM users'),
        suspended_users: row('SELECT COUNT(*) c FROM users WHERE suspended=1'),
        open_tickets: row("SELECT COUNT(*) c FROM tickets WHERE status='open'"),
        pending_claims: row("SELECT COUNT(*) c FROM claims WHERE status='pending'"),
        pending_removals: row("SELECT COUNT(*) c FROM removal_requests WHERE status='pending'"),
        open_incidents: row("SELECT COUNT(*) c FROM incidents WHERE status<>'resolved'"),
        newsletter_subs: row('SELECT COUNT(*) c FROM newsletter_subscribers WHERE active=1'),
        maintenance_on: getSetting('maintenance_on', '0') === '1',
        ai_moderation_on: getSetting('ai_moderation_on', '0') === '1',
        auto_approve: getSetting('auto_approve', '0') === '1',
      };
    },
  },
  {
    name: 'get_health', group: 'read', label: 'Server health', mutating: false,
    description: 'Return process uptime, memory, and disk snapshot from Admin → Health.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Read server health snapshot.'; },
    run() {
      try { return health.snapshot(); } catch (e) { return { error: e.message }; }
    },
  },
  {
    name: 'search_listings', group: 'read', label: 'Search listings', mutating: false,
    description: 'Search listings by name, slug, website or email. Optional status: pending, approved, rejected.',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search text.' },
        status: { type: 'string', enum: ['pending', 'approved', 'rejected', ''], description: 'Optional status filter.' },
      },
      required: ['q'], additionalProperties: false,
    },
    summarize(a) { return `Search listings for “${a.q || ''}”${a.status ? ` (${a.status})` : ''}.`; },
    run(args) {
      const q = String(args.q || '').trim().slice(0, 80);
      if (q.length < 2) return { error: 'Search needs at least 2 characters.' };
      const like = `%${q.replace(/[%_]/g, '')}%`;
      const status = ['pending', 'approved', 'rejected'].includes(args.status) ? args.status : '';
      const sql = status
        ? `SELECT id, slug, name, status, category, country, website, featured, claimed, created_at FROM listings WHERE status=? AND (name LIKE ? OR slug LIKE ? OR website LIKE ? OR email LIKE ?) ORDER BY updated_at DESC LIMIT 25`
        : `SELECT id, slug, name, status, category, country, website, featured, claimed, created_at FROM listings WHERE name LIKE ? OR slug LIKE ? OR website LIKE ? OR email LIKE ? ORDER BY updated_at DESC LIMIT 25`;
      const rows = status ? db.prepare(sql).all(status, like, like, like, like) : db.prepare(sql).all(like, like, like, like);
      return { count: rows.length, listings: rows };
    },
  },
  {
    name: 'search_users', group: 'read', label: 'Search users', mutating: false,
    description: 'Look up users by email, name or numeric id. Returns plan, suspension and listing counts.',
    parameters: {
      type: 'object',
      properties: { q: { type: 'string', description: 'Email, name fragment or user id.' } },
      required: ['q'], additionalProperties: false,
    },
    summarize(a) { return `Look up user “${a.q || ''}”.`; },
    run(args) {
      const q = String(args.q || '').trim().slice(0, 80);
      if (q.length < 2 && !/^\d+$/.test(q)) return { error: 'Need at least 2 characters.' };
      if (/^\d+$/.test(q)) {
        const u = db.prepare(
          `SELECT u.id, u.email, u.name, u.plan, u.plan_expires_at, u.suspended, u.created_at,
                  (SELECT COUNT(*) FROM listings l WHERE l.owner_user_id=u.id) AS listings FROM users u WHERE u.id=?`
        ).get(Number(q));
        return u ? { count: 1, users: [u] } : { count: 0, users: [] };
      }
      const like = `%${q.replace(/[%_]/g, '')}%`;
      const users = db.prepare(
        `SELECT u.id, u.email, u.name, u.plan, u.plan_expires_at, u.suspended, u.created_at,
                (SELECT COUNT(*) FROM listings l WHERE l.owner_user_id=u.id) AS listings
         FROM users u WHERE u.email LIKE ? OR u.name LIKE ? ORDER BY u.created_at DESC LIMIT 15`
      ).all(like, like);
      return { count: users.length, users };
    },
  },
  {
    name: 'search_admin', group: 'read', label: 'Global admin search', mutating: false,
    description: 'Search across users, listings, tickets, claims and blog posts (same as Admin → Search).',
    parameters: {
      type: 'object',
      properties: { q: { type: 'string', description: 'Search text, 2+ characters.' } },
      required: ['q'], additionalProperties: false,
    },
    summarize(a) { return `Admin search “${a.q || ''}”.`; },
    run(args) {
      const q = String(args.q || '').trim().slice(0, 80);
      if (q.length < 2) return { error: 'Need at least 2 characters.' };
      const like = `%${q.replace(/[%_]/g, '')}%`;
      return {
        users: db.prepare('SELECT id, name, email, suspended FROM users WHERE name LIKE ? OR email LIKE ? LIMIT 10').all(like, like),
        listings: db.prepare('SELECT id, slug, name, status, category FROM listings WHERE name LIKE ? OR slug LIKE ? OR website LIKE ? LIMIT 10').all(like, like, like),
        tickets: db.prepare('SELECT id, ref, subject, status FROM tickets WHERE ref LIKE ? OR subject LIKE ? LIMIT 10').all(like, like),
        claims: db.prepare('SELECT id, status, domain FROM claims WHERE domain LIKE ? LIMIT 10').all(like),
        posts: db.prepare('SELECT id, slug, title, status FROM blog_posts WHERE title LIKE ? OR slug LIKE ? LIMIT 8').all(like, like),
      };
    },
  },
  {
    name: 'list_open_tickets', group: 'read', label: 'Open tickets', mutating: false,
    description: 'List open support tickets with subject, user email and last update.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'List open support tickets.'; },
    run() {
      const rows = db.prepare(
        `SELECT t.id, t.ref, t.subject, t.status, t.category, t.updated_at, u.email AS user_email
         FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.status='open' ORDER BY t.updated_at DESC LIMIT 30`
      ).all();
      return { count: rows.length, tickets: rows };
    },
  },
  {
    name: 'list_pending_claims', group: 'read', label: 'Pending claims', mutating: false,
    description: 'List ownership claims waiting for review.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'List pending ownership claims.'; },
    run() {
      const rows = db.prepare(
        `SELECT c.id, c.method, c.domain, c.status, c.created_at, l.name AS listing_name, l.slug, u.email AS user_email
         FROM claims c JOIN listings l ON l.id=c.listing_id JOIN users u ON u.id=c.user_id
         WHERE c.status='pending' ORDER BY c.created_at DESC LIMIT 30`
      ).all();
      return { count: rows.length, claims: rows };
    },
  },
  {
    name: 'list_pending_removals', group: 'read', label: 'Pending removals', mutating: false,
    description: 'List listing-removal requests waiting for a moderator.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'List pending removal requests.'; },
    run() {
      const rows = db.prepare(
        `SELECT r.id, r.name, r.email, r.reason, r.created_at, l.name AS listing_name, l.slug, l.id AS listing_id
         FROM removal_requests r LEFT JOIN listings l ON l.id=r.listing_id
         WHERE r.status='pending' ORDER BY r.created_at DESC LIMIT 30`
      ).all();
      return { count: rows.length, removals: rows };
    },
  },

  /* ---------------- Listings ---------------- */
  {
    name: 'approve_listing', group: 'listings', label: 'Approve listing', mutating: true,
    description: 'Approve a single listing by numeric id or slug so it goes live.',
    parameters: {
      type: 'object',
      properties: { id_or_slug: { type: 'string', description: 'Listing id or slug.' } },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `Approve listing ${a.id_or_slug}.`; },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      return { ok: true, ...approveListingRow(l), status: 'approved' };
    },
  },
  {
    name: 'reject_listing', group: 'listings', label: 'Reject listing', mutating: true,
    description: 'Reject a single listing by numeric id or slug.',
    parameters: {
      type: 'object',
      properties: { id_or_slug: { type: 'string', description: 'Listing id or slug.' } },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `Reject listing ${a.id_or_slug}.`; },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      return { ok: true, ...rejectListingRow(l), status: 'rejected' };
    },
  },
  {
    name: 'accept_all_pending_listings', group: 'listings', label: 'Approve ALL pending', mutating: true, sensitive: true,
    description: 'Approve every listing currently in pending review. Use only when the admin explicitly asks to accept all pending.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Approve ALL listings currently pending review.'; },
    run() {
      const rows = db.prepare("SELECT * FROM listings WHERE status='pending'").all();
      const approved = [];
      for (const l of rows) { approveListingRow(l); approved.push({ id: l.id, slug: l.slug, name: l.name }); }
      return { approved: approved.length, listings: approved };
    },
  },
  {
    name: 'refresh_listing_tech', group: 'listings', label: 'Refresh technology radar', mutating: true,
    description: 'Re-scan one listing\'s public homepage and refresh its technology radar (frameworks, CMS, payments, analytics, hosting) plus the hiring link. Same action as Admin → Listings → ↻ Tech. Bulk/whole-directory refreshes stay in the console UI.',
    parameters: {
      type: 'object',
      properties: { id_or_slug: { type: 'string', description: 'Listing id or slug.' } },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `Refresh the technology radar for ${a.id_or_slug}.`; },
    async run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      const r = await techrefresh.refreshOne(l.id);
      if (!r.ok) {
        return { error: r.skipped === 'no-website'
          ? `${l.name} has no website — add one before scanning.`
          : 'That listing could not be refreshed.' };
      }
      const row = db.prepare('SELECT tech_checked_at, hiring_url FROM listings WHERE id=?').get(l.id);
      return {
        ok: true, id: l.id, name: l.name, slug: l.slug,
        technologies: r.count, tech: r.tech, changed: r.changed,
        before: r.before, scanned_at: row.tech_checked_at, hiring_url: row.hiring_url || '',
      };
    },
  },
  {
    name: 'approve_news', group: 'moderation', label: 'Approve news story', mutating: true,
    description: 'Approve a submitted news story (by id) so it appears on the listing profile. Rejected and already-published stories cannot be approved twice.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'News story id (Admin → News shows it).' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Approve news story #${a.id}.`; },
    run(args) {
      const r = news.approve(args.id, 'assistant');
      if (!r.ok) return { error: r.error };
      const n = db.prepare('SELECT * FROM listing_news WHERE id=?').get(r.id);
      return { ok: true, id: n.id, title: n.title, listing_id: n.listing_id, status: n.status };
    },
  },
  {
    name: 'reject_news', group: 'moderation', label: 'Reject news story', mutating: true,
    description: 'Reject a submitted news story (by id) — it stays out of the public profile and the submitter is told.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'News story id (Admin → News shows it).' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Reject news story #${a.id}.`; },
    run(args) {
      const r = news.reject(args.id, 'assistant');
      if (!r.ok) return { error: r.error };
      const n = db.prepare('SELECT * FROM listing_news WHERE id=?').get(r.id);
      return { ok: true, id: n.id, title: n.title, listing_id: n.listing_id, status: n.status };
    },
  },
  {
    name: 'delete_listing', group: 'listings', label: 'Delete listing', mutating: true, sensitive: true,
    description: 'Permanently delete a listing by id or slug. Cannot be undone.',
    parameters: {
      type: 'object',
      properties: { id_or_slug: { type: 'string', description: 'Listing id or slug.' } },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `PERMANENTLY delete listing ${a.id_or_slug}.`; },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      deleteLogo(l.logo_url);
      const tx = db.transaction(() => {
        for (const t of ['listing_events', 'jobs', 'favorites', 'removal_requests', 'payments']) {
          try { db.prepare(`DELETE FROM ${t} WHERE listing_id=?`).run(l.id); } catch { /* ignore */ }
        }
        try { db.prepare('DELETE FROM relationships WHERE listing_id=? OR target_listing_id=?').run(l.id, l.id); } catch { /* ignore */ }
        db.prepare('DELETE FROM listings WHERE id=?').run(l.id);
      });
      tx();
      return { ok: true, deleted: { id: l.id, slug: l.slug, name: l.name } };
    },
  },
  {
    name: 'feature_listing', group: 'listings', label: 'Feature listing', mutating: true,
    description: 'Set or toggle the featured flag on a listing (homepage featured strip).',
    parameters: {
      type: 'object',
      properties: {
        id_or_slug: { type: 'string' },
        featured: { type: 'boolean', description: 'true to feature, false to unfeature. Omit to toggle.' },
      },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) {
      if (a.featured === true) return `Mark listing ${a.id_or_slug} as featured.`;
      if (a.featured === false) return `Unfeature listing ${a.id_or_slug}.`;
      return `Toggle featured on ${a.id_or_slug}.`;
    },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      const next = args.featured === true ? 1 : args.featured === false ? 0 : (l.featured ? 0 : 1);
      db.prepare('UPDATE listings SET featured=? WHERE id=?').run(next, l.id);
      return { ok: true, id: l.id, name: l.name, featured: Boolean(next) };
    },
  },
  {
    name: 'set_listing_owner', group: 'listings', label: 'Set listing owner', mutating: true, sensitive: true,
    description: 'Transfer listing ownership to a user (email or id), or pass empty user to unclaim.',
    parameters: {
      type: 'object',
      properties: {
        id_or_slug: { type: 'string' },
        user: { type: 'string', description: 'User email or id. Empty string removes the owner.' },
      },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `Set owner of ${a.id_or_slug} to ${a.user || '(none)'}.`; },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      const q = String(args.user || '').trim();
      if (!q) {
        db.prepare('UPDATE listings SET owner_user_id=NULL, claimed=0 WHERE id=?').run(l.id);
        return { ok: true, listing: l.name, owner: null, claimed: false };
      }
      const u = findUser(q);
      if (!u) return { error: 'No user matches that email or id.' };
      db.prepare('UPDATE listings SET owner_user_id=? WHERE id=?').run(u.id, l.id);
      notify.notifyUser(u.id, {
        kind: 'listing',
        title: `You now own “${l.name}”`,
        body: 'An administrator transferred ownership of this listing to you.',
        url: `/dashboard/listings/${l.id}/edit`,
      });
      return { ok: true, listing: l.name, owner: u.email, user_id: u.id };
    },
  },
  {
    name: 'grant_listing_pro', group: 'listings', label: 'Grant listing Pro boost', mutating: true,
    description: 'Grant a listing-level Pro boost. days=30 default, or lifetime=true.',
    parameters: {
      type: 'object',
      properties: {
        id_or_slug: { type: 'string' },
        days: { type: 'integer', description: 'Duration in days (ignored if lifetime).' },
        lifetime: { type: 'boolean' },
      },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return a.lifetime ? `Lifetime Pro boost on ${a.id_or_slug}.` : `Pro boost ${a.days || 30} days on ${a.id_or_slug}.`; },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      if (args.lifetime) {
        db.prepare("UPDATE listings SET plan='pro', plan_expires_at='' WHERE id=?").run(l.id);
        return { ok: true, name: l.name, plan: 'pro', expires: 'lifetime' };
      }
      const days = Math.max(1, Math.min(3650, Number(args.days) || 30));
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const cur = l.plan === 'pro' && l.plan_expires_at && l.plan_expires_at >= today ? new Date(l.plan_expires_at) : now;
      const expiry = new Date(Math.max(cur.getTime(), now.getTime()) + days * 864e5).toISOString().slice(0, 10);
      db.prepare("UPDATE listings SET plan='pro', plan_expires_at=? WHERE id=?").run(expiry, l.id);
      return { ok: true, name: l.name, plan: 'pro', expires: expiry, days };
    },
  },
  {
    name: 'revoke_listing_pro', group: 'listings', label: 'Revoke listing Pro boost', mutating: true,
    description: 'Remove listing-level Pro. Account Pro on the owner is unchanged.',
    parameters: {
      type: 'object',
      properties: { id_or_slug: { type: 'string' } },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `Revoke listing Pro on ${a.id_or_slug}.`; },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      db.prepare("UPDATE listings SET plan='free', plan_expires_at='' WHERE id=?").run(l.id);
      return { ok: true, name: l.name, plan: 'free' };
    },
  },
  {
    name: 'sponsor_listing', group: 'listings', label: 'Sponsor listing', mutating: true,
    description: 'Grant sponsored placement. days number or lifetime=true.',
    parameters: {
      type: 'object',
      properties: {
        id_or_slug: { type: 'string' },
        days: { type: 'integer' },
        lifetime: { type: 'boolean' },
      },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `Sponsor ${a.id_or_slug}${a.lifetime ? ' (lifetime)' : ` for ${a.days || 30} days`}.`; },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      const r = ad.grantSponsorship(l.id, args.lifetime ? null : (parseInt(args.days, 10) || 30), 'ai');
      return r.ok ? r : { error: r.error || 'Could not sponsor.' };
    },
  },
  {
    name: 'unsponsor_listing', group: 'listings', label: 'Remove sponsorship', mutating: true,
    description: 'Remove sponsored placement from a listing.',
    parameters: {
      type: 'object',
      properties: { id_or_slug: { type: 'string' } },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `Unsponsor ${a.id_or_slug}.`; },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      const r = ad.revokeSponsorship(l.id);
      return r.ok ? r : { error: r.error || 'Could not unsponsor.' };
    },
  },
  {
    name: 'create_category', group: 'listings', label: 'Create category', mutating: true,
    description: 'Add a directory category (duplicates merge automatically).',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'], additionalProperties: false,
    },
    summarize(a) { return `Create category “${a.name}”.`; },
    run(args) {
      const r = catLib.ensure(String(args.name || ''));
      return { ok: true, name: r.name, created: r.created };
    },
  },
  {
    name: 'rename_category', group: 'listings', label: 'Rename category', mutating: true,
    description: 'Rename a category and move its listings.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Current category name.' },
        to: { type: 'string', description: 'New name.' },
      },
      required: ['from', 'to'], additionalProperties: false,
    },
    summarize(a) { return `Rename category “${a.from}” → “${a.to}”.`; },
    run(args) {
      const from = String(args.from || '').trim();
      const to = String(args.to || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const cat = db.prepare('SELECT * FROM categories WHERE name = ? COLLATE NOCASE').get(from);
      if (!cat) return { error: `No category named “${from}”.` };
      if (!to) return { error: 'New name required.' };
      const clash = db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND id <> ?').get(to, cat.id);
      if (clash) return { error: `“${to}” already exists — merge instead of renaming.` };
      const slug = slugify(to);
      const slugClash = db.prepare('SELECT id FROM categories WHERE slug = ? AND id <> ?').get(slug, cat.id);
      db.prepare('UPDATE listings SET category=? WHERE category=?').run(to, cat.name);
      db.prepare('UPDATE categories SET name=?, slug=? WHERE id=?').run(to, slugClash ? cat.slug : slug, cat.id);
      return { ok: true, from: cat.name, to };
    },
  },
  {
    name: 'delete_category', group: 'listings', label: 'Delete category', mutating: true, sensitive: true,
    description: 'Delete a category. Listings move to Other.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'], additionalProperties: false,
    },
    summarize(a) { return `Delete category “${a.name}” (listings → Other).`; },
    run(args) {
      const cat = db.prepare('SELECT * FROM categories WHERE name = ? COLLATE NOCASE').get(String(args.name || '').trim());
      if (!cat) return { error: 'Category not found.' };
      const inUse = catLib.usageCount(cat.name);
      db.prepare("UPDATE listings SET category='Other' WHERE category=?").run(cat.name);
      catLib.ensure('Other');
      db.prepare('DELETE FROM categories WHERE id=?').run(cat.id);
      return { ok: true, deleted: cat.name, moved: inUse };
    },
  },

  /* ---------------- Users & billing ---------------- */
  {
    name: 'suspend_user', group: 'users', label: 'Suspend user', mutating: true,
    description: 'Suspend a user by email or id. Sessions are revoked.',
    parameters: {
      type: 'object',
      properties: { user: { type: 'string', description: 'Email or user id.' } },
      required: ['user'], additionalProperties: false,
    },
    summarize(a) { return `Suspend user ${a.user}.`; },
    run(args) {
      const u = findUser(args.user);
      if (!u) return { error: 'No user matches that email or id.' };
      db.prepare('UPDATE users SET suspended=1 WHERE id=?').run(u.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
      sendBranded(u.email, 'Your FirmLedger account has been suspended', {
        kicker: 'Account notice', title: 'Your account is suspended',
        preheader: 'Your FirmLedger account has been suspended.',
        alert: 'Your FirmLedger account has been suspended. Active sessions were signed out.',
        alertTone: 'warn',
        paragraphs: ['If you believe this is an error, contact support@firmledger.co.ke.'],
      }).catch(() => {});
      return { ok: true, email: u.email, suspended: true };
    },
  },
  {
    name: 'unsuspend_user', group: 'users', label: 'Reinstate user', mutating: true,
    description: 'Lift a user suspension.',
    parameters: {
      type: 'object',
      properties: { user: { type: 'string' } },
      required: ['user'], additionalProperties: false,
    },
    summarize(a) { return `Reinstate user ${a.user}.`; },
    run(args) {
      const u = findUser(args.user);
      if (!u) return { error: 'No user matches that email or id.' };
      db.prepare('UPDATE users SET suspended=0 WHERE id=?').run(u.id);
      sendBranded(u.email, 'Your FirmLedger account has been reinstated', {
        kicker: 'Account notice', title: 'Welcome back',
        preheader: 'Your FirmLedger account suspension has been lifted.',
        alert: 'Your account suspension has been lifted.',
        alertTone: 'ok',
        paragraphs: ['You can sign in again as normal.'],
        cta: { label: 'Sign in', url: siteUrl('/login') },
      }).catch(() => {});
      return { ok: true, email: u.email, suspended: false };
    },
  },
  {
    name: 'delete_user', group: 'users', label: 'Delete user account', mutating: true, sensitive: true, neverAuto: true,
    description: 'Permanently delete a user and personal data. Listings stay on the ledger unclaimed. Always requires confirmation.',
    parameters: {
      type: 'object',
      properties: { user: { type: 'string' } },
      required: ['user'], additionalProperties: false,
    },
    summarize(a) { return `PERMANENTLY delete user ${a.user}.`; },
    run(args) {
      const u = findUser(args.user);
      if (!u) return { error: 'No user matches that email or id.' };
      sendBranded(u.email, 'Your FirmLedger account has been deleted', {
        kicker: 'Account deleted', title: 'Your account has been deleted',
        preheader: 'Your FirmLedger account was permanently removed.',
        alert: 'Your FirmLedger account has been permanently deleted.',
        alertTone: 'warn',
        paragraphs: ['Listings you submitted remain as factual records with your name removed as owner.'],
      }).catch(() => {});
      db.prepare("UPDATE deletion_requests SET status='completed', resolved_at=datetime('now') WHERE user_id=? AND status='pending'").run(u.id);
      const r = backup.deleteUserCascade(u.id);
      return r.ok ? { ok: true, email: r.email, name: r.name } : { error: r.error };
    },
  },
  {
    name: 'grant_user_pro', group: 'users', label: 'Grant account Pro', mutating: true,
    description: 'Grant FirmLedger Pro to a user. days=30 default, or lifetime=true.',
    parameters: {
      type: 'object',
      properties: {
        user: { type: 'string' },
        days: { type: 'integer' },
        lifetime: { type: 'boolean' },
      },
      required: ['user'], additionalProperties: false,
    },
    summarize(a) { return a.lifetime ? `Lifetime Pro for ${a.user}.` : `Grant Pro (${a.days || 30} days) to ${a.user}.`; },
    run(args) {
      const u = findUser(args.user);
      if (!u) return { error: 'No user matches that email or id.' };
      const r = plans.grantUserPro(u.id, args.lifetime ? null : (Number(args.days) || 30));
      const expiry = r && r.expiry ? r.expiry.toISOString().slice(0, 10) : null;
      sendBranded(u.email, "You've been upgraded to FirmLedger Pro", {
        kicker: 'Pro activated', title: 'Welcome to FirmLedger Pro',
        preheader: 'FirmLedger Pro is now active on your account.',
        alert: expiry ? `Pro is active until <b>${expiry}</b>.` : '<b>Lifetime</b> Pro is active.',
        alertTone: 'ok',
        paragraphs: ['Every listing in the directory is fully unlocked for you.'],
        cta: { label: 'Explore the directory', url: siteUrl('/directory') },
      }).catch(() => {});
      return { ok: true, email: u.email, expires: expiry || 'lifetime' };
    },
  },
  {
    name: 'revoke_user_pro', group: 'users', label: 'Revoke account Pro', mutating: true, sensitive: true,
    description: 'Revoke account-level FirmLedger Pro.',
    parameters: {
      type: 'object',
      properties: { user: { type: 'string' } },
      required: ['user'], additionalProperties: false,
    },
    summarize(a) { return `Revoke Pro for ${a.user}.`; },
    run(args) {
      const u = findUser(args.user);
      if (!u) return { error: 'No user matches that email or id.' };
      plans.revokeUserPro(u.id);
      sendBranded(u.email, 'Your FirmLedger Pro access has ended', {
        kicker: 'Plan update', title: 'Your Pro access has ended',
        preheader: 'FirmLedger Pro access on your account has ended.',
        alert: 'Your account is back on the Free plan.',
        alertTone: 'info',
        paragraphs: ['Upgrade again any time from /pricing.'],
        cta: { label: 'Upgrade to Pro', url: siteUrl('/dashboard/upgrade') },
      }).catch(() => {});
      return { ok: true, email: u.email, plan: 'free' };
    },
  },
  {
    name: 'grant_trial', group: 'users', label: 'Grant free trial', mutating: true,
    description: 'Start a Pro free trial on an account. days 1–90, default 14.',
    parameters: {
      type: 'object',
      properties: {
        user: { type: 'string' },
        days: { type: 'integer' },
      },
      required: ['user'], additionalProperties: false,
    },
    summarize(a) { return `Grant ${a.days || 14}-day trial to ${a.user}.`; },
    run(args) {
      const u = findUser(args.user);
      if (!u) return { error: 'No user matches that email or id.' };
      const r = plans.startTrial(u.id, Number(args.days) || plans.TRIAL_DEFAULT_DAYS);
      if (!r.ok) return { error: r.error };
      notify.notifyUser(u.id, {
        kind: 'billing',
        title: `Your ${r.days}-day FirmLedger Pro trial is active`,
        body: `It runs until ${String(r.expiresAt).slice(0, 10)}.`,
        url: '/dashboard/upgrade',
      });
      return { ok: true, email: u.email, days: r.days, expires: r.expiresAt };
    },
  },
  {
    name: 'revoke_trial', group: 'users', label: 'Revoke free trial', mutating: true,
    description: 'End a running free trial.',
    parameters: {
      type: 'object',
      properties: { user: { type: 'string' } },
      required: ['user'], additionalProperties: false,
    },
    summarize(a) { return `Revoke trial for ${a.user}.`; },
    run(args) {
      const u = findUser(args.user);
      if (!u) return { error: 'No user matches that email or id.' };
      const r = plans.revokeTrial(u.id);
      return r.ok ? { ok: true, email: u.email } : { error: r.error };
    },
  },
  {
    name: 'send_password_reset', group: 'users', label: 'Email password reset', mutating: true,
    description: 'Email a one-hour password-reset link to a user.',
    parameters: {
      type: 'object',
      properties: { user: { type: 'string' } },
      required: ['user'], additionalProperties: false,
    },
    summarize(a) { return `Email a password reset to ${a.user}.`; },
    run(args) {
      const u = findUser(args.user);
      if (!u) return { error: 'No user matches that email or id.' };
      const token = randomToken(32);
      const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      db.prepare('DELETE FROM resets WHERE email=?').run(u.email);
      db.prepare('INSERT INTO resets (email, token, expires_at) VALUES (?,?,?)').run(u.email, token, expires);
      const url = siteUrl('/reset/' + token);
      sendBranded(u.email, 'Reset your FirmLedger password', {
        kicker: 'Password reset', title: 'Reset your password',
        preheader: 'An administrator started a password reset.',
        alert: 'A FirmLedger administrator started a password reset. The link is valid for 1 hour.',
        alertTone: 'warn',
        paragraphs: ['If you did not expect this, ignore the email — your current password stays the same.'],
        cta: { label: 'Choose a new password', url },
      }).catch(() => {});
      notify.notifyUser(u.id, {
        kind: 'account', title: 'Password reset sent',
        body: 'An administrator emailed you a one-hour reset link.', url: '/login',
      });
      return { ok: true, email: u.email };
    },
  },
  {
    name: 'create_plan_offer', group: 'users', label: 'Create plan offer', mutating: true,
    description: 'Create a pricing offer (name, price_usd, duration_days, optional blurb).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        price_usd: { type: 'number' },
        duration_days: { type: 'integer' },
        blurb: { type: 'string' },
      },
      required: ['name', 'price_usd', 'duration_days'], additionalProperties: false,
    },
    summarize(a) { return `Create plan “${a.name}” at $${a.price_usd} / ${a.duration_days} days.`; },
    run(args) {
      const name = String(args.name || '').trim().slice(0, 60);
      const price = Number(args.price_usd);
      const days = Math.round(Number(args.duration_days));
      if (!name) return { error: 'The offer needs a name.' };
      if (!(price > 0) || price > 1e6) return { error: 'Enter a valid price above 0.' };
      if (!(days >= 1) || days > 3650) return { error: 'Duration must be 1–3650 days.' };
      const sort = (plans.allPlans(false).length || 0) + 1;
      db.prepare('INSERT INTO plans (name, blurb, price_cents, currency, duration_days, active, sort) VALUES (?,?,?,?,?,1,?)')
        .run(name, String(args.blurb || '').trim().slice(0, 240), Math.round(price * 100), 'USD', days, sort);
      return { ok: true, name, price_usd: price, duration_days: days };
    },
  },
  {
    name: 'toggle_plan_offer', group: 'users', label: 'Toggle plan offer', mutating: true,
    description: 'Show or hide a pricing offer by numeric id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Toggle plan offer #${a.id}.`; },
    run(args) {
      const p = plans.getPlan(args.id);
      if (!p) return { error: 'Offer not found.' };
      db.prepare('UPDATE plans SET active=? WHERE id=?').run(p.active ? 0 : 1, p.id);
      return { ok: true, id: p.id, name: p.name, active: !p.active };
    },
  },
  {
    name: 'approve_pro_transfer', group: 'users', label: 'Approve Pro transfer', mutating: true,
    description: 'Approve a pending listing-scoped Pro transfer request by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Approve Pro transfer #${a.id}.`; },
    run(args) {
      const r = db.prepare('SELECT * FROM pro_transfer_requests WHERE id=?').get(Number(args.id));
      if (!r || r.status !== 'pending') return { error: 'No pending transfer with that id.' };
      const from = db.prepare('SELECT * FROM listings WHERE id=?').get(r.from_listing_id);
      const to = db.prepare('SELECT * FROM listings WHERE id=?').get(r.to_listing_id);
      if (!from || !to) {
        db.prepare("UPDATE pro_transfer_requests SET status='rejected', resolved_at=datetime('now') WHERE id=?").run(r.id);
        return { error: 'One of the listings is gone — request closed.' };
      }
      db.prepare('UPDATE listings SET plan=?, plan_expires_at=? WHERE id=?').run(from.plan, from.plan_expires_at, to.id);
      db.prepare("UPDATE listings SET plan='free', plan_expires_at='' WHERE id=?").run(from.id);
      db.prepare("UPDATE pro_transfer_requests SET status='approved', resolved_at=datetime('now') WHERE id=?").run(r.id);
      notify.notifyUser(r.user_id, {
        kind: 'pro', title: 'Listing Pro transferred',
        body: `Remaining Pro time moved from ${from.name} onto ${to.name}.`,
        url: `/dashboard/listings/${to.id}/edit`,
      });
      return { ok: true, from: from.name, to: to.name };
    },
  },
  {
    name: 'reject_pro_transfer', group: 'users', label: 'Reject Pro transfer', mutating: true,
    description: 'Decline a pending listing-scoped Pro transfer request by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Reject Pro transfer #${a.id}.`; },
    run(args) {
      const r = db.prepare('SELECT * FROM pro_transfer_requests WHERE id=?').get(Number(args.id));
      if (!r || r.status !== 'pending') return { error: 'No pending transfer with that id.' };
      db.prepare("UPDATE pro_transfer_requests SET status='rejected', resolved_at=datetime('now') WHERE id=?").run(r.id);
      notify.notifyUser(r.user_id, {
        kind: 'pro', title: 'Pro transfer was declined',
        body: 'Admin declined moving remaining listing-scoped Pro.', url: '/dashboard',
      });
      return { ok: true, id: r.id };
    },
  },

  /* ---------------- Claims / tickets / removals ---------------- */
  {
    name: 'recheck_claim', group: 'moderation', label: 'Recheck claim', mutating: true,
    description: 'Re-run ownership verification for a pending claim by id. Approves if the check passes.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Recheck claim #${a.id}.`; },
    async run(args) {
      const c = db.prepare('SELECT * FROM claims WHERE id=?').get(Number(args.id));
      if (!c || c.status !== 'pending') return { error: 'No pending claim with that id.' };
      const result = await runCheck(c.method, c.domain, c.token);
      if (result.ok) {
        const l = db.prepare('SELECT * FROM listings WHERE id=?').get(c.listing_id);
        const u = db.prepare('SELECT * FROM users WHERE id=?').get(c.user_id);
        if (l && u) finalizeVerifiedClaim(c, l, u);
        return { ok: true, verified: true, detail: result.detail };
      }
      return { ok: true, verified: false, detail: result.detail };
    },
  },
  {
    name: 'reject_claim', group: 'moderation', label: 'Reject claim', mutating: true,
    description: 'Reject a pending ownership claim by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Reject claim #${a.id}.`; },
    run(args) {
      const c = db.prepare('SELECT * FROM claims WHERE id=?').get(Number(args.id));
      if (!c) return { error: 'Claim not found.' };
      db.prepare("UPDATE claims SET status='rejected' WHERE id=?").run(c.id);
      const u = db.prepare('SELECT id, name, email FROM users WHERE id=?').get(c.user_id);
      const l = db.prepare('SELECT name FROM listings WHERE id=?').get(c.listing_id);
      if (u) {
        sendBranded(u.email, `Ownership claim update — ${l ? l.name : 'your listing'}`, {
          kicker: 'Claim review', title: 'Your ownership claim was not verified',
          preheader: 'Your ownership claim could not be verified.',
          alert: `Your ownership claim for <b>${l ? escHtml(l.name) : 'the listing'}</b> could not be verified.`,
          alertTone: 'warn',
          paragraphs: ['Submit a fresh claim from your dashboard after placing the verification token.'],
          cta: { label: 'Submit a new claim', url: siteUrl('/dashboard/claims') },
        }).catch(() => {});
        notify.notifyUser(u.id, {
          kind: 'claim', title: 'Ownership claim was not verified',
          body: l ? `Your claim on ${l.name} could not be verified.` : 'Your ownership claim could not be verified.',
          url: '/dashboard',
        });
      }
      return { ok: true, id: c.id, status: 'rejected' };
    },
  },
  {
    name: 'reply_ticket', group: 'moderation', label: 'Reply to ticket', mutating: true,
    description: 'Post an admin reply on a support ticket (id or ref like FL-xxxx).',
    parameters: {
      type: 'object',
      properties: {
        id_or_ref: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['id_or_ref', 'message'], additionalProperties: false,
    },
    summarize(a) { return `Reply on ticket ${a.id_or_ref}.`; },
    run(args) {
      const raw = String(args.id_or_ref || '').trim();
      const t = /^\d+$/.test(raw)
        ? db.prepare('SELECT * FROM tickets WHERE id=?').get(Number(raw))
        : db.prepare('SELECT * FROM tickets WHERE ref=? COLLATE NOCASE').get(raw);
      if (!t) return { error: 'Ticket not found.' };
      const body = String(args.message || '').trim();
      if (body.length < 2) return { error: 'Write a reply first.' };
      support.reply(t.id, 'admin', body, '', '');
      notify.notifyUser(t.user_id, {
        kind: 'ticket', title: `Reply on ticket ${t.ref}`,
        body: body.length > 180 ? body.slice(0, 180) + '…' : body,
        url: `/dashboard/support/${t.id}`,
      });
      return { ok: true, id: t.id, ref: t.ref };
    },
  },
  {
    name: 'set_ticket_status', group: 'moderation', label: 'Set ticket status', mutating: true,
    description: 'Set a ticket to open, solved or closed (id or ref).',
    parameters: {
      type: 'object',
      properties: {
        id_or_ref: { type: 'string' },
        status: { type: 'string', enum: ['open', 'solved', 'closed'] },
      },
      required: ['id_or_ref', 'status'], additionalProperties: false,
    },
    summarize(a) { return `Mark ticket ${a.id_or_ref} as ${a.status}.`; },
    run(args) {
      const raw = String(args.id_or_ref || '').trim();
      const t = /^\d+$/.test(raw)
        ? db.prepare('SELECT * FROM tickets WHERE id=?').get(Number(raw))
        : db.prepare('SELECT * FROM tickets WHERE ref=? COLLATE NOCASE').get(raw);
      if (!t) return { error: 'Ticket not found.' };
      const status = String(args.status || '');
      if (!['open', 'solved', 'closed'].includes(status)) return { error: 'Status must be open, solved or closed.' };
      support.setStatus(t.id, status);
      if (status === 'solved') {
        notify.notifyUser(t.user_id, {
          kind: 'ticket', title: `Ticket ${t.ref} marked Solved`,
          body: 'Reply any time if something else comes up — the ticket reopens.',
          url: `/dashboard/support/${t.id}`,
        });
      } else if (status === 'closed') {
        notify.notifyUser(t.user_id, {
          kind: 'ticket', title: `Ticket ${t.ref} was closed`,
          body: 'Open a fresh ticket for a new issue.', url: '/dashboard/support',
        });
      }
      return { ok: true, id: t.id, ref: t.ref, status };
    },
  },
  {
    name: 'dismiss_removal', group: 'moderation', label: 'Dismiss removal request', mutating: true,
    description: 'Dismiss a listing-removal request without deleting the listing.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Dismiss removal request #${a.id}.`; },
    run(args) {
      const r = db.prepare('SELECT * FROM removal_requests WHERE id=?').get(Number(args.id));
      if (!r) return { error: 'Removal request not found.' };
      db.prepare("UPDATE removal_requests SET status='dismissed', resolved_at=datetime('now') WHERE id=?").run(r.id);
      return { ok: true, id: r.id, status: 'dismissed' };
    },
  },
  {
    name: 'fulfill_removal', group: 'moderation', label: 'Remove listing from request', mutating: true, sensitive: true,
    description: 'Delete the listing attached to a removal request and mark the request resolved.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Fulfill removal #${a.id} (delete the listing).`; },
    run(args) {
      const r = db.prepare('SELECT * FROM removal_requests WHERE id=?').get(Number(args.id));
      if (!r) return { error: 'Removal request not found.' };
      const l = db.prepare('SELECT * FROM listings WHERE id=?').get(r.listing_id);
      /* Resolve the request first, then drop the listing: the FK sets listing_id
         to NULL, so the request survives as a "removed" audit record. */
      db.prepare("UPDATE removal_requests SET status='removed', resolved_at=datetime('now') WHERE id=?").run(r.id);
      if (l) {
        deleteLogo(l.logo_url);
        db.prepare('DELETE FROM listings WHERE id=?').run(l.id);
      }
      return { ok: true, id: r.id, listing: l ? l.name : null, status: 'removed' };
    },
  },

  /* ---------------- Content ---------------- */
  {
    name: 'email_users', group: 'content', label: 'Email members', mutating: true, sensitive: true,
    description: 'Email an audience: all, pro, free, newsletter, or a single email. Subject and message required.',
    parameters: {
      type: 'object',
      properties: {
        audience: { type: 'string', description: 'all | pro | free | newsletter | a specific email' },
        subject: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['audience', 'subject', 'message'], additionalProperties: false,
    },
    summarize(a) { return `Email ${a.audience}: “${String(a.subject || '').slice(0, 80)}”.`; },
    run(args) {
      const subject = String(args.subject || '').trim().slice(0, 200);
      const message = String(args.message || '').trim().slice(0, 10000);
      if (!subject) return { error: 'A subject is required.' };
      if (message.length < 10) return { error: 'Write a message of at least 10 characters.' };
      const to = String(args.audience || 'all').trim().toLowerCase();
      const today = new Date().toISOString().slice(0, 10);
      const proSql = "(plan='pro' AND (plan_expires_at IS NULL OR plan_expires_at='' OR plan_expires_at >= ?))";
      let recipients = [];
      if (to === 'all') recipients = db.prepare('SELECT email FROM users').all().map((u) => u.email);
      else if (to === 'pro') recipients = db.prepare(`SELECT email FROM users WHERE ${proSql}`).all(today).map((u) => u.email);
      else if (to === 'free') recipients = db.prepare(`SELECT email FROM users WHERE NOT ${proSql}`).all(today).map((u) => u.email);
      else if (to === 'newsletter') recipients = db.prepare('SELECT email FROM newsletter_subscribers WHERE active=1').all().map((n) => n.email);
      else {
        const u = db.prepare('SELECT email FROM users WHERE email=?').get(to);
        const n = u ? null : db.prepare('SELECT email FROM newsletter_subscribers WHERE email=? AND active=1').get(to);
        if (!u && !n) return { error: 'Unknown audience. Use all, pro, free, newsletter, or an email.' };
        recipients = [(u || n).email];
      }
      if (!recipients.length) return { error: 'That audience is empty right now.' };
      return queueMail(recipients, subject, message);
    },
  },
  {
    name: 'email_all_users', group: 'content', label: 'Email ALL users', mutating: true, sensitive: true,
    description: 'Email every registered user. Prefer email_users with audience=all. Subject and message required.',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['subject', 'message'], additionalProperties: false,
    },
    summarize(a) { return `Email ALL users: “${String(a.subject || '').slice(0, 80)}”.`; },
    run(args) {
      return TOOLS.find((t) => t.name === 'email_users').run({ audience: 'all', subject: args.subject, message: args.message });
    },
  },
  {
    name: 'create_blog_post', group: 'content', label: 'Create blog post', mutating: true,
    description: 'Create a blog post. status draft or published.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        excerpt: { type: 'string' },
        body: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
        slug: { type: 'string' },
      },
      required: ['title', 'body'], additionalProperties: false,
    },
    summarize(a) { return `Create blog post “${a.title}” (${a.status || 'draft'}).`; },
    run(args) {
      const title = String(args.title || '').trim().slice(0, 200);
      if (!title) return { error: 'Title required.' };
      let slug = String(args.slug || title).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
      if (db.prepare('SELECT id FROM blog_posts WHERE slug=?').get(slug)) slug = `${slug}-${Date.now().toString(36)}`;
      const status = args.status === 'published' ? 'published' : 'draft';
      db.prepare(
        "INSERT INTO blog_posts (slug, title, excerpt, body, status, published_at) VALUES (?,?,?,?,?, CASE WHEN ?='published' THEN datetime('now') ELSE NULL END)"
      ).run(slug, title, String(args.excerpt || '').trim().slice(0, 400), String(args.body || '').trim(), status, status);
      return { ok: true, slug, title, status };
    },
  },
  {
    name: 'toggle_blog_post', group: 'content', label: 'Publish/unpublish post', mutating: true,
    description: 'Flip a blog post between draft and published (id or slug).',
    parameters: {
      type: 'object',
      properties: { id_or_slug: { type: 'string' } },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `Toggle blog post ${a.id_or_slug}.`; },
    run(args) {
      const raw = String(args.id_or_slug || '').trim();
      const p = /^\d+$/.test(raw)
        ? db.prepare('SELECT * FROM blog_posts WHERE id=?').get(Number(raw))
        : db.prepare('SELECT * FROM blog_posts WHERE slug=?').get(raw);
      if (!p) return { error: 'Post not found.' };
      db.prepare(
        `UPDATE blog_posts SET status = CASE status WHEN 'published' THEN 'draft' ELSE 'published' END,
           published_at = CASE WHEN status<>'published' AND published_at IS NULL THEN datetime('now') ELSE published_at END WHERE id=?`
      ).run(p.id);
      const fresh = db.prepare('SELECT id, slug, title, status FROM blog_posts WHERE id=?').get(p.id);
      return { ok: true, ...fresh };
    },
  },
  {
    name: 'delete_blog_post', group: 'content', label: 'Delete blog post', mutating: true, sensitive: true,
    description: 'Delete a blog post by id or slug.',
    parameters: {
      type: 'object',
      properties: { id_or_slug: { type: 'string' } },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `Delete blog post ${a.id_or_slug}.`; },
    run(args) {
      const raw = String(args.id_or_slug || '').trim();
      const p = /^\d+$/.test(raw)
        ? db.prepare('SELECT * FROM blog_posts WHERE id=?').get(Number(raw))
        : db.prepare('SELECT * FROM blog_posts WHERE slug=?').get(raw);
      if (!p) return { error: 'Post not found.' };
      db.prepare('DELETE FROM blog_posts WHERE id=?').run(p.id);
      return { ok: true, deleted: p.title, slug: p.slug };
    },
  },
  {
    name: 'create_promo', group: 'content', label: 'Create promo code', mutating: true,
    description: 'Create a percent-off promo code (1–90). Optional max_uses and expires_at (YYYY-MM-DD).',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        percent: { type: 'integer' },
        max_uses: { type: 'integer' },
        expires_at: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['code', 'percent'], additionalProperties: false,
    },
    summarize(a) { return `Create promo ${a.code} (${a.percent}% off).`; },
    run(args) {
      const r = promos.create({
        code: args.code, percent: args.percent, maxUses: args.max_uses,
        expiresAt: args.expires_at, note: args.note,
      });
      return r.ok ? r : { error: r.error };
    },
  },
  {
    name: 'toggle_promo', group: 'content', label: 'Toggle promo code', mutating: true,
    description: 'Activate or deactivate a promo by code or id.',
    parameters: {
      type: 'object',
      properties: {
        code_or_id: { type: 'string' },
        on: { type: 'boolean' },
      },
      required: ['code_or_id'], additionalProperties: false,
    },
    summarize(a) { return `Toggle promo ${a.code_or_id}.`; },
    run(args) {
      const raw = String(args.code_or_id || '').trim();
      const p = /^\d+$/.test(raw)
        ? db.prepare('SELECT * FROM promo_codes WHERE id=?').get(Number(raw))
        : promos.getByCode(raw);
      if (!p) return { error: 'Promo not found.' };
      const on = args.on === undefined ? !p.active : Boolean(args.on);
      promos.setActive(p.id, on);
      return { ok: true, code: p.code, active: on };
    },
  },
  {
    name: 'create_career', group: 'content', label: 'Post a career role', mutating: true,
    description: 'Publish a FirmLedger careers role. Requires title, location, description, requirements.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        location: { type: 'string' },
        description: { type: 'string' },
        requirements: { type: 'string' },
        role_type: { type: 'string', description: 'Full-time, Part-time, Contract, Internship, Remote' },
        apply_email: { type: 'string' },
      },
      required: ['title', 'location', 'description', 'requirements'], additionalProperties: false,
    },
    summarize(a) { return `Post career “${a.title}” in ${a.location}.`; },
    run(args) {
      const r = careers.create(args);
      return r.ok ? { ok: true, id: r.id, title: args.title } : { error: (r.errors || []).join(' ') };
    },
  },
  {
    name: 'toggle_career', group: 'content', label: 'Open/close career', mutating: true,
    description: 'Toggle a careers role between open and closed by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Toggle career #${a.id}.`; },
    run(args) {
      const r = careers.toggleStatus(args.id);
      return r ? { ok: true, id: r.id, title: r.title, status: r.status } : { error: 'Role not found.' };
    },
  },

  /* ---------------- Ops ---------------- */
  {
    name: 'set_maintenance_mode', group: 'ops', label: 'Maintenance mode', mutating: true, sensitive: true,
    description: 'Turn the public maintenance holding page on or off. Admins stay signed in.',
    parameters: {
      type: 'object',
      properties: {
        on: { type: 'boolean' },
        title: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['on'], additionalProperties: false,
    },
    summarize(a) { return a.on ? 'Turn maintenance mode ON.' : 'Turn maintenance mode OFF.'; },
    run(args) {
      const on = Boolean(args.on);
      setSetting('maintenance_on', on ? '1' : '0');
      if (args.title) setSetting('maintenance_title', String(args.title).trim().slice(0, 120));
      if (args.message) setSetting('maintenance_message', String(args.message).trim().slice(0, 2000));
      return {
        maintenance_on: on,
        title: getSetting('maintenance_title', "We'll be back soon"),
        message: getSetting('maintenance_message', ''),
      };
    },
  },
  {
    name: 'set_auto_approve', group: 'ops', label: 'Simple auto-approve', mutating: true,
    description: 'Enable or disable simple auto-approve (new listings go live without review). Independent of AI auto-moderation.',
    parameters: {
      type: 'object',
      properties: { on: { type: 'boolean' } },
      required: ['on'], additionalProperties: false,
    },
    summarize(a) { return a.on ? 'Enable simple auto-approve.' : 'Disable simple auto-approve.'; },
    run(args) {
      setSetting('auto_approve', args.on ? '1' : '0');
      return { auto_approve: getSetting('auto_approve', '0') === '1' };
    },
  },
  {
    name: 'set_ai_moderation', group: 'ops', label: 'AI auto-moderation', mutating: true,
    description: 'Enable or disable AI auto-moderation of newly submitted listings.',
    parameters: {
      type: 'object',
      properties: { on: { type: 'boolean' } },
      required: ['on'], additionalProperties: false,
    },
    summarize(a) { return a.on ? 'Enable AI auto-moderation.' : 'Disable AI auto-moderation.'; },
    run(args) {
      setSetting('ai_moderation_on', args.on ? '1' : '0');
      return { ai_moderation_on: getSetting('ai_moderation_on', '0') === '1' };
    },
  },
  {
    name: 'set_indexing', group: 'ops', label: 'Search indexing', mutating: true,
    description: 'Enable or disable IndexNow / search-engine pings.',
    parameters: {
      type: 'object',
      properties: { on: { type: 'boolean' } },
      required: ['on'], additionalProperties: false,
    },
    summarize(a) { return a.on ? 'Enable search indexing.' : 'Disable search indexing.'; },
    run(args) {
      setSetting('indexing_enabled', args.on ? '1' : '0');
      return { indexing_enabled: getSetting('indexing_enabled', '1') === '1' };
    },
  },
  {
    name: 'set_newsletter_cadence', group: 'ops', label: 'Digest cadence', mutating: true,
    description: 'Set newsletter digest cadence: daily, weekly or monthly.',
    parameters: {
      type: 'object',
      properties: { cadence: { type: 'string', enum: ['daily', 'weekly', 'monthly'] } },
      required: ['cadence'], additionalProperties: false,
    },
    summarize(a) { return `Set digest cadence to ${a.cadence}.`; },
    run(args) {
      const c = String(args.cadence || '').trim();
      if (!['daily', 'weekly', 'monthly'].includes(c)) return { error: 'Cadence must be daily, weekly or monthly.' };
      setSetting('newsletter_cadence', c);
      return { cadence: c };
    },
  },
  {
    name: 'send_newsletter_digest', group: 'ops', label: 'Send digest now', mutating: true, sensitive: true,
    description: 'Force-send the newsletter digest to active subscribers.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Force-send the newsletter digest.'; },
    async run() {
      const r = await nl.sendWeeklyDigest(true).catch((e) => ({ sent: 0, reason: 'error', error: e.message }));
      if (r.reason === 'ok') return { ok: true, sent: r.sent, verified: r.verified, fresh: r.fresh };
      return { error: r.error || r.reason || 'Digest not sent.' };
    },
  },
  {
    name: 'block_ip', group: 'ops', label: 'Block or allow IP', mutating: true, sensitive: true,
    description: 'Add an IP to the protection allow or block list. kind=block (default) or allow.',
    parameters: {
      type: 'object',
      properties: {
        ip: { type: 'string' },
        kind: { type: 'string', enum: ['block', 'allow'] },
        note: { type: 'string' },
      },
      required: ['ip'], additionalProperties: false,
    },
    summarize(a) { return `${a.kind === 'allow' ? 'Allow' : 'Block'} IP ${a.ip}.`; },
    run(args) {
      const r = spam.addIp(args.ip, args.kind === 'allow' ? 'allow' : 'block', args.note);
      return r.ok ? { ok: true, ip: args.ip, kind: args.kind === 'allow' ? 'allow' : 'block' } : { error: r.error };
    },
  },
  {
    name: 'block_domain', group: 'ops', label: 'Block or allow email domain', mutating: true, sensitive: true,
    description: 'Add an email domain to the protection allow or block list.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        kind: { type: 'string', enum: ['block', 'allow'] },
        note: { type: 'string' },
      },
      required: ['domain'], additionalProperties: false,
    },
    summarize(a) { return `${a.kind === 'allow' ? 'Allow' : 'Block'} domain ${a.domain}.`; },
    run(args) {
      const r = spam.addDomain(args.domain, args.kind === 'allow' ? 'allow' : 'block', args.note);
      return r.ok ? { ok: true, domain: args.domain, kind: args.kind === 'allow' ? 'allow' : 'block' } : { error: r.error };
    },
  },
  {
    name: 'create_incident', group: 'ops', label: 'Open status incident', mutating: true,
    description: 'Open a public status incident. status investigating/identified/monitoring, severity minor/major/critical.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        severity: { type: 'string', enum: ['minor', 'major', 'critical'] },
        status: { type: 'string', enum: ['investigating', 'identified', 'monitoring'] },
      },
      required: ['title'], additionalProperties: false,
    },
    summarize(a) { return `Open incident “${a.title}”.`; },
    run(args) {
      const r = mon.createIncident({
        title: args.title, description: args.description || '',
        status: args.status || 'investigating', severity: args.severity || 'minor',
      });
      if (!r.ok) return { error: r.error };
      return { ok: true, id: r.id, title: args.title };
    },
  },
  {
    name: 'update_incident', group: 'ops', label: 'Update status incident', mutating: true,
    description: 'Post an update on an incident by id.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        message: { type: 'string' },
        status: { type: 'string', enum: ['investigating', 'identified', 'monitoring', 'resolved'] },
      },
      required: ['id', 'message'], additionalProperties: false,
    },
    summarize(a) { return `Update incident #${a.id}.`; },
    run(args) {
      const r = mon.addIncidentUpdate(args.id, { status: args.status, message: args.message });
      return r.ok ? { ok: true, id: r.incident && r.incident.id, status: r.incident && r.incident.status } : { error: r.error };
    },
  },
  {
    name: 'resolve_incident', group: 'ops', label: 'Resolve incident', mutating: true,
    description: 'Mark a status incident resolved.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Resolve incident #${a.id}.`; },
    run(args) {
      const r = mon.resolveIncident(args.id);
      return r.ok ? { ok: true, id: r.incident && r.incident.id } : { error: r.error };
    },
  },
  {
    name: 'mark_admin_notifications_read', group: 'ops', label: 'Mark inbox read', mutating: true,
    description: 'Mark every admin console notification as read.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Mark all admin notifications read.'; },
    run() {
      notify.markAllRead({ audience: 'admin' });
      return { ok: true };
    },
  },

  /* ==========================================================================
   * Site understanding — the assistant reads the site itself, not a summary
   * somebody wrote once. These are lookups: they never mutate, never confirm.
   * ======================================================================== */
  {
    name: 'site_overview', group: 'site', label: 'Explain this site', mutating: false,
    description: 'Explain FirmLedger itself: the product, business rules (duplicates, Pro, claims, verification, indexing, email-vs-in-app), the admin console page map, the public URL map, the data model, the live counters, or the settings inventory. topic: product | rules | admin | public | data | schema | live | settings | tools.',
    parameters: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'product, rules, admin, public, data, schema, live, settings or tools. Omit for the whole briefing.' } },
      additionalProperties: false,
    },
    summarize(a) { return a.topic ? `Read the site briefing (${a.topic}).` : 'Read the full site briefing.'; },
    run(args) {
      const topic = String(args.topic || '').trim().toLowerCase();
      if (!topic) {
        return {
          briefing: sitecontext.context({ compact: true }).slice(0, 20000),
          topics: sitecontext.TOPICS,
          note: 'Ask again with a topic for the full detail (schema returns every column).',
        };
      }
      const out = sitecontext.topic(topic);
      if (out.topic === 'index') return { error: out.note, topics: out.topics };
      return out;
    },
  },
  {
    name: 'get_site_schema', group: 'site', label: 'Database schema', mutating: false,
    description: 'Read the live SQLite schema: every table with its row count and column list. Pass tables to narrow it (comma or space separated, partial names match).',
    parameters: {
      type: 'object',
      properties: {
        tables: { type: 'string', description: 'Optional filter, e.g. "listings users payments".' },
        with_columns: { type: 'boolean', description: 'Default true.' },
      },
      additionalProperties: false,
    },
    summarize(a) { return `Read the database schema${a.tables ? ` for ${a.tables}` : ''}.`; },
    run(args) {
      const dm = sitecontext.dataModel({ tables: args.tables, withColumns: args.with_columns !== false });
      return { tables: dm.count, schema: dm.tables };
    },
  },
  {
    name: 'get_settings', group: 'site', label: 'Site settings', mutating: false,
    description: 'Read the current configuration: feature flags (maintenance, auto-approve, AI moderation, indexing, upkeep, PayPal mode, SMTP) and every stored setting. Secrets are reported as set/not-set only, never their values.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Read the site settings inventory.'; },
    run() {
      return { flags: sitecontext.flagsSnapshot(), settings: sitecontext.settingsInventory() };
    },
  },
  {
    name: 'query_database', group: 'site', label: 'Read-only SQL', mutating: false,
    description: 'Run a READ-ONLY SQL query against the live database (SELECT or WITH … SELECT only; one statement; a LIMIT is added when missing). Use it for any lookup the dedicated tools do not cover — joins, aggregates, date ranges, exports of counts. Writes are refused here; use the matching action tool instead so the operator can confirm it.',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single SELECT statement.' },
        limit: { type: 'integer', description: 'Row cap, default 25, maximum 200.' },
      },
      required: ['sql'], additionalProperties: false,
    },
    summarize(a) { return `Run read-only SQL: ${String(a.sql || '').replace(/\s+/g, ' ').slice(0, 120)}`; },
    run(args) {
      const cap = Math.max(1, Math.min(200, Number(args.limit) || 25));
      let sql = String(args.sql || '').replace(/\s+/g, ' ').trim();
      if (!sql) return { error: 'Send a SELECT statement.' };
      sql = sql.replace(/;\s*$/, '');
      if (sql.includes(';')) return { error: 'One statement at a time.' };
      if (!/^(select|with)\s/i.test(sql)) return { error: 'Read-only: the statement must start with SELECT or WITH.' };
      const banned = /\b(insert|update|delete|drop|alter|create|attach|detach|replace|truncate|vacuum|reindex|pragma|grant|revoke|begin|commit|rollback|savepoint|load_extension)\b/i;
      if (banned.test(sql)) return { error: 'Read-only: that statement contains a write or a database command. Use the matching action tool.' };
      if (!/\blimit\b/i.test(sql)) sql = `${sql} LIMIT ${cap}`;
      let rows;
      try {
        rows = db.prepare(sql).all();
      } catch (e) {
        return { error: `SQLite: ${String(e.message || e).slice(0, 300)}` };
      }
      return {
        count: rows.length,
        columns: rows.length ? Object.keys(rows[0]) : [],
        rows: rows.slice(0, cap),
        truncated: rows.length > cap,
      };
    },
  },

  /* ==========================================================================
   * Lookups — one read tool per console list, so the assistant never guesses
   * an id, a slug, an email or a count.
   * ======================================================================== */
  {
    name: 'get_listing', group: 'read', label: 'Listing detail', mutating: false,
    description: 'Full detail for one listing (id or slug): every stored field, the owner, timeline events, relationship graph, technology radar, news, payments and any open claim or removal request.',
    parameters: {
      type: 'object',
      properties: { id_or_slug: { type: 'string' } },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `Open listing ${a.id_or_slug}.`; },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      const owner = l.owner_user_id
        ? db.prepare('SELECT id, email, name, plan, suspended FROM users WHERE id=?').get(l.owner_user_id) : null;
      const submitter = l.submitter_user_id
        ? db.prepare('SELECT id, email, name FROM users WHERE id=?').get(l.submitter_user_id) : null;
      let sources = []; let socials = {}; let tech = [];
      try { sources = JSON.parse(l.sources || '[]'); } catch { sources = []; }
      try { socials = JSON.parse(l.socials || '{}'); } catch { socials = {}; }
      try { tech = techrefresh.parseTech(l.tech); } catch { tech = []; }
      return {
        ok: true,
        listing: {
          id: l.id, slug: l.slug, name: l.name, tagline: l.tagline, description: l.description,
          type: l.type, category: l.category, website: l.website, email: l.email, phone: l.phone,
          country: l.country, city: l.city, region: l.region, address: l.address,
          logo_url: l.logo_url, founded: l.founded, size: l.size, tags: l.tags,
          socials, sources, status: l.status, featured: Boolean(l.featured), claimed: Boolean(l.claimed),
          confidence: l.confidence, plan: l.plan, plan_expires_at: l.plan_expires_at,
          sponsored: Boolean(l.sponsored), sponsored_expires_at: l.sponsored_expires_at,
          ad_reference: l.ad_reference, hiring_url: l.hiring_url,
          tech, tech_checked_at: l.tech_checked_at, news_checked_at: l.news_checked_at,
          last_verified_at: l.last_verified_at, created_at: l.created_at, updated_at: l.updated_at,
          url: siteUrl(`/listing/${l.slug}`),
        },
        owner, submitter,
        events: db.prepare('SELECT * FROM listing_events WHERE listing_id=? ORDER BY event_date DESC').all(l.id),
        relationships: db.prepare('SELECT * FROM relationships WHERE listing_id=? ORDER BY id').all(l.id),
        news: news.allFor(l.id).slice(0, 12),
        payments: db.prepare('SELECT id, reference, amount, currency, status, kind, created_at FROM payments WHERE listing_id=? ORDER BY id DESC LIMIT 10').all(l.id),
        claims: db.prepare('SELECT id, user_id, method, domain, status, created_at FROM claims WHERE listing_id=? ORDER BY id DESC LIMIT 5').all(l.id),
        removals: db.prepare('SELECT id, name, email, reason, status, created_at FROM removal_requests WHERE listing_id=? ORDER BY id DESC LIMIT 5').all(l.id),
        watchers: safeCount('SELECT COUNT(*) c FROM favorites WHERE listing_id=?', l.id),
      };
    },
  },
  {
    name: 'get_user', group: 'read', label: 'Member detail', mutating: false,
    description: 'Full context for one account (email, name or id): plan and trial state, listings owned and submitted, claims, tickets, payments, sessions, notifications and any pending deletion request. Password hashes and tokens are never returned.',
    parameters: {
      type: 'object',
      properties: { user: { type: 'string', description: 'Email, name or numeric id.' } },
      required: ['user'], additionalProperties: false,
    },
    summarize(a) { return `Open the account ${a.user}.`; },
    run(args) {
      const u = findUser(args.user);
      if (!u) return { error: 'No user matches that email, name or id.' };
      return {
        ok: true,
        user: {
          id: u.id, email: u.email, name: u.name, role: u.role, suspended: Boolean(u.suspended),
          plan: u.plan, plan_expires_at: u.plan_expires_at, subscription_status: u.subscription_status,
          trial_started_at: u.trial_started_at, trial_expires_at: u.trial_expires_at, trial_days: u.trial_days,
          signup_provider: u.provider || 'email', created_at: u.created_at,
          status_label: plans.statusOf(u),
          pro_active: plans.isProUser(u),
          totp_enrolled: Boolean(safeOne('SELECT enabled FROM user_totp WHERE user_id=?', u.id)),
        },
        listings_owned: db.prepare('SELECT id, slug, name, status, claimed, confidence FROM listings WHERE owner_user_id=? ORDER BY id DESC').all(u.id),
        listings_submitted: safeCount('SELECT COUNT(*) c FROM listings WHERE submitter_user_id=?', u.id),
        claims: db.prepare('SELECT c.id, c.status, c.method, c.domain, l.name AS listing FROM claims c LEFT JOIN listings l ON l.id=c.listing_id WHERE c.user_id=? ORDER BY c.id DESC LIMIT 10').all(u.id),
        tickets: db.prepare('SELECT id, ref, subject, status, updated_at FROM tickets WHERE user_id=? ORDER BY id DESC LIMIT 10').all(u.id),
        payments: db.prepare('SELECT id, reference, amount, currency, status, created_at FROM payments WHERE user_id=? ORDER BY id DESC LIMIT 10').all(u.id),
        sessions: safeCount('SELECT COUNT(*) c FROM sessions WHERE user_id=?', u.id),
        unread_notifications: safeCount("SELECT COUNT(*) c FROM notifications WHERE audience='user' AND user_id=? AND deleted_at IS NULL AND (read_at IS NULL OR read_at='')", u.id),
        pending_deletion: db.prepare("SELECT id, reason, created_at FROM deletion_requests WHERE user_id=? AND status='pending' ORDER BY id DESC LIMIT 1").get(u.id) || null,
      };
    },
  },
  {
    name: 'list_listings', group: 'read', label: 'Browse listings', mutating: false,
    description: 'Browse the ledger with the same filters as Admin → Listings: status, category, country, type, claimed, featured, sponsored, plan, plus free text. Sorted and paged.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'approved', 'rejected', ''] },
        category: { type: 'string' }, country: { type: 'string' }, type: { type: 'string' },
        q: { type: 'string', description: 'Free text across name, slug, website, email.' },
        claimed: { type: 'boolean' }, featured: { type: 'boolean' }, sponsored: { type: 'boolean' },
        plan: { type: 'string', enum: ['free', 'pro', ''] },
        sort: { type: 'string', enum: ['newest', 'oldest', 'name', 'confidence', 'updated'] },
        limit: { type: 'integer', description: 'Default 25, max 100.' },
        offset: { type: 'integer' },
      },
      additionalProperties: false,
    },
    summarize(a) {
      const bits = [a.status, a.category, a.country, a.type, a.plan].filter(Boolean);
      return `Browse listings${bits.length ? ` (${bits.join(', ')})` : ''}${a.q ? ` matching “${a.q}”` : ''}.`;
    },
    run(args) {
      const where = []; const params = [];
      if (['pending', 'approved', 'rejected'].includes(args.status)) { where.push('status=?'); params.push(args.status); }
      if (args.category) { where.push('category=? COLLATE NOCASE'); params.push(String(args.category).trim()); }
      if (args.country) { where.push('country LIKE ?'); params.push(`%${String(args.country).trim().replace(/[%_]/g, '')}%`); }
      if (args.type) { where.push('type=?'); params.push(String(args.type).trim().toLowerCase()); }
      if (args.plan === 'pro' || args.plan === 'free') { where.push("plan=?"); params.push(args.plan); }
      if (args.claimed === true || args.claimed === false) { where.push('claimed=?'); params.push(args.claimed ? 1 : 0); }
      if (args.featured === true || args.featured === false) { where.push('featured=?'); params.push(args.featured ? 1 : 0); }
      if (args.sponsored === true || args.sponsored === false) { where.push('sponsored=?'); params.push(args.sponsored ? 1 : 0); }
      if (args.q) {
        const like = `%${String(args.q).trim().slice(0, 80).replace(/[%_]/g, '')}%`;
        where.push('(name LIKE ? OR slug LIKE ? OR website LIKE ? OR email LIKE ? OR tags LIKE ?)');
        params.push(like, like, like, like, like);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const order = {
        newest: 'id DESC', oldest: 'id ASC', name: 'name COLLATE NOCASE ASC',
        confidence: 'confidence DESC, id DESC', updated: "datetime(updated_at) DESC, id DESC",
      }[args.sort] || 'id DESC';
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 25));
      const offset = Math.max(0, Number(args.offset) || 0);
      const rows = db.prepare(
        `SELECT id, slug, name, status, type, category, country, city, website, confidence, featured, claimed, sponsored, plan, owner_user_id, created_at, updated_at
         FROM listings ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`
      ).all(...params, limit, offset);
      const total = db.prepare(`SELECT COUNT(*) c FROM listings ${clause}`).get(...params).c;
      return { count: rows.length, total, limit, offset, has_more: offset + rows.length < total, listings: rows };
    },
  },
  {
    name: 'list_users', group: 'read', label: 'Browse members', mutating: false,
    description: 'Browse accounts with the Admin → Users filters: plan, suspended, trialing, owners of listings, plus free text on email or name.',
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        plan: { type: 'string', enum: ['free', 'pro', ''] },
        suspended: { type: 'boolean' },
        trialing: { type: 'boolean' },
        with_listings: { type: 'boolean' },
        sort: { type: 'string', enum: ['newest', 'oldest', 'email', 'plan'] },
        limit: { type: 'integer' }, offset: { type: 'integer' },
      },
      additionalProperties: false,
    },
    summarize(a) {
      const bits = [a.plan, a.suspended === true ? 'suspended' : '', a.trialing === true ? 'trialing' : ''].filter(Boolean);
      return `Browse members${bits.length ? ` (${bits.join(', ')})` : ''}${a.q ? ` matching “${a.q}”` : ''}.`;
    },
    run(args) {
      const where = []; const params = [];
      if (args.q) {
        const like = `%${String(args.q).trim().slice(0, 80).replace(/[%_]/g, '')}%`;
        where.push('(u.email LIKE ? OR u.name LIKE ?)'); params.push(like, like);
      }
      if (args.plan === 'pro') { where.push("u.plan='pro'"); }
      if (args.plan === 'free') { where.push("u.plan<>'pro'"); }
      if (args.suspended === true) where.push('u.suspended=1');
      if (args.suspended === false) where.push('u.suspended=0');
      if (args.trialing === true) where.push("u.subscription_status='trialing'");
      if (args.with_listings === true) where.push('EXISTS (SELECT 1 FROM listings l WHERE l.owner_user_id=u.id)');
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const order = { newest: 'u.id DESC', oldest: 'u.id ASC', email: 'u.email COLLATE NOCASE', plan: "u.plan DESC, u.id DESC" }[args.sort] || 'u.id DESC';
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 25));
      const offset = Math.max(0, Number(args.offset) || 0);
      const rows = db.prepare(
        `SELECT u.id, u.email, u.name, u.role, u.plan, u.plan_expires_at, u.subscription_status, u.suspended, u.created_at,
                (SELECT COUNT(*) FROM listings l WHERE l.owner_user_id=u.id) AS listings
         FROM users u ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`
      ).all(...params, limit, offset);
      const total = db.prepare(`SELECT COUNT(*) c FROM users u ${clause}`).get(...params).c;
      return { count: rows.length, total, limit, offset, has_more: offset + rows.length < total, users: rows };
    },
  },
  {
    name: 'list_categories', group: 'read', label: 'Categories', mutating: false,
    description: 'List directory categories with listing counts and how many listings use each (Admin → Categories).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'List the directory categories.'; },
    run() {
      const rows = catLib.withCounts().map((c) => ({ ...c, in_use: catLib.usageCount(c.name) }));
      return { count: rows.length, categories: rows };
    },
  },
  {
    name: 'list_blog_posts', group: 'read', label: 'Blog posts', mutating: false,
    description: 'List blog posts (Admin → Blog) with status. Optional status filter and free text.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['published', 'draft', ''] },
        q: { type: 'string' }, limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    summarize(a) { return `List blog posts${a.status ? ` (${a.status})` : ''}.`; },
    run(args) {
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
      let rows = db.prepare('SELECT id, slug, title, excerpt, status, published_at, created_at, updated_at FROM blog_posts ORDER BY created_at DESC LIMIT ?').all(limit);
      if (['published', 'draft'].includes(args.status)) rows = rows.filter((r) => (args.status === 'published' ? r.status === 'published' : r.status !== 'published'));
      if (args.q) {
        const n = String(args.q).toLowerCase();
        rows = rows.filter((r) => `${r.title} ${r.slug} ${r.excerpt || ''}`.toLowerCase().includes(n));
      }
      return { count: rows.length, posts: rows };
    },
  },
  {
    name: 'list_plan_offers', group: 'read', label: 'Plan offers', mutating: false,
    description: 'List FirmLedger Pro plan offers with price, duration, active flag and how many payments reference each (Admin → Plan offers).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'List the plan offers.'; },
    run() {
      const rows = plans.allPlans(false).map((p) => ({
        ...p,
        price_usd: (p.price_cents / 100).toFixed(2),
        payments: safeCount('SELECT COUNT(*) c FROM payments WHERE plan_id=?', p.id),
      }));
      return { count: rows.length, offers: rows };
    },
  },
  {
    name: 'list_promos', group: 'read', label: 'Promo codes', mutating: false,
    description: 'List promo codes with discount, usage, cap, expiry and active flag (Admin → Promos).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'List the promo codes.'; },
    run() {
      const rows = promos.all().map((p) => ({
        id: p.id, code: p.code, percent: p.percent, active: Boolean(p.active),
        used: p.used_count, cap: p.max_uses, expires_at: p.expires_at, plan_id: p.plan_id, note: p.note,
      }));
      return { count: rows.length, promos: rows };
    },
  },
  {
    name: 'list_careers', group: 'read', label: 'Career roles', mutating: false,
    description: 'List FirmLedger career roles (Admin → Careers) with status.',
    parameters: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['open', 'closed', ''] } },
      additionalProperties: false,
    },
    summarize(a) { return `List careers roles${a.status ? ` (${a.status})` : ''}.`; },
    run(args) {
      let rows = careers.listAll();
      if (args.status === 'open' || args.status === 'closed') rows = rows.filter((r) => r.status === args.status);
      return { count: rows.length, roles: rows };
    },
  },
  {
    name: 'list_ad_packages', group: 'read', label: 'Ad packages', mutating: false,
    description: 'List advertising packages and the listings currently in sponsored placement (Admin → Advertising).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'List ad packages and sponsored placements.'; },
    run() {
      return {
        packages: ad.allPackages(false).map((p) => ({ ...p, price_usd: (p.price_cents / 100).toFixed(2) })),
        sponsored: ad.allSponsored().map((l) => ({ id: l.id, slug: l.slug, name: l.name, expires: l.sponsored_expires_at || 'lifetime', reference: l.ad_reference })),
      };
    },
  },
  {
    name: 'list_payments', group: 'read', label: 'Payments ledger', mutating: false,
    description: 'Read the payments ledger (Admin → Settings → Payments): reference, amount, currency, status, channel, plan, promo, member and listing.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['success', 'failed', 'pending', ''] },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    summarize(a) { return `Read the payments ledger${a.status ? ` (${a.status})` : ''}.`; },
    run(args) {
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
      const rows = db.prepare(
        `SELECT p.id, p.reference, p.amount, p.currency, p.status, p.channel, p.kind, p.duration_days, p.created_at, p.paid_at,
                l.name AS listing_name, pl.name AS plan_name, u.email AS user_email
         FROM payments p LEFT JOIN listings l ON l.id=p.listing_id
         LEFT JOIN plans pl ON pl.id=p.plan_id LEFT JOIN users u ON u.id=p.user_id
         ORDER BY p.id DESC LIMIT ?`
      ).all(limit);
      const filtered = ['success', 'failed', 'pending'].includes(args.status) ? rows.filter((r) => r.status === args.status) : rows;
      const totals = db.prepare(
        "SELECT COUNT(*) c, COALESCE(SUM(amount),0) sum FROM payments WHERE status='success' AND currency='USD'"
      ).get();
      return { count: filtered.length, payments: filtered, successful_count: totals.c, successful_usd_cents: totals.sum };
    },
  },
  {
    name: 'list_pro_transfers', group: 'read', label: 'Pro transfer requests', mutating: false,
    description: 'List listing-scoped Pro transfer requests (from listing → to listing) with status.',
    parameters: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected', ''] } },
      additionalProperties: false,
    },
    summarize(a) { return `List Pro transfer requests${a.status ? ` (${a.status})` : ''}.`; },
    run(args) {
      const status = ['pending', 'approved', 'rejected'].includes(args.status) ? args.status : '';
      const rows = db.prepare(
        `SELECT t.*, u.email AS user_email, a.name AS from_listing, b.name AS to_listing
         FROM pro_transfer_requests t
         LEFT JOIN users u ON u.id=t.user_id
         LEFT JOIN listings a ON a.id=t.from_listing_id
         LEFT JOIN listings b ON b.id=t.to_listing_id
         ${status ? "WHERE t.status=?" : ''} ORDER BY t.id DESC LIMIT 100`
      ).all(...(status ? [status] : []));
      return { count: rows.length, transfers: rows };
    },
  },
  {
    name: 'list_removals', group: 'read', label: 'Removal requests', mutating: false,
    description: 'List listing-removal requests in any status (Admin → Removals).',
    parameters: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['pending', 'resolved', 'dismissed', ''] } },
      additionalProperties: false,
    },
    summarize(a) { return `List removal requests${a.status ? ` (${a.status})` : ''}.`; },
    run(args) {
      const status = ['pending', 'resolved', 'dismissed'].includes(args.status) ? args.status : '';
      const rows = db.prepare(
        `SELECT r.*, l.name AS listing_name, l.slug AS listing_slug, l.status AS listing_status
         FROM removal_requests r LEFT JOIN listings l ON l.id=r.listing_id
         ${status ? 'WHERE r.status=?' : ''} ORDER BY r.id DESC LIMIT 200`
      ).all(...(status ? [status] : []));
      return { count: rows.length, removals: rows };
    },
  },
  {
    name: 'list_claims', group: 'read', label: 'Ownership claims', mutating: false,
    description: 'List ownership claims in any status with the listing, the claimant and the verification method (Admin → Claims).',
    parameters: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected', ''] } },
      additionalProperties: false,
    },
    summarize(a) { return `List ownership claims${a.status ? ` (${a.status})` : ''}.`; },
    run(args) {
      const status = ['pending', 'approved', 'rejected'].includes(args.status) ? args.status : '';
      const rows = db.prepare(
        `SELECT c.*, l.name AS listing_name, l.slug AS listing_slug, u.email AS user_email
         FROM claims c JOIN listings l ON l.id=c.listing_id JOIN users u ON u.id=c.user_id
         ${status ? 'WHERE c.status=?' : ''}
         ORDER BY CASE c.status WHEN 'pending' THEN 0 ELSE 1 END, c.id DESC LIMIT 200`
      ).all(...(status ? [status] : []));
      return { count: rows.length, claims: rows };
    },
  },
  {
    name: 'list_news', group: 'read', label: 'Listing news queue', mutating: false,
    description: 'List listing news stories (Admin → News) by status and origin (auto-detected, member-submitted, console-written), with the queue counts.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'approved', 'rejected', ''] },
        origin: { type: 'string', enum: ['auto', 'user', 'admin', ''] },
        listing: { type: 'string', description: 'Optional listing id or slug.' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    summarize(a) { return `List news${a.status ? ` (${a.status})` : ''}${a.origin ? ` origin ${a.origin}` : ''}.`; },
    run(args) {
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));
      if (args.listing) {
        const l = findListing(args.listing);
        if (!l) return { error: 'No listing matches that id or slug.' };
        return { count: news.allFor(l.id).length, listing: l.name, stories: news.allFor(l.id).slice(0, limit), counts: news.counts() };
      }
      let rows = news.recent(['pending', 'approved', 'rejected'].includes(args.status) ? args.status : '', limit);
      if (['auto', 'user', 'admin'].includes(args.origin)) rows = rows.filter((r) => r.origin === args.origin);
      return { count: rows.length, stories: rows, counts: news.counts(), job: news.jobState() };
    },
  },
  {
    name: 'list_tickets', group: 'read', label: 'Support tickets', mutating: false,
    description: 'List support tickets (Admin → Tickets) by status with the member, subject, category and last update.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'solved', 'closed', ''] },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    summarize(a) { return `List tickets${a.status ? ` (${a.status})` : ''}.`; },
    run(args) {
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 40));
      const status = ['open', 'solved', 'closed'].includes(args.status) ? args.status : '';
      const rows = db.prepare(
        `SELECT t.id, t.ref, t.subject, t.category, t.status, t.created_at, t.updated_at, u.email AS user_email, u.name AS user_name,
                (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id=t.id) AS messages
         FROM tickets t JOIN users u ON u.id=t.user_id
         ${status ? 'WHERE t.status=?' : ''} ORDER BY t.updated_at DESC LIMIT ?`
      ).all(...(status ? [status, limit] : [limit]));
      return { count: rows.length, tickets: rows };
    },
  },
  {
    name: 'get_ticket', group: 'read', label: 'Ticket thread', mutating: false,
    description: 'Read one support ticket thread in full (id or ref like FL-XXXX): every message, who sent it, attachments.',
    parameters: {
      type: 'object',
      properties: { id_or_ref: { type: 'string' } },
      required: ['id_or_ref'], additionalProperties: false,
    },
    summarize(a) { return `Open ticket ${a.id_or_ref}.`; },
    run(args) {
      const t = findTicket(args.id_or_ref);
      if (!t) return { error: 'No ticket matches that id or reference.' };
      const u = db.prepare('SELECT id, email, name FROM users WHERE id=?').get(t.user_id) || {};
      return {
        ok: true,
        ticket: { ...t, user_email: u.email, user_name: u.name },
        messages: db.prepare('SELECT id, sender, body, attachment_name, created_at FROM ticket_messages WHERE ticket_id=? ORDER BY id ASC').all(t.id),
      };
    },
  },
  {
    name: 'list_notifications', group: 'read', label: 'Console inbox', mutating: false,
    description: 'List the admin console inbox (unread first). Also reports the unread count shown on the bell.',
    parameters: {
      type: 'object',
      properties: { unread_only: { type: 'boolean' }, limit: { type: 'integer' } },
      additionalProperties: false,
    },
    summarize(a) { return `Read the console inbox${a.unread_only ? ' (unread only)' : ''}.`; },
    run(args) {
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 40));
      let rows = notify.listAdmin(limit);
      if (args.unread_only) rows = rows.filter((n) => notify.isUnread(n));
      return { count: rows.length, unread: notify.unreadAdmin(), notifications: rows };
    },
  },
  {
    name: 'list_deletion_requests', group: 'read', label: 'Account deletion requests', mutating: false,
    description: 'List member account-deletion requests with the reason and what they said could be improved (Admin → Users shows the count).',
    parameters: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['pending', 'completed', ''] } },
      additionalProperties: false,
    },
    summarize(a) { return `List account deletion requests${a.status ? ` (${a.status})` : ''}.`; },
    run(args) {
      const status = ['pending', 'completed'].includes(args.status) ? args.status : '';
      const rows = db.prepare(
        `SELECT d.id, d.user_id, d.reason, d.improve, d.status, d.created_at, d.resolved_at, u.email, u.name
         FROM deletion_requests d JOIN users u ON u.id=d.user_id
         ${status ? 'WHERE d.status=?' : ''} ORDER BY d.id DESC LIMIT 200`
      ).all(...(status ? [status] : []));
      return { count: rows.length, requests: rows };
    },
  },
  {
    name: 'get_status', group: 'read', label: 'Public status page', mutating: false,
    description: 'Read the /status page state: components and their current status, overall status, uptime percentages, open incidents and subscriber count.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Read the public status page state.'; },
    run() {
      mon.ensureComponents();
      return {
        overall: mon.overallStatus(),
        components: mon.components().map((c) => ({ id: c.id, name: c.name, slug: c.slug, status: c.status, uptime: mon.uptimeSummary(c.id) })),
        overall_uptime: mon.overallUptime ? mon.overallUptime() : null,
        open_incidents: mon.activeIncidents(),
        recent_incidents: mon.allIncidents().slice(0, 10).map((i) => ({ id: i.id, title: i.title, status: i.status, severity: i.severity, component: i.component_name, created_at: i.created_at })),
        subscribers: mon.subscriberCount(),
      };
    },
  },
  {
    name: 'get_indexing', group: 'read', label: 'Search indexing', mutating: false,
    description: 'Read search-indexing state: IndexNow enabled + key present, the last log entries, Google Indexing API configuration, today’s 200-URL quota and how many approved listings Google has never been sent.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Read search-indexing state.'; },
    run() {
      return {
        indexnow_enabled: getSetting('indexing_enabled', '1') === '1',
        indexnow_key_set: Boolean(getIndexNowKey()),
        recent_log: indexlog.recent(20),
        log_entries: indexlog.count(),
        google: googleIndexing.status(),
        google_quota: googleIndexing.quota(),
        google_pending_listings: googleIndexing.pendingCount(),
        google_submitted_total: googleIndexing.submittedCount(),
        google_job: googleIndexing.jobState(),
      };
    },
  },
  {
    name: 'get_protection', group: 'read', label: 'Protection settings', mutating: false,
    description: 'Read spam protection and maintenance state: IP allow/block lists, email-domain lists, every rate limit with its default, and the maintenance page text.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Read protection and maintenance state.'; },
    run() {
      return {
        ips: spam.listIp(),
        domains: spam.listDomain(),
        limits: spam.limits(),
        defaults: spam.DEFAULTS,
        maintenance: {
          on: getSetting('maintenance_on', '0') === '1',
          title: getSetting('maintenance_title', "We'll be back soon"),
          message: getSetting('maintenance_message', ''),
          eta: getSetting('maintenance_eta', ''),
        },
      };
    },
  },
  {
    name: 'get_mail_status', group: 'read', label: 'Email delivery', mutating: false,
    description: 'Read email delivery state: whether SMTP is configured, the From address, every hop in the failover chain with its daily limit and last error, and the most recent admin mail log entries.',
    parameters: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false },
    summarize() { return 'Read email delivery state.'; },
    run(args) {
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
      return {
        configured: mailer.mailConfigured(),
        from: mailer.fromAddress(),
        hops: mailer.hops().map((h) => ({
          id: h.id, via: h.via, source: h.source, host: h.host, port: h.port, secure: Boolean(h.secure),
          daily_limit: h.daily_limit || 0, sent_today: h.sent_today || 0, last_error: h.last_error || '',
        })),
        providers: mailer.PROVIDERS.map((p) => ({ id: p.id, name: p.name })),
        recent: db.prepare('SELECT id, to_email, subject, delivered, created_at FROM admin_mail_log ORDER BY id DESC LIMIT ?').all(limit),
      };
    },
  },
  {
    name: 'get_newsletter', group: 'read', label: 'Newsletter state', mutating: false,
    description: 'Read newsletter state: active subscriber count, cadence, when the last digest went out, and what the next roundup would contain.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Read newsletter state.'; },
    run() {
      const cadence = nl.digestCadence();
      let roundup = null;
      try { roundup = nl.weeklyRoundup(cadence.windowDays); } catch { roundup = null; }
      return {
        subscribers: nl.subCount(true),
        total_rows: nl.subCount(false),
        cadence: cadence.key,
        last_sent: getSetting('newsletter_last_sent', '') || 'never',
        roundup: roundup ? { verified: (roundup.verified || []).length, fresh: (roundup.fresh || []).length } : null,
      };
    },
  },
  {
    name: 'get_upkeep', group: 'read', label: 'Automated upkeep', mutating: false,
    description: 'Read the automated upkeep schedule (hourly sweep that refreshes technology radars and checks listing news), when it last ran, and the state of any running tech or news job.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Read the automated upkeep schedule.'; },
    run() {
      return {
        settings: upkeep.settings(),
        defaults: upkeep.DEFAULTS,
        last_run: upkeep.lastRun(),
        running: upkeep.isRunning(),
        tech_counts: techrefresh.counts(),
        tech_job: techrefresh.jobState(),
        news_counts: news.counts(),
        news_job: news.jobState(),
      };
    },
  },
  {
    name: 'get_backup_state', group: 'read', label: 'Backup state', mutating: false,
    description: 'Read backup state: when the last full .firmledger backup was taken, what a backup contains, and the live database footprint.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Read backup state.'; },
    run() {
      let snap = null;
      try { snap = health.snapshot(); } catch { snap = null; }
      return {
        last_backup_at: getSetting('last_backup_at', '') || 'never',
        contains: backup.configurationSection ? Object.keys(backup.configurationSection() || {}) : [],
        users_included: safeCount('SELECT COUNT(*) c FROM users'),
        listings_included: safeCount('SELECT COUNT(*) c FROM listings'),
        health: snap,
        download_url: '/admin3119Musa/health/backup.firmledger',
      };
    },
  },
  {
    name: 'get_ai_state', group: 'read', label: 'AI playground state', mutating: false,
    description: 'Read the AI Playground state: which model providers have a key, which one is active with which model, failover, auto-moderation, the assistant auto-run policy, proposals waiting for confirmation and the latest audit entries.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Read the AI Playground state.'; },
    run() {
      const active = llm.activeProviderId();
      return {
        active_provider: active,
        active_model: llm.savedModel(active),
        failover: llm.failoverEnabled(),
        rate_limit_per_min: llm.rateLimitPerMinute(),
        providers: llm.providerSnapshot().map((p) => ({
          id: p.id, label: p.label, configured: p.configured, key_set: p.key_set,
          key_source: p.key_source, model: p.model, base_url: p.base_url,
          live_models: p.live_models.length, live_checked_at: p.live_checked_at,
        })),
        moderation: {
          on: getSetting('ai_moderation_on', '0') === '1',
          model: getSetting('ai_moderation_model', '') || '(default)',
          email_admin: getSetting('ai_moderation_email', '1') === '1',
        },
        auto_tools: [...autoSet()],
        tool_groups: enabledGroups(),
        pending_actions: safeCount('SELECT COUNT(*) c FROM ai_pending_actions'),
        recent_audit: db.prepare('SELECT id, kind, action, result, ok, created_at FROM ai_audit_log ORDER BY id DESC LIMIT 15').all(),
        recent_moderation: db.prepare('SELECT id, listing_id, listing_name, decision, reason, model, created_at FROM ai_moderation_log ORDER BY id DESC LIMIT 15').all(),
      };
    },
  },
  {
    name: 'get_api_usage', group: 'read', label: 'Public API usage', mutating: false,
    description: 'Read public REST API v1 usage: keys in circulation, requests and writes per day, and webhook delivery failures.',
    parameters: { type: 'object', properties: { days: { type: 'integer' } }, additionalProperties: false },
    summarize() { return 'Read public API usage.'; },
    run(args) {
      const days = Math.max(1, Math.min(90, Number(args.days) || 14));
      return {
        keys: safeCount('SELECT COUNT(*) c FROM api_keys'),
        active_keys: safeCount("SELECT COUNT(*) c FROM api_keys WHERE revoked_at IS NULL OR revoked_at=''"),
        daily: safeAll(`SELECT day, SUM(requests) requests, SUM(writes) writes FROM api_usage_daily WHERE day >= date('now', ?) GROUP BY day ORDER BY day DESC`, `-${days} days`),
        webhook_failures: safeAll("SELECT id, webhook_id, status, attempts, error, created_at FROM api_webhook_deliveries WHERE status <> 'delivered' ORDER BY id DESC LIMIT 20"),
      };
    },
  },
  {
    name: 'find_duplicate_listings', group: 'read', label: 'Duplicate check', mutating: false,
    description: 'Check whether a name or website domain already exists on the ledger — the same duplicate protection that blocks user submissions and admin adds. Run this before creating a listing.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' }, website: { type: 'string' },
      },
      additionalProperties: false,
    },
    summarize(a) { return `Duplicate check for ${a.name || a.website || '?'}.`; },
    run(args) {
      const name = String(args.name || '').trim();
      const domain = domainOf(normalizeUrl(String(args.website || '')));
      if (!name && !domain) return { error: 'Give a name or a website to check.' };
      const byName = name
        ? db.prepare('SELECT id, slug, name, status, website FROM listings WHERE name = ? COLLATE NOCASE').all(name) : [];
      const byDomain = domain
        ? db.prepare('SELECT id, slug, name, status, website FROM listings WHERE lower(website) LIKE ?').all(`%${domain}%`) : [];
      const hits = [...new Map([...byName, ...byDomain].map((r) => [r.id, r])).values()];
      return { duplicate: hits.length > 0, name_matches: byName, domain_matches: byDomain, matches: hits, checked_domain: domain };
    },
  },

  /* ==========================================================================
   * Listings — the full editor, admin add, bulk actions, timeline, graph,
   * technology radar and listing news. Everything Admin → Listings can do.
   * ======================================================================== */
  {
    name: 'edit_listing', group: 'listings', label: 'Edit listing', mutating: true,
    description: 'Edit any field of a listing, exactly like Admin → Listings → Edit: name, tagline, description, type, category, website, email, phone, country, city, region, address, logo_url, founded, size, tags, sources, socials, hiring_url, status (pending/approved/rejected), featured, claimed, confidence, last_verified_at. Send only the fields to change. Duplicate protection runs on name and website. Status changes fire the same notifications and indexing pings as the console. Returns the before/after diff.',
    parameters: {
      type: 'object',
      properties: {
        id_or_slug: { type: 'string' },
        name: { type: 'string' }, tagline: { type: 'string' }, description: { type: 'string' },
        type: { type: 'string', description: 'company | startup | agency | organization | product | service | publisher' },
        category: { type: 'string' }, website: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' },
        country: { type: 'string' }, city: { type: 'string' }, region: { type: 'string' }, address: { type: 'string' },
        logo_url: { type: 'string' }, founded: { type: 'string', description: 'YYYY or YYYY-MM' },
        size: { type: 'string' }, tags: { type: 'string', description: 'Comma separated.' },
        sources: { type: 'string', description: 'One source URL per line (or comma separated).' },
        hiring_url: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
        featured: { type: 'boolean' }, claimed: { type: 'boolean' },
        confidence: { type: 'integer', description: '0–97. Omit to recalculate from the record.' },
        last_verified_at: { type: 'string', description: 'YYYY-MM-DD, or empty to clear.' },
      },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) {
      const fields = Object.keys(a).filter((k) => k !== 'id_or_slug');
      return `Edit ${a.id_or_slug}: ${fields.length ? fields.join(', ') : 'nothing'}${a.status ? ` → ${a.status}` : ''}.`;
    },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      const editable = ['name', 'tagline', 'description', 'type', 'category', 'website', 'email', 'phone',
        'country', 'city', 'region', 'address', 'logo_url', 'founded', 'size', 'tags', 'sources',
        'hiring_url', 'status', 'featured', 'claimed', 'confidence', 'last_verified_at'];
      const unknown = Object.keys(args).filter((k) => k !== 'id_or_slug' && !editable.includes(k));
      if (unknown.length) return { error: `These fields are not editable here: ${unknown.join(', ')}.` };
      const changes = {};
      const next = { ...l };

      const str = (k, max) => {
        if (args[k] === undefined) return;
        changes[k] = { from: l[k], to: String(args[k]).trim().slice(0, max) };
        next[k] = changes[k].to;
      };
      str('tagline', 200); str('description', 4000); str('email', 190); str('phone', 40);
      str('country', 60); str('city', 80); str('region', 80); str('address', 200);
      str('founded', 12); str('size', 20); str('tags', 160); str('hiring_url', 300);

      if (args.name !== undefined) {
        const name = String(args.name).trim().replace(/\s+/g, ' ').slice(0, 60);
        if (name.length < 2) return { error: 'A listing name needs at least 2 characters.' };
        const clash = db.prepare('SELECT id, slug, name FROM listings WHERE name = ? COLLATE NOCASE AND id <> ?').get(name, l.id);
        if (clash) return { error: `Another listing is already called “${clash.name}” (/listing/${clash.slug}) — duplicate names are blocked.` };
        changes.name = { from: l.name, to: name };
        next.name = name;
      }
      if (args.type !== undefined) {
        if (!TYPES.some((t) => t.value === String(args.type).trim().toLowerCase())) {
          return { error: `type must be one of: ${TYPES.map((t) => t.value).join(', ')}.` };
        }
        changes.type = { from: l.type, to: String(args.type).trim().toLowerCase() };
        next.type = changes.type.to;
      }
      if (args.category !== undefined) {
        const cat = catLib.ensure(args.category);
        changes.category = { from: l.category, to: cat.name };
        next.category = cat.name;
      }
      if (args.website !== undefined) {
        const website = normalizeUrl(String(args.website));
        const domain = domainOf(website);
        if (domain) {
          const clash = db.prepare('SELECT id, slug, name FROM listings WHERE lower(website) LIKE ? AND id <> ? LIMIT 1').get(`%${domain}%`, l.id);
          if (clash) return { error: `“${clash.name}” already uses that domain (/listing/${clash.slug}).` };
        }
        changes.website = { from: l.website, to: website };
        next.website = website;
      }
      if (args.logo_url !== undefined) {
        changes.logo_url = { from: l.logo_url, to: normalizeUrl(String(args.logo_url)) };
        next.logo_url = changes.logo_url.to;
      }
      if (args.sources !== undefined) {
        const list = String(args.sources).split(/[\n,]+/).map((s) => normalizeUrl(s.trim())).filter(Boolean).slice(0, 20);
        changes.sources = { from: l.sources, to: JSON.stringify(list) };
        next.sources = JSON.stringify(list);
      }
      if (args.featured !== undefined) { changes.featured = { from: l.featured, to: args.featured ? 1 : 0 }; next.featured = changes.featured.to; }
      if (args.claimed !== undefined) { changes.claimed = { from: l.claimed, to: args.claimed ? 1 : 0 }; next.claimed = changes.claimed.to; }
      if (args.confidence !== undefined) {
        const c = Math.max(0, Math.min(97, parseInt(args.confidence, 10) || 0));
        changes.confidence = { from: l.confidence, to: c };
        next.confidence = c;
      }
      if (args.last_verified_at !== undefined) {
        const v = String(args.last_verified_at).trim().slice(0, 40) || null;
        changes.last_verified_at = { from: l.last_verified_at, to: v };
        next.last_verified_at = v;
      }
      if (args.status !== undefined && !['pending', 'approved', 'rejected'].includes(args.status)) {
        return { error: 'status must be pending, approved or rejected.' };
      }
      if (!Object.keys(changes).length && args.status === undefined) return { error: 'Nothing to change — send at least one field.' };

      db.prepare(
        `UPDATE listings SET name=?, tagline=?, description=?, type=?, category=?, website=?, email=?, phone=?,
            country=?, city=?, region=?, address=?, logo_url=?, founded=?, size=?, tags=?, sources=?, hiring_url=?,
            featured=?, claimed=?, confidence=?, last_verified_at=?, updated_at=datetime('now') WHERE id=?`
      ).run(
        next.name, next.tagline, next.description, next.type, next.category, next.website, next.email, next.phone,
        next.country, next.city, next.region, next.address, next.logo_url, next.founded, next.size, next.tags,
        next.sources, next.hiring_url || '', next.featured ? 1 : 0, next.claimed ? 1 : 0,
        next.confidence == null ? l.confidence : next.confidence,
        next.last_verified_at === undefined ? l.last_verified_at : next.last_verified_at,
        l.id
      );

      let status = l.status;
      if (args.status && args.status !== l.status) {
        const before = db.prepare('SELECT * FROM listings WHERE id=?').get(l.id);
        if (args.status === 'approved') approveListingRow(before);
        else if (args.status === 'rejected') rejectListingRow(before);
        else db.prepare("UPDATE listings SET status='pending', updated_at=datetime('now') WHERE id=?").run(l.id);
        status = args.status;
        changes.status = { from: l.status, to: args.status };
      }
      const after = db.prepare('SELECT * FROM listings WHERE id=?').get(l.id);
      listingEvents.transition(l, after);
      submitForIndexing([`/listing/${after.slug}`]);
      if (after.status === 'approved') googleIndexing.pingGoogleNewListingBackground(siteUrl(`/listing/${after.slug}`));
      return { ok: true, id: after.id, slug: after.slug, name: after.name, status, changes };
    },
  },
  {
    name: 'create_listing', group: 'listings', label: 'Add a listing', mutating: true,
    description: 'Add a listing to the ledger the way Admin → Listings → Add does. Duplicate protection applies (same name or same website domain is refused). Defaults to status=pending so it goes through review; pass status=approved to publish it immediately.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' }, tagline: { type: 'string', description: '20–90 characters.' },
        description: { type: 'string', description: '100–1200 characters.' },
        type: { type: 'string' }, category: { type: 'string' }, website: { type: 'string' },
        email: { type: 'string' }, phone: { type: 'string' }, country: { type: 'string' },
        city: { type: 'string' }, region: { type: 'string' }, address: { type: 'string' },
        logo_url: { type: 'string' }, founded: { type: 'string' }, size: { type: 'string' },
        tags: { type: 'string' }, sources: { type: 'string', description: 'One URL per line.' },
        owner: { type: 'string', description: 'Optional owner email or id — sets owner and claimed.' },
        status: { type: 'string', enum: ['pending', 'approved'], description: 'Default pending.' },
      },
      required: ['name', 'tagline', 'description', 'website', 'country'], additionalProperties: false,
    },
    summarize(a) { return `Add listing “${a.name}” (${a.status || 'pending'}).`; },
    run(args) {
      const draft = {
        name: args.name, tagline: args.tagline, description: args.description,
        type: args.type || 'company', category: args.category || 'Other',
        website: args.website, email: args.email || '', phone: args.phone || '',
        country: args.country, city: args.city || '', region: args.region || '', address: args.address || '',
        logo_url: args.logo_url || '', founded: args.founded || '', size: args.size || '', tags: args.tags || '',
        sources: args.sources || '',
      };
      let f;
      try {
        f = svc.parseFields(draft, { partial: false });
      } catch (e) {
        const details = e.details && Array.isArray(e.details.errors)
          ? ' ' + e.details.errors.map((x) => `${x.field}: ${x.message}`).join('; ') : '';
        return { error: (e.message || 'That listing is not valid.') + details };
      }
      const domain = domainOf(f.website);
      const dupName = db.prepare('SELECT id, slug, name FROM listings WHERE name = ? COLLATE NOCASE').get(f.name);
      if (dupName) return { error: `A listing named “${dupName.name}” already exists (/listing/${dupName.slug}).` };
      if (domain) {
        const dupWeb = db.prepare('SELECT id, slug, name FROM listings WHERE lower(website) LIKE ? LIMIT 1').get(`%${domain}%`);
        if (dupWeb) return { error: `“${dupWeb.name}” already uses that domain (/listing/${dupWeb.slug}).` };
      }
      let owner = null;
      if (args.owner) {
        owner = findUser(args.owner);
        if (!owner) return { error: 'No user matches that owner email or id.' };
      }
      const r = createListingRow(f, {
        status: args.status === 'approved' ? 'approved' : 'pending',
        ownerId: owner ? owner.id : null,
        sources: String(args.sources || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean),
      });
      if (r.status === 'approved') {
        approveListingRow(db.prepare('SELECT * FROM listings WHERE id=?').get(r.id));
      } else {
        scheduleRowModeration(r.id);
      }
      return {
        ok: true, id: r.id, slug: r.slug, name: r.name, status: r.status,
        confidence: r.confidence, owner: owner ? owner.email : null,
        url: siteUrl(`/listing/${r.slug}`),
        note: r.status === 'pending' ? 'Created as pending — it enters the review queue.' : 'Created and published.',
      };
    },
  },
  {
    name: 'bulk_update_listings', group: 'listings', label: 'Bulk listing action', mutating: true, sensitive: true,
    description: 'Apply one action to many listings at once (Admin → Listings → bulk approve/reject): action approve | reject | feature | unfeature | delete, targeted by an explicit list of ids/slugs or by a filter (status, category, country). Bulk delete is permanent. Always confirm the count with the operator first.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['approve', 'reject', 'feature', 'unfeature', 'delete'] },
        ids: { type: 'array', items: { type: 'string' }, description: 'Explicit listing ids or slugs.' },
        status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
        category: { type: 'string' }, country: { type: 'string' },
        limit: { type: 'integer', description: 'Safety cap, default 200.' },
      },
      required: ['action'], additionalProperties: false,
    },
    summarize(a) {
      const scope = (a.ids && a.ids.length) ? `${a.ids.length} named listing(s)`
        : [a.status, a.category, a.country].filter(Boolean).join(', ') || 'the whole directory';
      return `BULK ${String(a.action).toUpperCase()} ${scope}.`;
    },
    run(args) {
      const action = String(args.action || '').toLowerCase();
      if (!['approve', 'reject', 'feature', 'unfeature', 'delete'].includes(action)) return { error: 'Unknown action.' };
      let rows = [];
      if (Array.isArray(args.ids) && args.ids.length) {
        rows = args.ids.map((x) => findListing(x)).filter(Boolean);
      } else {
        const where = []; const params = [];
        if (['pending', 'approved', 'rejected'].includes(args.status)) { where.push('status=?'); params.push(args.status); }
        if (args.category) { where.push('category=? COLLATE NOCASE'); params.push(String(args.category).trim()); }
        if (args.country) { where.push('country LIKE ?'); params.push(`%${String(args.country).trim().replace(/[%_]/g, '')}%`); }
        if (!where.length) return { error: 'Refusing to touch the whole directory — pass ids or at least one filter.' };
        const cap = Math.max(1, Math.min(1000, Number(args.limit) || 200));
        rows = db.prepare(`SELECT * FROM listings WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`).all(...params, cap);
      }
      if (!rows.length) return { error: 'No listings match that selection.' };
      const done = []; const failed = [];
      for (const l of rows) {
        try {
          if (action === 'approve') { approveListingRow(l); done.push({ id: l.id, slug: l.slug, name: l.name }); }
          else if (action === 'reject') { rejectListingRow(l); done.push({ id: l.id, slug: l.slug, name: l.name }); }
          else if (action === 'feature' || action === 'unfeature') {
            db.prepare('UPDATE listings SET featured=? WHERE id=?').run(action === 'feature' ? 1 : 0, l.id);
            listingEvents.updated(db.prepare('SELECT * FROM listings WHERE id=?').get(l.id), { change: 'featured' });
            done.push({ id: l.id, slug: l.slug, name: l.name });
          } else if (action === 'delete') {
            deleteLogo(l.logo_url);
            const tx = db.transaction(() => {
              for (const t of ['listing_events', 'jobs', 'favorites', 'removal_requests', 'payments', 'listing_news']) {
                try { db.prepare(`DELETE FROM ${t} WHERE listing_id=?`).run(l.id); } catch { /* ignore */ }
              }
              try { db.prepare('DELETE FROM relationships WHERE listing_id=? OR target_listing_id=?').run(l.id, l.id); } catch { /* ignore */ }
              db.prepare('DELETE FROM listings WHERE id=?').run(l.id);
            });
            tx();
            done.push({ id: l.id, slug: l.slug, name: l.name, deleted: true });
          }
        } catch (e) {
          failed.push({ id: l.id, slug: l.slug, error: String(e.message || e).slice(0, 160) });
        }
      }
      return { ok: true, action, affected: done.length, failed: failed.length, listings: done.slice(0, 60), errors: failed.slice(0, 10) };
    },
  },
  {
    name: 'add_listing_event', group: 'listings', label: 'Add timeline event', mutating: true,
    description: 'Add a dated timeline event to a listing profile (funding, launch, milestone, award, partnership…). Same as the Timeline box in the listing editor.',
    parameters: {
      type: 'object',
      properties: {
        id_or_slug: { type: 'string' },
        title: { type: 'string' },
        event_date: { type: 'string', description: 'YYYY-MM-DD or YYYY-MM.' },
        kind: { type: 'string', description: 'milestone (default), funding, launch, award, partnership, acquisition.' },
      },
      required: ['id_or_slug', 'title'], additionalProperties: false,
    },
    summarize(a) { return `Add timeline event “${a.title}” to ${a.id_or_slug}.`; },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      const title = String(args.title || '').trim().slice(0, 200);
      if (title.length < 3) return { error: 'Give the event a proper title.' };
      const info = db.prepare('INSERT INTO listing_events (listing_id, event_date, kind, title) VALUES (?,?,?,?)')
        .run(l.id, String(args.event_date || '').trim().slice(0, 20), String(args.kind || 'milestone').slice(0, 30), title);
      listingEvents.updated(db.prepare('SELECT * FROM listings WHERE id=?').get(l.id), { change: 'timeline' });
      return { ok: true, id: Number(info.lastInsertRowid), listing: l.name, title, event_date: String(args.event_date || '').trim() };
    },
  },
  {
    name: 'delete_listing_event', group: 'listings', label: 'Delete timeline event', mutating: true,
    description: 'Delete one timeline event by its numeric id (Admin → Listings → Edit → Timeline).',
    parameters: {
      type: 'object',
      properties: { event_id: { type: 'integer' } },
      required: ['event_id'], additionalProperties: false,
    },
    summarize(a) { return `Delete timeline event #${a.event_id}.`; },
    run(args) {
      const e = db.prepare('SELECT * FROM listing_events WHERE id=?').get(Number(args.event_id) || 0);
      if (!e) return { error: 'No timeline event with that id.' };
      db.prepare('DELETE FROM listing_events WHERE id=?').run(e.id);
      listingEvents.updated(db.prepare('SELECT * FROM listings WHERE id=?').get(e.listing_id), { change: 'timeline' });
      return { ok: true, deleted: e.title, listing_id: e.listing_id };
    },
  },
  {
    name: 'add_relationship', group: 'listings', label: 'Add relationship', mutating: true,
    description: 'Add an edge to the relationship graph: rel_type founder | investor | parent_company | subsidiary | product | service | partner, target is a company/product/person name (it links to the matching approved listing when one exists).',
    parameters: {
      type: 'object',
      properties: {
        id_or_slug: { type: 'string' },
        rel_type: { type: 'string', enum: ['founder', 'investor', 'parent_company', 'subsidiary', 'product', 'service', 'partner'] },
        target: { type: 'string' }, note: { type: 'string' },
      },
      required: ['id_or_slug', 'rel_type', 'target'], additionalProperties: false,
    },
    summarize(a) { return `Add ${a.rel_type} “${a.target}” to ${a.id_or_slug}.`; },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      const r = graphLib.addRelationship(l.id, args.rel_type, args.target, args.note);
      if (r.error) return { error: r.error };
      const row = db.prepare('SELECT * FROM relationships WHERE listing_id=? ORDER BY id DESC LIMIT 1').get(l.id);
      return { ok: true, id: row ? row.id : null, listing: l.name, rel_type: args.rel_type, target: row ? row.target_name : args.target, linked_listing_id: row ? row.target_listing_id : null };
    },
  },
  {
    name: 'delete_relationship', group: 'listings', label: 'Delete relationship', mutating: true,
    description: 'Delete one relationship-graph edge by its numeric id.',
    parameters: {
      type: 'object',
      properties: { relation_id: { type: 'integer' } },
      required: ['relation_id'], additionalProperties: false,
    },
    summarize(a) { return `Delete relationship #${a.relation_id}.`; },
    run(args) {
      const rel = db.prepare('SELECT * FROM relationships WHERE id=?').get(Number(args.relation_id) || 0);
      if (!rel) return { error: 'No relationship with that id.' };
      graphLib.removeRelationship(rel.id);
      return { ok: true, deleted: { id: rel.id, rel_type: rel.rel_type, target: rel.target_name, listing_id: rel.listing_id } };
    },
  },
  {
    name: 'recalculate_listing_confidence', group: 'listings', label: 'Recalculate confidence', mutating: true,
    description: 'Recompute a listing’s confidence score (0–97) from how complete the record is — website, email, phone, socials, sources, founded, size, location.',
    parameters: {
      type: 'object',
      properties: { id_or_slug: { type: 'string' } },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `Recalculate the confidence score for ${a.id_or_slug}.`; },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      const score = confidenceScore(l);
      db.prepare('UPDATE listings SET confidence=? WHERE id=?').run(score, l.id);
      return { ok: true, id: l.id, name: l.name, before: l.confidence, confidence: score };
    },
  },
  {
    name: 'refresh_tech_bulk', group: 'listings', label: 'Bulk technology refresh', mutating: true,
    description: 'Queue a background technology-radar sweep (Admin → Listings → ↻ Tech): scope stale (not checked for 45+ days), all (every listing with a website), or selected (explicit ids). Returns immediately; progress is readable with get_upkeep.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['stale', 'all', 'selected'] },
        ids: { type: 'array', items: { type: 'string' }, description: 'Listing ids/slugs for scope=selected.' },
      },
      required: ['scope'], additionalProperties: false,
    },
    summarize(a) { return `Start a ${a.scope} technology-radar refresh.`; },
    run(args) {
      let ids = [];
      if (args.scope === 'selected') {
        ids = (Array.isArray(args.ids) ? args.ids : []).map((x) => findListing(x)).filter(Boolean).map((l) => l.id);
        if (!ids.length) return { error: 'scope=selected needs at least one listing id or slug.' };
      } else if (args.scope === 'all') {
        ids = techrefresh.allIds();
      } else {
        ids = techrefresh.staleIds();
      }
      if (!ids.length) return { error: 'Nothing to refresh — every listing with a website was checked recently.' };
      const started = techrefresh.start(ids, args.scope);
      if (!started.ok) return { error: started.error, job: started.job };
      return { ok: true, scope: args.scope, queued: ids.length, job: techrefresh.jobState() };
    },
  },
  {
    name: 'cancel_tech_job', group: 'listings', label: 'Stop technology refresh', mutating: true,
    description: 'Stop the running technology-radar sweep once the in-flight request finishes.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Stop the technology refresh job.'; },
    run() {
      const stopped = techrefresh.cancel();
      return stopped ? { ok: true, note: 'The sweep stops once the in-flight scan finishes.' } : { error: 'No technology refresh is running.' };
    },
  },
  {
    name: 'refresh_listing_news', group: 'listings', label: 'Check news for a listing', mutating: true,
    description: 'Search the news index for fresh coverage of ONE listing and store whatever genuinely matches (the accuracy gate is name-or-domain-or-nothing).',
    parameters: {
      type: 'object',
      properties: { id_or_slug: { type: 'string' } },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `Check the news index for ${a.id_or_slug}.`; },
    async run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      const r = await news.fetchFor(l);
      db.prepare("UPDATE listings SET news_checked_at=date('now') WHERE id=?").run(l.id);
      return { ok: true, listing: l.name, ...r };
    },
  },
  {
    name: 'refresh_news_bulk', group: 'listings', label: 'Bulk news sweep', mutating: true,
    description: 'Queue a background news sweep (Admin → News → Refresh): scope due (not checked recently), all (every approved listing) or selected (explicit ids).',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['due', 'all', 'selected'] },
        ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['scope'], additionalProperties: false,
    },
    summarize(a) { return `Start a ${a.scope} news sweep.`; },
    run(args) {
      let ids = [];
      if (args.scope === 'selected') {
        ids = (Array.isArray(args.ids) ? args.ids : []).map((x) => findListing(x)).filter(Boolean).map((l) => l.id);
        if (!ids.length) return { error: 'scope=selected needs at least one listing id or slug.' };
      } else if (args.scope === 'all') {
        ids = db.prepare("SELECT id FROM listings WHERE status='approved' AND name <> '' ORDER BY id").all().map((r) => r.id);
      } else {
        ids = news.staleListingIds({ limit: 200, maxAgeDays: upkeep.settings().news_max_age_days });
      }
      if (!ids.length) return { error: 'Nothing is due — every listing was checked recently.' };
      const started = news.start(ids, args.scope);
      if (!started.ok) return { error: started.error, job: started.job };
      return { ok: true, scope: args.scope, queued: ids.length, job: news.jobState() };
    },
  },
  {
    name: 'cancel_news_job', group: 'listings', label: 'Stop news sweep', mutating: true,
    description: 'Stop the running news sweep once the in-flight requests finish.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Stop the news sweep.'; },
    run() {
      const stopped = news.cancel();
      return stopped ? { ok: true, note: 'The sweep stops once the in-flight requests finish.' } : { error: 'No news sweep is running.' };
    },
  },
  {
    name: 'add_news_story', group: 'listings', label: 'Add a news story', mutating: true,
    description: 'Write a news story onto a listing by hand (Admin → News → Add). A console-written story is published immediately because it came from a human.',
    parameters: {
      type: 'object',
      properties: {
        id_or_slug: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' },
        source: { type: 'string' }, published_at: { type: 'string', description: 'YYYY-MM-DD' }, summary: { type: 'string' },
      },
      required: ['id_or_slug', 'title'], additionalProperties: false,
    },
    summarize(a) { return `Add news story “${a.title}” to ${a.id_or_slug}.`; },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      const r = news.addManual({
        listing: l, title: args.title, url: args.url, source: args.source,
        published_at: args.published_at, summary: args.summary,
      });
      if (!r.ok) return { error: r.error };
      return { ok: true, listing: l.name, story: r.story || r };
    },
  },
  {
    name: 'delete_news', group: 'listings', label: 'Delete news story', mutating: true,
    description: 'Delete a listing news story by id — it disappears from the public profile permanently.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Delete news story #${a.id}.`; },
    run(args) {
      const r = news.remove(args.id);
      if (!r.ok) return { error: r.error };
      return { ok: true, deleted_id: r.id };
    },
  },
  {
    name: 'set_news_settings', group: 'listings', label: 'News moderation policy', mutating: true,
    description: 'Decide whether auto-detected stories publish straight away or wait for a moderator (Admin → News → Settings). Member-submitted stories always wait.',
    parameters: {
      type: 'object',
      properties: { review_auto: { type: 'boolean', description: 'true = detected stories wait for moderation.' } },
      required: ['review_auto'], additionalProperties: false,
    },
    summarize(a) { return a.review_auto ? 'Make detected news wait for moderation.' : 'Publish detected news automatically.'; },
    run(args) {
      setSetting('news_review_auto', args.review_auto ? '1' : '0');
      return { ok: true, review_auto: Boolean(args.review_auto) };
    },
  },

  /* ==========================================================================
   * Users & billing — everything Admin → Users, Plan offers and Pricing do.
   * ======================================================================== */
  {
    name: 'update_user', group: 'users', label: 'Edit account', mutating: true, sensitive: true,
    description: 'Change an account’s display name or email address. Changing the email changes how the member signs in and where mail goes — the member is emailed about it.',
    parameters: {
      type: 'object',
      properties: {
        user: { type: 'string', description: 'Current email or id.' },
        name: { type: 'string' },
        email: { type: 'string', description: 'New email address.' },
      },
      required: ['user'], additionalProperties: false,
    },
    summarize(a) { return `Edit account ${a.user}${a.email ? ` → email ${a.email}` : ''}${a.name ? ` → name ${a.name}` : ''}.`; },
    run(args) {
      const u = findUser(args.user);
      if (!u) return { error: 'No user matches that email or id.' };
      if (args.name === undefined && args.email === undefined) return { error: 'Send a new name and/or email.' };
      const changes = {};
      let name = u.name;
      let email = u.email;
      if (args.name !== undefined) {
        name = String(args.name).trim().slice(0, 120);
        if (name.length < 2) return { error: 'A display name needs at least 2 characters.' };
        changes.name = { from: u.name, to: name };
      }
      if (args.email !== undefined) {
        email = String(args.email).trim().toLowerCase().slice(0, 190);
        if (!isEmail(email)) return { error: 'That is not a valid email address.' };
        const clash = db.prepare('SELECT id FROM users WHERE email=? AND id<>?').get(email, u.id);
        if (clash) return { error: 'Another account already uses that email address.' };
        changes.email = { from: u.email, to: email };
      }
      db.prepare('UPDATE users SET name=?, email=? WHERE id=?').run(name, email, u.id);
      if (changes.email) {
        sendBranded(email, 'Your FirmLedger sign-in email changed', {
          kicker: 'Account notice', title: 'Your sign-in email was updated',
          preheader: 'An administrator changed the email address on your account.',
          alert: `Your FirmLedger sign-in email is now <b>${escHtml(email)}</b>.`,
          alertTone: 'warn',
          paragraphs: ['An administrator made this change. Use the new address the next time you sign in. If this was not expected, contact support immediately.'],
          cta: { label: 'Contact support', url: 'mailto:support@firmledger.co.ke' },
        }).catch(() => {});
        notify.notifyUser(u.id, { kind: 'account', title: 'Your sign-in email changed', body: `It is now ${email}.`, url: '/dashboard/settings' });
      }
      return { ok: true, id: u.id, email, name, changes };
    },
  },
  {
    name: 'set_user_plan', group: 'users', label: 'Set account plan', mutating: true, sensitive: true,
    description: 'Set an account’s plan directly (Admin → Users → plan): plan=pro with expires_at (YYYY-MM-DD) or lifetime=true, or plan=free to remove Pro. This changes what the member can see without a payment — use it for corrections and goodwill, and say so in the note.',
    parameters: {
      type: 'object',
      properties: {
        user: { type: 'string' },
        plan: { type: 'string', enum: ['pro', 'free'] },
        expires_at: { type: 'string', description: 'YYYY-MM-DD. Empty with lifetime=true means no expiry.' },
        lifetime: { type: 'boolean' },
        note: { type: 'string', description: 'Why — recorded in the audit log and shown to the member.' },
      },
      required: ['user', 'plan'], additionalProperties: false,
    },
    summarize(a) {
      if (a.plan === 'free') return `Set ${a.user} to the Free plan (Pro removed).`;
      return `Set ${a.user} to Pro${a.lifetime ? ' for lifetime' : ` until ${a.expires_at || '(no expiry)'}`}.`;
    },
    run(args) {
      const u = findUser(args.user);
      if (!u) return { error: 'No user matches that email or id.' };
      const plan = String(args.plan || '').trim().toLowerCase();
      if (plan !== 'pro' && plan !== 'free') return { error: 'plan must be pro or free.' };
      const note = String(args.note || 'Adjusted by the admin assistant.').slice(0, 300);
      if (plan === 'free') {
        plans.revokeUserPro(u.id);
        sendBranded(u.email, 'Your FirmLedger Pro access was removed', {
          kicker: 'Billing', title: 'Pro access removed',
          preheader: 'Your account is back on the Free plan.',
          alert: 'Your FirmLedger Pro access has been removed by our team.',
          alertTone: 'warn',
          paragraphs: [escHtml(note), 'Free accounts keep every listing they own and can still add and edit listings. Full listing details and the owner perks need Pro.'],
          cta: { label: 'See plans', url: siteUrl('/pricing') },
        }).catch(() => {});
        notify.notifyUser(u.id, { kind: 'pro', title: 'Pro access removed', body: note, url: '/pricing' });
        const fresh = db.prepare('SELECT plan, plan_expires_at FROM users WHERE id=?').get(u.id);
        return { ok: true, id: u.id, email: u.email, ...fresh, note };
      }
      let expiry = String(args.expires_at || '').trim().slice(0, 10);
      if (args.lifetime) expiry = '';
      if (!args.lifetime && !expiry) {
        const r = plans.grantUserPro(u.id, 30);
        if (!r) return { error: 'Could not grant Pro.' };
        expiry = String(r.expiry || '').slice(0, 10);
      } else if (!args.lifetime) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return { error: 'expires_at must be YYYY-MM-DD, or pass lifetime=true.' };
        db.prepare("UPDATE users SET plan='pro', plan_expires_at=?, subscription_status='active' WHERE id=?").run(expiry, u.id);
      } else {
        db.prepare("UPDATE users SET plan='pro', plan_expires_at='', subscription_status='active' WHERE id=?").run(u.id);
      }
      sendBranded(u.email, 'FirmLedger Pro is active on your account', {
        kicker: 'Billing', title: 'You have FirmLedger Pro',
        preheader: expiry ? `Pro is active until ${expiry}.` : 'Pro is active for lifetime.',
        alert: `An administrator activated FirmLedger Pro on your account${expiry ? ` until <b>${escHtml(expiry)}</b>` : ' with <b>no expiry</b>'}.`,
        alertTone: 'ok',
        paragraphs: [escHtml(note), 'You can now see full details on every listing — website, email, phone, socials, events and the relationship graph — and your own listings get the verified tick, Featured placement and the gold badge.'],
        cta: { label: 'Open your dashboard', url: siteUrl('/dashboard') },
      }).catch(() => {});
      notify.notifyUser(u.id, { kind: 'pro', title: 'FirmLedger Pro activated', body: note, url: '/dashboard' });
      const fresh = db.prepare('SELECT plan, plan_expires_at FROM users WHERE id=?').get(u.id);
      return { ok: true, id: u.id, email: u.email, ...fresh, note };
    },
  },
  {
    name: 'update_plan_offer', group: 'users', label: 'Edit plan offer', mutating: true,
    description: 'Edit a plan offer’s name, price, duration, blurb or sort order (Admin → Plan offers).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer' }, name: { type: 'string' }, price_usd: { type: 'number' },
        duration_days: { type: 'integer' }, blurb: { type: 'string' }, sort: { type: 'integer' },
      },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Edit plan offer #${a.id}.`; },
    run(args) {
      const p = plans.getPlan(args.id);
      if (!p) return { error: 'No plan offer with that id.' };
      const name = args.name !== undefined ? String(args.name).trim().slice(0, 60) : p.name;
      const priceCents = args.price_usd !== undefined ? Math.round(Number(args.price_usd) * 100) : p.price_cents;
      const days = args.duration_days !== undefined ? Math.round(Number(args.duration_days)) : p.duration_days;
      const blurb = args.blurb !== undefined ? String(args.blurb).trim().slice(0, 240) : p.blurb;
      const sort = args.sort !== undefined ? Math.round(Number(args.sort)) : p.sort;
      if (!name) return { error: 'The offer needs a name.' };
      if (!(priceCents > 0) || priceCents > 1e8) return { error: 'Enter a valid price above 0.' };
      if (!(days >= 1) || days > 3650) return { error: 'Duration must be between 1 and 3650 days.' };
      db.prepare('UPDATE plans SET name=?, price_cents=?, duration_days=?, blurb=?, sort=? WHERE id=?')
        .run(name, priceCents, days, blurb, sort, p.id);
      return { ok: true, offer: plans.getPlan(p.id) };
    },
  },
  {
    name: 'delete_plan_offer', group: 'users', label: 'Delete plan offer', mutating: true,
    description: 'Delete a plan offer (Admin → Plan offers). If payments reference it, the offer is deactivated instead so the payment history survives.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Delete plan offer #${a.id}.`; },
    run(args) {
      const p = plans.getPlan(args.id);
      if (!p) return { error: 'No plan offer with that id.' };
      const refs = safeCount('SELECT COUNT(*) c FROM payments WHERE plan_id=?', p.id);
      if (refs > 0) {
        db.prepare('UPDATE plans SET active=0 WHERE id=?').run(p.id);
        return { ok: true, deactivated: true, name: p.name, payments_attached: refs, note: 'Payments are attached, so the offer was hidden rather than deleted.' };
      }
      db.prepare('DELETE FROM plans WHERE id=?').run(p.id);
      return { ok: true, deleted: p.name };
    },
  },
  {
    name: 'revoke_user_sessions', group: 'users', label: 'Sign a member out everywhere', mutating: true, sensitive: true,
    description: 'Delete every active session for an account, signing that member out on all devices. Their next sign-in creates a fresh session.',
    parameters: {
      type: 'object',
      properties: { user: { type: 'string' } },
      required: ['user'], additionalProperties: false,
    },
    summarize(a) { return `Sign ${a.user} out of every device.`; },
    run(args) {
      const u = findUser(args.user);
      if (!u) return { error: 'No user matches that email or id.' };
      const info = db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
      return { ok: true, id: u.id, email: u.email, sessions_revoked: info.changes };
    },
  },
  {
    name: 'reset_user_2fa', group: 'users', label: 'Reset member 2FA', mutating: true,
    description: 'Clear a member’s authenticator enrolment and recovery codes so they can set two-factor up again on their next sign-in.',
    parameters: {
      type: 'object',
      properties: { user: { type: 'string' } },
      required: ['user'], additionalProperties: false,
    },
    summarize(a) { return `Reset two-factor for ${a.user}.`; },
    run(args) {
      const u = findUser(args.user);
      if (!u) return { error: 'No user matches that email or id.' };
      const had = Boolean(safeOne('SELECT enabled FROM user_totp WHERE user_id=?', u.id));
      db.prepare('DELETE FROM user_totp WHERE user_id=?').run(u.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
      notify.notifyUser(u.id, { kind: 'account', title: 'Two-factor was reset', body: 'An administrator cleared your authenticator enrolment. Set it up again from your account settings.', url: '/dashboard/settings' });
      return { ok: true, id: u.id, email: u.email, was_enrolled: had, sessions_revoked: true };
    },
  },
  {
    name: 'notify_user', group: 'users', label: 'In-app notification', mutating: true,
    description: 'Post an in-app notification into one member’s bell (not an email). Good for a personal follow-up that does not need SMTP.',
    parameters: {
      type: 'object',
      properties: {
        user: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' },
        url: { type: 'string' }, kind: { type: 'string', description: 'listing | claim | pro | billing | account | info' },
      },
      required: ['user', 'title'], additionalProperties: false,
    },
    summarize(a) { return `Notify ${a.user}: “${a.title}”.`; },
    run(args) {
      const u = findUser(args.user);
      if (!u) return { error: 'No user matches that email or id.' };
      const id = notify.notifyUser(u.id, {
        kind: args.kind || 'info',
        title: String(args.title).slice(0, 200),
        body: String(args.body || '').slice(0, 2000),
        url: String(args.url || '/dashboard').slice(0, 400),
      });
      return id ? { ok: true, id: Number(id), to: u.email } : { error: 'The notification could not be stored.' };
    },
  },
  {
    name: 'create_backup', group: 'users', label: 'Take a full backup', mutating: true,
    description: 'Build a complete .firmledger backup (every user, every listing and all configuration) and write it to data/backups on the server. Stamps last_backup_at like the console download does.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Take a full .firmledger backup now.'; },
    run() {
      const body = backup.buildBackup();
      const dir = path.join(process.env.FIRMLEDGER_DATA_DIR ? path.resolve(process.env.FIRMLEDGER_DATA_DIR) : path.join(__dirname, '..', '..', 'data'), 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const file = path.join(dir, `firmledger-backup-${stamp}.firmledger`);
      fs.writeFileSync(file, body);
      setSetting('last_backup_at', new Date().toISOString());
      return { ok: true, file: path.basename(file), bytes: Buffer.byteLength(body), users: safeCount('SELECT COUNT(*) c FROM users'), listings: safeCount('SELECT COUNT(*) c FROM listings') };
    },
  },

  /* ==========================================================================
   * Claims, tickets, removals
   * ======================================================================== */
  {
    name: 'auto_close_stale_tickets', group: 'moderation', label: 'Auto-close stale tickets', mutating: true,
    description: 'Run the hourly ticket auto-close pass now: solved tickets unanswered for 7+ days and admin replies unanswered for 14+ days are closed, and the member is told.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Auto-close stale support tickets.'; },
    run() {
      const r = support.autoCloseStale();
      return { ok: true, ...(r && typeof r === 'object' ? r : { closed: Number(r) || 0 }) };
    },
  },

  /* ==========================================================================
   * Content — blog, email, careers, promos, advertising, newsletter
   * ======================================================================== */
  {
    name: 'update_blog_post', group: 'content', label: 'Edit blog post', mutating: true,
    description: 'Edit a blog post (Admin → Blog → Edit): title, slug, excerpt, body, status. Send only what changes.',
    parameters: {
      type: 'object',
      properties: {
        id_or_slug: { type: 'string' }, title: { type: 'string' }, slug: { type: 'string' },
        excerpt: { type: 'string' }, body: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `Edit blog post ${a.id_or_slug}${a.status ? ` → ${a.status}` : ''}.`; },
    run(args) {
      const raw = String(args.id_or_slug || '').trim();
      const p = /^\d+$/.test(raw)
        ? db.prepare('SELECT * FROM blog_posts WHERE id=?').get(Number(raw))
        : db.prepare('SELECT * FROM blog_posts WHERE slug=?').get(raw);
      if (!p) return { error: 'Post not found.' };
      const title = args.title !== undefined ? String(args.title).trim().slice(0, 200) : p.title;
      if (title.length < 3) return { error: 'Give the post a proper title.' };
      let slug = args.slug !== undefined
        ? String(args.slug || title).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 120)
        : p.slug;
      const clash = db.prepare('SELECT id FROM blog_posts WHERE slug=? AND id<>?').get(slug, p.id);
      if (clash) slug = `${slug}-${Date.now().toString(36)}`;
      const excerpt = args.excerpt !== undefined ? String(args.excerpt).trim().slice(0, 400) : p.excerpt;
      const body = args.body !== undefined ? String(args.body).trim() : p.body;
      const status = args.status !== undefined ? (args.status === 'published' ? 'published' : 'draft') : p.status;
      db.prepare(
        `UPDATE blog_posts SET slug=?, title=?, excerpt=?, body=?, status=?,
           published_at = CASE WHEN ?='published' AND published_at IS NULL THEN datetime('now') ELSE published_at END,
           updated_at = datetime('now') WHERE id=?`
      ).run(slug, title, excerpt, body, status, status, p.id);
      if (status === 'published') submitForIndexing([`/blog/${slug}`]);
      const fresh = db.prepare('SELECT id, slug, title, status, published_at FROM blog_posts WHERE id=?').get(p.id);
      return { ok: true, ...fresh, url: siteUrl(`/blog/${fresh.slug}`) };
    },
  },
  {
    name: 'send_test_email', group: 'content', label: 'Send a test email', mutating: true,
    description: 'Send one real test email through the configured transport (Admin → Settings → Test email) so the operator can confirm deliverability. Without SMTP it lands in data/outbox.log.',
    parameters: {
      type: 'object',
      properties: { to: { type: 'string', description: 'Destination address.' } },
      required: ['to'], additionalProperties: false,
    },
    summarize(a) { return `Send a test email to ${a.to}.`; },
    async run(args) {
      const to = String(args.to || '').trim().toLowerCase().slice(0, 200);
      if (!isEmail(to)) return { error: 'Enter a valid email address.' };
      if (!mailer.mailConfigured()) return { error: 'No SMTP configuration found — add a provider in Admin → Settings or set SMTP_URL in .env.' };
      const r = await mailer.sendTest(to);
      if (!r.ok) return { error: r.error };
      return { ok: true, to, delivered: true, via: r.via || 'smtp', from: mailer.fromAddress() };
    },
  },
  {
    name: 'set_mail_from', group: 'content', label: 'Set email From address', mutating: true,
    description: 'Set the From address used by every mail hop (Admin → Settings → Email). Accepts "Name <addr>" or a bare address.',
    parameters: {
      type: 'object',
      properties: { from: { type: 'string' } },
      required: ['from'], additionalProperties: false,
    },
    summarize(a) { return `Set the mail From address to ${a.from}.`; },
    run(args) {
      const v = validFromAddress(args.from);
      if (!v.ok) return { error: v.error };
      const r = mailer.saveGlobalFrom(v.from);
      if (r && r.ok === false) return { error: r.error };
      return { ok: true, from: mailer.fromAddress() };
    },
  },
  {
    name: 'manage_smtp_account', group: 'content', label: 'Manage SMTP hop', mutating: true, sensitive: true,
    description: 'Manage the multi-SMTP failover chain (Admin → Settings → Email providers): action=add (provider preset or custom host/port/username/password/daily_limit/sort), action=toggle (enable/disable a hop), action=delete. Hops are tried in sort order; when one hits its daily limit the next is used.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'toggle', 'delete'] },
        id: { type: 'integer', description: 'Hop id for toggle/delete.' },
        provider: { type: 'string', description: 'zoho, zoho_pro, emitlo, maileroo, brevo, mailjet, mailtrap, smtp2go, resend, ahasend, smtpfast, forwardemail, dnsexit or custom.' },
        label: { type: 'string' }, host: { type: 'string' }, port: { type: 'integer' },
        secure: { type: 'boolean' }, username: { type: 'string' }, password: { type: 'string' },
        daily_limit: { type: 'integer' }, sort: { type: 'integer' },
      },
      required: ['action'], additionalProperties: false,
    },
    summarize(a) { return `${String(a.action).toUpperCase()} SMTP hop${a.id ? ` #${a.id}` : ''}${a.host ? ` (${a.host})` : ''}.`; },
    run(args) {
      const action = String(args.action || '').toLowerCase();
      if (action === 'add') {
        const r = mailer.addAccount({
          provider: args.provider, label: args.label, host: args.host, port: args.port,
          secure: args.secure ? '1' : '0', username: args.username, password: args.password,
          daily_limit: args.daily_limit, sort: args.sort,
        });
        if (!r.ok) return { error: r.error };
        return { ok: true, added: true, hops: mailer.hops().map((h) => ({ id: h.id, via: h.via, host: h.host })) };
      }
      if (action === 'toggle' || action === 'delete') {
        const id = Number(args.id) || 0;
        if (!id) return { error: 'Pass the hop id.' };
        const row = db.prepare('SELECT id, label, host FROM smtp_accounts WHERE id=?').get(id);
        if (!row) return { error: 'No SMTP hop with that id.' };
        if (action === 'toggle') mailer.toggleAccount(id);
        else mailer.deleteAccount(id);
        const fresh = action === 'toggle' ? db.prepare('SELECT id, label, host, active FROM smtp_accounts WHERE id=?').get(id) : null;
        return { ok: true, action, hop: fresh || row };
      }
      return { error: 'action must be add, toggle or delete.' };
    },
  },
  {
    name: 'delete_promo', group: 'content', label: 'Delete promo code', mutating: true,
    description: 'Delete a promo code (Admin → Promos). Codes with redemptions are deactivated instead so payment history survives.',
    parameters: {
      type: 'object',
      properties: { code_or_id: { type: 'string' } },
      required: ['code_or_id'], additionalProperties: false,
    },
    summarize(a) { return `Delete promo ${a.code_or_id}.`; },
    run(args) {
      const raw = String(args.code_or_id || '').trim();
      const p = /^\d+$/.test(raw) ? db.prepare('SELECT * FROM promo_codes WHERE id=?').get(Number(raw)) : promos.getByCode(raw);
      if (!p) return { error: 'Promo not found.' };
      const r = promos.remove(p.id);
      if (!r.ok) return { error: 'That promo could not be removed.' };
      return { ok: true, code: p.code, deactivated: Boolean(r.deactivated) };
    },
  },
  {
    name: 'update_career', group: 'content', label: 'Edit career role', mutating: true,
    description: 'Edit a FirmLedger career role (Admin → Careers): title, role_type, location, description, requirements, apply_email.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer' }, title: { type: 'string' },
        role_type: { type: 'string', description: 'Full-time, Part-time, Contract, Internship, Remote' },
        location: { type: 'string' }, description: { type: 'string' }, requirements: { type: 'string' },
        apply_email: { type: 'string' },
      },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Edit career role #${a.id}.`; },
    run(args) {
      let patch = args;
      if (args.apply_email !== undefined) {
        const email = String(args.apply_email || '').trim().slice(0, 190);
        if (email && !isEmail(email)) return { error: `"${email}" is not a valid application address.` };
        patch = { ...args, apply_email: email };
      }
      const r = careers.update(patch.id, patch);
      if (!r.ok) return { error: (r.errors || ['That role could not be updated.']).join(' ') }
      return { ok: true, role: careers.get(patch.id) };
    },
  },
  {
    name: 'delete_career', group: 'content', label: 'Delete career role', mutating: true,
    description: 'Delete a career role permanently (Admin → Careers).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Delete career role #${a.id}.`; },
    run(args) {
      const role = careers.get(args.id);
      if (!role) return { error: 'No career role with that id.' };
      careers.remove(args.id);
      return { ok: true, deleted: role.title };
    },
  },
  {
    name: 'manage_ad_package', group: 'content', label: 'Manage ad package', mutating: true,
    description: 'Manage advertising packages (Admin → Advertising): action=create | update | toggle | delete with name, blurb, price_usd, duration_days, sort.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'toggle', 'delete'] },
        id: { type: 'integer' }, name: { type: 'string' }, blurb: { type: 'string' },
        price_usd: { type: 'number' }, duration_days: { type: 'integer' }, sort: { type: 'integer' },
      },
      required: ['action'], additionalProperties: false,
    },
    summarize(a) { return `${String(a.action).toUpperCase()} ad package${a.name ? ` “${a.name}”` : ` #${a.id || ''}`}.`; },
    run(args) {
      const action = String(args.action || '').toLowerCase();
      if (action === 'create') {
        const name = String(args.name || '').trim();
        const price = Math.round(Number(args.price_usd) * 100);
        const days = Math.round(Number(args.duration_days) || 0);
        if (!name) return { error: 'The package needs a name.' };
        if (!(price > 0)) return { error: 'Enter a price above 0.' };
        if (!(days >= 1)) return { error: 'Duration must be at least 1 day (0 for lifetime is not supported here).' };
        const info = ad.createPackage({ name, blurb: args.blurb, priceCents: price, currency: 'USD', durationDays: days, sort: args.sort });
        return { ok: true, created: ad.getPackage(Number(info.lastInsertRowid)) };
      }
      const pkg = ad.getPackage(args.id);
      if (!pkg) return { error: 'No ad package with that id.' };
      if (action === 'update') {
        const updated = ad.updatePackage(pkg.id, {
          name: args.name, blurb: args.blurb, sort: args.sort,
          price_cents: args.price_usd !== undefined ? Math.round(Number(args.price_usd) * 100) : undefined,
          duration_days: args.duration_days,
        });
        return { ok: true, package: updated };
      }
      if (action === 'toggle') return { ok: true, package: ad.togglePackage(pkg.id) };
      if (action === 'delete') { ad.deletePackage(pkg.id); return { ok: true, deleted: pkg.name }; }
      return { error: 'action must be create, update, toggle or delete.' };
    },
  },
  {
    name: 'notify_members', group: 'content', label: 'In-app announcement', mutating: true, sensitive: true,
    description: 'Post an in-app announcement into members’ notification bells (audience all | pro | free | one email). Cheaper than email and it does not consume SMTP quota. Emailing everyone is a separate, louder action.',
    parameters: {
      type: 'object',
      properties: {
        audience: { type: 'string', description: 'all | pro | free | a specific email' },
        title: { type: 'string' }, body: { type: 'string' },
        url: { type: 'string' }, kind: { type: 'string' },
      },
      required: ['audience', 'title'], additionalProperties: false,
    },
    summarize(a) { return `In-app announcement to ${a.audience}: “${a.title}”.`; },
    run(args) {
      const title = String(args.title || '').trim().slice(0, 200);
      if (!title) return { error: 'A title is required.' };
      const body = String(args.body || '').trim().slice(0, 2000);
      const url = String(args.url || '/dashboard').slice(0, 400);
      const kind = String(args.kind || 'info').slice(0, 40);
      const audience = String(args.audience || 'all').trim().toLowerCase();
      const today = new Date().toISOString().slice(0, 10);
      const proSql = "(plan='pro' AND (plan_expires_at IS NULL OR plan_expires_at='' OR plan_expires_at >= ?))";
      let users = [];
      if (audience === 'all') users = db.prepare('SELECT id, email FROM users').all();
      else if (audience === 'pro') users = db.prepare(`SELECT id, email FROM users WHERE ${proSql}`).all(today);
      else if (audience === 'free') users = db.prepare(`SELECT id, email FROM users WHERE NOT ${proSql}`).all(today);
      else {
        const u = findUser(audience);
        if (!u) return { error: 'Unknown audience. Use all, pro, free, or a member email/id.' };
        users = [{ id: u.id, email: u.email }];
      }
      if (!users.length) return { error: 'That audience is empty right now.' };
      let queued = 0;
      for (const u of users) {
        if (notify.notifyUser(u.id, { kind, title, body, url })) queued++;
      }
      return { ok: true, queued, audience, title };
    },
  },
  {
    name: 'manage_newsletter_subscriber', group: 'content', label: 'Newsletter subscriber', mutating: true,
    description: 'Add or remove a newsletter subscriber by email (the list behind the digest).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove'] },
        email: { type: 'string' },
      },
      required: ['action', 'email'], additionalProperties: false,
    },
    summarize(a) { return `${String(a.action).toUpperCase()} newsletter subscriber ${a.email}.`; },
    run(args) {
      const email = String(args.email || '').trim().toLowerCase();
      if (!isEmail(email)) return { error: 'Enter a valid email address.' };
      const action = String(args.action || '').toLowerCase();
      if (action === 'add') {
        const r = nl.subscribe(email, 'admin');
        if (r && r.ok === false) return { error: r.error };
        return { ok: true, email, active: true, subscribers: nl.subCount(true) };
      }
      const row = db.prepare('SELECT * FROM newsletter_subscribers WHERE email=?').get(email);
      if (!row) return { error: 'That address is not on the list.' };
      nl.unsubscribe(row.token || email);
      const fresh = db.prepare('SELECT active FROM newsletter_subscribers WHERE email=?').get(email);
      return { ok: true, email, active: Boolean(fresh && fresh.active), subscribers: nl.subCount(true) };
    },
  },
  {
    name: 'post_admin_notification', group: 'content', label: 'Note to the console inbox', mutating: true,
    description: 'Post a note into the admin console inbox (the bell) — a reminder for whoever runs the console next.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' }, url: { type: 'string' }, kind: { type: 'string' } },
      required: ['title'], additionalProperties: false,
    },
    summarize(a) { return `Post a console note: “${a.title}”.`; },
    run(args) {
      const id = notify.notifyAdmin({
        kind: args.kind || 'system',
        title: String(args.title || '').slice(0, 200),
        body: String(args.body || '').slice(0, 2000),
        url: String(args.url || '/admin3119Musa/dashboard').slice(0, 400),
      });
      return id ? { ok: true, id: Number(id) } : { error: 'The note could not be stored.' };
    },
  },

  /* ==========================================================================
   * Site operations — protection, maintenance, indexing, status, notifications,
   * upkeep, credentials and the AI playground itself.
   * ======================================================================== */
  {
    name: 'update_settings', group: 'ops', label: 'Site settings', mutating: true, sensitive: true,
    description: 'Change site-wide settings (Admin → Settings / Protection / News / Upkeep): auto_approve, indexing_enabled, google_indexing_enabled, admin_email, newsletter_cadence, news_review_auto, maintenance_title, maintenance_message, maintenance_eta, status_weekly_report, upkeep_on, upkeep_tech_on, upkeep_news_on, upkeep_tech_limit, upkeep_news_limit, upkeep_news_max_age_days. Send only the keys to change; booleans as true/false.',
    parameters: {
      type: 'object',
      properties: {
        auto_approve: { type: 'boolean' },
        indexing_enabled: { type: 'boolean' },
        google_indexing_enabled: { type: 'boolean' },
        admin_email: { type: 'string' },
        newsletter_cadence: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
        news_review_auto: { type: 'boolean' },
        maintenance_title: { type: 'string' },
        maintenance_message: { type: 'string' },
        maintenance_eta: { type: 'string' },
        status_weekly_report: { type: 'boolean' },
        upkeep_on: { type: 'boolean' },
        upkeep_tech_on: { type: 'boolean' },
        upkeep_news_on: { type: 'boolean' },
        upkeep_tech_limit: { type: 'integer' },
        upkeep_news_limit: { type: 'integer' },
        upkeep_news_max_age_days: { type: 'integer' },
      },
      additionalProperties: false,
    },
    summarize(a) { return `Change site settings: ${Object.keys(a).join(', ')}.`; },
    run(args) {
      const allowed = {
        auto_approve: 'bool', indexing_enabled: 'bool', google_indexing_enabled: 'bool',
        news_review_auto: 'bool', status_weekly_report: 'bool', upkeep_on: 'bool',
        upkeep_tech_on: 'bool', upkeep_news_on: 'bool',
        admin_email: 'email', maintenance_title: 'text:120', maintenance_message: 'text:2000',
        maintenance_eta: 'text:80', newsletter_cadence: 'enum:daily,weekly,monthly',
        upkeep_tech_limit: 'int:1:500', upkeep_news_limit: 'int:1:500', upkeep_news_max_age_days: 'int:1:365',
      };
      const changes = {};
      for (const [key, value] of Object.entries(args)) {
        const rule = allowed[key];
        if (!rule) return { error: `“${key}” cannot be changed with this tool.` };
        if (rule === 'bool') {
          changes[key] = { from: getSetting(key, ''), to: value ? '1' : '0' };
        } else if (rule === 'email') {
          const v = String(value || '').trim().toLowerCase();
          if (v && !isEmail(v)) return { error: 'admin_email must be a valid address (or empty for the default).' };
          changes[key] = { from: getSetting(key, ''), to: v };
        } else if (rule.startsWith('text:')) {
          changes[key] = { from: getSetting(key, ''), to: String(value || '').trim().slice(0, Number(rule.split(':')[1])) };
        } else if (rule.startsWith('enum:')) {
          const options = rule.split(':')[1].split(',');
          if (!options.includes(String(value))) return { error: `${key} must be one of: ${options.join(', ')}.` };
          changes[key] = { from: getSetting(key, ''), to: String(value) };
        } else if (rule.startsWith('int:')) {
          const [, min, max] = rule.split(':');
          const n = Math.round(Number(value));
          if (!Number.isFinite(n) || n < Number(min) || n > Number(max)) return { error: `${key} must be between ${min} and ${max}.` };
          changes[key] = { from: getSetting(key, ''), to: String(n) };
        }
      }
      if (!Object.keys(changes).length) return { error: 'Nothing to change — send at least one setting.' };
      for (const [key, c] of Object.entries(changes)) setSetting(key, c.to);
      if ('upkeep_on' in changes || 'upkeep_tech_on' in changes || 'upkeep_news_on' in changes
        || 'upkeep_tech_limit' in changes || 'upkeep_news_limit' in changes || 'upkeep_news_max_age_days' in changes) {
        try { upkeep.save({
          upkeep_on: getSetting('upkeep_on', '1'), upkeep_tech_on: getSetting('upkeep_tech_on', '1'),
          upkeep_news_on: getSetting('upkeep_news_on', '1'), upkeep_tech_limit: getSetting('upkeep_tech_limit', ''),
          upkeep_news_limit: getSetting('upkeep_news_limit', ''), upkeep_news_max_age_days: getSetting('upkeep_news_max_age_days', ''),
        }); } catch { /* the raw settings are already stored */ }
      }
      return { ok: true, changes, flags: sitecontext.flagsSnapshot() };
    },
  },
  {
    name: 'set_rate_limits', group: 'ops', label: 'Rate limits', mutating: true, sensitive: true,
    description: 'Change the protection rate limits (Admin → Protection): login, register, listing, claim, newsletter, status, search (per minute), scrape (per minute), api_read_rpm, api_write_rpm. Send only the ones to change; 0 disables a limit.',
    parameters: {
      type: 'object',
      properties: {
        login: { type: 'integer' }, register: { type: 'integer' }, listing: { type: 'integer' },
        claim: { type: 'integer' }, newsletter: { type: 'integer' }, status: { type: 'integer' },
        search: { type: 'integer' }, scrape: { type: 'integer' },
        api_read_rpm: { type: 'integer' }, api_write_rpm: { type: 'integer' },
      },
      additionalProperties: false,
    },
    summarize(a) { return `Change rate limits: ${Object.keys(a).join(', ')}.`; },
    run(args) {
      const keys = Object.keys(spam.DEFAULTS);
      const body = {};
      const changes = {};
      for (const [k, v] of Object.entries(args)) {
        const key = keys.includes(k) ? k : (keys.includes(`spam_rl_${k}`) ? `spam_rl_${k}` : null);
        if (!key) return { error: `“${k}” is not a rate limit. Known: ${keys.join(', ')}.` };
        const n = Math.round(Number(v));
        if (!Number.isFinite(n) || n < 0 || n > 100000) return { error: `${key} must be 0–100000.` };
        body[key] = n;
        changes[key] = { from: getSetting(key, String(spam.DEFAULTS[key])), to: String(n) };
      }
      if (!Object.keys(body).length) return { error: 'Nothing to change — send at least one limit.' };
      spam.saveLimits(body);
      return { ok: true, changes, limits: spam.limits() };
    },
  },
  {
    name: 'delete_ip_rule', group: 'ops', label: 'Delete IP rule', mutating: true,
    description: 'Remove an IP from the protection allow/block list by rule id (see get_protection for ids).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Delete IP rule #${a.id}.`; },
    run(args) {
      const row = db.prepare('SELECT * FROM spam_ip WHERE id=?').get(Number(args.id) || 0);
      if (!row) return { error: 'No IP rule with that id.' };
      spam.removeIp(row.id);
      return { ok: true, deleted: row };
    },
  },
  {
    name: 'delete_domain_rule', group: 'ops', label: 'Delete domain rule', mutating: true,
    description: 'Remove an email domain from the protection allow/block list by rule id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Delete email-domain rule #${a.id}.`; },
    run(args) {
      const row = db.prepare('SELECT * FROM spam_domain WHERE id=?').get(Number(args.id) || 0);
      if (!row) return { error: 'No domain rule with that id.' };
      spam.removeDomain(row.id);
      return { ok: true, deleted: row };
    },
  },
  {
    name: 'regen_indexnow_key', group: 'ops', label: 'Regenerate IndexNow key', mutating: true, sensitive: true,
    description: 'Generate a new IndexNow key (Admin → Settings). The old key file stops working immediately, so search engines need the new one.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Regenerate the IndexNow key.'; },
    run() {
      setSetting('indexnow_key', crypto.randomBytes(16).toString('hex'));
      return { ok: true, key: getIndexNowKey(), note: 'The previous key file is now invalid.' };
    },
  },
  {
    name: 'run_google_indexing_batch', group: 'ops', label: 'Google submission run', mutating: true, sensitive: true,
    description: 'Start the Google Indexing API back-fill (Admin → Settings → Submit first 200): sends approved listings Google has never seen, inside the hard 200/day quota. Runs in the background.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max URLs, capped at the remaining quota (200/day).' } },
      additionalProperties: false,
    },
    summarize(a) { return `Start a Google Indexing submission run (up to ${a.limit || 200} URLs).`; },
    run(args) {
      const st = googleIndexing.status();
      if (!st.configured) {
        return {
          error: 'The Google Indexing API is not connected — upload a service-account key in Admin → Settings → Google Indexing (or set GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON). IndexNow still works; use ping_indexnow for that.',
        };
      }
      const q = googleIndexing.quota();
      if (q.remaining <= 0) return { error: `Google's 200/day quota is used up — ${q.used} submitted in the last 24 hours.` };
      const r = googleIndexing.startBatch(Math.min(q.remaining, Number(args.limit) || 200));
      if (!r.ok) return { error: r.error, job: r.job };
      notify.notifyAdmin({ kind: 'system', title: 'Google submission run started', body: 'Submitting un-pinged listings to the Google Indexing API.', url: '/admin3119Musa/settings' });
      return { ok: true, quota: q, pending: googleIndexing.pendingCount(), job: googleIndexing.jobState() };
    },
  },
  {
    name: 'remove_google_service_account', group: 'ops', label: 'Disconnect Google Indexing', mutating: true, sensitive: true,
    description: 'Delete the stored Google Cloud service-account key so the Indexing API stops being called. The environment variable (if set) keeps working.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Remove the stored Google Indexing service-account key.'; },
    run() {
      googleIndexing.removeServiceAccount();
      const st = googleIndexing.status();
      return { ok: true, still_configured: Boolean(st.configured), source: st.source || '', note: st.env_set ? 'GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON is still set in the environment.' : 'Google indexing is inactive until a new key is uploaded.' };
    },
  },
  {
    name: 'ping_indexnow', group: 'ops', label: 'Ping IndexNow', mutating: true,
    description: 'Submit site-relative URLs to IndexNow right now (Bing, Yandex, Seznam…). Only does anything when indexing is enabled and BASE_URL is a public origin.',
    parameters: {
      type: 'object',
      properties: { urls: { type: 'array', items: { type: 'string' }, description: 'Site-relative paths such as /listing/acme.' } },
      required: ['urls'], additionalProperties: false,
    },
    summarize(a) { return `Ping IndexNow for ${(a.urls || []).length} URL(s).`; },
    run(args) {
      const urls = (Array.isArray(args.urls) ? args.urls : []).map((u) => String(u).trim()).filter(Boolean).slice(0, 50);
      if (!urls.length) return { error: 'Pass at least one URL.' };
      const r = submitForIndexing(urls);
      return { ok: true, submitted: urls.length, result: r || null, enabled: getSetting('indexing_enabled', '1') === '1' };
    },
  },
  {
    name: 'clear_indexing_log', group: 'ops', label: 'Clear indexing log', mutating: true, sensitive: true,
    description: 'Delete every entry in the indexing log (Admin → Settings → Indexing log). The log is the record of what was actually sent to search engines.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Clear the whole indexing log.'; },
    run() {
      const n = indexlog.clearAll();
      return { ok: true, deleted: Number(n) || 0 };
    },
  },
  {
    name: 'delete_indexing_log_entry', group: 'ops', label: 'Delete indexing log entry', mutating: true,
    description: 'Delete one indexing-log entry by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Delete indexing log entry #${a.id}.`; },
    run(args) {
      indexlog.remove(args.id);
      const left = indexlog.count();
      return { ok: true, remaining_entries: left };
    },
  },
  {
    name: 'run_upkeep', group: 'ops', label: 'Run upkeep sweep', mutating: true,
    description: 'Run the automated upkeep sweep now (Admin → Settings → Upkeep → Run): refreshes stale technology radars and checks for fresh listing news, inside the hourly caps.',
    parameters: {
      type: 'object',
      properties: { force: { type: 'boolean', description: 'Run even when the schedule is switched off.' } },
      additionalProperties: false,
    },
    summarize(a) { return `Run the upkeep sweep${a.force ? ' (forced)' : ''}.`; },
    async run(args) {
      const r = await upkeep.runSweep({ force: args.force !== false });
      if (!r.ok) return { error: r.skipped === 'already-running' ? 'An upkeep sweep is already running.' : 'Upkeep is switched off — pass force=true to run it anyway.', detail: r };
      return { ok: true, tech: r.tech || null, news: r.news || null };
    },
  },
  {
    name: 'delete_incident', group: 'ops', label: 'Delete incident', mutating: true, sensitive: true,
    description: 'Permanently delete a status incident and its whole timeline (Admin → Status). It disappears from the public /status page and from the uptime history.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `PERMANENTLY delete incident #${a.id}.`; },
    run(args) {
      const r = mon.deleteIncident(args.id);
      if (!r.ok) return { error: r.error };
      return { ok: true, deleted_id: Number(args.id) };
    },
  },
  {
    name: 'set_component_status', group: 'ops', label: 'Set component status', mutating: true,
    description: 'Force a status-page component to a state: operational, degraded, partial_outage, major_outage. Use when a real problem is known before the probe notices.',
    parameters: {
      type: 'object',
      properties: {
        id_or_slug: { type: 'string' },
        status: { type: 'string', enum: ['operational', 'degraded', 'partial_outage', 'major_outage'] },
      },
      required: ['id_or_slug', 'status'], additionalProperties: false,
    },
    summarize(a) { return `Set ${a.id_or_slug} to ${a.status} on the status page.`; },
    run(args) {
      const raw = String(args.id_or_slug || '').trim();
      const comp = /^\d+$/.test(raw) ? mon.componentById(Number(raw)) : mon.componentBySlug(raw);
      if (!comp) return { error: 'No status component with that id or slug.' };
      const wanted = String(args.status || '').trim().toLowerCase();
      if (!['operational', 'degraded', 'partial_outage', 'major_outage'].includes(wanted)) {
        return { error: 'status must be one of: operational, degraded, partial_outage, major_outage.' };
      }
      mon.setComponentStatus(comp.id, wanted);
      const fresh = mon.componentById(comp.id);
      return { ok: true, component: { id: fresh.id, name: fresh.name, slug: fresh.slug, status: fresh.status }, overall: mon.overallStatus() };
    },
  },
  {
    name: 'reset_component_status', group: 'ops', label: 'Reset component', mutating: true,
    description: 'Clear a component’s detected status and let the next probe decide again. Refuses while an incident on that component is still open.',
    parameters: {
      type: 'object',
      properties: { id_or_slug: { type: 'string' } },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `Reset the detected status of ${a.id_or_slug}.`; },
    run(args) {
      const raw = String(args.id_or_slug || '').trim();
      const comp = /^\d+$/.test(raw) ? mon.componentById(Number(raw)) : mon.componentBySlug(raw);
      if (!comp) return { error: 'No status component with that id or slug.' };
      const r = mon.resetComponentStatus(comp.id);
      if (r && r.ok === false) return { error: r.error };
      return { ok: true, component: mon.componentById(comp.id) };
    },
  },
  {
    name: 'run_status_probes', group: 'ops', label: 'Probe status now', mutating: true,
    description: 'Run every status-page probe immediately (Admin → Status → Refresh) and report what each component answered.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Run all status probes now.'; },
    async run() {
      const results = await mon.checkAll();
      return {
        ok: true,
        overall: mon.overallStatus(),
        results: (Array.isArray(results) ? results : []).map((r) => ({
          component: (r.component && r.component.name) || r.name || '', ok: Boolean(r.ok),
          latency_ms: r.latency_ms || 0, note: r.note || '',
        })),
      };
    },
  },
  {
    name: 'set_status_digest', group: 'ops', label: 'Weekly status digest', mutating: true,
    description: 'Switch the weekly /status subscriber digest on or off, and optionally send it now.',
    parameters: {
      type: 'object',
      properties: {
        weekly_report: { type: 'boolean' },
        send_now: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    summarize(a) { return `${a.send_now ? 'Send the status digest now' : `Weekly status digest ${a.weekly_report ? 'on' : 'off'}`}.`; },
    async run(args) {
      if (args.weekly_report !== undefined) setSetting('status_weekly_report', args.weekly_report ? '1' : '0');
      let sent = null;
      if (args.send_now) {
        try { sent = await mon.sendWeeklyStatusDigest(true); } catch (e) { sent = { error: String(e.message || e) }; }
      }
      return { ok: true, weekly_report: getSetting('status_weekly_report', '1') === '1', subscribers: mon.subscriberCount(), sent };
    },
  },
  {
    name: 'manage_notification', group: 'ops', label: 'Manage inbox entry', mutating: true,
    description: 'Archive, restore, permanently delete or mark-read one console inbox entry (Admin → Inbox / Trash).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['archive', 'restore', 'delete', 'read'] },
        id: { type: 'integer' },
        duration: { type: 'string', enum: ['7d', '30d'], description: 'How long the entry stays in the trash before it is purged (default 30d).' },
      },
      required: ['action', 'id'], additionalProperties: false,
    },
    summarize(a) { return `${String(a.action).toUpperCase()} inbox entry #${a.id}.`; },
    run(args) {
      const id = Number(args.id) || 0;
      const row = db.prepare("SELECT * FROM notifications WHERE id=? AND audience='admin'").get(id);
      if (!row) return { error: 'No console inbox entry with that id.' };
      const action = String(args.action || '').toLowerCase();
      if (action === 'archive') {
        const r = notificationsLib.archive(id, null, args.duration || '30d');
        if (!r.ok) return { error: r.error || 'Could not archive that entry.' };
      } else if (action === 'restore') {
        const r = notificationsLib.restore(id, null);
        if (!r.ok) return { error: r.error || 'That entry is not in the trash.' };
      } else if (action === 'delete') {
        /* permanentDelete removes the row whether or not it was archived first. */
        const r = notificationsLib.permanentDelete(id, null);
        if (!r.ok) return { error: r.error || 'Could not delete that entry.' };
        return { ok: true, action, notification: { id, deleted: true } };
      } else if (action === 'read') {
        notify.markRead(id, { admin: true });
      } else {
        return { error: 'action must be archive, restore, delete or read.' };
      }
      const fresh = db.prepare('SELECT id, title, read_at, archived_at, deleted_at FROM notifications WHERE id=?').get(id);
      return { ok: true, action, notification: fresh || { id, deleted: true } };
    },
  },
  {
    name: 'purge_expired_notifications', group: 'ops', label: 'Purge expired trash', mutating: true,
    description: 'Hard-delete archived notifications whose archive window has passed (runs hourly on its own).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Purge expired archived notifications.'; },
    run() {
      const n = notificationsLib.purgeExpired();
      return { ok: true, purged: Number(n) || 0 };
    },
  },
  {
    name: 'expire_trials_now', group: 'ops', label: 'Expire finished trials', mutating: true,
    description: 'Flip every finished free trial back to paying Pro or Free now (runs hourly on its own).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Expire finished free trials now.'; },
    run() {
      const r = plans.expireTrials();
      return { ok: true, expired: (r && typeof r === 'object' ? r : Number(r) || 0) };
    },
  },
  {
    name: 'set_paypal_credentials', group: 'ops', label: 'PayPal credentials', mutating: true, sensitive: true,
    description: 'Save PayPal REST credentials and mode (Admin → Settings → Payments). Environment variables always win over saved values. Use sandbox unless the operator explicitly says live — live charges real money.',
    parameters: {
      type: 'object',
      properties: {
        client_id: { type: 'string' }, client_secret: { type: 'string' },
        mode: { type: 'string', enum: ['sandbox', 'live'] },
        clear: { type: 'boolean', description: 'true wipes the stored credentials.' },
      },
      additionalProperties: false,
    },
    summarize(a) { return a.clear ? 'Clear the stored PayPal credentials.' : `Save PayPal credentials (mode ${a.mode || 'unchanged'}).`; },
    run(args) {
      if (process.env.PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_SECRET) {
        return { error: 'PayPal credentials are pinned by environment variables — change them in .env, not here.' };
      }
      if (args.clear) {
        setSetting('paypal_client_id', ''); setSetting('paypal_client_secret', '');
        return { ok: true, cleared: true, configured: paypal.configured() };
      }
      if (args.client_id !== undefined) setSetting('paypal_client_id', String(args.client_id || '').trim().slice(0, 300));
      if (args.client_secret !== undefined) setSetting('paypal_client_secret', String(args.client_secret || '').trim().slice(0, 500));
      if (args.mode !== undefined) {
        const m = String(args.mode).toLowerCase();
        if (m !== 'sandbox' && m !== 'live') return { error: 'mode must be sandbox or live.' };
        setSetting('paypal_mode', m);
      }
      return { ok: true, configured: paypal.configured(), mode: paypal.mode(), client_id_set: Boolean(getSetting('paypal_client_id', '')) };
    },
  },
  {
    name: 'set_smtp_credentials', group: 'ops', label: 'Primary SMTP', mutating: true, sensitive: true,
    description: 'Save the primary SMTP transport (Admin → Settings → Email): host, port, user, password, secure, from. Environment (SMTP_URL / MAIL_HOST) always wins. Use manage_smtp_account for extra failover hops.',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string' }, port: { type: 'integer' }, user: { type: 'string' },
        password: { type: 'string' }, secure: { type: 'boolean' }, from: { type: 'string' },
        clear_password: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    summarize(a) { return a.host ? `Save primary SMTP (${a.host}).` : 'Update primary SMTP settings.'; },
    run(args) {
      if (process.env.SMTP_URL || process.env.MAIL_HOST) {
        return { error: 'SMTP is pinned by the environment (SMTP_URL / MAIL_HOST) — change it in .env, not here.' };
      }
      if (args.host !== undefined) {
        const host = String(args.host || '').trim().slice(0, 200);
        if (host && !/^[a-z0-9.-]+$/i.test(host)) return { error: 'host must be a hostname such as smtp.example.com.' };
        setSetting('smtp_host', host);
      }
      if (args.port !== undefined) {
        const port = Math.round(Number(args.port));
        if (!Number.isFinite(port) || port < 1 || port > 65535) return { error: 'port must be between 1 and 65535.' };
        setSetting('smtp_port', String(port));
      }
      if (args.user !== undefined) setSetting('smtp_user', String(args.user || '').trim().slice(0, 200));
      if (args.password !== undefined && String(args.password).trim()) setSetting('smtp_pass', String(args.password).trim().slice(0, 500));
      if (args.clear_password) setSetting('smtp_pass', '');
      if (args.secure !== undefined) setSetting('smtp_secure', args.secure ? '1' : '0');
      if (args.from !== undefined) {
        const v = validFromAddress(args.from);
        if (!v.ok) return { error: v.error };
        mailer.saveGlobalFrom(v.from);
      }
      return { ok: true, configured: mailer.mailConfigured(), from: mailer.fromAddress(), host: getSetting('smtp_host', '') };
    },
  },
  {
    name: 'reset_admin_2fa', group: 'ops', label: 'Reset console 2FA', mutating: true, sensitive: true,
    description: 'Wipe the console’s authenticator enrolment and every recovery code (Admin → Settings → Two-factor). The next console sign-in enrolls a fresh key. Only do this when the operator has lost their authenticator.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Reset the console two-factor enrolment and recovery codes.'; },
    run() {
      setSetting('admin_totp_secret', '');
      setSetting('admin_totp_pending', '');
      setSetting('admin_recovery_codes', '[]');
      try { require('./adminmail2fa').clearEmailCode(); } catch { /* best-effort */ }
      notify.notifyAdmin({ kind: 'system', title: 'Console two-factor was reset', body: 'The authenticator enrolment and all recovery codes were wiped. The next sign-in enrolls a fresh key.', url: '/admin3119Musa/settings' });
      return { ok: true, reset: true, note: 'The next console sign-in shows the enrolment QR again.' };
    },
  },
  {
    name: 'set_admin_otp_email', group: 'ops', label: 'Console OTP inbox', mutating: true, sensitive: true,
    description: 'Change the inbox that receives the console sign-in one-time codes (Admin → Settings). Empty returns to the default admin inbox.',
    parameters: {
      type: 'object',
      properties: { email: { type: 'string', description: 'New inbox, or an empty string to go back to the default admin inbox.' } },
      additionalProperties: false,
    },
    summarize(a) { return `Send console sign-in OTPs to ${a.email || 'the default admin inbox'}.`; },
    run(args) {
      /* `email` is deliberately not in `required`: an empty string is a real
         instruction (fall back to the default inbox) and the generic
         missing-argument guard would reject it. */
      if (args.email === undefined) return { error: 'Send an inbox address, or an empty string to go back to the default admin inbox.' };
      const raw = String(args.email || '').trim().slice(0, 120);
      if (raw && !isEmail(raw)) return { error: 'Enter a valid email address.' };
      setSetting('admin_2fa_email', raw);
      return { ok: true, email: raw || '(default admin inbox)' };
    },
  },
  {
    name: 'set_ai_provider', group: 'ops', label: 'Switch AI provider', mutating: true, sensitive: true,
    description: 'Choose which model provider the console uses (Admin → AI Playground → Providers) and its model, plus cross-provider failover and the per-minute call cap. Keys are never handled here — the operator pastes those in the console.',
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'groq, openai, anthropic, gemini, deepseek, huggingface, openrouter, mistral, xai, together, cerebras, fireworks, sambanova, perplexity, azure, custom.' },
        model: { type: 'string', description: 'Model id for that provider.' },
        failover: { type: 'boolean', description: 'Fall over to another configured provider on error.' },
        rate_limit_per_min: { type: 'integer', description: '1–600 calls per minute.' },
      },
      additionalProperties: false,
    },
    summarize(a) { return `Switch the AI provider to ${a.provider || '(unchanged)'}${a.model ? ` / ${a.model}` : ''}.`; },
    run(args) {
      if (args.provider !== undefined) {
        const pid = String(args.provider).trim().toLowerCase();
        if (!llm.isProviderId(pid)) return { error: `“${pid}” is not a supported provider.` };
        if (!llm.configured(pid)) return { error: `${llm.provider(pid).label} has no API key saved yet — add one in the console first.` };
        llm.setActiveProvider(pid);
      }
      const active = llm.activeProviderId();
      if (args.model !== undefined) {
        const model = String(args.model).trim().slice(0, 160);
        if (!model) return { error: 'Send a model id.' };
        if (!llm.knownModelIds(active).includes(model)) llm.addCustomModelId(active, model);
        llm.setSavedModel(active, model);
      }
      if (args.failover !== undefined) setSetting('ai_failover', args.failover ? '1' : '0');
      if (args.rate_limit_per_min !== undefined) {
        const n = Math.round(Number(args.rate_limit_per_min));
        if (!(n >= 1) || n > 600) return { error: 'rate_limit_per_min must be between 1 and 600.' };
        setSetting('ai_rate_limit_per_min', String(n));
      }
      return {
        ok: true, provider: active, label: llm.provider(active).label,
        model: llm.savedModel(active), failover: llm.failoverEnabled(),
        rate_limit_per_min: llm.rateLimitPerMinute(),
      };
    },
  },
  {
    name: 'test_ai_provider', group: 'ops', label: 'Test AI provider', mutating: false,
    description: 'Verify a provider’s key and list the models it can actually call, then send one tiny completion. No data is changed. Use it right after the operator pastes a key.',
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Defaults to the active provider.' },
        model: { type: 'string' },
      },
      additionalProperties: false,
    },
    summarize(a) { return `Test the ${a.provider || 'active'} connection.`; },
    async run(args) {
      const pid = String(args.provider || '').trim().toLowerCase() || llm.activeProviderId();
      if (!llm.isProviderId(pid)) return { error: `“${pid}” is not a supported provider.` };
      const r = await llm.testConnection(pid, args.model);
      if (!r.ok) return { error: r.error || r.list_error || 'The test failed.', detail: r };
      return { ok: true, ...r };
    },
  },
  {
    name: 'manage_ai_models', group: 'ops', label: 'Manage model list', mutating: true,
    description: 'Add or remove a hand-typed model id for a provider (for a release newer than the built-in catalogue), or sync the provider’s live model list.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove', 'sync'] },
        provider: { type: 'string' },
        model: { type: 'string' },
      },
      required: ['action'], additionalProperties: false,
    },
    summarize(a) { return `${String(a.action).toUpperCase()} model${a.model ? ` ${a.model}` : ' list'} for ${a.provider || 'the active provider'}.`; },
    async run(args) {
      const pid = String(args.provider || '').trim().toLowerCase() || llm.activeProviderId();
      if (!llm.isProviderId(pid)) return { error: `“${pid}” is not a supported provider.` };
      const action = String(args.action || '').toLowerCase();
      if (action === 'add') {
        const model = String(args.model || '').trim().slice(0, 160);
        if (!model) return { error: 'Send a model id to add.' };
        return { ok: true, provider: pid, custom_models: llm.addCustomModelId(pid, model) };
      }
      if (action === 'remove') {
        const model = String(args.model || '').trim();
        if (!model) return { error: 'Send a model id to remove.' };
        return { ok: true, provider: pid, custom_models: llm.removeCustomModelId(pid, model) };
      }
      if (action === 'sync') {
        try {
          const r = await llm.syncModels(pid);
          return { ok: true, ...r };
        } catch (e) {
          return { error: e.message };
        }
      }
      return { error: 'action must be add, remove or sync.' };
    },
  },
  {
    name: 'clear_ai_logs', group: 'ops', label: 'Clear AI logs', mutating: true, sensitive: true,
    description: 'Delete the AI audit log, the moderation log, or both. These are the operator’s record of every assistant action — clearing them is a deliberate act.',
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['audit', 'moderation', 'both'] } },
      required: ['kind'], additionalProperties: false,
    },
    summarize(a) { return `Clear the AI ${a.kind} log.`; },
    run(args) {
      const kind = String(args.kind || '').toLowerCase();
      const out = { ok: true };
      if (kind === 'audit' || kind === 'both') out.audit_deleted = db.prepare('DELETE FROM ai_audit_log').run().changes;
      if (kind === 'moderation' || kind === 'both') out.moderation_deleted = db.prepare('DELETE FROM ai_moderation_log').run().changes;
      if (kind !== 'audit' && kind !== 'moderation' && kind !== 'both') return { error: 'kind must be audit, moderation or both.' };
      return out;
    },
  },
  {
    name: 'delete_ai_log_entry', group: 'ops', label: 'Delete AI log entry', mutating: true,
    description: 'Delete one AI audit-log or moderation-log entry by id.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['audit', 'moderation'] },
        id: { type: 'integer' },
      },
      required: ['kind', 'id'], additionalProperties: false,
    },
    summarize(a) { return `Delete ${a.kind} log entry #${a.id}.`; },
    run(args) {
      const id = Number(args.id) || 0;
      const info = args.kind === 'moderation'
        ? db.prepare('DELETE FROM ai_moderation_log WHERE id=?').run(id)
        : db.prepare('DELETE FROM ai_audit_log WHERE id=?').run(id);
      if (!info.changes) return { error: 'No log entry with that id.' };
      return { ok: true, deleted: id, kind: args.kind };
    },
  },

  /* ==========================================================================
   * The last three console actions: restore a backup, connect the Google
   * Indexing key, and regenerate the admin recovery codes.
   * ======================================================================== */
  {
    name: 'import_backup', group: 'users', label: 'Restore a backup', mutating: true, sensitive: true,
    description:
      'Import a FirmLedger export/backup (.firmledger) — the same upload as Admin → Users → Import. It creates and updates member accounts, and when the file also holds the ledger and configuration it restores those tables too. Give either a file name that create_backup wrote into data/backups, or the raw export JSON. Existing rows are matched by email/slug and updated, never duplicated.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'A file name inside data/backups, e.g. firmledger-backup-2026-09-08-10-11-12.firmledger.' },
        payload: { type: 'string', description: 'The raw export JSON, if the operator pasted it.' },
      },
      additionalProperties: false,
    },
    summarize(a) { return `Restore the backup ${a.file || 'the operator pasted'} over the current data.`; },
    run(args) {
      let text = String(args.payload || '');
      let source = 'pasted JSON';
      if (!text && args.file) {
        /* Only ever a plain file name inside the backups directory. */
        const dir = path.join(
          process.env.FIRMLEDGER_DATA_DIR ? path.resolve(process.env.FIRMLEDGER_DATA_DIR) : path.join(__dirname, '..', '..', 'data'),
          'backups',
        );
        const file = path.resolve(dir, path.basename(String(args.file)));
        if (!file.startsWith(path.resolve(dir) + path.sep)) return { error: 'That path is outside data/backups.' };
        if (!fs.existsSync(file)) {
          const have = fs.existsSync(dir) ? fs.readdirSync(dir).slice(-5) : [];
          return { error: `No backup file called “${path.basename(file)}”.`, available: have };
        }
        try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { error: `Could not read that file: ${e.message}` }; }
        source = path.basename(file);
      }
      if (!text.trim()) return { error: 'Send a backup file name from data/backups, or the raw export JSON.' };
      const r = backup.importUsers(text);
      if (!r.ok) return { error: r.error };
      return {
        ok: true, source,
        users_created: r.created, users_updated: r.updated, skipped: r.skipped || 0,
        restored: r.restore ? { records_created: r.restore.created, records_updated: r.restore.updated, tables: r.restore.tables } : null,
        restore_error: r.restoreError || '',
      };
    },
  },
  {
    name: 'set_google_service_account', group: 'ops', label: 'Connect Google Indexing', mutating: true, sensitive: true,
    description:
      'Save a Google Cloud service-account key so the Indexing API can be called (Admin → Settings → Google Indexing). Accepts the JSON contents of the key file. The key is written to data/service-account.json with 0600 permissions; GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON in the environment wins over it. The private key is never repeated back.',
    parameters: {
      type: 'object',
      properties: {
        json: { type: 'string', description: 'The full service-account JSON (type, project_id, private_key, client_email…).' },
      },
      required: ['json'], additionalProperties: false,
    },
    summarize() { return 'Save a Google Cloud service-account key for the Indexing API.'; },
    run(args) {
      const raw = String(args.json || '').trim();
      if (!raw) return { error: 'Paste the service-account JSON.' };
      const r = googleIndexing.saveServiceAccount(raw);
      if (!r.ok) return { error: r.error };
      notify.notifyAdmin({
        kind: 'system', title: 'Google Indexing API connected',
        body: `${r.client_email} — new and updated listings will ping Google automatically.`,
        url: '/admin3119Musa/settings',
      });
      const st = googleIndexing.status();
      return {
        ok: true, client_email: r.client_email || '', project_id: r.project_id || '',
        configured: Boolean(st.configured), source: st.source || 'file',
        note: 'Approved and updated listings now ping Google automatically, inside the 200/day quota.',
      };
    },
  },
  {
    name: 'regen_admin_recovery_codes', group: 'ops', label: 'Regenerate console recovery codes', mutating: true, sensitive: true,
    description:
      'Generate a fresh set of 10 one-time console recovery codes (Admin → Settings → Two-factor → Regenerate). Every previous code stops working immediately and the new set is emailed to the console sign-in inbox. The codes are never shown in chat — they appear only in that email and on the console screen.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Regenerate the 10 one-time console recovery codes (old ones die instantly).'; },
    run() {
      if (!getSetting('admin_totp_secret', '')) {
        return { error: 'Two-factor is not enrolled yet — recovery codes are generated during enrolment. Sign in to the console once to enrol, or use reset_admin_2fa to start again.' };
      }
      const codes = backup.genAdminRecoveryCodes(10);
      setSetting('admin_recovery_codes', JSON.stringify(codes.map((c) => ({ h: backup.hashAdminCode(c), used: 0 }))));
      const to = getSetting('admin_2fa_email', '') || getSetting('admin_email', '') || '';
      if (to && isEmail(to)) {
        sendBranded(to, 'Fresh set: your admin recovery codes — keep these safe', {
          kicker: 'Admin security', title: 'Your new admin recovery codes',
          preheader: '10 one-time codes that open the admin console if the authenticator app is unreachable.',
          alertTone: 'warn',
          alert: 'All previous recovery codes stopped working the instant this set was generated.',
          paragraphs: [
            'Each of the 10 codes below works <strong>exactly once</strong> at the console two-factor screen, in place of the authenticator code.',
            `<code style="display:block;background:#F5F7FA;border:1px solid #E3E8EF;border-radius:10px;padding:14px 16px;font-family:ui-monospace,Consolas,monospace;font-size:13.5px;line-height:1.9;white-space:pre-wrap">${codes.map((c, i) => `${i + 1}. ${c}`).join('\n')}</code>`,
            'Keep them offline and private — anyone with a code and the ADMIN_SECRET can open the console.',
          ],
          note: 'Generated from Admin → AI Playground. Regenerate again any time in Admin → Settings → Two-factor.',
        }).catch(() => {});
      }
      notify.notifyAdmin({
        kind: 'system', title: 'Console recovery codes regenerated',
        body: 'A fresh set of 10 one-time codes was created; every previous code stopped working.',
        url: '/admin3119Musa/settings',
      });
      return { ok: true, codes: 10, emailed_to: to || '(no console inbox set — the codes were not emailed)', previous_codes_invalid: true };
    },
  },

];

const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/** Tools the assistant may actually use right now (group scope switch). */
function availableTools() {
  const on = new Set(enabledGroups());
  return TOOLS.filter((t) => on.has(t.group || 'ops'));
}

function groupEnabled(name) {
  const t = getTool(name);
  if (!t) return true;
  return enabledGroups().includes(t.group || 'ops');
}

/**
 * Tool schemas in the OpenAI function-calling shape. llm.js adapts them to the
 * Anthropic and Gemini wire formats when another provider is active.
 */
function groqTools(opts = {}) {
  const list = opts.all ? TOOLS : availableTools();
  return list.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }));
}

function getTool(name) { return BY_NAME[name] || null; }

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return { _raw: String(raw) }; }
}

function describeCall(name, args) {
  const t = getTool(name);
  if (!t) return `Unknown action “${name}”.`;
  try { return t.summarize(args || {}); } catch { return t.label || t.name; }
}

function autoSet() {
  let arr = [];
  try { arr = JSON.parse(getSetting('ai_auto_tools', '[]') || '[]'); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  return new Set(arr.map(String));
}

/** A tool is sensitive when it is flagged, or when it used the older neverAuto flag. */
function isSensitive(name) {
  const t = getTool(name);
  return Boolean(t && (t.sensitive || t.neverAuto));
}

/**
 * Does this tool run without asking?
 *   read-only          → yes, always
 *   sensitive / neverAuto → no, never (the operator confirms every time)
 *   other writes       → only when the admin ticked it under Settings → Auto-run
 */
function isAuto(name) {
  const t = getTool(name);
  if (!t) return false;
  if (t.sensitive || t.neverAuto) return false;
  if (!t.mutating) return true;
  return autoSet().has(name);
}

function catalog() {
  const auto = autoSet();
  const on = new Set(enabledGroups());
  return TOOLS.map((t) => ({
    name: t.name,
    group: t.group || 'ops',
    label: t.label || t.name,
    description: t.description,
    mutating: Boolean(t.mutating),
    sensitive: Boolean(t.sensitive || t.neverAuto),
    neverAuto: Boolean(t.neverAuto),
    enabled: on.has(t.group || 'ops'),
    auto: !t.mutating || (!t.sensitive && !t.neverAuto && auto.has(t.name)),
  }));
}

function saveAutoTools(names) {
  /* Sensitive actions can never be auto-run, so they are not offered at all. */
  const allowed = new Set(
    TOOLS.filter((t) => t.mutating && !t.sensitive && !t.neverAuto).map((t) => t.name)
  );
  const list = [...new Set((Array.isArray(names) ? names : [names]).map(String).filter((n) => allowed.has(n)))];
  setSetting('ai_auto_tools', JSON.stringify(list));
  return list;
}

async function execute(name, args) {
  const t = getTool(name);
  if (!t) return { ok: false, error: `Unknown tool “${name}”.` };
  if (!groupEnabled(name)) {
    return {
      ok: false,
      error: `“${name}” belongs to a tool group the operator switched off in Admin → AI Playground → Settings. Say so plainly; do not retry.`,
    };
  }
  const parsed = parseArgs(args);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed._raw) {
    return { ok: false, error: 'The model returned invalid arguments for this action. Please try the request again.' };
  }
  const required = (t.parameters && Array.isArray(t.parameters.required)) ? t.parameters.required : [];
  const missing = required.filter((key) => parsed[key] === undefined || parsed[key] === null || String(parsed[key]).trim() === '');
  if (missing.length) return { ok: false, error: `Missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.` };
  const result = await t.run(parsed);
  if (result && result.error) return { ok: false, error: result.error, result };
  return { ok: true, result };
}

/**
 * What the model is told about its own reach: one line per tool, grouped by
 * console area, tagged read / write / WRITE-CONFIRM so the model plans a
 * multi-step job and knows which steps will stop for the operator.
 *
 * The full descriptions travel in the tool schemas themselves, so the default
 * prompt is the compact one. Pass { descriptions: true } when the schemas are
 * not being sent (a provider without function calling) and the model needs the
 * detail inline.
 */
function capabilityPrompt(opts = {}) {
  const on = new Set(enabledGroups());
  const lines = [];
  for (const g of GROUPS) {
    const items = TOOLS.filter((t) => (t.group || 'ops') === g.id && (opts.all || on.has(g.id)));
    if (!items.length) continue;
    lines.push(`[${g.label}]`);
    for (const t of items) {
      const kind = !t.mutating ? 'read' : (t.sensitive || t.neverAuto ? 'WRITE-CONFIRM' : 'write');
      const detail = opts.descriptions
        ? String(t.description || t.label || '').replace(/\s+/g, ' ').trim()
        : String(t.label || t.name);
      lines.push(`- ${t.name} (${kind}): ${detail}`);
    }
  }
  return lines.join('\n');
}

/** Numbers for the console header and the settings summary. */
function stats() {
  const c = catalog();
  return {
    total: c.length,
    reads: c.filter((t) => !t.mutating).length,
    writes: c.filter((t) => t.mutating).length,
    sensitive: c.filter((t) => t.sensitive).length,
    auto: c.filter((t) => t.mutating && t.auto).length,
    groups: enabledGroups().length,
  };
}

module.exports = {
  TOOLS, GROUPS, groqTools, availableTools, getTool, parseArgs, describeCall, execute,
  findListing, findUser, findTicket, approveListingRow, rejectListingRow, createListingRow,
  isAuto, isSensitive, catalog, saveAutoTools, autoSet, capabilityPrompt, stats,
  enabledGroups, saveEnabledGroups, groupEnabled,
};
