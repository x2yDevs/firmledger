/**
 * FirmLedger API webhooks.
 *
 * Webhook writes are deliberately queue-first: the request that changes a
 * listing only records a small durable delivery row, then the POST happens in
 * the background. A restart drains pending rows, retries transient failures
 * with backoff, signs every body with HMAC-SHA256 and disables a subscription
 * after repeated terminal failures. The API never waits on a third-party URL.
 */
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');
const { db } = require('../db');

const EVENTS = Object.freeze([
  'listing.approved',
  'listing.rejected',
  'listing.updated',
  'listing.created',
  'listing.deleted',
  'claim.verified',
]);
const DEFAULT_EVENTS = EVENTS.filter((e) => e !== 'listing.deleted');
const MAX_ACTIVE_FAILURES = 10;
const MAX_WEBHOOKS_PER_USER = 10;
const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];
const DELIVERY_TIMEOUT_MS = Math.max(2_000, Number(process.env.WEBHOOK_TIMEOUT_MS) || 10_000);
const MAX_RESPONSE_CHARS = 2_000;
const queue = new Set();

class WebhookServiceError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details) {
  throw new WebhookServiceError(status, code, message, details);
}

function parseJsonList(value, fallback = []) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ''));
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeEvents(input) {
  const source = input === undefined || input === null ? DEFAULT_EVENTS : input;
  const values = Array.isArray(source) ? source : String(source).split(',');
  const cleaned = [...new Set(values.map((v) => String(v || '').trim()).filter(Boolean))];
  if (cleaned.includes('*')) return [...EVENTS];
  const unknown = cleaned.filter((event) => !EVENTS.includes(event));
  if (unknown.length) fail(422, 'invalid_events', `Unknown webhook event${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`, { allowed: EVENTS });
  if (!cleaned.length) fail(422, 'events_required', 'Choose at least one webhook event.', { allowed: EVENTS });
  return EVENTS.filter((event) => cleaned.includes(event));
}

function normalizeCategories(input) {
  if (input === undefined || input === null || input === '') return [];
  const values = Array.isArray(input) ? input : String(input).split(',');
  return [...new Set(values.map((v) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 80)).filter(Boolean))].slice(0, 50);
}

