/**
 * Model gateway — every AI provider FirmLedger can talk to.
 *
 * One code path, many vendors. The admin pastes keys for as many providers as
 * they like in Admin → AI Playground → Settings, picks the one to use, and the
 * whole console (assistant, listing generator, auto-moderation) follows that
 * choice. `src/lib/groq.js` is now a thin back-compatibility façade over this
 * module, so nothing else in the app had to change.
 *
 * Wire formats handled for real:
 *   openai    OpenAI-compatible /chat/completions + /models
 *             (Groq, OpenAI, DeepSeek, OpenRouter, Hugging Face Router,
 *              Mistral, Together, xAI, Cerebras, SambaNova, Fireworks,
 *              Perplexity, GitHub Models, Ollama, any custom gateway)
 *   anthropic /v1/messages with tool_use / tool_result blocks
 *   gemini    /models/{id}:generateContent with functionCall parts
 *   cohere    /v2/chat with message.tool_calls
 *
 * Key resolution per provider: environment variable first (deployment wins),
 * then the key saved in the settings table. Keys are never returned to the
 * browser — only a masked hint.
 *
 * Model tiers:
 *   production  current, supported, safe to default to
 *   preview     served but pre-GA — may change or disappear; selectable
 *   legacy      superseded but still served — selectable, never auto-picked
 *   live        discovered from the provider's own /models catalog at runtime
 *   retired     shut down by the vendor (see Groq/DeepSeek/Fireworks notes) —
 *               hidden from the picker and rejected before any outbound call,
 *               unless the provider's live catalog still lists the id.
 */
const { getSetting, setSetting } = require('../db');
const { siteUrl } = require('./util');

const LIVE_TTL_MS = 6 * 60 * 60 * 1000; // re-check availability twice a day at most
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_MIN = 40;

/* ---------------------------------------------------------------- registry */

