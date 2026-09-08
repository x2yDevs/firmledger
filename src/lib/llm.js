/**
 * FirmLedger model-provider layer — one chat() for every AI backend.
 *
 * The admin console is not tied to a single vendor any more. Admin → AI
 * Playground → Providers lets the operator paste a key for any of the
 * providers below, pick which one is live, and choose a model per provider.
 * Keys resolve env-first (so a deployment can hard-pin one) and fall back to
 * the value saved in the settings table; nothing is ever sent to the browser
 * beyond a masked hint.
 *
 * Three wire protocols are spoken, all normalised back to the OpenAI chat
 * shape the agent loop already uses ({ choices: [{ message: { content,
 * tool_calls } }], usage }):
 *
 *   openai     POST {base}/chat/completions        — Groq, OpenAI, DeepSeek,
 *                                                   OpenRouter, Hugging Face,
 *                                                   Mistral, Together, xAI,
 *                                                   Cerebras, Fireworks,
 *                                                   SambaNova, Perplexity,
 *                                                   Azure, any self-hosted
 *                                                   gateway (Ollama, vLLM,
 *                                                   LiteLLM, llama.cpp)
 *   anthropic  POST {base}/messages                — Claude (x-api-key,
 *                                                   anthropic-version, tool_use
 *                                                   / tool_result blocks)
 *   gemini     POST {base}/v1beta/models/{m}:generateContent
 *                                                   — Google Gemini (contents /
 *                                                   functionCall / functionResponse)
 *
 * Model ids move faster than code: besides the curated catalogue every
 * provider accepts (a) any id returned by its own live /models endpoint and
 * (b) any id the admin typed into "Other model id". So a brand-new release
 * works the day it ships, without a deploy.
 */
const { getSetting, setSetting } = require('../db');

/* ------------------------------------------------------------------ models */

/**
 * tier:  production | preview | legacy
 * tools: OpenAI-style function calling (required by the admin assistant)
 * json:  structured output / JSON mode (listing generator + moderation)
 * reasoning: vendor wants max_completion_tokens and no temperature
 */
