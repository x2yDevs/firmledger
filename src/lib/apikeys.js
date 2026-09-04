/**
 * FirmLedger API keys — generation, hashing, lookup, revocation, scopes and
 * durable usage aggregates. Raw keys are shown once and only their SHA-256
 * hash is persisted, so a database leak cannot reveal a live credential.
 */
const crypto = require('crypto');
const { db } = require('../db');

const KEY_PREFIX = 'fl_live_';
const KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // base58-ish, no confusing chars
const KEY_BODY_LEN = 32;
const MAX_ACTIVE_KEYS = 3;

const SCOPE_DEFINITIONS = Object.freeze([
  { id: 'read:listings', label: 'Read listings', description: 'Directory, profiles, filters, categories, countries, suggestions and your own listing reads.' },
  { id: 'write:listings', label: 'Write listings', description: 'Create, update and delete listings owned by this account.' },
  { id: 'export', label: 'Export', description: 'Download approved ledger data as CSV.' },
  { id: 'manage:webhooks', label: 'Manage webhooks', description: 'Create, test, rotate and remove event subscriptions.' },
  { id: 'read:usage', label: 'Read usage', description: 'Account usage, endpoint analytics and rate-limit snapshots.' },
]);
const VALID_SCOPES = new Set(SCOPE_DEFINITIONS.map((s) => s.id));
const DEFAULT_SCOPES = SCOPE_DEFINITIONS.map((s) => s.id);

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

/** Normalize a scope payload while preserving the documented order. */
function normalizeScopes(input, { allowEmpty = false } = {}) {
  let values = input;
  if (values === undefined || values === null) values = DEFAULT_SCOPES;
  if (typeof values === 'string') {
    try {
      const parsed = JSON.parse(values);
      values = Array.isArray(parsed) ? parsed : values.split(',');
    } catch {
      values = values.split(',');
    }
  }
  if (!Array.isArray(values)) values = [values];
  const cleanedValues = [...new Set(values.map((s) => String(s || '').trim()).filter(Boolean))];
  const unknown = cleanedValues.filter((scope) => !VALID_SCOPES.has(scope));
  if (unknown.length) {
    const err = new Error(`Unknown API scope${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`);
    err.status = 422; err.code = 'invalid_scope';
    throw err;
  }
  const scopes = DEFAULT_SCOPES.filter((scope) => cleanedValues.includes(scope));
  if (!scopes.length && !allowEmpty) {
    const err = new Error('Choose at least one API scope.');
    err.status = 422; err.code = 'scope_required';
    throw err;
  }
  return DEFAULT_SCOPES.filter((scope) => scopes.includes(scope));
}

function parseScopes(rowOrValue) {
  const raw = rowOrValue && typeof rowOrValue === 'object' && !Array.isArray(rowOrValue)
    ? rowOrValue.scopes : rowOrValue;
  try {
    return normalizeScopes(raw);
  } catch {
    // A key created before scopes existed is intentionally full-access.
    return [...DEFAULT_SCOPES];
  }
}

function hasScope(key, scope) {
  return parseScopes(key).includes(scope);
}

/** Create a key for a user. Throws { status, code } when validation fails. */
function createKey(userId, label = '', scopes = DEFAULT_SCOPES) {
  const active = db.prepare('SELECT COUNT(*) c FROM api_keys WHERE user_id=? AND revoked_at IS NULL').get(userId).c;
  if (active >= MAX_ACTIVE_KEYS) {
    const err = new Error(`You can hold at most ${MAX_ACTIVE_KEYS} active API keys — revoke one first.`);
    err.status = 409; err.code = 'key_limit';
    throw err;
  }
  const normalized = normalizeScopes(scopes);
  const raw = KEY_PREFIX + randomKeyBody();
  const prefix = raw.slice(0, 14) + '…';
  const info = db.prepare('INSERT INTO api_keys (user_id, label, prefix, key_hash, scopes) VALUES (?,?,?,?,?)')
    .run(userId, String(label || '').trim().slice(0, 60), prefix, hashKey(raw), JSON.stringify(normalized));
  return { raw, key: db.prepare('SELECT * FROM api_keys WHERE id=?').get(info.lastInsertRowid) };
}

function listKeys(userId) {
  return db.prepare('SELECT id, label, prefix, scopes, created_at, last_used_at, revoked_at, total_requests, write_requests FROM api_keys WHERE user_id=? ORDER BY id DESC')
    .all(userId)
    .map((row) => ({ ...row, scopes: parseScopes(row) }));
}

function activeKeyCount(userId) {
  return db.prepare('SELECT COUNT(*) c FROM api_keys WHERE user_id=? AND revoked_at IS NULL').get(userId).c;
}

function revokeKey(id, userId) {
  const r = db.prepare("UPDATE api_keys SET revoked_at=datetime('now') WHERE id=? AND user_id=? AND revoked_at IS NULL").run(id, userId);
  return r.changes > 0;
}

function updateScopes(id, userId, scopes) {
  const normalized = normalizeScopes(scopes);
  const r = db.prepare('UPDATE api_keys SET scopes=? WHERE id=? AND user_id=? AND revoked_at IS NULL')
    .run(JSON.stringify(normalized), id, userId);
  return r.changes > 0;
}

/** Resolve a raw key to { key, user } or null (revoked handled by caller). */
function lookup(raw) {
  const key = db.prepare('SELECT * FROM api_keys WHERE key_hash=?').get(hashKey(raw));
  if (!key) return null;
  const user = db.prepare('SELECT id, email, name, plan, plan_expires_at, trial_expires_at, subscription_status, suspended FROM users WHERE id=?').get(key.user_id);
  return { key, user };
}