const PROVIDERS = [
  {
    id: 'groq', label: 'Groq', vendor: 'Groq', format: 'openai', listModels: 'openai',
    blurb: 'Fast open-model inference — Llama, GPT-OSS and Qwen at very high throughput.',
    base: 'https://api.groq.com/openai/v1', env: ['GROQ_API_KEY'], legacySetting: 'groq_api_key',
    legacyModelSetting: 'groq_model', keyPlaceholder: 'gsk_…', keysUrl: 'https://console.groq.com/keys',
    defaultModel: 'openai/gpt-oss-120b',
    fallbacks: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'qwen/qwen3.6-27b'],
    models: [
      {
        id: 'openai/gpt-oss-120b', label: 'OpenAI GPT-OSS 120B', tier: 'production',
        note: 'Flagship — best tool-calling accuracy. Default for the assistant.',
        tools: true, json: true, vision: false, free: true, context: 131072, maxOutput: 65536, tps: 500,
      },
      {
        id: 'openai/gpt-oss-20b', label: 'OpenAI GPT-OSS 20B', tier: 'production',
        note: 'Fastest production option. Good for bulk drafting.',
        tools: true, json: true, vision: false, free: true, context: 131072, maxOutput: 65536, tps: 1000,
      },
      {
        id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B', tier: 'preview',
        note: 'Preview — strong agentic/tool use, JSON schema mode.',
        tools: true, json: true, vision: true, free: true, context: 131042, maxOutput: 16384, tps: 450,
      },
      {
        id: 'qwen/qwen3.6-27b', label: 'Qwen 3.6 27B', tier: 'preview',
        note: 'Preview — cheaper than 3.8, same tool support.',
        tools: true, json: true, vision: true, free: true, context: 131072, maxOutput: 16384, tps: 500,
      },
      {
        id: 'openai/gpt-oss-safeguard-20b', label: 'GPT-OSS Safeguard 20B', tier: 'preview',
        note: 'Trust & safety tuned — the best fit for listing auto-moderation.',
        tools: true, json: true, vision: false, free: true, context: 131072, maxOutput: 65536, tps: 1000,
      },
      {
        id: 'groq/compound', label: 'Groq Compound', tier: 'production',
        note: 'Groq hosted agent system with built-in search and code execution.',
        tools: false, json: true, vision: false, free: true, context: 131072, maxOutput: 8192,
      },
      {
        id: 'groq/compound-mini', label: 'Groq Compound Mini', tier: 'production',
        note: 'Lower-cost Groq hosted agent system.',
        tools: false, json: true, vision: false, free: true, context: 131072, maxOutput: 8192,
      },
      {
        id: 'minimaxai/minimax-m2.7', label: 'MiniMax M2.7', tier: 'preview',
        note: 'Preview — MiniMax reasoning model served on Groq with tool calling.',
        tools: true, json: true, vision: false, free: true, context: 131072, maxOutput: 16384, tps: 400,
      },
      {
        id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (retired)', tier: 'retired',
        note: 'Retired by Groq on 16 Aug 2026 — migrated to GPT-OSS 120B.',
        tools: true, json: true, vision: false, free: true, context: 131072, maxOutput: 32768, tps: 280,
      },
      {
        id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant (retired)', tier: 'retired',
        note: 'Retired by Groq on 16 Aug 2026 — migrated to GPT-OSS 20B.',
        tools: true, json: true, vision: false, free: true, context: 131072, maxOutput: 131072, tps: 560,
      },
    ],
  },

  {
    id: 'openai', label: 'OpenAI', vendor: 'OpenAI', format: 'openai', listModels: 'openai',
    blurb: 'GPT-4.1 / GPT-4o / o-series. Strongest general reasoning, paid per token.',
    base: 'https://api.openai.com/v1', env: ['OPENAI_API_KEY'],
    keyPlaceholder: 'sk-…', keysUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-6-astra',
    fallbacks: ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-4.1'],
    models: [
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', tier: 'production', note: 'Latest OpenAI flagship for agentic and long-horizon work.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 128000 },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', tier: 'production', note: 'Highest-capability current GPT-5.6 variant.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 128000 },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', tier: 'production', note: 'Balanced GPT-5.6 production tier.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 128000 },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', tier: 'production', note: 'Lower-cost GPT-5.6 production tier.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 128000 },
      { id: 'gpt-5.5', label: 'GPT-5.5', tier: 'production', note: 'Current ChatGPT default; strong reasoning and tool use.', tools: true, json: true, vision: true, context: 400000, maxOutput: 65536 },
      { id: 'gpt-5.4', label: 'GPT-5.4', tier: 'production', note: 'Reasoning + coding flagship of the 5.4 family.', tools: true, json: true, vision: true, context: 400000, maxOutput: 65536 },
      { id: 'gpt-5', label: 'GPT-5', tier: 'production', note: 'Unified knowledge + reasoning; long docs and agent workflows.', tools: true, json: true, vision: true, context: 400000, maxOutput: 65536 },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', tier: 'production', note: 'Fast, lower-cost reasoning model.', tools: true, json: true, vision: true, context: 400000, maxOutput: 65536 },
      { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', tier: 'production', note: 'Lowest-cost current reasoning tier.', tools: true, json: true, vision: true, context: 400000, maxOutput: 65536 },
      { id: 'gpt-4.1', label: 'GPT-4.1', tier: 'production', note: 'Best tool-calling accuracy.', tools: true, json: true, vision: true, context: 1047576, maxOutput: 32768 },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', tier: 'production', note: 'Cheap and quick; fine for moderation.', tools: true, json: true, vision: true, context: 1047576, maxOutput: 32768 },
      { id: 'gpt-4.1-nano', label: 'GPT-4.1 nano', tier: 'production', note: 'Cheapest tier.', tools: true, json: true, vision: true, context: 1047576, maxOutput: 32768 },
      { id: 'gpt-4o', label: 'GPT-4o', tier: 'production', note: 'Multimodal workhorse.', tools: true, json: true, vision: true, context: 128000, maxOutput: 16384 },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', tier: 'legacy', note: 'Older, still cheap.', tools: true, json: true, vision: true, context: 128000, maxOutput: 16384 },
      { id: 'o3-mini', label: 'o3-mini', tier: 'production', note: 'Reasoning model — no system role, no temperature.', tools: true, json: true, vision: false, context: 200000, maxOutput: 100000 },
    ],
  },

  {
    id: 'anthropic', label: 'Anthropic Claude', vendor: 'Anthropic', format: 'anthropic', listModels: 'anthropic',
    blurb: 'Claude Sonnet / Opus / Haiku. Excellent at long agent runs and tool use.',
    base: 'https://api.anthropic.com/v1', env: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
    keyPlaceholder: 'sk-ant-…', keysUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-fable-5-1',
    fallbacks: ['claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    models: [
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', tier: 'production', note: 'Latest Anthropic model for long-running agents and knowledge work.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 128000 },
      { id: 'claude-fable-5', label: 'Claude Fable 5', tier: 'production', note: 'Frontier long-context model.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 128000 },
      { id: 'claude-opus-5', label: 'Claude Opus 5', tier: 'production', note: 'Complex agentic coding and enterprise work.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 128000 },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', tier: 'production', note: 'Current Opus production model.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 128000 },
      { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', tier: 'production', note: 'Current Opus production model.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 128000 },
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', tier: 'production', note: 'Current 1M-context Opus tier.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 128000 },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', tier: 'production', note: 'Current speed/intelligence balance.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 128000 },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', tier: 'production', note: 'Current Sonnet compatibility model.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 128000 },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', tier: 'production', note: 'Fastest current Claude tier; good for moderation.', tools: true, json: true, vision: true, context: 200000, maxOutput: 64000 },
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', tier: 'production', note: 'Best balance for the admin assistant.', tools: true, json: true, vision: true, context: 200000, maxOutput: 64000 },
      { id: 'claude-opus-4-1', label: 'Claude Opus 4.1 (legacy)', tier: 'legacy', note: 'Deepest reasoning, slowest and priciest.', tools: true, json: true, vision: true, context: 200000, maxOutput: 32000 },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tier: 'production', note: 'Fast and cheap; good for auto-moderation.', tools: true, json: true, vision: true, context: 200000, maxOutput: 64000 },
      { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku (retired)', tier: 'retired', note: 'Retired by Anthropic on 19 Feb 2026 — migrated to Haiku 4.5.', tools: true, json: true, vision: false, context: 200000, maxOutput: 8192 },
    ],
  },

  {
    id: 'gemini', label: 'Google Gemini', vendor: 'Google AI Studio', format: 'gemini', listModels: 'gemini',
    blurb: 'Gemini 2.5 Pro / Flash. Huge context, free tier available with a Google key.',
    base: 'https://generativelanguage.googleapis.com/v1beta', env: ['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    keyPlaceholder: 'AIza…', keysUrl: 'https://aistudio.google.com/app/apikey',
    defaultModel: 'gemini-3.8-flash',
    fallbacks: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview'],
    models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', tier: 'production', note: 'Latest stable Flash model; 1M context and tool calling.', tools: true, json: true, vision: true, free: true, context: 1048576, maxOutput: 65536 },
      { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', tier: 'production', note: 'Stable multimodal reasoning and agent model.', tools: true, json: true, vision: true, free: true, context: 1048576, maxOutput: 65536 },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', tier: 'production', note: 'High-throughput current Flash tier.', tools: true, json: true, vision: true, free: true, context: 1048576, maxOutput: 65536 },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', tier: 'production', note: 'Stable multimodal Flash model.', tools: true, json: true, vision: true, free: true, context: 1048576, maxOutput: 65536 },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', tier: 'production', note: 'Cost-efficient current model for extraction and routing.', tools: true, json: true, vision: true, free: true, context: 1048576, maxOutput: 65536 },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)', tier: 'preview', note: 'Current preview Flash tier; 1M context.', tools: true, json: true, vision: true, free: true, context: 1048576, maxOutput: 65536 },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', tier: 'preview', note: 'Deep reasoning and coding; preview availability.', tools: true, json: true, vision: true, free: true, context: 1048576, maxOutput: 65536 },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', tier: 'production', note: 'Lowest-cost current 1M-context tier.', tools: true, json: true, vision: true, free: true, context: 1048576, maxOutput: 65536 },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'production', note: 'Fast, tool-capable, 1M context.', tools: true, json: true, vision: true, free: true, context: 1048576, maxOutput: 65536 },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', tier: 'production', note: 'Cheapest Gemini; fine for bulk drafting.', tools: true, json: true, vision: true, free: true, context: 1048576, maxOutput: 65536 },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'production', note: 'Strongest Gemini reasoning.', tools: true, json: true, vision: true, free: true, context: 1048576, maxOutput: 65536 },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', tier: 'legacy', note: 'Previous generation.', tools: true, json: true, vision: true, free: true, context: 1048576, maxOutput: 8192 },
    ],
  },

  {
    id: 'deepseek', label: 'DeepSeek', vendor: 'DeepSeek', format: 'openai', listModels: 'openai',
    blurb: 'Very cheap strong models — V4 Flash and V4 Pro with 1M context, thinking modes and tool calling.',
    base: 'https://api.deepseek.com', env: ['DEEPSEEK_API_KEY'],
    keyPlaceholder: 'sk-…', keysUrl: 'https://platform.deepseek.com/api_keys',
    defaultModel: 'deepseek-v4-flash',
    fallbacks: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    models: [
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', tier: 'production', note: 'Current high-throughput 1M-context model; supports tools and JSON.', tools: true, json: true, vision: false, context: 1048576, maxOutput: 384000 },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', tier: 'production', note: 'Current flagship for difficult reasoning and coding.', tools: true, json: true, vision: false, context: 1048576, maxOutput: 384000 },
      { id: 'deepseek-v4-flash-vision-exp', label: 'DeepSeek V4 Flash Vision (experimental)', tier: 'preview', note: 'Text plus image input; validate before production use.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 384000 },
      { id: 'deepseek-chat', label: 'DeepSeek Chat (retired)', tier: 'retired', note: 'Retired by DeepSeek on 24 Jul 2026 — migrated to V4 Flash.', tools: true, json: true, vision: false, context: 65536, maxOutput: 8192 },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (retired)', tier: 'retired', note: 'Retired by DeepSeek on 24 Jul 2026 — migrated to V4 Pro with thinking.', tools: false, json: false, vision: false, context: 65536, maxOutput: 65536 },
    ],
  },

  {
    id: 'huggingface', label: 'Hugging Face', vendor: 'HF Inference Providers', format: 'openai', listModels: 'openai',
    blurb: 'The HF Router: hundreds of open models behind one key, billed per provider.',
    base: 'https://router.huggingface.co/v1', env: ['HUGGINGFACE_API_KEY', 'HF_TOKEN'],
    keyPlaceholder: 'hf_…', keysUrl: 'https://huggingface.co/settings/tokens',
    allowCustom: true, defaultModel: 'openai/gpt-oss-120b',
    fallbacks: ['openai/gpt-oss-120b', 'meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct'],
    models: [
      { id: 'openai/gpt-oss-120b', label: 'OpenAI GPT-OSS 120B', tier: 'production', note: 'Stable open model with strong tool calling.', tools: true, json: true, vision: false, context: 131072, maxOutput: 40960 },
      { id: 'deepseek-ai/DeepSeek-V4-Flash-0731', label: 'DeepSeek V4 Flash 0731', tier: 'production', note: 'Current HF Router example with tool calling.', tools: true, json: true, vision: false, context: 1048576, maxOutput: 131072 },
      { id: 'Qwen/Qwen3.5-9B', label: 'Qwen 3.5 9B', tier: 'production', note: 'Efficient multimodal router model.', tools: true, json: true, vision: true, context: 262144, maxOutput: 65536 },
      { id: 'meta-llama/Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B Instruct', tier: 'production', note: 'Solid all-round tool caller.', tools: true, json: true, vision: false, context: 131072, maxOutput: 4096 },
      { id: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen 2.5 72B Instruct', tier: 'production', note: 'Strong JSON output.', tools: true, json: true, vision: false, context: 131072, maxOutput: 8192 },
      { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', label: 'Qwen 3 235B Instruct', tier: 'production', note: 'Largest open weights on the router.', tools: true, json: true, vision: false, context: 262144, maxOutput: 32768 },
      { id: 'deepseek-ai/DeepSeek-R1-0528', label: 'DeepSeek R1', tier: 'preview', note: 'Reasoning — no tool calls.', tools: false, json: false, vision: false, context: 163840, maxOutput: 65536 },
    ],
  },

  {
    id: 'openrouter', label: 'OpenRouter', vendor: 'OpenRouter', format: 'openai', listModels: 'openai',
    blurb: 'One key, 300+ models from every lab. Best fallback coverage.',
    base: 'https://openrouter.ai/api/v1', env: ['OPENROUTER_API_KEY'],
    keyPlaceholder: 'sk-or-…', keysUrl: 'https://openrouter.ai/settings/keys',
    allowCustom: true, defaultModel: 'anthropic/claude-sonnet-4.5',
    fallbacks: ['anthropic/claude-sonnet-4.5', 'openai/gpt-4.1', 'google/gemini-2.5-flash', 'openai/gpt-6-astra'],
    models: [
      { id: 'openai/gpt-6-astra', label: 'OpenAI GPT-6 Astra', tier: 'production', note: 'Latest OpenRouter flagship.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 128000 },
      { id: 'openai/gpt-5.6-sol', label: 'OpenAI GPT-5.6 Sol', tier: 'production', note: 'Current high-capability GPT route.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 128000 },
      { id: 'openai/gpt-5.5', label: 'OpenAI GPT-5.5', tier: 'production', note: 'Current ChatGPT default, routed.', tools: true, json: true, vision: true, context: 400000, maxOutput: 65536 },
      { id: 'anthropic/claude-opus-5', label: 'Claude Opus 5', tier: 'production', note: 'Routed Opus flagship.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 128000 },
      { id: 'anthropic/claude-fable-5-1', label: 'Claude Fable 5.1', tier: 'production', note: 'Latest Anthropic route.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 128000 },
      { id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash', tier: 'production', note: 'Latest Google Flash route.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 65536 },
      { id: 'deepseek/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash', tier: 'production', note: 'Cost-efficient current DeepSeek route.', tools: true, json: true, vision: false, context: 1048576, maxOutput: 131072 },
      { id: 'openai/gpt-4.1', label: 'OpenAI GPT-4.1', tier: 'production', note: 'Routed GPT-4.1.', tools: true, json: true, vision: true, context: 1047576, maxOutput: 32768 },
      { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', tier: 'production', note: 'Routed Claude.', tools: true, json: true, vision: true, context: 200000, maxOutput: 64000 },
      { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'production', note: 'Routed Gemini.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 65536 },
      { id: 'deepseek/deepseek-chat-v3-0324', label: 'DeepSeek V3', tier: 'production', note: 'Cheap routed DeepSeek.', tools: true, json: true, vision: false, context: 163840, maxOutput: 8192 },
      { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B', tier: 'production', note: 'Open weights, many providers.', tools: true, json: true, vision: false, context: 131072, maxOutput: 4096 },
      { id: 'qwen/qwen3-235b-a22b', label: 'Qwen 3 235B', tier: 'production', note: 'Large MoE.', tools: true, json: true, vision: false, context: 131072, maxOutput: 16384 },
    ],
  },

  {
    id: 'mistral', label: 'Mistral AI', vendor: 'Mistral', format: 'openai', listModels: 'openai',
    blurb: 'La Plateforme — Mistral Large/Small and the open Nemo models.',
    base: 'https://api.mistral.ai/v1', env: ['MISTRAL_API_KEY'],
    keyPlaceholder: '…', keysUrl: 'https://console.mistral.ai/api-keys',
    defaultModel: 'mistral-medium-3-5',
    fallbacks: ['mistral-medium-3-5', 'mistral-small-2603', 'mistral-large-2512'],
    models: [
      { id: 'mistral-medium-3-5', label: 'Mistral Medium 3.5', tier: 'production', note: 'Current flagship for agents and coding.', tools: true, json: true, vision: true, context: 256000, maxOutput: 32768 },
      { id: 'mistral-small-2603', label: 'Mistral Small 4', tier: 'production', note: 'Current hybrid instruct/reasoning model.', tools: true, json: true, vision: true, context: 256000, maxOutput: 32768 },
      { id: 'mistral-large-2512', label: 'Mistral Large 3', tier: 'production', note: 'Current multimodal large model.', tools: true, json: true, vision: true, context: 256000, maxOutput: 32768 },
      { id: 'codestral-2508', label: 'Codestral', tier: 'production', note: 'Current coding model; use for code-focused prompts.', tools: true, json: true, vision: false, context: 256000, maxOutput: 32768 },
      { id: 'ministral-8b-2512', label: 'Ministral 8B', tier: 'production', note: 'Current edge-efficient model; cheap high-volume tier.', tools: true, json: true, vision: false, context: 128000, maxOutput: 8192 },
      { id: 'mistral-large-latest', label: 'Mistral Large', tier: 'production', note: 'Flagship with function calling.', tools: true, json: true, vision: false, context: 131072, maxOutput: 8192 },
      { id: 'mistral-small-latest', label: 'Mistral Small', tier: 'production', note: 'Cheap and quick.', tools: true, json: true, vision: false, context: 131072, maxOutput: 8192 },
      { id: 'magistral-medium-latest', label: 'Magistral Medium', tier: 'preview', note: 'Reasoning — no tool calls.', tools: false, json: false, vision: false, context: 40960, maxOutput: 40960 },
      { id: 'magistral-small-latest', label: 'Magistral Small', tier: 'preview', note: 'Smaller reasoning model — no tool calls.', tools: false, json: false, vision: false, context: 40960, maxOutput: 40960 },
      { id: 'open-mistral-nemo', label: 'Mistral Nemo (open)', tier: 'legacy', note: '12B open weights.', tools: true, json: true, vision: false, context: 131072, maxOutput: 8192 },
    ],
  },

  {
    id: 'together', label: 'Together AI', vendor: 'Together', format: 'openai', listModels: 'openai',
    blurb: 'Dedicated open-model inference with serverless pricing.',
    base: 'https://api.together.xyz/v1', env: ['TOGETHER_API_KEY'],
    keyPlaceholder: '…', keysUrl: 'https://api.together.xyz/settings/api-keys',
    allowCustom: true, defaultModel: 'MiniMaxAI/MiniMax-M3',
    fallbacks: ['MiniMaxAI/MiniMax-M3', 'deepseek-ai/DeepSeek-V4-Flash-0731', 'deepseek-ai/DeepSeek-V4-Pro-0813'],
    models: [
      { id: 'MiniMaxAI/MiniMax-M3', label: 'MiniMax M3', tier: 'production', note: 'Current 1M-context agentic model with tool calling.', tools: true, json: true, vision: true, context: 524288, maxOutput: 131072 },
      { id: 'deepseek-ai/DeepSeek-V4-Flash-0731', label: 'DeepSeek V4 Flash 0731', tier: 'production', note: 'Current high-throughput DeepSeek model.', tools: true, json: true, vision: false, context: 1048576, maxOutput: 131072 },
      { id: 'deepseek-ai/DeepSeek-V4-Pro-0813', label: 'DeepSeek V4 Pro 0813', tier: 'production', note: 'Current flagship reasoning model.', tools: true, json: true, vision: false, context: 1048576, maxOutput: 131072 },
      { id: 'moonshotai/Kimi-K3', label: 'Kimi K3', tier: 'production', note: 'Moonshot flagship reasoning model; 1M context.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 131072 },
      { id: 'Qwen/Qwen3.5-9B', label: 'Qwen 3.5 9B', tier: 'production', note: 'Efficient multimodal model.', tools: true, json: true, vision: true, context: 262144, maxOutput: 65536 },
      { id: 'google/gemma-4-31B-it', label: 'Gemma 4 31B IT', tier: 'production', note: 'Current Google open multimodal model.', tools: true, json: true, vision: true, context: 262144, maxOutput: 65536 },
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo', tier: 'production', note: 'Tool-calling open model.', tools: true, json: true, vision: false, context: 131072, maxOutput: 4096 },
      { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', label: 'Qwen 2.5 72B Turbo', tier: 'production', note: 'Good JSON adherence.', tools: true, json: true, vision: false, context: 131072, maxOutput: 8192 },
      { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3', tier: 'production', note: 'Large MoE.', tools: true, json: true, vision: false, context: 163840, maxOutput: 8192 },
    ],
  },

  {
    id: 'xai', label: 'xAI (Grok)', vendor: 'xAI', format: 'openai', listModels: 'openai',
    blurb: 'Grok 4 / Grok 3 with live-search capable tool use.',
    base: 'https://api.x.ai/v1', env: ['XAI_API_KEY'],
    keyPlaceholder: 'xai-…', keysUrl: 'https://console.x.ai/team/default/api-keys',
    defaultModel: 'grok-4.6',
    fallbacks: ['grok-4.6', 'grok-4.3', 'grok-4.5', 'grok-4'],
    models: [
      { id: 'grok-4.6', label: 'Grok 4.6', tier: 'production', note: 'Latest xAI flagship with configurable reasoning and tool calling.', tools: true, json: true, vision: true, context: 500000, maxOutput: 131072 },
      { id: 'grok-4.5', label: 'Grok 4.5', tier: 'production', note: 'Prior flagship, Opus-class at lower cost.', tools: true, json: true, vision: true, context: 500000, maxOutput: 131072 },
      { id: 'grok-4.3', label: 'Grok 4.3', tier: 'production', note: 'Production sweet spot; 1M context with video input.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 65536 },
      { id: 'grok-4-1-fast-reasoning', label: 'Grok 4.1 Fast Reasoning', tier: 'production', note: 'Cheap high-throughput reasoning; 2M context.', tools: true, json: true, vision: true, context: 2000000, maxOutput: 32768 },
      { id: 'grok-4-1-fast-non-reasoning', label: 'Grok 4.1 Fast', tier: 'production', note: 'Cheapest high-volume tier; 2M context.', tools: true, json: true, vision: true, context: 2000000, maxOutput: 32768 },
      { id: 'grok-code-fast-1', label: 'Grok Code Fast 1', tier: 'production', note: 'Coding-tuned fast tier.', tools: true, json: true, vision: true, context: 256000, maxOutput: 32768 },
      { id: 'grok-4', label: 'Grok 4', tier: 'production', note: 'Flagship reasoning + tools.', tools: true, json: true, vision: false, context: 256000, maxOutput: 32768 },
      { id: 'grok-3', label: 'Grok 3', tier: 'production', note: 'Previous flagship.', tools: true, json: true, vision: false, context: 131072, maxOutput: 8192 },
      { id: 'grok-3-mini', label: 'Grok 3 mini', tier: 'production', note: 'Cheap and fast.', tools: true, json: true, vision: false, context: 131072, maxOutput: 8192 },
    ],
  },

  {
    id: 'cerebras', label: 'Cerebras', vendor: 'Cerebras Inference', format: 'openai', listModels: 'openai',
    blurb: 'Wafer-scale inference — thousands of tokens per second.',
    base: 'https://api.cerebras.ai/v1', env: ['CEREBRAS_API_KEY'],
    keyPlaceholder: 'csk-…', keysUrl: 'https://cloud.cerebras.ai/',
    allowCustom: true, defaultModel: 'gpt-oss-120b',
    fallbacks: ['gpt-oss-120b', 'llama-3.3-70b', 'qwen-3-32b'],
    models: [
      { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', tier: 'production', note: 'Cerebras public production model with tool calling.', tools: true, json: true, vision: false, free: true, context: 131072, maxOutput: 40960 },
      { id: 'llama-3.3-70b', label: 'Llama 3.3 70B', tier: 'production', note: 'Fastest 70B anywhere.', tools: true, json: true, vision: false, free: true, context: 64000, maxOutput: 8192 },
      { id: 'llama3.1-8b', label: 'Llama 3.1 8B', tier: 'production', note: 'Small and extremely fast.', tools: true, json: true, vision: false, free: true, context: 64000, maxOutput: 8192 },
      { id: 'qwen-3-32b', label: 'Qwen 3 32B', tier: 'production', note: 'Tool support, very high throughput.', tools: true, json: true, vision: false, free: true, context: 64000, maxOutput: 8192 },
      { id: 'qwen-3-235b-a22b-instruct-2507', label: 'Qwen 3 235B Instruct (preview)', tier: 'preview', note: 'Large MoE preview on the public endpoint.', tools: true, json: true, vision: false, free: true, context: 64000, maxOutput: 8192 },
      { id: 'zai-glm-4.6', label: 'GLM 4.6 (preview)', tier: 'preview', note: 'Preview model; availability varies by account.', tools: true, json: true, vision: false, free: true, context: 64000, maxOutput: 8192 },
    ],
  },

  {
    id: 'sambanova', label: 'SambaNova', vendor: 'SambaNova Cloud', format: 'openai', listModels: 'openai',
    blurb: 'RDU inference for Llama, Qwen and DeepSeek at very low latency.',
    base: 'https://api.sambanova.ai/v1', env: ['SAMBANOVA_API_KEY'],
    keyPlaceholder: '…', keysUrl: 'https://cloud.sambanova.ai/apis',
    allowCustom: true, defaultModel: 'MiniMax-M2.7',
    fallbacks: ['MiniMax-M2.7', 'DeepSeek-V3.1', 'gpt-oss-120b'],
    models: [
      { id: 'MiniMax-M2.7', label: 'MiniMax M2.7', tier: 'production', note: 'Current SambaCloud production flagship.', tools: true, json: true, vision: false, free: true, context: 196608, maxOutput: 81920 },
      { id: 'DeepSeek-V3.1', label: 'DeepSeek V3.1', tier: 'production', note: 'Hybrid thinking model; tool calling in non-thinking mode.', tools: true, json: true, vision: false, free: true, context: 131072, maxOutput: 32768 },
      { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', tier: 'production', note: 'OpenAI open weights with tools.', tools: true, json: true, vision: false, free: true, context: 131072, maxOutput: 40960 },
      { id: 'MiniMax-M3', label: 'MiniMax M3', tier: 'preview', note: 'Multimodal preview; availability varies by account.', tools: true, json: true, vision: true, free: true, context: 1048576, maxOutput: 131072 },
      { id: 'DeepSeek-V3.2', label: 'DeepSeek V3.2', tier: 'preview', note: 'Current DeepSeek preview on SambaCloud.', tools: true, json: true, vision: false, free: true, context: 32768, maxOutput: 8192 },
      { id: 'gemma-4-31B-it', label: 'Gemma 4 31B IT', tier: 'preview', note: 'Google multimodal preview (text, image, video in).', tools: true, json: true, vision: true, free: true, context: 131072, maxOutput: 8192 },
      { id: 'Meta-Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B', tier: 'production', note: 'Tool-calling.', tools: true, json: true, vision: false, free: true, context: 131072, maxOutput: 4096 },
      { id: 'Qwen3-32B', label: 'Qwen 3 32B', tier: 'legacy', note: 'No longer in the published SambaCloud catalog — may 404.', tools: true, json: true, vision: false, free: true, context: 16384, maxOutput: 4096 },
      { id: 'DeepSeek-R1-Distill-Llama-70B', label: 'DeepSeek R1 Distill 70B (retired)', tier: 'retired', note: 'Removed from the SambaCloud catalog — use DeepSeek V3.1.', tools: false, json: false, vision: false, free: true, context: 131072, maxOutput: 8192 },
    ],
  },

  {
    id: 'fireworks', label: 'Fireworks AI', vendor: 'Fireworks', format: 'openai', listModels: 'openai',
    blurb: 'Fast serving of open models, compound AI and function calling.',
    base: 'https://api.fireworks.ai/inference/v1', env: ['FIREWORKS_API_KEY'],
    keyPlaceholder: 'fw_…', keysUrl: 'https://fireworks.ai/account/api-keys',
    allowCustom: true, defaultModel: 'accounts/fireworks/models/deepseek-v4-flash-0731',
    fallbacks: ['accounts/fireworks/models/deepseek-v4-flash-0731', 'accounts/fireworks/models/minimax-m3', 'accounts/fireworks/models/gpt-oss-120b'],
    models: [
      { id: 'accounts/fireworks/models/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash 0731', tier: 'production', note: 'Current 1M-context default; cheap with tool calling.', tools: true, json: true, vision: false, context: 1048576, maxOutput: 131072 },
      { id: 'accounts/fireworks/models/deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro 0813', tier: 'production', note: 'Flagship reasoning model; 1M context.', tools: true, json: true, vision: false, context: 1048576, maxOutput: 131072 },
      { id: 'accounts/fireworks/models/kimi-k3', label: 'Kimi K3', tier: 'production', note: 'Moonshot flagship agent model; multimodal.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 131072 },
      { id: 'accounts/fireworks/models/kimi-k2p6', label: 'Kimi K2.6', tier: 'production', note: 'Current Kimi reasoning tier.', tools: true, json: true, vision: false, context: 262144, maxOutput: 32768 },
      { id: 'accounts/fireworks/models/kimi-k2p7-code', label: 'Kimi K2.7 Code', tier: 'production', note: 'Coding and agentic Kimi tier.', tools: true, json: true, vision: false, context: 262144, maxOutput: 32768 },
      { id: 'accounts/fireworks/models/minimax-m3', label: 'MiniMax M3', tier: 'production', note: 'Native multimodal; 512K context.', tools: true, json: true, vision: true, context: 524288, maxOutput: 65536 },
      { id: 'accounts/fireworks/models/gpt-oss-120b', label: 'GPT-OSS 120B', tier: 'production', note: 'OpenAI open weights with tools.', tools: true, json: true, vision: false, context: 131072, maxOutput: 32768 },
      { id: 'accounts/fireworks/models/glm-5p3', label: 'GLM 5.3', tier: 'production', note: 'Z.ai flagship reasoning model.', tools: true, json: true, vision: false, context: 1048576, maxOutput: 131072 },
      { id: 'accounts/fireworks/models/glm-5p3-flash', label: 'GLM 5.3 Flash', tier: 'production', note: 'Cheapest current GLM tier.', tools: true, json: true, vision: false, context: 1048576, maxOutput: 131072 },
      { id: 'accounts/fireworks/models/qwen3p7-plus', label: 'Qwen 3.7 Plus', tier: 'production', note: 'Current Qwen serverless tier.', tools: true, json: true, vision: false, context: 262144, maxOutput: 32768 },
      { id: 'accounts/fireworks/models/qwen3p8-max', label: 'Qwen 3.8 Max', tier: 'production', note: 'Largest current Qwen tier.', tools: true, json: true, vision: true, context: 262144, maxOutput: 32768 },
      { id: 'accounts/fireworks/models/muse-glimmer-30b', label: 'Muse Glimmer 30B', tier: 'production', note: 'Meta multimodal model.', tools: true, json: true, vision: true, context: 131072, maxOutput: 16384 },
      { id: 'accounts/fireworks/models/deepseek-v4-flash-vision-exp', label: 'DeepSeek V4 Flash Vision (experimental)', tier: 'preview', note: 'Text plus image input; validate before production use.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 131072 },
      { id: 'accounts/fireworks/models/deepseek-v4-flash', label: 'DeepSeek V4 Flash alias (retired)', tier: 'retired', note: 'Unversioned alias retired — use deepseek-v4-flash-0731.', tools: true, json: true, vision: false, context: 1048576, maxOutput: 131072 },
      { id: 'accounts/fireworks/models/deepseek-v3p1', label: 'DeepSeek V3.1 (retired)', tier: 'retired', note: 'Removed from serverless on 14 May 2026 — use Kimi K2.6.', tools: true, json: true, vision: false, context: 1048576, maxOutput: 131072 },
      { id: 'accounts/fireworks/models/kimi-k2p5', label: 'Kimi K2.5 (retired)', tier: 'retired', note: 'Deprecated by Fireworks — use Kimi K2.6.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 131072 },
      { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', label: 'Llama 3.3 70B (retired)', tier: 'retired', note: 'Removed from serverless on 14 May 2026 — use GPT-OSS 120B.', tools: true, json: true, vision: false, context: 131072, maxOutput: 4096 },
      { id: 'accounts/fireworks/models/qwen3-235b-a22b-instruct-2507', label: 'Qwen 3 235B Instruct', tier: 'legacy', note: 'Superseded by Qwen 3.7 / 3.8 tiers.', tools: true, json: true, vision: false, context: 262144, maxOutput: 32768 },
      { id: 'accounts/fireworks/models/deepseek-v3', label: 'DeepSeek V3 (retired)', tier: 'retired', note: 'Long removed from serverless — use DeepSeek V4 Flash.', tools: true, json: true, vision: false, context: 131072, maxOutput: 8192 },
    ],
  },

  {
    id: 'perplexity', label: 'Perplexity', vendor: 'Perplexity AI', format: 'openai', listModels: null,
    blurb: 'Search-grounded answers with citations. No tool calling — lookups only.',
    base: 'https://api.perplexity.ai', env: ['PERPLEXITY_API_KEY'],
    keyPlaceholder: 'pplx-…', keysUrl: 'https://www.perplexity.ai/settings/api',
    defaultModel: 'sonar-pro',
    fallbacks: ['sonar-pro', 'sonar', 'sonar-deep-research'],
    models: [
      { id: 'sonar-pro', label: 'Sonar Pro', tier: 'production', note: 'Current production search model for complex answers.', tools: false, json: true, vision: false, context: 200000, maxOutput: 8192 },
      { id: 'sonar-reasoning-pro', label: 'Sonar Reasoning Pro', tier: 'production', note: 'Current reasoning search model.', tools: false, json: true, vision: false, context: 128000, maxOutput: 8192 },
      { id: 'sonar-deep-research', label: 'Sonar Deep Research', tier: 'production', note: 'Long-form multi-step research.', tools: false, json: true, vision: false, context: 128000, maxOutput: 8192 },
      { id: 'sonar', label: 'Sonar', tier: 'production', note: 'Fast, cited answers.', tools: false, json: true, vision: false, context: 128000, maxOutput: 8192 },
      { id: 'sonar-reasoning', label: 'Sonar Reasoning (retired)', tier: 'legacy', note: 'Reasoning with citations.', tools: false, json: true, vision: false, context: 128000, maxOutput: 8192 },
    ],
  },

  {
    id: 'cohere', label: 'Cohere', vendor: 'Cohere', format: 'cohere', listModels: 'cohere',
    blurb: 'Command R+ / Command A — enterprise RAG and multilingual work.',
    base: 'https://api.cohere.com', env: ['COHERE_API_KEY'],
    keyPlaceholder: '…', keysUrl: 'https://dashboard.cohere.com/api-keys',
    defaultModel: 'command-a-plus-05-2026',
    fallbacks: ['command-a-plus-05-2026', 'command-a-reasoning-08-2025', 'command-a-03-2025'],
    models: [
      { id: 'command-a-plus-05-2026', label: 'Command A+', tier: 'production', note: 'Latest Cohere model with vision and agentic tool use.', tools: true, json: true, vision: true, context: 131072, maxOutput: 65536 },
      { id: 'command-a-reasoning-08-2025', label: 'Command A Reasoning', tier: 'production', note: 'Reasoning model with tool use.', tools: true, json: true, vision: false, context: 256000, maxOutput: 32768 },
      { id: 'command-a-vision-07-2025', label: 'Command A Vision', tier: 'production', note: 'Vision and document understanding.', tools: true, json: true, vision: true, context: 128000, maxOutput: 8192 },
      { id: 'command-r7b-12-2024', label: 'Command R7B', tier: 'production', note: 'Small current Command model.', tools: true, json: true, vision: false, context: 128000, maxOutput: 4096 },
      { id: 'command-a-03-2025', label: 'Command A', tier: 'production', note: 'Cohere flagship with tools.', tools: true, json: true, vision: false, context: 256000, maxOutput: 8192 },
      { id: 'command-r-plus-08-2024', label: 'Command R+', tier: 'legacy', note: 'Previous flagship.', tools: true, json: true, vision: false, context: 128000, maxOutput: 4096 },
      { id: 'command-r-08-2024', label: 'Command R', tier: 'legacy', note: 'Cheaper tier.', tools: true, json: true, vision: false, context: 128000, maxOutput: 4096 },
    ],
  },

  {
    id: 'github', label: 'GitHub Models (retired)', vendor: 'GitHub', format: 'openai', listModels: 'openai', status: 'retired',
    retiredNote: 'GitHub retired the Models playground, catalog and inference API on 30 July 2026. Existing settings are retained for compatibility; migrate to OpenAI, Azure, or another provider.',
    blurb: 'Retired 30 July 2026 — retained so existing settings can be migrated without data loss.',
    base: 'https://models.inference.ai.azure.com', env: ['GITHUB_TOKEN', 'GITHUB_MODELS_TOKEN'],
    keyPlaceholder: 'github_pat_…', keysUrl: 'https://github.com/settings/tokens',
    allowCustom: true, defaultModel: 'gpt-4.1',
    fallbacks: ['gpt-4.1', 'gpt-4o', 'Meta-Llama-3.1-70B-Instruct'],
    models: [
      { id: 'gpt-4.1', label: 'GPT-4.1', tier: 'production', note: 'Tool calling.', tools: true, json: true, vision: true, context: 1047576, maxOutput: 32768 },
      { id: 'gpt-4o', label: 'GPT-4o', tier: 'production', note: 'Multimodal.', tools: true, json: true, vision: true, context: 128000, maxOutput: 16384 },
      { id: 'Meta-Llama-3.1-70B-Instruct', label: 'Llama 3.1 70B Instruct', tier: 'production', note: 'Open weights.', tools: true, json: true, vision: false, context: 131072, maxOutput: 4096 },
      { id: 'Mistral-Large-2411', label: 'Mistral Large 2411', tier: 'production', note: 'Long context.', tools: true, json: true, vision: false, context: 128000, maxOutput: 4096 },
    ],
  },

  {
    id: 'ollama', label: 'Ollama (local)', vendor: 'Ollama', format: 'openai', listModels: 'ollama',
    blurb: 'Your own machine — no API key, nothing leaves the server. Needs the OpenAI-compatible port.',
    base: 'http://127.0.0.1:11434/v1', env: ['OLLAMA_BASE_URL'], baseEnv: 'OLLAMA_BASE_URL',
    keyPlaceholder: 'not required', keysUrl: 'https://ollama.com/download', needsKey: false,
    allowCustom: true, defaultModel: 'qwen3:30b',
    fallbacks: ['qwen3:30b', 'gpt-oss:20b', 'llama3.3'],
    models: [
      { id: 'qwen3:30b', label: 'Qwen 3 30B', tier: 'production', note: 'Best overall local model; pull with `ollama pull qwen3:30b`.', tools: true, json: true, vision: false, free: true, context: 262144, maxOutput: 65536 },
      { id: 'qwen3:14b', label: 'Qwen 3 14B', tier: 'production', note: 'General chat for 12–16 GB machines.', tools: true, json: true, vision: false, free: true, context: 262144, maxOutput: 65536 },
      { id: 'gpt-oss:20b', label: 'GPT-OSS 20B', tier: 'production', note: 'Local reasoning and agent model.', tools: true, json: true, vision: false, free: true, context: 131072, maxOutput: 65536 },
      { id: 'gpt-oss:120b', label: 'GPT-OSS 120B', tier: 'production', note: 'Local frontier reasoning model.', tools: true, json: true, vision: false, free: true, context: 131072, maxOutput: 65536 },
      { id: 'gemma4', label: 'Gemma 4', tier: 'production', note: 'Current multimodal local model.', tools: true, json: true, vision: true, free: true, context: 262144, maxOutput: 65536 },
      { id: 'qwen3-coder:30b', label: 'Qwen 3 Coder 30B', tier: 'production', note: 'Agentic coding model.', tools: true, json: true, vision: false, free: true, context: 262144, maxOutput: 65536 },
      { id: 'deepseek-r1:8b', label: 'DeepSeek R1 8B', tier: 'production', note: 'Lightweight local reasoning.', tools: false, json: true, vision: false, free: true, context: 131072, maxOutput: 32768 },
      { id: 'llama3.3', label: 'Llama 3.3', tier: 'production', note: 'Pull with `ollama pull llama3.3`.', tools: true, json: true, vision: false, free: true, context: 131072, maxOutput: 4096 },
      { id: 'qwen2.5', label: 'Qwen 2.5', tier: 'production', note: 'Pull with `ollama pull qwen2.5`.', tools: true, json: true, vision: false, free: true, context: 131072, maxOutput: 8192 },
      { id: 'gemma3', label: 'Gemma 3', tier: 'production', note: 'Vision-capable local model.', tools: false, json: true, vision: true, free: true, context: 131072, maxOutput: 8192 },
      { id: 'mistral', label: 'Mistral', tier: 'legacy', note: 'Small and fast.', tools: true, json: true, vision: false, free: true, context: 32768, maxOutput: 4096 },
    ],
  },

  {
    id: 'custom', label: 'Custom gateway', vendor: 'Any OpenAI-compatible endpoint', format: 'openai', listModels: 'openai',
    blurb: 'Point at any OpenAI-compatible gateway — LiteLLM, vLLM, OpenWebUI, Azure, a company proxy.',
    base: '', env: ['CUSTOM_LLM_API_KEY'], baseEnv: 'CUSTOM_LLM_BASE_URL',
    keyPlaceholder: 'provider key', keysUrl: '', allowCustom: true, defaultModel: '',
    fallbacks: [],
    models: [],
  },
];

const BY_ID = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));
const DEFAULT_PROVIDER = 'groq';

/* ------------------------------------------------------------------ errors */

class LLMError extends Error {
  constructor(message, { status = 502, code = 'llm_error', retryAfterSec = 0, provider = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
    this.provider = provider;
  }
}

/* --------------------------------------------------------------- utilities */

function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 10) return `${k.slice(0, 4)}…`;
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isValidProvider(id) {
  return Boolean(BY_ID[String(id || '').trim()]);
}

function isRetiredProvider(id) {
  return provider(id).status === 'retired';
}

function provider(id) {
  return BY_ID[String(id || '').trim()] || BY_ID[DEFAULT_PROVIDER];
}

/** The provider the console currently runs on. */
function activeId() {
  const saved = String(getSetting('llm_provider', '') || '').trim();
  return isValidProvider(saved) ? saved : DEFAULT_PROVIDER;
}

function setActiveProvider(id) {
  const pid = String(id || '').trim();
  if (!isValidProvider(pid)) {
    const err = new LLMError(`“${pid}” is not a provider this console knows.`, { status: 422, code: 'bad_provider' });
    throw err;
  }
  setSetting('llm_provider', pid);
  return pid;
}

/* ------------------------------------------------------------------- keys */

function envKey(p) {
  for (const name of (p.env || [])) {
    const v = String(process.env[name] || '').trim();
    if (v) return v;
  }
  return '';
}

function apiKey(pid) {
  const p = provider(pid);
  const env = envKey(p);
  if (env) return env;
  const saved = String(getSetting(`llm_key_${p.id}`, '') || '').trim();
  if (saved) return saved;
  if (p.legacySetting) return String(getSetting(p.legacySetting, '') || '').trim();
  return '';
}

function setApiKey(pid, key) {
  const p = provider(pid);
  const v = String(key == null ? '' : key).trim().slice(0, 400);
  setSetting(`llm_key_${p.id}`, v);
  if (p.legacySetting) setSetting(p.legacySetting, v);
  return v;
}

function keySource(pid) {
  const p = provider(pid);
  if (envKey(p)) return 'env';
  if (String(getSetting(`llm_key_${p.id}`, '') || '').trim()) return 'settings';
  if (p.legacySetting && String(getSetting(p.legacySetting, '') || '').trim()) return 'settings';
  return '';
}

function configured(pid) {
  const p = provider(pid);
  if (p.status === 'retired') return false;
  if (p.needsKey === false) return true; // Ollama and friends need no secret
  return Boolean(apiKey(pid));
}

/* -------------------------------------------------------------- base urls */

function baseUrlFor(pid) {
  const p = provider(pid);
  const saved = String(getSetting(`llm_base_${p.id}`, '') || '').trim();
  if (saved) return saved.replace(/\/+$/, '');
  if (p.baseEnv) {
    const env = String(process.env[p.baseEnv] || '').trim();
    if (env) return env.replace(/\/+$/, '');
  }
  return String(p.base || '').replace(/\/+$/, '');
}

function setBaseUrl(pid, url) {
  const p = provider(pid);
  setSetting(`llm_base_${p.id}`, String(url == null ? '' : url).trim().slice(0, 300).replace(/\/+$/, ''));
}

function chatUrl(pid) {
  const p = provider(pid);
  const base = baseUrlFor(pid);
  if (p.format === 'anthropic') return `${base}/messages`;
  if (p.format === 'cohere') return `${base}/v2/chat`;
  if (p.format === 'gemini') return base; // the model id is part of the path
  return `${base}/chat/completions`;
}

function modelsUrl(pid) {
  const p = provider(pid);
  const base = baseUrlFor(pid);
  if (p.format === 'anthropic') return `${base}/models`;
  if (p.format === 'cohere') return `${base}/v1/models`;
  if (p.format === 'gemini') return `${base}/models`;
  if (p.id === 'ollama') return base.replace(/\/v1$/, '') + '/api/tags';
  return `${base}/models`;
}

function extraHeaders(pid) {
  const p = provider(pid);
  const h = {};
  if (p.id === 'openrouter') {
    h['HTTP-Referer'] = siteUrl('/');
    h['X-Title'] = 'FirmLedger admin console';
  }
  if (p.format === 'anthropic') h['anthropic-version'] = '2023-06-01';
  return h;
}

function authHeaders(pid) {
  const p = provider(pid);
  const key = apiKey(pid);
  if (p.format === 'anthropic') return { 'x-api-key': key };
  if (p.format === 'gemini') return { 'x-goog-api-key': key };
  if (!key) return {};
  return { Authorization: `Bearer ${key}` };
}

/* ---------------------------------------------------------------- models */

function looksLikeModelId(id) {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,120}$/.test(String(id || '').trim());
}

/* ------------------------------------------- free-tier model discovery */

/**
 * Which providers serve models on a free tier, and how a newly discovered
 * live id is classified. Curated registry rows carry their own `free` flag;
 * this table decides for ids the provider exposes that we have not curated
 * yet — so a brand-new free model appears in the playground on its own at
 * the next catalog sync, with no code change.
 *   groq / cerebras / sambanova / ollama — whole catalog is free (rate limited)
 *   gemini   — Google AI Studio free tier covers the Gemini + Gemma chat rows
 *   openrouter — free variants carry the `:free` suffix
 * Everyone else is paid-only, so unknown live ids are not treated as free.
 */
const FREE_LIVE_PATTERNS = {
  groq: () => true,
  gemini: (id) => /^(gemini|gemma|learnlm)[-.]/.test(id),
  cerebras: () => true,
  sambanova: () => true,
  ollama: () => true,
  openrouter: (id) => /:free$/i.test(id),
};

/** Does this model run on a free tier for the given provider? */
function isFreeModel(id, pid) {
  const p = provider(pid || activeId());
  const meta = modelMeta(id, p.id);
  if (meta) return meta.free === true;
  const pattern = FREE_LIVE_PATTERNS[p.id];
  return pattern ? pattern(String(id || '').trim()) : false;
}

function activeModels() { return provider(activeId()).models; }
function activeDefaultModel() { return modelFor(activeId()); }

function modelMeta(id, pid) {
  const p = provider(pid || activeId());
  const wanted = String(id || '').trim();
  if (!wanted) return null;
  return p.models.find((m) => m.id === wanted) || null;
}

/** A model is retired when its vendor has shut the id down. Retired ids are
    rejected before any outbound call — unless the provider's own live catalog
    still lists one, in which case our marking is the stale side. */
function isRetiredModel(id, pid) {
  const meta = modelMeta(id, pid);
  if (!meta || meta.tier !== 'retired') return false;
  return !liveSnapshot(provider(pid || activeId()).id).ids.includes(String(id || '').trim());
}

/** A model is known if it is in the static list, in the live list, or (for
    providers flagged allowCustom) any plausible id the admin typed. */
function isKnownModel(id, pid) {
  const p = provider(pid || activeId());
  const wanted = String(id || '').trim();
  if (!wanted) return false;
  const meta = p.models.find((m) => m.id === wanted) || null;
  const snapshot = liveSnapshot(p.id);
  const live = snapshot.ids;
  /* A vendor-shutdown id is rejected outright — unless the provider's own
     live catalog still lists it, in which case our marking is the stale one
     and the id stays usable. */
  if (meta && meta.tier === 'retired') return live.includes(wanted);
  /* Once a provider has returned a NON-EMPTY catalog, treat it as
     authoritative. This is the important stale-selection guard: a model that
     disappeared from a provider's own catalog must not be sent just because
     it remains in our compatibility registry. An empty live list is never
     authoritative — some /models endpoints omit chat SKUs, and a transient
     empty response must not nuke the whole picker. Custom gateways are
     intentionally different — their operator owns the catalog. */
  if (snapshot.checked_at && live.length) return live.includes(wanted) || (p.allowCustom && looksLikeModelId(wanted));
  if (meta) return true;
  if (p.allowCustom && looksLikeModelId(wanted)) return true;
  return false;
}

/** Models with no metadata (custom ids) are assumed capable on openai-format
    providers — the alternative is refusing a gateway we cannot introspect. */
function capabilities(id, pid) {
  const meta = modelMeta(id, pid);
  if (meta) return { tools: Boolean(meta.tools), json: Boolean(meta.json), vision: Boolean(meta.vision) };
  const p = provider(pid || activeId());
  const openaiish = p.format === 'openai' || p.format === 'anthropic' || p.format === 'gemini' || p.format === 'cohere';
  return { tools: openaiish, json: openaiish, vision: false };
}

function supportsTools(id, pid) { return capabilities(id, pid).tools; }
function supportsJson(id, pid) { return capabilities(id, pid).json; }

function modelFor(pid) {
  const p = provider(pid);
  const saved = String(getSetting(`llm_model_${p.id}`, '') || '').trim();
  const legacy = p.legacyModelSetting ? String(getSetting(p.legacyModelSetting, '') || '').trim() : '';
  const savedMeta = saved ? modelMeta(saved, p.id) : null;
  const legacyMeta = legacy ? modelMeta(legacy, p.id) : null;
  const liveSnapshotForSelection = liveSnapshot(p.id);
  const live = liveSnapshotForSelection.ids;
  /* A saved compatibility row is retained, but a newly resolved request must
     not keep selecting a model explicitly marked legacy or retired when a
     current default exists. */
  const staleTier = (meta) => Boolean(meta && (meta.tier === 'legacy' || meta.tier === 'retired'));
  const preferredSaved = staleTier(savedMeta) ? '' : saved;
  const preferredLegacy = staleTier(legacyMeta) ? '' : legacy;
  const candidates = [preferredSaved, preferredLegacy, p.defaultModel, ...(p.fallbacks || []), ...p.models.filter((m) => m.tier !== 'legacy' && m.tier !== 'retired').map((m) => m.id)];
  if (liveSnapshotForSelection.checked_at && live.length) {
    const liveSet = new Set(live);
    const selected = candidates.find((id) => id && liveSet.has(id));
    if (selected) return selected;
    /* A provider may expose a model not yet in our curated catalog. Once its
       own chat catalog is authoritative, use its first chat-capable row rather
       than failing or sending a stale static default. This is safe for normal
       providers because the ID came from their authenticated /models response;
       custom gateways retain their operator-supplied IDs as well. */
    if (live[0]) return live[0];
    return '';
  }
  /* Without a live catalog, only resolve to ids this console actually knows —
     a stale saved id (renamed or retired upstream) falls through to the
     current default instead of being sent to the wire to 404. */
  return candidates.find((id) => id && isKnownModel(id, p.id)) || '';
}

function setModel(pid, id) {
  const p = provider(pid);
  const v = String(id == null ? '' : id).trim().slice(0, 160);
  setSetting(`llm_model_${p.id}`, v);
  if (p.legacyModelSetting) setSetting(p.legacyModelSetting, v);
  return v;
}

/* ---------------------- tool-capability fallback resolution ---------------- */

/**
 * The model a provider can actually run console actions with, or '' when the
 * provider is retired, unconfigured, or none of its reachable models supports
 * tool calling (Perplexity Sonar, Groq Compound, reasoning-only ids…).
 * Preference order: the operator's saved pick, the provider default, the
 * curated fallbacks, the rest of the catalogue, then live discoveries.
 */
function toolCapableModel(pid) {
  const p = provider(pid);
  if (p.status === 'retired' || !configured(pid)) return '';
  const { ids: live } = liveSnapshot(p.id);
  const saved = String(getSetting(`llm_model_${p.id}`, '') || '').trim();
  const order = [saved, p.defaultModel, ...(p.fallbacks || []), ...p.models.map((m) => m.id), ...live];
  for (const id of order) {
    if (id && isKnownModel(id, p.id) && supportsTools(id, p.id)) return id;
  }
  return '';
}

/**
 * Another configured provider with a tool-capable model — the target when the
 * active provider cannot run tool calls, so the assistant keeps doing real
 * work instead of only talking. Keyed providers (in registry order) win;
 * keyless local gateways (Ollama) only come in when no keyed provider is
 * configured. null when nothing can execute.
 */
function toolFallbackProvider(pid) {
  const skip = String(pid || '').trim();
  const withKey = [];
  const keyless = [];
  for (const p of PROVIDERS) {
    if (p.id === skip || p.status === 'retired') continue;
    if (!configured(p.id)) continue;
    const model = toolCapableModel(p.id);
    if (!model) continue;
    (p.needsKey === false ? keyless : withKey).push({ provider: p.id, model });
  }
  return withKey[0] || keyless[0] || null;
}

/* ------------------------------------------------ live availability cache */

function liveSnapshot(pid) {
  const p = provider(pid);
  let ids = [];
  let checked = '';
  try { ids = JSON.parse(getSetting(`llm_live_${p.id}`, '[]') || '[]'); } catch { ids = []; }
  checked = String(getSetting(`llm_live_checked_${p.id}`, '') || '');
  if (!Array.isArray(ids)) ids = [];
  return { ids: ids.map(String), checked_at: checked };
}

function liveAgeMs(pid) {
  const { checked_at } = liveSnapshot(pid);
  const t = Date.parse(checked_at ? `${checked_at.replace(' ', 'T')}Z` : '');
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}

function liveModelIds(pid) { return liveSnapshot(pid).ids; }

function markLiveModels(pid, ids) {
  const p = provider(pid);
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x).trim()).filter(Boolean))];
  setSetting(`llm_live_${p.id}`, JSON.stringify(clean).slice(0, 40000));
  setSetting(`llm_live_checked_${p.id}`, new Date().toISOString().replace('T', ' ').slice(0, 19));
  return clean;
}

/** Static models decorated with what this key can actually reach.
    Retired vendor ids are hidden (auto-removal) unless the provider's own
    live catalog still lists them; live discoveries are appended (auto-add). */
function usableModels(pid) {
  const p = provider(pid);
  const { ids, checked_at } = liveSnapshot(p.id);
  const live = new Set(ids);
  const authoritative = ids.length > 0;
  const rows = p.models
    .filter((m) => m.tier !== 'retired' || live.has(m.id))
    .map((m) => ({
      ...m,
      /* A retired id the vendor still serves is our marking gone stale — show
         it as a live discovery, not as a retired row. */
      ...(m.tier === 'retired' ? { tier: 'live', note: 'Vendor lists this id again — kept available.' } : {}),
      provider: p.id,
      available: authoritative ? live.has(m.id) : null,
    }))
    .map((m) => ({ ...m, checked_at: checked_at || '' }));
  /* Surface authenticated provider discoveries in the Admin picker as well as
     the JSON endpoint. This lets an account use a newly released model before
     the curated compatibility rows are updated, while the live catalog keeps
     stale static rows visibly unavailable. */
  const known = new Set(rows.map((m) => m.id));
  for (const id of ids) {
    if (known.has(id)) continue;
    rows.push({
      id, label: id, tier: 'live', note: 'Discovered from this provider’s live chat model catalog.',
      tools: true, json: true, vision: false, context: 0, maxOutput: 0,
      provider: p.id, available: true, checked_at: checked_at || '',
    });
  }
  /* Classify free-tier availability for every row — curated entries carry
     their own flag, live discoveries are classified by FREE_LIVE_PATTERNS. */
  return rows.map((m) => ({ ...m, free: m.free === true || isFreeModel(m.id, p.id) }));
}

/**
 * The models the AI Playground offers: only models that run on a free tier,
 * so the console never proposes a model a free key cannot use or that bills
 * per token. New free models flow in automatically — the live catalog sync
 * classifies discoveries through the same filter. Providers with no free
 * tier at all keep their full catalog (an empty picker would be useless),
 * and a currently selected non-free model stays listed so the operator can
 * see and change the active pick.
 */
function playgroundModels(pid) {
  const p = provider(pid);
  const all = usableModels(p.id);
  const free = all.filter((m) => m.free);
  if (!free.length) return all;
  const rows = free.slice();
  const current = modelFor(p.id);
  if (current && !rows.some((m) => m.id === current)) {
    const cur = all.find((m) => m.id === current);
    if (cur) {
      rows.unshift({
        ...cur,
        note: `${cur.note || ''} Not a free-tier model — kept listed because it is the current pick.`.trim(),
      });
    }
  }
  return rows;
}

/* ---------------------------------------------------------- rate limiting */

const recentCalls = new Map(); // provider id -> timestamps

function chargeLocal(pid) {
  const now = Date.now();
  const p = provider(pid);
  let arr = recentCalls.get(p.id) || [];
  arr = arr.filter((t) => now - t <= RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX_PER_MIN) {
    recentCalls.set(p.id, arr);
    throw new LLMError(`${p.label} rate limit — wait a minute and try again.`, {
      status: 429, code: 'rate_limited', retryAfterSec: 60, provider: p.id,
    });
  }
  arr.push(now);
  recentCalls.set(p.id, arr);
}

/* --------------------------------------------------------- HTTP plumbing */

async function send(url, pid, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const p = provider(pid);
  try {
    return await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(pid),
        ...extraHeaders(pid),
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new LLMError(`${p.label} timed out after ${Math.round(timeoutMs / 1000)} seconds. Try again.`, {
        status: 504, code: 'timeout', provider: p.id,
      });
    }
    throw new LLMError(`Could not reach ${p.label}: ${e.message || 'network error'}`, {
      status: 502, code: 'network', provider: p.id,
    });
  } finally {
    clearTimeout(timer);
  }
}

function describeHttpError(res, data, pid) {
  const p = provider(pid);
  const apiMsg = (data && data.error && (data.error.message || data.error.code))
    || (data && data.message) || (typeof data === 'string' ? data : '') || '';
  if (res.status === 401 || res.status === 403) {
    return {
      message: `${p.label} rejected the API key. Check the key saved in Admin → AI Playground → Model providers (or the ${p.env.join(' / ')} environment variable).`,
      code: 'invalid_key', status: res.status,
    };
  }
  if (res.status === 429) {
    return { message: `${p.label} is rate-limiting this key. Retry shortly.`, code: 'llm_rate', status: 429 };
  }
  /* Out-of-credits is a billing state, not a gateway outage and not a model
     problem: every model on the key shares the same balance, so no fallback
     or retry is attempted — the operator must top up first. Surfaced as 402
     (not 502) so the console never mislabels it as a Bad Gateway. */
  if (res.status === 402
    || (/payment required|insufficient (credits?|balance|funds|quota)|out of credits|top[ -]?up|delinquent|billing/i.test(String(apiMsg)) && res.status >= 400 && res.status < 500)) {
    return {
      message: `${p.label} is out of credits (HTTP 402). Top up billing at ${p.keysUrl || 'the provider dashboard'} — the key itself is fine, the account just needs funds. Nothing was retried because every model on this key shares the same balance.`,
      code: 'payment_required', status: 402,
    };
  }
  if (res.status === 404 || /decommission|no longer available|does not exist|not found|unknown model|invalid model|model_not_found|is not found/i.test(String(apiMsg))) {
    return { message: apiMsg || 'That model is not available on this key.', code: 'model_unavailable', status: 502 };
  }
  if (/tool/i.test(String(apiMsg)) && /support|not.*(allow|enable)|unavailable/i.test(String(apiMsg))) {
    return { message: `${apiMsg} — switch to a model with tool support.`, code: 'tools_unsupported', status: 422 };
  }
  /* A malformed or incompatible request is an operator/model configuration
     problem, not a gateway outage. Returning 422 keeps the Admin UI from
     mislabeling provider validation failures as 502 Bad Gateway. */
  if (res.status === 400 || res.status === 422) {
    const modelIssue = /model|unsupported|parameter|field|max_tokens|temperature|response.?format|json|tool/i.test(String(apiMsg));
    return {
      message: apiMsg || `${p.label} rejected the request.`,
      code: modelIssue ? 'model_incompatible' : 'provider_request',
      status: 422,
    };
  }
  if (res.status >= 400 && res.status < 500) {
    return { message: apiMsg || `${p.label} rejected the request (HTTP ${res.status}).`, code: 'provider_request', status: res.status };
  }
  if (res.status >= 500) {
    return { message: apiMsg || `${p.label} returned HTTP ${res.status}.`, code: 'upstream_error', status: 502 };
  }
  return { message: apiMsg || `${p.label} HTTP ${res.status}`, code: 'llm_http', status: 502 };
}

/* --------------------------------------------- wire format: request build */

/** Split OpenAI-style messages into { system, turns }. */
function splitSystem(messages) {
  const system = [];
  const turns = [];
  for (const m of messages) {
    if (m && m.role === 'system') system.push(String(m.content || ''));
    else turns.push(m);
  }
  return { system: system.filter(Boolean).join('\n\n'), turns };
}

function toAnthropicBody(opts, pid, model) {
  const { system, turns } = splitSystem(opts.messages || []);
  const content = [];
  for (const m of turns) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (m.role === 'tool') continue; // folded in below
    const blocks = [];
    if (m.content) blocks.push({ type: 'text', text: String(m.content) });
    for (const c of calls) {
      blocks.push({
        type: 'tool_use',
        id: c.id || `call_${content.length}`,
        name: (c.function && c.function.name) || c.name || '',
        input: parseToolArgs(c.function && c.function.arguments, c.arguments),
      });
    }
    if (!blocks.length) blocks.push({ type: 'text', text: '' });
    content.push({ role, content: blocks });
  }
  /* Tool results must arrive as one user turn carrying tool_result blocks. */
  for (const m of turns) {
    if (m.role !== 'tool') continue;
    const block = {
      type: 'tool_result',
      tool_use_id: m.tool_call_id || 'call_1',
      content: String(m.content || '').slice(0, 20000),
    };
    let last = content[content.length - 1];
    if (!last || last.role !== 'user' || !Array.isArray(last.content)) {
      last = { role: 'user', content: [] };
      content.push(last);
    }
    last.content.push(block);
  }
  const body = {
    model,
    messages: content,
    max_tokens: Math.max(256, Math.min(opts.max_tokens || 1024, 64000)),
  };
  if (system) body.system = system;
  /* Current Claude 5 models require temperature=1 or unset (Fable adaptive
     thinking is always on). Leaving the app's legacy temperature out avoids a
     provider 400 while preserving it for older Claude compatibility rows. */
  if (opts.temperature != null && !/^claude-(?:fable|opus|sonnet)-5/.test(model)) {
    body.temperature = Math.max(0, Math.min(1, Number(opts.temperature)));
  }
  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));
    if (opts.tool_choice === 'required') body.tool_choice = { type: 'any' };
    else if (opts.tool_choice === 'none') body.tool_choice = { type: 'none' };
  }
  return body;
}

function geminiPartsFromText(text) { return [{ text: String(text || '') }]; }

/** Gemini's schema validator is stricter than OpenAI's: besides the JSON
    Schema extras it rejects empty-string enum values ("enum[3]: cannot be
    empty"). Filter those out at the wire level so a loose tool definition
    can never turn an assistant call into a 400. */
function stripSchemaNoise(node) {
  if (Array.isArray(node)) return node.map(stripSchemaNoise);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'additionalProperties' || k === '$schema') continue;
    if (k === 'enum' && Array.isArray(v)) {
      const clean = v.filter((x) => String(x == null ? '' : x).trim() !== '');
      /* An enum with nothing left is no constraint at all — drop it. */
      if (!clean.length) continue;
      out[k] = clean;
      continue;
    }
    out[k] = stripSchemaNoise(v);
  }
  return out;
}

function toGeminiBody(opts, pid, model) {
  const { system, turns } = splitSystem(opts.messages || []);
  const contents = [];
  for (const m of turns) {
    if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: m.name || 'tool', response: { result: safeParse(m.content) } } }],
      });
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    if (m.content) parts.push(...geminiPartsFromText(m.content));
    for (const c of (Array.isArray(m.tool_calls) ? m.tool_calls : [])) {
      parts.push({ functionCall: { name: (c.function && c.function.name) || c.name, args: parseToolArgs(c.function && c.function.arguments, c.arguments) } });
    }
    if (!parts.length) parts.push({ text: '' });
    contents.push({ role, parts });
  }
  const body = { contents };
  if (system) body.system_instruction = { parts: [{ text: system }] };
  const gen = {};
  /* Gemini 3.x uses thinking levels and rejects the legacy sampling controls
     on current stable models. Gemini 2.5 compatibility rows retain the old
     temperature behavior. */
  if (opts.temperature != null && !/^gemini-3\./.test(model)) gen.temperature = Number(opts.temperature);
  /* Deep thinking is intentionally never forced on the wire: every model
     runs with its own default thinking behavior, so free-tier keys are not
     charged extra thinking tokens and the playground has no "deep thinking"
     mode to speak of. */
  if (opts.max_tokens) gen.maxOutputTokens = Number(opts.max_tokens);
  if (opts.response_format && opts.response_format.type === 'json_object') gen.responseMimeType = 'application/json';
  if (Object.keys(gen).length) body.generationConfig = gen;
  if (opts.tools && opts.tools.length) {
    body.tools = [{
      functionDeclarations: opts.tools.map((t) => ({
        name: t.function.name,
        description: String(t.function.description || '').slice(0, 1000),
        parameters: stripSchemaNoise(t.function.parameters || { type: 'object', properties: {} }),
      })),
    }];
    if (opts.tool_choice === 'required') body.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    else if (opts.tool_choice === 'none') body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
  }
  return body;
}

