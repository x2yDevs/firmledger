/**
 * FirmLedger — multi-provider AI conformance test.
 *
 *   node tests/ai-providers.test.js
 *
 * Two halves, both real:
 *
 *  A. src/lib/llm.js in process. The provider registry, key precedence, model
 *     refs, per-protocol request building (OpenAI / Anthropic / Gemini), the
 *     normalised response shape, auth headers, live model lists, fallback and
 *     failover, the per-minute cap, and the backwards-compatible groq façade
 *     the rest of the app still requires. Every HTTP call is answered by a
 *     recording stub — no network, no real keys.
 *
 *  B. The admin console over HTTP. Boots the real server against a throwaway
 *     database plus a mock OpenAI-compatible endpoint, connects it as a
 *     "custom" provider through the same routes the browser uses, then proves
 *     the whole chain works end to end: a chat turn proposes a SENSITIVE
 *     action instead of running it, the operator's confirm executes it for
 *     real, and the database shows it. Also asserts no API key ever reaches a
 *     response body.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-providers-'));
process.env.FIRMLEDGER_DATA_DIR = tmp;
process.env.BASE_URL = process.env.BASE_URL || 'https://firmledger.test';
process.env.SMTP_URL = '';

const { db, getSetting, setSetting } = require('../src/db');
const llm = require('../src/lib/llm');
const groq = require('../src/lib/groq');
const ai = require('../src/lib/ai');
const tools = require('../src/lib/aitools');

/* ---------------------------------------------------------------- harness */
let passed = 0;
const failures = [];
function ok(name, cond, why) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push({ name, why: why || 'assertion failed' }); console.log(`  ✗ ${name} — ${why || ''}`); }
}
function section(t) { console.log(`\n${t}`); }
const one = (sql, ...p) => db.prepare(sql).get(...p);

/** Recording fetch stub: answers from a queue or a handler, logs every call. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async function stub(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const headers = (init && init.headers) || {};
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = init && init.body; }
    calls.push({ url, method: (init && init.method) || 'GET', headers, body });
    const out = await handler({ url, method: (init && init.method) || 'GET', headers, body, callIndex: calls.length - 1 });
    const status = out.status || 200;
    const text = typeof out.body === 'string' ? out.body : JSON.stringify(out.body == null ? {} : out.body);
    const map = new Map(Object.entries(out.headers || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
    return {
      ok: status >= 200 && status < 300,
      status,
      url,
      headers: { get: (k) => (map.has(String(k).toLowerCase()) ? map.get(String(k).toLowerCase()) : null) },
      text: async () => text,
    };
  };
  return calls;
}
const realFetch = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Put a key on a provider the way the console does, and take it off again. */
async function withKey(pid, key, fn) {
  const setting = llm.provider(pid).keySetting;
  const before = getSetting(setting, '');
  setSetting(setting, key);
  try { return await fn(); } finally { setSetting(setting, before); }
}

/**
 * Stop chat() from scheduling its twice-a-day background model refresh, so a
 * stubbed transport sees exactly the calls the test expects.
 */
function pinLiveLists() {
  for (const p of llm.PROVIDERS) llm.markLiveModels(p.id, []);
}

const OPENAI_REPLY = {
  id: 'chatcmpl-1', object: 'chat.completion', model: 'gpt-test',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from OpenAI.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
};
const TOOL_REPLY = {
  choices: [{
    index: 0, finish_reason: 'tool_calls',
    message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'delete_listing', arguments: JSON.stringify({ id_or_slug: 'beta-works' }) } }],
    },
  }],
  usage: { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 },
};
const ANTHROPIC_REPLY = {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', stop_reason: 'tool_use',
  content: [
    { type: 'text', text: 'Deleting that listing now.' },
    { type: 'tool_use', id: 'toolu_1', name: 'delete_listing', input: { id_or_slug: 'beta-works' } },
  ],
  usage: { input_tokens: 30, output_tokens: 12 },
};
const GEMINI_REPLY = {
  candidates: [{
    content: {
      role: 'model',
      parts: [
        { text: 'On it.' },
        { functionCall: { name: 'delete_listing', args: { id_or_slug: 'beta-works' } } },
      ],
    },
    finishReason: 'STOP',
  }],
  usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 15, totalTokenCount: 55 },
};

/* ====================================================================== */
/* A. the provider layer                                                   */
/* ====================================================================== */

section('Provider registry');
const EXPECTED = ['groq', 'openai', 'anthropic', 'gemini', 'deepseek', 'huggingface', 'openrouter',
  'mistral', 'xai', 'together', 'cerebras', 'fireworks', 'sambanova', 'perplexity', 'azure', 'custom'];
ok('every advertised provider is registered',
  EXPECTED.every((id) => llm.PROVIDER_IDS.includes(id)),
  'missing: ' + EXPECTED.filter((id) => !llm.PROVIDER_IDS.includes(id)).join(', '));
ok('all 16 providers are reachable by id', llm.PROVIDERS.length === 16, `got ${llm.PROVIDERS.length}`);
ok('each provider declares a protocol, key setting and label',
  llm.PROVIDERS.every((p) => ['openai', 'anthropic', 'gemini'].includes(p.protocol) && p.keySetting && p.label),
  'a provider is missing protocol/keySetting/label');
ok('each provider has an env key or is env-free by design',
  llm.PROVIDERS.every((p) => Array.isArray(p.envKeys)), 'envKeys must be an array');
ok('providers that need a base URL say so',
  llm.provider('azure').customBase === true && llm.provider('custom').customBase === true, 'azure/custom must accept a base URL');
ok('unknown provider ids are rejected', llm.isProviderId('skynet') === false && llm.isProviderId('groq') === true);
ok('curated models carry capability flags',
  llm.PROVIDERS.every((p) => (p.models || []).every((m) => m.id && m.label && typeof m.tools === 'boolean')),
  'a curated model is missing id/label/tools');

