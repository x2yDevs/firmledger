/**
 * Groq chat completions client (OpenAI-compatible HTTP API).
 * Server-side only — the API key never reaches the browser.
 *
 * Resolution order for the key:
 *   1. GROQ_API_KEY environment variable (always wins)
 *   2. Admin → AI Playground saved key (settings.groq_api_key)
 *
 * The model registry below is kept to ids that Groq actually serves today.
 * Groq retired `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` for free /
 * developer-tier keys on 16 Aug 2026, and removed `llama3-70b-8192`,
 * `llama3-8b-8192` (30 Aug 2025) and `mixtral-8x7b-32768` entirely — they are
 * gone from this list so the console cannot be pointed at a dead id.
 * `syncModels()` asks the live /models endpoint, which is what powers
 * Admin → AI Playground → “Check key & sync models”.
 */
const { getSetting, setSetting } = require('../db');

const DEFAULT_BASE = 'https://api.groq.com/openai/v1';
const LIVE_TTL_MS = 6 * 60 * 60 * 1000; // re-check availability twice a day at most

/* OpenAI-compatible base URL. Override only for a proxy/gateway you control;
   the key still comes from GROQ_API_KEY / the saved setting. */
function baseUrl() {
  const raw = String(process.env.GROQ_BASE_URL || DEFAULT_BASE).trim().replace(/\/+$/, '');
  return raw || DEFAULT_BASE;
}
function chatUrl() { return `${baseUrl()}/chat/completions`; }
function modelsUrl() { return `${baseUrl()}/models`; }

/**
 * tier: 'production' | 'preview' | 'legacy'
 * tools: supports OpenAI-style function calling (required by the admin assistant)
 * json:  supports response_format { type: 'json_object' } (listing generator + moderation)
 */
const MODELS = [
  {
    id: 'openai/gpt-oss-120b', label: 'OpenAI GPT-OSS 120B', tier: 'production',
    note: 'Flagship — best tool-calling accuracy. Default for the assistant.',
    tools: true, json: true, vision: false, context: 131072, maxOutput: 65536, tps: 500,
  },
  {
    id: 'openai/gpt-oss-20b', label: 'OpenAI GPT-OSS 20B', tier: 'production',
    note: 'Fastest production option. Good for bulk drafting.',
    tools: true, json: true, vision: false, context: 131072, maxOutput: 65536, tps: 1000,
  },
  {
    id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B', tier: 'preview',
    note: 'Preview — strong agentic/tool use, JSON schema mode.',
    tools: true, json: true, vision: true, context: 131042, maxOutput: 16384, tps: 450,
  },
  {
    id: 'qwen/qwen3.6-27b', label: 'Qwen 3.6 27B', tier: 'preview',
    note: 'Preview — cheaper than 3.8, same tool support.',
    tools: true, json: true, vision: true, context: 131072, maxOutput: 16384, tps: 500,
  },
  {
    id: 'openai/gpt-oss-safeguard-20b', label: 'GPT-OSS Safeguard 20B', tier: 'preview',
    note: 'Trust & safety tuned — the best fit for listing auto-moderation.',
    tools: true, json: true, vision: false, context: 131072, maxOutput: 65536, tps: 1000,
  },
  {
    id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (legacy)', tier: 'legacy',
    note: 'Retired for developer keys on 16 Aug 2026 — enterprise contracts only.',
    tools: true, json: true, vision: false, context: 131072, maxOutput: 32768, tps: 280,
  },
  {
    id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant (legacy)', tier: 'legacy',
    note: 'Retired for developer keys on 16 Aug 2026 — enterprise contracts only.',
    tools: true, json: true, vision: false, context: 131072, maxOutput: 131072, tps: 560,
  },
];

const DEFAULT_MODEL = 'openai/gpt-oss-120b';
/* Order matters: current production ids first, preview second. Legacy ids are
   deliberately absent — an unavailable id costs a round trip before the retry. */
const FALLBACKS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'qwen/qwen3.6-27b'];

function groqKey() {
  const env = String(process.env.GROQ_API_KEY || '').trim();
  if (env) return env;
  return String(getSetting('groq_api_key', '') || '').trim();
}

function groqConfigured() {
  return Boolean(groqKey());
}

function groqKeySource() {
  if (String(process.env.GROQ_API_KEY || '').trim()) return 'env';
  if (String(getSetting('groq_api_key', '') || '').trim()) return 'settings';
  return '';
}