const GROQ_MODELS = [
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

/* ---------------------------------------------------------------- providers */

const PROVIDERS = [
  {
    id: 'groq', label: 'Groq', protocol: 'openai',
    base: 'https://api.groq.com/openai/v1',
    envKeys: ['GROQ_API_KEY'], envBase: 'GROQ_BASE_URL',
    keySetting: 'groq_api_key', keyHint: 'gsk_…',
    keyUrl: 'https://console.groq.com/keys',
    blurb: 'Fast open-model inference (GPT-OSS, Llama, Qwen). Free developer tier.',
    defaultModel: 'openai/gpt-oss-120b',
    models: GROQ_MODELS,
  },
  {
    id: 'openai', label: 'OpenAI', protocol: 'openai',
    base: 'https://api.openai.com/v1',
    envKeys: ['OPENAI_API_KEY'], envBase: 'OPENAI_BASE_URL',
    keySetting: 'openai_api_key', keyHint: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    blurb: 'GPT-5 / GPT-4.1 / o-series. Strongest general tool calling.',
    defaultModel: 'gpt-5-mini',
    models: [
      { id: 'gpt-5', label: 'GPT-5', tier: 'production', note: 'Flagship reasoning model — best for multi-step admin work.', tools: true, json: true, reasoning: true, context: 400000, maxOutput: 128000 },
      { id: 'gpt-5-mini', label: 'GPT-5 mini', tier: 'production', note: 'Cheap + fast, full tool support. Good default.', tools: true, json: true, reasoning: true, context: 400000, maxOutput: 128000 },
      { id: 'gpt-5-nano', label: 'GPT-5 nano', tier: 'production', note: 'Cheapest — bulk drafting and moderation.', tools: true, json: true, reasoning: true, context: 400000, maxOutput: 128000 },
      { id: 'gpt-4.1', label: 'GPT-4.1', tier: 'production', note: 'Non-reasoning workhorse, accepts temperature.', tools: true, json: true, context: 1047576, maxOutput: 32768 },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', tier: 'production', note: 'Fast and cheap.', tools: true, json: true, context: 1047576, maxOutput: 32768 },
      { id: 'gpt-4o', label: 'GPT-4o', tier: 'production', note: 'Multimodal.', tools: true, json: true, vision: true, context: 128000, maxOutput: 16384 },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', tier: 'production', note: 'Cheapest multimodal option.', tools: true, json: true, vision: true, context: 128000, maxOutput: 16384 },
      { id: 'o4-mini', label: 'o4-mini', tier: 'production', note: 'Reasoning, tool-capable.', tools: true, json: true, reasoning: true, context: 200000, maxOutput: 100000 },
      { id: 'o3', label: 'o3', tier: 'production', note: 'Deep reasoning — slow, expensive.', tools: true, json: true, reasoning: true, context: 200000, maxOutput: 100000 },
    ],
  },
  {
    id: 'anthropic', label: 'Anthropic (Claude)', protocol: 'anthropic',
    base: 'https://api.anthropic.com/v1',
    envKeys: ['ANTHROPIC_API_KEY'], envBase: 'ANTHROPIC_BASE_URL',
    keySetting: 'anthropic_api_key', keyHint: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    blurb: 'Claude — excellent long-context reasoning and very reliable tool use.',
    defaultModel: 'claude-sonnet-4-5',
    models: [
      { id: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1', tier: 'production', note: 'Strongest Claude — hard admin judgement calls.', tools: true, json: true, context: 200000, maxOutput: 32000 },
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', tier: 'production', note: 'Best price/quality for the assistant. Default.', tools: true, json: true, context: 200000, maxOutput: 64000 },
      { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', tier: 'production', note: 'Previous Sonnet, dated id.', tools: true, json: true, context: 200000, maxOutput: 64000 },
      { id: 'claude-3-7-sonnet-20250219', label: 'Claude 3.7 Sonnet', tier: 'legacy', note: 'Older hybrid-reasoning model.', tools: true, json: true, context: 200000, maxOutput: 64000 },
      { id: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku', tier: 'production', note: 'Cheapest + fastest Claude.', tools: true, json: true, context: 200000, maxOutput: 8192 },
    ],
  },
  {
    id: 'gemini', label: 'Google Gemini', protocol: 'gemini',
    base: 'https://generativelanguage.googleapis.com',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GOOGLE_API_KEY'], envBase: 'GEMINI_BASE_URL',
    keySetting: 'gemini_api_key', keyHint: 'AIza…',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    blurb: 'Gemini — 1M-token context, generous free tier, native function calling.',
    defaultModel: 'gemini-2.5-flash',
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'production', note: 'Deep reasoning, 1M context.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 65536 },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'production', note: 'Fast, cheap, tool-capable. Default.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 65536 },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', tier: 'production', note: 'Cheapest — bulk moderation.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 65536 },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', tier: 'legacy', note: 'Previous generation.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 8192 },
    ],
  },
  {
    id: 'deepseek', label: 'DeepSeek', protocol: 'openai',
    base: 'https://api.deepseek.com',
    chatPath: '/chat/completions', modelsPath: '/models',
    envKeys: ['DEEPSEEK_API_KEY'], envBase: 'DEEPSEEK_BASE_URL',
    keySetting: 'deepseek_api_key', keyHint: 'sk-…',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    blurb: 'DeepSeek V3 chat + R1 reasoning at very low cost.',
    defaultModel: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek-V3 (chat)', tier: 'production', note: 'General model, function calling supported. Default.', tools: true, json: true, context: 128000, maxOutput: 8192 },
      { id: 'deepseek-reasoner', label: 'DeepSeek-R1 (reasoner)', tier: 'production', note: 'Chain-of-thought model — no tool calling, JSON by prompt only.', tools: false, json: false, reasoning: true, context: 128000, maxOutput: 64000 },
    ],
  },
  {
    id: 'huggingface', label: 'Hugging Face', protocol: 'openai',
    base: 'https://router.huggingface.co/v1',
    envKeys: ['HF_TOKEN', 'HUGGINGFACE_API_KEY', 'HF_API_KEY'], envBase: 'HF_BASE_URL',
    keySetting: 'huggingface_api_key', keyHint: 'hf_…',
    keyUrl: 'https://huggingface.co/settings/tokens',
    blurb: 'HF Router — thousands of open models (Llama, Qwen, DeepSeek, Mistral) behind one key.',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B Instruct', tier: 'production', note: 'Solid all-round open model with tools.', tools: true, json: true, context: 128000, maxOutput: 4096 },
      { id: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen 2.5 72B Instruct', tier: 'production', note: 'Strong tool calling, multilingual.', tools: true, json: true, context: 128000, maxOutput: 4096 },
      { id: 'deepseek-ai/DeepSeek-R1-0528', label: 'DeepSeek R1 0528', tier: 'production', note: 'Reasoning model.', tools: true, json: true, reasoning: true, context: 163840, maxOutput: 16384 },
      { id: 'mistralai/Mistral-Nemo-Instruct-2407', label: 'Mistral Nemo 12B', tier: 'production', note: 'Cheap and quick.', tools: true, json: true, context: 128000, maxOutput: 4096 },
      { id: 'google/gemma-3-27b-it', label: 'Gemma 3 27B', tier: 'preview', note: 'Google open model.', tools: true, json: true, vision: true, context: 131072, maxOutput: 8192 },
    ],
  },
  {
    id: 'openrouter', label: 'OpenRouter', protocol: 'openai',
    base: 'https://openrouter.ai/api/v1',
    envKeys: ['OPENROUTER_API_KEY'], envBase: 'OPENROUTER_BASE_URL',
    keySetting: 'openrouter_api_key', keyHint: 'sk-or-…',
    keyUrl: 'https://openrouter.ai/settings/keys',
    blurb: 'One key for 400+ models across every lab, including free tiers and Cohere Command.',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    extraHeaders: true,
    models: [
      { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', tier: 'production', note: 'Best tool use through the router.', tools: true, json: true, context: 200000, maxOutput: 64000 },
      { id: 'openai/gpt-5-mini', label: 'GPT-5 mini', tier: 'production', note: 'Cheap OpenAI reasoning.', tools: true, json: true, reasoning: true, context: 400000, maxOutput: 128000 },
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'production', note: '1M context.', tools: true, json: true, vision: true, context: 1048576, maxOutput: 65536 },
      { id: 'deepseek/deepseek-chat-v3-0324', label: 'DeepSeek V3', tier: 'production', note: 'Very low cost.', tools: true, json: true, context: 163840, maxOutput: 8192 },
      { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B', tier: 'production', note: 'Open weights.', tools: true, json: true, context: 131072, maxOutput: 4096 },
      { id: 'qwen/qwen3-235b-a22b', label: 'Qwen3 235B', tier: 'production', note: 'Large MoE, strong agentic use.', tools: true, json: true, context: 131072, maxOutput: 16384 },
      { id: 'cohere/command-r-plus-08-2024', label: 'Cohere Command R+', tier: 'production', note: 'Cohere models are reachable through the router.', tools: true, json: true, context: 128000, maxOutput: 4096 },
      { id: 'mistralai/mistral-large', label: 'Mistral Large', tier: 'production', note: 'Mistral flagship.', tools: true, json: true, context: 128000, maxOutput: 8192 },
    ],
  },
  {
    id: 'mistral', label: 'Mistral AI', protocol: 'openai',
    base: 'https://api.mistral.ai/v1',
    envKeys: ['MISTRAL_API_KEY'], envBase: 'MISTRAL_BASE_URL',
    keySetting: 'mistral_api_key', keyHint: '…',
    keyUrl: 'https://console.mistral.ai/api-keys',
    blurb: 'Mistral Large / Small / Ministral — European-hosted, good tool calling.',
    defaultModel: 'mistral-large-latest',
    models: [
      { id: 'mistral-large-latest', label: 'Mistral Large', tier: 'production', note: 'Flagship.', tools: true, json: true, context: 128000, maxOutput: 8192 },
      { id: 'mistral-small-latest', label: 'Mistral Small', tier: 'production', note: 'Cheap, fast, tool-capable.', tools: true, json: true, context: 128000, maxOutput: 8192 },
      { id: 'ministral-8b-latest', label: 'Ministral 8B', tier: 'production', note: 'Cheapest option.', tools: true, json: true, context: 128000, maxOutput: 4096 },
      { id: 'open-mistral-nemo', label: 'Mistral Nemo', tier: 'production', note: 'Open 12B.', tools: true, json: true, context: 128000, maxOutput: 4096 },
      { id: 'magistral-medium-latest', label: 'Magistral Medium', tier: 'preview', note: 'Reasoning model.', tools: true, json: true, reasoning: true, context: 40000, maxOutput: 4000 },
    ],
  },
  {
    id: 'xai', label: 'xAI (Grok)', protocol: 'openai',
    base: 'https://api.x.ai/v1',
    envKeys: ['XAI_API_KEY'], envBase: 'XAI_BASE_URL',
    keySetting: 'xai_api_key', keyHint: 'xai-…',
    keyUrl: 'https://console.x.ai',
    blurb: 'Grok 4 / 3 — long context, very fast, tool-capable.',
    defaultModel: 'grok-4',
    models: [
      { id: 'grok-4', label: 'Grok 4', tier: 'production', note: 'Flagship reasoning model.', tools: true, json: true, context: 256000, maxOutput: 32768 },
      { id: 'grok-3', label: 'Grok 3', tier: 'production', note: 'Previous flagship.', tools: true, json: true, context: 131072, maxOutput: 8192 },
      { id: 'grok-3-mini', label: 'Grok 3 mini', tier: 'production', note: 'Fast and cheap.', tools: true, json: true, context: 131072, maxOutput: 8192 },
      { id: 'grok-2-1212', label: 'Grok 2', tier: 'legacy', note: 'Legacy id.', tools: true, json: true, context: 131072, maxOutput: 4096 },
    ],
  },
  {
    id: 'together', label: 'Together AI', protocol: 'openai',
    base: 'https://api.together.xyz/v1',
    envKeys: ['TOGETHER_API_KEY'], envBase: 'TOGETHER_BASE_URL',
    keySetting: 'together_api_key', keyHint: '…',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
    blurb: 'Open-model inference (Llama, Qwen, DeepSeek, Mixtral) with per-token pricing.',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo', tier: 'production', note: 'Default — tools supported.', tools: true, json: true, context: 131072, maxOutput: 4096 },
      { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', label: 'Qwen 2.5 Coder 32B', tier: 'production', note: 'Code-heavy work.', tools: true, json: true, context: 32768, maxOutput: 4096 },
      { id: 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B', label: 'DeepSeek R1 Distill 70B', tier: 'production', note: 'Reasoning.', tools: true, json: true, reasoning: true, context: 131072, maxOutput: 4096 },
      { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', label: 'Mixtral 8x7B', tier: 'legacy', note: 'Older MoE model.', tools: true, json: true, context: 32768, maxOutput: 4096 },
    ],
  },
  {
    id: 'cerebras', label: 'Cerebras', protocol: 'openai',
    base: 'https://api.cerebras.ai/v1',
    envKeys: ['CEREBRAS_API_KEY'], envBase: 'CEREBRAS_BASE_URL',
    keySetting: 'cerebras_api_key', keyHint: 'csk-…',
    keyUrl: 'https://cloud.cerebras.ai',
    blurb: 'Wafer-scale inference — the fastest tokens/second of any hosted option.',
    defaultModel: 'llama-3.3-70b',
    models: [
      { id: 'llama-3.3-70b', label: 'Llama 3.3 70B', tier: 'production', note: 'Extremely fast, tools supported.', tools: true, json: true, context: 128000, maxOutput: 4096 },
      { id: 'qwen-3-32b', label: 'Qwen 3 32B', tier: 'production', note: 'Strong agentic use at speed.', tools: true, json: true, context: 128000, maxOutput: 4096 },
      { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', tier: 'production', note: 'OpenAI open-weights flagship.', tools: true, json: true, context: 131072, maxOutput: 16384 },
    ],
  },
  {
    id: 'fireworks', label: 'Fireworks AI', protocol: 'openai',
    base: 'https://api.fireworks.ai/inference/v1',
    envKeys: ['FIREWORKS_API_KEY'], envBase: 'FIREWORKS_BASE_URL',
    keySetting: 'fireworks_api_key', keyHint: 'fw_…',
    keyUrl: 'https://fireworks.ai/account/api-keys',
    blurb: 'Fast open-model serving with function calling and structured output.',
    defaultModel: 'accounts/fireworks/models/llama4-maverick-instruct-basic',
    models: [
      { id: 'accounts/fireworks/models/llama4-maverick-instruct-basic', label: 'Llama 4 Maverick', tier: 'production', note: 'Large MoE, tools supported.', tools: true, json: true, context: 512000, maxOutput: 16384 },
      { id: 'accounts/fireworks/models/deepseek-v3', label: 'DeepSeek V3', tier: 'production', note: 'Cheap general model.', tools: true, json: true, context: 128000, maxOutput: 8192 },
      { id: 'accounts/fireworks/models/qwen3-235b-a22b-instruct-2507', label: 'Qwen3 235B', tier: 'production', note: 'Very large MoE.', tools: true, json: true, context: 256000, maxOutput: 16384 },
    ],
  },
  {
    id: 'sambanova', label: 'SambaNova', protocol: 'openai',
    base: 'https://api.sambanova.ai/v1',
    envKeys: ['SAMBANOVA_API_KEY'], envBase: 'SAMBANOVA_BASE_URL',
    keySetting: 'sambanova_api_key', keyHint: '…',
    keyUrl: 'https://cloud.sambanova.ai',
    blurb: 'RDU inference — Llama and DeepSeek at very high throughput, free tier.',
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
    models: [
      { id: 'Meta-Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B', tier: 'production', note: 'Default.', tools: true, json: true, context: 128000, maxOutput: 4096 },
      { id: 'DeepSeek-R1-0528', label: 'DeepSeek R1', tier: 'production', note: 'Reasoning.', tools: true, json: true, reasoning: true, context: 163840, maxOutput: 16384 },
      { id: 'Qwen3-32B', label: 'Qwen3 32B', tier: 'production', note: 'Fast agentic model.', tools: true, json: true, context: 163840, maxOutput: 8192 },
    ],
  },
  {
    id: 'perplexity', label: 'Perplexity', protocol: 'openai',
    base: 'https://api.perplexity.ai',
    chatPath: '/chat/completions', modelsPath: '/models',
    envKeys: ['PERPLEXITY_API_KEY'], envBase: 'PERPLEXITY_BASE_URL',
    keySetting: 'perplexity_api_key', keyHint: 'pplx-…',
    keyUrl: 'https://www.perplexity.ai/settings/api',
    blurb: 'Sonar — answers grounded in live web search with citations.',
    defaultModel: 'sonar-pro',
    models: [
      { id: 'sonar-pro', label: 'Sonar Pro', tier: 'production', note: 'Deep web research, function calling supported.', tools: true, json: true, context: 200000, maxOutput: 8192 },
      { id: 'sonar', label: 'Sonar', tier: 'production', note: 'Fast web-grounded answers.', tools: true, json: true, context: 128000, maxOutput: 4096 },
      { id: 'sonar-reasoning-pro', label: 'Sonar Reasoning Pro', tier: 'production', note: 'Reasoning + search.', tools: false, json: true, reasoning: true, context: 128000, maxOutput: 8192 },
      { id: 'sonar-deep-research', label: 'Sonar Deep Research', tier: 'production', note: 'Long research reports.', tools: false, json: true, context: 128000, maxOutput: 8192 },
    ],
  },
  {
    id: 'azure', label: 'Azure OpenAI', protocol: 'openai',
    base: '', authHeader: 'api-key', customBase: true,
    chatPath: '/chat/completions?api-version=2025-04-01-preview',
    modelsPath: '/models?api-version=2025-04-01-preview',
    envKeys: ['AZURE_OPENAI_API_KEY'], envBase: 'AZURE_OPENAI_BASE_URL',
    keySetting: 'azure_api_key', keyHint: '…',
    keyUrl: 'https://portal.azure.com',
    blurb: 'Your own Azure deployment. Base URL: https://RESOURCE.openai.azure.com/openai/deployments/DEPLOYMENT',
    defaultModel: 'gpt-4o',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o (deployment)', tier: 'production', note: 'Match the model to your Azure deployment name.', tools: true, json: true, context: 128000, maxOutput: 16384 },
      { id: 'gpt-4.1', label: 'GPT-4.1 (deployment)', tier: 'production', note: 'Match the deployment name in your resource.', tools: true, json: true, context: 1047576, maxOutput: 32768 },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini (deployment)', tier: 'production', note: 'Cheap deployment.', tools: true, json: true, context: 128000, maxOutput: 16384 },
    ],
  },
  {
    id: 'custom', label: 'Custom / self-hosted', protocol: 'openai',
    base: '',
    chatPath: '/chat/completions', modelsPath: '/models',
    envKeys: ['CUSTOM_LLM_API_KEY', 'OPENAI_COMPATIBLE_API_KEY', 'LLM_API_KEY'], envBase: 'CUSTOM_LLM_BASE_URL',
    keySetting: 'custom_api_key', keyHint: '…',
    keyUrl: '',
    blurb: 'Any OpenAI-compatible endpoint: Ollama, vLLM, LM Studio, LiteLLM, llama.cpp, an internal gateway.',
    defaultModel: '',
    models: [],
    customBase: true,
  },
];

const BY_ID = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));
const PROVIDER_IDS = PROVIDERS.map((p) => p.id);
const DEFAULT_PROVIDER = 'groq';

