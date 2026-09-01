/**
 * Groq chat completions client (OpenAI-compatible HTTP API).
 * Server-side only — the API key never reaches the browser.
 *
 * Resolution order for the key:
 *   1. GROQ_API_KEY environment variable (always wins)
 *   2. Admin → AI Playground saved key (settings.groq_api_key)
 *
 * Default model is llama-3.3-70b-versatile (current Groq production).
 * llama3-70b-8192 / mixtral-8x7b-32768 remain selectable for operators
 * whose accounts still have those ids enabled.
 */
const { getSetting } = require('../db');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const MODELS = [
  { id: 'openai/gpt-oss-20b', label: 'OpenAI GPT-OSS 20B' },
  { id: 'openai/gpt-oss-120b', label: 'OpenAI GPT-OSS 120B' },
  { id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B' },
  { id: 'qwen/qwen3.6-27b', label: 'Qwen 3.6 27B' },
  { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (legacy)' },
  { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant (legacy)' },
  { id: 'llama3-70b-8192', label: 'Llama 3 70B 8k (legacy)' },
  { id: 'mixtral-8x7b-32768', label: 'Mixtral 8×7B (legacy)' },
];

const FALLBACKS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

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

function modelId() {
  const wanted = String(getSetting('groq_model', '') || '').trim();
  if (MODELS.some((m) => m.id === wanted)) return wanted;
  return MODELS[0].id;
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

async function postOnce(payload, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  let res;
  try {
    res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new GroqError('Groq timed out after 45 seconds. Try again.', { status: 504, code: 'timeout' });
    }
    throw new GroqError('Could not reach Groq: ' + (e.message || 'network error'), { status: 502, code: 'network' });
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }

  if (res.status === 401 || res.status === 403) {
    throw new GroqError('Groq rejected the API key. Check GROQ_API_KEY or the key saved in AI Playground settings.', {
      status: 401, code: 'invalid_key',
    });
  }
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after')) || 8;
    const err = new GroqError('Groq is rate-limiting this key. Retry shortly.', {
      status: 429, code: 'groq_rate', retryAfterSec: retry,
    });
    err.retryAfterSec = retry;
    throw err;
  }
  if (!res.ok) {
    const msg = (data.error && data.error.message) || data.message || `Groq HTTP ${res.status}`;
    const err = new GroqError(msg, { status: 502, code: 'groq_http' });
    err.httpStatus = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function isMissingModel(err) {
  const msg = String(err && err.message || '').toLowerCase();
  return /decommission|does not exist|model_not_found|not found|unknown model|invalid model/.test(msg);
}

/**
 * Chat completion. `opts` mirrors the Groq/OpenAI chat payload
 * (messages, tools, tool_choice, response_format, temperature, max_tokens).
 */
async function chat(opts = {}) {
  const key = groqKey();
  if (!key) {
    throw new GroqError('Groq is not configured. Set GROQ_API_KEY in .env or paste a key in Admin → AI Playground.', {
      status: 503, code: 'not_configured',
    });
  }
  chargeLocal();

  const primary = opts.model || modelId();
  const tried = [];
  const chain = [primary, ...FALLBACKS.filter((m) => m !== primary)];

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
    if (opts.tools) payload.tools = opts.tools;
    if (opts.tool_choice) payload.tool_choice = opts.tool_choice;
    if (opts.response_format) payload.response_format = opts.response_format;

    try {
      const data = await postOnce(payload, key);
      data._model = model;
      return data;
    } catch (e) {
      lastErr = e;
      if (e.code === 'groq_rate') {
        await sleep(Math.min(12_000, (e.retryAfterSec || 4) * 1000));
        try {
          const data = await postOnce(payload, key);
          data._model = model;
          return data;
        } catch (e2) { lastErr = e2; }
      }
      if (isMissingModel(e) && chain.indexOf(model) < chain.length - 1) {
        console.warn('[groq] model unavailable, falling back:', model, e.message);
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

module.exports = {
  MODELS, GroqError,
  groqKey, groqConfigured, groqKeySource, modelId,
  chat, assistantText, toolCalls,
};
