/**
 * FirmLedger REST API — v1.
 *
 * Mounted at /api/v1 BEFORE the session CSRF guard: API clients authenticate
 * with a key, not cookies, so CSRF does not apply.
 *
 * Every endpoint requires a FirmLedger Pro API key (Authorization: Bearer).
 * There are NO public read endpoints — the directory is as closed as the
 * rest, so key-less probes receive 401 (the status monitor sends a key).
 *
 *   GET    /api/v1                     → index (discovery)
 *   GET    /api/v1/health              → liveness (authenticated)
 *   GET    /api/v1/me                  → account, plan, limits, usage
 *   GET    /api/v1/listings            → directory (approved, filters & pagination)
 *   POST   /api/v1/listings            → create (201, owner only)
 *   GET    /api/v1/listings/:slug      → full company profile by slug
 *   PUT    /api/v1/listings/:id        → update (owner only)
 *   DELETE /api/v1/listings/:id        → delete (204)
 *   GET    /api/v1/my/listings         → your listings (paginated)
 *   POST   /api/v1/my/listings         → create (owner only)
 *   GET    /api/v1/my/listings/:id     → one listing (owner only)
 *   GET    /api/v1/search              → global search
 *   GET    /api/v1/categories          → category list
 *   GET    /api/v1/countries           → country list
 *   GET    /api/v1/suggest             → autocomplete
 *   GET    /api/v1/relationships/:slug → company relationship graph
 *   GET    /api/v1/verify/domain/:domain → check if a domain is listed
 *   GET    /api/v1/export/listings.csv → bulk export (Pro)
 *
 * Access is a FirmLedger Pro feature: every key resolves to a user with an
 * active Pro plan, otherwise 403 { error.code = "pro_required" }.
 */
const express = require('express');
const crypto = require('crypto');
const apikeys = require('../lib/apikeys');
const lim = require('../lib/apilimit');
const svc = require('../lib/apilistings');
const { hasProAccess } = require('../lib/plans');
const { siteUrl } = require('../lib/util');

const router = express.Router();

const DocsURL = () => siteUrl('/api/docs');

/* ---------- JSON body parsing (API-local, strict) ---------- */
router.use(express.json({ limit: '100kb' }));
router.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return lim.apiError(res, 400, 'invalid_json', 'The request body is not valid JSON. Check quotes and trailing commas.');
  }
  if (err && err.type === 'entity.too.large') {
    return lim.apiError(res, 413, 'payload_too_large', 'Request bodies are limited to 100 KB.');
  }
  next(err);
});

/* ---------- request id (echoed for support/debugging) ---------- */
router.use((req, res, next) => {
  req.requestId = 'req_' + crypto.randomBytes(8).toString('hex');
  res.set('X-Request-Id', req.requestId);
  next();
});

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
}

/* ---------- API key authentication ---------- */
function extractKey(req) {
  const h = String(req.headers.authorization || '');
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  return '';
}

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const ip = clientIp(req);

  // Brute-force guard: this IP burned too many bad keys recently.
  const lock = lim.ipLocked(ip);
  if (lock.locked) {
    return lim.apiError(res, 429, 'ip_locked', 'Too many invalid API keys from this network address. Locked out temporarily — see Retry-After.', { retryAfterSec: lock.retryAfterSec });
  }

  const raw = extractKey(req);
  if (!raw) {
    return lim.apiError(res, 401, 'missing_key', `No API key provided. Send it as "Authorization: Bearer fl_live_…". Keys are created by Pro members at ${siteUrl('/dashboard/api')}.`, { details: { docs: DocsURL() } });
  }

  if (!apikeys.isWellFormed(raw)) {
    const after = lim.registerFail(ip);
    return lim.apiError(res, 401, 'invalid_key', 'That does not look like a FirmLedger API key (expected fl_live_ + 32 characters).', { retryAfterSec: after.locked ? after.retryAfterSec : 0 });
  }

  const hit = apikeys.lookup(raw);
  if (!hit) {
    const after = lim.registerFail(ip);
    return lim.apiError(res, 401, 'invalid_key', 'API key not recognised. It may have been regenerated — create a fresh one in your dashboard.', { retryAfterSec: after.locked ? after.retryAfterSec : 0 });
  }
  if (hit.key.revoked_at) {
    return lim.apiError(res, 401, 'key_revoked', 'This API key has been revoked. Create a new key in your dashboard.');
  }
  if (!hit.user || hit.user.suspended) {
    return lim.apiError(res, 403, 'account_suspended', 'The account behind this API key is suspended. Contact support.');
  }
  if (!hasProAccess(hit.user)) {
    return lim.apiError(res, 403, 'pro_required', `API access is a FirmLedger Pro feature. Renew or upgrade at ${siteUrl('/pricing')} — your key works again the moment Pro is active.`, { details: { upgrade_url: siteUrl('/pricing') } });
  }

  lim.clearFails(ip);
  req.apiKey = hit.key;
  req.apiUser = hit.user;
  next();
});

