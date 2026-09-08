/**
 * Admin AI Playground — providers, listing generator, admin assistant,
 * auto-moderation settings, logs.
 * Mounted after session/CSRF. requireAdmin on every /admin3119Musa/* route.
 *
 * Contract for the console UI (all JSON endpoints answer the same envelope):
 *   ok:true  + payload            success
 *   ok:false + error (+code)      anything the operator should read
 * The admin assistant is stateless: it only uses the messages visible in the
 * current tab. Chat history was removed entirely — nothing is stored, listed,
 * reopened or restored.
 *
 * Model calls go through src/lib/llm.js, so every endpoint here works with
 * whichever provider the admin connected. API keys are write-only: they are
 * accepted on a POST, stored server-side, and only ever returned masked.
 */
const express = require('express');
const { requireAdmin } = require('../lib/session');
const { TYPES, SIZES, COUNTRIES } = require('../lib/taxonomy');
const catLib = require('../lib/categories');
const groq = require('../lib/groq');
const llm = require('../lib/llm');
const ai = require('../lib/ai');
const sitecontext = require('../lib/sitecontext');
const tools = require('../lib/aitools');
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
  if (e instanceof llm.LlmError) {
    if (wantsJson(req)) return jsonError(res, e.status || 502, e.message, { code: e.code, provider: e.provider });
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
    const back = str(req.body && req.body.back, 200) || `${BASE}?tab=set`;
    const target = back.startsWith('/admin3119Musa') ? back : `${BASE}?tab=set`;
    return res.redirect(target + (target.includes('?') ? '&' : '?') + 'ok=' + encodeURIComponent('AI Playground settings saved.') + '#ai-settings');
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

/* ---------------- Providers ---------------- */

/** Everything the Providers panel needs — keys are reported masked or absent. */
router.get(`${BASE}/providers`, (req, res) => {
  try {
    return res.json({ ok: true, ...ai.providerSnapshot(), tool_stats: tools.stats() });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

/** Verify one provider: key, live model list, one tiny completion. */
router.post(`${BASE}/test`, json(async (req, res) => {
  const provider = str(req.body && (req.body.provider || req.body.provider_id), 40);
  const model = str(req.body && req.body.model, 160);
  const result = await ai.testProvider(provider, model);
  return res.json({
    ok: true,
    test: result,
    provider: result.provider || provider || llm.activeProviderId(),
    settings: ai.settingsSnapshot(),
  });
}));

/** Switch the live backend ("Use this provider"). */
router.post(`${BASE}/provider`, json(async (req, res) => {
  const provider = str(req.body && (req.body.provider || req.body.provider_id), 40);
  const model = str(req.body && req.body.model, 160);
  const used = ai.useProvider(provider, model);
  return res.json({ ok: true, ...used, settings: ai.settingsSnapshot() });
}));

/** Save one provider's key / model / base URL without a full form post. */
router.post(`${BASE}/provider/save`, json(async (req, res) => {
  const pid = str(req.body && (req.body.provider || req.body.provider_id), 40).toLowerCase();
  if (!llm.isProviderId(pid)) return jsonError(res, 422, `“${pid}” is not a supported provider.`);
  const body = {};
  const key = req.body && req.body.api_key;
  if (key !== undefined) body[`${pid}_api_key`] = key;
  if (String((req.body || {}).clear_key || '') === '1') body[`${pid}_api_key_clear`] = '1';
  if ((req.body || {}).model !== undefined) body[`${pid}_model`] = req.body.model;
  if ((req.body || {}).base_url !== undefined) body[`${pid}_base_url`] = req.body.base_url;
  if ((req.body || {}).extra_models !== undefined) body[`${pid}_extra_models`] = req.body.extra_models;
  if ((req.body || {}).make_active) body.ai_provider = pid;
  ai.saveSettings(body);
  return res.json({ ok: true, provider: pid, settings: ai.settingsSnapshot() });
}));

/** Model list for one provider (curated + whatever its key can really call). */
router.get(`${BASE}/models`, (req, res) => {
  try {
    const pid = str(req.query.provider, 40).toLowerCase() || llm.activeProviderId();
    if (!llm.isProviderId(pid)) return jsonError(res, 422, `“${pid}” is not a supported provider.`);
    return res.json({
      ok: true,
      provider: pid,
      models: llm.usableModels(pid),
      selected: llm.savedModel(pid),
      default: (llm.provider(pid) || {}).defaultModel || '',
      moderation_model: ai.moderationModelId(),
      moderation_choices: ai.moderationModelChoices(),
      active_provider: llm.activeProviderId(),
      legacy_default: groq.DEFAULT_MODEL,
      live_checked_at: llm.liveSnapshot(pid).checked_at,
      live_models: llm.liveSnapshot(pid).ids,
      tool_stats: tools.stats(),
    });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

/** Ask a provider for its live model list and remember it. */
router.post(`${BASE}/models/sync`, json(async (req, res) => {
  const pid = str(req.body && (req.body.provider || req.body.provider_id), 40).toLowerCase() || llm.activeProviderId();
  const r = await llm.syncModels(pid);
  ai.audit({ kind: 'settings', action: 'sync_models', payload: { provider: pid, count: r.count } });
  return res.json({ ok: true, ...r, settings: ai.settingsSnapshot() });
}));

/** What the assistant is told about the site — so the operator can read it too. */
router.get(`${BASE}/site-context`, (req, res) => {
  try {
    const topic = str(req.query.topic, 30);
    if (topic) return res.json({ ok: true, ...sitecontext.topic(topic) });
    return res.json({
      ok: true,
      briefing: sitecontext.context({ compact: req.query.full !== '1', fresh: true }),
      topics: sitecontext.TOPICS,
      system_prompt_chars: ai.assistantSystemPrompt().length,
      tools: tools.stats(),
    });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

/* ---------------- Listing generator ---------------- */

router.post(`${BASE}/generate-listing`, json(async (req, res) => {
  const prompt = str(req.body && req.body.prompt);
  const model = str(req.body && req.body.model, 160);
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
  const model = str(req.body && req.body.model, 160);
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
