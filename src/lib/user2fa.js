/**
 * User two-factor authentication.
 *
 * TOTP (Google Authenticator etc.) + 10 one-time recovery codes rendered
 * as a downloadable .txt at enrollment. When 2FA is enabled, sensitive
 * account actions (change password, change email, disable 2FA itself)
 * require either the current 6-digit TOTP or one unused recovery code.
 */
const crypto = require('crypto');
const { db } = require('../db');
const totp = require('./totp');

function row(userId) {
  return db.prepare('SELECT * FROM user_totp WHERE user_id = ?').get(userId) || null;
}
function enabled(userId) {
  const r = row(userId);
  return Boolean(r && r.enabled);
}

function startEnrollment(userId) {
  const secret = totp.generateSecret();
  db.prepare(
    'INSERT INTO user_totp (user_id, pending_secret, enabled) VALUES (?,?,0) ON CONFLICT(user_id) DO UPDATE SET pending_secret = EXCLUDED.pending_secret'
  ).run(userId, secret);
  return secret;
}

function otpAuthUrl(secret, email) {
  const label = `FirmLedger:${email}`;
  return totp.otpAuthUrl(secret, label);
}

/** Generate 10 codes shaped xxxx-xxxx-xxxx (base32, unambiguous alphabet). */
function genRecoveryCodes(n = 10) {
  const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const mk = () => {
    const raw = Array.from(crypto.randomBytes(15)).map((b) => alpha[b % 32]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  };
  return Array.from({ length: n }, mk);
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code).toUpperCase().replace(/\s/g, '')).digest('hex');
}

function completeEnrollment(userId, code) {
  const r = row(userId);
  if (!r || !r.pending_secret) return { ok: false, error: 'Start the setup first — no authenticator enrollment is pending.' };
  if (!totp.verifyTotp(r.pending_secret, code)) return { ok: false, error: 'That code did not match. Check your authenticator clock and try the latest 6-digit code.' };

  const codes = genRecoveryCodes(10);
  const hashes = codes.map(hashCode);
  db.prepare(
    'UPDATE user_totp SET secret = ?, pending_secret = ?, recovery_codes = ?, enabled = 1, enabled_at = ? WHERE user_id = ?'
  ).run(r.pending_secret, '', JSON.stringify(hashes.map((h, i) => ({ h, used: 0 }))), new Date().toISOString(), userId);
  return { ok: true, codes };
}

function disable(userId) {
  db.prepare('UPDATE user_totp SET secret = ?, pending_secret = ?, recovery_codes = ?, enabled = 0 WHERE user_id = ?')
    .run('', '', '[]', userId);
}

/**
 * authorise a sensitive action — accepts TOTP or a recovery code.
 * Recovery codes are single-use; we burn them on success.
 */
function verifySensitive(userId, code) {
  const r = row(userId);
  if (!r || !r.enabled) return { ok: true }; // no 2FA → nothing to verify
  const raw = String(code || '').trim();
  if (!raw) return { ok: false, error: 'Two-factor authentication is on for your account — enter your 6-digit app code or a recovery code.' };
  if (/^\d{6}$/.test(raw) && totp.verifyTotp(r.secret, raw)) return { ok: true };

  // try recovery codes
  let list = [];
  try { list = JSON.parse(r.recovery_codes); } catch {}
  const h = hashCode(raw);
  const idx = list.findIndex((c) => c.h === h && !c.used);
  if (idx >= 0) {
    list[idx].used = 1;
    db.prepare('UPDATE user_totp SET recovery_codes = ? WHERE user_id = ?').run(JSON.stringify(list), userId);
    return { ok: true, recovery: true, remaining: list.filter((c) => !c.used).length };
  }
  return { ok: false, error: 'That code did not match — use the 6-digit code from your authenticator app, or one of your unused recovery codes.' };
}

/** recovery codes left (for dashboard display) */
function recoveryCount(userId) {
  const r = row(userId);
  if (!r || !r.enabled) return 0;
  try { return JSON.parse(r.recovery_codes).filter((c) => !c.used).length; }
  catch { return 0; }
}

module.exports = { enabled, startEnrollment, otpAuthUrl, completeEnrollment, disable, verifySensitive, recoveryCount };