function maskKey(key) {
  const k = String(key || '');
  if (k.length <= 10) return k ? `${k.slice(0, 4)}…` : '';
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

function isKnownModel(id) {
  return MODELS.some((m) => m.id === String(id || '').trim());
}

function modelMeta(id) {
  const wanted = String(id || '').trim();
  return MODELS.find((m) => m.id === wanted) || null;
}

function modelId() {
  const wanted = String(getSetting('groq_model', '') || '').trim();
  if (MODELS.some((m) => m.id === wanted)) return wanted;
  return DEFAULT_MODEL;
}

function supportsTools(id) {
  const meta = modelMeta(id);
  return meta ? Boolean(meta.tools) : false;
}

function supportsJson(id) {
  const meta = modelMeta(id);
  return meta ? Boolean(meta.json) : false;
}

/* ---------------- live availability (what this key can actually call) ---------------- */

function liveSnapshot() {
  let ids = [];
  let checked = '';
  try { ids = JSON.parse(getSetting('groq_live_models', '[]') || '[]'); } catch { ids = []; }
  try { checked = String(getSetting('groq_live_checked_at', '') || ''); } catch { checked = ''; }
  if (!Array.isArray(ids)) ids = [];
  return { ids: ids.map(String), checked_at: checked };
}

function liveAgeMs() {
  const { checked_at } = liveSnapshot();
  const t = Date.parse(checked_at ? `${checked_at.replace(' ', 'T')}Z` : '');
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}

function liveModelIds() {
  return liveSnapshot().ids;
}

/** MODELS decorated with what this key can reach, so the UI can grey out dead ids. */
function usableModels() {
  const { ids, checked_at } = liveSnapshot();
  const live = new Set(ids);
  return MODELS.map((m) => ({
    ...m,
    /* null = never checked / no data; true/false = the verdict of the last sync. */
    available: ids.length ? live.has(m.id) : null,
  })).map((m) => ({ ...m, checked_at: checked_at || '' }));
}

function markLiveModels(ids) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x).trim()).filter(Boolean))];
  setSetting('groq_live_models', JSON.stringify(clean).slice(0, 20000));
  setSetting('groq_live_checked_at', new Date().toISOString().replace('T', ' ').slice(0, 19));
  return clean;
}

class GroqError extends Error {
  constructor(message, { status = 502, code = 'groq_error', retryAfterSec = 0 } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

/* Process-wide rolling window so a stuck tab cannot burn the Groq quota. */
const recentCalls = [];
function chargeLocal() {
  const now = Date.now();
  while (recentCalls.length && now - recentCalls[0] > 60_000) recentCalls.shift();
  if (recentCalls.length >= 40) {
    throw new GroqError('Groq rate limit — wait a minute and try again.', {
      status: 429, code: 'rate_limited', retryAfterSec: 60,
    });
  }
  recentCalls.push(now);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function send(url, key, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new GroqError(`Groq timed out after ${Math.round(timeoutMs / 1000)} seconds. Try again.`, { status: 504, code: 'timeout' });
    }
    throw new GroqError('Could not reach Groq: ' + (e.message || 'network error'), { status: 502, code: 'network' });
  } finally {
    clearTimeout(timer);
  }
}

function describeHttpError(res, data) {
  const apiMsg = (data && data.error && (data.error.message || data.error.code)) || data?.message || '';
  if (res.status === 401 || res.status === 403) {
    return { message: 'Groq rejected the API key. Check GROQ_API_KEY or the key saved in AI Playground settings.', code: 'invalid_key', status: 401 };
  }
  if (res.status === 429) {
    return { message: 'Groq is rate-limiting this key. Retry shortly.', code: 'groq_rate', status: 429 };
  }
  if (res.status === 404 || /decommission|no longer available|does not exist|not found|unknown model|invalid model|model_not_found/i.test(String(apiMsg))) {
    return { message: apiMsg || 'That model is not available on this key.', code: 'model_unavailable', status: 502 };
  }
  if (/tool/i.test(String(apiMsg)) && /support|not.*(allow|enable)|unavailable/i.test(String(apiMsg))) {
    return { message: `${apiMsg} — switch the playground model to one with tool support (GPT-OSS 120B or 20B).`, code: 'tools_unsupported', status: 502 };
  }
  return { message: apiMsg || `Groq HTTP ${res.status}`, code: 'groq_http', status: 502 };
}

async function postOnce(payload, key) {
  const res = await send(chatUrl(), key, { method: 'POST', body: JSON.stringify(payload) }, 45_000);

  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }

  if (!res.ok) {
    const info = describeHttpError(res, data);
    const err = new GroqError(info.message, { status: info.status, code: info.code });
    err.httpStatus = res.status;
    err.body = data;
    if (res.status === 429) err.retryAfterSec = Number(res.headers.get('retry-after')) || 8;
    throw err;
  }
  return data;
}

/** GET {base}/models — the ids this key can call right now. */
async function fetchLiveModels() {
  const key = groqKey();
  if (!key) {
    throw new GroqError('Groq is not configured. Set GROQ_API_KEY in .env or paste a key in Admin → AI Playground.', {
      status: 503, code: 'not_configured',
    });
  }
  const res = await send(modelsUrl(), key, { method: 'GET' }, 15_000);
  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!res.ok) {
    const info = describeHttpError(res, data);
    throw new GroqError(info.message, { status: info.status, code: info.code });
  }
  const rows = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
  return rows.map((r) => String(typeof r === 'string' ? r : (r && (r.id || r.name)) || '')).filter(Boolean);
}

/** Ask Groq what this key can use and remember the answer for the UI. */
async function syncModels() {
  const ids = await fetchLiveModels();
  markLiveModels(ids);
  const set = new Set(ids);
  return {
    count: ids.length,
    selected_available: ids.includes(modelId()),
    missing: MODELS.filter((m) => !set.has(m.id)).map((m) => m.id),
  };
}

