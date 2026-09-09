/**
 * FirmLedger — model providers + AI Playground console test.
 *
 *   node tests/ai-providers.test.js
 *
 * Part A runs `src/lib/llm.js` in-process against a recording fetch stub and
 * asserts the real wire format of every dialect (OpenAI-compatible, Anthropic,
 * Gemini, Cohere), key resolution, provider switching, model fallback, live
 * model listing and the per-provider rate limiter.
 *
 * Part B boots the real server, signs in as admin and drives the AI Playground:
 * every provider card renders, saving a provider + key switches the console
 * over, the provider endpoint answers, and no key ever reaches the browser.
 */
process.env.NODE_ENV = 'test';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-llm-'));
process.env.FIRMLEDGER_DATA_DIR = dataDir;
process.env.BASE_URL = 'https://firmledger.test';
process.env.GROQ_API_KEY = 'gsk-test-key-from-env';

const { db, getSetting, setSetting } = require('../src/db');
const llm = require('../src/lib/llm');
const ai = require('../src/lib/ai');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

/* ---------------------------------------------------------------- fetch stub */
const requests = [];
let responder = () => ({ status: 200, body: {} });
const realFetch = globalThis.fetch;   // restored before the real-server section

globalThis.fetch = async function stub(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  const headers = {};
  const src = (init && init.headers) || {};
  for (const [k, v] of Object.entries(src)) headers[String(k).toLowerCase()] = v;
  let body = null;
  try { body = init && init.body ? JSON.parse(init.body) : null; } catch { body = init && init.body; }
  const rec = { url, method: (init && init.method) || 'GET', headers, body };
  requests.push(rec);
  const out = responder(rec) || { status: 200, body: {} };
  return {
    ok: out.status >= 200 && out.status < 300,
    status: out.status,
    url,
    headers: { get: () => null },
    text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body)),
  };
};

const last = () => requests[requests.length - 1];
const userMsg = [{ role: 'user', content: 'Say ok' }];
const oneTool = [{
  type: 'function',
  function: {
    name: 'approve_listing',
    description: 'Approve a listing',
    parameters: { type: 'object', properties: { id_or_slug: { type: 'string' } }, required: ['id_or_slug'], additionalProperties: false },
  },
}];

/* Keep the background "refresh live models" timer out of the assertions. */
llm.PROVIDERS.forEach((p) => { if (p.listModels) llm.markLiveModels(p.id, p.models.map((m) => m.id)); });

/* Saved (not env) keys for the vendors under test — Groq's comes from the env. */
['anthropic', 'gemini', 'cohere', 'cerebras', 'mistral'].forEach((id) => llm.setApiKey(id, `saved-${id}-key`));

