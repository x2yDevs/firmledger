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
 *   GET    /api/v1/health              → real system status (same data as /status)
 *   GET    /api/v1/me                  → account, scopes, limits, usage
 *   GET    /api/v1/usage               → durable monthly + endpoint usage analytics
 *   GET    /api/v1/listings            → directory (approved, filters & pagination)
 *   POST   /api/v1/listings            → create (201, owner only)
 *   GET    /api/v1/listings/:slug      → full company profile by slug
 *   PUT    /api/v1/listings/:id        → update (owner only)
 *   DELETE /api/v1/listings/:id        → delete (204)
 *   GET    /api/v1/my/listings         → your listings (paginated)
 *   POST   /api/v1/my/listings         → create (owner only)
 *   GET    /api/v1/my/listings/:id     → one listing (owner only)
 *   GET    /api/v1/categories          → category list
 *   GET    /api/v1/countries           → country list
 *   GET    /api/v1/suggest             → autocomplete
 *   GET    /api/v1/verify/domain/:domain → check if a domain is listed
 *   GET    /api/v1/export/listings.csv → bulk export (Pro)
 *   GET/POST/PATCH/DELETE /api/v1/webhooks → signed event subscriptions
 *
 * Access is a FirmLedger Pro feature: every key resolves to a user with an
 * active Pro plan, otherwise 403 { error.code = "pro_required" }. Keys can be
 * narrowed with read:listings, write:listings, export,
 * manage:webhooks and read:usage scopes.
 */
const express = require('express');
const crypto = require('crypto');
const apikeys = require('../lib/apikeys');
const lim = require('../lib/apilimit');
const svc = require('../lib/apilistings');
const webhooks = require('../lib/webhooks');
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

/* ---------- scope enforcement ---------- */
function requiredScope(req) {
  const path = String(req.path || '').replace(/\/$/, '') || '/';
  const method = req.method.toUpperCase();
  if (path === '/me' || path === '/usage') return 'read:usage';
  if (path === '/webhooks' || path.startsWith('/webhooks/')) return 'manage:webhooks';
  if (path === '/export/listings.csv') return 'export';
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
      && (/^\/listings(?:\/|$)/.test(path) || /^\/my\/listings(?:\/|$)/.test(path))) return 'write:listings';
  if (method === 'GET' && (/^\/(?:listings|directory|my\/listings)(?:\/|$)/.test(path)
      || ['/categories', '/countries', '/suggest'].includes(path)
      || path.startsWith('/verify/domain/'))) return 'read:listings';
  return null;
}

router.use((req, res, next) => {
  const scope = requiredScope(req);
  if (!scope || apikeys.hasScope(req.apiKey, scope)) return next();
  res.set('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${scope}"`);
  return lim.apiError(res, 403, 'insufficient_scope', `This API key does not include the ${scope} scope. Update its scopes in the FirmLedger API console or use a key with the required access.`, {
    details: { required_scope: scope, scopes: apikeys.parseScopes(req.apiKey), docs: DocsURL() },
  });
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
  apikeys.recordUsage(req.apiKey.id, isWrite, apikeys.usageEndpoint(req.method, req.path));
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
  if (e instanceof svc.ApiServiceError || e instanceof webhooks.WebhookServiceError) {
    return lim.apiError(res, e.status, e.code, e.message, { details: e.details });
  }
  throw e;
}

/* ---------- health (authenticated) ----------
   This is the machine-readable face of the public /status page. It is a normal
   keyed v1 endpoint like every other one — same auth, same scopes, same rate
   limits — but the payload is the *real* monitor state, not a hardcoded ok:true.
   Both surfaces read the identical snapshot, so /api/v1/health and /status can
   never disagree: same components, same live probe evidence, same uptime
   percentages and the same open incidents. */
router.get('/health', (req, res) => {
  const mon = require('../lib/statusMonitor');
  const snap = mon.snapshot();
  const degraded = snap.status !== 'operational';
  res.json({
    ok: !degraded,
    service: 'FirmLedger API',
    version: 'v1',
    time: new Date().toISOString(),
    status: snap.status,
    status_label: snap.status_label,
    last_checked: snap.last_checked || null,
    last_run_at: snap.last_run_at || null,
    components: snap.components.map((c) => ({
      name: c.name,
      slug: c.slug,
      status: c.status,
      status_label: c.status_label,
      last_note: c.last_note || '',
      last_latency_ms: c.last_latency_ms || 0,
      last_checked_at: c.last_checked_at || '',
      uptime: c.uptime,
    })),
    uptime: snap.uptime,
    active_incidents: snap.active_incidents.map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      severity: i.severity,
      component: i.component_name || null,
      source: i.source || 'manual',
      created_at: i.created_at,
    })),
    status_page: siteUrl('/status'),
  });
});

