/**
 * Admin AI Playground — listing generator, admin assistant, auto-moderation settings.
 * Mounted after session/CSRF. requireAdmin on every /admin3119Musa/* route.
 *
 * Contract for the console UI (all JSON endpoints answer the same envelope):
 *   ok:true  + payload            success
 *   ok:false + error (+code)      anything the operator should read
 * The admin assistant is stateless: it only uses the messages visible in the
 * current tab. Chat history was removed entirely — nothing is stored, listed,
 * reopened or restored.
 */
const express = require('express');
const { requireAdmin } = require('../lib/session');
const { TYPES, SIZES, COUNTRIES } = require('../lib/taxonomy');
const catLib = require('../lib/categories');
const groq = require('../lib/groq');
const llm = require('../lib/llm');
const ai = require('../lib/ai');
const svc = require('../lib/apilistings');

const router = express.Router();
router.use('/admin3119Musa', requireAdmin);

const BASE = '/admin3119Musa/ai';

function wantsJson(req) {
  const accept = String(req.headers.accept || '');
  const ct = String(req.headers['content-type'] || '');
  return accept.includes('application/json') || ct.includes('application/json') || req.xhr;
}

function jsonError(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, error: message, ...extra });
}

function str(v, max = 4000) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function handleAiError(req, res, e) {
  if (e instanceof groq.GroqError) {
    if (wantsJson(req)) return jsonError(res, e.status || 502, e.message, { code: e.code });
    return res.redirect(`${BASE}?err=` + encodeURIComponent(e.message));
  }
  if (e instanceof svc.ApiServiceError) {
    const msg = e.message + (e.details && e.details.errors
      ? ' ' + e.details.errors.map((x) => x.field + ': ' + x.message).join('; ')
      : '');
    if (wantsJson(req)) return jsonError(res, e.status || 422, msg, { code: e.code, details: e.details });
    return res.redirect(`${BASE}?err=` + encodeURIComponent(msg));
  }
  const status = e.status || 500;
  const msg = e.message || 'Unexpected error.';
  console.error('[admin-ai]', msg);
  if (wantsJson(req)) return jsonError(res, status, msg);
  return res.redirect(`${BASE}?err=` + encodeURIComponent(msg));
}

/** Wraps an async JSON handler so every throw lands in handleAiError. */
function json(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      handleAiError(req, res, e);
    }
  };
}

/* ---------------- Render ---------------- */

