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
 *
 * Production guarantees this module owns:
 *   • one rule for “can this listing be contacted” (contactState) shared by the
 *     profile page and the POST route, so the form is never rendered for a
 *     listing that would refuse it;
 *   • honest length limits — a submission over the cap is rejected with a
 *     message, never silently truncated (LIMITS is the single source of truth
 *     for both the form attributes and the validator);
 *   • double-submit safety — an identical inquiry or reply posted twice in a
 *     short window is folded into the first one instead of duplicating;
 *   • nothing a member typed is lost — a rejected inquiry is stashed as a draft
 *     and re-fills the form once.
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

/** Field ceilings — the form's maxlength attributes and the validator agree. */
const LIMITS = {
  name: { max: 120 },
  phone: { max: 40 },
  looking_for: { max: 140 },
  message: { min: 10, max: 4000 },
  reply: { min: 1, max: 4000 },
  note: { min: 2, max: 2000 },
};

/** An identical inquiry posted again inside this window is a double submit. */
const DUPLICATE_WINDOW_MIN = 10;
/** An identical reply posted again inside this window is a double click. */
const REPLY_DUPLICATE_SEC = 60;
/** How long a rejected form is kept for re-filling. */
const DRAFT_TTL_MIN = 60;

function clean(s, max = 500) {
  return String(s || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

/* lead_messages is created in the same boot-time schema block as leads, but a
   database caught mid-upgrade can briefly miss it. Cache the positive answer
   (a table that exists never disappears) and re-check while it does not. */
let _hasMessages = false;
function messagesReady() {
  if (_hasMessages) return true;
  try {
    _hasMessages = Boolean(db.prepare(
      "SELECT 1 AS t FROM sqlite_master WHERE type='table' AND name='lead_messages'"
    ).get());
  } catch { _hasMessages = false; }
  return _hasMessages;
}

/* Correlated subquery giving the sender of the newest message on a thread —
   used to show which side the conversation is waiting for. Empty string when
   the messages table is not there yet. */
function lastSenderSql() {
  return messagesReady()
    ? `(SELECT m.sender FROM lead_messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_sender`
    : `'' AS last_sender`;
}

function validate({ name, email, phone, looking_for, message }) {
  const errors = [];
  const n = clean(name, LIMITS.name.max);
  const e = String(email || '').trim().toLowerCase().slice(0, 254);
  const p = clean(phone, LIMITS.phone.max);
  const lf = clean(looking_for, LIMITS.looking_for.max);
  const rawMsg = String(message || '').trim();
  const rawLf = String(looking_for || '').trim();
  const m = rawMsg.slice(0, LIMITS.message.max);
  if (n.length < 2) errors.push('Tell the business your name.');
  if (!isEmail(e)) errors.push('A valid FirmLedger account email is required so the business can reply.');
  if (rawMsg.length < LIMITS.message.min) {
    errors.push(`Write a message of at least ${LIMITS.message.min} characters so the business knows what you need.`);
  } else if (rawMsg.length > LIMITS.message.max) {
    errors.push(`Messages are limited to ${LIMITS.message.max.toLocaleString('en-US')} characters — please shorten yours.`);
  }
  if (rawLf.length > LIMITS.looking_for.max) {
    errors.push(`“What are you looking for?” is limited to ${LIMITS.looking_for.max} characters.`);
  }
  /* Phone is optional, but if it is given it has to be dialable: 6–15 digits
     (E.164 range) once spacing, brackets and dashes are ignored. */
  if (p) {
    const digits = p.replace(/\D/g, '');
    if (digits.length < 6 || digits.length > 15 || !/^[+()\d]/.test(p)) {
      errors.push('That phone number does not look right — include the country code, digits only.');
    }
  }
  return { errors, fields: { name: n, email: e, phone: p, looking_for: lf, message: m } };
}

/**
 * The ONE rule for whether a listing can receive inquiries. Used by the
 * profile page (do we render the contact panel at all?) and by the POST route
 * (do we accept the submission?), so a member is never shown a form that would
 * bounce. Every refusal contains “cannot receive inquiries” or names the real
 * reason, and none of them leak anything private.
 */
function contactState(listing) {
  if (!listing) return { ok: false, reason: 'That record was not found.' };
  if (listing.status !== 'approved') {
    return { ok: false, reason: 'This record is still in review — it cannot receive inquiries yet.' };
  }
  if (!listing.claimed) {
    return { ok: false, reason: 'This business is not verified yet, so it cannot receive inquiries.' };
  }
  if (!listing.owner_user_id) {
    return { ok: false, reason: 'This business cannot receive inquiries yet.' };
  }
  let owner = null;
  try {
    owner = db.prepare('SELECT id, suspended FROM users WHERE id=?').get(listing.owner_user_id);
  } catch { owner = null; }
  if (!owner) return { ok: false, reason: 'This business cannot receive inquiries yet.' };
  if (owner.suspended) return { ok: false, reason: 'This business cannot receive inquiries right now.' };
  return { ok: true, ownerId: owner.id };
}

/** A recently-posted identical inquiry from the same member (double submit). */
function recentDuplicate(listingId, inquirerUserId, message) {
  try {
    return db.prepare(
      `SELECT id, status FROM leads
        WHERE listing_id = ? AND inquirer_user_id = ? AND message = ?
          AND created_at >= datetime('now', ?)
        ORDER BY id DESC LIMIT 1`
    ).get(Number(listingId) || 0, Number(inquirerUserId) || 0, String(message || ''), `-${DUPLICATE_WINDOW_MIN} minutes`) || null;
  } catch { return null; }
}

/** Create a lead for a claimed listing. Requires a signed-in FirmLedger user. */
function create({ listing, fields, city = '', country = '', inquirerUserId = null }) {
  if (!listing || !listing.owner_user_id) return { ok: false, error: 'This business cannot receive inquiries yet.' };
  if (!listing.claimed) return { ok: false, error: 'Only verified businesses can receive inquiries.' };
  if (!inquirerUserId) return { ok: false, error: 'Sign in with your FirmLedger account to contact this business.' };
  if (Number(inquirerUserId) === Number(listing.owner_user_id)) {
    return { ok: false, error: 'This is your own listing — inquiries from visitors land in your Leads inbox.' };
  }
  const state = contactState(listing);
  if (!state.ok) return { ok: false, error: state.reason };
  const v = validate(fields);
  if (v.errors.length) return { ok: false, error: v.errors[0], errors: v.errors, fields: v.fields };
  const f = v.fields;

  /* Double submit (refresh, double click, resubmission after a stall) folds
     into the conversation already open — the member is sent to it, and the
     business never sees the same inquiry twice. */
  const dup = recentDuplicate(listing.id, inquirerUserId, f.message);
  if (dup) return { ok: true, id: Number(dup.id), fields: f, duplicate: true };

  const write = db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO leads (listing_id, owner_user_id, inquirer_user_id, name, email, phone, looking_for, message, city, country)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      listing.id, listing.owner_user_id, Number(inquirerUserId) || null,
      f.name, f.email, f.phone, f.looking_for, f.message,
      String(city || '').slice(0, 80), String(country || '').slice(0, 80)
    );
    const id = Number(r.lastInsertRowid);
    /* Seed the thread with the opening message so both sides share one timeline.
       Same transaction: a lead without its opening message would show an empty
       thread to the business. */
    db.prepare(`INSERT INTO lead_messages (lead_id, sender, body) VALUES (?,?,?)`).run(id, 'inquirer', f.message);
    return id;
  });

  let id = 0;
  try {
    id = write();
  } catch (e) {
    console.error('[leads] could not store the inquiry:', listing && listing.id, e && e.message);
    return { ok: false, error: 'That inquiry could not be sent. Please try again in a moment.' };
  }
  clearDraft(inquirerUserId, listing.id);
  return { ok: true, id, fields: f };
}

