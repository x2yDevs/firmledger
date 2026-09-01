/**
 * FirmLedger — notification archiving (trash with an expiry date).
 *
 * A notification is never silently destroyed: archiving moves it to a trash
 * bin that hard-deletes itself after 1 week or 1 month, and it can be restored
 * at any point before that. "Delete now" is the only immediate destruction.
 *
 * Scope rules — every function takes the owner so one member can never touch
 * another member's row:
 *   userId = <number>  → that member's notifications (audience='user')
 *   userId = null      → the admin console inbox (audience='admin')
 *
 * Columns used (see migrations/2026-09-01-notifications-archive.sql):
 *   archived_at, deleted_at, archive_expires_at
 */
const { db } = require('../db');

/** Supported archive durations → days until the hard delete. */
const DURATIONS = {
  '1week': 7,
  week: 7,
  '7d': 7,
  '1month': 30,
  month: 30,
  '30d': 30,
};

function durationDays(duration) {
  if (typeof duration === 'number' && Number.isFinite(duration)) {
    const d = Math.round(duration);
    return d >= 1 && d <= 365 ? d : null;
  }
  const key = String(duration || '').trim().toLowerCase().replace(/\s+/g, '');
  return DURATIONS[key] || null;
}

/** WHERE fragment + params scoping a row to its owner. */
function scope(userId) {
  return userId === null || userId === undefined
    ? { sql: "audience='admin' AND user_id IS NULL", params: [] }
    : { sql: "audience='user' AND user_id=?", params: [Number(userId)] };
}

/**
 * Move a notification to trash.
 * @param {number} notificationId
 * @param {number|null} userId  owning member, or null for the admin inbox
 * @param {string|number} duration  '1week' | '1month' (or a day count)
 * @returns {{ok: boolean, days?: number, expiresAt?: string, error?: string}}
 */
function archive(notificationId, userId, duration) {
  const days = durationDays(duration);
  if (!days) return { ok: false, error: 'Choose 1 week or 1 month.' };
  const s = scope(userId);
  const info = db.prepare(
    `UPDATE notifications
        SET archived_at = datetime('now'),
            deleted_at = datetime('now'),
            archive_expires_at = datetime('now', '+' || ? || ' days')
      WHERE id = ? AND ${s.sql} AND deleted_at IS NULL`
  ).run(days, Number(notificationId), ...s.params);
  if (!info.changes) return { ok: false, error: 'Notification not found (or already in trash).' };
  const row = db.prepare('SELECT archive_expires_at FROM notifications WHERE id=?').get(Number(notificationId));
  return { ok: true, days, expiresAt: row ? row.archive_expires_at : '' };
}

/** Put an archived notification back in the inbox (only before it expires). */
function restore(notificationId, userId) {
  const s = scope(userId);
  const info = db.prepare(
    `UPDATE notifications
        SET archived_at = NULL, deleted_at = NULL, archive_expires_at = NULL
      WHERE id = ? AND ${s.sql} AND deleted_at IS NOT NULL`
  ).run(Number(notificationId), ...s.params);
  return { ok: Boolean(info.changes), error: info.changes ? '' : 'Notification not found in trash.' };
}

/** Destroy a notification immediately (works from the inbox or from trash). */
function permanentDelete(notificationId, userId) {
  const s = scope(userId);
  const info = db.prepare(`DELETE FROM notifications WHERE id = ? AND ${s.sql}`)
    .run(Number(notificationId), ...s.params);
  return { ok: Boolean(info.changes), error: info.changes ? '' : 'Notification not found.' };
}

/** Archived notifications belonging to one member (or the admin inbox). */
function getTrash(userId, limit = 100) {
  const s = scope(userId);
  return db.prepare(
    `SELECT * FROM notifications
      WHERE ${s.sql} AND deleted_at IS NOT NULL
      ORDER BY deleted_at DESC LIMIT ?`
  ).all(...s.params, Number(limit) || 100);
}

/** Moderation view: every archived notification, from every account. */
function getGlobalTrash(limit = 300) {
  return db.prepare(
    `SELECT n.*, u.email AS owner_email, u.name AS owner_name
       FROM notifications n
       LEFT JOIN users u ON u.id = n.user_id
      WHERE n.deleted_at IS NOT NULL
      ORDER BY n.deleted_at DESC LIMIT ?`
  ).all(Number(limit) || 300);
}

/** Admin override — delete any archived notification regardless of owner. */
function adminDeleteAny(notificationId) {
  const info = db.prepare('DELETE FROM notifications WHERE id = ? AND deleted_at IS NOT NULL')
    .run(Number(notificationId));
  return { ok: Boolean(info.changes), error: info.changes ? '' : 'Notification not found in trash.' };
}

/** Hard-delete everything whose archive window has run out. Returns the count. */
function purgeExpired() {
  const info = db.prepare(
    "DELETE FROM notifications WHERE archive_expires_at IS NOT NULL AND archive_expires_at < datetime('now')"
  ).run();
  return info.changes;
}

/** Days left before a trashed row is purged (0 = today). */
function daysLeft(n) {
  if (!n || !n.archive_expires_at) return null;
  const ms = new Date(String(n.archive_expires_at).replace(' ', 'T') + 'Z').getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 864e5));
}

module.exports = {
  DURATIONS, durationDays,
  archive, restore, permanentDelete,
  getTrash, getGlobalTrash, adminDeleteAny,
  purgeExpired, daysLeft,
};
