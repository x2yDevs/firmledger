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
 * Delivery guarantees this module enforces, so the flow is real end to end:
 *   • a business can only receive inquiries when a live (non-suspended) owner
 *     account can actually read them;
 *   • nothing a member types is silently truncated — over-long input is
 *     refused with the real numbers so it can be shortened and re-sent;
 *   • an accidental double-submit re-opens the existing thread instead of
 *     forking a second conversation;
 *   • a reply to an archived thread pulls it back into the owner's inbox;
 *   • per-thread flood limits stop one party burying the other;
 *   • unread counters per side drive honest badges in both inboxes.
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

/* Field ceilings. These are the SAME numbers the contact form advertises with
   its maxlength attributes — the server must never accept a value the form
   allowed and then quietly cut it in half. */
const NAME_MAX = 120;
const PHONE_MAX = 40;
const SUBJECT_MAX = 140;
const MESSAGE_MIN = 10;
const MESSAGE_MAX = 4000;

/* A repeat of the exact same inquiry inside this window is treated as the same
   conversation (double-clicked button, refreshed POST, flaky connection). */
const DUPLICATE_WINDOW_MIN = 10;
/* Per-thread reply guards: the identical message twice in a row is dropped,
   and no single party may post more than BURST_MAX messages per window. */
const REPLY_DUP_WINDOW_SEC = 60;
const REPLY_BURST_MAX = 12;
const REPLY_BURST_WINDOW_MIN = 5;

