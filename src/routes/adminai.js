/**
 * Admin AI Playground — listing generator, assistant, auto-moderation settings.
 * Mounted after session/CSRF. requireAdmin on every /admin3119Musa/* route.
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

function wantsJson(req) {
  const accept = String(req.headers.accept || '');
  const ct = String(req.headers['content-type'] || '');
  return accept.includes('application/json') || ct.includes('application/json') || req.xhr;
}

function jsonError(res, status, message, extra = {}) {
  return res.status(status).json({ ok: false, error: message, ...extra });
}

function handleAiError(req, res, e) {
  if (e instanceof groq.GroqError) {
    if (wantsJson(req)) return jsonError(res, e.status || 502, e.message, { code: e.code });
    return res.redirect('/admin3119Musa/ai?err=' + encodeURIComponent(e.message));
  }
  if (e instanceof svc.ApiServiceError) {
    const msg = e.message + (e.details && e.details.errors
      ? ' ' + e.details.errors.map((x) => x.field + ': ' + x.message).join('; ')
      : '');
    if (wantsJson(req)) return jsonError(res, e.status || 422, msg, { code: e.code, details: e.details });
    return res.redirect('/admin3119Musa/ai?err=' + encodeURIComponent(msg));
  }
  const status = e.status || 500;
  const msg = e.message || 'Unexpected error.';
  console.error('[admin-ai]', msg);
  if (wantsJson(req)) return jsonError(res, status, msg);
  return res.redirect('/admin3119Musa/ai?err=' + encodeURIComponent(msg));
}

router.get('/admin3119Musa/ai', (req, res) => {
  res.render('admin/ai', {
    meta: { title: 'AI Playground — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    section: 'ai',
    settings: ai.settingsSnapshot(),
    TYPES, SIZES, COUNTRIES,
    allCats: catLib.all(),
    moderationLog: ai.recentModeration(50),
    auditLog: ai.recentAudit(40),
    ok: req.query.ok || '',
    err: req.query.err || '',
  });
});

router.post('/admin3119Musa/ai/settings', (req, res) => {
  try {
    ai.saveSettings(req.body);
    return res.redirect('/admin3119Musa/ai?ok=' + encodeURIComponent('AI Playground settings saved.') + '#ai-settings');
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

router.post('/admin3119Musa/ai/generate-listing', async (req, res) => {
  try {
    const prompt = String((req.body && req.body.prompt) || '').trim();
    const { draft, model } = await ai.generateListing(prompt);
    return res.json({ ok: true, draft, model });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

router.post('/admin3119Musa/ai/publish-listing', async (req, res) => {
  try {
    const outcome = ai.publishListing(req.body || {});
    const data = outcome.body && outcome.body.data;
    return res.status(outcome.status || 201).json({
      ok: true,
      via: outcome.via,
      listing: data,
      meta: outcome.body && outcome.body.meta,
    });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

router.post('/admin3119Musa/ai/chat', async (req, res) => {
  try {
    const result = await ai.chatTurn(req.body && req.body.messages);
    return res.json({ ok: true, ...result });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

router.post('/admin3119Musa/ai/execute', async (req, res) => {
  try {
    const id = String((req.body && req.body.pending_id) || '');
    const result = await ai.executePending(id);
    return res.json({ ok: true, ...result });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

router.post('/admin3119Musa/ai/cancel', async (req, res) => {
  try {
    const id = String((req.body && req.body.pending_id) || '');
    const result = await ai.cancelPending(id);
    return res.json({ ok: true, ...result });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

/* Chat session management */
router.post('/admin3119Musa/ai/chat/sessions', async (req, res) => {
  try {
    const userId = req.session && req.session.userId ? Number(req.session.userId) : 0;
    const includeArchived = req.query.include_archived === '1' || req.body.include_archived === '1';
    const sessions = ai.getChatSessions(userId, includeArchived);
    return res.json({ ok: true, sessions });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

router.post('/admin3119Musa/ai/chat/session/create', async (req, res) => {
  try {
    const userId = req.session && req.session.userId ? Number(req.session.userId) : 0;
    const title = String((req.body && req.body.title) || '').slice(0, 200) || 'New Chat';
    const model = String((req.body && req.body.model) || '').slice(0, 100) || groq.modelId();
    const session = ai.createChatSession(userId, title, model);
    return res.json({ ok: true, session });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

router.post('/admin3119Musa/ai/chat/session/:id/messages', async (req, res) => {
  try {
    const sessionId = Number(req.params.id);
    const limit = Number(req.query.limit) || 100;
    const messages = ai.getChatMessages(sessionId, limit);
    return res.json({ ok: true, messages });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

router.post('/admin3119Musa/ai/chat/session/:id/delete', async (req, res) => {
  try {
    const sessionId = Number(req.params.id);
    const userId = req.session && req.session.userId ? Number(req.session.userId) : 0;
    const session = ai.getChatSession(sessionId);
    if (session && session.user_id === userId) {
      ai.deleteChatSession(sessionId);
      return res.json({ ok: true, deleted: true });
    }
    throw new Error('Session not found or not authorized.');
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

router.post('/admin3119Musa/ai/chat/session/:id/archive', async (req, res) => {
  try {
    const sessionId = Number(req.params.id);
    const userId = req.session && req.session.userId ? Number(req.session.userId) : 0;
    const session = ai.getChatSession(sessionId);
    if (session && session.user_id === userId) {
      ai.archiveChatSession(sessionId);
      return res.json({ ok: true, archived: true });
    }
    throw new Error('Session not found or not authorized.');
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

router.post('/admin3119Musa/ai/chat/session/:id/unarchive', async (req, res) => {
  try {
    const sessionId = Number(req.params.id);
    const userId = req.session && req.session.userId ? Number(req.session.userId) : 0;
    const session = ai.getChatSession(sessionId);
    if (session && session.user_id === userId) {
      ai.unarchiveChatSession(sessionId);
      return res.json({ ok: true, unarchived: true });
    }
    throw new Error('Session not found or not authorized.');
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

router.post('/admin3119Musa/ai/chat/session/:id/activate', async (req, res) => {
  try {
    const sessionId = Number(req.params.id);
    const userId = req.session && req.session.userId ? Number(req.session.userId) : 0;
    const session = ai.setActiveSession(sessionId);
    if (session && session.user_id === userId) {
      return res.json({ ok: true, session });
    }
    throw new Error('Session not found or not authorized.');
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

router.post('/admin3119Musa/ai/chat/purge-old', async (req, res) => {
  try {
    const days = Number(req.query.days) || 30;
    ai.purgeOldArchivedChats(days);
    return res.json({ ok: true, purged: true });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

/* Audit and moderation log deletion */
router.post('/admin3119Musa/ai/audit/:id/delete', async (req, res) => {
  try {
    const id = Number(req.params.id);
    ai.deleteAuditLogEntry(id);
    return res.json({ ok: true, deleted: true });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

router.post('/admin3119Musa/ai/moderation/:id/delete', async (req, res) => {
  try {
    const id = Number(req.params.id);
    ai.deleteModerationLogEntry(id);
    return res.json({ ok: true, deleted: true });
  } catch (e) {
    return handleAiError(req, res, e);
  }
});

module.exports = router;