/* ---------------- Unfinished inquiry drafts (never lose typed text) -------- */

/** Stash a rejected submission so the form can be re-filled once. */
function saveDraft(userId, listingId, fields) {
  const uid = Number(userId) || 0;
  const lid = Number(listingId) || 0;
  if (!uid || !lid) return false;
  /* validate() normalises and caps every field; its errors are irrelevant here
     (the caller already has them) — only the cleaned values are stored. The
     account email is never stashed: it is read from the account on submit. */
  const f = validate(fields || {}).fields;
  try {
    /* Keep the table tiny: drop anything older than the TTL on every write. */
    db.prepare(`DELETE FROM lead_drafts WHERE created_at < datetime('now', ?)`).run(`-${DRAFT_TTL_MIN * 4} minutes`);
    db.prepare(
      `INSERT INTO lead_drafts (user_id, listing_id, name, phone, looking_for, message, created_at)
       VALUES (?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(user_id, listing_id) DO UPDATE SET
         name=excluded.name, phone=excluded.phone, looking_for=excluded.looking_for,
         message=excluded.message, created_at=excluded.created_at`
    ).run(uid, lid, f.name, f.phone, f.looking_for, f.message);
    return true;
  } catch (e) {
    console.error('[leads] draft not saved:', e && e.message);
    return false;
  }
}

