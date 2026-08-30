/**
 * FirmLedger API keys — generation, hashing, lookup, revocation, usage.
 * Raw keys are shown to the owner exactly once (at creation); only the
 * SHA-256 hash is ever persisted, so a database leak cannot leak live keys.
 */
const crypto = require('crypto');
const { db } = require('../db');

const KEY_PREFIX = 'fl_live_';
const KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // base58-ish, no confusing chars
const KEY_BODY_LEN = 32;
const MAX_ACTIVE_KEYS = 3;

function randomKeyBody(len = KEY_BODY_LEN) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += KEY_CHARS[bytes[i] % KEY_CHARS.length];
  return out;
}

function hashKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function isWellFormed(raw) {
  return typeof raw === 'string' && /^fl_live_[A-Za-z0-9]{32}$/.test(raw);
}

/** Create a key for a user. Throws { status, code } when the cap is reached. */
function createKey(userId, label = '') {
  const active = db.prepare('SELECT COUNT(*) c FROM api_keys WHERE user_id=? AND revoked_at IS NULL').get(userId).c;
  if (active >= MAX_ACTIVE_KEYS) {
    const err = new Error(`You can hold at most ${MAX_ACTIVE_KEYS} active API keys — revoke one first.`);
    err.status = 409; err.code = 'key_limit';
    throw err;
  }
  const raw = KEY_PREFIX + randomKeyBody();
  const prefix = raw.slice(0, 14) + '…';
  const info = db.prepare('INSERT INTO api_keys (user_id, label, prefix, key_hash) VALUES (?,?,?,?)')
    .run(userId, String(label || '').trim().slice(0, 60), prefix, hashKey(raw));
  return { raw, key: db.prepare('SELECT * FROM api_keys WHERE id=?').get(info.lastInsertRowid) };
}

function listKeys(userId) {
  return db.prepare('SELECT id, label, prefix, created_at, last_used_at, revoked_at, total_requests, write_requests FROM api_keys WHERE user_id=? ORDER BY id DESC').all(userId);
}

function activeKeyCount(userId) {
  return db.prepare('SELECT COUNT(*) c FROM api_keys WHERE user_id=? AND revoked_at IS NULL').get(userId).c;
}

function revokeKey(id, userId) {
  const r = db.prepare('UPDATE api_keys SET revoked_at=datetime(\'now\') WHERE id=? AND user_id=? AND revoked_at IS NULL').run(id, userId);
  return r.changes > 0;
}

/** Resolve a raw key to { key, user } or null (unknown / revoked handled by caller). */
function lookup(raw) {
  const key = db.prepare('SELECT * FROM api_keys WHERE key_hash=?').get(hashKey(raw));
  if (!key) return null;
  const user = db.prepare('SELECT id, email, name, plan, plan_expires_at, suspended FROM users WHERE id=?').get(key.user_id);
  return { key, user };
}

/** Record one request (and optionally one write) against a key. */
function recordUsage(keyId, isWrite) {
  db.prepare('UPDATE api_keys SET total_requests=total_requests+1, write_requests=write_requests+?, last_used_at=datetime(\'now\') WHERE id=?')
    .run(isWrite ? 1 : 0, keyId);
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO api_usage_daily (key_id, day, requests, writes) VALUES (?,?,1,?)
              ON CONFLICT(key_id, day) DO UPDATE SET requests=requests+1, writes=writes+excluded.writes`)
    .run(keyId, day, isWrite ? 1 : 0);
}

/** Rolling usage totals for the console. */
function usageSummary(userId) {
  const keys = db.prepare('SELECT id FROM api_keys WHERE user_id=?').all(userId).map((r) => r.id);
  if (!keys.length) return { today_requests: 0, today_writes: 0, total_requests: 0, total_writes: 0 };
  const day = new Date().toISOString().slice(0, 10);
  const marks = keys.map(() => '?').join(',');
  const today = db.prepare(`SELECT COALESCE(SUM(requests),0) r, COALESCE(SUM(writes),0) w FROM api_usage_daily WHERE day=? AND key_id IN (${marks})`).get(day, ...keys);
  const total = db.prepare(`SELECT COALESCE(SUM(total_requests),0) r, COALESCE(SUM(write_requests),0) w FROM api_keys WHERE user_id=?`).get(userId);
  return { today_requests: today.r, today_writes: today.w, total_requests: total.r, total_writes: total.w };
}

module.exports = {
  KEY_PREFIX, MAX_ACTIVE_KEYS, isWellFormed, hashKey,
  createKey, listKeys, activeKeyCount, revokeKey, lookup, recordUsage, usageSummary,
};
