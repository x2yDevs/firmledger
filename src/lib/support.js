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

module.exports = { attachmentField, openTicket, reply, setStatus, markAdminSeen, CATEGORIES };
