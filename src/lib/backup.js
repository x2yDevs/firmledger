/**
 * FirmLedger user backup & export.
 *
 * .firmledger files are plain JSON (UTF-8), pretty-printed so the records line up
 * column wise and remain human-auditable. Two files share the one format:
 *   - "Export users"   → the core user rows (details + plan + status).
 *   - "Backup"         → the same rows PLUS each user's listings, claims, tickets
 *                        and payment history, so a full restore is possible after loss.
 * Password hashes are included — an account keeps working after a restore.
 * Imports validate the format header and merge by email (update in place, never
 * silently downgrade an existing account unless the file says to).
 */
const multer = require('multer');
const { db } = require('../db');

const FORMAT = 'firmledger-backup@1';

const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/** multipart field middleware — parses the single uploaded .firmledger file into req.file. */
function backupField(field = 'backup_file') {
  const single = memUpload.single(field);
  return (req, res, next) => {
    single(req, res, (err) => {
      if (err) {
        req.uploadError = err.code === 'LIMIT_FILE_SIZE'
          ? 'Backup file is too large — the limit is 25 MB.'
          : err.message;
      }
      next();
    });
  };
}

function userRows() {
  return db.prepare(
    'SELECT id, name, email, password_hash, plan, plan_expires_at, suspended, created_at FROM users ORDER BY id ASC'
  ).all();
}

function pad(v, w) { return String(v ?? '').padEnd(w, ' '); }

/** Aligned per-user block for the export file. */
function exportUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    password_hash: u.password_hash,
    plan: u.plan,
    plan_expires_at: u.plan_expires_at,
    suspended: u.suspended,
    created_at: u.created_at,
  };
}

/** "Export users" — core account details for every user. */
function buildExport() {
  const users = userRows().map(exportUser);
  return JSON.stringify({
    format: FORMAT,
    kind: 'user-export',
    generated_at: new Date().toISOString(),
    app: 'FirmLedger',
    count: users.length,
    users,
  }, null, 2);
}

/** "Backup" — everything about every user, restore-ready. */
function buildBackup() {
  const users = userRows().map((u) => {
    const listings = db.prepare(
      'SELECT id, slug, name, status, claimed, plan, plan_expires_at, created_at, updated_at FROM listings WHERE owner_user_id = ? ORDER BY id ASC'
    ).all(u.id);
    const claims = db.prepare(
      'SELECT id, listing_id, method, domain, status, created_at FROM claims WHERE user_id = ? ORDER BY id ASC'
    ).all(u.id);
    const tickets = db.prepare(
      'SELECT id, ref, subject, category, status, created_at, updated_at FROM tickets WHERE user_id = ? ORDER BY id ASC'
    ).all(u.id);
    const payments = db.prepare(
      'SELECT id, listing_id, plan_id, duration_days, order_id, reference, amount, currency, status, channel, email, created_at, paid_at FROM payments WHERE user_id = ? ORDER BY id ASC'
    ).all(u.id);
    const totp = db.prepare('SELECT enabled, enabled_at FROM user_totp WHERE user_id = ?').get(u.id);
    return { ...exportUser(u), twofa: totp ? { enabled: totp.enabled, enabled_at: totp.enabled_at } : null, listings, claims, tickets, payments };
  });
  return JSON.stringify({
    format: FORMAT,
    kind: 'full-backup',
    generated_at: new Date().toISOString(),
    app: 'FirmLedger',
    count: users.length,
    users,
  }, null, 2);
}

/**
 * Import a .firmledger file's `users` array. Merges by email:
 * existing accounts get their details updated (password_hash kept unless the file
 * carries one), new accounts are inserted with the file's password hash so their
 * original login keeps working. Related data in a full backup is not re-inserted
 * listing-by-listing (the ledger is permanent) — the restore targets identities:
 * name/email/password/plan/suspension so lost users can sign in again fully intact.
 */