class LlmError extends Error {
  constructor(message, { status = 502, code = 'llm_error', retryAfterSec = 0, provider = '' } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
    this.provider = provider;
  }
}

/* ------------------------------------------------------------- key handling */

function provider(id) {
  return BY_ID[String(id || '').trim()] || null;
}

function isProviderId(id) { return Boolean(BY_ID[String(id || '').trim()]); }

function apiKey(pid) {
  const p = provider(pid);
  if (!p) return '';
  for (const k of p.envKeys) {
    const v = String(process.env[k] || '').trim();
    if (v) return v;
  }
  return String(getSetting(p.keySetting, '') || '').trim();
}

function keySource(pid) {
  const p = provider(pid);
  if (!p) return '';
  if (p.envKeys.some((k) => String(process.env[k] || '').trim())) return 'env';
  if (String(getSetting(p.keySetting, '') || '').trim()) return 'settings';
  return '';
}

function configured(pid) { return Boolean(apiKey(pid)); }

function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 10) return `${k.slice(0, 4)}…`;
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

function baseUrl(pid) {
  const p = provider(pid);
  if (!p) return '';
  const fromEnv = String(process.env[p.envBase] || '').trim();
  const fromSettings = String(getSetting(`ai_base_url_${p.id}`, '') || '').trim();
  const raw = (fromEnv || fromSettings || p.base || '').replace(/\/+$/, '');
  return raw;
}