/** Read AND remove the stashed form for this member + listing (one-shot). */
function takeDraft(userId, listingId) {
  const uid = Number(userId) || 0;
  const lid = Number(listingId) || 0;
  if (!uid || !lid) return null;
  try {
    const row = db.prepare(
      `SELECT * FROM lead_drafts WHERE user_id=? AND listing_id=? AND created_at >= datetime('now', ?)`
    ).get(uid, lid, `-${DRAFT_TTL_MIN} minutes`);
    db.prepare('DELETE FROM lead_drafts WHERE user_id=? AND listing_id=?').run(uid, lid);
    if (!row) return null;
    return {
      name: row.name || '', phone: row.phone || '',
      looking_for: row.looking_for || '', message: row.message || '',
    };
  } catch { return null; }
}

function clearDraft(userId, listingId) {
  try {
    db.prepare('DELETE FROM lead_drafts WHERE user_id=? AND listing_id=?')
      .run(Number(userId) || 0, Number(listingId) || 0);
  } catch { /* nothing stashed */ }
}

/** Conversations this member already has with one business (profile page). */
function threadsFor(userId, listingId, limit = 4) {
  const uid = Number(userId) || 0;
  const lid = Number(listingId) || 0;
  if (!uid || !lid) return [];
  try {
    return db.prepare(
      `SELECT l.id, l.looking_for, l.message, l.status, l.created_at, l.updated_at, ${lastSenderSql()}
         FROM leads l
        WHERE l.inquirer_user_id = ? AND l.listing_id = ?
        ORDER BY l.updated_at DESC, l.id DESC LIMIT ?`
    ).all(uid, lid, Math.max(1, Math.min(10, Number(limit) || 4)));
  } catch { return []; }
}

/**
 * Move every conversation on a listing to a new owner — used when ownership of
 * the record itself changes (a verified claim that displaces a previous owner,
 * or an admin transfer in the console).
 *
 * An inquiry belongs to whoever owns the business NOW: without this the
 * previous owner could keep reading (and answering) a member's inquiry for a
 * business that is no longer theirs, and the new owner would inherit a live
 * conversation with no history. Messages and private notes travel with the
 * lead, because they are the business's record of that conversation.
 *
 * Pass a falsy owner (the listing became unclaimed) and nothing moves: leads
 * require an owner, and the honest record is that the account which received
 * them did so while it owned the business.
 *
 * Returns how many conversations moved.
 */
function transferListing(listingId, newOwnerId) {
  const lid = Number(listingId) || 0;
  const uid = Number(newOwnerId) || 0;
  if (!lid || !uid) return 0;
  try {
    const info = db.prepare(
      `UPDATE leads SET owner_user_id = ? WHERE listing_id = ? AND owner_user_id <> ?`
    ).run(uid, lid, uid);
    return Number(info.changes) || 0;
  } catch (e) {
    console.error('[leads] ownership transfer failed:', lid, uid, e && e.message);
    return 0;
  }
}

/** Status counts for an owner's received inbox (excludes archived). */
function countsForOwner(ownerId) {
  const out = { new: 0, contacted: 0, qualified: 0, won: 0, lost: 0, total: 0, archived: 0, waiting: 0 };
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
  /* Threads where the member spoke last and the business has not answered —
     the honest “needs your reply” number for the inbox header. */
  if (messagesReady()) {
    try {
      out.waiting = db.prepare(
        `SELECT COUNT(*) AS c FROM leads l
          WHERE l.owner_user_id=? AND l.archived=0 AND l.status NOT IN ('won','lost')
            AND (SELECT m.sender FROM lead_messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) = 'inquirer'`
      ).get(ownerId).c || 0;
    } catch { out.waiting = 0; }
  }
  return out;
}