function isPrivateIp(value) {
  const raw = String(value || '').toLowerCase().replace(/^\[|\]$/g, '');
  const ip = raw.replace(/^::ffff:/, '');
  if (net.isIPv4(ip)) {
    const octets = ip.split('.').map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31
      || a === 192 && (b === 0 || b === 168)
      || a === 198 && (b === 18 || b === 19 || b === 51)
      || a === 203 && b === 0 && octets[2] === 113
      || a >= 224;
  }
  if (!net.isIPv6(raw)) return false;
  let normalized = raw;
  const dottedIndex = raw.lastIndexOf(':');
  const dottedTail = dottedIndex >= 0 ? raw.slice(dottedIndex + 1) : '';
  if (net.isIPv4(dottedTail)) {
    const octets = dottedTail.split('.').map(Number);
    normalized = `${raw.slice(0, dottedIndex)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const pieces = normalized.split('::');
  if (pieces.length > 2) return false;
  const left = pieces[0] ? pieces[0].split(':').filter(Boolean) : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':').filter(Boolean) : [];
  const groups = pieces.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : [...left];
  if (groups.length !== 8) return false;
  const bytes = groups.map((group) => Number.parseInt(group, 16));
  if (bytes.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff)) return false;
  const first = bytes[0];
  const firstByte = first >> 8;
  const isMapped = bytes.slice(0, 5).every((n) => n === 0) && bytes[5] === 0xffff;
  if (isMapped) {
    const mapped = `${bytes[6] >> 8}.${bytes[6] & 255}.${bytes[7] >> 8}.${bytes[7] & 255}`;
    return isPrivateIp(mapped);
  }
  return bytes.every((n) => n === 0) || (bytes.slice(0, 7).every((n) => n === 0) && bytes[7] === 1)
    || (firstByte & 0xfe) === 0xfc // unique-local fc00::/7
    || firstByte === 0xff // multicast
    || (first & 0xffc0) === 0xfe80; // link-local fe80::/10
}

function validateWebhookUrl(raw) {
  let parsed;
  try { parsed = new URL(String(raw || '').trim()); } catch {
    fail(422, 'invalid_url', 'Webhook URL must be an absolute http(s) URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) fail(422, 'invalid_url', 'Webhook URL must use http or https.');
  if (parsed.username || parsed.password || parsed.hash) fail(422, 'invalid_url', 'Webhook URLs cannot contain credentials or fragments.');
  if (parsed.hostname.length > 253 || String(raw || '').length > 500) fail(422, 'invalid_url', 'Webhook URL is too long.');
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    fail(422, 'https_required', 'Production webhooks must use HTTPS so signed event payloads cannot be intercepted.');
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
      || host === 'metadata.google.internal' || host === '169.254.169.254' || isPrivateIp(host)) {
    fail(422, 'private_url', 'Webhook URLs must point to a public host. Local and private network addresses are blocked.');
  }
  return parsed.toString();
}

function encryptionKey() {
  // WEBHOOK_ENCRYPTION_KEY should be a long random production secret. ADMIN_SECRET
  // is the backwards-compatible fallback used by existing FirmLedger deployments.
  return crypto.createHash('sha256')
    .update(String(process.env.WEBHOOK_ENCRYPTION_KEY || process.env.ADMIN_SECRET || 'firmledger-development-webhook-key'))
    .digest();
}

function encryptSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}

function decryptSecret(value) {
  try {
    const [version, ivText, tagText, bodyText] = String(value || '').split('.');
    if (version !== 'v1' || !ivText || !tagText || !bodyText) return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(bodyText, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function randomSecret() {
  return `whsec_${crypto.randomBytes(32).toString('base64url')}`;
}

function serialize(row) {
  return {
    id: row.id,
    label: row.label,
    url: row.url,
    secret_prefix: row.secret_prefix,
    events: normalizeEvents(parseJsonList(row.events, DEFAULT_EVENTS)),
    categories: normalizeCategories(parseJsonList(row.categories, [])),
    active: !!row.active,
    failure_count: row.failure_count || 0,
    last_error: row.last_error || '',
    last_delivery_at: row.last_delivery_at || null,
    last_success_at: row.last_success_at || null,
    disabled_at: row.disabled_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getOwned(userId, id) {
  const row = db.prepare('SELECT * FROM api_webhooks WHERE id=? AND user_id=?').get(Number(id), userId);
  if (!row) fail(404, 'webhook_not_found', 'That webhook does not exist on your account.');
  return row;
}

function list(userId) {
  return db.prepare('SELECT * FROM api_webhooks WHERE user_id=? ORDER BY active DESC, id DESC').all(userId).map(serialize);
}

function create(userId, input = {}) {
  const count = db.prepare('SELECT COUNT(*) c FROM api_webhooks WHERE user_id=?').get(userId).c;
  if (count >= MAX_WEBHOOKS_PER_USER) fail(409, 'webhook_limit', `You can register at most ${MAX_WEBHOOKS_PER_USER} webhook destinations per account.`);
  const url = validateWebhookUrl(input.url);
  const label = String(input.label || '').trim().replace(/\s+/g, ' ').slice(0, 80) || 'Untitled webhook';
  const events = normalizeEvents(input.events);
  const categories = normalizeCategories(input.categories);
  const secret = randomSecret();
  try {
    const info = db.prepare(`INSERT INTO api_webhooks
      (user_id, label, url, secret_prefix, secret_ciphertext, events, categories)
      VALUES (?,?,?,?,?,?,?)`).run(
      userId, label, url, secret.slice(0, 15) + '…', encryptSecret(secret), JSON.stringify(events), JSON.stringify(categories)
    );
    return { row: db.prepare('SELECT * FROM api_webhooks WHERE id=?').get(info.lastInsertRowid), secret };
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) fail(409, 'webhook_exists', 'A webhook with that URL already exists on your account.');
    throw e;
  }
}

function update(userId, id, input = {}) {
  const row = getOwned(userId, id);
  const values = [];
  const sets = [];
  if (Object.prototype.hasOwnProperty.call(input, 'url')) { sets.push('url=?'); values.push(validateWebhookUrl(input.url)); }
  if (Object.prototype.hasOwnProperty.call(input, 'label')) { sets.push('label=?'); values.push(String(input.label || '').trim().replace(/\s+/g, ' ').slice(0, 80) || 'Untitled webhook'); }
  if (Object.prototype.hasOwnProperty.call(input, 'events')) { sets.push('events=?'); values.push(JSON.stringify(normalizeEvents(input.events))); }
  if (Object.prototype.hasOwnProperty.call(input, 'categories')) { sets.push('categories=?'); values.push(JSON.stringify(normalizeCategories(input.categories))); }
  if (Object.prototype.hasOwnProperty.call(input, 'active')) {
    const active = input.active === true || input.active === 1 || input.active === '1' || input.active === 'true';
    sets.push('active=?'); values.push(active ? 1 : 0);
    if (active) { sets.push('disabled_at=NULL'); sets.push("failure_count=0"); sets.push("last_error=''"); }
  }
  if (!sets.length) fail(422, 'empty_update', 'Provide url, label, events, categories or active to update.');
  values.push(Number(id), userId);
  try {
    db.prepare(`UPDATE api_webhooks SET ${sets.join(', ')}, updated_at=datetime('now') WHERE id=? AND user_id=?`).run(...values);
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) fail(409, 'webhook_exists', 'A webhook with that URL already exists on your account.');
    throw e;
  }
  return getOwned(userId, id);
}

function rotateSecret(userId, id) {
  getOwned(userId, id);
  const secret = randomSecret();
  db.prepare("UPDATE api_webhooks SET secret_prefix=?, secret_ciphertext=?, updated_at=datetime('now') WHERE id=? AND user_id=?")
    .run(secret.slice(0, 15) + '…', encryptSecret(secret), Number(id), userId);
  return { row: getOwned(userId, id), secret };
}

function remove(userId, id) {
  const r = db.prepare('DELETE FROM api_webhooks WHERE id=? AND user_id=?').run(Number(id), userId);
  if (!r.changes) fail(404, 'webhook_not_found', 'That webhook does not exist on your account.');
  return true;
}

function categoryMatches(row, category) {
  const categories = normalizeCategories(parseJsonList(row.categories, []));
  if (!categories.length || !category) return true;
  return categories.some((c) => c.toLowerCase() === String(category).trim().toLowerCase());
}

function eventMatches(row, type, category) {
  const events = normalizeEvents(parseJsonList(row.events, DEFAULT_EVENTS));
  // Category filters are for the broadcast "new public listing" stream. An
  // owner must still receive approval/rejection/update/claim events for their
  // own record even when they also use a category filter for discovery.
  const categoryAllowed = type === 'listing.created' ? categoryMatches(row, category) : true;
  return (events.includes(type) || events.includes('*')) && categoryAllowed;
}

function eventPayload(type, data = {}) {
  return JSON.stringify({
    id: `evt_${crypto.randomBytes(16).toString('hex')}`,
    type,
    api_version: 'v1',
    created_at: new Date().toISOString(),
    data,
  });
}

function listingData(row) {
  if (!row) return null;
  try { return require('./apilistings').apiSerialize(row); } catch { return { id: row.id, slug: row.slug, name: row.name, category: row.category, status: row.status }; }
}

function queueFor(row, type, payload) {
  const event = JSON.parse(payload);
  try {
    const info = db.prepare(`INSERT OR IGNORE INTO api_webhook_deliveries
      (webhook_id, event_id, event_type, payload, status, next_attempt_at)
      VALUES (?,?,?,?, 'pending', datetime('now'))`).run(row.id, event.id, type, payload);
    if (info.changes) scheduleDelivery(info.lastInsertRowid);
  } catch (e) {
    console.error('[webhooks] queue failure:', e && e.message);
  }
}

/**
 * Queue a signed event for the owner or, when targetUserId is omitted, for
 * every active subscriber whose event/category filters match. Passing null is
 * intentional and means "no owner" — it must never become a broadcast.
 */
function dispatch(type, { listing = null, targetUserId = undefined, data = {} } = {}) {
  if (!EVENTS.includes(type)) return 0;
  const category = listing && listing.category ? listing.category : '';
  const rows = targetUserId === undefined
    ? db.prepare("SELECT * FROM api_webhooks WHERE active=1").all()
    : db.prepare("SELECT * FROM api_webhooks WHERE active=1 AND user_id=?").all(targetUserId);
  const body = {
    ...data,
    ...(listing ? { listing: listingData(listing) } : {}),
  };
  const payload = eventPayload(type, body);
  let queued = 0;
  for (const row of rows) {
    if (!eventMatches(row, type, category)) continue;
    queueFor(row, type, payload);
    queued += 1;
  }
  return queued;
}

function test(userId, id) {
  const row = getOwned(userId, id);
  const payload = eventPayload('webhook.test', {
    webhook: { id: row.id, label: row.label, url: row.url },
    message: 'This is a test delivery from FirmLedger. No ledger record was changed.',
  });
  queueFor(row, 'webhook.test', payload);
  return db.prepare('SELECT * FROM api_webhook_deliveries WHERE webhook_id=? ORDER BY id DESC LIMIT 1').get(row.id);
}

function listDeliveries(userId, webhookId, limit = 50) {
  getOwned(userId, webhookId);
  return db.prepare(`SELECT id, webhook_id, event_id, event_type, status, attempts,
      next_attempt_at, response_status, response_body, error, delivered_at, created_at, updated_at
      FROM api_webhook_deliveries WHERE webhook_id=? ORDER BY id DESC LIMIT ?`).all(Number(webhookId), Math.min(100, Math.max(1, Number(limit) || 50)));
}

function retryDelivery(userId, webhookId, deliveryId) {
  getOwned(userId, webhookId);
  const r = db.prepare(`UPDATE api_webhook_deliveries SET status='pending', attempts=0, next_attempt_at=datetime('now'), error='', updated_at=datetime('now')
    WHERE id=? AND webhook_id=? AND status IN ('failed','pending')`).run(Number(deliveryId), Number(webhookId));
  if (!r.changes) fail(404, 'delivery_not_found', 'That delivery is not available to retry.');
  scheduleDelivery(Number(deliveryId));
  return true;
}

function publicAddressAllowed(addresses) {
  return addresses.length > 0 && addresses.every((a) => !isPrivateIp(a.address));
}

async function assertPublicDestination(url) {
  const parsed = new URL(url);
  if (isPrivateIp(parsed.hostname)) fail(422, 'private_url', 'Webhook destination resolved to a private network address.');
  const addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  if (!publicAddressAllowed(addresses)) fail(422, 'private_url', 'Webhook destination resolved to a private network address.');
}

function retryableStatus(status) { return status === 408 || status === 425 || status === 429 || status >= 500; }

async function sendDelivery(row, webhook) {
  const secret = decryptSecret(webhook.secret_ciphertext);
  if (!secret) throw new Error('Webhook secret cannot be decrypted; rotate the webhook secret.');
  await assertPublicDestination(webhook.url);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${row.payload}`).digest('hex');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const response = await fetch(webhook.url, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'FirmLedger-Webhooks/1.0',
        'x-firmledger-event': row.event_type,
        'x-firmledger-delivery': row.event_id,
        'x-firmledger-timestamp': timestamp,
        'x-firmledger-signature': `v1=${signature}`,
        'x-idempotency-key': row.event_id,
      },
      body: row.payload,
    });
    const text = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
    return { ok: response.status >= 200 && response.status < 300, status: response.status, body: text, retryable: retryableStatus(response.status) };
  } finally {
    clearTimeout(timeout);
  }
}

