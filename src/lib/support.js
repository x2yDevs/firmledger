/**
 * Support tickets + live chat between a member and the admin team.
 * Attachments are validated (mime allowlist, 8 MB cap) under data/uploads/support/.
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../db');

const CATEGORIES = new Set(['billing', 'technical', 'listing', 'account', 'verification', 'other']);

const dir = path.join(__dirname, '..', '..', 'data', 'uploads', 'support');
fs.mkdirSync(dir, { recursive: true });

const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf', 'text/plain', 'text/csv',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/zip',
]);
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.txt', '.csv', '.doc', '.docx', '.zip']);

const upload = multer({
  storage: multer.diskStorage({
    destination: dir,
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z.]/g, '') || '.bin';
      cb(null, `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_MIME.has(file.mimetype) && ALLOWED_EXT.has(ext)) return cb(null, true);
    cb(new Error('That file type isn\'t allowed — images, PDF, DOC/DOCX, TXT, CSV or ZIP up to 8 MB.'));
  },
});

function attachmentField(field = 'attachment') {
  const single = upload.single(field);
  return (req, res, next) => {
    single(req, res, (err) => {
      if (err) {
        req.uploadError = err.code === 'LIMIT_FILE_SIZE'
          ? 'Attachment is too large — the limit is 8 MB.'
          : err.message;
      }
      next();
    });
  };
}

function newRef() {
  return 'FL-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function touch(ticketId) {
  db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticketId);
}

function openTicket(userId, subject, category, body, attachment, attachmentName) {
  const cat = CATEGORIES.has(category) ? category : 'general';
  const ref = newRef();
  const tx = db.transaction(() => {
    const t = db.prepare(
      'INSERT INTO tickets (ref, user_id, subject, category) VALUES (?,?,?,?)'
    ).run(ref, userId, subject, cat);
    db.prepare(
      'INSERT INTO ticket_messages (ticket_id, sender, body, attachment, attachment_name) VALUES (?,?,?,?,?)'
    ).run(t.lastInsertRowid, 'user', body, attachment || '', attachmentName || '');
    return t.lastInsertRowid;
  });
  return { id: tx(), ref };
}

function reply(ticketId, sender, body, attachment, attachmentName) {
  db.prepare(
    'INSERT INTO ticket_messages (ticket_id, sender, body, attachment, attachment_name) VALUES (?,?,?,?,?)'
  ).run(ticketId, sender, body, attachment || '', attachmentName || '');
  if (sender === 'admin') {
    db.prepare("UPDATE tickets SET admin_seen_at = datetime('now') WHERE id = ?").run(ticketId);
  }
  touch(ticketId);
}

function setStatus(ticketId, status) {
  const closedAt = status === 'closed' || status === 'solved' ? new Date().toISOString() : '';
  db.prepare('UPDATE tickets SET status = ?, closed_at = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(status, closedAt, ticketId);
}

function markAdminSeen(ticketId) {
  db.prepare("UPDATE tickets SET admin_seen_at = datetime('now') WHERE id = ?").run(ticketId);
}

/**
 * Keep the queue clean:
 *  - tickets marked Solved for more than 7 days → Closed
 *  - open tickets where the last admin reply had no user response for > 14 days → Closed
 * Returns the number of tickets closed.
 */
function autoCloseStale() {
  const notify = require('./notify');
  let closed = 0;
  const solved = db.prepare(
    `SELECT t.*, u.email AS user_email, u.name AS user_name
     FROM tickets t JOIN users u ON u.id = t.user_id
     WHERE t.status = 'solved'
       AND t.closed_at <> ''
       AND t.closed_at < datetime('now', '-7 days')`
  ).all();
  const stale = db.prepare(
    `SELECT t.*, u.email AS user_email, u.name AS user_name
     FROM tickets t JOIN users u ON u.id = t.user_id
     WHERE t.status = 'open'
       AND EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id = t.id AND m.sender = 'admin')
       AND COALESCE((SELECT MAX(created_at) FROM ticket_messages WHERE ticket_id = t.id AND sender = 'user'), '')
           <= COALESCE((SELECT MAX(created_at) FROM ticket_messages WHERE ticket_id = t.id AND sender = 'admin'), '')
       AND (SELECT MAX(created_at) FROM ticket_messages WHERE ticket_id = t.id AND sender = 'admin')
           < datetime('now', '-14 days')`
  ).all();
  const seen = new Set();
  for (const t of [...solved, ...stale]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    setStatus(t.id, 'closed');
    closed += 1;
    notify.notifyUser(t.user_id, {
      kind: 'ticket',
      title: `Ticket ${t.ref} was auto-closed`,
      body: t.status === 'solved'
        ? 'It stayed resolved for more than 7 days with no further replies.'
        : 'There was no reply from you for more than 14 days, so the ticket was closed to keep the queue clean.',
      url: `/dashboard/support/${t.id}`,
    });
    notify.notifyAdmin({
      kind: 'ticket',
      title: `Auto-closed ticket ${t.ref}`,
      body: `${t.subject} — ${t.user_email}`,
      url: `/admin3119Musa/tickets/${t.id}`,
    });
  }
  return closed;
}

module.exports = { attachmentField, openTicket, reply, setStatus, markAdminSeen, autoCloseStale, CATEGORIES };
