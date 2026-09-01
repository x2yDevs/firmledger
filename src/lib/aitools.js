/**
 * Admin assistant tool registry.
 *
 * Adding a tool: push an entry to TOOLS with { name, group, label, description,
 * parameters, mutating, neverAuto, summarize, run }. Groq schemas are derived
 * automatically. Mutating run() is invoked only after UI confirm — unless the
 * admin ticked the tool in Settings → Auto-run. neverAuto tools always confirm.
 */
const { db, getSetting, setSetting } = require('../db');
const { sendBranded, mailConfigured } = require('./mailer');
const { submitForIndexing } = require('./indexing');
const { deleteLogo } = require('./upload');
const notify = require('./notify');
const { siteUrl, escHtml, normalizeUrl, slugify, randomToken } = require('./util');
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
  if (firstApproval) {
    const catSlug = (db.prepare('SELECT slug FROM categories WHERE name = ?').get(l.category) || {}).slug;
    submitForIndexing([`/listing/${l.slug}`, catSlug ? `/directory/c/${catSlug}` : null].filter(Boolean));
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
  { id: 'read', label: 'Lookups (always run, no confirm)' },
  { id: 'listings', label: 'Listings' },
  { id: 'users', label: 'Users & billing' },
  { id: 'moderation', label: 'Claims, tickets, removals' },
  { id: 'content', label: 'Blog, email, careers, promos' },
  { id: 'ops', label: 'Site operations' },
];

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
    name: 'accept_all_pending_listings', group: 'listings', label: 'Approve ALL pending', mutating: true,
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
    name: 'delete_listing', group: 'listings', label: 'Delete listing', mutating: true,
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
    name: 'set_listing_owner', group: 'listings', label: 'Set listing owner', mutating: true,
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
    name: 'delete_category', group: 'listings', label: 'Delete category', mutating: true,
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
    name: 'delete_user', group: 'users', label: 'Delete user account', mutating: true, neverAuto: true,
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
    name: 'revoke_user_pro', group: 'users', label: 'Revoke account Pro', mutating: true,
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
    name: 'fulfill_removal', group: 'moderation', label: 'Remove listing from request', mutating: true,
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
      if (l) {
        deleteLogo(l.logo_url);
        db.prepare('DELETE FROM listings WHERE id=?').run(l.id);
      }
      db.prepare("UPDATE removal_requests SET status='removed', resolved_at=datetime('now') WHERE id=?").run(r.id);
      return { ok: true, id: r.id, listing: l ? l.name : null };
    },
  },

  /* ---------------- Content ---------------- */
  {
    name: 'email_users', group: 'content', label: 'Email members', mutating: true,
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
    name: 'email_all_users', group: 'content', label: 'Email ALL users', mutating: true,
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
    name: 'delete_blog_post', group: 'content', label: 'Delete blog post', mutating: true,
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
    name: 'set_maintenance_mode', group: 'ops', label: 'Maintenance mode', mutating: true,
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
    name: 'send_newsletter_digest', group: 'ops', label: 'Send digest now', mutating: true,
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
    name: 'block_ip', group: 'ops', label: 'Block or allow IP', mutating: true,
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
    name: 'block_domain', group: 'ops', label: 'Block or allow email domain', mutating: true,
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
];

const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

function groqTools() {
  return TOOLS.map((t) => ({
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

function isAuto(name) {
  const t = getTool(name);
  if (!t) return false;
  if (t.neverAuto) return false;
  if (!t.mutating) return true;
  return autoSet().has(name);
}

function catalog() {
  const auto = autoSet();
  return TOOLS.map((t) => ({
    name: t.name,
    group: t.group || 'ops',
    label: t.label || t.name,
    description: t.description,
    mutating: Boolean(t.mutating),
    neverAuto: Boolean(t.neverAuto),
    auto: !t.mutating || (!t.neverAuto && auto.has(t.name)),
  }));
}

function saveAutoTools(names) {
  const allowed = new Set(
    TOOLS.filter((t) => t.mutating && !t.neverAuto).map((t) => t.name)
  );
  const list = [...new Set((Array.isArray(names) ? names : [names]).map(String).filter((n) => allowed.has(n)))];
  setSetting('ai_auto_tools', JSON.stringify(list));
  return list;
}

async function execute(name, args) {
  const t = getTool(name);
  if (!t) return { ok: false, error: `Unknown tool “${name}”.` };
  const parsed = parseArgs(args);
  const result = await t.run(parsed);
  if (result && result.error) return { ok: false, error: result.error, result };
  return { ok: true, result };
}

function capabilityPrompt() {
  const lines = TOOLS.map((t) => `- ${t.name}: ${t.label || t.name}`);
  return lines.join('\n');
}

module.exports = {
  TOOLS, GROUPS, groqTools, getTool, parseArgs, describeCall, execute,
  findListing, approveListingRow, rejectListingRow,
  isAuto, catalog, saveAutoTools, autoSet, capabilityPrompt,
};

