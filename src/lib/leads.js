/**
 * FirmLedger leads — direct conversion on every claimed business listing.
 *
 * Only signed-in FirmLedger members can contact a claimed (verified-owner)
 * profile. Their FirmLedger account email is used automatically — never typed
 * freehand — so the business can reply to a real account. The lead lands with
 * the verified owner in Dashboard → Leads and by email; the owner's email is
 * never exposed to the inquirer.
 *
 * Both sides can talk in-thread: the owner in the received inbox, the inquirer
 * under “Sent” (listings they contacted). Private owner notes stay owner-only.
 *
 * Reading and managing the business-side inbox is a FirmLedger Pro feature:
 * leads are collected for every claimed listing, but the full inbox unlocks
 * with Pro. Inquirers always see their own sent threads.
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
  if (!isEmail(e)) errors.push('A valid FirmLedger account email is required so the business can reply.');
  if (m.length < 10) errors.push('Write a message of at least 10 characters so the business knows what you need.');
  return { errors, fields: { name: n, email: e, phone: p, looking_for: lf, message: m } };
}

/** Create a lead for a claimed listing. Requires a signed-in FirmLedger user. */
function create({ listing, fields, city = '', country = '', inquirerUserId = null }) {
  if (!listing || !listing.owner_user_id) return { ok: false, error: 'This business cannot receive inquiries yet.' };
  if (!listing.claimed) return { ok: false, error: 'Only verified businesses can receive inquiries.' };
  if (!inquirerUserId) return { ok: false, error: 'Sign in with your FirmLedger account to contact this business.' };
  if (Number(inquirerUserId) === Number(listing.owner_user_id)) {
    return { ok: false, error: 'This is your own listing — inquiries from visitors land in your Leads inbox.' };
  }
  const v = validate(fields);
  if (v.errors.length) return { ok: false, error: v.errors[0], errors: v.errors };
  const f = v.fields;
  const r = db.prepare(
    `INSERT INTO leads (listing_id, owner_user_id, inquirer_user_id, name, email, phone, looking_for, message, city, country)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    listing.id, listing.owner_user_id, Number(inquirerUserId) || null,
    f.name, f.email, f.phone, f.looking_for, f.message,
    String(city || '').slice(0, 80), String(country || '').slice(0, 80)
  );
  const id = Number(r.lastInsertRowid);
  /* Seed the thread with the opening message so both sides share one timeline. */
  try {
    db.prepare(
      `INSERT INTO lead_messages (lead_id, sender, body) VALUES (?,?,?)`
    ).run(id, 'inquirer', f.message);
  } catch { /* table may be mid-migrate */ }
  return { ok: true, id, fields: f };
}

/** Status counts for an owner's received inbox (excludes archived). */
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

/** How many threads this member opened as the inquirer. */
function countsForInquirer(userId) {
  try {
    const total = db.prepare(
      `SELECT COUNT(*) c FROM leads WHERE inquirer_user_id=? AND archived=0`
    ).get(userId).c;
    return { total: total || 0 };
  } catch {
    return { total: 0 };
  }
}

/** Paginated received inbox rows for an owner, newest first. */
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
     ORDER BY l.updated_at DESC, l.id DESC LIMIT ? OFFSET ?`
  ).all(...params, pp, (p - 1) * pp);
  return { rows, total, page: p, pages: Math.max(1, Math.ceil(total / pp)) };
}

/** Paginated sent threads for an inquirer (listings they contacted). */
function listForInquirer(userId, { page = 1, perPage = 20 } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const pp = Math.max(1, Math.min(100, parseInt(perPage, 10) || 20));
  const total = db.prepare(
    `SELECT COUNT(*) c FROM leads WHERE inquirer_user_id=?`
  ).get(userId).c;
  const rows = db.prepare(
    `SELECT l.*, g.name AS listing_name, g.slug AS listing_slug, g.logo_url AS listing_logo
     FROM leads l JOIN listings g ON g.id = l.listing_id
     WHERE l.inquirer_user_id = ?
     ORDER BY l.updated_at DESC, l.id DESC LIMIT ? OFFSET ?`
  ).all(userId, pp, (p - 1) * pp);
  return { rows, total, page: p, pages: Math.max(1, Math.ceil(total / pp)) };
}