function chatUrl(pid) {
  const p = provider(pid);
  return `${baseUrl(pid)}${p && p.chatPath ? p.chatPath : '/chat/completions'}`;
}

function modelsUrl(pid) {
  const p = provider(pid);
  return `${baseUrl(pid)}${p && p.modelsPath ? p.modelsPath : '/models'}`;
}

/** Order the operator arranged providers in (failover order); unknown ids dropped. */
function providerOrder() {
  let arr = [];
  try { arr = JSON.parse(getSetting('ai_provider_order', '[]') || '[]'); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  const clean = [...new Set(arr.map(String).filter(isProviderId))];
  for (const id of PROVIDER_IDS) if (!clean.includes(id)) clean.push(id);
  return clean;
}

function saveProviderOrder(ids) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(isProviderId))];
  setSetting('ai_provider_order', JSON.stringify(clean.slice(0, PROVIDER_IDS.length)));
  return providerOrder();
}

function activeProviderId() {
  const fromEnv = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (isProviderId(fromEnv)) return fromEnv;
  const saved = String(getSetting('ai_provider', '') || '').trim().toLowerCase();
  if (isProviderId(saved)) return saved;
  /* Nothing chosen yet: use the first provider that actually has a key. */
  for (const id of providerOrder()) if (configured(id)) return id;
  return DEFAULT_PROVIDER;
}

function setActiveProvider(id) {
  if (!isProviderId(id)) {
    const err = new LlmError(`“${String(id || '').slice(0, 40)}” is not a supported provider.`, { status: 422, code: 'bad_provider' });
    throw err;
  }
  setSetting('ai_provider', String(id));
  return id;
}

function failoverEnabled() {
  return getSetting('ai_failover', '1') === '1';
}

/* --------------------------------------------------------------- model side */

function catalogModels(pid) {
  const p = provider(pid);
  return (p && p.models ? p.models : []).map((m) => ({ ...m, provider: pid }));
}

function customModelIds(pid) {
  let arr = [];
  try { arr = JSON.parse(getSetting(`ai_custom_models_${pid}`, '[]') || '[]'); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
}

function addCustomModelId(pid, modelId) {
  const id = String(modelId || '').trim().slice(0, 160);
  if (!id || !isProviderId(pid)) return customModelIds(pid);
  const list = [...new Set([...customModelIds(pid), id])].slice(-40);
  setSetting(`ai_custom_models_${pid}`, JSON.stringify(list));
  return list;
}

function removeCustomModelId(pid, modelId) {
  const list = customModelIds(pid).filter((x) => x !== String(modelId || '').trim());
  setSetting(`ai_custom_models_${pid}`, JSON.stringify(list));
  return list;
}

function liveSnapshot(pid) {
  let ids = [];
  try { ids = JSON.parse(getSetting(`ai_live_models_${pid}`, '[]') || '[]'); } catch { ids = []; }
  if (!Array.isArray(ids)) ids = [];
  /* Groq kept its historical keys before providers existed — read them too. */
  if (pid === 'groq' && !ids.length) {
    try { ids = JSON.parse(getSetting('groq_live_models', '[]') || '[]'); } catch { ids = []; }
    if (!Array.isArray(ids)) ids = [];
  }
  const checked = pid === 'groq'
    ? (String(getSetting(`ai_live_checked_${pid}`, '') || '') || String(getSetting('groq_live_checked_at', '') || ''))
    : String(getSetting(`ai_live_checked_${pid}`, '') || '');
  return { ids: ids.map(String), checked_at: checked };
}

function markLiveModels(pid, ids) {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x).trim()).filter(Boolean))];
  setSetting(`ai_live_models_${pid}`, JSON.stringify(clean).slice(0, 60000));
  setSetting(`ai_live_checked_${pid}`, new Date().toISOString().replace('T', ' ').slice(0, 19));
  return clean;
}

/** Every model id this provider can be asked for (catalogue + live + typed). */
function knownModelIds(pid) {
  return [
    ...catalogModels(pid).map((m) => m.id),
    ...liveSnapshot(pid).ids,
    ...customModelIds(pid),
  ];
}

function modelMeta(pid, modelId) {
  const wanted = String(modelId || '').trim();
  return catalogModels(pid).find((m) => m.id === wanted) || null;
}

function isKnownModel(modelId, pid) {
  const wanted = String(modelId || '').trim();
  if (!wanted) return false;
  if (pid) return knownModelIds(pid).includes(wanted);
  return PROVIDER_IDS.some((id) => knownModelIds(id).includes(wanted));
}

/** Which provider a bare model id belongs to (catalogue/live/typed match). */
function providerForModel(modelId) {
  const wanted = String(modelId || '').trim();
  if (!wanted) return '';
  for (const pid of providerOrder()) {
    if (knownModelIds(pid).includes(wanted)) return pid;
  }
  return '';
}

/** "gemini:gemini-2.5-pro" and "gemini-2.5-pro" both resolve. */
function splitModelRef(ref) {
  const raw = String(ref || '').trim();
  const m = raw.match(/^([a-z0-9_-]+)::?(.+)$/i);
  if (m && isProviderId(m[1])) return { provider: m[1], model: m[2].trim() };
  return { provider: '', model: raw };
}

function savedModel(pid) {
  const p = provider(pid);
  if (!p) return '';
  const settingKey = `ai_model_${pid}`;
  const legacy = pid === 'groq' ? String(getSetting('groq_model', '') || '').trim() : '';
  const saved = String(getSetting(settingKey, '') || '').trim() || legacy;
  if (saved && knownModelIds(pid).includes(saved)) return saved;
  if (saved) return saved; // typed id we cannot verify — respect the operator
  return p.defaultModel || (knownModelIds(pid)[0] || '');
}

