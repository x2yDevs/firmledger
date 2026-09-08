/**
 * Groq chat completions client — now a thin, fully backwards-compatible façade
 * over the multi-provider layer in `./llm.js`.
 *
 * Everything this module exported before still exists with the same shape and
 * the same meaning *for Groq*, so callers that were written when Groq was the
 * only backend keep working untouched. The difference: the calls now go to
 * whichever provider the admin selected in Admin → AI Playground → Providers
 * (Groq is still the default), and every export that describes "the models we
 * can use" describes the active provider's models.
 *
 * Resolution order for a key (per provider, see llm.js):
 *   1. environment variable — GROQ_API_KEY for Groq, OPENAI_API_KEY,
 *      ANTHROPIC_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, HF_TOKEN,
 *      OPENROUTER_API_KEY … for the others (always wins)
 *   2. the key saved in Admin → AI Playground (settings table)
 *
 * The model registry lives in llm.js: curated ids per provider, plus whatever
 * the provider's own live /models endpoint reports, plus any id the admin
 * typed in by hand. `syncModels()` powers "Check key & sync models".
 */
const llm = require('./llm');

const GroqError = llm.LlmError; // instanceof checks in routes keep working
const GROQ = 'groq';

/* The Groq catalogue, kept under its historical name. */
const MODELS = llm.catalogModels(GROQ).map((m) => { const { provider, ...rest } = m; return rest; });
const DEFAULT_MODEL = (llm.provider(GROQ) || {}).defaultModel || 'openai/gpt-oss-120b';
/* Order matters: current production ids first, preview second. Legacy ids are
   deliberately absent — an unavailable id costs a round trip before the retry.
   The real fallback chain (including other configured providers) lives in llm.js. */
const FALLBACKS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'qwen/qwen3.6-27b'];

/** The provider every "current" question is about. */
function activeId() { return llm.activeProviderId(); }

function baseUrl(providerId) { return llm.baseUrl(providerId || activeId()); }
function chatUrl(providerId) { return llm.endpointFor(providerId || activeId()) || llm.chatUrl(providerId || activeId()); }
function modelsUrl(providerId) { return llm.modelsUrl(providerId || activeId()); }

function groqKey() { return llm.apiKey(activeId()); }
function groqConfigured() { return llm.configured(activeId()); }
function groqKeySource() { return llm.keySource(activeId()); }
function maskKey(key) { return llm.maskKey(key); }

/** A model id is known if ANY configured provider serves it (or it is typed). */
function isKnownModel(id) { return llm.isKnownModel(id); }
function modelMeta(id) {
  const pid = llm.providerForModel(id) || activeId();
  const meta = llm.modelMeta(pid, llm.splitModelRef(id).model);
  if (!meta) return null;
  const { provider, ...rest } = meta;
  return { ...rest, provider: pid };
}

/** The model the console will use right now (active provider's saved model). */
function modelId() { return llm.activeModel(); }

function supportsTools(id) { return llm.supportsTools(id); }
function supportsJson(id) { return llm.supportsJson(id); }

/* ---------------- live availability (what this key can actually call) ---------------- */

function liveSnapshot(providerId) { return llm.liveSnapshot(providerId || activeId()); }
function liveModelIds(providerId) { return llm.liveSnapshot(providerId || activeId()).ids; }

/** Models of the active provider, decorated with availability for the UI. */
function usableModels(providerId) { return llm.usableModels(providerId || activeId()); }

function markLiveModels(ids, providerId) { return llm.markLiveModels(providerId || activeId(), ids); }

/** GET the provider's model list — the ids this key can call right now. */
function fetchLiveModels(providerId) { return llm.fetchLiveModels(providerId || activeId()); }

/** Ask the active provider what this key can use and remember it for the UI. */
async function syncModels(providerId) { return llm.syncModels(providerId || activeId()); }

/** Background refresh — never blocks a request. */
function maybeSyncModels(providerId) { llm.maybeSyncModels(providerId || activeId()); }

/**
 * Chat completion. `opts` mirrors the OpenAI chat payload (messages, tools,
 * tool_choice, response_format, temperature, max_tokens, model) and may carry
 * `provider` or a "provider:model" model ref to target one backend explicitly.
 * opts.noFallback skips the retry chain (used by the connection test).
 */
function chat(opts = {}) { return llm.chat(opts); }

function assistantText(data) { return llm.assistantText(data); }
function toolCalls(data) { return llm.toolCalls(data); }
function usage(data) { return llm.usage(data); }

/** Cheap, side-effect-free probe used by "Check key & sync models". */
function testConnection(modelOverride, providerId) {
  const ref = llm.splitModelRef(modelOverride);
  return llm.testConnection(providerId || ref.provider || activeId(), ref.model);
}

module.exports = {
  MODELS, GroqError, DEFAULT_MODEL, FALLBACKS,
  baseUrl, chatUrl, modelsUrl,
  groqKey, groqConfigured, groqKeySource, maskKey,
  modelId, modelMeta, isKnownModel, supportsTools, supportsJson,
  liveModelIds, liveSnapshot, usableModels, syncModels, maybeSyncModels, markLiveModels,
  fetchLiveModels, testConnection,
  chat, assistantText, toolCalls, usage,
  /* provider-aware extras (the playground UI uses these) */
  llm, activeProviderId: activeId, providerSnapshot: llm.providerSnapshot,
};