/** One lead if this user is the owner or the inquirer. */
function getAccessible(leadId, userId) {
  const lead = db.prepare(
    `SELECT l.*, g.name AS listing_name, g.slug AS listing_slug, g.logo_url AS listing_logo
     FROM leads l JOIN listings g ON g.id = l.listing_id
     WHERE l.id = ?`
  ).get(Number(leadId) || 0);
  if (!lead) return null;
  const uid = Number(userId) || 0;
  if (lead.owner_user_id === uid) return { ...lead, role: 'owner' };
  if (lead.inquirer_user_id && lead.inquirer_user_id === uid) return { ...lead, role: 'inquirer' };
  return null;
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

/**
 * Permanently delete a conversation (owner-side). Removes the lead together
 * with its messages and notes for BOTH parties — there is no trash for leads,
 * so this cannot be undone. Only the owning business may do this.
 */
function permanentDelete(leadId, ownerId) {
  const lead = getOwned(leadId, ownerId);
  if (!lead) return { ok: false, error: 'Conversation not found.' };
  db.prepare('DELETE FROM leads WHERE id=? AND owner_user_id=?').run(lead.id, ownerId);
  return { ok: true };
}

/**
 * Inquirer-side permanent delete: removes the conversation from THIS member's
 * Sent box by dropping the inquirer link. The business keeps its own record of
 * the inquiry (name + message) — only the shared account link is removed, so
 * no further replies or notifications reach the inquirer.
 */
function detachInquirer(leadId, userId) {
  const info = db.prepare(
    `UPDATE leads SET inquirer_user_id = NULL, updated_at = datetime('now')
      WHERE id = ? AND inquirer_user_id = ?`
  ).run(Number(leadId) || 0, Number(userId) || 0);
  return Boolean(info.changes)
    ? { ok: true }
    : { ok: false, error: 'Conversation not found.' };
}

/** Mark that the given party has received their one email for this lead. */
function markEmailed(leadId, role) {
  const col = role === 'owner' ? 'owner_emailed' : role === 'inquirer' ? 'inquirer_emailed' : null;
  if (!col) return false;
  db.prepare(`UPDATE leads SET ${col} = 1 WHERE id = ?`).run(Number(leadId) || 0);
  return true;
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

/**
 * Add a chat message on a lead thread. `sender` is 'owner' or 'inquirer'.
 * Only the matching party may post.
 */
function addMessage(leadId, userId, body) {
  const lead = getAccessible(leadId, userId);
  if (!lead) return { ok: false, error: 'Conversation not found.' };
  const text = String(body || '').trim().slice(0, 4000);
  if (text.length < 1) return { ok: false, error: 'Write a message first.' };
  const sender = lead.role; // 'owner' | 'inquirer'
  db.prepare(
    `INSERT INTO lead_messages (lead_id, sender, body) VALUES (?,?,?)`
  ).run(lead.id, sender, text);
  /* Bump the lead and flip status when the business replies for the first time. */
  if (sender === 'owner' && lead.status === 'new') {
    db.prepare(`UPDATE leads SET status='contacted', updated_at=datetime('now') WHERE id=?`).run(lead.id);
  } else {
    db.prepare(`UPDATE leads SET updated_at=datetime('now') WHERE id=?`).run(lead.id);
  }
  return { ok: true, lead, sender, body: text };
}

/** Full message timeline for a lead the user can access. */
function messagesFor(leadId, userId) {
  const lead = getAccessible(leadId, userId);
  if (!lead) return [];
  try {
    const rows = db.prepare(
      `SELECT * FROM lead_messages WHERE lead_id=? ORDER BY id ASC`
    ).all(lead.id);
    if (rows.length) return rows;
  } catch { /* ignore */ }
  /* Legacy leads without a messages row — surface the opening message once. */
  if (lead.message) {
    return [{
      id: 0, lead_id: lead.id, sender: 'inquirer', body: lead.message,
      created_at: lead.created_at,
    }];
  }
  return [];
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
  validate, create, countsForOwner, countsForInquirer,
  listForOwner, listForInquirer, getOwned, getAccessible,
  setStatus, setArchived, addNote, notesFor,
  addMessage, messagesFor, newCount,
  permanentDelete, detachInquirer, markEmailed,
};
