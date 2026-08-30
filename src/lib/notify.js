/**
 * In-app notifications for members and the admin console.
 *
 * Sensitive account events still go out by email (password, 2FA, deletion,
 * receipts). Everything else — listing review, claims, tickets, watchlist,
 * bulk moderation — lands here so SMTP quotas stay intact and the unread
 * green dot on the bell is always truthful.
 */
const { db } = require('../db');

function insert({ userId = null, audience, title, body = '', url = '', kind = 'info' }) {
  if (!title) return null;
  if (audience !== 'admin' && audience !== 'user') return null;
  if (audience === 'user' && !userId) return null;
  const info = db.prepare(
    `INSERT INTO notifications (user_id, audience, title, body, url, kind)
     VALUES (?,?,?,?,?,?)`
  ).run(audience === 'user' ? userId : null, audience, String(title).slice(0, 200),
    String(body || '').slice(0, 2000), String(url || '').slice(0, 400), String(kind || 'info').slice(0, 40));
  return info.lastInsertRowid;
}

function notifyUser(userId, opts) {
  return insert({ ...opts, userId, audience: 'user' });
}

function notifyAdmin(opts) {
  return insert({ ...opts, audience: 'admin' });
}

function unreadUser(userId) {
  if (!userId) return 0;
  return db.prepare(
    "SELECT COUNT(*) c FROM notifications WHERE audience='user' AND user_id=? AND (read_at IS NULL OR read_at='')"
  ).get(userId).c;
}

function unreadAdmin() {
  return db.prepare(
    "SELECT COUNT(*) c FROM notifications WHERE audience='admin' AND (read_at IS NULL OR read_at='')"
  ).get().c;
}

function listUser(userId, limit = 60) {
  return db.prepare(
    `SELECT * FROM notifications WHERE audience='user' AND user_id=?
     ORDER BY created_at DESC LIMIT ?`
  ).all(userId, limit);
}

function listAdmin(limit = 80) {
  return db.prepare(
    `SELECT * FROM notifications WHERE audience='admin'
     ORDER BY created_at DESC LIMIT ?`
  ).all(limit);
}

function markRead(id, { userId = null, admin = false } = {}) {
  if (admin) {
    db.prepare(
      "UPDATE notifications SET read_at=datetime('now') WHERE id=? AND audience='admin' AND (read_at IS NULL OR read_at='')"
    ).run(id);
    return;
  }
  if (!userId) return;
  db.prepare(
    "UPDATE notifications SET read_at=datetime('now') WHERE id=? AND audience='user' AND user_id=? AND (read_at IS NULL OR read_at='')"
  ).run(id, userId);
}

function markAllRead({ userId = null, admin = false, audience = '' } = {}) {
  if (admin || audience === 'admin') {
    db.prepare(
      "UPDATE notifications SET read_at=datetime('now') WHERE audience='admin' AND (read_at IS NULL OR read_at='')"
    ).run();
    return;
  }
  if (!userId) return;
  db.prepare(
    "UPDATE notifications SET read_at=datetime('now') WHERE audience='user' AND user_id=? AND (read_at IS NULL OR read_at='')"
  ).run(userId);
}

function isUnread(n) {
  return !n || !n.read_at;
}

module.exports = {
  notifyUser, notifyAdmin, unreadUser, unreadAdmin,
  listUser, listAdmin, markRead, markAllRead, isUnread,
};