async function partA() {
  console.log('FirmLedger model-provider suite\n');

  /* ---------------------------------------------------------------- keys */
  section('Key resolution');
  check('registry covers the requested vendors',
    ['groq', 'gemini', 'deepseek', 'anthropic', 'huggingface', 'openrouter', 'openai', 'mistral', 'together', 'xai', 'cerebras', 'sambanova', 'fireworks', 'perplexity', 'cohere', 'github', 'ollama', 'custom']
      .every((id) => llm.isValidProvider(id)),
    llm.PROVIDERS.map((p) => p.id).join(','));
  check('environment key wins for Groq', llm.apiKey('groq') === 'gsk-test-key-from-env' && llm.keySource('groq') === 'env');
  llm.setApiKey('deepseek', 'sk-deepseek-saved');
  check('saved key is used when no env var exists', llm.apiKey('deepseek') === 'sk-deepseek-saved' && llm.keySource('deepseek') === 'settings');
  setSetting('groq_api_key', 'gsk-legacy-saved');
  check('legacy groq_api_key still readable', getSetting('groq_api_key') === 'gsk-legacy-saved');
  check('masked hint never shows the whole key', llm.maskKey('gsk-test-key-from-env') === 'gsk-te…-env', llm.maskKey('gsk-test-key-from-env'));
  check('Ollama needs no key', llm.configured('ollama') === true);
  check('an unknown provider is rejected', (() => { try { llm.setActiveProvider('skynet'); return false; } catch (e) { return e.code === 'bad_provider'; } })());

  /* ------------------------------------------------- OpenAI-compatible shape */
  section('OpenAI-compatible dialect (Groq)');
  responder = () => ({ status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } } });
  let data = await llm.chat({ provider: 'groq', messages: userMsg, temperature: 0.1, max_tokens: 20 });
  let r = last();
  check('posts to /chat/completions', r.url === 'https://api.groq.com/openai/v1/chat/completions', r.url);
  check('sends the bearer key from the environment', r.headers.authorization === 'Bearer gsk-test-key-from-env');
  check('passes the model and messages through', r.body.model === 'openai/gpt-oss-120b' && r.body.messages[0].content === 'Say ok');
  check('Groq gets max_completion_tokens (max_tokens is deprecated there)', r.body.max_completion_tokens === 20 && r.body.max_tokens === undefined, JSON.stringify(Object.keys(r.body)));
  check('GPT-OSS omits reasoning_format (unsupported on that model)', r.body.reasoning_format === undefined);
  check('normalised reply text', llm.assistantText(data) === 'ok');
  check('normalised usage', llm.usage(data).total_tokens === 4);

  /* Groq's Qwen 3.6 / 3.8 models require reasoning_format "hidden" for
     tool calling and JSON mode. */
  responder = () => ({ status: 200, body: { choices: [{ message: { content: '{"ok":true}' } }] } });
  await llm.chat({ provider: 'groq', model: 'qwen/qwen3.8-27b', max_tokens: 100, response_format: { type: 'json_object' }, messages: userMsg });
  r = last();
  check('Groq Qwen 3.8 JSON mode sets reasoning_format hidden', r.body.reasoning_format === 'hidden' && r.body.max_completion_tokens === 100, JSON.stringify(r.body));
  await llm.chat({ provider: 'groq', model: 'qwen/qwen3.6-27b', max_tokens: 100, tools: oneTool, tool_choice: 'auto', messages: userMsg });
  r = last();
  check('Groq Qwen 3.6 tool calls set reasoning_format hidden', r.body.reasoning_format === 'hidden');

  responder = () => ({
    status: 200,
    body: {
      choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'approve_listing', arguments: '{"id_or_slug":"acme"}' } }] } }],
      usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
    },
  });
  data = await llm.chat({ provider: 'groq', messages: userMsg, tools: oneTool, tool_choice: 'auto' });
  r = last();
  check('tools are forwarded to the model', Array.isArray(r.body.tools) && r.body.tools[0].function.name === 'approve_listing');
  check('tool_choice is forwarded', r.body.tool_choice === 'auto');
  check('tool calls are read back', llm.toolCalls(data)[0].function.name === 'approve_listing');

  /* ----------------------------- token field + retry behaviour (the 502 fix) */
  section('Token field selection and transient 5xx retry (playground 502 fix)');
  responder = () => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } });
  llm.setApiKey('openai', 'sk-test-openai');
  await llm.chat({ provider: 'openai', model: 'o3-mini', temperature: 0.5, max_tokens: 100, messages: userMsg });
  r = last();
  check('OpenAI o-series gets max_completion_tokens, no temperature', r.body.max_completion_tokens === 100 && r.body.max_tokens === undefined && r.body.temperature === undefined, JSON.stringify(Object.keys(r.body)));
  llm.markLiveModels('openai', llm.liveModelIds('openai').concat(['gpt-5']));
  await llm.chat({ provider: 'openai', model: 'gpt-5', max_tokens: 100, messages: userMsg });
  r = last();
  check('GPT-5.x gets max_completion_tokens', r.body.max_completion_tokens === 100 && r.body.max_tokens === undefined);
  await llm.chat({ provider: 'openai', model: 'gpt-4.1', max_tokens: 100, messages: userMsg });
  r = last();
  check('standard OpenAI models keep max_tokens', r.body.max_tokens === 100 && r.body.max_completion_tokens === undefined);
  await llm.chat({ provider: 'deepseek', model: 'deepseek-chat', max_tokens: 50, messages: userMsg });
  r = last();
  check('non-reasoning OpenAI-compatible models keep max_tokens', r.body.max_tokens === 50 && r.body.max_completion_tokens === undefined);

  let hits = 0;
  responder = () => {
    hits += 1;
    return hits === 1
      ? { status: 502, body: { error: { message: 'upstream blip' } } }
      : { status: 200, body: { choices: [{ message: { content: 'recovered' } }], model: 'openai/gpt-oss-120b' } };
  };
  data = await llm.chat({ provider: 'groq', model: 'openai/gpt-oss-120b', messages: userMsg });
  check('a transient upstream 5xx is retried once and recovers', llm.assistantText(data) === 'recovered' && hits === 2, `hits=${hits}`);

  hits = 0;
  responder = () => { hits += 1; return { status: 503, body: { error: { message: 'still down' } } }; };
  let surfaced = false;
  try { await llm.chat({ provider: 'groq', model: 'openai/gpt-oss-120b', messages: userMsg }); } catch (e) { surfaced = e.status === 502 && e.httpStatus === 503; }
  check('a persistent upstream 5xx still surfaces (after one retry)', surfaced && hits === 2, `hits=${hits}`);

  /* ------------------------------------------------------------- Anthropic */
  section('Anthropic dialect (Claude)');
  responder = () => ({
    status: 200,
    body: {
      id: 'msg_1', model: 'claude-sonnet-4-5',
      content: [
        { type: 'text', text: 'Running it now.' },
        { type: 'tool_use', id: 'tu_1', name: 'approve_listing', input: { id_or_slug: 'acme' } },
      ],
      usage: { input_tokens: 21, output_tokens: 7 },
    },
  });
  data = await llm.chat({
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    temperature: 0.4,
    max_tokens: 300,
    messages: [
      { role: 'system', content: 'You are the admin assistant.' },
      { role: 'user', content: 'Approve acme' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c0', type: 'function', function: { name: 'search_listings', arguments: '{"q":"acme"}' } }] },
      { role: 'tool', tool_call_id: 'c0', name: 'search_listings', content: '{"count":1}' },
    ],
    tools: oneTool,
  });
  r = last();
  check('posts to /v1/messages', r.url === 'https://api.anthropic.com/v1/messages', r.url);
  check('uses x-api-key + anthropic-version', Boolean(r.headers['x-api-key']) && r.headers['anthropic-version'] === '2023-06-01');
  check('system prompt is lifted out of messages', r.body.system === 'You are the admin assistant.' && r.body.messages.every((m) => m.role !== 'system'));
  check('tools become input_schema', r.body.tools[0].name === 'approve_listing' && r.body.tools[0].input_schema.type === 'object');
  check('assistant tool_use is translated back', r.body.messages.some((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use')));
  check('tool results become tool_result blocks', r.body.messages.some((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'c0')));
  check('temperature clamped to the Anthropic range', r.body.temperature === 0.4 && r.body.max_tokens === 300);
  check('tool_use response normalised to OpenAI tool_calls', llm.toolCalls(data)[0].function.name === 'approve_listing');
  check('text blocks are concatenated', llm.assistantText(data) === 'Running it now.');
  check('usage mapped from input/output tokens', llm.usage(data).prompt_tokens === 21 && llm.usage(data).total_tokens === 28);

  /* ---------------------------------------------------------------- Gemini */
  section('Gemini dialect (Google)');
  responder = () => ({
    status: 200,
    body: {
      candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'approve_listing', args: { id_or_slug: 'acme' } } }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 17 },
    },
  });
  data = await llm.chat({
    provider: 'gemini', model: 'gemini-2.5-flash', messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Approve acme' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c0', function: { name: 'search_listings', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c0', name: 'search_listings', content: '{"count":1}' },
    ],
    tools: oneTool, response_format: { type: 'json_object' }, max_tokens: 200,
  });
  r = last();
  check('posts to models/{id}:generateContent', r.url === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', r.url);
  check('uses the x-goog-api-key header', Boolean(r.headers['x-goog-api-key']));
  check('system becomes system_instruction', r.body.system_instruction.parts[0].text === 'Be brief.');
  check('contents use user/model roles', r.body.contents[0].role === 'user' && r.body.contents[1].role === 'model');
  check('tools become functionDeclarations', r.body.tools[0].functionDeclarations[0].name === 'approve_listing');
  check('additionalProperties stripped from the schema', JSON.stringify(r.body.tools[0].functionDeclarations[0].parameters).indexOf('additionalProperties') === -1);
  check('function responses are folded into a user turn', r.body.contents.some((c) => c.role === 'user' && c.parts.some((p) => p.functionResponse)));
  check('JSON mode requested via responseMimeType', r.body.generationConfig.responseMimeType === 'application/json');
  check('functionCall normalised to tool_calls', llm.toolCalls(data)[0].function.name === 'approve_listing');
  check('usage mapped from usageMetadata', llm.usage(data).total_tokens === 17);

  /* ---------------------------------------------------------------- Cohere */
  section('Cohere dialect');
  responder = () => ({
    status: 200,
    body: {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        tool_calls: [{ id: 'ct_1', type: 'function', function: { name: 'approve_listing', arguments: '{"id_or_slug":"acme"}' } }],
      },
      meta: { tokens: { input: { tokens: 8 }, output: { tokens: 4 } } },
    },
  });
  data = await llm.chat({ provider: 'cohere', messages: userMsg, tools: oneTool, max_tokens: 100 });
  r = last();
  check('posts to /v2/chat', r.url === 'https://api.cohere.com/v2/chat', r.url);
  check('tools wrapped in the Cohere envelope', r.body.tools[0].type === 'function' && r.body.tools[0].function.name === 'approve_listing');
  check('tool_calls normalised', llm.toolCalls(data)[0].function.name === 'approve_listing');
  check('text normalised', llm.assistantText(data) === 'Done.');

  /* ------------------------------------------------- gateway specific bits */
  section('Gateways: OpenRouter, Ollama and custom endpoints');
  responder = () => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } });
  llm.setApiKey('openrouter', 'sk-or-test');
  await llm.chat({ provider: 'openrouter', messages: userMsg });
  r = last();
  check('OpenRouter gets the attribution headers', Boolean(r.headers['http-referer']) && r.headers['x-title'] === 'FirmLedger admin console');
  check('OpenRouter posts to its own base', r.url === 'https://openrouter.ai/api/v1/chat/completions', r.url);

  await llm.chat({ provider: 'ollama', messages: userMsg });
  r = last();
  check('Ollama uses the local OpenAI-compatible port', r.url === 'http://127.0.0.1:11434/v1/chat/completions', r.url);
  check('Ollama sends no bearer token', !r.headers.authorization);

  llm.setBaseUrl('custom', 'https://llm.internal.example/v1/');
  llm.setApiKey('custom', 'gw-key');
  await llm.chat({ provider: 'custom', model: 'internal/assistant-7b', messages: userMsg });
  r = last();
  check('custom gateway base URL is honoured (trailing slash trimmed)', r.url === 'https://llm.internal.example/v1/chat/completions', r.url);
  check('a custom model id is accepted', r.body.model === 'internal/assistant-7b');

  /* ------------------------------------------------------- model handling */
  section('Model selection, fallback and live ids');
  let refused = false;
  try { await llm.chat({ provider: 'groq', model: 'gpt-9-turbo', messages: userMsg }); } catch (e) { refused = e.code === 'bad_model'; }
  check('a model outside the Groq catalogue is rejected before the call', refused);
  check('isKnownModel accepts static + live ids', llm.isKnownModel('openai/gpt-oss-20b', 'groq') && !llm.isKnownModel('gpt-9-turbo', 'groq'));
  check('capabilities fall back sensibly for unknown ids', llm.supportsTools('anything', 'deepseek') === true && llm.supportsTools('deepseek-reasoner', 'deepseek') === false);

  responder = (rec) => (rec.body.model === 'openai/gpt-oss-120b'
    ? { status: 404, body: { error: { message: 'The model `openai/gpt-oss-120b` does not exist' } } }
    : { status: 200, body: { choices: [{ message: { content: 'fallback ok' } }], model: rec.body.model } });
  data = await llm.chat({ provider: 'groq', messages: userMsg });
  check('an unavailable model falls back to the next one', llm.assistantText(data) === 'fallback ok' && data._model === 'openai/gpt-oss-20b', data._model);

  responder = (rec) => (/\/models/.test(rec.url)
    ? { status: 200, body: { data: [{ id: 'openai/gpt-oss-120b' }, { id: 'moonshotai/kimi-k2' }] } }
    : { status: 200, body: { choices: [{ message: { content: 'ok' } }] } });
  const synced = await llm.syncModels('groq');
  check('live model list is fetched and stored', synced.count === 2 && llm.liveModelIds('groq').includes('moonshotai/kimi-k2'));
  check('a live id becomes usable even if it is not in the static list', llm.isKnownModel('moonshotai/kimi-k2', 'groq'));

  responder = (rec) => (/\/models/.test(rec.url)
    ? { status: 200, body: { models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-pro' }] } }
    : { status: 200, body: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } });
  const gem = await llm.syncModels('gemini');
  check('Gemini model ids lose the models/ prefix', gem.count === 2 && llm.liveModelIds('gemini').includes('gemini-2.5-pro'), JSON.stringify(llm.liveModelIds('gemini')));

  responder = () => ({ status: 401, body: { error: { message: 'invalid api key' } } });
  const failed = await llm.testConnection('deepseek', 'deepseek-chat');
  check('a rejected key is reported, not swallowed', failed.ok === false && /rejected the API key/i.test(failed.error), failed.error);
  check('the failed test still names the provider', failed.provider === 'deepseek' && failed.provider_label === 'DeepSeek');

  /* ---------------------------------------------------------- rate limiter */
  section('Per-provider rate limiter');
  responder = () => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } });
  let limited = false;
  for (let i = 0; i < llm.RATE_MAX_PER_MIN + 2; i++) {
    try { await llm.chat({ provider: 'cerebras', messages: userMsg }); } catch (e) { if (e.code === 'rate_limited') { limited = true; break; } }
  }
  check(`the ${llm.RATE_MAX_PER_MIN + 1}th call in a minute is refused`, limited);

  /* ------------------------------------------- the console follows the pick */
  section('Provider switching drives the whole console');
  const groqFacade = require('../src/lib/groq');
  llm.setActiveProvider('anthropic');
  llm.setModel('anthropic', 'claude-haiku-4-5');
  check('active provider is remembered', getSetting('llm_provider') === 'anthropic' && llm.activeId() === 'anthropic');
  check('the Groq façade now resolves the chosen provider', groqFacade.modelId() === 'claude-haiku-4-5' && groqFacade.baseUrl() === 'https://api.anthropic.com/v1', groqFacade.baseUrl());
  check('façade MODELS follows the provider', groqFacade.MODELS.some((m) => m.id === 'claude-haiku-4-5'));
  responder = () => ({ status: 200, body: { content: [{ type: 'text', text: 'via claude' }], usage: { input_tokens: 1, output_tokens: 1 } } });
  data = await groqFacade.chat({ messages: userMsg });
  check('façade chat goes to the chosen provider', last().url === 'https://api.anthropic.com/v1/messages' && llm.assistantText(data) === 'via claude');
  check('settings snapshot reports the active provider', ai.settingsSnapshot().provider === 'anthropic');
  check('moderation model follows the provider when unset', ai.moderationModelId() === 'claude-haiku-4-5', ai.moderationModelId());

  llm.setActiveProvider('groq');
  check('switching back keeps Groq working', llm.activeId() === 'groq' && groqFacade.modelId() === 'openai/gpt-oss-120b');

  /* --------------------------------------------------- settings save path */
  section('Saving provider settings');
  ai.saveSettings({
    llm_provider: 'gemini',
    llm_key_gemini: 'AIza-test-key',
    llm_model_gemini: 'gemini-2.5-pro',
    llm_base_gemini: '',
    llm_key_groq: '',            // an empty field must not wipe a saved key
    groq_model: 'openai/gpt-oss-20b',
  });
  check('the chosen provider is stored', getSetting('llm_provider') === 'gemini');
  check('the key is stored for that provider only', getSetting('llm_key_gemini') === 'AIza-test-key' && getSetting('llm_key_groq', 'x') !== '');
  check('the model is stored per provider', getSetting('llm_model_gemini') === 'gemini-2.5-pro');
  check('the legacy groq_model key still round-trips', getSetting('groq_model') === 'openai/gpt-oss-20b');
  check('the snapshot hides keys and shows hints', (() => {
    const snap = ai.settingsSnapshot();
    const gem = snap.providers.find((p) => p.id === 'gemini');
    return gem.key_hint.indexOf('AIza') === 0 && gem.key_hint.indexOf('AIza-test-key') === -1 && JSON.stringify(snap).indexOf('AIza-test-key') === -1;
  })());
  let badProvider = false;
  try { ai.saveSettings({ llm_provider: 'not-a-real-lab' }); } catch (e) { badProvider = e.status === 422; }
  check('an unknown provider is refused on save', badProvider);
  llm.setActiveProvider('groq');
}