function geminiChatUrl(pid, model) {
  return `${baseUrlFor(pid)}/models/${encodeURIComponent(model)}:generateContent`;
}

function toCohereBody(opts, pid, model) {
  const body = {
    model,
    messages: (opts.messages || []).map((m) => ({ role: m.role === 'tool' ? 'user' : m.role, content: String(m.content || '') })),
    max_tokens: Math.max(256, Number(opts.max_tokens || 1024)),
  };
  if (opts.temperature != null) body.temperature = Number(opts.temperature);
  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.function.name,
        description: t.function.description || '',
        parameters: t.function.parameters || { type: 'object', properties: {} },
      },
    }));
    /* Cohere v2 has no "any" mode — a forced call degrades to auto there;
       the OpenAI-compatible providers carry the 'required' spelling. */
    if (opts.tool_choice === 'none') body.tool_choice = { type: 'none' };
  }
  return body;
}

/**
 * Which output-limit field an OpenAI-compatible wire accepts for this model.
 *
 * `max_tokens` is the legacy spelling. Groq deprecated it in favour of
 * `max_completion_tokens` (their current API reference uses the new name for
 * every model), and OpenAI's reasoning families — the o-series, GPT-5.x and
 * GPT-OSS — reject `max_tokens` outright with a 400. That 400 is what the
 * console was surfacing as a wall of 502s in the AI Playground: every call
 * to the default model carried a field the provider refuses.
 */