router.get(BASE, (req, res) => {
  // The admin assistant is intentionally stateless: no chat history, no saved
  // sessions, and no previous messages rendered back into the UI.
  res.render('admin/ai', {
    meta: { title: 'AI Playground — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    section: 'ai',
    settings: ai.settingsSnapshot(),
    TYPES, SIZES, COUNTRIES,
    allCats: catLib.all(),
    pendingSamples: ai.oldestPending(30),
    moderation: ai.logsPage('moderation', { limit: 50 }),
    auditLog: ai.logsPage('audit', { limit: 40 }),
    tab: ['gen', 'chat', 'set'].includes(req.query.tab) ? req.query.tab : 'gen',
    ok: str(req.query.ok, 300),
    err: str(req.query.err, 300),
  });
});

/* ---------------- Settings ---------------- */

router.post(`${BASE}/settings`, (req, res) => {
  try {
    ai.saveSettings(req.body);
    return res.redirect(`${BASE}?tab=set&ok=` + encodeURIComponent('AI Playground settings saved.') + '#ai-settings');
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

/**
 * Verify a provider: is the key accepted, which models can it call, and does a
 * tiny completion come back? `provider` defaults to the active one, so the
 * existing "Check key & sync models" button keeps working unchanged.
 */
router.post(`${BASE}/test`, json(async (req, res) => {
  const model = str(req.body && req.body.model, 160);
  const wanted = str(req.body && req.body.provider, 40);
  const providerId = wanted && llm.isValidProvider(wanted) ? wanted : llm.activeId();
  const result = await llm.testConnection(providerId, model);
  try {
    ai.audit({
      kind: 'settings',
      action: 'test',
      payload: { provider: providerId, model: model || llm.modelFor(providerId) },
      result: result.ok ? `ok${result.used_model ? ` · ${result.used_model}` : ''}` : result.error,
      ok: result.ok ? 1 : 0,
    });
  } catch { /* audit is best-effort */ }
  return res.json({
    ok: true,
    test: result,
    provider: providerId,
    providers: llm.providersView(),
    settings: ai.settingsSnapshot(),
  });
}));

/**
 * Refresh every configured provider's catalog in one go — new models appear
 * automatically and removed ones drop to unavailable. The hourly upkeep tick
 * does the same for stale catalogs, so this is the manual "sync now".
 */
router.post(`${BASE}/sync-all`, json(async (req, res) => {
  const fresh = String((req.body && req.body.fresh) || '') === '1';
  const results = await llm.syncAllProviders({ onlyStale: !fresh });
  const synced = results.filter((r) => !r.skipped && !r.error).length;
  const added = results.reduce((n, r) => n + ((r.added && r.added.length) || 0), 0);
  try {
    ai.audit({
      kind: 'settings',
      action: 'sync-all',
      payload: { results: results.map((r) => ({ provider: r.provider, count: r.count, skipped: r.skipped, error: r.error })) },
      result: `${synced} catalog(s) synced · ${added} new model(s) discovered`,
      ok: 1,
    });
  } catch { /* audit is best-effort */ }
  return res.json({
    ok: true,
    results,
    synced,
    added,
    providers: llm.providersView(),
    settings: ai.settingsSnapshot(),
  });
}));

/** Make one provider the one the whole console runs on. */
router.post(`${BASE}/provider`, json(async (req, res) => {
  const pid = str(req.body && req.body.provider, 40);
  if (!llm.isValidProvider(pid)) return jsonError(res, 422, `“${pid}” is not a provider this console knows.`);
  llm.setActiveProvider(pid);
  ai.audit({
    kind: 'settings',
    action: 'provider',
    payload: { provider: pid, model: llm.modelFor(pid) },
    result: `active provider → ${llm.provider(pid).label}`,
  });
  return res.json({ ok: true, provider: pid, providers: llm.providersView(), settings: ai.settingsSnapshot() });
}));

/** The whole provider catalogue — models, key state, live ids — for the console. */
router.get(`${BASE}/models`, (req, res) => {
  res.json({
    ok: true,
    /* Free-tier models only — matching what the playground UI offers. */
    models: groq.playgroundModels(),
    selected: groq.modelId(),
    moderation_model: ai.moderationModelId(),
    default: groq.DEFAULT_MODEL,
    live_checked_at: groq.liveSnapshot().checked_at,
    live_models: groq.liveSnapshot().ids,
    provider: llm.activeId(),
    providers: llm.providersView(),
  });
});

/* ---------------- Listing generator ---------------- */

router.post(`${BASE}/generate-listing`, json(async (req, res) => {
  const prompt = str(req.body && req.body.prompt);
  const model = str(req.body && req.body.model, 100);
  const { draft, model: used, usage } = await ai.generateListing(prompt, { model });
  return res.json({ ok: true, draft, model: used, usage });
}));

router.post(`${BASE}/publish-listing`, json(async (req, res) => {
  const outcome = ai.publishListing(req.body || {});
  const data = outcome.body && outcome.body.data;
  return res.status(outcome.status || 201).json({
    ok: true,
    via: outcome.via,
    listing: data,
    meta: outcome.body && outcome.body.meta,
  });
}));

/* ---------------- Assistant ---------------- */

router.post(`${BASE}/chat`, json(async (req, res) => {
  const text = str(req.body && req.body.text);
  const model = str(req.body && req.body.model, 100);
  const prior = req.body && Array.isArray(req.body.messages) ? req.body.messages : [];
  const messages = text ? [...prior, { role: 'user', content: text }] : prior;
  if (!messages.length) return jsonError(res, 422, 'Type a message first.');

  // Stateless by design: the assistant uses the current in-page context only.
  // No chat history is created or stored anywhere.
  const result = await ai.chatTurn(messages, { model });
  return res.json({ ok: true, ...result });
}));

router.post(`${BASE}/execute`, json(async (req, res) => {
  const id = str(req.body && req.body.pending_id, 80);
  const result = await ai.executePending(id);
  return res.json({ ok: true, ...result });
}));

router.post(`${BASE}/cancel`, json(async (req, res) => {
  const id = str(req.body && req.body.pending_id, 80);
  const result = await ai.cancelPending(id);
  return res.json({ ok: true, ...result });
}));

/* ---------------- Logs ---------------- */

router.get(`${BASE}/logs`, (req, res) => {
  try {
    const kind = str(req.query.kind, 20) || 'audit';
    const page = ai.logsPage(kind, {
      limit: Number(req.query.limit) || (kind === 'moderation' ? 50 : 40),
      offset: Number(req.query.offset) || 0,
      q: str(req.query.q, 60),
    });
    return res.json({ ok: true, ...page });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

function deleteLog(kind) {
  return (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return jsonError(res, 422, 'Missing log id.');
      const info = kind === 'moderation' ? ai.deleteModerationLogEntry(id) : ai.deleteAuditLogEntry(id);
      return res.json({ ok: true, deleted: info.changes > 0 });
    } catch (e) {
      return handleAiError(req, res, e);
    }
  };
}
router.post(`${BASE}/logs/audit/:id/delete`, deleteLog('audit'));
router.post(`${BASE}/logs/moderation/:id/delete`, deleteLog('moderation'));
router.post(`${BASE}/audit/:id/delete`, deleteLog('audit'));
router.post(`${BASE}/moderation/:id/delete`, deleteLog('moderation'));

/** Re-run AI moderation on one listing — used by the “Review one now” button. */
router.post(`${BASE}/moderate`, json(async (req, res) => {
  const id = Number(req.body && req.body.listing_id) || 0;
  if (!id) {
    const err = new Error('Pick a pending listing first.');
    err.status = 422;
    throw err;
  }
  const result = await ai.moderateListing(id);
  return res.json({ ok: true, result, moderation: ai.logsPage('moderation', { limit: 50 }) });
}));

module.exports = router;