function setSavedModel(pid, modelId) {
  if (!isProviderId(pid)) return '';
  const id = String(modelId || '').trim().slice(0, 160);
  setSetting(`ai_model_${pid}`, id);
  if (pid === 'groq') setSetting('groq_model', id); // keeps the legacy key truthful
  return id;
}

/** The model the console will use right now. */
function activeModel(pid = activeProviderId()) { return savedModel(pid); }

function usableModels(pid = activeProviderId()) {
  const { ids, checked_at } = liveSnapshot(pid);
  const live = new Set(ids);
  const seen = new Set();
  const out = [];
  const push = (m) => {
    if (!m.id || seen.has(m.id)) return;
    seen.add(m.id);
    out.push({
      ...m,
      provider: pid,
      available: ids.length ? live.has(m.id) : null,
      checked_at: checked_at || '',
    });
  };
  catalogModels(pid).forEach(push);
  /* Anything the key can actually call that we did not curate is still usable —
     a brand-new vendor release works before this file is updated. */
  ids.filter((id) => !seen.has(id)).forEach((id) => push({
    id, label: id, tier: 'live', note: 'Reported by the provider’s live model list.',
    tools: true, json: true, context: 0, maxOutput: 0,
  }));
  customModelIds(pid).forEach((id) => push({
    id, label: id, tier: 'custom', note: 'Added by the admin (Other model id).',
    tools: true, json: true, context: 0, maxOutput: 0,
  }));
  return out;
}

function supportsTools(modelId, pid) {
  const ref = splitModelRef(modelId);
  const p = ref.provider || pid || providerForModel(ref.model) || activeProviderId();
  const meta = modelMeta(p, ref.model);
  if (meta) return Boolean(meta.tools);
  /* Unknown/live ids: assume tools unless the vendor says otherwise below. */
  return !/reasoner|deep-research|o1-preview/i.test(ref.model);
}

function supportsJson(modelId, pid) {
  const ref = splitModelRef(modelId);
  const p = ref.provider || pid || providerForModel(ref.model) || activeProviderId();
  const meta = modelMeta(p, ref.model);
  return meta ? Boolean(meta.json) : true;
}

function isReasoning(modelId, pid) {
  const ref = splitModelRef(modelId);
  const p = ref.provider || pid || providerForModel(ref.model) || activeProviderId();
  const meta = modelMeta(p, ref.model);
  return meta ? Boolean(meta.reasoning) : false;
}

/* ------------------------------------------------------------------ sending */

const LIVE_TTL_MS = 6 * 60 * 60 * 1000; // re-check availability twice a day at most
const recentCalls = new Map(); // pid -> timestamps

function rateLimitPerMinute() {
  const n = Number(getSetting('ai_rate_limit_per_min', '') || getSetting('llm_rate_limit_per_min', '') || 40);
  return Number.isFinite(n) && n > 0 ? Math.min(600, n) : 40;
}

/* Process-wide rolling window per provider so a stuck tab cannot burn quota. */
function chargeLocal(pid) {
  const now = Date.now();
  const cap = rateLimitPerMinute();
  let arr = recentCalls.get(pid) || [];
  while (arr.length && now - arr[0] > 60_000) arr.shift();
  if (arr.length >= cap) {
    recentCalls.set(pid, arr);
    throw new LlmError(`${provider(pid).label} rate limit — ${cap} calls/minute reached. Wait a moment and try again.`, {
      status: 429, code: 'rate_limited', retryAfterSec: 60, provider: pid,
    });
  }
  arr.push(now);
  recentCalls.set(pid, arr);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function authHeaders(pid) {
  const p = provider(pid);
  const key = apiKey(pid);
  const style = (p && p.authHeader) || (pid === 'custom' && String(getSetting('ai_custom_auth_header', '') || '').trim().toLowerCase() === 'api-key' ? 'api-key' : 'bearer');
  if (p && p.protocol === 'anthropic') {
    return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  }
  if (p && p.protocol === 'gemini') {
    return { 'x-goog-api-key': key };
  }
  if (style === 'api-key') return { 'api-key': key };
  return { Authorization: `Bearer ${key}` };
}

function extraHeadersFor(pid) {
  const p = provider(pid);
  if (!p || !p.extraHeaders) return {};
  /* OpenRouter asks (does not require) for attribution headers. */
  let host = '';
  try { host = String(getSetting('base_url', '') || process.env.BASE_URL || '').replace(/^https?:\/\//, ''); } catch { host = ''; }
  return {
    'HTTP-Referer': `https://${host || 'firmledger.co.ke'}`,
    'X-Title': 'FirmLedger Admin',
  };
}

async function send(url, pid, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...authHeaders(pid), ...extraHeadersFor(pid), ...(init.headers || {}) },
      signal: controller.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new LlmError(`${provider(pid).label} timed out after ${Math.round(timeoutMs / 1000)} seconds. Try again.`, {
        status: 504, code: 'timeout', provider: pid,
      });
    }
    throw new LlmError(`Could not reach ${provider(pid).label}: ${(e && e.message) || 'network error'}`, {
      status: 502, code: 'network', provider: pid,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res) {
  const raw = await res.text();
  try { return raw ? JSON.parse(raw) : {}; } catch { return { raw: String(raw).slice(0, 400) }; }
}

function apiMessage(data) {
  if (!data || typeof data !== 'object') return '';
  const e = data.error;
  if (!e) return String(data.message || '');
  if (typeof e === 'string') return e;
  return String(e.message || e.code || (Array.isArray(e) ? JSON.stringify(e[0]) : '') || '');
}

function describeHttpError(pid, res, data) {
  const label = (provider(pid) || {}).label || pid;
  const msg = apiMessage(data);
  if (res.status === 401 || res.status === 403) {
    return {
      message: `${label} rejected the API key${msg ? ` — ${msg}` : ''}. Check the key saved in Admin → AI Playground → Providers (or the environment variable).`,
      code: 'invalid_key', status: 401,
    };
  }
  if (res.status === 402) {
    return { message: msg || `${label}: the account has no credit for this model.`, code: 'billing', status: 402 };
  }
  if (res.status === 429) {
    return { message: msg || `${label} is rate-limiting this key. Retry shortly.`, code: 'rate', status: 429 };
  }
  if (res.status === 404 || /decommission|no longer available|does not exist|not found|unknown model|invalid model|model_not_found|unsupported model/i.test(msg)) {
    return { message: msg || `That model is not available on this ${label} key.`, code: 'model_unavailable', status: 502 };
  }
  if (/tool/i.test(msg) && /support|not.*(allow|enable)|unavailable|invalid/i.test(msg)) {
    return { message: `${msg} — pick a model with tool support for the admin assistant.`, code: 'tools_unsupported', status: 502 };
  }
  if (res.status >= 500) {
    return { message: msg || `${label} HTTP ${res.status}`, code: 'server_error', status: 502 };
  }
  return { message: msg || `${label} HTTP ${res.status}`, code: 'llm_http', status: 502 };
}

/* ------------------------------------------------------- message conversion */

function stripSystem(messages) {
  const system = [];
  const rest = [];
  for (const m of messages || []) {
    if (m && m.role === 'system') system.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    else rest.push(m);
  }
  return { system: system.filter(Boolean).join('\n\n'), messages: rest };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  return content == null ? '' : JSON.stringify(content);
}

function argsObject(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw || '{}')); } catch { return { _raw: String(raw || '') }; }
}