function completionTokenField(model, pid) {
  const id = String(model || '').toLowerCase();
  if (pid === 'groq') return 'max_completion_tokens';
  if (/^o\d/.test(id) || /gpt-[56]|gpt-oss|reasoner|magistral/.test(id)) return 'max_completion_tokens';
  return 'max_tokens';
}

function toOpenAiBody(opts, pid, model) {
  const p = provider(pid);
  const lowerModel = String(model || '').toLowerCase();
  const reasoning = /^o\d/.test(model) || /o3-mini|o4-mini|gpt-[56]|gpt-oss/.test(lowerModel);
  const deepseekV4 = p.id === 'deepseek' && /^deepseek-v4-/.test(lowerModel);
  const messages = (opts.messages || []).map((m) => {
    /* DeepSeek V4 requires reasoning_content on assistant turns that contain
       tool calls. Preserve the provider's returned field when present; the
       empty value keeps a hand-built follow-up valid for gateways that only
       require the property to exist. */
    if (deepseekV4 && m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      return { ...m, reasoning_content: m.reasoning_content == null ? '' : m.reasoning_content };
    }
    return m;
  });
  const payload = { model, messages, [completionTokenField(model, p.id)]: opts.max_tokens || 1800 };
  if (!reasoning && !deepseekV4 && opts.temperature != null) payload.temperature = opts.temperature;
  /* DeepSeek V4: no forced deep-thinking mode — the model runs with its
     default behavior, which keeps free/cheap credits from being burned on
     reasoning tokens the operator never asked for. */
  if (opts.tools && opts.tools.length) payload.tools = opts.tools;
  /* DeepSeek V4 supports tool calls but not the OpenAI tool_choice control. */
  if (opts.tools && opts.tools.length && opts.tool_choice && !deepseekV4) payload.tool_choice = opts.tool_choice;
  if (opts.response_format && supportsJson(model, p.id)) payload.response_format = opts.response_format;
  /* Groq's Qwen 3.6 / 3.8 models require reasoning_format "hidden" whenever
     tool calling or JSON mode is used — without it the request 400s. GPT-OSS
     does not support the parameter at all, so it is only set for the Qwen
     ids. */
  if (p.id === 'groq' && /^qwen\/qwen3\.[68]-27b$/.test(model)
    && ((opts.tools && opts.tools.length)
      || (opts.response_format && opts.response_format.type === 'json_object'))) {
    payload.reasoning_format = 'hidden';
  }
  return payload;
}