/** Background refresh at most every LIVE_TTL_MS — never blocks a request. */
function maybeSyncModels() {
  if (!groqConfigured()) return;
  if (liveAgeMs() < LIVE_TTL_MS) return;
  setImmediate(() => {
    syncModels().catch(() => { /* surfaced by the manual “Check key” button */ });
  });
}

/**
 * Chat completion. `opts` mirrors the Groq/OpenAI chat payload
 * (messages, tools, tool_choice, response_format, temperature, max_tokens, model).
 * opts.noFallback skips the retry chain (used by the connection test).
 */
async function chat(opts = {}) {
  const key = groqKey();
  if (!key) {
    throw new GroqError('Groq is not configured. Set GROQ_API_KEY in .env or paste a key in Admin → AI Playground.', {
      status: 503, code: 'not_configured',
    });
  }
  chargeLocal();
  maybeSyncModels();

  const requested = String(opts.model || '').trim();
  if (requested && !isKnownModel(requested)) {
    throw new GroqError(`“${requested.slice(0, 60)}” is not a model this console supports. Pick one in Settings → Groq.`, {
      status: 422, code: 'bad_model',
    });
  }
  const primary = requested || modelId();
  const tried = [];
  const chain = opts.noFallback ? [primary] : [primary, ...FALLBACKS.filter((m) => m !== primary)];
  const wantsTools = Boolean(opts.tools && opts.tools.length);

  let lastErr;
  for (const model of chain) {
    if (tried.includes(model)) continue;
    tried.push(model);
    const payload = {
      model,
      messages: opts.messages,
      temperature: opts.temperature == null ? 0.3 : opts.temperature,
      max_tokens: opts.max_tokens || 1800,
    };
    if (wantsTools) payload.tools = opts.tools;
    if (wantsTools && opts.tool_choice) payload.tool_choice = opts.tool_choice;
    /* A model without JSON mode just gets the same instruction in prose — the
       callers already tolerate markdown-fenced JSON. */
    if (opts.response_format && supportsJson(model)) payload.response_format = opts.response_format;

    try {
      const data = await postOnce(payload, key);
      data._model = model;
      return data;
    } catch (e) {
      lastErr = e;
      if (e.code === 'groq_rate' && chain.length) {
        await sleep(Math.min(12_000, (e.retryAfterSec || 4) * 1000));
        try {
          const data = await postOnce(payload, key);
          data._model = model;
          return data;
        } catch (e2) { lastErr = e2; }
      }
      const retryable = e.code === 'model_unavailable' || e.code === 'tools_unsupported';
      if (retryable && chain.indexOf(model) < chain.length - 1) {
        console.warn('[groq] model unusable, falling back:', model, e.message);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new GroqError('Groq request failed.');
}

function assistantText(data) {
  const choice = data && data.choices && data.choices[0];
  if (!choice) return '';
  return (choice.message && choice.message.content) || '';
}

function toolCalls(data) {
  const choice = data && data.choices && data.choices[0];
  const msg = choice && choice.message;
  return (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length) ? msg.tool_calls : [];
}

function usage(data) {
  const u = data && data.usage;
  if (!u) return null;
  return {
    prompt_tokens: Number(u.prompt_tokens) || 0,
    completion_tokens: Number(u.completion_tokens) || 0,
    total_tokens: Number(u.total_tokens) || 0,
  };
}

/** Cheap, side-effect-free probe used by “Check key & sync models”. */
async function testConnection(modelOverride) {
  const model = String(modelOverride || '').trim() || modelId();
  const key = groqKey();
  if (!key) {
    return {
      ok: false, key_source: '', model,
      error: 'No Groq key configured. Set GROQ_API_KEY in .env or paste one in Settings below.',
    };
  }
  const out = { ok: true, key_source: groqKeySource(), key_hint: maskKey(key), base: baseUrl(), model };
  try {
    const ids = await fetchLiveModels();
    markLiveModels(ids);
    out.models = ids;
    out.model_available = ids.includes(model);
  } catch (e) {
    out.list_error = e.message;
    if (e.code === 'invalid_key' || e.code === 'not_configured') {
      return { ...out, ok: false, error: e.message };
    }
  }
  try {
    const data = await chat({
      model, temperature: 0, max_tokens: 8, noFallback: true,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    });
    out.reply = assistantText(data).trim().slice(0, 40);
    out.used_model = data._model || model;
    out.usage = usage(data);
  } catch (e) {
    out.ok = false;
    out.error = e.message;
    out.error_code = e.code;
  }
  return out;
}

module.exports = {
  MODELS, GroqError, DEFAULT_MODEL,
  baseUrl, chatUrl, modelsUrl,
  groqKey, groqConfigured, groqKeySource, maskKey,
  modelId, modelMeta, isKnownModel, supportsTools, supportsJson,
  liveModelIds, liveSnapshot, usableModels, syncModels, maybeSyncModels, markLiveModels,
  fetchLiveModels, testConnection,
  chat, assistantText, toolCalls, usage,
};