/* ---------- rate limiting + concurrency gate ---------- */
router.use((req, res, next) => {
  const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  const bucketName = 'k' + req.apiKey.id;

  if (!lim.acquireSlot(bucketName)) {
    return lim.apiError(res, 429, 'too_many_concurrent', `Maximum ${lim.MAX_INFLIGHT} requests in flight per key. Wait for one to finish — your results are identical.`, { retryAfterSec: 1 });
  }
  let slotReleased = false;
  const releaseSlotOnce = () => { if (slotReleased) return; slotReleased = true; lim.releaseSlot(bucketName); };
  res.on('finish', releaseSlotOnce);
  res.on('close', releaseSlotOnce);

  if (isWrite && !lim.chargeGlobalWrite({ commit: false }).ok) {
    const g = lim.chargeGlobalWrite({ commit: false });
    return lim.apiError(res, 429, 'global_write_limit', 'The API is receiving unusual write volume right now. Retry shortly — reads are unaffected.', { retryAfterSec: g.resetInSec });
  }

  const c = lim.charge(bucketName, isWrite);
  if (!c.ok) {
    lim.rateHeaders(res, c, isWrite);
    return lim.apiError(res, 429, 'rate_limited', `${isWrite ? 'Write' : 'Read'} rate limit hit — ${c.limit} requests per 60 seconds per key. Back off and retry; the limit is per rolling minute, not per day.`, { retryAfterSec: c.resetInSec });
  }
  if (isWrite) lim.chargeGlobalWrite();
  lim.rateHeaders(res, c, isWrite);
  apikeys.recordUsage(req.apiKey.id, isWrite);
  next();
});

/* ---------- JSON helper ---------- */
function deliver(res, result, req) {
  if (result.status === 204) return res.status(204).end();
  if (result.status === 201 && result.body && result.body.data) {
    res.set('Location', `/api/v1/my/listings/${result.body.data.id}`);
  }
  return res.status(result.status).json(result.body);
}

function serviceError(res, e) {
  if (e instanceof svc.ApiServiceError) {
    return lim.apiError(res, e.status, e.code, e.message, { details: e.details });
  }
  throw e;
}

/* ---------- liveness (authenticated) ---------- */
router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'FirmLedger API', version: 'v1', time: new Date().toISOString() });
});

/* ---------- discovery ---------- */
router.get('/', (req, res) => {
  res.json({
    name: 'FirmLedger API', version: 'v1',
    docs: DocsURL(),
    endpoints: {
      health: 'GET /api/v1/health',
      me: 'GET /api/v1/me',
      directory: 'GET /api/v1/listings',
      directory_alias: ['GET /api/v1/directory', 'GET /api/v1/directory/:slug'],
      profile: 'GET /api/v1/listings/:slug',
      create: 'POST /api/v1/listings',
      update: 'PUT /api/v1/listings/:id',
      remove: 'DELETE /api/v1/listings/:id',
      mine: ['GET /api/v1/my/listings', 'POST /api/v1/my/listings', 'GET /api/v1/my/listings/:id'],
      search: 'GET /api/v1/search',
      categories: 'GET /api/v1/categories',
      countries: 'GET /api/v1/countries',
      suggest: 'GET /api/v1/suggest',
      relationships: 'GET /api/v1/relationships/:slug',
      verify: 'GET /api/v1/verify/domain/:domain',
      export: 'GET /api/v1/export/listings.csv',
    },
    limits: { read_requests_per_minute: lim.READ_RPM, write_requests_per_minute: lim.WRITE_RPM, max_concurrent_per_key: lim.MAX_INFLIGHT, max_keys_per_account: apikeys.MAX_ACTIVE_KEYS },
    note: 'API access is a FirmLedger Pro feature. Every endpoint needs a key — there is no public endpoint, including /health.',
  });
});

