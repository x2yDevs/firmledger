/**
 * Admin email second-factor fallback.
 *
 * After the admin secret code (first factor) is accepted, a 6-digit one-time
 * sign-in code is emailed to the admin notification address — the escape hatch
 * when the authenticator app is unreachable. Codes live for 10 minutes, are
 * single-use (burned on success), are replaced whenever a new one is issued,
 * and are resend-throttled to one email per minute.
 *
 * Stored hashed (sha256) in settings — the cleartext only ever exists in the
 * email itself, never in the database.
 */
const crypto = require('crypto');
const { getSetting, setSetting } = require('../db');

const SETTING = 'admin_email_otp';
const SETTING_SENT = 'admin_email_otp_sent_at';
const TTL_MS = 10 * 60 * 1000;      // 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000; // one email per minute

function load() {
  try { return JSON.parse(getSetting(SETTING, '')) || null; } catch { return null; }
}
function hash(code) {
  return crypto.createHash('sha256').update(String(code).trim()).digest('hex');
}

/** Issue a fresh code (any prior one dies instantly). Returns the 6-digit code. */
function createEmailCode() {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  setSetting(SETTING, JSON.stringify({ h: hash(code), exp: Date.now() + TTL_MS, used: 0 }));
  setSetting(SETTING_SENT, String(Date.now()));
  return code;
}

/** { ok } — burns the code on success. */
function verifyEmailCode(code) {
  const raw = String(code || '').trim();
  if (!/^\d{6}$/.test(raw)) return { ok: false };
  const row = load();
  if (!row || row.used) return { ok: false };
  if (Date.now() > row.exp) return { ok: false };
  try {
    if (!crypto.timingSafeEqual(Buffer.from(hash(raw)), Buffer.from(row.h))) return { ok: false };
  } catch { return { ok: false }; }
  row.used = 1;
  setSetting(SETTING, JSON.stringify(row));
  return { ok: true };
}

/** Clear any pending code (after a successful sign-in via any factor, or a reset). */
function clearEmailCode() {
  setSetting(SETTING, '');
  setSetting(SETTING_SENT, '');
}

/** Resend guard — true when a resend is allowed right now. */
function resendAllowed() {
  const sentAt = Number(getSetting(SETTING_SENT, '0') || '0');
  return Date.now() - sentAt >= RESEND_COOLDOWN_MS;
}

module.exports = { createEmailCode, verifyEmailCode, clearEmailCode, resendAllowed, TTL_MS };