function importUsers(text) {
  let doc;
  try { doc = JSON.parse(text); }
  catch { return { ok: false, error: 'That file is not valid JSON — upload the .firmledger file that the export produced.' }; }
  if (!doc || doc.format !== FORMAT || !Array.isArray(doc.users)) {
    return { ok: false, error: 'That file is not a FirmLedger export/backup — the format header did not match. Re-download the file from the admin console.' };
  }
  let created = 0; let updated = 0; let skipped = 0;
  const find = db.prepare('SELECT id, password_hash FROM users WHERE email = ?');
  const ins = db.prepare('INSERT INTO users (email, password_hash, name, plan, plan_expires_at, suspended, created_at) VALUES (?,?,?,?,?,?,?)');
  const upd = db.prepare('UPDATE users SET name = ?, password_hash = ?, plan = ?, plan_expires_at = ?, suspended = ? WHERE email = ?');
  const tx = db.transaction((rows) => {
    for (const u of rows) {
      const email = String(u.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { skipped++; continue; }
      const name = String(u.name || '').trim().slice(0, 80) || email.split('@')[0];
      const plan = u.plan === 'pro' ? 'pro' : 'free';
      const planExp = String(u.plan_expires_at || '').slice(0, 40);
      const suspended = u.suspended ? 1 : 0;
      const existing = find.get(email);
      const hash = typeof u.password_hash === 'string' && u.password_hash.length > 10 ? u.password_hash : null;
      if (existing) {
        upd.run(name, hash || existing.password_hash, plan, planExp, suspended, email);
        updated++;
      } else {
        if (!hash) { skipped++; continue; } // cannot invent a credential — skip accounts with no hash
        ins.run(email, hash, name, plan, planExp, suspended, String(u.created_at || '').slice(0, 40) || new Date().toISOString());
        created++;
      }
    }
  });
  try { tx(doc.users); }
  catch (e) { return { ok: false, error: 'Import failed mid-flight: ' + e.message + ' — the database was left unchanged.' }; }
  return { ok: true, created, updated, skipped, total: doc.users.length, kind: doc.kind || 'user-export', generatedAt: doc.generated_at || '' };
}

/** Permanently delete a user and everything personally attributable to their account. */
function deleteUserCascade(userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) return { ok: false, error: 'User not found.' };
  const tx = db.transaction(() => {
    // Their listings come off their name — the business record stays in the ledger
    db.prepare('UPDATE listings SET owner_user_id = NULL, claimed = 0 WHERE owner_user_id = ?').run(userId);
    // Personal data, gone for good
    db.prepare('DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE user_id = ?)').run(userId);
    db.prepare('DELETE FROM tickets WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM resets WHERE email = ?').run(u.email);
    db.prepare('DELETE FROM reg_otps WHERE email = ?').run(u.email);
    db.prepare('DELETE FROM user_totp WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM claims WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM payments WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });
  try { tx(); }
  catch (e) { return { ok: false, error: 'Delete failed: ' + e.message + ' — the account was left intact.' }; }
  return { ok: true, email: u.email, name: u.name };
}

/* ------- admin recovery codes (same model as user 2FA) ------- */
const crypto = require('crypto');
function genAdminRecoveryCodes(n = 10) {
  const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const mk = () => {
    const raw = Array.from(crypto.randomBytes(15)).map((b) => alpha[b % 32]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  };
  return Array.from({ length: n }, mk);
}
function hashAdminCode(code) {
  return crypto.createHash('sha256').update(String(code).toUpperCase().replace(/\s/g, '')).digest('hex');
}
/** verify() → { ok, remaining } — chews the matching unused code. */
function verifyAdminRecovery(code) {
  const raw = String(code || '').trim();
  if (!/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(raw)) return { ok: false };
  let list = [];
  try { list = JSON.parse(require('../db').getSetting('admin_recovery_codes', '[]')); } catch {}
  const h = hashAdminCode(raw);
  const idx = list.findIndex((c) => c.h === h && !c.used);
  if (idx < 0) return { ok: false };
  list[idx].used = 1;
  require('../db').setSetting('admin_recovery_codes', JSON.stringify(list));
  return { ok: true, remaining: list.filter((c) => !c.used).length };
}

module.exports = {
  FORMAT, backupField, buildExport, buildBackup, importUsers, deleteUserCascade,
  genAdminRecoveryCodes, hashAdminCode, verifyAdminRecovery,
};