/* ---------- me ---------- */
router.get('/me', (req, res) => {
  const usage = apikeys.usageSummary(req.apiUser.id);
  res.json({
    data: {
      id: req.apiUser.id,
      email: req.apiUser.email,
      name: req.apiUser.name,
      plan: 'pro',
      plan_expires_at: req.apiUser.plan_expires_at || null,
      api: {
        key_prefix: req.apiKey.prefix,
        active_keys: apikeys.activeKeyCount(req.apiUser.id),
        max_keys: apikeys.MAX_ACTIVE_KEYS,
        limits: {
          read_requests_per_minute: lim.READ_RPM,
          write_requests_per_minute: lim.WRITE_RPM,
          max_concurrent_per_key: lim.MAX_INFLIGHT,
        },
        usage,
      },
    },
  });
});

/* ---------- directory (approved, filters & pagination) ---------- */
router.get('/listings', (req, res) => {
  try { res.json(svc.directory(req.query)); }
  catch (e) { serviceError(res, e); }
});

/* ---------- full company profile by slug ---------- */
router.get('/listings/:slug', (req, res) => {
  try {
    const row = svc.profileBySlug(req.params.slug);
    if (!row) return lim.apiError(res, 404, 'not_found', 'No approved public listing with that slug.');
    res.json({ data: row });
  } catch (e) { serviceError(res, e); }
});

/* ---------- create (owner only) ---------- */
router.post('/listings', (req, res) => {
  try { deliver(res, svc.createListing(req.apiUser, req.body), req); }
  catch (e) { serviceError(res, e); }
});

/* ---------- update / delete (owner only, by id) ---------- */
router.put('/listings/:id', (req, res) => {
  try { deliver(res, svc.updateListing(req.apiUser, req.params.id, req.body), req); }
  catch (e) { serviceError(res, e); }
});

router.delete('/listings/:id', (req, res) => {
  try { deliver(res, svc.deleteListing(req.apiUser, req.params.id), req); }
  catch (e) { serviceError(res, e); }
});

/* ---------- legacy read aliases (key-gated, /listings is canonical) ---------- */
router.get('/directory', (req, res) => {
  try { res.json(svc.directory(req.query)); }
  catch (e) { serviceError(res, e); }
});
router.get('/directory/:slug', (req, res) => {
  try {
    const row = svc.profileBySlug(req.params.slug);
    if (!row) return lim.apiError(res, 404, 'not_found', 'No approved public listing with that slug.');
    res.json({ data: row });
  } catch (e) { serviceError(res, e); }
});

/* ---------- my listings (owner CRUD) ---------- */
router.get('/my/listings', (req, res) => {
  try { res.json(svc.listMine(req.apiUser, req.query)); }
  catch (e) { serviceError(res, e); }
});

router.post('/my/listings', (req, res) => {
  try { deliver(res, svc.createListing(req.apiUser, req.body), req); }
  catch (e) { serviceError(res, e); }
});

router.get('/my/listings/:id', (req, res) => {
  try { res.json({ data: svc.serialize(svc.getOwned(req.apiUser, req.params.id)) }); }
  catch (e) { serviceError(res, e); }
});

/* ---------- global search ---------- */
router.get('/search', (req, res) => {
  try { res.json(svc.search(req.query)); }
  catch (e) { serviceError(res, e); }
});

/* ---------- category list ---------- */
router.get('/categories', (req, res) => {
  try { res.json(svc.categories()); }
  catch (e) { serviceError(res, e); }
});

/* ---------- country list ---------- */
router.get('/countries', (req, res) => {
  try { res.json(svc.countries()); }
  catch (e) { serviceError(res, e); }
});

/* ---------- autocomplete ---------- */
router.get('/suggest', (req, res) => {
  try { res.json(svc.suggest(req.query)); }
  catch (e) { serviceError(res, e); }
});

/* ---------- company relationship graph ---------- */
router.get('/relationships/:slug', (req, res) => {
  try {
    const g = svc.relationships(req.params.slug);
    if (!g) return lim.apiError(res, 404, 'not_found', 'No approved public listing with that slug.');
    res.json({ data: g });
  } catch (e) { serviceError(res, e); }
});

/* ---------- verify a domain is listed ---------- */
router.get('/verify/domain/:domain', (req, res) => {
  try { res.json(svc.verifyDomain(req.params.domain)); }
  catch (e) { serviceError(res, e); }
});

/* ---------- bulk export (Pro) ---------- */
router.get('/export/listings.csv', (req, res) => {
  try {
    const csv = svc.exportCsv(req.query);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="firmledger-listings-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (e) { serviceError(res, e); }
});

/* ---------- JSON 404 for anything else under /api/v1 ---------- */
router.use((req, res) => {
  lim.apiError(res, 404, 'unknown_endpoint', `No ${req.method} endpoint at this path. The v1 surface is documented at ${DocsURL()}.`, { details: { docs: DocsURL() } });
});

module.exports = router;