function safeParse(raw) {
  try { return JSON.parse(raw); } catch { return { text: String(raw || '') }; }
}

function parseToolArgs(raw, fallback) {
  if (fallback && typeof fallback === 'object') return fallback;
  if (raw && typeof raw === 'object') return raw;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { _raw: String(raw) }; }
}

/* -------------------------------------------- wire format: response parse */

/** Every provider is normalised into the OpenAI chat shape the rest of the
    console already understands. */
function normalizeResponse(data, pid, model) {
  const p = provider(pid);
  if (p.format === 'anthropic') {
    const text = [];
    const calls = [];
    for (const block of (data.content || [])) {
      if (block.type === 'text') text.push(block.text || '');
      if (block.type === 'tool_use') {
        calls.push({ id: block.id || `call_${calls.length + 1}`, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
      }
    }
    return {
      choices: [{ message: { role: 'assistant', content: text.join(''), ...(calls.length ? { tool_calls: calls } : {}) } }],
      usage: data.usage ? {
        prompt_tokens: Number(data.usage.input_tokens) || 0,
        completion_tokens: Number(data.usage.output_tokens) || 0,
        total_tokens: (Number(data.usage.input_tokens) || 0) + (Number(data.usage.output_tokens) || 0),
      } : null,
      _model: data.model || model,
      _provider: p.id,
    };
  }
  if (p.format === 'gemini') {
    const cand = (data.candidates || [])[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    const text = parts.filter((x) => x.text).map((x) => x.text).join('');
    const calls = parts.filter((x) => x.functionCall).map((x, i) => ({
      id: x.functionCall.id || `call_${i + 1}`,
      type: 'function',
      function: { name: x.functionCall.name, arguments: JSON.stringify(x.functionCall.args || {}) },
    }));
    const u = data.usageMetadata || {};
    return {
      choices: [{
        message: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) },
        finish_reason: cand ? String(cand.finishReason || '').toLowerCase() : '',
      }],
      usage: u ? {
        prompt_tokens: Number(u.promptTokenCount) || 0,
        completion_tokens: Number(u.candidatesTokenCount) || 0,
        total_tokens: Number(u.totalTokenCount) || 0,
      } : null,
      _model: model,
      _provider: p.id,
      _blocked: Boolean(data.promptFeedback && data.promptFeedback.blockReason),
      _block_reason: (data.promptFeedback && data.promptFeedback.blockReason) || '',
    };
  }
  if (p.format === 'cohere') {
    const msg = data.message || {};
    const text = (msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const calls = (msg.tool_calls || []).map((c, i) => ({
      id: c.id || `call_${i + 1}`,
      type: 'function',
      function: {
        name: (c.function && c.function.name) || c.name || '',
        arguments: (c.function && c.function.arguments) || JSON.stringify(c.parameters || {}),
      },
    }));
    const tokens = (data.meta && data.meta.tokens) || {};
    return {
      choices: [{ message: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) } }],
      usage: {
        prompt_tokens: Number((tokens.input && tokens.input.tokens)) || 0,
        completion_tokens: Number((tokens.output && tokens.output.tokens)) || 0,
        total_tokens: (Number((tokens.input && tokens.input.tokens)) || 0) + (Number((tokens.output && tokens.output.tokens)) || 0),
      },
      _model: model,
      _provider: p.id,
    };
  }
  /* openai-compatible: pass through, tagged. */
  return { ...data, _model: data.model || model, _provider: p.id };
}

