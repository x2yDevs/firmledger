/**
 * Shared helpers for the admin assistant tool registries.
 *
 * Split out of `aitools.js` so the second registry (`aitools-admin.js`) can use
 * the exact same lookups and listing transitions — one implementation, two
 * files of tool definitions. `aitools.js` re-exports everything here, so
 * `require('./aitools').approveListingRow` keeps working for existing callers.
 */
const { db, getSetting, setSetting } = require('../db');
const { sendBranded, mailConfigured } = require('./mailer');
const { submitForIndexing } = require('./indexing');
const googleIndexing = require('./googleIndexing');
const notify = require('./notify');
const { escHtml } = require('./util');
const listingEvents = require('./listingevents');

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
          alias: 'hello',
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

/* ------------------------------------------------------------ small utils */

function bool(v) {
  return v === true || v === 1 || v === '1' || v === 'on' || v === 'true' || v === 'yes';
}

function str(v, max = 4000) { return String(v == null ? '' : v).trim().slice(0, max); }

function int(v, fallback = 0) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function row(sql, ...params) {
  try { return db.prepare(sql).get(...params); } catch { return null; }
}

function rows(sql, ...params) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function countOf(sql, ...params) {
  try { return db.prepare(sql).get(...params).c; } catch { return 0; }
}

module.exports = {
  db, getSetting, setSetting,
  findListing, findUser, approveListingRow, rejectListingRow, queueMail,
  bool, str, int, num, row, rows, countOf,
};