/** Anthropic wants one message per role turn, alternating. */
function toAnthropicMessages(messages) {
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages || []) {
    const role = m && m.role;
    if (role === 'user') {
      push('user', [{ type: 'text', text: textOf(m.content) || '.' }]);
    } else if (role === 'assistant') {
      const blocks = [];
      const text = textOf(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of (m.tool_calls || [])) {
        blocks.push({
          type: 'tool_use',
          id: tc.id || `toolu_${Math.random().toString(36).slice(2, 12)}`,
          name: (tc.function && tc.function.name) || tc.name || '',
          input: argsObject(tc.function && tc.function.arguments),
        });
      }
      push('assistant', blocks);
    } else if (role === 'tool') {
      push('user', [{
        type: 'tool_result',
        tool_use_id: m.tool_call_id || m.toolCallId || '',
        content: textOf(m.content),
        ...(m.is_error ? { is_error: true } : {}),
      }]);
    }
  }
  /* Anthropic rejects a conversation that does not start with a user turn. */
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function toAnthropicTools(tools) {
  return (tools || []).map((t) => {
    const fn = t.function || t;
    return {
      name: fn.name,
      description: String(fn.description || '').slice(0, 4000),
      input_schema: cleanSchema(fn.parameters || { type: 'object', properties: {} }),
    };
  });
}

function toGeminiContents(messages) {
  const contents = [];
  for (const m of messages || []) {
    const role = m && m.role;
    if (role === 'user') {
      contents.push({ role: 'user', parts: [{ text: textOf(m.content) || '.' }] });
    } else if (role === 'assistant' || role === 'model') {
      const parts = [];
      const text = textOf(m.content);
      if (text) parts.push({ text });
      for (const tc of (m.tool_calls || [])) {
        parts.push({
          functionCall: {
            name: (tc.function && tc.function.name) || tc.name || '',
            args: argsObject(tc.function && tc.function.arguments),
          },
        });
      }
      if (parts.length) contents.push({ role: 'model', parts });
    } else if (role === 'tool') {
      /* Gemini takes function responses on a user turn. */
      let payload = {};
      try { payload = JSON.parse(textOf(m.content)); } catch { payload = { result: textOf(m.content) }; }
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: m.name || 'tool', response: { result: payload } } }],
      });
    }
  }
  /* Merge neighbours with the same role — Gemini rejects repeats in some SDK paths. */
  const merged = [];
  for (const c of contents) {
    const last = merged[merged.length - 1];
    if (last && last.role === c.role) last.parts.push(...c.parts);
    else merged.push(c);
  }
  return merged;
}

/** Gemini’s schema parser rejects OpenAI-only keywords. */
function cleanSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const drop = new Set(['additionalProperties', '$schema', 'definitions', '$defs', 'examples']);
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (drop.has(k)) continue;
      out[k] = (k === 'properties' || k === 'items' || typeof v === 'object') ? walk(v) : v;
    }
    return out;
  };
  return walk(schema);
}

/* ------------------------------------------------------- response shaping */

function openAiChoice(data) {
  const choice = data && data.choices && data.choices[0];
  if (!choice) return null;
  const msg = choice.message || {};
  return {
    role: 'assistant',
    content: textOf(msg.content) || '',
    tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls.map((tc) => ({
      id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: {
        name: (tc.function && tc.function.name) || tc.name || '',
        arguments: typeof (tc.function && tc.function.arguments) === 'string'
          ? tc.function.arguments
          : JSON.stringify((tc.function && tc.function.arguments) || {}),
      },
    })) : [],
    finish_reason: choice.finish_reason || '',
  };
}

function anthropicChoice(data) {
  const parts = Array.isArray(data && data.content) ? data.content : [];
  const text = parts.filter((p) => p && p.type === 'text').map((p) => p.text).join('');
  const calls = parts.filter((p) => p && p.type === 'tool_use').map((p) => ({
    id: p.id,
    type: 'function',
    function: { name: p.name, arguments: JSON.stringify(p.input || {}) },
  }));
  const stop = data && data.stop_reason;
  return {
    role: 'assistant', content: text, tool_calls: calls,
    finish_reason: stop === 'tool_use' ? 'tool_calls' : (stop || 'stop'),
  };
}

function geminiChoice(data) {
  const cand = (data && data.candidates && data.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('');
  const calls = parts.filter((p) => p && p.functionCall).map((p, i) => ({
    id: `gemini_call_${i + 1}`,
    type: 'function',
    function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
  }));
  const fr = String(cand.finishReason || '').toUpperCase();
  return {
    role: 'assistant', content: text, tool_calls: calls,
    finish_reason: calls.length ? 'tool_calls' : (fr === 'MAX_TOKENS' ? 'length' : 'stop'),
    safety: cand.safetyRatings || undefined,
    blockReason: cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT' ? fr : '',
  };
}

function normalizeUsage(pid, data) {
  const u = (data && data.usage) || (data && data.usageMetadata) || null;
  if (!u) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount ?? 0) || 0;
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount ?? 0) || 0;
  const total = Number(u.total_tokens ?? (prompt + completion) ?? 0) || (prompt + completion);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total, provider: pid };
}

function normalize(pid, data) {
  const p = provider(pid) || {};
  let choice = null;
  if (p.protocol === 'anthropic') choice = anthropicChoice(data);
  else if (p.protocol === 'gemini') choice = geminiChoice(data);
  else choice = openAiChoice(data);
  return {
    _provider: pid,
    _model: (data && (data.model || (data.candidates && data.candidates[0] && data.candidates[0].model))) || '',
    choices: [{ message: choice || { role: 'assistant', content: '', tool_calls: [] }, finish_reason: choice ? choice.finish_reason : '' }],
    usage: normalizeUsage(pid, data),
    raw: data,
  };
}

/* ------------------------------------------------------------ request build */