/* ---------- discovery ---------- */
router.get('/', (req, res) => {
  res.json({
    name: 'FirmLedger API', version: 'v1',
    docs: DocsURL(),
    endpoints: {
      health: 'GET /api/v1/health',
      me: 'GET /api/v1/me',
      usage: 'GET /api/v1/usage',
      directory: 'GET /api/v1/listings',
      directory_alias: ['GET /api/v1/directory', 'GET /api/v1/directory/:slug'],
      profile: 'GET /api/v1/listings/:slug',
      create: 'POST /api/v1/listings',
      update: 'PUT /api/v1/listings/:id',
      remove: 'DELETE /api/v1/listings/:id',
      mine: ['GET /api/v1/my/listings', 'POST /api/v1/my/listings', 'GET /api/v1/my/listings/:id'],
      categories: 'GET /api/v1/categories',
      countries: 'GET /api/v1/countries',
      suggest: 'GET /api/v1/suggest',
      verify: 'GET /api/v1/verify/domain/:domain',
      export: 'GET /api/v1/export/listings.csv',
      webhooks: {
        list: 'GET /api/v1/webhooks',
        create: 'POST /api/v1/webhooks',
        update: 'PATCH /api/v1/webhooks/:id',
        remove: 'DELETE /api/v1/webhooks/:id',
        test: 'POST /api/v1/webhooks/:id/test',
        deliveries: 'GET /api/v1/webhooks/:id/deliveries',
      },
    },
    scopes: apikeys.SCOPE_DEFINITIONS,
    webhook_events: webhooks.EVENTS,
    limits: { read_requests_per_minute: lim.READ_RPM, write_requests_per_minute: lim.WRITE_RPM, max_concurrent_per_key: lim.MAX_INFLIGHT, max_keys_per_account: apikeys.MAX_ACTIVE_KEYS, max_webhooks_per_account: webhooks.MAX_WEBHOOKS_PER_USER },
    note: 'API access is a FirmLedger Pro feature. Every endpoint needs a key — there is no public endpoint, including /health. Narrow keys with scopes and use webhooks for push notifications.',
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
        scopes: apikeys.parseScopes(req.apiKey),
        active_keys: apikeys.activeKeyCount(req.apiUser.id),
        max_keys: apikeys.MAX_ACTIVE_KEYS,
        limits: {
          read_requests_per_minute: lim.READ_RPM,
          write_requests_per_minute: lim.WRITE_RPM,
          max_concurrent_per_key: lim.MAX_INFLIGHT,
          current_key: {
            read: lim.snapshot('k' + req.apiKey.id, false),
            write: lim.snapshot('k' + req.apiKey.id, true),
          },
        },
        usage,
      },
    },
  });
});

/* Durable usage data is intentionally separate from /me so a service can
   poll analytics without re-fetching account identity fields. */
