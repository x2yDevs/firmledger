/**
 * Admin AI Playground — listing generator, admin assistant, auto-moderation settings.
 * Mounted after session/CSRF. requireAdmin on every /admin3119Musa/* route.
 *
 * Contract for the console UI (all JSON endpoints answer the same envelope):
 *   ok:true  + payload            success
 *   ok:false + error (+code)      anything the operator should read
 * Session-scoped routes always re-check ownership, so a guessed chat id from a
 * second operator can never read or mutate someone else's transcript.
 */
const express = require('express');
const { requireAdmin } = require('../lib/session');
const { TYPES, SIZES, COUNTRIES } = require('../lib/taxonomy');
const catLib = require('../lib/categories');
const groq = require('../lib/groq');
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

/*
 * Admin sessions are cookie-only (sessions.kind='admin', user_id NULL), so every
 * console operator shares one identity — owner 0. The id is still threaded through
 * every chat route so transcripts stay scoped per owner if the console ever grows
 * named admins.
 */
function adminUserId() {
  return 0;
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
  const userId = adminUserId();
  const settings = ai.settingsSnapshot(userId);
  const requested = Number(req.query.session) || 0;
  let openSession = null;
  if (requested) {
    try {
      openSession = ai.getChatSessionForUser(requested, userId);
      ai.setActiveSession(openSession.id, userId);
    } catch { openSession = null; }
  } else {
    openSession = ai.activeChatSession(userId);
    if (openSession && openSession.archived) openSession = null;
  }

  const rail = ai.listChatSessions(userId, { limit: 80, includeArchived: req.query.archived === 'all' });
  const transcriptLimit = Math.max(20, Math.min(300, Number(req.query.limit) || 120));
  const transcript = openSession
    ? ai.sessionTranscript(openSession.id, { limit: transcriptLimit })
    : { messages: [], has_more: false, oldest_id: 0 };

  res.render('admin/ai', {
    meta: { title: 'AI Playground — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    section: 'ai',
    settings,
    TYPES, SIZES, COUNTRIES,
    allCats: catLib.all(),
    openSession,
    messages: transcript.messages,
    hasMoreMessages: transcript.has_more,
    oldestMessageId: transcript.oldest_id,
    transcriptLimit: transcriptLimit,
    chatSessions: rail.sessions,
    chatTotal: rail.total,
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

/** Verify the key + refresh which models this key can actually call. */
router.post(`${BASE}/test`, json(async (req, res) => {
  const model = str(req.body && req.body.model, 100);
  const result = await groq.testConnection(model);
  try {
    ai.audit({
      kind: 'settings',
      action: 'test',
      payload: { model: model || groq.modelId() },
      result: result.ok ? `ok${result.used_model ? ` · ${result.used_model}` : ''}` : result.error,
      ok: result.ok ? 1 : 0,
    });
  } catch { /* audit is best-effort */ }
  return res.json({
    ok: true,
    test: result,
    settings: ai.settingsSnapshot(adminUserId()),
  });
}));

router.get(`${BASE}/models`, (req, res) => {
  res.json({
    ok: true,
    models: groq.usableModels(),
    selected: groq.modelId(),
    moderation_model: ai.moderationModelId(),
    default: groq.DEFAULT_MODEL,
    live_checked_at: groq.liveSnapshot().checked_at,
    live_models: groq.liveSnapshot().ids,
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
  const userId = adminUserId();
  const text = str(req.body && req.body.text);
  const sessionId = Number(req.body && req.body.session_id) || 0;
  const model = str(req.body && req.body.model, 100);
  if (!text && !(req.body && Array.isArray(req.body.messages) && req.body.messages.length)) {
    return jsonError(res, 422, 'Type a message first.');
  }
  const session = sessionId
    ? ai.getChatSessionForUser(sessionId, userId)
    : ai.ensureChatSession(userId, { model });

  const result = await ai.chatTurn(req.body && req.body.messages, {
    text,
    model,
    session_id: session ? session.id : 0,
    userId,
  });
  const fresh = session ? ai.getChatSession(session.id) : null;
  return res.json({
    ok: true,
    ...result,
    session: fresh || null,
    history_open: Boolean(fresh),
  });
}));

router.post(`${BASE}/execute`, json(async (req, res) => {
  const id = str(req.body && req.body.pending_id, 80);
  const result = await ai.executePending(id, {
    session_id: Number(req.body && req.body.session_id) || 0,
    userId: adminUserId(),
  });
  return res.json({ ok: true, ...result });
}));

router.post(`${BASE}/cancel`, json(async (req, res) => {
  const id = str(req.body && req.body.pending_id, 80);
  const result = await ai.cancelPending(id, {
    session_id: Number(req.body && req.body.session_id) || 0,
    userId: adminUserId(),
  });
  return res.json({ ok: true, ...result });
}));

/* ---------------- Chat history rail ---------------- */

router.get(`${BASE}/chat/sessions`, (req, res) => {
  try {
    const userId = adminUserId();
    const archived = str(req.query.archived, 8);
    const page = ai.listChatSessions(userId, {
      includeArchived: archived === 'all',
      archivedOnly: archived === '1' || archived === 'only',
      q: str(req.query.q, 60),
      limit: Number(req.query.limit) || 80,
      offset: Number(req.query.offset) || 0,
    });
    return res.json({ ok: true, ...page, counts: ai.countChatSessions(userId) });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

/** POST kept alongside the REST verb so a stale tab still works after deploy. */
function createSessionHandler(req, res) {
  try {
    const userId = adminUserId();
    const session = ai.createChatSession(
      userId,
      str(req.body && req.body.title, 120) || 'New chat',
      str(req.body && req.body.model, 100),
    );
    return res.json({ ok: true, session, counts: ai.countChatSessions(userId) });
  } catch (e) {
    return handleAiError(req, res, e);
  }
}
router.post(`${BASE}/chat/sessions`, createSessionHandler);
router.post(`${BASE}/chat/session/create`, createSessionHandler);

router.get(`${BASE}/chat/sessions/:id`, (req, res) => {
  try {
    const userId = adminUserId();
    const session = ai.getChatSessionForUser(req.params.id, userId);
    const page = ai.sessionTranscript(session.id, {
      limit: Number(req.query.limit) || 120,
      before: Number(req.query.before) || 0,
    });
    return res.json({ ok: true, session, ...page, counts: ai.countChatSessions(userId) });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

router.get(`${BASE}/chat/session/:id/messages`, (req, res) => {
  try {
    const userId = adminUserId();
    const session = ai.getChatSessionForUser(req.params.id, userId);
    const page = ai.sessionTranscript(session.id, {
      limit: Number(req.query.limit) || 120,
      before: Number(req.query.before) || 0,
    });
    return res.json({ ok: true, session, ...page });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

function sessionAction(action) {
  return (req, res) => {
    try {
      const userId = adminUserId();
      const session = ai.getChatSessionForUser(req.params.id, userId);
      let out = {};
      if (action === 'activate') out = { session: ai.setActiveSession(session.id, userId) };
      else if (action === 'archive') out = ai.archiveChatSession(session.id);
      else if (action === 'unarchive') out = ai.unarchiveChatSession(session.id);
      else if (action === 'clear') out = ai.clearChatMessages(session.id);
      else if (action === 'rename') out = { session: ai.renameChatSession(session.id, str(req.body && req.body.title, 120)) };
      else if (action === 'model') out = { session: ai.setChatSessionModel(session.id, str(req.body && req.body.model, 100)) };
      else if (action === 'delete') out = ai.deleteChatSession(session.id);
      return res.json({ ok: true, ...out, counts: ai.countChatSessions(userId) });
    } catch (e) {
      return handleAiError(req, res, e);
    }
  };
}

['activate', 'archive', 'unarchive', 'clear', 'rename', 'model'].forEach((action) => {
  router.post(`${BASE}/chat/sessions/:id/${action}`, sessionAction(action));
  router.post(`${BASE}/chat/session/:id/${action}`, sessionAction(action));
});
router.post(`${BASE}/chat/sessions/:id/delete`, sessionAction('delete'));
router.delete(`${BASE}/chat/sessions/:id`, sessionAction('delete'));

router.post(`${BASE}/chat/purge-archived`, (req, res) => {
  try {
    const userId = adminUserId();
    const days = Number(req.body && req.body.days) || Number(req.query.days) || 30;
    const out = ai.purgeArchivedChats(userId, days);
    return res.json({ ok: true, ...out, counts: ai.countChatSessions(userId) });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

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