section('API keys: precedence, masking and configuration');
setSetting('groq_api_key', '');
delete process.env.GROQ_API_KEY;
ok('no key means not configured', llm.configured('groq') === false);
setSetting('groq_api_key', 'gsk_saved_key_1234567890');
ok('a saved key configures the provider', llm.configured('groq') === true);
ok('saved keys report their source', llm.keySource('groq') === 'settings', llm.keySource('groq'));
process.env.GROQ_API_KEY = 'gsk_env_key_abcdefghij';
ok('an environment key wins over the saved one', llm.apiKey('groq') === 'gsk_env_key_abcdefghij');
ok('env keys report their source', llm.keySource('groq') === 'env');
const mask = llm.maskKey('gsk_env_key_abcdefghij');
ok('the mask never shows the whole key',
  mask && !mask.includes('gsk_env_key_abcdefghij') && mask.length < 14, mask);
delete process.env.GROQ_API_KEY;
setSetting('groq_api_key', '');
ok('clearing the key de-configures the provider', llm.configured('groq') === false);

section('Base URLs and model selection');
ok('the curated default base URL is used', llm.baseUrl('groq') === 'https://api.groq.com/openai/v1', llm.baseUrl('groq'));
setSetting('ai_base_url_groq', 'https://gateway.internal/groq/v1');
ok('a saved base URL overrides the default', llm.baseUrl('groq') === 'https://gateway.internal/groq/v1');
ok('the chat endpoint follows the base URL', llm.chatUrl('groq') === 'https://gateway.internal/groq/v1/chat/completions');
setSetting('ai_base_url_groq', '');
process.env.GROQ_BASE_URL = 'https://env-gateway.test/v1';
ok('an env base URL overrides too', llm.baseUrl('groq') === 'https://env-gateway.test/v1');
delete process.env.GROQ_BASE_URL;
ok('anthropic posts to /messages', llm.endpointFor('anthropic') === 'https://api.anthropic.com/v1/messages', llm.endpointFor('anthropic'));
ok('azure refuses to guess a base URL', llm.baseUrl('azure') === '' && llm.configured('azure') === false);

setSetting('groq_api_key', 'gsk_saved_key_1234567890');
ok('a bare model ref keeps the active provider', JSON.stringify(llm.splitModelRef('llama-3.3-70b-versatile')) === JSON.stringify({ provider: '', model: 'llama-3.3-70b-versatile' }));
ok('a provider-prefixed ref names its backend', llm.splitModelRef('gemini:gemini-2.5-flash').provider === 'gemini'
  && llm.splitModelRef('gemini:gemini-2.5-flash').model === 'gemini-2.5-flash');
llm.setSavedModel('groq', 'llama-3.3-70b-versatile');
ok('the saved model is persisted', llm.savedModel('groq') === 'llama-3.3-70b-versatile' && getSetting('ai_model_groq', '') === 'llama-3.3-70b-versatile');
llm.addCustomModelId('groq', 'firmledger/finetune-1');
ok('a hand-typed model id joins the picker', llm.knownModelIds('groq').includes('firmledger/finetune-1')
  && llm.usableModels('groq').some((m) => m.id === 'firmledger/finetune-1'));
llm.removeCustomModelId('groq', 'firmledger/finetune-1');
ok('and can be removed again', !llm.knownModelIds('groq').includes('firmledger/finetune-1'));
ok('unknown models are still usable (vendors ship fast)', llm.isKnownModel('brand-new-model') === false);
ok('capability lookups: tools / json / reasoning',
  llm.supportsTools('openai/gpt-oss-120b', 'groq') === true
  && llm.supportsJson('openai/gpt-oss-120b', 'groq') === true
  && llm.isReasoning('o4-mini', 'openai') === true);

section('Active provider, failover and the rate cap');
ok('groq is the default backend', llm.DEFAULT_PROVIDER === 'groq');
setSetting('groq_api_key', 'gsk_saved_key_1234567890');
setSetting('openai_api_key', 'sk-saved-openai-key-1234');
llm.setActiveProvider('openai');
ok('the console can switch backend', llm.activeProviderId() === 'openai' && getSetting('ai_provider', '') === 'openai');
ok('the active model follows the provider', llm.activeModel() === llm.savedModel('openai'));
llm.setActiveProvider('groq');
setSetting('ai_failover', '0');
ok('failover can be switched off', llm.failoverEnabled() === false);
setSetting('ai_failover', '1');
ok('and back on', llm.failoverEnabled() === true);
llm.saveProviderOrder(['openai', 'anthropic', 'groq']);
ok('the failover order is respected', llm.providerOrder().slice(0, 3).join(',') === 'openai,anthropic,groq', llm.providerOrder().join(','));
llm.saveProviderOrder([]);
setSetting('ai_rate_limit_per_min', '25');
ok('the per-minute cap is stored and clamped', llm.rateLimitPerMinute() === 25);
setSetting('ai_rate_limit_per_min', '99999');
ok('an absurd cap is clamped to 600', llm.rateLimitPerMinute() === 600);
setSetting('ai_rate_limit_per_min', '');

section('Request building — OpenAI protocol');
let payload = llm.buildPayload('groq', {
  messages: [{ role: 'system', content: 'You are the admin assistant.' }, { role: 'user', content: 'How many listings?' }],
  tools: [{ type: 'function', function: { name: 'get_listing_stats', description: 'counts', parameters: { type: 'object', properties: {}, additionalProperties: false } } }],
  tool_choice: 'auto', temperature: 0.2, max_tokens: 900,
}, 'llama-3.3-70b-versatile');
ok('messages are passed through with the system message inline',
  payload.model === 'llama-3.3-70b-versatile' && payload.messages[0].role === 'system' && payload.messages.length === 2);
ok('tools travel in OpenAI function shape', payload.tools[0].function.name === 'get_listing_stats' && payload.tool_choice === 'auto');
ok('temperature and max_tokens are set for a normal model', payload.temperature === 0.2 && payload.max_tokens === 900);
payload = llm.buildPayload('openai', { messages: [{ role: 'user', content: 'hi' }], temperature: 0.5, max_tokens: 400 }, 'o4-mini');
ok('a reasoning model uses max_completion_tokens and no temperature',
  payload.max_completion_tokens === 400 && payload.temperature === undefined && payload.max_tokens === undefined);