router.get('/usage', (req, res) => {
  res.json({
    data: apikeys.usageSummary(req.apiUser.id),
    meta: {
      current_key: {
        prefix: req.apiKey.prefix,
        read: lim.snapshot('k' + req.apiKey.id, false),
        write: lim.snapshot('k' + req.apiKey.id, true),
      },
      period: 'current calendar month (UTC) plus trailing 31 days',
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
    const row = svc.profileBySlug(req.params.slug, req.query.fields);
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
    const row = svc.profileBySlug(req.params.slug, req.query.fields);
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
  try { res.json({ data: svc.projectFields(svc.serialize(svc.getOwned(req.apiUser, req.params.id)), req.query.fields) }); }
  catch (e) { serviceError(res, e); }
});

router.put('/my/listings/:id', (req, res) => {
  try { deliver(res, svc.updateListing(req.apiUser, req.params.id, req.body), req); }
  catch (e) { serviceError(res, e); }
});

router.delete('/my/listings/:id', (req, res) => {
  try { deliver(res, svc.deleteListing(req.apiUser, req.params.id), req); }
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

/* ---------- webhooks (push delivery, not polling) ---------- */
router.get('/webhooks', (req, res) => {
  try { res.json({ data: webhooks.list(req.apiUser.id), meta: { events: webhooks.EVENTS } }); }
  catch (e) { serviceError(res, e); }
});

router.post('/webhooks', (req, res) => {
  try {
    const created = webhooks.create(req.apiUser.id, req.body && typeof req.body === 'object' ? req.body : {});
    const data = webhooks.serialize(created.row);
    res.status(201).json({ data: { ...data, secret: created.secret }, meta: { secret_once: true, note: 'Store this secret now. Rotate it to receive a new one; FirmLedger cannot display it again.' } });
  } catch (e) { serviceError(res, e); }
});

router.get('/webhooks/:id', (req, res) => {
  try { res.json({ data: webhooks.serialize(webhooks.getOwned(req.apiUser.id, req.params.id)) }); }
  catch (e) { serviceError(res, e); }
});

function updateWebhookRoute(req, res) {
  try { res.json({ data: webhooks.serialize(webhooks.update(req.apiUser.id, req.params.id, req.body && typeof req.body === 'object' ? req.body : {})) }); }
  catch (e) { serviceError(res, e); }
}
router.patch('/webhooks/:id', updateWebhookRoute);
router.put('/webhooks/:id', updateWebhookRoute);

router.post('/webhooks/:id/rotate-secret', (req, res) => {
  try {
    const rotated = webhooks.rotateSecret(req.apiUser.id, req.params.id);
    res.json({ data: { ...webhooks.serialize(rotated.row), secret: rotated.secret }, meta: { secret_once: true, note: 'The previous signing secret is invalid immediately.' } });
  } catch (e) { serviceError(res, e); }
});

router.post('/webhooks/:id/test', (req, res) => {
  try {
    const delivery = webhooks.test(req.apiUser.id, req.params.id);
    res.status(202).json({ data: { delivery_id: delivery.id, event: 'webhook.test', status: 'pending' }, meta: { note: 'The test is queued and will be delivered in the background.' } });
  } catch (e) { serviceError(res, e); }
});

router.get('/webhooks/:id/deliveries', (req, res) => {
  try {
    const rows = webhooks.listDeliveries(req.apiUser.id, req.params.id, req.query.limit);
    res.json({ data: rows, meta: { total: rows.length } });
  } catch (e) { serviceError(res, e); }
});

router.post('/webhooks/:id/deliveries/:deliveryId/retry', (req, res) => {
  try {
    webhooks.retryDelivery(req.apiUser.id, req.params.id, req.params.deliveryId);
    res.status(202).json({ data: { delivery_id: Number(req.params.deliveryId), status: 'pending' } });
  } catch (e) { serviceError(res, e); }
});

router.delete('/webhooks/:id', (req, res) => {
  try { webhooks.remove(req.apiUser.id, req.params.id); res.status(204).end(); }
  catch (e) { serviceError(res, e); }
});

/* ---------- JSON 404 for anything else under /api/v1 ---------- */
router.use((req, res) => {
  lim.apiError(res, 404, 'unknown_endpoint', `No ${req.method} endpoint at this path. The v1 surface is documented at ${DocsURL()}.`, { details: { docs: DocsURL() } });
});

module.exports = router;