function clean(s, max) {
  return String(s || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

/**
 * Validate one inquiry. Over-long input is REFUSED (with the real count) rather
 * than trimmed behind the member's back: a 3,000-character brief that silently
 * becomes 2,000 characters loses the part the business needed to quote on.
 */
function validate({ name, email, phone, looking_for, message }) {
  const errors = [];
  const n = clean(name, NAME_MAX);
  const e = String(email || '').trim().toLowerCase().slice(0, 254);
  const p = clean(phone, PHONE_MAX);
  const lf = clean(looking_for, SUBJECT_MAX);
  const m = String(message || '').trim();
  if (n.length < 2) {
    errors.push('Tell the business your name — add it to the name field (or set it on your FirmLedger profile).');
  }
  if (!isEmail(e)) errors.push('A valid FirmLedger account email is required so the business can reply.');
  if (m.length < MESSAGE_MIN) {
    errors.push(`Write a message of at least ${MESSAGE_MIN} characters so the business knows what you need.`);
  } else if (m.length > MESSAGE_MAX) {
    errors.push(`Your message is ${m.length.toLocaleString('en-GB')} characters — shorten it to ${MESSAGE_MAX.toLocaleString('en-GB')} or fewer and send it again.`);
  }
  return { errors, fields: { name: n, email: e, phone: p, looking_for: lf, message: m } };
}

/** The owner account behind a listing, or null. */
function ownerAccount(listing) {
  if (!listing || !listing.owner_user_id) return null;
  try {
    return db.prepare('SELECT id, email, name, suspended FROM users WHERE id = ?').get(listing.owner_user_id) || null;
  } catch {
    return null;
  }
}

/**
 * Can this listing receive an inquiry right now? A "Contact this business"
 * button must only exist where a real person can read what is sent, so the
 * page and the POST handler both ask this one question.
 */
function canReceive(listing) {
  if (!listing) return { ok: false, error: 'This business cannot receive inquiries yet.' };
  if (listing.status && listing.status !== 'approved') {
    return { ok: false, error: 'This business cannot receive inquiries yet.' };
  }
  if (!listing.claimed) {
    return { ok: false, error: 'This business cannot receive inquiries yet — nobody has claimed and verified this listing.' };
  }
  const owner = ownerAccount(listing);
  if (!owner) return { ok: false, error: 'This business cannot receive inquiries yet.' };
  if (owner.suspended) {
    return { ok: false, error: 'This business is not accepting inquiries at the moment.' };
  }
  return { ok: true, owner };
}

/** An identical inquiry from the same member, moments ago — the same thread. */
function recentDuplicate(listingId, inquirerUserId, message) {
  if (!inquirerUserId) return null;
  try {
    return db.prepare(
      `SELECT * FROM leads
        WHERE listing_id = ? AND inquirer_user_id = ? AND message = ?
          AND created_at >= datetime('now', ?)
        ORDER BY id DESC LIMIT 1`
    ).get(listingId, Number(inquirerUserId), message, `-${DUPLICATE_WINDOW_MIN} minutes`) || null;
  } catch {
    return null;
  }
}

/** Create a lead for a claimed listing. Requires a signed-in FirmLedger user. */
function create({ listing, fields, city = '', country = '', inquirerUserId = null }) {
  const gate = canReceive(listing);
  if (!gate.ok) return { ok: false, error: gate.error };
  if (!inquirerUserId) return { ok: false, error: 'Sign in with your FirmLedger account to contact this business.' };
  if (Number(inquirerUserId) === Number(listing.owner_user_id)) {
    return { ok: false, error: 'This is your own listing — inquiries from visitors land in your Leads inbox.' };
  }
  const v = validate(fields);
  if (v.errors.length) return { ok: false, error: v.errors[0], errors: v.errors };
  const f = v.fields;

  /* Double-submit protection: the same message to the same business minutes
     ago is the same conversation, not a second one. */
  const dup = recentDuplicate(listing.id, inquirerUserId, f.message);
  if (dup) return { ok: true, id: dup.id, fields: f, duplicate: true };

  const r = db.prepare(
    `INSERT INTO leads (listing_id, owner_user_id, inquirer_user_id, name, email, phone, looking_for, message, city, country, owner_unread)
     VALUES (?,?,?,?,?,?,?,?,?,?,1)`
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
  const out = { new: 0, contacted: 0, qualified: 0, won: 0, lost: 0, total: 0, archived: 0, unread: 0 };
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
  out.unread = unreadForOwner(ownerId);
  return out;
}

/**
 * How many threads this member opened as the inquirer. Counts every thread in
 * their Sent box — including ones the business archived on its own side, which
 * stay readable (and replyable) for the inquirer — so the tab count always
 * matches the list below it.
 */
function countsForInquirer(userId) {
  try {
    const total = db.prepare(
      `SELECT COUNT(*) c FROM leads WHERE inquirer_user_id=?`
    ).get(userId).c;
    return { total: total || 0, unread: unreadForInquirer(userId) };
  } catch {
    return { total: 0, unread: 0 };
  }
}

/* Latest message on the thread — what an inbox row should actually preview. */
const LAST_MESSAGE_SQL = `
  (SELECT m.body FROM lead_messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_body,
  (SELECT m.sender FROM lead_messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_sender`;

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
    `SELECT l.*, g.name AS listing_name, g.slug AS listing_slug,${LAST_MESSAGE_SQL}
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
    `SELECT l.*, g.name AS listing_name, g.slug AS listing_slug, g.logo_url AS listing_logo,${LAST_MESSAGE_SQL}
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
    `UPDATE leads SET inquirer_user_id = NULL, inquirer_unread = 0, updated_at = datetime('now')
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
 *
 * Returns `{ ok:true, delivered:false }` when the message is stored but the
 * other side can no longer receive it (the inquirer deleted their copy) — the
 * caller tells the truth instead of showing a plain “Message sent.”
 */
function addMessage(leadId, userId, body) {
  const lead = getAccessible(leadId, userId);
  if (!lead) return { ok: false, error: 'Conversation not found.' };
  const text = String(body || '').trim();
  if (text.length < 1) return { ok: false, error: 'Write a message first.' };
  if (text.length > MESSAGE_MAX) {
    return {
      ok: false,
      error: `Your message is ${text.length.toLocaleString('en-GB')} characters — shorten it to ${MESSAGE_MAX.toLocaleString('en-GB')} or fewer and send it again.`,
    };
  }
  const sender = lead.role; // 'owner' | 'inquirer'

  /* Flood guards, per thread and per party. */
  try {
    const last = db.prepare(
      `SELECT body, created_at FROM lead_messages
        WHERE lead_id=? AND sender=? ORDER BY id DESC LIMIT 1`
    ).get(lead.id, sender);
    if (last && last.body === text) {
      const same = db.prepare(
        `SELECT 1 FROM lead_messages WHERE lead_id=? AND sender=? AND body=?
           AND created_at >= datetime('now', ?) LIMIT 1`
      ).get(lead.id, sender, text, `-${REPLY_DUP_WINDOW_SEC} seconds`);
      if (same) return { ok: false, error: 'You just sent that message — give them a moment to reply.' };
    }
    const burst = db.prepare(
      `SELECT COUNT(*) c FROM lead_messages
        WHERE lead_id=? AND sender=? AND created_at >= datetime('now', ?)`
    ).get(lead.id, sender, `-${REPLY_BURST_WINDOW_MIN} minutes`).c;
    if (burst >= REPLY_BURST_MAX) {
      return {
        ok: false,
        error: `You have sent ${REPLY_BURST_MAX} messages on this conversation in the last few minutes — wait for a reply before sending more.`,
      };
    }
  } catch { /* guards must never block a legitimate reply */ }

  db.prepare(
    `INSERT INTO lead_messages (lead_id, sender, body) VALUES (?,?,?)`
  ).run(lead.id, sender, text);

  /* Bump the lead, raise the other side's unread counter, flip status when the
     business replies for the first time, and pull an archived thread back into
     the inbox when the member follows up — an archived conversation must never
     swallow a live customer. */
  /* Answering a thread is proof of having read it, so the sender's own counter
     is cleared in the same statement that raises the other side's. Otherwise a
     business that replies straight from the email alert keeps a badge for a
     message it has demonstrably just answered. */
  if (sender === 'owner') {
    /* Only raise the member's badge when there is still a member attached —
       a detached thread must never accumulate unread counts nobody can clear. */
    db.prepare(
      `UPDATE leads SET inquirer_unread = CASE WHEN inquirer_user_id IS NULL THEN 0 ELSE inquirer_unread + 1 END,
              owner_unread = 0,
              status = CASE WHEN status='new' THEN 'contacted' ELSE status END,
              updated_at = datetime('now')
        WHERE id=?`
    ).run(lead.id);
  } else {
    db.prepare(
      `UPDATE leads SET owner_unread = owner_unread + 1, inquirer_unread = 0,
              archived = 0, updated_at = datetime('now')
        WHERE id=?`
    ).run(lead.id);
  }

  /* Delivered only if somebody is still on the other end. */
  const delivered = sender === 'owner' ? Boolean(lead.inquirer_user_id) : true;
  return { ok: true, lead, sender, body: text, delivered, reopened: sender === 'inquirer' && Boolean(lead.archived) };
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

/**
 * Clear this member's unread counter on a thread they just opened. Returns the
 * number of messages that were unread, so a caller can still render the “new”
 * divider for the messages that arrived since their last visit.
 */
function markRead(leadId, userId) {
  const lead = getAccessible(leadId, userId);
  if (!lead) return 0;
  const col = lead.role === 'owner' ? 'owner_unread' : 'inquirer_unread';
  const was = Number(lead[col]) || 0;
  if (was) db.prepare(`UPDATE leads SET ${col} = 0 WHERE id = ?`).run(lead.id);
  return was;
}

/** Unread messages waiting for a business across its live (unarchived) inbox. */
function unreadForOwner(ownerId) {
  try {
    return db.prepare(
      'SELECT COALESCE(SUM(owner_unread), 0) c FROM leads WHERE owner_user_id=? AND archived=0'
    ).get(ownerId).c || 0;
  } catch {
    return 0;
  }
}

/** Unread replies waiting for a member in their Sent box. */
function unreadForInquirer(userId) {
  try {
    return db.prepare(
      'SELECT COALESCE(SUM(inquirer_unread), 0) c FROM leads WHERE inquirer_user_id=?'
    ).get(userId).c || 0;
  } catch {
    return 0;
  }
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
  NAME_MAX, PHONE_MAX, SUBJECT_MAX, MESSAGE_MIN, MESSAGE_MAX,
  validate, create, canReceive, countsForOwner, countsForInquirer,
  listForOwner, listForInquirer, getOwned, getAccessible,
  setStatus, setArchived, addNote, notesFor,
  addMessage, messagesFor, newCount,
  markRead, unreadForOwner, unreadForInquirer,
  permanentDelete, detachInquirer, markEmailed,
};