/**
 * How many threads this member opened as the inquirer. Counts every thread in
 * their Sent box — including ones the business archived on its own side, which
 * stay readable (and replyable) for the inquirer — so the tab count always
 * matches the list below it. Counted through the same JOIN the list uses, so a
 * row can never be counted and then not shown.
 *
 * `waiting` is how many of those threads the business has answered and the
 * member has not read/replied to yet (last message is the business's).
 */
function countsForInquirer(userId) {
  const out = { total: 0, waiting: 0 };
  try {
    out.total = db.prepare(
      `SELECT COUNT(*) c FROM leads l JOIN listings g ON g.id = l.listing_id WHERE l.inquirer_user_id=?`
    ).get(userId).c || 0;
  } catch {
    return { total: 0, waiting: 0 };
  }
  if (messagesReady()) {
    try {
      out.waiting = db.prepare(
        `SELECT COUNT(*) c FROM leads l JOIN listings g ON g.id = l.listing_id
          WHERE l.inquirer_user_id=?
            AND (SELECT m.sender FROM lead_messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) = 'owner'`
      ).get(userId).c || 0;
    } catch { out.waiting = 0; }
  }
  return out;
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
    `SELECT l.*, g.name AS listing_name, g.slug AS listing_slug, ${lastSenderSql()}
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
    `SELECT COUNT(*) c FROM leads l JOIN listings g ON g.id = l.listing_id WHERE l.inquirer_user_id=?`
  ).get(userId).c;
  const rows = db.prepare(
    `SELECT l.*, g.name AS listing_name, g.slug AS listing_slug, g.logo_url AS listing_logo, ${lastSenderSql()}
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
  const n = String(note || '').trim();
  if (n.length < LIMITS.note.min) return { ok: false, error: 'Write a note first.' };
  if (n.length > LIMITS.note.max) {
    return { ok: false, error: `Notes are limited to ${LIMITS.note.max.toLocaleString('en-US')} characters.` };
  }
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
 * Only the matching party may post. Over-long messages are refused (never
 * silently cut), and the same text posted twice within a minute is treated as
 * one message — a double click must not send the business two identical lines.
 */
function addMessage(leadId, userId, body) {
  const lead = getAccessible(leadId, userId);
  if (!lead) return { ok: false, error: 'Conversation not found.' };
  const text = String(body || '').trim();
  if (text.length < LIMITS.reply.min) return { ok: false, error: 'Write a message first.' };
  if (text.length > LIMITS.reply.max) {
    return { ok: false, error: `Messages are limited to ${LIMITS.reply.max.toLocaleString('en-US')} characters — please shorten yours.` };
  }
  const sender = lead.role; // 'owner' | 'inquirer'

  if (messagesReady()) {
    try {
      const last = db.prepare(
        `SELECT sender, body, created_at FROM lead_messages WHERE lead_id=? ORDER BY id DESC LIMIT 1`
      ).get(lead.id);
      if (last && last.sender === sender && last.body === text) {
        const at = Date.parse(String(last.created_at || '').replace(' ', 'T') + 'Z');
        if (Number.isFinite(at) && Date.now() - at <= REPLY_DUPLICATE_SEC * 1000) {
          return { ok: true, lead, sender, body: text, duplicate: true };
        }
      }
    } catch { /* fall through and store the message */ }
  }

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
  if (messagesReady()) {
    try {
      const rows = db.prepare(
        `SELECT * FROM lead_messages WHERE lead_id=? ORDER BY id ASC`
      ).all(lead.id);
      if (rows.length) return rows;
    } catch (e) {
      console.error('[leads] could not read the thread:', lead.id, e && e.message);
    }
  }
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
  STATUSES, STATUS_LABELS, LIMITS,
  DUPLICATE_WINDOW_MIN, REPLY_DUPLICATE_SEC, DRAFT_TTL_MIN,
  validate, create, contactState, countsForOwner, countsForInquirer,
  listForOwner, listForInquirer, getOwned, getAccessible,
  setStatus, setArchived, addNote, notesFor,
  addMessage, messagesFor, newCount,
  threadsFor, saveDraft, takeDraft, clearDraft, transferListing,
  permanentDelete, detachInquirer, markEmailed,
};