/* ============================================================ Part B: console */
const PORT = 4123 + (process.pid % 400);
const BASE = `http://127.0.0.1:${PORT}`;
const token = 'llm' + crypto.randomBytes(16).toString('hex');
const csrf = crypto.randomBytes(12).toString('hex');

const serverEnv = {
  ...process.env,
  FIRMLEDGER_DATA_DIR: dataDir,
  PORT: String(PORT),
  BASE_URL: BASE,
  ADMIN_SECRET: 'llm-test-secret',
  GROQ_API_KEY: '',
  SMTP_URL: '',
  STATUS_UPDATE_INTERVAL: '3600',
};

const seed = `
process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(dataDir)};
const { setSetting } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
setSetting('llm_provider', 'groq');
setSetting('groq_api_key', 'gsk-saved-in-the-settings-table');
require(${JSON.stringify(path.join(ROOT, 'src/db.js'))}).db
  .prepare("INSERT INTO sessions (token,user_id,csrf,kind,expires_at) VALUES (?,NULL,?,'admin',datetime('now','+1 day'))")
  .run(${JSON.stringify(token)}, ${JSON.stringify(csrf)});
console.log('seeded');
`;

async function partB() {
  section('AI Playground console (real server)');
  globalThis.fetch = realFetch;   // this section talks to a real server
  execFileSync(process.execPath, ['-e', seed], { cwd: ROOT, env: serverEnv, stdio: ['ignore', 'pipe', 'inherit'] });
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = Boolean(await fetch(`${BASE}/healthz`)); } catch { await sleep(250); }
  }
  if (!up) {
    check('server boots', false, log.slice(-800));
    server.kill('SIGKILL');
    return;
  }
  check('server boots', true);

  const cookie = { cookie: `fl_admin=${token}` };
  const page = await (await fetch(`${BASE}/admin3119Musa/ai`, { headers: cookie })).text();
  check('playground renders the provider picker + config card', /id="prov-select"/.test(page) && /id="prov-config"/.test(page));
  const provOptions = (page.match(/<option value="[a-z]+"[^>]*>[^<]*— (?:in use|\.env key|key saved|no key needed|no key)<\/option>/g) || []).length;
  check('every provider is offered in the picker', provOptions >= 18, `${provOptions} providers`);
  ['Groq', 'Google Gemini', 'DeepSeek', 'Anthropic Claude', 'Hugging Face', 'OpenRouter'].forEach((label) => {
    check(`picker offers ${label}`, page.indexOf(label) > -1);
  });
  check('the active provider is posted as llm_provider', /name="llm_provider" id="llm-provider-input"/.test(page));
  check('the config card carries the active provider key + endpoint fields', /name="llm_key_groq"/.test(page) && /name="llm_base_groq"/.test(page));
  check('the model field is named for the active provider', /name="llm_model_groq"/.test(page));
  check('the saved key is only shown masked', page.indexOf('gsk-saved-in-the-settings-table') === -1 && /gsk-sa…able/.test(page), (page.match(/gsk-sa[^<]{0,12}/) || [''])[0]);
  check('the active provider is marked in use', /data-prov="groq"[\s\S]{0,400}?ai-prov-badge on">in use/.test(page.replace(/\n/g, ' ')) || /is-active/.test(page));
  check('sensitive actions are labelled in the auto-run grid', /sensitive · always confirms/.test(page));

  /* Save a different provider + key through the real form endpoint. */
  const form = new URLSearchParams({
    _csrf: csrf,
    llm_provider: 'anthropic',
    llm_key_anthropic: 'sk-ant-test-secret',
    llm_model_anthropic: 'claude-sonnet-4-5',
    ai_auto_tools_present: '1',
  });
  const saved = await fetch(`${BASE}/admin3119Musa/ai/settings`, {
    method: 'POST', headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(), redirect: 'follow',
  });
  const after = await saved.text();
  check('saving the provider form succeeds', saved.status === 200 && /AI Playground settings saved/.test(after), `HTTP ${saved.status}`);
  check('the console switched to Anthropic', /Default model —\s*<span id="prov-model-owner">Anthropic Claude/.test(after.replace(/\s+/g, ' ')) || /Anthropic Claude<\/span>/.test(after));
  check('the new key is stored masked, never in the HTML', after.indexOf('sk-ant-test-secret') === -1 && /sk-ant…cret/.test(after), (after.match(/sk-ant[^<]{0,12}/) || [''])[0]);
  check('Claude models are offered once Anthropic is active', /value="claude-sonnet-4-5"/.test(after));

  const stored = execFileSync(process.execPath, ['-e', `
    process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(dataDir)};
    const { getSetting } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
    console.log(JSON.stringify({ provider: getSetting('llm_provider'), key: getSetting('llm_key_anthropic'), model: getSetting('llm_model_anthropic') }));
  `], { cwd: ROOT, env: serverEnv, encoding: 'utf8' });
  const dbState = JSON.parse(stored.trim().split('\n').pop());
  check('provider choice persisted in the settings table', dbState.provider === 'anthropic', JSON.stringify(dbState));
  check('pasted key persisted in the settings table', dbState.key === 'sk-ant-test-secret');
  check('per-provider model persisted', dbState.model === 'claude-sonnet-4-5');

  /* JSON endpoints. */
  const models = await (await fetch(`${BASE}/admin3119Musa/ai/models`, { headers: { ...cookie, accept: 'application/json' } })).json();
  check('models endpoint lists every provider', models.ok === true && models.providers.length >= 18 && models.provider === 'anthropic', JSON.stringify(models.provider));

  const switched = await (await fetch(`${BASE}/admin3119Musa/ai/provider`, {
    method: 'POST', headers: { ...cookie, accept: 'application/json', 'content-type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ provider: 'gemini' }),
  })).json();
  check('provider endpoint switches the active service', switched.ok === true && switched.provider === 'gemini', JSON.stringify(switched));

  const rejected = await fetch(`${BASE}/admin3119Musa/ai/provider`, {
    method: 'POST', headers: { ...cookie, accept: 'application/json', 'content-type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ provider: 'skynet' }),
  });
  check('an unknown provider is refused with 422', rejected.status === 422, `HTTP ${rejected.status}`);

  const tested = await (await fetch(`${BASE}/admin3119Musa/ai/test`, {
    method: 'POST', headers: { ...cookie, accept: 'application/json', 'content-type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ provider: 'deepseek', model: 'deepseek-chat' }),
  })).json();
  check('test endpoint answers for a specific provider', tested.ok === true && tested.test.provider === 'deepseek', JSON.stringify(tested.test && tested.test.provider));
  check('an unreachable provider reports the failure, not silence',
    tested.test.ok === false && /reach|network|timed out|rate|key/i.test(tested.test.error || ''), tested.test.error);

  const keyless = await (await fetch(`${BASE}/admin3119Musa/ai/test`, {
    method: 'POST', headers: { ...cookie, accept: 'application/json', 'content-type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ provider: 'xai' }),
  })).json();
  check('a provider with no key says so instead of calling out',
    keyless.test.ok === false && /no .* key configured|not configured/i.test(keyless.test.error || ''), keyless.test.error);

  server.kill('SIGKILL');
}

(async function main() {
  await partA();
  await partB();
  console.log(`\n${'='.repeat(64)}`);
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  failures.forEach((f) => console.log('  • ' + f));
  console.log('='.repeat(64));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
})();
