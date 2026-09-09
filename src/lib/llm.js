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
    ],
  },

  {
    id: 'openai', label: 'OpenAI', vendor: 'OpenAI', format: 'openai', listModels: 'openai',
    blurb: 'GPT-4.1 / GPT-4o / o-series. Strongest general reasoning, paid per token.',
    base: 'https://api.openai.com/v1', env: ['OPENAI_API_KEY'],
    keyPlaceholder: 'sk-…', keysUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-4.1',
    fallbacks: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o-mini'],
    models: [
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
    defaultModel: 'claude-sonnet-4-5',
    fallbacks: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-3-5-haiku-latest'],
    models: [
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', tier: 'production', note: 'Best balance for the admin assistant.', tools: true, json: true, vision: true, context: 200000, maxOutput: 64000 },
      { id: 'claude-opus-4-1', label: 'Claude Opus 4.1', tier: 'production', note: 'Deepest reasoning, slowest and priciest.', tools: true, json: true, vision: true, context: 200000, maxOutput: 32000 },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tier: 'production', note: 'Fast and cheap; good for auto-moderation.', tools: true, json: true, vision: true, context: 200000, maxOutput: 64000 },
      { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku', tier: 'legacy', note: 'Previous cheap tier.', tools: true, json: true, vision: false, context: 200000, maxOutput: 8192 },
    ],
  },

  {
    id: 'gemini', label: 'Google Gemini', vendor: 'Google AI Studio', format: 'gemini', listModels: 'gemini',
    blurb: 'Gemini 2.5 Pro / Flash. Huge context, free tier available with a Google key.',
    base: 'https://generativelanguage.googleapis.com/v1beta', env: ['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    keyPlaceholder: 'AIza…', keysUrl: 'https://aistudio.google.com/app/apikey',
    defaultModel: 'gemini-2.5-flash',
    fallbacks: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'production', note: 'Fast, tool-capable, 1M context.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 65536 },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', tier: 'production', note: 'Cheapest Gemini; fine for bulk drafting.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 65536 },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'production', note: 'Strongest Gemini reasoning.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 65536 },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', tier: 'legacy', note: 'Previous generation.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 8192 },
    ],
  },

  {
    id: 'deepseek', label: 'DeepSeek', vendor: 'DeepSeek', format: 'openai', listModels: null,
    blurb: 'Very cheap strong models. deepseek-chat takes tools; the reasoner does not.',
    base: 'https://api.deepseek.com/v1', env: ['DEEPSEEK_API_KEY'],
    keyPlaceholder: 'sk-…', keysUrl: 'https://platform.deepseek.com/api_keys',
    defaultModel: 'deepseek-chat',
    fallbacks: ['deepseek-chat'],
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat (V3)', tier: 'production', note: 'General model with tool calling.', tools: true, json: true, vision: false, context: 65536, maxOutput: 8192 },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)', tier: 'production', note: 'Chain-of-thought — no tool calls, no JSON mode.', tools: false, json: false, vision: false, context: 65536, maxOutput: 65536 },
    ],
  },

  {
    id: 'huggingface', label: 'Hugging Face', vendor: 'HF Inference Providers', format: 'openai', listModels: 'openai',
    blurb: 'The HF Router: hundreds of open models behind one key, billed per provider.',
    base: 'https://router.huggingface.co/v1', env: ['HUGGINGFACE_API_KEY', 'HF_TOKEN'],
    keyPlaceholder: 'hf_…', keysUrl: 'https://huggingface.co/settings/tokens',
    allowCustom: true, defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    fallbacks: ['meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct'],
    models: [
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
    allowCustom: true, defaultModel: 'openai/gpt-4.1',
    fallbacks: ['openai/gpt-4.1', 'anthropic/claude-sonnet-4.5', 'google/gemini-2.5-flash'],
    models: [
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
    defaultModel: 'mistral-large-latest',
    fallbacks: ['mistral-large-latest', 'mistral-small-latest'],
    models: [
      { id: 'mistral-large-latest', label: 'Mistral Large', tier: 'production', note: 'Flagship with function calling.', tools: true, json: true, vision: false, context: 131072, maxOutput: 8192 },
      { id: 'mistral-small-latest', label: 'Mistral Small', tier: 'production', note: 'Cheap and quick.', tools: true, json: true, vision: false, context: 131072, maxOutput: 8192 },
      { id: 'magistral-medium-latest', label: 'Magistral Medium', tier: 'preview', note: 'Reasoning — no tool calls.', tools: false, json: false, vision: false, context: 40960, maxOutput: 40960 },
      { id: 'open-mistral-nemo', label: 'Mistral Nemo (open)', tier: 'legacy', note: '12B open weights.', tools: true, json: true, vision: false, context: 131072, maxOutput: 8192 },
    ],
  },

  {
    id: 'together', label: 'Together AI', vendor: 'Together', format: 'openai', listModels: 'openai',
    blurb: 'Dedicated open-model inference with serverless pricing.',
    base: 'https://api.together.xyz/v1', env: ['TOGETHER_API_KEY'],
    keyPlaceholder: '…', keysUrl: 'https://api.together.xyz/settings/api-keys',
    allowCustom: true, defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    fallbacks: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
    models: [
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
    defaultModel: 'grok-4',
    fallbacks: ['grok-4', 'grok-3', 'grok-3-mini'],
    models: [
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
    allowCustom: true, defaultModel: 'llama-3.3-70b',
    fallbacks: ['llama-3.3-70b', 'qwen-3-32b'],
    models: [
      { id: 'llama-3.3-70b', label: 'Llama 3.3 70B', tier: 'production', note: 'Fastest 70B anywhere.', tools: true, json: true, vision: false, context: 64000, maxOutput: 8192 },
      { id: 'qwen-3-32b', label: 'Qwen 3 32B', tier: 'production', note: 'Tool support, very high throughput.', tools: true, json: true, vision: false, context: 64000, maxOutput: 8192 },
      { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', tier: 'production', note: 'OpenAI open weights.', tools: true, json: true, vision: false, context: 128000, maxOutput: 65536 },
    ],
  },

  {
    id: 'sambanova', label: 'SambaNova', vendor: 'SambaNova Cloud', format: 'openai', listModels: 'openai',
    blurb: 'RDU inference for Llama, Qwen and DeepSeek at very low latency.',
    base: 'https://api.sambanova.ai/v1', env: ['SAMBANOVA_API_KEY'],
    keyPlaceholder: '…', keysUrl: 'https://cloud.sambanova.ai/apis',
    allowCustom: true, defaultModel: 'Meta-Llama-3.3-70B-Instruct',
    fallbacks: ['Meta-Llama-3.3-70B-Instruct', 'Qwen3-32B'],
    models: [
      { id: 'Meta-Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B', tier: 'production', note: 'Tool-calling.', tools: true, json: true, vision: false, context: 131072, maxOutput: 4096 },
      { id: 'Qwen3-32B', label: 'Qwen 3 32B', tier: 'production', note: 'Fast and cheap.', tools: true, json: true, vision: false, context: 16384, maxOutput: 4096 },
      { id: 'DeepSeek-R1-Distill-Llama-70B', label: 'DeepSeek R1 Distill 70B', tier: 'preview', note: 'Reasoning distill.', tools: false, json: false, vision: false, context: 131072, maxOutput: 8192 },
    ],
  },

  {
    id: 'fireworks', label: 'Fireworks AI', vendor: 'Fireworks', format: 'openai', listModels: 'openai',
    blurb: 'Fast serving of open models, compound AI and function calling.',
    base: 'https://api.fireworks.ai/inference/v1', env: ['FIREWORKS_API_KEY'],
    keyPlaceholder: 'fw_…', keysUrl: 'https://fireworks.ai/account/api-keys',
    allowCustom: true, defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    fallbacks: ['accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/qwen3-235b-a22b-instruct-2507'],
    models: [
      { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', label: 'Llama 3.3 70B Instruct', tier: 'production', note: 'Tool calling supported.', tools: true, json: true, vision: false, context: 131072, maxOutput: 4096 },
      { id: 'accounts/fireworks/models/qwen3-235b-a22b-instruct-2507', label: 'Qwen 3 235B Instruct', tier: 'production', note: 'Large MoE.', tools: true, json: true, vision: false, context: 262144, maxOutput: 32768 },
      { id: 'accounts/fireworks/models/deepseek-v3', label: 'DeepSeek V3', tier: 'production', note: 'Cheap large model.', tools: true, json: true, vision: false, context: 131072, maxOutput: 8192 },
    ],
  },

  {
    id: 'perplexity', label: 'Perplexity', vendor: 'Perplexity AI', format: 'openai', listModels: null,
    blurb: 'Search-grounded answers with citations. No tool calling — lookups only.',
    base: 'https://api.perplexity.ai', env: ['PERPLEXITY_API_KEY'],
    keyPlaceholder: 'pplx-…', keysUrl: 'https://www.perplexity.ai/settings/api',
    defaultModel: 'sonar',
    fallbacks: ['sonar', 'sonar-pro'],
    models: [
      { id: 'sonar', label: 'Sonar', tier: 'production', note: 'Fast, cited answers.', tools: false, json: true, vision: false, context: 128000, maxOutput: 8192 },
      { id: 'sonar-pro', label: 'Sonar Pro', tier: 'production', note: 'Deeper research.', tools: false, json: true, vision: false, context: 200000, maxOutput: 8192 },
      { id: 'sonar-reasoning', label: 'Sonar Reasoning', tier: 'production', note: 'Reasoning with citations.', tools: false, json: true, vision: false, context: 128000, maxOutput: 8192 },
    ],
  },

  {
    id: 'cohere', label: 'Cohere', vendor: 'Cohere', format: 'cohere', listModels: 'cohere',
    blurb: 'Command R+ / Command A — enterprise RAG and multilingual work.',
    base: 'https://api.cohere.com', env: ['COHERE_API_KEY'],
    keyPlaceholder: '…', keysUrl: 'https://dashboard.cohere.com/api-keys',
    defaultModel: 'command-a-03-2025',
    fallbacks: ['command-a-03-2025', 'command-r-plus-08-2024'],
    models: [
      { id: 'command-a-03-2025', label: 'Command A', tier: 'production', note: 'Cohere flagship with tools.', tools: true, json: true, vision: false, context: 256000, maxOutput: 8192 },
      { id: 'command-r-plus-08-2024', label: 'Command R+', tier: 'legacy', note: 'Previous flagship.', tools: true, json: true, vision: false, context: 128000, maxOutput: 4096 },
      { id: 'command-r-08-2024', label: 'Command R', tier: 'legacy', note: 'Cheaper tier.', tools: true, json: true, vision: false, context: 128000, maxOutput: 4096 },
    ],
  },

  {
    id: 'github', label: 'GitHub Models', vendor: 'GitHub', format: 'openai', listModels: 'openai',
    blurb: 'Free model playground keys for any GitHub account (rate limited).',
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
    allowCustom: true, defaultModel: 'llama3.3',
    fallbacks: ['llama3.3'],
    models: [
      { id: 'llama3.3', label: 'Llama 3.3', tier: 'production', note: 'Pull with `ollama pull llama3.3`.', tools: true, json: true, vision: false, context: 131072, maxOutput: 4096 },
      { id: 'qwen2.5', label: 'Qwen 2.5', tier: 'production', note: 'Pull with `ollama pull qwen2.5`.', tools: true, json: true, vision: false, context: 131072, maxOutput: 8192 },
      { id: 'gemma3', label: 'Gemma 3', tier: 'production', note: 'Vision-capable local model.', tools: false, json: true, vision: true, context: 131072, maxOutput: 8192 },
      { id: 'mistral', label: 'Mistral', tier: 'legacy', note: 'Small and fast.', tools: true, json: true, vision: false, context: 32768, maxOutput: 4096 },
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

function activeModels() { return provider(activeId()).models; }
function activeDefaultModel() { return modelFor(activeId()); }

function modelMeta(id, pid) {
  const p = provider(pid || activeId());
  const wanted = String(id || '').trim();
  if (!wanted) return null;
  return p.models.find((m) => m.id === wanted) || null;
}

/** A model is known if it is in the static list, in the live list, or (for
    providers flagged allowCustom) any plausible id the admin typed. */
function isKnownModel(id, pid) {
  const p = provider(pid || activeId());
  const wanted = String(id || '').trim();
  if (!wanted) return false;
  if (p.models.some((m) => m.id === wanted)) return true;
  if (liveModelIds(p.id).includes(wanted)) return true;
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
  if (saved) return saved;
  if (p.legacyModelSetting) {
    const legacy = String(getSetting(p.legacyModelSetting, '') || '').trim();
    if (legacy) return legacy;
  }
  return p.defaultModel || '';
}

function setModel(pid, id) {
  const p = provider(pid);
  const v = String(id == null ? '' : id).trim().slice(0, 160);
  setSetting(`llm_model_${p.id}`, v);
  if (p.legacyModelSetting) setSetting(p.legacyModelSetting, v);
  return v;
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

/** Static models decorated with what this key can actually reach. */
function usableModels(pid) {
  const p = provider(pid);
  const { ids, checked_at } = liveSnapshot(p.id);
  const live = new Set(ids);
  return p.models
    .map((m) => ({ ...m, provider: p.id, available: ids.length ? live.has(m.id) : null }))
    .map((m) => ({ ...m, checked_at: checked_at || '' }));
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
      code: 'invalid_key', status: 401,
    };
  }
  if (res.status === 429) {
    return { message: `${p.label} is rate-limiting this key. Retry shortly.`, code: 'llm_rate', status: 429 };
  }
  if (res.status === 404 || /decommission|no longer available|does not exist|not found|unknown model|invalid model|model_not_found|is not found/i.test(String(apiMsg))) {
    return { message: apiMsg || 'That model is not available on this key.', code: 'model_unavailable', status: 502 };
  }
  if (/tool/i.test(String(apiMsg)) && /support|not.*(allow|enable)|unavailable/i.test(String(apiMsg))) {
    return { message: `${apiMsg} — switch to a model with tool support.`, code: 'tools_unsupported', status: 502 };
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
  if (opts.temperature != null) body.temperature = Math.max(0, Math.min(1, Number(opts.temperature)));
  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));
    if (opts.tool_choice && opts.tool_choice !== 'auto') body.tool_choice = { type: 'auto' };
  }
  return body;
}

function geminiPartsFromText(text) { return [{ text: String(text || '') }]; }

function stripSchemaNoise(node) {
  if (Array.isArray(node)) return node.map(stripSchemaNoise);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'additionalProperties' || k === '$schema') continue;
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
  if (opts.temperature != null) gen.temperature = Number(opts.temperature);
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
    if (opts.tool_choice && opts.tool_choice !== 'auto') {
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }
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
  if (/^o\d/.test(id) || /gpt-5|gpt-oss|reasoner|magistral/.test(id)) return 'max_completion_tokens';
  return 'max_tokens';
}

function toOpenAiBody(opts, pid, model) {
  const p = provider(pid);
  const reasoning = /^o\d/.test(model) || /o3-mini|o4-mini/.test(model);
  const payload = { model, messages: opts.messages, [completionTokenField(model, p.id)]: opts.max_tokens || 1800 };
  if (!reasoning && opts.temperature != null) payload.temperature = opts.temperature;
  if (opts.tools && opts.tools.length) payload.tools = opts.tools;
  if (opts.tools && opts.tools.length && opts.tool_choice) payload.tool_choice = opts.tool_choice;
  if (opts.response_format && supportsJson(model, p.id) && !reasoning) payload.response_format = opts.response_format;
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
    .map((r) => String(typeof r === 'string' ? r : (r && (r.id || r.name)) || '')).filter(Boolean)
    .map((id) => (p.format === 'gemini' ? id.replace(/^models\//, '') : id));
}

async function syncModels(pid) {
  const id = pid || activeId();
  const ids = await fetchLiveModels(id);
  if (ids.length) markLiveModels(id, ids);
  const set = new Set(ids);
  const p = provider(id);
  return {
    provider: id,
    count: ids.length,
    selected_available: ids.includes(modelFor(id)),
    missing: p.models.filter((m) => !set.has(m.id)).map((m) => m.id),
  };
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
  const wantsTools = Boolean(opts.tools && opts.tools.length) && supportsTools(primary, pid);

  let lastErr;
  const tried = [];
  for (const model of chain) {
    if (tried.includes(model)) continue;
    tried.push(model);
    const callOpts = { ...opts, tools: wantsTools ? opts.tools : undefined };
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
      const retryable = lastErr.code === 'model_unavailable' || lastErr.code === 'tools_unsupported';
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
  const src = keySource(p.id);
  return {
    id: p.id,
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
    models: usableModels(pid),
    allow_custom: Boolean(p.allowCustom),
    list_models: Boolean(p.listModels),
    live_models: live.ids,
    live_checked_at: live.checked_at,
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
      if (ids.length) markLiveModels(id, ids);
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
  isValidProvider, activeId, setActiveProvider,
  apiKey, setApiKey, keySource, configured, maskKey,
  baseUrlFor, setBaseUrl, chatUrl, modelsUrl,
  activeModels, activeDefaultModel, modelFor, setModel, modelMeta,
  isKnownModel, capabilities, supportsTools, supportsJson, looksLikeModelId,
  usableModels, liveModelIds, liveSnapshot, markLiveModels,
  fetchLiveModels, syncModels, maybeSyncModels,
  chat, assistantText, toolCalls, usage, testConnection,
  /* internals exposed for tests */
  _internal: {
    toOpenAiBody, toAnthropicBody, toGeminiBody, toCohereBody,
    normalizeResponse, splitSystem, stripSchemaNoise, completionTokenField,
  },
};