payload = llm.buildPayload('groq', { messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_object' } }, 'openai/gpt-oss-120b');
ok('JSON mode is requested when the model supports it', payload.response_format && payload.response_format.type === 'json_object');
payload = llm.buildPayload('deepseek', { messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_object' } }, 'deepseek-reasoner');
ok('JSON mode is not requested from a model that cannot do it', payload.response_format === undefined);
payload = llm.buildPayload('groq', { messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_object' }, tools: [{ type: 'function', function: { name: 'x', parameters: {} } }] }, 'openai/gpt-oss-120b');
ok('tools and JSON mode can travel together on an OpenAI-compatible call',
  Array.isArray(payload.tools) && payload.response_format.type === 'json_object');

section('Request building — Anthropic protocol');
payload = llm.buildPayload('anthropic', {
  messages: [
    { role: 'system', content: 'You are the admin assistant.' },
    { role: 'user', content: 'Delete beta' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'delete_listing', arguments: '{"id_or_slug":"beta-works"}' } }] },
    { role: 'tool', tool_call_id: 'call_9', content: '{"ok":true}' },
  ],
  tools: [{ type: 'function', function: { name: 'delete_listing', description: 'delete', parameters: { type: 'object', properties: { id_or_slug: { type: 'string' } }, required: ['id_or_slug'], additionalProperties: false } } }],
  temperature: 0.4, max_tokens: 800,
}, 'claude-sonnet-4-5');
ok('the system prompt is lifted out of messages', payload.system === 'You are the admin assistant.' && payload.messages.every((m) => m.role !== 'system'));
ok('max_tokens is always present (Anthropic requires it)', typeof payload.max_tokens === 'number' && payload.max_tokens >= 256);
ok('tools are converted to input_schema without OpenAI-only keywords',
  payload.tools[0].name === 'delete_listing' && payload.tools[0].input_schema.properties.id_or_slug
  && payload.tools[0].input_schema.additionalProperties === undefined);
ok('tool_choice uses the Anthropic vocabulary', payload.tool_choice && payload.tool_choice.type === 'auto');
ok('an assistant tool call becomes a tool_use block',
  payload.messages.some((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use' && b.id === 'call_9')));
ok('a tool result becomes a user tool_result block',
  payload.messages.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'call_9')));

section('Request building — Gemini protocol');
payload = llm.buildPayload('gemini', {
  messages: [{ role: 'system', content: 'Grounded in the live site.' }, { role: 'user', content: 'Delete beta' }],
  tools: [{ type: 'function', function: { name: 'delete_listing', description: 'delete', parameters: { type: 'object', properties: { id_or_slug: { type: 'string' } }, additionalProperties: false, $schema: 'http://json-schema.org/draft-07/schema#' } } }],
  temperature: 0.7, max_tokens: 500,
}, 'gemini-2.5-flash');
ok('the system prompt becomes systemInstruction', payload.systemInstruction.parts[0].text === 'Grounded in the live site.');
ok('messages become contents with the model/user vocabulary',
  Array.isArray(payload.contents) && payload.contents[0].role === 'user');
ok('generationConfig carries temperature and maxOutputTokens',
  payload.generationConfig.temperature === 0.7 && payload.generationConfig.maxOutputTokens === 500);
ok('function declarations are cleaned for Gemini',
  payload.tools[0].functionDeclarations[0].name === 'delete_listing'
  && payload.tools[0].functionDeclarations[0].parameters.additionalProperties === undefined
  && payload.tools[0].functionDeclarations[0].parameters.$schema === undefined);
ok('function calling mode is set', payload.toolConfig.functionCallingConfig.mode === 'AUTO');
payload = llm.buildPayload('gemini', { messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_object' } }, 'gemini-2.5-flash');
ok('JSON mode sets responseMimeType when there are no tools', payload.generationConfig.responseMimeType === 'application/json');
payload = llm.buildPayload('gemini', { messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_object' }, tools: [{ type: 'function', function: { name: 'x', parameters: {} } }] }, 'gemini-2.5-flash');
ok('but never alongside functionDeclarations (Gemini rejects that)', payload.generationConfig.responseMimeType === undefined);

section('Response normalisation — one shape for every protocol');
let out = llm.normalize('groq', OPENAI_REPLY);
ok('openai: text, finish reason and usage',
  out.choices[0].message.content === 'Hello from OpenAI.' && out.choices[0].finish_reason === 'stop'
  && out.usage.prompt_tokens === 11 && out.usage.total_tokens === 18 && out.usage.provider === 'groq');
out = llm.normalize('anthropic', ANTHROPIC_REPLY);
ok('anthropic: text plus tool_use become OpenAI tool_calls',
  out.choices[0].message.content === 'Deleting that listing now.'
  && out.choices[0].message.tool_calls[0].function.name === 'delete_listing'
  && JSON.parse(out.choices[0].message.tool_calls[0].function.arguments).id_or_slug === 'beta-works'
  && out.choices[0].finish_reason === 'tool_calls');
ok('anthropic usage is mapped to the same names', out.usage.prompt_tokens === 30 && out.usage.completion_tokens === 12);
out = llm.normalize('gemini', GEMINI_REPLY);
ok('gemini: parts with functionCall become tool_calls',
  out.choices[0].message.content === 'On it.'
  && out.choices[0].message.tool_calls[0].function.name === 'delete_listing'
  && out.choices[0].finish_reason === 'tool_calls');
ok('gemini usageMetadata is mapped', out.usage.prompt_tokens === 40 && out.usage.completion_tokens === 15 && out.usage.total_tokens === 55);
ok('the accessors read the normalised shape',
  llm.assistantText(out) === 'On it.' && llm.toolCalls(out)[0].id === 'gemini_call_1' && llm.usage(out).total_tokens === 55);

section('chat() end to end per protocol (stubbed transport)');
(async function main() {
  pinLiveLists();
  let calls = stubFetch(() => ({ body: OPENAI_REPLY }));
  const r1 = await withKey('groq', 'gsk_saved_key_1234567890', () => llm.chat({
    provider: 'groq', model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: 'hi' }], temperature: 0, max_tokens: 50, noFallback: true,
  }));
  ok('groq posts to /chat/completions with a bearer key',
    calls[0].url === 'https://api.groq.com/openai/v1/chat/completions'
    && calls[0].headers.Authorization === 'Bearer gsk_saved_key_1234567890'
    && calls[0].headers['Content-Type'] === 'application/json', JSON.stringify(calls[0].headers));
  ok('the reply is normalised and stamped with its provider and model',
    r1.choices[0].message.content === 'Hello from OpenAI.' && r1._provider === 'groq' && r1._model === 'gpt-test',
    JSON.stringify({ p: r1._provider, m: r1._model }));

  calls = stubFetch(() => ({ body: ANTHROPIC_REPLY }));
  const r2 = await withKey('anthropic', 'sk-ant-saved-key-1234', () => llm.chat({
    provider: 'anthropic', model: 'claude-sonnet-4-5',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'delete_listing', description: 'd', parameters: { type: 'object', properties: {} } } }],
    noFallback: true,
  }));
  ok('anthropic posts to /messages with x-api-key and a version header',
    calls[0].url === 'https://api.anthropic.com/v1/messages'
    && calls[0].headers['x-api-key'] === 'sk-ant-saved-key-1234'
    && calls[0].headers['anthropic-version'] === '2023-06-01', JSON.stringify(calls[0].headers));
  ok('anthropic tool calls come back normalised',
    llm.toolCalls(r2)[0].function.name === 'delete_listing' && r2._provider === 'anthropic');

  calls = stubFetch(() => ({ body: GEMINI_REPLY }));
  const r3 = await withKey('gemini', 'AIza-saved-key-1234', () => llm.chat({
    provider: 'gemini', model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'hi' }], noFallback: true,
  }));
  ok('gemini posts to the generateContent endpoint with x-goog-api-key',
    /\/v1beta\/models\/gemini-2\.5-flash:generateContent$/.test(calls[0].url)
    && calls[0].headers['x-goog-api-key'] === 'AIza-saved-key-1234', calls[0].url);
  ok('gemini tool calls come back normalised', llm.toolCalls(r3)[0].function.name === 'delete_listing');

  calls = stubFetch(() => ({ body: OPENAI_REPLY }));
  await withKey('openrouter', 'sk-or-saved-key-123', () => llm.chat({
    provider: 'openrouter', model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], noFallback: true,
  }));
  ok('openrouter sends its attribution headers',
    calls[0].headers['HTTP-Referer'] && calls[0].headers['X-Title'] === 'FirmLedger Admin', JSON.stringify(calls[0].headers));

  calls = stubFetch(() => ({ body: OPENAI_REPLY }));
  setSetting('custom_api_key', 'mock-key');
  setSetting('ai_base_url_custom', 'http://127.0.0.1:9999/v1');
  await llm.chat({ provider: 'custom', model: 'local-model', messages: [{ role: 'user', content: 'hi' }], noFallback: true });
  ok('a custom OpenAI-compatible endpoint is honoured',
    calls[0].url === 'http://127.0.0.1:9999/v1/chat/completions', calls[0].url);
  setSetting('ai_custom_auth_header', 'api-key');
  calls = stubFetch(() => ({ body: OPENAI_REPLY }));
  await llm.chat({ provider: 'custom', model: 'local-model', messages: [{ role: 'user', content: 'hi' }], noFallback: true });
  ok('the custom auth header style can be switched to api-key',
    calls[0].headers['api-key'] === 'mock-key' && calls[0].headers.Authorization === undefined);
  setSetting('ai_custom_auth_header', '');
  setSetting('custom_api_key', '');
  setSetting('ai_base_url_custom', '');

  section('Errors, fallback and failover');
  calls = stubFetch(() => ({ status: 401, body: { error: { message: 'bad key' } } }));
  let err = null;
  try {
    await withKey('groq', 'gsk_wrong', () => llm.chat({ provider: 'groq', model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }], noFallback: true }));
  } catch (e) { err = e; }
  ok('a rejected key surfaces as an LlmError the operator can act on',
    err instanceof llm.LlmError && err.code === 'invalid_key' && /rejected the API key/i.test(err.message), err && err.message);

  err = null;
  try {
    await llm.chat({ provider: 'deepseek', model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], noFallback: true });
  } catch (e) { err = e; }
  ok('an unconfigured provider explains how to fix it',
    err && err.code === 'not_configured' && /paste an api key/i.test(err.message), err && err.message);

  err = null;
  try { await llm.chat({ provider: 'skynet', messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err = e; }
  ok('an unknown provider is refused', err && err.code === 'bad_provider');

  /* 429 on the first model, then the fallback model answers. */
  let n = 0;
  calls = stubFetch(() => {
    n += 1;
    if (n <= 2) return { status: 429, headers: { 'retry-after': '1' }, body: { error: { message: 'slow down' } } };
    return { body: { ...OPENAI_REPLY, model: 'second' } };
  });
  const fell = await withKey('groq', 'gsk_saved_key_1234567890', () => llm.chat({
    provider: 'groq', model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }],
  }));
  ok('a rate-limited model retries and then falls back to another model',
    calls.length >= 2 && fell && fell.choices && fell.choices.length === 1, `calls=${calls.length}`);

  /* Provider-level failover: groq is down, openai answers. */
  calls = stubFetch(({ url }) => (url.includes('groq.com')
    ? { status: 503, body: { error: { message: 'overloaded' } } }
    : { body: OPENAI_REPLY }));
  setSetting('groq_api_key', 'gsk_saved_key_1234567890');
  setSetting('openai_api_key', 'sk-saved-openai-key-1234');
  llm.setActiveProvider('groq');
  const over = await llm.chat({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] });
  ok('a dead provider fails over to another connected one',
    over._provider === 'openai' && calls.some((c) => c.url.includes('api.openai.com')), `provider=${over._provider}`);
  setSetting('ai_failover', '0');
  calls = stubFetch(() => ({ status: 503, body: { error: { message: 'overloaded' } } }));
  err = null;
  try { await llm.chat({ provider: 'groq', model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err = e; }
  ok('with failover switched off the error is reported instead', Boolean(err), 'expected a thrown error');
  setSetting('ai_failover', '1');

  /* The per-minute cap. */
  setSetting('ai_rate_limit_per_min', '2');
  setSetting('cerebras_api_key', 'sk-cerebras-saved-key');
  calls = stubFetch(() => ({ body: OPENAI_REPLY }));
  await llm.chat({ provider: 'cerebras', model: 'llama-3.3-70b', messages: [{ role: 'user', content: '1' }], noFallback: true });
  await llm.chat({ provider: 'cerebras', model: 'llama-3.3-70b', messages: [{ role: 'user', content: '2' }], noFallback: true });
  err = null;
  try { await llm.chat({ provider: 'cerebras', model: 'llama-3.3-70b', messages: [{ role: 'user', content: '3' }], noFallback: true }); } catch (e) { err = e; }
  ok('the per-minute cap stops a runaway loop', err && err.status === 429 && err.code === 'rate_limited', err && err.message);
  ok('a capped call never reaches the network', calls.length === 2, `calls=${calls.length}`);
  setSetting('ai_rate_limit_per_min', '');
  setSetting('cerebras_api_key', '');

  section('Live model lists and the connection test');
  calls = stubFetch(({ url }) => {
    if (url.includes('/models')) return { body: { data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'brand-new-model' }] } };
    return { body: OPENAI_REPLY };
  });
  const synced = await withKey('groq', 'gsk_saved_key_1234567890', () => llm.syncModels('groq'));
  ok('the live list is fetched and stored',
    synced.count === 2 && synced.models.includes('brand-new-model')
    && JSON.parse(getSetting('ai_live_models_groq', '[]')).includes('brand-new-model'));
  ok('a live model becomes selectable', llm.usableModels('groq').some((m) => m.id === 'brand-new-model'));
  ok('availability is marked against the live list',
    llm.usableModels('groq').find((m) => m.id === 'llama-3.3-70b-versatile').available === true);

  calls = stubFetch(({ url, method }) => {
    if (method === 'GET') return { body: { data: [{ id: 'claude-sonnet-4-5' }] } };
    return { body: ANTHROPIC_REPLY };
  });
  const tested = await withKey('anthropic', 'sk-ant-saved-key-1234', () => llm.testConnection('anthropic'));
  ok('the connection test lists models and completes a call',
    tested.ok === true && tested.models.includes('claude-sonnet-4-5') && tested.key_source === 'settings', JSON.stringify(tested).slice(0, 200));
  const noKey = await llm.testConnection('deepseek');
  ok('the test reports a missing key without touching the network', noKey.ok === false && /no .*key configured/i.test(noKey.error), noKey.error);

  section('Backwards-compatible groq façade');
  ok('the façade still exposes the legacy surface',
    typeof groq.modelId === 'function' && typeof groq.usableModels === 'function' && typeof groq.chat === 'function'
    && typeof groq.testConnection === 'function' && groq.DEFAULT_MODEL === 'openai/gpt-oss-120b');
  ok('GroqError is the same class as LlmError', groq.GroqError === llm.LlmError);
  setSetting('groq_api_key', 'gsk_saved_key_1234567890');
  llm.setActiveProvider('groq');
  ok('the façade follows the active provider', groq.modelId() === llm.savedModel('groq') && groq.groqConfigured() === true);
  ok('the façade lists models for the active provider', groq.usableModels().length > 0);
  /* ai.js calls groq.chat at call time, and tests/ai-agent.test.js monkeypatches it. */
  const originalChat = groq.chat;
  let patched = 0;
  groq.chat = async () => { patched += 1; return { choices: [{ message: { role: 'assistant', content: 'stubbed' }, finish_reason: 'stop' }], usage: null }; };
  const stubbed = await groq.chat({ messages: [{ role: 'user', content: 'x' }] });
  ok('groq.chat can still be monkeypatched (the agent test relies on it)',
    patched === 1 && stubbed.choices[0].message.content === 'stubbed');
  groq.chat = originalChat;

  section('Tool registry: reach, sensitivity and scope');
  const cat = tools.catalog();
  ok('the assistant can do everything the console can', cat.length >= 150, `${cat.length} tools`);
  ok('every console area is covered',
    ['site', 'read', 'listings', 'users', 'moderation', 'content', 'ops'].every((g) => cat.some((t) => t.group === g)));
  ok('sensitive actions are flagged and never auto-run',
    cat.filter((t) => t.sensitive).length >= 25
    && cat.filter((t) => t.sensitive).every((t) => tools.isAuto(t.name) === false));
  ok('deletions and bulk actions are sensitive',
    ['delete_listing', 'delete_user', 'bulk_update_listings', 'email_all_users', 'set_maintenance_mode', 'clear_ai_logs']
      .every((n) => tools.isSensitive(n)), 'a destructive tool is not marked sensitive');
  ok('lookups run without asking', tools.isAuto('get_listing_stats') === true && tools.isAuto('query_database') === true);
  tools.saveAutoTools(['suspend_user', 'delete_user', 'get_listing_stats']);
  ok('only real write actions can be auto-run',
    tools.autoSet().has('suspend_user') && !tools.autoSet().has('delete_user') && !tools.autoSet().has('get_listing_stats'));
  tools.saveAutoTools([]);
  tools.saveEnabledGroups(['read', 'listings']);
  ok('tool groups can be scoped down', tools.enabledGroups().join(',') === 'read,listings');
  ok('a scoped-out tool is not offered to the model',
    !tools.groqTools().some((t) => t.function.name === 'update_settings')
    && tools.groqTools().some((t) => t.function.name === 'get_listing'));
  let scoped = await tools.execute('update_settings', { auto_approve: true });
  ok('and cannot be executed either', scoped.ok === false && /switched off/i.test(scoped.error), scoped.error);
  scoped = await tools.execute('search_listings', { q: 'beta' });
  ok('a scoped-in lookup still runs', scoped.ok === true, scoped.error);
  scoped = await tools.execute('query_database', { sql: 'SELECT COUNT(*) c FROM listings' });
  ok('site understanding is scoped out with its own group', scoped.ok === false && /switched off/i.test(scoped.error), scoped.error);
  tools.saveEnabledGroups([]);
  ok('an empty scope re-opens everything (never lock the assistant out)', tools.enabledGroups().length === tools.GROUPS.length);
  ok('the capability prompt lists every reachable action',
    tools.capabilityPrompt().includes('delete_listing') && tools.capabilityPrompt().includes('WRITE-CONFIRM'));

  section('Live site briefing (what the model is told about this install)');
  const sc = require('../src/lib/sitecontext');
  const brief = sc.context({ compact: true, fresh: true });
  ok('the briefing describes the product and the stack', /FirmLedger/.test(brief) && /SQLite/.test(brief));
  ok('the briefing carries live counts',
    new RegExp(`listings: ${one('SELECT COUNT(*) c FROM listings').c} total`).test(brief)
    && new RegExp(`people: ${one('SELECT COUNT(*) c FROM users').c} accounts`).test(brief),
    (brief.match(/- listings:.*/) || [''])[0]);
  ok('the briefing lists the real tables', /Database tables \(\d+\)/.test(brief) && brief.includes('pro_transfer_requests'));
  ok('the briefing never leaks a secret value', !/gsk_saved_key_1234567890|sk-saved-openai-key-1234/.test(brief));
  ok('every topic answers', sc.TOPICS.every((t) => {
    const r = sc.topic(t);
    return r && (r.topic === t) && JSON.stringify(r).length > 40;
  }));
  const prompt = ai.assistantSystemPrompt();
  ok('the system prompt is grounded in the briefing and the tool list',
    prompt.includes('THE SITE YOU OPERATE') && prompt.includes('YOUR ACTIONS') && prompt.includes('site_overview') && prompt.length > 8000);
  ok('the system prompt states the confirmation policy',
    /ALWAYS require the operator's confirmation/i.test(prompt) && prompt.includes('delete_listing'));

  globalThis.fetch = realFetch;

  /* ==================================================================== */
  /* B. the console over HTTP                                              */
  /* ==================================================================== */
  await httpHalf();
})().catch((e) => {
  console.error(e);
  failures.push({ name: 'suite', why: e && e.message });
  report();
});