/* ----------------------------------------------------------- model listing */

async function fetchLiveModels(pid) {
  const p = provider(pid);
  if (!p.listModels) return [];
  const url = p.listModels === 'gemini'
    ? `${baseUrlFor(pid)}/models?pageSize=1000`
    : modelsUrl(pid);
  const res = await send(url, pid, { method: 'GET' }, 15_000);
  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!res.ok) {
    const info = describeHttpError(res, data, pid);
    throw new LLMError(info.message, { status: info.status, code: info.code, provider: p.id });
  }
  let rows = [];
  if (Array.isArray(data.data)) rows = data.data;
  else if (Array.isArray(data.models)) rows = data.models;
  return rows
    .map((r) => ({
      raw: r,
      id: String(typeof r === 'string' ? r : (r && (r.id || r.name)) || '').trim(),
    }))
    .map((row) => ({ ...row, id: p.format === 'gemini' ? row.id.replace(/^models\//, '') : row.id }))
    .filter((row) => row.id && looksLikeModelId(row.id))
    /* /models endpoints often include embeddings, image, audio and rerank
       SKUs. They are real models, but not valid inputs to this chat gateway. */
    .filter((row) => {
      const id = row.id.toLowerCase();
      const rawRow = row.raw && typeof row.raw === 'object' ? row.raw : {};
      const caps = rawRow.capabilities || rawRow.capability || {};
      if (caps.chat === false || caps.chat_completions === false || caps.text_generation === false) return false;
      return !/(^|[\/._-])(embedding|embed|rerank|moderation|whisper|transcri|tts|speech|audio|image|video|live|translate|music|lyria|veo|imagen|ocr)([\/._:-]|$)/i.test(id);
    })
    .map((row) => row.id);
}

async function syncModels(pid) {
  const id = pid || activeId();
  const p = provider(id);
  if (!p.listModels) {
    return { provider: id, count: 0, skipped: 'no_list_endpoint', selected_available: null, missing: [] };
  }
  const ids = await fetchLiveModels(id);
  if (!ids.length) {
    /* Never let an empty response wipe a good catalog: some /models endpoints
       omit chat SKUs or hiccup transiently. Keep the previous snapshot so the
       picker and the stale-selection guard stay intact. */
    const prev = liveSnapshot(id);
    return { provider: id, count: 0, empty: true, kept: prev.ids.length, selected_available: null, missing: [] };
  }
  markLiveModels(id, ids);
  const set = new Set(ids);
  return {
    provider: id,
    count: ids.length,
    selected_available: ids.includes(modelFor(id)),
    missing: p.models.filter((m) => m.tier !== 'retired' && !set.has(m.id)).map((m) => m.id),
    added: ids.filter((x) => !p.models.some((m) => m.id === x)),
  };
}

/**
 * Refresh every configured provider's catalog (auto-add new models, flag
 * removed ones unavailable). With onlyStale (the default) providers synced
 * within LIVE_TTL_MS are skipped, so the hourly upkeep tick stays cheap.
 */
async function syncAllProviders({ onlyStale = true } = {}) {
  const results = [];
  for (const p of PROVIDERS) {
    if (!p.listModels) continue;
    if (p.status === 'retired') continue;
    if (!configured(p.id)) continue;
    if (onlyStale && liveAgeMs(p.id) < LIVE_TTL_MS) {
      results.push({ provider: p.id, skipped: 'fresh', count: liveSnapshot(p.id).ids.length });
      continue;
    }
    try {
      results.push(await syncModels(p.id));
    } catch (e) {
      results.push({ provider: p.id, ok: false, error: e.message, code: e.code || 'sync_failed' });
    }
  }
  return results;
}

/** Background refresh at most every LIVE_TTL_MS — never blocks a request. */
function maybeSyncModels(pid) {
  const id = pid || activeId();
  const p = provider(id);
  if (!p.listModels) return;
  if (!configured(id)) return;
  if (liveAgeMs(id) < LIVE_TTL_MS) return;
  setImmediate(() => { syncModels(id).catch(() => { /* surfaced by the manual button */ }); });
}

/* --------------------------------------------------------------- the call */

async function postOnce(pid, model, opts) {
  const p = provider(pid);
  let url; let body;
  if (p.format === 'anthropic') { url = chatUrl(pid); body = toAnthropicBody(opts, pid, model); } else if (p.format === 'gemini') { url = geminiChatUrl(pid, model); body = toGeminiBody(opts, pid, model); } else if (p.format === 'cohere') { url = chatUrl(pid); body = toCohereBody(opts, pid, model); } else { url = chatUrl(pid); body = toOpenAiBody(opts, pid, model); }

  const res = await send(url, pid, { method: 'POST', body: JSON.stringify(body) }, 60_000);
  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!res.ok) {
    const info = describeHttpError(res, data, pid);
    const err = new LLMError(info.message, { status: info.status, code: info.code, provider: p.id });
    err.httpStatus = res.status;
    err.body = data;
    if (res.status === 429) err.retryAfterSec = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 8;
    throw err;
  }
  return normalizeResponse(data, pid, model);
}

/**
 * Chat completion against the chosen provider.
 *
 * `opts`: { provider, model, messages, tools, tool_choice, temperature,
 *           max_tokens, response_format, noFallback }
 * Messages use the OpenAI shape (system / user / assistant / tool) — the
 * provider translators in this file do the rest.
 */
async function chat(opts = {}) {
  const pid = String(opts.provider || '').trim() || activeId();
  const p = provider(pid);
  if (p.status === 'retired') {
    throw new LLMError(p.retiredNote || `${p.label} is no longer available.`, {
      status: 410, code: 'provider_retired', provider: p.id,
    });
  }
  const key = apiKey(pid);
  if (p.needsKey !== false && !key) {
    throw new LLMError(
      `${p.label} is not configured. Set ${p.env.join(' or ')} in .env, or paste a key in Admin → AI Playground → Settings → Model providers.`,
      { status: 503, code: 'not_configured', provider: p.id }
    );
  }
  if (p.format !== 'gemini' && !baseUrlFor(pid)) {
    throw new LLMError(`${p.label} needs a base URL — set CUSTOM_LLM_BASE_URL or fill it in under Model providers.`, {
      status: 503, code: 'not_configured', provider: p.id,
    });
  }
  chargeLocal(pid);
  maybeSyncModels(pid);

  const requested = String(opts.model || '').trim();
  if (requested && !isKnownModel(requested, pid)) {
    throw new LLMError(`“${requested.slice(0, 60)}” is not a model this console knows for ${p.label}. Pick one in Settings → Model providers.`, {
      status: 422, code: 'bad_model', provider: p.id,
    });
  }
  const primary = requested || modelFor(pid);
  if (!primary) {
    throw new LLMError(`${p.label} has no model selected. Choose one under Settings → Model providers.`, {
      status: 503, code: 'not_configured', provider: p.id,
    });
  }
  const chain = opts.noFallback ? [primary] : [primary, ...(p.fallbacks || []).filter((m) => m !== primary && isKnownModel(m, pid))];
  const needsTools = Boolean(opts.tools && opts.tools.length);

  let lastErr;
  const tried = [];
  for (const model of chain) {
    if (tried.includes(model)) continue;
    tried.push(model);
    /* Do not silently drop tools: that turns an agent request into a plain
       chat and can produce an apparently successful but functionally broken
       admin action. Try the next compatible model or return 422. */
    if (needsTools && !supportsTools(model, pid)) {
      lastErr = new LLMError(`${p.label} model “${model}” does not support tool calling. Choose a tool-capable model.`, {
        status: 422, code: 'tools_unsupported', provider: p.id,
      });
      if (chain.indexOf(model) < chain.length - 1) continue;
      throw lastErr;
    }
    const callOpts = { ...opts, tools: needsTools ? opts.tools : undefined };
    try {
      const data = await postOnce(pid, model, callOpts);
      data._model = data._model || model;
      data._provider = pid;
      return data;
    } catch (e) {
      lastErr = e;
      if (e.code === 'llm_rate') {
        await sleep(Math.min(12_000, (e.retryAfterSec || 4) * 1000));
        try {
          const data = await postOnce(pid, model, callOpts);
          data._model = data._model || model;
          data._provider = pid;
          return data;
        } catch (e2) { lastErr = e2; }
      }
      /* A transient provider outage (5xx from the upstream) usually clears in
         seconds — retry the same model once before surfacing the error, so a
         single blip does not reach the console as a 502. */
      if (lastErr.httpStatus >= 500 && lastErr.httpStatus <= 599) {
        await sleep(1200);
        try {
          const retried = await postOnce(pid, model, callOpts);
          retried._model = retried._model || model;
          retried._provider = pid;
          return retried;
        } catch (e2) { lastErr = e2; }
      }
      const retryable = ['model_unavailable', 'tools_unsupported', 'model_incompatible'].includes(lastErr.code);
      if (retryable && chain.indexOf(model) < chain.length - 1) {
        console.warn(`[llm:${pid}] model unusable, falling back:`, model, lastErr.message);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr || new LLMError('Model request failed.', { provider: pid });
}

/* ------------------------------------------------------------- accessors */

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

/** What the console shows on the key line — no secrets, only hints. */
function providerView(pid) {
  const p = provider(pid);
  const live = liveSnapshot(p.id);
  const src = keySource(pid);
  const models = playgroundModels(pid);
  return {
    id: p.id,
    status: p.status || 'active',
    retired: p.status === 'retired',
    retired_note: p.retiredNote || '',
    label: p.label,
    vendor: p.vendor,
    blurb: p.blurb,
    format: p.format,
    base_url: baseUrlFor(pid),
    default_base: String(p.base || ''),
    env: p.env || [],
    needs_key: p.needsKey !== false,
    key_source: src,
    key_set: Boolean(src),
    key_hint: maskKey(apiKey(pid)),
    configured: configured(pid),
    model: modelFor(pid),
    default_model: p.defaultModel || '',
    /* The playground offers free-tier models only (see playgroundModels) —
       providers without any free tier keep their full catalog. */
    models,
    free_only: models.length > 0 && models.every((m) => m.free),
    allow_custom: Boolean(p.allowCustom),
    list_models: Boolean(p.listModels),
    sync_supported: Boolean(p.listModels),
    live_models: live.ids,
    live_checked_at: live.checked_at,
    live_stale: liveAgeMs(p.id) >= LIVE_TTL_MS,
    retired_hidden: p.models.filter((m) => m.tier === 'retired' && !live.ids.includes(m.id)).length,
    keys_url: p.keysUrl || '',
    active: activeId() === p.id,
  };
}

function providersView() { return PROVIDERS.map((p) => providerView(p.id)); }

function configuredProviders() { return PROVIDERS.filter((p) => configured(p.id)).map((p) => p.id); }

/** Cheap, side-effect-free probe used by the per-provider “Test” button. */
async function testConnection(pid, modelOverride) {
  const id = String(pid || '').trim() || activeId();
  const p = provider(id);
  const model = String(modelOverride || '').trim() || modelFor(id);
  if (p.status === 'retired') {
    return {
      ok: false, provider: id, provider_label: p.label, key_source: keySource(id), model,
      error: p.retiredNote || `${p.label} is no longer available.`, error_code: 'provider_retired',
    };
  }
  if (p.needsKey !== false && !apiKey(id)) {
    return {
      ok: false, provider: id, provider_label: p.label, key_source: '', model,
      error: `No ${p.label} key configured. Set ${p.env.join(' or ')} in .env or paste one in Model providers.`,
    };
  }
  const out = {
    ok: true, provider: id, provider_label: p.label, key_source: keySource(id),
    key_hint: maskKey(apiKey(id)), base: baseUrlFor(id), model,
  };
  try {
    if (p.listModels) {
      const ids = await fetchLiveModels(id);
      /* An empty listing never overwrites a good snapshot (see syncModels). */
      if (ids.length) markLiveModels(id, ids);
      else out.list_empty = true;
      out.models = ids;
      out.model_available = ids.length ? ids.includes(model) : null;
    }
  } catch (e) {
    out.list_error = e.message;
    if (e.code === 'invalid_key' || e.code === 'not_configured') return { ...out, ok: false, error: e.message };
  }
  try {
    const data = await chat({
      provider: id, model, temperature: 0, max_tokens: 8, noFallback: true,
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
  PROVIDERS, LLMError, DEFAULT_PROVIDER, RATE_MAX_PER_MIN,
  provider, providerView, providersView, configuredProviders,
  isValidProvider, isRetiredProvider, activeId, setActiveProvider,
  apiKey, setApiKey, keySource, configured, maskKey,
  baseUrlFor, setBaseUrl, chatUrl, modelsUrl,
  activeModels, activeDefaultModel, modelFor, setModel, modelMeta,
  isKnownModel, isRetiredModel, capabilities, supportsTools, supportsJson, looksLikeModelId,
  isFreeModel, playgroundModels,
  toolCapableModel, toolFallbackProvider,
  usableModels, liveModelIds, liveSnapshot, liveAgeMs, markLiveModels,
  fetchLiveModels, syncModels, syncAllProviders, maybeSyncModels, LIVE_TTL_MS,
  chat, assistantText, toolCalls, usage, testConnection,
  /* internals exposed for tests */
  _internal: {
    toOpenAiBody, toAnthropicBody, toGeminiBody, toCohereBody,
    normalizeResponse, splitSystem, stripSchemaNoise, completionTokenField,
  },
};
