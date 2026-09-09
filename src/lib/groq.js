/**
 * Groq-compatible façade over the multi-provider model gateway.
 *
 * This module used to speak to Groq only. Every caller in the console
 * (assistant, listing generator, auto-moderation, the playground UI) imports
 * it, so rather than rewriting them it now forwards to `src/lib/llm.js` and
 * always resolves against the provider the admin selected in
 * Admin → AI Playground → Settings → Model providers — Groq by default.
 *
 * Every function keeps its original name and signature, so
 * `require('./groq').chat({ messages })` works exactly as before.
 */
const llm = require('./llm');

const active = () => llm.activeId();

module.exports = {
  /* Static data now follows the active provider. */
  get MODELS() { return llm.activeModels(); },
  get DEFAULT_MODEL() { return llm.provider(active()).defaultModel || ''; },
  get PROVIDERS() { return llm.PROVIDERS; },
  get GroqError() { return llm.LLMError; },
  LLMError: llm.LLMError,

  /* Endpoints / keys */
  baseUrl: () => llm.baseUrlFor(active()),
  chatUrl: () => llm.chatUrl(active()),
  modelsUrl: () => llm.modelsUrl(active()),
  groqKey: () => llm.apiKey(active()),
  groqConfigured: () => llm.configured(active()),
  groqKeySource: () => llm.keySource(active()),
  maskKey: llm.maskKey,

  /* Models */
  modelId: () => llm.modelFor(active()),
  modelMeta: (id) => llm.modelMeta(id, active()),
  isKnownModel: (id) => llm.isKnownModel(id, active()),
  isRetiredModel: (id) => llm.isRetiredModel(id, active()),
  supportsTools: (id) => llm.supportsTools(id, active()),
  supportsJson: (id) => llm.supportsJson(id, active()),
  usableModels: () => llm.usableModels(active()),
  liveModelIds: () => llm.liveModelIds(active()),
  liveSnapshot: () => llm.liveSnapshot(active()),
  markLiveModels: (ids) => llm.markLiveModels(active(), ids),
  fetchLiveModels: () => llm.fetchLiveModels(active()),
  syncModels: () => llm.syncModels(active()),
  syncAllProviders: (opts) => llm.syncAllProviders(opts),
  maybeSyncModels: () => llm.maybeSyncModels(active()),

  /* Calls */
  chat: (opts = {}) => llm.chat({ ...opts, provider: opts.provider || active() }),
  assistantText: llm.assistantText,
  toolCalls: llm.toolCalls,
  usage: llm.usage,
  testConnection: (model, pid) => llm.testConnection(pid || active(), model),

  /* The gateway itself, for callers that want a specific provider. */
  llm,
};