/* ---------------------------------------------------------------- part B */
async function httpHalf() {
  section('Admin console over HTTP — connect a provider and drive the assistant');

  /* A mock OpenAI-compatible endpoint: first turn proposes a sensitive tool
     call, second turn reports the result, /models answers the live list. */
  let turn = 0;
  const seen = [];
  const mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers, body: raw });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
        return res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'mock-model-large' }] }));
      }
      turn += 1;
      if (turn === 1) {
        return res.end(JSON.stringify({
          choices: [{
            index: 0, finish_reason: 'tool_calls',
            message: {
              role: 'assistant', content: '',
              tool_calls: [{ id: 'call_mock_1', type: 'function', function: { name: 'delete_listing', arguments: JSON.stringify({ id_or_slug: 'beta-works' }) } }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }));
      }
      return res.end(JSON.stringify({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Beta Works has been deleted.' } }],
        usage: { prompt_tokens: 120, completion_tokens: 10, total_tokens: 130 },
      }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;
  const mockBase = `http://127.0.0.1:${mockPort}/v1`;

  const PORT = 4700 + (process.pid % 200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const token = 'prov' + crypto.randomBytes(16).toString('hex');
  const csrf = crypto.randomBytes(12).toString('hex');
  const env = {
    ...process.env,
    FIRMLEDGER_DATA_DIR: tmp, PORT: String(PORT), BASE_URL: BASE,
    ADMIN_SECRET: 'provider-suite', SMTP_URL: '', STATUS_UPDATE_INTERVAL: '3600',
  };
  delete env.GROQ_API_KEY;
  delete env.OPENAI_API_KEY;

  /* Seed a listing to delete and an admin session, in a separate process so the
     server owns the only long-lived database handle. */
  execFileSync(process.execPath, ['-e', `
    process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(tmp)};
    const { db } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
    db.prepare(\`INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,status)
      VALUES ('beta-works','Beta Works','Tagline','A seeded listing for the provider suite to delete.','company','Other','https://beta-works.example','b@beta-works.example','Kenya','approved')\`).run();
    db.prepare("INSERT INTO sessions (token,user_id,csrf,kind,expires_at) VALUES (?,NULL,?,'admin',datetime('now','+1 day'))").run(${JSON.stringify(token)}, ${JSON.stringify(csrf)});
    console.log('seeded');
  `], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });

  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  const cookie = `fl_admin=${token}`;
  async function get(p) {
    const res = await fetch(BASE + p, { headers: { cookie, accept: 'application/json' } });
    const text = await res.text();
    let data = {}; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
    return { status: res.status, data, text };
  }
  async function post(p, body, form) {
    const res = await fetch(BASE + p, {
      method: 'POST',
      headers: form
        ? { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf }
        : { cookie, 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrf },
      body: form ? new URLSearchParams({ _csrf: csrf, ...body }).toString() : JSON.stringify(body),
    });
    const text = await res.text();
    let data = {}; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
    return { status: res.status, data, text };
  }
  const dbQuery = (sql) => {
    const out = execFileSync(process.execPath, ['-e', `
      process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(tmp)};
      const { db } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
      process.stdout.write(JSON.stringify(db.prepare(${JSON.stringify(sql)}).all()));
    `], { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    return JSON.parse(out);
  };

  try {
    for (let i = 0; i < 80; i++) {
      try { await fetch(`${BASE}/healthz`); break; } catch { await sleep(250); }
    }
    await sleep(300);

    const page = await fetch(`${BASE}/admin3119Musa/ai?tab=set`, { headers: { cookie } });
    const html = await page.text();
    ok('the playground page renders for an admin', page.status === 200 && html.includes('Model providers'), `status ${page.status}`);
    ok('the page offers every provider', ['Groq', 'OpenAI', 'Anthropic', 'Google Gemini', 'DeepSeek', 'Hugging Face', 'OpenRouter']
      .every((label) => html.includes(label)));
    ok('the page shows the sensitivity policy', html.includes('sensitive · always confirm') && html.includes('ai_tool_groups'));

    const provs = await get('/admin3119Musa/ai/providers');
    ok('GET /ai/providers lists all 16 backends', provs.status === 200 && provs.data.providers.length === 16, `status ${provs.status}`);
    ok('GET /ai/providers never returns a raw key',
      provs.data.providers.every((p) => !p.key_hint || (p.key_hint.length <= 14 && p.key_hint.includes('…')))
      && !/gsk_saved_key_1234567890|sk-saved-openai-key-1234|sk-ant-saved-key-1234|AIza-saved-key-1234/.test(provs.text),
      'a raw key was returned to the browser');

    /* Connect the mock endpoint as a "custom" provider — the same POST the
       browser makes when the admin pastes a key. */
    const saved = await post('/admin3119Musa/ai/provider/save', {
      provider: 'custom', api_key: 'mock-secret-key-9999', base_url: mockBase, model: 'mock-model', extra_models: 'mock-model-large',
    });
    ok('POST /ai/provider/save stores the key server-side', saved.status === 200 && saved.data.ok === true, saved.text.slice(0, 200));
    ok('the key really is in the settings table',
      dbQuery("SELECT value FROM settings WHERE key='custom_api_key'")[0].value === 'mock-secret-key-9999');
    ok('the base URL and model were stored',
      dbQuery("SELECT value FROM settings WHERE key='ai_base_url_custom'")[0].value === mockBase
      && dbQuery("SELECT value FROM settings WHERE key='ai_model_custom'")[0].value === 'mock-model');
    ok('no response body ever contains the raw key',
      !saved.text.includes('mock-secret-key-9999') && !provs.text.includes('mock-secret-key-9999'),
      'a raw API key leaked into a response');
    const after = await get('/admin3119Musa/ai/providers');
    const custom = after.data.providers.find((p) => p.id === 'custom');
    ok('the provider is now reported as configured, with a masked key',
      custom.configured === true && custom.key_set === true && custom.key_hint && !custom.key_hint.includes('mock-secret-key-9999'),
      JSON.stringify(custom).slice(0, 200));

    const used = await post('/admin3119Musa/ai/provider', { provider: 'custom', model: 'mock-model' });
    ok('POST /ai/provider switches the live backend',
      used.status === 200 && used.data.provider === 'custom'
      && dbQuery("SELECT value FROM settings WHERE key='ai_provider'")[0].value === 'custom', used.text.slice(0, 200));
    const refused = await post('/admin3119Musa/ai/provider', { provider: 'deepseek' });
    ok('switching to a provider with no key is refused', refused.status === 422 && /no api key/i.test(refused.data.error || ''), refused.text.slice(0, 160));

    const models = await get('/admin3119Musa/ai/models?provider=custom');
    ok('GET /ai/models lists the hand-typed ids for that provider',
      models.status === 200 && models.data.models.some((m) => m.id === 'mock-model')
      && models.data.models.some((m) => m.id === 'mock-model-large'), models.text.slice(0, 200));

    const testRes = await post('/admin3119Musa/ai/test', { provider: 'custom', model: 'mock-model' });
    ok('POST /ai/test verifies the connection through the console',
      testRes.status === 200 && testRes.data.test.ok === true, JSON.stringify(testRes.data.test || {}).slice(0, 240));
    ok('the test really hit the provider (models + a completion)',
      seen.some((c) => c.url.startsWith('/v1/models')) && seen.some((c) => c.url === '/v1/chat/completions'));
    ok('the API key travelled as an Authorization header, not in the URL',
      seen.some((c) => String(c.headers.authorization || '') === 'Bearer mock-secret-key-9999')
      && !seen.some((c) => c.url.includes('mock-secret-key-9999')));

    /* Settings form: several providers at once, plus tool scope and auto-run. */
    const formRes = await post('/admin3119Musa/ai/settings', {
      groq_api_key: 'gsk_from_the_form_123',
      groq_model: 'llama-3.3-70b-versatile',
      openai_api_key: 'sk_from_the_form_456',
      anthropic_api_key: 'sk-ant-from-the-form',
      gemini_api_key: 'AIza-from-the-form',
      deepseek_api_key: 'ds-from-the-form',
      huggingface_api_key: 'hf_from_the_form',
      openrouter_api_key: 'sk-or-from-the-form',
      ai_failover: '1', ai_failover_present: '1',
      ai_rate_limit_per_min: '33',
      ai_moderation_on: '1', ai_moderation_model: 'custom:mock-model',
      ai_auto_tools: 'suspend_user', ai_auto_tools_present: '1',
      ai_tool_groups: ['site', 'read', 'listings', 'users', 'moderation', 'content', 'ops'], ai_tool_groups_present: '1',
    }, true);
    ok('POST /ai/settings accepts every provider key in one save',
      formRes.status === 302 || formRes.status === 200, `status ${formRes.status}`);
    const storedKeys = dbQuery("SELECT key, value FROM settings WHERE key LIKE '%_api_key'");
    const asMap = Object.fromEntries(storedKeys.map((r) => [r.key, r.value]));
    ok('all seven keys landed in the settings table',
      asMap.groq_api_key === 'gsk_from_the_form_123' && asMap.openai_api_key === 'sk_from_the_form_456'
      && asMap.anthropic_api_key === 'sk-ant-from-the-form' && asMap.gemini_api_key === 'AIza-from-the-form'
      && asMap.deepseek_api_key === 'ds-from-the-form' && asMap.huggingface_api_key === 'hf_from_the_form'
      && asMap.openrouter_api_key === 'sk-or-from-the-form', JSON.stringify(asMap));
    ok('the per-provider model and the rate cap were stored',
      dbQuery("SELECT value FROM settings WHERE key='ai_model_groq'")[0].value === 'llama-3.3-70b-versatile'
      && dbQuery("SELECT value FROM settings WHERE key='ai_rate_limit_per_min'")[0].value === '33');
    ok('auto-moderation can run on another provider entirely',
      dbQuery("SELECT value FROM settings WHERE key='ai_moderation_model'")[0].value === 'custom:mock-model');
    ok('the auto-run selection kept a write action',
      JSON.parse(dbQuery("SELECT value FROM settings WHERE key='ai_auto_tools'")[0].value).includes('suspend_user'));
    ok('the tool scope selection was stored',
      JSON.parse(dbQuery("SELECT value FROM settings WHERE key='ai_tool_groups'")[0].value).length === 7);

    const ctx = await get('/admin3119Musa/ai/site-context');
    ok('GET /ai/site-context exposes the live briefing to the operator',
      ctx.status === 200 && /FirmLedger/.test(ctx.data.briefing) && ctx.data.tools.total >= 150);
    const topicRes = await get('/admin3119Musa/ai/site-context?topic=admin');
    ok('a single topic can be read on its own', topicRes.status === 200 && topicRes.data.topic === 'admin');

    /* The assistant: a sensitive action must be PROPOSED, never executed. */
    ok('the listing is still there before the chat turn',
      dbQuery("SELECT COUNT(*) c FROM listings WHERE slug='beta-works'")[0].c === 1);
    turn = 0;
    const chat = await post('/admin3119Musa/ai/chat', { text: 'Delete the Beta Works listing.', messages: [] });
    ok('POST /ai/chat answers', chat.status === 200 && chat.data.ok === true, chat.text.slice(0, 300));
    ok('the model was reached through the connected provider',
      chat.data.model && seen.filter((c) => c.url === '/v1/chat/completions').length >= 1, JSON.stringify(chat.data).slice(0, 200));
    ok('the system prompt sent to the provider describes the real site',
      (() => {
        const body = JSON.parse(seen[seen.length - 1].body);
        const sys = (body.messages || []).find((m) => m.role === 'system');
        return Boolean(sys && /THE SITE YOU OPERATE/.test(sys.content) && /delete_listing/.test(sys.content));
      })(), 'the grounded system prompt did not reach the provider');
    ok('the tool schemas reached the provider',
      (() => {
        const body = JSON.parse(seen[seen.length - 1].body);
        return Array.isArray(body.tools) && body.tools.length >= 100
          && body.tools.some((t) => t.function.name === 'delete_listing');
      })(), 'tools were not sent');
    ok('a sensitive action comes back as a proposal, not an execution',
      chat.data.type === 'tool_proposal' && chat.data.sensitive === true && chat.data.tool.sensitive === true
      && chat.data.tool.steps[0].sensitive === true, JSON.stringify(chat.data).slice(0, 300));
    ok('nothing ran while it waits for the operator',
      dbQuery("SELECT COUNT(*) c FROM listings WHERE slug='beta-works'")[0].c === 1
      && dbQuery('SELECT COUNT(*) c FROM ai_pending_actions')[0].c === 1);

    const pid = chat.data.pending_id;
    const cancelled = await post('/admin3119Musa/ai/cancel', { pending_id: pid });
    ok('the operator can discard the proposal', cancelled.status === 200 && cancelled.data.ok === true);
    ok('discarding leaves the record untouched',
      dbQuery("SELECT COUNT(*) c FROM listings WHERE slug='beta-works'")[0].c === 1);

    turn = 0;
    const chat2 = await post('/admin3119Musa/ai/chat', { text: 'Delete the Beta Works listing.', messages: [] });
    const pid2 = chat2.data.pending_id;
    const ran = await post('/admin3119Musa/ai/execute', { pending_id: pid2 });
    ok('confirming executes the action for real',
      ran.status === 200 && ran.data.ok === true && ran.data.executed !== false, ran.text.slice(0, 300));
    ok('the database shows it happened',
      dbQuery("SELECT COUNT(*) c FROM listings WHERE slug='beta-works'")[0].c === 0);
    ok('the pending row was consumed', dbQuery('SELECT COUNT(*) c FROM ai_pending_actions')[0].c === 0);
    ok('the action was written to the audit log',
      dbQuery('SELECT COUNT(*) c FROM ai_audit_log')[0].c >= 1,
      'nothing was audited');

    /* A read-only question needs no confirmation at all. */
    turn = 5;   // the mock now answers with plain text
    const chat3 = await post('/admin3119Musa/ai/chat', { text: 'Thanks — summarise what happened.', messages: [] });
    ok('a plain answer comes straight back', chat3.status === 200 && chat3.data.type !== 'tool_proposal');

    const replay = await post('/admin3119Musa/ai/execute', { pending_id: pid2 });
    ok('a consumed proposal cannot be replayed',
      replay.data.ok === false && /expired|already/i.test(replay.data.error || ''), replay.text.slice(0, 200));

    /* Security: no admin session, no AI. */
    const anon = await fetch(`${BASE}/admin3119Musa/ai/providers`, { redirect: 'manual' });
    ok('the provider list is admin-only', anon.status === 302 || anon.status === 401 || anon.status === 403, `status ${anon.status}`);
    const anonChat = await fetch(`${BASE}/admin3119Musa/ai/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }), redirect: 'manual',
    });
    ok('chatting is admin-only too', anonChat.status === 302 || anonChat.status === 401 || anonChat.status === 403, `status ${anonChat.status}`);
  } catch (e) {
    console.error(e);
    failures.push({ name: 'http', why: e && e.message });
    console.log(serverLog.slice(-2000));
  } finally {
    server.kill();
    mock.close();
    await sleep(150);
    report();
  }
}

function report() {
  console.log(`\n${'='.repeat(64)}`);
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  if (failures.length) for (const f of failures) console.log(`  • ${f.name}: ${f.why}`);
  console.log('='.repeat(64));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
}