/** Normalize paths before storing endpoint analytics so ids/slugs do not create unbounded cardinality. */
function usageEndpoint(method, path) {
  let p = String(path || '').split('?')[0].replace(/^\/api\/v1(?=\/|$)/, '') || '/';
  p = p.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  if (/^\/(listings|directory)\/[^/]+$/.test(p)) p = p.replace(/^(\/[^/]+)\/[^/]+$/, '$1/:slug');
  else if (/^\/my\/listings\/\d+$/.test(p)) p = '/my/listings/:id';
  else if (/^\/listings\/\d+$/.test(p)) p = '/listings/:id';
  else if (/^\/verify\/domain\/[^/]+$/.test(p)) p = '/verify/domain/:domain';
  else if (/^\/webhooks\/\d+\/deliveries\/\d+$/.test(p)) p = '/webhooks/:id/deliveries/:deliveryId';
  else if (/^\/webhooks\/\d+\/[^/]+$/.test(p)) p = p.replace(/^\/webhooks\/\d+\/[^/]+$/, '/webhooks/:id/action');
  else if (/^\/webhooks\/\d+$/.test(p)) p = '/webhooks/:id';
  return { method: String(method || 'GET').toUpperCase(), endpoint: p };
}

/** Record one request (and optionally one write) against a key. */
function recordUsage(keyId, isWrite, endpoint = { method: 'GET', endpoint: '/unknown' }) {
  const e = typeof endpoint === 'string' ? usageEndpoint('GET', endpoint) : endpoint;
  db.prepare("UPDATE api_keys SET total_requests=total_requests+1, write_requests=write_requests+?, last_used_at=datetime('now') WHERE id=?")
    .run(isWrite ? 1 : 0, keyId);
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO api_usage_daily (key_id, day, requests, writes) VALUES (?,?,1,?)
              ON CONFLICT(key_id, day) DO UPDATE SET requests=requests+1, writes=writes+excluded.writes`)
    .run(keyId, day, isWrite ? 1 : 0);
  db.prepare(`INSERT INTO api_usage_endpoint_daily (key_id, day, method, endpoint, requests, writes)
              VALUES (?,?,?,?,1,?)
              ON CONFLICT(key_id, day, method, endpoint)
              DO UPDATE SET requests=requests+1, writes=writes+excluded.writes`)
    .run(keyId, day, e.method, e.endpoint, isWrite ? 1 : 0);
}

function monthStart(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function dayIso(date) { return date.toISOString().slice(0, 10); }

/** Dashboard/API usage totals, endpoint ranking and a compact 31-day chart series. */
function usageSummary(userId) {
  const keys = db.prepare('SELECT id FROM api_keys WHERE user_id=?').all(userId).map((r) => r.id);
  const empty = {
    today_requests: 0, today_writes: 0, total_requests: 0, total_writes: 0,
    month_requests: 0, month_writes: 0, top_endpoints: [], daily: [],
  };
  if (!keys.length) return empty;
  const marks = keys.map(() => '?').join(',');
  const todayDay = dayIso(new Date());
  const start = monthStart();
  const today = db.prepare(`SELECT COALESCE(SUM(requests),0) r, COALESCE(SUM(writes),0) w
    FROM api_usage_daily WHERE day=? AND key_id IN (${marks})`).get(todayDay, ...keys);
  const month = db.prepare(`SELECT COALESCE(SUM(requests),0) r, COALESCE(SUM(writes),0) w
    FROM api_usage_daily WHERE day>=? AND key_id IN (${marks})`).get(start, ...keys);
  const total = db.prepare(`SELECT COALESCE(SUM(total_requests),0) r, COALESCE(SUM(write_requests),0) w
    FROM api_keys WHERE user_id=?`).get(userId);
  const top = db.prepare(`SELECT method, endpoint, SUM(requests) requests, SUM(writes) writes
    FROM api_usage_endpoint_daily WHERE day>=? AND key_id IN (${marks})
    GROUP BY method, endpoint ORDER BY requests DESC, endpoint ASC LIMIT 8`).all(start, ...keys);

  // The chart deliberately crosses a month boundary when needed; monthly totals
  // and the graph are separate views with different time windows.
  const chartStartDay = dayIso(new Date(Date.now() - 30 * 864e5));
  const dailyRows = db.prepare(`SELECT day, SUM(requests) requests, SUM(writes) writes
    FROM api_usage_daily WHERE day>=? AND key_id IN (${marks}) GROUP BY day ORDER BY day ASC`).all(chartStartDay, ...keys);
  const chartMap = new Map(dailyRows.map((r) => [r.day, { requests: r.requests, writes: r.writes }]));
  const daily = [];
  for (let i = 30; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    const day = dayIso(d);
    const v = chartMap.get(day) || { requests: 0, writes: 0 };
    daily.push({ day, requests: v.requests, writes: v.writes });
  }
  return {
    today_requests: today.r,
    today_writes: today.w,
    total_requests: total.r,
    total_writes: total.w,
    month_requests: month.r,
    month_writes: month.w,
    top_endpoints: top,
    daily,
  };
}

module.exports = {
  KEY_PREFIX, MAX_ACTIVE_KEYS,
  SCOPE_DEFINITIONS, DEFAULT_SCOPES, VALID_SCOPES,
  isWellFormed, hashKey, normalizeScopes, parseScopes, hasScope,
  createKey, listKeys, activeKeyCount, revokeKey, updateScopes, lookup,
  recordUsage, usageEndpoint, usageSummary,
};