function buildPayload(pid, opts, model) {
  const p = provider(pid);
  const { system, messages } = stripSystem(opts.messages || []);
  const tools = Array.isArray(opts.tools) && opts.tools.length ? opts.tools : null;
  const wantsJson = Boolean(opts.response_format && opts.response_format.type === 'json_object');
  const reasoning = isReasoning(model, pid);
  const maxOut = Math.max(16, Math.min(Number(opts.max_tokens) || 1800, 128000));

  if (p.protocol === 'anthropic') {
    const payload = {
      model,
      messages: toAnthropicMessages(messages),
      max_tokens: Math.max(256, Math.min(maxOut, 64000)),
    };
    if (system) payload.system = system.slice(0, 60000);
    if (!reasoning && opts.temperature != null) payload.temperature = Math.max(0, Math.min(1, Number(opts.temperature)));
    if (tools) {
      payload.tools = toAnthropicTools(tools);
      payload.tool_choice = opts.tool_choice === 'required' || opts.tool_choice === 'any'
        ? { type: 'any' }
        : { type: 'auto' };
    }
    if (wantsJson && !tools) {
      payload.system = `${system ? system + '\n\n' : ''}Respond with a single valid JSON object and nothing else.`;
    }
    if (opts.stop) payload.stop_sequences = Array.isArray(opts.stop) ? opts.stop : [opts.stop];
    return payload;
  }

  if (p.protocol === 'gemini') {
    const payload = { contents: toGeminiContents(messages) };
    if (system) payload.systemInstruction = { parts: [{ text: system.slice(0, 60000) }] };
    const gen = { maxOutputTokens: Math.max(64, Math.min(maxOut, 65536)) };
    if (!reasoning && opts.temperature != null) gen.temperature = Math.max(0, Math.min(2, Number(opts.temperature)));
    /* Gemini rejects responseMimeType alongside functionDeclarations — the JSON
       instruction in the system prompt covers that case. */
    if (wantsJson && !tools) gen.responseMimeType = 'application/json';
    payload.generationConfig = gen;
    if (tools) {
      payload.tools = [{
        functionDeclarations: tools.map((t) => {
          const fn = t.function || t;
          return {
            name: fn.name,
            description: String(fn.description || '').slice(0, 4000),
            parameters: cleanSchema(fn.parameters || { type: 'object', properties: {} }),
          };
        }),
      }];
      payload.toolConfig = {
        functionCallingConfig: {
          mode: opts.tool_choice === 'required' || opts.tool_choice === 'any' ? 'ANY' : 'AUTO',
        },
      };
    }
    return payload;
  }

  /* openai-compatible */
  const payload = { model, messages: opts.messages };
  if (reasoning) payload.max_completion_tokens = maxOut;
  else payload.max_tokens = maxOut;
  if (!reasoning) payload.temperature = opts.temperature == null ? 0.3 : Number(opts.temperature);
  if (tools) {
    payload.tools = tools;
    if (opts.tool_choice) payload.tool_choice = opts.tool_choice;
  }
  if (wantsJson && supportsJson(model, pid)) payload.response_format = { type: 'json_object' };
  if (opts.stop) payload.stop = opts.stop;
  return payload;
}

function endpointFor(pid) {
  const p = provider(pid);
  if (p.protocol === 'anthropic') return `${baseUrl(pid)}/messages`;
  if (p.protocol === 'gemini') return null; // built per model below
  return chatUrl(pid);
}

