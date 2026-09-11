/**
 * FirmLedger leads — direct conversion on every claimed business listing.
 *
 * A visitor opens “Contact this business” on a claimed (verified-owner)
 * profile and sends an inquiry. The lead lands with the verified owner in
 * Dashboard → Leads and by email. The owner's email address is never exposed
 * anywhere in the flow — the inquirer only ever sees the form.
 *
 * The inbox is a FirmLedger Pro feature: leads are collected for every
 * claimed listing, but reading and managing them needs Pro access.
 */
const { db } = require('../db');
const { isEmail } = require('./util');

const STATUSES = ['new', 'contacted', 'qualified', 'won', 'lost'];
const STATUS_LABELS = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  won: 'Won',
  lost: 'Lost',
};

function clean(s, max = 500) {
  return String(s || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function validate({ name, email, phone, looking_for, message }) {
  const errors = [];
  const n = clean(name, 120);
  const e = String(email || '').trim().toLowerCase().slice(0, 254);
  const p = clean(phone, 40);
  const lf = clean(looking_for, 120);
  const m = String(message || '').trim().slice(0, 2000);
  if (n.length < 2) errors.push('Tell the business your name.');
  if (!isEmail(e)) errors.push('A valid email is required so the business can reply.');
  if (m.length < 10) errors.push('Write a message of at least 10 characters so the business knows what you need.');
  return { errors, fields: { name: n, email: e, phone: p, looking_for: lf, message: m } };
}

/** Create a lead for a claimed listing. Returns { ok, id } or { ok:false, error }. */
function create({ listing, fields, city = '', country = '' }) {
  if (!listing || !listing.owner_user_id) return { ok: false, error: 'This business cannot receive inquiries yet.' };
  if (!listing.claimed) return { ok: false, error: 'Only verified businesses can receive inquiries.' };
  const v = validate(fields);
  if (v.errors.length) return { ok: false, error: v.errors[0], errors: v.errors };
  const f = v.fields;
  const r = db.prepare(
    `INSERT INTO leads (listing_id, owner_user_id, name, email, phone, looking_for, message, city, country)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(listing.id, listing.owner_user_id, f.name, f.email, f.phone, f.looking_for, f.message,
    String(city || '').slice(0, 80), String(country || '').slice(0, 80));
  return { ok: true, id: Number(r.lastInsertRowid), fields: f };
}

/** Status counts for an owner's inbox (excludes archived). */
function countsForOwner(ownerId) {
  const out = { new: 0, contacted: 0, qualified: 0, won: 0, lost: 0, total: 0, archived: 0 };
  try {
    const rows = db.prepare(
      `SELECT status, archived, COUNT(*) AS c FROM leads WHERE owner_user_id=? GROUP BY status, archived`
    ).all(ownerId);
    for (const r of rows) {
      if (r.archived) { out.archived += r.c; continue; }
      if (r.status in out) out[r.status] += r.c;
      out.total += r.c;
    }
  } catch { /* ignore */ }
  return out;
}

/** Paginated inbox rows for an owner, newest first. */
function listForOwner(ownerId, { status = '', archived = false, listingId = 0, page = 1, perPage = 20 } = {}) {
  const where = ['l.owner_user_id = ?'];
  const params = [ownerId];
  if (archived) where.push('l.archived = 1');
  else where.push('l.archived = 0');
  if (status && STATUSES.includes(status)) { where.push('l.status = ?'); params.push(status); }
  if (listingId) { where.push('l.listing_id = ?'); params.push(Number(listingId) || 0); }
  const p = Math.max(1, parseInt(page, 10) || 1);
  const pp = Math.max(1, Math.min(100, parseInt(perPage, 10) || 20));
  const total = db.prepare(`SELECT COUNT(*) c FROM leads l WHERE ${where.join(' AND ')}`).get(...params).c;
  const rows = db.prepare(
    `SELECT l.*, g.name AS listing_name, g.slug AS listing_slug
     FROM leads l JOIN listings g ON g.id = l.listing_id
     WHERE ${where.join(' AND ')}
     ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`
  ).all(...params, pp, (p - 1) * pp);
  return { rows, total, page: p, pages: Math.max(1, Math.ceil(total / pp)) };
}

/** One lead, only if it belongs to this owner. */
function getOwned(leadId, ownerId) {
  return db.prepare(
    `SELECT l.*, g.name AS listing_name, g.slug AS listing_slug
     FROM leads l JOIN listings g ON g.id = l.listing_id
     WHERE l.id = ? AND l.owner_user_id = ?`
  ).get(Number(leadId) || 0, ownerId) || null;
}

function setStatus(leadId, ownerId, status) {
  if (!STATUSES.includes(status)) return { ok: false, error: 'Unknown status.' };
  const lead = getOwned(leadId, ownerId);
  if (!lead) return { ok: false, error: 'Lead not found.' };
  db.prepare(`UPDATE leads SET status=?, updated_at=datetime('now') WHERE id=?`).run(status, lead.id);
  return { ok: true, lead: { ...lead, status } };
}

function setArchived(leadId, ownerId, archived) {
  const lead = getOwned(leadId, ownerId);
  if (!lead) return { ok: false, error: 'Lead not found.' };
  db.prepare(`UPDATE leads SET archived=?, updated_at=datetime('now') WHERE id=?`).run(archived ? 1 : 0, lead.id);
  return { ok: true };
}

function addNote(leadId, ownerId, note) {
  const lead = getOwned(leadId, ownerId);
  if (!lead) return { ok: false, error: 'Lead not found.' };
  const n = String(note || '').trim().slice(0, 2000);
  if (n.length < 2) return { ok: false, error: 'Write a note first.' };
  db.prepare('INSERT INTO lead_notes (lead_id, user_id, note) VALUES (?,?,?)').run(lead.id, ownerId, n);
  db.prepare(`UPDATE leads SET updated_at=datetime('now') WHERE id=?`).run(lead.id);
  return { ok: true };
}

function notesFor(leadId, ownerId) {
  const lead = getOwned(leadId, ownerId);
  if (!lead) return [];
  return db.prepare('SELECT * FROM lead_notes WHERE lead_id=? ORDER BY id ASC').all(lead.id);
}

/** How many unread (“new”) leads an owner has — for nav badges. */
function newCount(ownerId) {
  try {
    return db.prepare(
      `SELECT COUNT(*) c FROM leads WHERE owner_user_id=? AND status='new' AND archived=0`
    ).get(ownerId).c;
  } catch {
    return 0;
  }
}

module.exports = {
  STATUSES, STATUS_LABELS,
  validate, create, countsForOwner, listForOwner, getOwned,
  setStatus, setArchived, addNote, notesFor, newCount,
};