async function deliver(deliveryId) {
  if (queue.has(deliveryId)) return;
  queue.add(deliveryId);
  try {
    const claimed = db.prepare(`UPDATE api_webhook_deliveries SET status='sending', attempts=attempts+1, updated_at=datetime('now')
      WHERE id=? AND status='pending' AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime('now'))`).run(deliveryId);
    if (!claimed.changes) return;
    const row = db.prepare('SELECT * FROM api_webhook_deliveries WHERE id=?').get(deliveryId);
    const webhook = db.prepare('SELECT * FROM api_webhooks WHERE id=?').get(row.webhook_id);
    if (!webhook || (!webhook.active && row.event_type !== 'webhook.test')) {
      db.prepare("UPDATE api_webhook_deliveries SET status='failed', error='Webhook is inactive.', updated_at=datetime('now') WHERE id=?").run(deliveryId);
      return;
    }
    let result;
    try { result = await sendDelivery(row, webhook); }
    catch (e) { result = { ok: false, status: 0, body: '', retryable: true, error: e && e.message ? e.message : 'Delivery failed.' }; }
    const attempt = Number(row.attempts || 1);
    const error = result.error || (result.ok ? '' : `Endpoint returned HTTP ${result.status || 0}.`);
    db.prepare("UPDATE api_webhooks SET last_delivery_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(webhook.id);
    if (result.ok) {
      db.prepare(`UPDATE api_webhook_deliveries SET status='succeeded', response_status=?, response_body=?, error='', delivered_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
        .run(result.status, result.body || '', deliveryId);
      db.prepare("UPDATE api_webhooks SET failure_count=0, last_error='', last_success_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
        .run(webhook.id);
    } else if (result.retryable && attempt < MAX_ATTEMPTS) {
      const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      db.prepare(`UPDATE api_webhook_deliveries SET status='pending', response_status=?, response_body=?, error=?, next_attempt_at=datetime('now', '+' || ? || ' seconds'), updated_at=datetime('now') WHERE id=?`)
        .run(result.status || 0, result.body || '', error.slice(0, MAX_RESPONSE_CHARS), Math.ceil(delay / 1000), deliveryId);
    } else {
      db.prepare(`UPDATE api_webhook_deliveries SET status='failed', response_status=?, response_body=?, error=?, updated_at=datetime('now') WHERE id=?`)
        .run(result.status || 0, result.body || '', error.slice(0, MAX_RESPONSE_CHARS), deliveryId);
      db.prepare(`UPDATE api_webhooks SET failure_count=failure_count+1, last_error=?, active=CASE WHEN failure_count+1 >= ? THEN 0 ELSE active END,
        disabled_at=CASE WHEN failure_count+1 >= ? THEN datetime('now') ELSE disabled_at END, updated_at=datetime('now') WHERE id=?`)
        .run(error.slice(0, 500), MAX_ACTIVE_FAILURES, MAX_ACTIVE_FAILURES, webhook.id);
    }
  } finally {
    queue.delete(deliveryId);
  }
}

function scheduleDelivery(id) {
  setImmediate(() => deliver(Number(id)).catch((e) => console.error('[webhooks] delivery worker:', e && e.message)));
}

function drain() {
  const rows = db.prepare(`SELECT id FROM api_webhook_deliveries
    WHERE status='pending' AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime('now'))
    ORDER BY id ASC LIMIT 20`).all();
  rows.forEach((r) => scheduleDelivery(r.id));
}

// Restart-safe queue drain. The timer is unref'd so it never keeps a CLI/test
// process alive on its own.
setImmediate(drain);
setInterval(drain, 30_000).unref();

module.exports = {
  EVENTS, DEFAULT_EVENTS, MAX_WEBHOOKS_PER_USER, WebhookServiceError,
  normalizeEvents, normalizeCategories, validateWebhookUrl,
  serialize, getOwned, list, create, update, rotateSecret, remove,
  dispatch, test, listDeliveries, retryDelivery, drain, deliver,
};