function geminiEndpoint(pid, model) {
  return `${baseUrl(pid)}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

async function postOnce(pid, model, payload, timeoutMs) {
  const p = provider(pid);
  const url = p.protocol === 'gemini' ? geminiEndpoint(pid, model) : endpointFor(pid);
  if (!url) {
    throw new LlmError(`${p.label} needs a base URL — set it in Admin → AI Playground → Providers.`, {
      status: 422, code: 'no_base_url', provider: pid,
    });
  }
  const res = await send(url, pid, { method: 'POST', body: JSON.stringify(payload) }, timeoutMs);
  const data = await readJson(res);
  if (!res.ok) {
    const info = describeHttpError(pid, res, data);
    const err = new LlmError(info.message, { status: info.status, code: info.code, provider: pid });
    err.httpStatus = res.status;
    err.body = data;
    if (res.status === 429) err.retryAfterSec = Number(res.headers.get('retry-after')) || 8;
    throw err;
  }
  return data;
}

/* ------------------------------------------------------------- model lists */

async function fetchLiveModels(pid) {
  const p = provider(pid);
  if (!p) throw new LlmError(`Unknown provider “${pid}”.`, { status: 422, code: 'bad_provider' });
  const key = apiKey(pid);
  if (!key) {
    throw new LlmError(`${p.label} is not configured. Paste an API key in Admin → AI Playground → Providers (or set ${p.envKeys[0]} in .env).`, {
      status: 503, code: 'not_configured', provider: pid,
    });
  }
  const base = baseUrl(pid);
  if (!base) {
    throw new LlmError(`${p.label} needs a base URL — fill it in under Providers.`, { status: 422, code: 'no_base_url', provider: pid });
  }
  let url = modelsUrl(pid);
  if (p.protocol === 'anthropic') url = `${base}/models?limit=100`;
  if (p.protocol === 'gemini') url = `${base}/v1beta/models?pageSize=200`;

  const res = await send(url, pid, { method: 'GET' }, 20_000);
  const data = await readJson(res);
  if (!res.ok) {
    const info = describeHttpError(pid, res, data);
    throw new LlmError(info.message, { status: info.status, code: info.code, provider: pid });
  }
  const rows = Array.isArray(data.data) ? data.data
    : (Array.isArray(data.models) ? data.models : []);
  return [...new Set(rows.map((r) => {
    const id = String(typeof r === 'string' ? r : (r && (r.id || r.name)) || '');
    return id.replace(/^models\//, '');
  }).filter(Boolean))];
}

async function syncModels(pid = activeProviderId()) {
  const ids = await fetchLiveModels(pid);
  markLiveModels(pid, ids);
  const set = new Set(ids);
  return {
    provider: pid,
    count: ids.length,
    models: ids,
    selected: savedModel(pid),
    selected_available: ids.includes(savedModel(pid)),
    missing: catalogModels(pid).filter((m) => !set.has(m.id)).map((m) => m.id),
  };
}

function liveAgeMs(pid) {
  const t = Date.parse(String(liveSnapshot(pid).checked_at || '').replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}

/** Background refresh at most twice a day per provider — never blocks a request. */
function maybeSyncModels(pid) {
  if (!configured(pid)) return;
  if (liveAgeMs(pid) < LIVE_TTL_MS) return;
  setImmediate(() => { syncModels(pid).catch(() => { /* surfaced by the manual Test button */ }); });
}

/* ------------------------------------------------------------------- chat() */

const RETRYABLE = new Set(['model_unavailable', 'tools_unsupported', 'server_error', 'network', 'timeout', 'rate', 'rate_limited', 'llm_http']);

function fallbackModels(pid, primary) {
  return usableModels(pid)
    .filter((m) => m.id !== primary && m.tier !== 'legacy' && m.available !== false)
    .slice(0, 2)
    .map((m) => m.id);
}

/** Providers with a key, in the operator's order, excluding the one just tried. */
function failoverProviders(exclude) {
  if (!failoverEnabled()) return [];
  return providerOrder().filter((id) => id !== exclude && configured(id)).slice(0, 2);
}

/**
 * One chat completion against the chosen provider.
 *
 * opts: { model, provider, messages, tools, tool_choice, response_format,
 *         temperature, max_tokens, noFallback, timeoutMs }
 * `model` may be "provider:model" to target a specific backend in one call —
 * auto-moderation uses that to run a cheaper model than the assistant.
 */
async function chat(opts = {}) {
  const ref = splitModelRef(opts.model || '');
  let pid = String(opts.provider || '').trim().toLowerCase() || ref.provider;
  if (pid && !isProviderId(pid)) {
    throw new LlmError(`“${pid.slice(0, 40)}” is not a supported provider.`, { status: 422, code: 'bad_provider' });
  }
  if (!pid) pid = providerForModel(ref.model) || activeProviderId();

  /* A typed id we have never seen is allowed through — vendors ship models
     faster than this file changes, and the fallback chain catches a bad one. */
  const requested = String(ref.model || '').trim().slice(0, 160);
  let model = requested || savedModel(pid);
  if (!model) model = (provider(pid) || {}).defaultModel || '';
  if (!model) {
    throw new LlmError(`${(provider(pid) || {}).label || pid} has no model selected. Choose one in Admin → AI Playground → Providers.`, {
      status: 422, code: 'bad_model', provider: pid,
    });
  }

  const attempts = [{ pid, model }];
  if (!opts.noFallback) {
    if (supportsTools(model, pid) || !opts.tools) {
      for (const m of fallbackModels(pid, model)) attempts.push({ pid, model: m });
    }
    for (const next of failoverProviders(pid)) {
      const m = savedModel(next);
      /* Only fail over to a backend that can do what this call needs. */
      if (m && (!opts.tools || !opts.tools.length || supportsTools(m, next))) attempts.push({ pid: next, model: m });
    }
  }

  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const p = provider(attempt.pid);
    if (!configured(attempt.pid)) {
      lastErr = new LlmError(
        `${p.label} is not configured. Paste an API key in Admin → AI Playground → Providers${p.envKeys && p.envKeys[0] ? ` (or set ${p.envKeys[0]} in .env)` : ''}.`,
        { status: 503, code: 'not_configured', provider: attempt.pid }
      );
      continue;
    }
    if (!baseUrl(attempt.pid)) {
      lastErr = new LlmError(`${p.label} needs a base URL — fill it in under Providers.`, {
        status: 422, code: 'no_base_url', provider: attempt.pid,
      });
      continue;
    }

    chargeLocal(attempt.pid);
    maybeSyncModels(attempt.pid);

    const payload = buildPayload(attempt.pid, opts, attempt.model);
    const timeoutMs = Number(opts.timeoutMs) || (opts.tools && opts.tools.length ? 90_000 : 60_000);
    try {
      const data = await postOnce(attempt.pid, attempt.model, payload, timeoutMs);
      const out = normalize(attempt.pid, data);
      out._model = out._model || attempt.model;
      return out;
    } catch (e) {
      lastErr = e;
      const retryable = RETRYABLE.has(e.code);
      if (e.code === 'rate' || e.code === 'rate_limited') {
        await sleep(Math.min(12_000, (e.retryAfterSec || 4) * 1000));
        try {
          const data = await postOnce(attempt.pid, attempt.model, payload, timeoutMs);
          const out = normalize(attempt.pid, data);
          out._model = out._model || attempt.model;
          return out;
        } catch (e2) { lastErr = e2; }
      }
      if (retryable && i < attempts.length - 1) {
        console.warn(`[llm] ${attempt.pid}/${attempt.model} unusable (${e.code}), falling back —`, e.message);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new LlmError('The model request failed.', { provider: pid });
}

/* --------------------------------------------------------------- accessors */

function assistantText(data) {
  const choice = data && data.choices && data.choices[0];
  if (!choice) return '';
  const msg = choice.message || choice;
  return textOf(msg.content) || '';
}

function toolCalls(data) {
  const choice = data && data.choices && data.choices[0];
  const msg = choice && (choice.message || choice);
  return (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length) ? msg.tool_calls : [];
}

function usage(data) {
  const u = data && data.usage;
  if (!u) return null;
  return {
    prompt_tokens: Number(u.prompt_tokens) || 0,
    completion_tokens: Number(u.completion_tokens) || 0,
    total_tokens: Number(u.total_tokens) || 0,
    provider: u.provider || (data && data._provider) || '',
  };
}

/** Cheap, side-effect-free probe used by the Providers → Test button. */
async function testConnection(pid = activeProviderId(), modelOverride = '') {
  const p = provider(pid);
  if (!p) return { ok: false, provider: pid, error: `Unknown provider “${pid}”.` };
  const model = splitModelRef(modelOverride).model || savedModel(pid);
  const key = apiKey(pid);
  if (!key) {
    return {
      ok: false, provider: pid, label: p.label, model, key_source: '',
      error: `No ${p.label} key configured. Paste one below${p.envKeys && p.envKeys[0] ? ` or set ${p.envKeys[0]} in .env` : ''}.`,
      key_url: p.keyUrl,
    };
  }
  const out = {
    ok: true, provider: pid, label: p.label, protocol: p.protocol,
    key_source: keySource(pid), key_hint: maskKey(key), base: baseUrl(pid), model,
  };
  if (!out.base) {
    return { ...out, ok: false, error: `${p.label} needs a base URL — fill it in below.` };
  }
  try {
    const ids = await fetchLiveModels(pid);
    markLiveModels(pid, ids);
    out.models = ids;
    out.model_available = ids.includes(model);
  } catch (e) {
    out.list_error = e.message;
    if (e.code === 'invalid_key' || e.code === 'not_configured') return { ...out, ok: false, error: e.message };
  }
  try {
    const data = await chat({
      provider: pid, model, temperature: 0, max_tokens: 16, noFallback: true, timeoutMs: 30_000,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    });
    out.reply = assistantText(data).trim().slice(0, 60) || '(empty reply)';
    out.used_model = data._model || model;
    out.used_provider = data._provider || pid;
    out.usage = usage(data);
  } catch (e) {
    out.ok = false;
    out.error = e.message;
    out.error_code = e.code;
  }
  return out;
}

/** Everything the Providers UI needs, without leaking a single key. */
function providerSnapshot() {
  const active = activeProviderId();
  return PROVIDERS.map((p) => {
    const key = apiKey(p.id);
    const snap = liveSnapshot(p.id);
    return {
      id: p.id,
      label: p.label,
      protocol: p.protocol,
      blurb: p.blurb || '',
      key_url: p.keyUrl || '',
      key_hint: key ? maskKey(key) : '',
      key_set: Boolean(key),
      key_source: keySource(p.id),
      env_keys: p.envKeys || [],
      env_locked: (p.envKeys || []).some((k) => String(process.env[k] || '').trim()),
      base_url: baseUrl(p.id),
      default_base: p.base || '',
      custom_base: Boolean(p.customBase),
      base_required: !p.base,
      model: savedModel(p.id),
      default_model: p.defaultModel || '',
      models: usableModels(p.id),
      custom_models: customModelIds(p.id),
      live_models: snap.ids,
      live_checked_at: snap.checked_at,
      active: p.id === active,
      configured: Boolean(key) && Boolean(baseUrl(p.id)),
    };
  });
}

module.exports = {
  PROVIDERS, PROVIDER_IDS, BY_ID, DEFAULT_PROVIDER, LlmError,
  provider, isProviderId, providerOrder, saveProviderOrder,
  activeProviderId, setActiveProvider, failoverEnabled,
  apiKey, keySource, configured, maskKey,
  baseUrl, chatUrl, modelsUrl, endpointFor,
  catalogModels, usableModels, knownModelIds, modelMeta, isKnownModel, providerForModel,
  customModelIds, addCustomModelId, removeCustomModelId,
  savedModel, setSavedModel, activeModel,
  supportsTools, supportsJson, isReasoning,
  liveSnapshot, markLiveModels, fetchLiveModels, syncModels, maybeSyncModels,
  chat, assistantText, toolCalls, usage, testConnection, providerSnapshot,
  buildPayload, normalize, splitModelRef, cleanSchema,
  toAnthropicMessages, toGeminiContents, rateLimitPerMinute,
};
