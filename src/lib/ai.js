/**
 * FirmLedger AI Playground — listing generator, admin assistant, auto-moderation.
 * All Groq calls stay on the server. Mutating assistant tools wait for UI
 * confirmation (ai_pending_actions) unless the admin ticked them under Settings
 * → Auto-run. Lookups always run immediately. delete_user always confirms.
 *
 * The assistant is stateless: no chat history is stored. Context comes only
 * from the messages visible in the current browser tab.
 */
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('../db');
const groq = require('./groq');
const llm = require('./llm');
const tools = require('./aitools');
const { TYPES, CATEGORIES, SIZES, COUNTRIES } = require('./taxonomy');
const catLib = require('./categories');
const svc = require('./apilistings');
const notify = require('./notify');
const { sendBranded } = require('./mailer');
const { slugify, normalizeUrl, domainOf, siteUrl, escHtml, confidenceScore } = require('./util');
const { submitForIndexing } = require('./indexing');

const DEFAULT_MODERATION_RULES = `You are a FirmLedger listing moderator. FirmLedger is a verified company-intelligence directory for real businesses, startups, agencies, organisations, products, services and publishers.

Approve when ALL of the following hold:
- The record describes a real-looking entity (not gibberish, lorem ipsum, or a joke).
- The description has real substance (what the organisation does, who it serves, where). Prefer 150+ characters of facts, not a slogan.
- The category fits the description.
- The website is a plausible URL (https://example.com is a placeholder — treat that as weak evidence, not an automatic reject).
- No adult content, scams, hate, weapons, or clearly illegal activity.

Reject when:
- Spam, placeholder text, or promotional junk with no company facts.
- Adult, hateful, or illegal content.
- An obvious fake / duplicate-looking shell with no identifiable business.

Leave pending when you are not confident (missing critical facts, ambiguous category, possible duplicate, or the model is guessing). Human review is cheaper than a wrong live listing.

Respond with JSON only:
{"decision":"approve"|"reject"|"pending","reason":"one or two short sentences","confidence":0-100}`;

function audit({ kind, action, listingId = null, payload = {}, result = '', ok = 1 }) {
  try {
    db.prepare(
      `INSERT INTO ai_audit_log (kind, action, listing_id, payload, result, ok)
       VALUES (?,?,?,?,?,?)`
    ).run(
      String(kind || 'info').slice(0, 40),
      String(action || '').slice(0, 80),
      listingId || null,
      JSON.stringify(payload).slice(0, 8000),
      String(typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 4000),
      ok ? 1 : 0,
    );
  } catch (e) {
    console.error('[ai-audit]', e.message);
  }
}

function adminNotifyEmail() {
  return getSetting('admin_email', '') || process.env.ADMIN_NOTIFY_EMAIL || 'hello@firmledger.co.ke';
}

function clampLen(s, min, max, pad) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max).trimEnd();
  if (s.length < min && pad) {
    const extra = pad;
    s = (s + (s ? ' ' : '') + extra).slice(0, max);
    if (s.length < min) s = (s + ' ' + extra.repeat(3)).slice(0, max);
  }
  return s;
}

function applyListingLimits(raw) {
  const typeValues = TYPES.map((t) => t.value);
  let type = String(raw.type || 'company').trim().toLowerCase();
  if (!typeValues.includes(type)) type = 'company';

  let category = String(raw.category || 'Other').trim();
  if (!category) category = 'Other';

  let website = normalizeUrl(String(raw.website || '').trim());
  if (!website) website = 'https://example.com';

  let tags = raw.tags;
  if (Array.isArray(tags)) tags = tags.map((t) => String(t).trim()).filter(Boolean).join(', ');
  else tags = String(tags || '').trim();
  tags = tags.slice(0, 160);

  let founded = String(raw.founded || '').trim().slice(0, 12);
  if (founded && !/^\d{4}(-\d{2})?$/.test(founded)) founded = founded.replace(/\D/g, '').slice(0, 4);

  let size = String(raw.size || '').trim();
  if (size && !SIZES.includes(size)) size = '';

  let country = String(raw.country || '').trim().slice(0, 60);
  if (!country) country = 'Kenya';

  const name = clampLen(raw.name, 2, 60, 'Company');
  let tagline = clampLen(raw.tagline, 0, 90, '');
  if (tagline.length < 20) {
    tagline = clampLen(tagline || `${name} is a ${category} ${type} based in ${country}.`, 20, 90, 'Verified business record on FirmLedger.');
  }
  let description = String(raw.description || '').trim();
  if (description.length > 1200) description = description.slice(0, 1200).trimEnd();
  if (description.length < 100) {
    const pad = `${name} is a ${type} in ${category}, based in ${country}. ${tagline} Visit ${website} for more information about products, services and contact details.`;
    description = (description + (description ? ' ' : '') + pad).slice(0, 1200);
    if (description.length < 100) description = (description + ' ' + pad).slice(0, 1200);
  }

  return {
    name,
    tagline,
    description,
    type,
    category,
    tags,
    founded,
    country,
    website,
    email: String(raw.email || '').trim().slice(0, 190),
    city: String(raw.city || '').trim().slice(0, 80),
    region: String(raw.region || '').trim().slice(0, 80),
    phone: String(raw.phone || '').trim().slice(0, 40),
    size,
    logo_url: normalizeUrl(String(raw.logo_url || '')),
  };
}

function extractJson(text) {
  if (!text) throw new Error('The model returned an empty response.');
  const fence = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : String(text);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON.');
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('The model returned invalid JSON.');
  }
}

function listingSystemPrompt() {
  return `You draft FirmLedger directory listings. Return a single JSON object, no markdown, with exactly these keys:
name, tagline, description, category, tags, founded, country, type, website, email, city, size.

Rules:
- name: 2–60 characters, the legal or trading name.
- tagline: ONE sentence, 20–90 characters.
- description: 100–1200 characters of real substance (what they do, who they serve, where). No slogans-only.
- type: one of ${TYPES.map((t) => t.value).join(', ')}.
- category: preferably one of ${CATEGORIES.join(', ')}. If none fit, invent a short Title Case category.
- tags: array of 2–6 short tags.
- founded: year (YYYY) or YYYY-MM if known, else "".
- country: a real country name. Prefer one of ${COUNTRIES.join(', ')} when it fits.
- size: one of ${SIZES.map((s) => JSON.stringify(s)).join(', ')} or "".
- website: a full https URL. If the user did not give one and you cannot infer it, use "https://example.com".
- email: a plausible public email or "".
- city: city name or "".
Use only facts present or reasonably inferred from the prompt. Never invent funding rounds, fake awards, or celebrity founders.`;
}

async function generateListing(prompt, opts = {}) {
  const text = String(prompt || '').trim().slice(0, 4000);
  if (text.length < 8) {
    const err = new Error('Give the model a bit more to work with (business name, site, or a short description).');
    err.status = 422;
    throw err;
  }
  const model = chatModelFor(opts.model);
  const data = await groq.chat({
    model,
    temperature: 0.4,
    max_tokens: 1400,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: listingSystemPrompt() },
      { role: 'user', content: text },
    ],
  });
  const content = groq.assistantText(data);
  let parsed;
  try {
    parsed = extractJson(content);
  } catch (e) {
    audit({ kind: 'generate', action: 'invalid_json', payload: { prompt: text.slice(0, 400) }, result: content.slice(0, 1500), ok: 0 });
    const err = new Error('The model returned invalid JSON. Retry — this is usually a one-off.');
    err.status = 502;
    err.raw = content;
    throw err;
  }
  const draft = applyListingLimits(parsed);
  audit({ kind: 'generate', action: 'ok', payload: { prompt: text.slice(0, 400), name: draft.name }, result: draft.name });
  return { draft, model: data._model || model, raw: parsed, usage: groq.usage(data) };
}

function publishAsAdmin(draft) {
  const f = svc.parseFields(draft, { partial: false });
  const domain = domainOf(f.website);
  const dupName = db.prepare('SELECT id, slug, name FROM listings WHERE name = ? COLLATE NOCASE').get(f.name);
  if (dupName) {
    const err = new Error(`A listing named “${dupName.name}” already exists (/listing/${dupName.slug}).`);
    err.status = 409;
    throw err;
  }
  if (domain) {
    const dupWeb = db.prepare('SELECT id, slug, name FROM listings WHERE lower(website) LIKE ? LIMIT 1').get(`%${domain}%`);
    if (dupWeb) {
      const err = new Error(`“${dupWeb.name}” already uses that domain.`);
      err.status = 409;
      throw err;
    }
  }
  let slug = slugify(f.name) || 'listing';
  let n = 2;
  while (db.prepare('SELECT id FROM listings WHERE slug=?').get(slug)) slug = `${slugify(f.name)}-${n++}`;
  const confidence = confidenceScore(f);
  const info = db.prepare(
    `INSERT INTO listings (slug, name, tagline, description, type, category, website, email, phone,
       country, city, region, address, logo_url, founded, size, tags, socials, sources, status, featured, claimed, confidence)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    slug, f.name, f.tagline, f.description, f.type || 'company',
    catLib.ensure(f.category).name,
    f.website, f.email || '', f.phone || '',
    f.country, f.city || '', f.region || '', f.address || '',
    f.logo_url || '', f.founded || '', f.size || '', f.tags || '',
    f.socials || '{}', '[]',
    'pending', 0, 0, confidence,
  );
  const row = db.prepare('SELECT * FROM listings WHERE id=?').get(info.lastInsertRowid);
  try {
    notify.notifyAdmin({
      kind: 'listing',
      title: `AI draft pending — ${row.name}`,
      body: 'Saved from the AI Playground listing generator.',
      url: '/admin3119Musa/listings?status=pending',
    });
  } catch { /* notify is best-effort */ }
  scheduleModeration(row.id);
  return { via: 'admin', status: 201, body: { data: svc.serialize(row), meta: { note: 'Created as pending — confirm it in Listings after review (or let AI auto-moderation decide if enabled).' } } };
}

function publishListing(body) {
  const draft = applyListingLimits(body);
  const outcome = publishAsAdmin(draft);
  const data = outcome.body && outcome.body.data;
  audit({
    kind: 'publish',
    action: 'ok',
    listingId: data && data.id,
    payload: { name: draft.name, via: outcome.via },
    result: data ? data.slug : '',
  });
  return outcome;
}

/* ---------------- Assistant (chat + confirm-then-execute) ---------------- */

function sweepPending() {
  try { db.prepare("DELETE FROM ai_pending_actions WHERE expires_at < datetime('now')").run(); } catch { /* ignore */ }
}

/**
 * Park one or more proposed actions for operator confirmation.
 * `steps` is always an array of { name, args, id } — a single proposal is a
 * one-element batch, so confirm/execute has exactly one code path.
 */
function storePending({ steps, convo, ran = [] }) {
  sweepPending();
  const id = 'act_' + crypto.randomBytes(16).toString('hex');
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const label = steps.length === 1 ? steps[0].name : `${steps.length} actions`;
  db.prepare(
    `INSERT INTO ai_pending_actions (id, tool, args, messages, expires_at) VALUES (?,?,?,?,?)`
  ).run(
    id,
    label.slice(0, 80),
    JSON.stringify({ steps }).slice(0, 200000),
    JSON.stringify({ convo, ran }).slice(0, 400000),
    expires,
  );
  return id;
}

function loadPending(id) {
  sweepPending();
  return db.prepare('SELECT * FROM ai_pending_actions WHERE id=?').get(String(id || ''));
}

function dropPending(id) {
  db.prepare('DELETE FROM ai_pending_actions WHERE id=?').run(id);
}

function sanitiseHistory(messages) {
  const out = [];
  const src = Array.isArray(messages) ? messages : [];
  for (const m of src.slice(-20)) {
    const role = m && m.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = String(m.content || '').slice(0, 4000);
    if (!content) continue;
    out.push({ role, content });
  }
  return out;
}

function assistantSystemPrompt() {
  const active = llm.provider(llm.activeId());
  const auto = [...tools.autoSet()];
  const sensitive = tools.sensitiveTools();
  const autoLine = auto.length
    ? `These write tools are configured to run immediately (no confirm): ${auto.join(', ')}.`
    : 'Every write tool requires operator confirmation before it runs.';
  return `You are the FirmLedger admin assistant. You are signed in as the site administrator and you operate the live admin console through tools. You have full authority over the whole product — listings and the directory, members and billing, claims, tickets and removal requests, the blog, member news, careers, promos, plan and advert packages, categories, advertising, email delivery, search indexing, upkeep, the public status page, protection lists and rate limits, the admin inbox, backups and every site setting. If an admin asks for something the console can do, do it with a tool. Never claim you cannot reach part of the console — find the tool that does it.

Start from the real state of the site, not from assumptions. When you are unsure what FirmLedger is, which pages or settings exist, or what an action would touch, call get_site_overview, get_settings, get_listing, get_user, search_admin or get_ai_playground before you answer or act.

Available tools:
${tools.capabilityPrompt()}

Rules:
- Prefer a tool for any admin action or factual lookup. Do not invent ids, emails, slugs, counts or settings values.
- Look things up first when you are missing an id or slug (search_listings, search_users, search_admin, get_listing, get_user, list_content, the list_* tools), then act on what you found.
- Finish the whole job. If a request needs several actions, call them — one after another is fine, and you may call more than one tool in a single response. You are given each tool's real result before you answer.
- A reply without a tool call changes nothing. For any lookup or change, call the tool first and answer only from its result; if you could not call a tool, say the action did not run.
- If a request is ambiguous (which listing / which user?), ask a clarifying question instead of calling a tool.
- Never claim you already did a write. Report only what the tool results show: if a tool returned an error, say so plainly and do not describe it as done.
- ${autoLine}
- Sensitive actions ALWAYS stop for operator confirmation, whatever the auto-run list says: ${sensitive.join(', ')}. Never work around a confirmation by splitting the action into smaller calls.
- Other destructive or wide-reaching work (deleting records, emailing everyone, maintenance mode, bulk listing actions, removing search-index credentials) only when the operator is explicit about it.
- Never reveal API keys, SMTP passwords, PayPal secrets or recovery codes — the tools return masked hints only, and you must not ask for the raw value.
- Be concise. State what changed, with ids or names, and say what still needs doing.

You are currently running on ${active.label} (${active.id}, model ${llm.modelFor(active.id)}).`;
}

/* How far one turn may go on its own before it must come back to the operator. */
const MAX_MODEL_STEPS = 6;   // model round-trips per turn
const MAX_TOOL_RUNS = 12;    // tool executions per turn

/**
 * Appended to any final answer that did not execute a single console action,
 * so a reply can never read like a completed change. This is the hard
 * guarantee behind “the assistant only reports what actually ran”.
 */
const NO_ACTION_NOTE = '_(No console action ran in this turn — nothing was changed.)_';

function modelLabelOf(id, pid) {
  const meta = llm.modelMeta(String(id || '').trim(), pid);
  return (meta && meta.label) || String(id || 'that model');
}

/**
 * Which provider + model actually runs this turn's tool calls.
 *
 * The operator's pick always comes first. If that model cannot call tools
 * (Perplexity Sonar, Groq Compound, reasoning-only ids…), the loop moves to a
 * tool-capable model so the request is still executed for real — first on the
 * same provider, then on another configured provider. Every reply in that
 * mode names the model that ran, so nothing is hidden. Null only when no
 * configured model can call tools at all: then the turn answers questions in
 * a read-only prompt and says plainly that nothing was executed.
 */
function resolveExecutionModel(requested) {
  const active = llm.activeId();
  const req = String(requested || '').trim();
  const knownAndCapable = (m, pid) => Boolean(m) && llm.isKnownModel(m, pid) && llm.supportsTools(m, pid);
  if (req && knownAndCapable(req, active)) return { provider: active, model: req, swapped: false };
  if (!req) {
    const def = llm.modelFor(active);
    if (knownAndCapable(def, active)) return { provider: active, model: def, swapped: false };
  }
  if (llm.configured(active)) {
    const own = llm.toolCapableModel(active);
    if (own) return { provider: active, model: own, swapped: true };
  }
  const alt = llm.toolFallbackProvider(active);
  if (alt) return { provider: alt.provider, model: alt.model, swapped: true };
  return null;
}

function swapNote(exec, requested) {
  const active = llm.activeId();
  const from = String(requested || '').trim() || llm.modelFor(active) || 'the selected default model';
  return `_(Ran on ${modelLabelOf(exec.model, exec.provider)} — ${modelLabelOf(from, active)} does not support tool calling, so a tool-capable model executed it.)_`;
}

/** System prompt for the degraded, tools-unavailable turn. */
function degradedAssistantPrompt() {
  return 'You are the FirmLedger admin assistant in read-only degraded mode. No model in this deployment can call tools right now, so you CANNOT run, save, approve, reject, delete, email, or change anything in the console. Answer questions, explain the console, and help the operator plan; if asked to perform an action, say plainly that it needs a tool-capable model configured under Admin → AI Playground → Settings → Model providers. Never claim, hint or imply that anything was done in the console.';
}

function toolMessage(callId, name, payload) {
  return {
    role: 'tool',
    tool_call_id: callId,
    name,
    content: JSON.stringify(payload).slice(0, 6000),
  };
}

/** Normalise the model's tool_calls into { id, name, args }. */
function readCalls(calls) {
  return calls.map((c, i) => ({
    id: c.id || `call_${i + 1}`,
    name: (c.function && c.function.name) || c.name || '',
    args: tools.parseArgs(c.function && c.function.arguments),
  }));
}

/** One-line receipt per executed step, used when the model cannot summarise. */
function receipt(ran) {
  return ran.map((r) => (r.ok
    ? `✓ ${tools.describeCall(r.tool, r.args)}`
    : `✗ ${tools.describeCall(r.tool, r.args)} — ${r.error}`)).join('\n');
}

/** Execute a list of steps in order, appending the results to the conversation. */
async function runSteps(steps, convo, ran, { auto = false } = {}) {
  for (const step of steps) {
    let exec;
    try {
      exec = await tools.execute(step.name, step.args);
    } catch (e) {
      exec = { ok: false, error: e.message || 'The action failed.' };
    }
    audit({
      kind: 'tool',
      action: (auto ? 'auto:' : '') + step.name,
      payload: step.args,
      result: exec,
      ok: exec.ok ? 1 : 0,
    });
    ran.push({ tool: step.name, args: step.args, ok: Boolean(exec.ok), result: exec.result, error: exec.error || '' });
    convo.push(toolMessage(step.id, step.name, exec));
  }
  return ran;
}

/**
 * The agent loop.
 *
 * Runs the model, executes whatever it is allowed to execute, feeds the real
 * tool results back, and lets it continue until the task is genuinely finished
 * (or the step budget runs out). Nothing is ever reported as done unless a tool
 * actually ran and returned ok — the summary is generated from the tool output.
 *
 * Any step that needs operator confirmation stops the loop: every call in that
 * model response is parked as ONE pending batch, so “suspend X and email them”
 * is confirmed and then executed as a unit rather than being refused.
 */
async function runAgent({ convo, model, ran = [], budgetSteps = MAX_MODEL_STEPS }) {
  let usedModel = model;
  let usage = null;
  const requested = String(model || '').trim();
  const exec = resolveExecutionModel(requested);

  if (!exec) {
    /* No configured model can call tools: still answer the question, but
       execute nothing and say so — the reply is stamped with the note so it
       can never read like a completed change. */
    audit({ kind: 'chat', action: 'degraded_no_tools', payload: { requested: requested || llm.modelFor(llm.activeId()) }, result: 'no tool-capable model configured', ok: 0 });
    const degraded = [...convo];
    if (degraded[0] && degraded[0].role === 'system') degraded[0] = { role: 'system', content: degradedAssistantPrompt() };
    else degraded.unshift({ role: 'system', content: degradedAssistantPrompt() });
    const data = await groq.chat({
      model: requested || undefined,
      temperature: 0.2,
      max_tokens: 900,
      messages: degraded,
    });
    usedModel = data._model || model;
    usage = groq.usage(data);
    const text = (groq.assistantText(data) || '').trim()
      || 'I can answer questions, but I cannot run console actions right now — no configured model supports tool calling.';
    return {
      type: 'message',
      content: `${text}\n\n${NO_ACTION_NOTE}`,
      model: usedModel,
      usage,
      executed: false,
      steps: ran.map((r) => ({ tool: r.tool, ok: r.ok, error: r.error })),
      tool: '',
      no_action: true,
    };
  }

  if (exec.swapped) {
    audit({
      kind: 'chat',
      action: 'tool_fallback',
      payload: { requested: requested || '(default)', provider: exec.provider, model: exec.model },
      result: `executing on ${llm.provider(exec.provider).label}`,
    });
    /* Tell the model it is running on a different model than the one the
       operator picked, so its report can name it truthfully. */
    convo.push({
      role: 'system',
      content: `Note: the operator selected ${modelLabelOf(requested || llm.modelFor(llm.activeId()), llm.activeId())} but that model has no tool calling, so this conversation runs on ${llm.provider(exec.provider).label} (${exec.model}). Every tool call you make is executed for real — report only what the tool results confirm, and mention that a tool-capable model ran the action.`,
    });
  }

  for (let step = 0; step < budgetSteps; step++) {
    const data = await groq.chat({
      provider: exec.provider,
      model: exec.model,
      temperature: 0.2,
      max_tokens: 900,
      tools: tools.groqTools(),
      tool_choice: 'auto',
      messages: convo,
    });
    usedModel = data._model || usedModel;
    usage = groq.usage(data) || usage;

    const text = groq.assistantText(data) || '';
    const choice = data.choices && data.choices[0];
    const assistantMessage = (choice && choice.message) || { role: 'assistant', content: text };
    /* Tools are always offered on this path (the execution model was chosen
       for tool support), so any tool_calls in the reply are always read. */
    const calls = readCalls(groq.toolCalls(data));

    if (!calls.length) {
      audit({ kind: 'chat', action: 'reply', payload: { steps: ran.length }, result: text.slice(0, 400) });
      const content = text
        || (ran.length ? receipt(ran) : 'I could not verify an action or lookup from that request, so nothing was changed. Please rephrase it or include the listing, user, or record identifier.');
      const suffixes = [];
      if (!ran.length) suffixes.push(NO_ACTION_NOTE);
      if (exec.swapped) suffixes.push(swapNote(exec, requested));
      return {
        type: 'message',
        content: content + (suffixes.length ? '\n\n' + suffixes.join('\n\n') : ''),
        model: usedModel,
        usage,
        executed: ran.some((r) => r.ok),
        steps: ran.map((r) => ({ tool: r.tool, ok: r.ok, error: r.error })),
        tool: ran.length ? ran[ran.length - 1].tool : '',
        no_action: !ran.length,
      };
    }

    /* Unknown tool names never fail the turn — tell the model and let it retry. */
    const unknown = calls.filter((c) => !tools.getTool(c.name));
    if (unknown.length) {
      convo.push(assistantMessage);
      for (const c of unknown) {
        convo.push(toolMessage(c.id, c.name || 'unknown', { ok: false, error: `“${c.name}” is not a registered admin action.` }));
      }
      for (const c of calls.filter((x) => tools.getTool(x.name))) {
        convo.push(toolMessage(c.id, c.name, { ok: false, error: 'Skipped — another call in the same batch was invalid.' }));
      }
      continue;
    }

    const needsConfirm = calls.filter((c) => !tools.isAuto(c.name));
    if (needsConfirm.length) {
      convo.push(assistantMessage);
      const pendingId = storePending({ steps: calls, convo, ran });
      audit({
        kind: 'chat',
        action: 'propose:' + calls.map((c) => c.name).join('+'),
        payload: { steps: calls.map((c) => ({ tool: c.name, args: c.args })) },
        result: pendingId,
      });
      const labels = calls.map((c) => tools.describeCall(c.name, c.args));
      const label = labels.length === 1 ? labels[0] : `${labels.length} actions — ${labels.join(' · ')}`;
      const content = text || (labels.length === 1
        ? `I can ${labels[0]} Confirm to run it.`
        : `I can run these ${labels.length} actions in order:\n${labels.map((l, i) => `${i + 1}. ${l}`).join('\n')}\nConfirm to run them.`);
      return {
        type: 'tool_proposal',
        pending_id: pendingId,
        content,
        model: usedModel,
        usage,
        expires_in_sec: 600,
        tool: {
          name: calls.length === 1 ? calls[0].name : calls.map((c) => c.name).join(' + '),
          label,
          mutating: calls.some((c) => Boolean((tools.getTool(c.name) || {}).mutating)),
          auto: false,
          args: calls.length === 1 ? calls[0].args : calls.map((c) => ({ action: c.name, arguments: c.args })),
          steps: calls.map((c) => ({ name: c.name, label: tools.describeCall(c.name, c.args), args: c.args })),
        },
        done: ran.map((r) => ({ tool: r.tool, ok: r.ok })),
      };
    }

    if (ran.length + calls.length > MAX_TOOL_RUNS) {
      const base = ran.length
        ? `${receipt(ran)}\n\nI stopped there — that request needs more than ${MAX_TOOL_RUNS} actions in one turn. Ask me to continue and I will pick up from here.`
        : `That request needs more than ${MAX_TOOL_RUNS} actions in one turn, so nothing was started. Narrow the selection and ask again.`;
      const suffixes = [];
      if (!ran.length) suffixes.push(NO_ACTION_NOTE);
      if (exec.swapped) suffixes.push(swapNote(exec, requested));
      return {
        type: 'message',
        content: base + (suffixes.length ? '\n\n' + suffixes.join('\n\n') : ''),
        model: usedModel,
        usage,
        executed: ran.some((r) => r.ok),
        steps: ran.map((r) => ({ tool: r.tool, ok: r.ok, error: r.error })),
      };
    }

    audit({ kind: 'chat', action: 'auto:' + calls.map((c) => c.name).join('+'), payload: { count: calls.length }, result: 'auto-run' });
    convo.push(assistantMessage);
    await runSteps(calls, convo, ran, { auto: true });
  }

  /* Budget spent — ask for a plain summary of what actually happened, pinned
     to the same provider/model that ran the tools (no silent second swap). */
  let content = receipt(ran) || 'I could not verify any action from that request, so nothing was changed.';
  try {
    const data = await groq.chat({
      provider: exec.provider,
      model: exec.model,
      noFallback: true,
      temperature: 0.2,
      max_tokens: 500,
      messages: [...convo, { role: 'user', content: 'Summarise, in two sentences, exactly what was done and what is still outstanding. Do not claim anything the tool results do not show.' }],
    });
    content = groq.assistantText(data) || content;
    usedModel = data._model || usedModel;
  } catch { /* the receipt is a perfectly good fallback */ }
  const suffixes = [];
  if (!ran.length) suffixes.push(NO_ACTION_NOTE);
  if (exec.swapped) suffixes.push(swapNote(exec, requested));
  return {
    type: 'message',
    content: content + (suffixes.length ? '\n\n' + suffixes.join('\n\n') : ''),
    model: usedModel,
    usage,
    executed: ran.some((r) => r.ok),
    steps: ran.map((r) => ({ tool: r.tool, ok: r.ok, error: r.error })),
  };
}

/**
 * One assistant turn — fully stateless. The caller's `history` array (the
 * messages visible in the current tab) is the only context; nothing is read
 * from or written to a transcript store. Actions that need confirmation land
 * in ai_pending_actions; everything else is executed for real inside the loop.
 */
async function chatTurn(history, opts = {}) {
  const model = chatModelFor(opts.model);
  const messages = sanitiseHistory(history);
  if (!messages.length) {
    const err = new Error('Send a message first.');
    err.status = 422;
    throw err;
  }
  const last = messages[messages.length - 1];
  if (last.role !== 'user') {
    const err = new Error('The last message must come from you.');
    err.status = 422;
    throw err;
  }

  const convo = [{ role: 'system', content: assistantSystemPrompt() }, ...messages];
  return runAgent({ convo, model });
}

/** Operator pressed Run: execute the parked batch, then let the loop continue. */
async function executePending(pendingId, opts = {}) {
  const row = loadPending(pendingId);
  if (!row) {
    const err = new Error('That action expired or was already handled. Ask me again if you still want it.');
    err.status = 410;
    throw err;
  }
  dropPending(row.id);

  let steps = [];
  let packed = { convo: [], ran: [] };
  try {
    const parsedArgs = JSON.parse(row.args);
    steps = Array.isArray(parsedArgs && parsedArgs.steps) ? parsedArgs.steps : null;
    if (!steps) steps = [{ id: 'call_1', name: row.tool, args: parsedArgs || {} }]; // legacy row
  } catch {
    steps = [{ id: 'call_1', name: row.tool, args: {} }];
  }
  try { packed = JSON.parse(row.messages) || packed; } catch { /* legacy / truncated */ }

  const model = chatModelFor(opts.model);
  const convo = Array.isArray(packed.convo) && packed.convo.length
    ? packed.convo
    : [{ role: 'system', content: assistantSystemPrompt() }];
  const ran = Array.isArray(packed.ran) ? packed.ran : [];

  await runSteps(steps, convo, ran);

  /* Continue the loop so multi-part jobs finish themselves; it stops at the
     next confirmation or when the model has nothing left to do. */
  const out = await runAgent({ convo, model, ran, budgetSteps: 3 });
  if (out.type === 'message') {
    const executedNow = steps.every((s) => (ran.find((r) => r.tool === s.name) || {}).ok !== false);
    return {
      ...out,
      executed: out.executed || executedNow,
      tool: steps.map((s) => s.name).join(' + '),
      result: ran.length ? ran[ran.length - 1].result : undefined,
      error: ran.filter((r) => !r.ok).map((r) => r.error).join(' ') || undefined,
    };
  }
  return out;
}

async function cancelPending(pendingId) {
  const row = loadPending(pendingId);
  if (!row) return { type: 'message', content: 'That action was already cancelled or expired. Nothing ran.' };
  dropPending(row.id);

  let steps = [];
  try {
    const parsedArgs = JSON.parse(row.args);
    steps = Array.isArray(parsedArgs && parsedArgs.steps) ? parsedArgs.steps : [{ id: 'call_1', name: row.tool, args: parsedArgs || {} }];
  } catch { steps = [{ id: 'call_1', name: row.tool, args: {} }]; }

  audit({
    kind: 'tool',
    action: 'cancel:' + steps.map((s) => s.name).join('+'),
    payload: { steps: steps.map((s) => ({ tool: s.name, args: s.args })) },
    result: 'cancelled',
    ok: 1,
  });

  let packed = { convo: [] };
  try { packed = JSON.parse(row.messages) || packed; } catch { /* ignore */ }
  const convo = Array.isArray(packed.convo) && packed.convo.length
    ? packed.convo
    : [{ role: 'system', content: assistantSystemPrompt() }];
  for (const s of steps) {
    convo.push(toolMessage(s.id || 'call_1', s.name, {
      cancelled: true,
      note: 'The operator cancelled this action. It did NOT run. Do not retry it unless they ask again.',
    }));
  }

  const labels = steps.map((s) => tools.describeCall(s.name, s.args));
  let content = `Understood — cancelled ${labels.length === 1 ? `“${labels[0]}”` : `${labels.length} actions`}. Nothing was changed.`;
  try {
    const data = await groq.chat({
      temperature: 0.2,
      max_tokens: 400,
      messages: [...convo, { role: 'user', content: 'Acknowledge the cancellation in one short sentence. Do not retry.' }],
    });
    content = groq.assistantText(data) || content;
  } catch { /* keep the canned acknowledgement if the model is unreachable */ }
  return { type: 'message', content, cancelled: true };
}

/* ---------------- Auto-moderation ---------------- */

function moderationRules() {
  const custom = String(getSetting('ai_moderation_rules', '') || '').trim();
  return custom || DEFAULT_MODERATION_RULES;
}

function isModerationOn() {
  return getSetting('ai_moderation_on', '0') === '1';
}

/* Auto-moderation can run a different (cheaper, safety-tuned) model than the
   assistant. Falls back to the playground default when unset. */
function moderationModelId() {
  const m = String(getSetting('ai_moderation_model', '') || '').trim();
  return (m && llm.isKnownModel(m, llm.activeId())) ? m : llm.modelFor(llm.activeId());
}

function scheduleModeration(listingId) {
  if (!isModerationOn()) return;
  const id = Number(listingId);
  if (!id) return;
  setImmediate(() => {
    moderateListing(id).catch((e) => {
      console.error('[ai-moderation]', e && e.message);
      audit({ kind: 'moderate', action: 'error', listingId: id, result: e.message, ok: 0 });
      try {
        db.prepare(
          `INSERT INTO ai_moderation_log (listing_id, listing_name, decision, reason, model)
           VALUES (?,?,?,?,?)`
        ).run(id, '', 'error', String(e.message || 'unknown').slice(0, 500), groq.modelId());
      } catch { /* ignore */ }
    });
  });
}

async function moderateListing(listingId) {
  const l = db.prepare('SELECT * FROM listings WHERE id=?').get(listingId);
  if (!l) return { skipped: true, reason: 'missing' };
  if (l.status !== 'pending') return { skipped: true, reason: 'not_pending' };
  if (!groq.groqConfigured()) {
    audit({ kind: 'moderate', action: 'skipped_no_key', listingId: l.id, result: 'no groq key', ok: 0 });
    return { skipped: true, reason: 'no_key' };
  }

  const payload = {
    id: l.id,
    name: l.name,
    tagline: l.tagline,
    description: l.description,
    category: l.category,
    type: l.type,
    tags: l.tags,
    website: l.website,
    country: l.country,
    city: l.city,
    founded: l.founded,
  };

  let decision = 'pending';
  let reason = 'Model did not return a decision.';
  let confidence = 0;
  let model = moderationModelId();

  try {
    const data = await groq.chat({
      model,
      temperature: 0.1,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: moderationRules() },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    });
    model = data._model || model;
    const parsed = extractJson(groq.assistantText(data));
    const d = String(parsed.decision || parsed.status || '').toLowerCase();
    if (d === 'approve' || d === 'approved') decision = 'approve';
    else if (d === 'reject' || d === 'rejected') decision = 'reject';
    else decision = 'pending';
    reason = String(parsed.reason || parsed.explanation || '').slice(0, 500) || reason;
    confidence = Math.max(0, Math.min(100, Number(parsed.confidence) || 0));
    if (decision !== 'pending' && confidence && confidence < 55) {
      reason = `(Low confidence ${confidence}) ${reason}`;
      decision = 'pending';
    }
  } catch (e) {
    decision = 'pending';
    reason = 'Moderation call failed: ' + e.message;
    db.prepare(
      `INSERT INTO ai_moderation_log (listing_id, listing_name, decision, reason, model)
       VALUES (?,?,?,?,?)`
    ).run(l.id, l.name, 'error', reason.slice(0, 500), model);
    audit({ kind: 'moderate', action: 'error', listingId: l.id, result: reason, ok: 0 });
    notifyAdminUnsure(l, reason);
    return { decision: 'pending', reason, failed: true };
  }

  if (decision === 'approve') {
    tools.approveListingRow(l);
  } else if (decision === 'reject') {
    tools.rejectListingRow(l);
  } else {
    notifyAdminUnsure(l, reason);
  }

  db.prepare(
    `INSERT INTO ai_moderation_log (listing_id, listing_name, decision, reason, model)
     VALUES (?,?,?,?,?)`
  ).run(l.id, l.name, decision, reason.slice(0, 800), model);
  audit({
    kind: 'moderate',
    action: decision,
    listingId: l.id,
    payload: { confidence },
    result: reason,
    ok: decision === 'error' ? 0 : 1,
  });
  return { decision, reason, confidence, model };
}

function notifyAdminUnsure(l, reason) {
  notify.notifyAdmin({
    kind: 'listing',
    title: `AI left “${l.name}” pending`,
    body: reason || 'The model was not confident enough to approve or reject.',
    url: '/admin3119Musa/listings?status=pending',
  });
  if (getSetting('ai_moderation_email', '1') === '1') {
    sendBranded(adminNotifyEmail(), `AI moderation needs you — ${l.name}`, {
      alias: 'admin',
      kicker: 'AI auto-moderation',
      title: `“${escHtml(l.name)}” is still pending`,
      preheader: 'The AI was not confident enough to approve or reject this listing.',
      alert: 'AI auto-moderation left a listing in the review queue.',
      alertTone: 'info',
      paragraphs: [
        escHtml(reason || 'The model was not confident.'),
        `Listing: <b>${escHtml(l.name)}</b> · ${escHtml(l.category || '')} · ${escHtml(l.website || '')}`,
      ],
      cta: { label: 'Review pending listings', url: siteUrl('/admin3119Musa/listings?status=pending') },
      note: 'Turn off these emails in Admin → AI Playground → Settings.',
    }).catch(() => {});
  }
}

/** Does an environment variable already pin this provider's key? */
function envKeySet(p) {
  return (p.env || []).some((name) => String(process.env[name] || '').trim());
}

function settingsSnapshot() {
  const keySet = groq.groqConfigured();
  const src = groq.groqKeySource();
  const live = groq.liveSnapshot();
  let pending = 0;
  try { pending = db.prepare('SELECT COUNT(*) AS c FROM ai_pending_actions').get().c; } catch { pending = 0; }
  return {
    /* Multi-provider model gateway — Groq stays the default. */
    provider: llm.activeId(),
    provider_label: llm.provider(llm.activeId()).label,
    providers: llm.providersView(),
    providers_configured: llm.configuredProviders(),
    groq_configured: keySet,
    groq_key_source: src,
    groq_key_set: keySet,
    groq_env: src === 'env',
    groq_key_hint: groq.maskKey(groq.groqKey()),
    groq_base_url: groq.baseUrl(),
    groq_model: groq.modelId(),
    groq_default_model: groq.DEFAULT_MODEL,
    models: groq.usableModels(),
    live_models: live.ids,
    live_checked_at: live.checked_at,
    moderation_on: isModerationOn(),
    moderation_model: moderationModelId(),
    moderation_rules: getSetting('ai_moderation_rules', '') || DEFAULT_MODERATION_RULES,
    moderation_email: getSetting('ai_moderation_email', '1') === '1',
    default_rules: DEFAULT_MODERATION_RULES,
    tools: tools.catalog(),
    tool_groups: tools.GROUPS,
    auto_tools: [...tools.autoSet()],
    sensitive_tools: tools.sensitiveTools(),
    pending_actions: pending,
  };
}

/** Rows for the Settings tab tables (also the JSON endpoint behind “Load more”). */
function logSnapshot(limit = 40) {
  return {
    moderation: logsPage('moderation', { limit: 50 }),
    audit: logsPage('audit', { limit }),
  };
}

function saveSettings(body) {
  /* Validate the complete provider/model portion before changing the active
     provider or persisting any key. A stale select must fail atomically from
     the operator's point of view, rather than switching the console and then
     failing halfway through the form. */
  for (const p of llm.PROVIDERS) {
    const field = `llm_model_${p.id}`;
    if (body[field] !== undefined) {
      const candidate = String(body[field] || '').trim();
      if (candidate && !llm.isKnownModel(candidate, p.id)) {
        const retired = llm.isRetiredModel(candidate, p.id);
        const err = new Error(retired
          ? `“${candidate.slice(0, 80)}” was retired by ${p.label} and can no longer be called. Choose a current model instead.`
          : `“${candidate.slice(0, 80)}” is not currently available for ${p.label}. Test & sync models, then choose an available model.`);
        err.status = 422;
        err.code = 'bad_model';
        throw err;
      }
    }
    /* A malformed endpoint override would turn every call into a network 502 —
       reject it at save time with the exact field named. */
    const baseField = `llm_base_${p.id}`;
    if (body[baseField] !== undefined) {
      const candidate = String(body[baseField] || '').trim();
      if (candidate && !/^https?:\/\/[^/\s]+(\/\S*)?$/.test(candidate)) {
        const err = new Error(`The endpoint override for ${p.label} must be a full http(s) URL (e.g. https://llm.internal.example/v1) — “${candidate.slice(0, 80)}” would break every call.`);
        err.status = 422;
        err.code = 'bad_base_url';
        throw err;
      }
    }
  }
  /* ---- Model providers: pick one, paste keys, choose models, set endpoints ---- */
  if (body.llm_provider !== undefined && String(body.llm_provider || '').trim()) {
    const pid = String(body.llm_provider).trim();
    if (!llm.isValidProvider(pid)) {
      const err = new Error(`“${pid}” is not a model provider this console knows.`);
      err.status = 422;
      throw err;
    }
    llm.setActiveProvider(pid);
  }
  for (const p of llm.PROVIDERS) {
    const pid = p.id;
    /* Keys: env always wins, and an empty field must never wipe a saved key. */
    const keyField = `llm_key_${pid}`;
    if (body[keyField] !== undefined && !envKeySet(p)) {
      const k = String(body[keyField] || '').trim();
      if (k) llm.setApiKey(pid, k);
      if (String(body[`${keyField}_clear`] || '') === '1') llm.setApiKey(pid, '');
    }
    if (body[`llm_model_${pid}`] !== undefined) {
      const m = String(body[`llm_model_${pid}`] || '').trim();
      if (m) llm.setModel(pid, m);
    }
    if (body[`llm_base_${pid}`] !== undefined) {
      const b = String(body[`llm_base_${pid}`] || '').trim();
      if (b || p.allowCustom || p.baseEnv) llm.setBaseUrl(pid, b);
    }
  }
  if (body.groq_model !== undefined) {
    /* Legacy clients still post groq_model. Keep accepting and round-tripping
       it, but modelFor() will ignore it when a live catalog says it is stale. */
    const m = String(body.groq_model || '').trim();
    if (m && llm.provider('groq').models.some((x) => x.id === m)) setSetting('groq_model', m);
  }
  if (!process.env.GROQ_API_KEY && body.groq_api_key !== undefined) {
    const k = String(body.groq_api_key || '').trim();
    if (k) setSetting('groq_api_key', k.slice(0, 200));
    if (String(body.groq_api_key_clear || '') === '1') setSetting('groq_api_key', '');
  }
  // Unchecked boxes are omitted from the POST — treat missing as off on a settings save.
  if (body.groq_model !== undefined || body.ai_moderation_on !== undefined || body.ai_moderation_rules !== undefined) {
    setSetting('ai_moderation_on', body.ai_moderation_on === '1' || body.ai_moderation_on === true || body.ai_moderation_on === 'on' ? '1' : '0');
    setSetting('ai_moderation_email', body.ai_moderation_email === '1' || body.ai_moderation_email === true || body.ai_moderation_email === 'on' ? '1' : '0');
  }
  if (body.ai_moderation_rules !== undefined) {
    setSetting('ai_moderation_rules', String(body.ai_moderation_rules || '').slice(0, 8000));
  }
  if (body.ai_moderation_model !== undefined) {
    const m = String(body.ai_moderation_model || '').trim();
    if (!m || m === '__default__') setSetting('ai_moderation_model', '');
    else if (llm.isKnownModel(m, llm.activeId())) setSetting('ai_moderation_model', m);
  }
  if (body.ai_auto_tools_present !== undefined) {
    const raw = body.ai_auto_tools;
    const names = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    tools.saveAutoTools(names);
  }
  audit({
    kind: 'settings',
    action: 'save',
    payload: {
      provider: llm.activeId(),
      model: llm.modelFor(llm.activeId()),
      providers_with_keys: llm.configuredProviders(),
      moderation_on: getSetting('ai_moderation_on', '0'),
      moderation_model: getSetting('ai_moderation_model', ''),
      auto_tools: [...tools.autoSet()],
    },
  });
}

/* ---------------- Logs (audit + moderation tables, with paging) ---------------- */

const LOG_KINDS = {
  moderation: {
    from: 'FROM ai_moderation_log m LEFT JOIN listings l ON l.id = m.listing_id',
    select: `SELECT m.*, l.slug, l.status AS listing_status
             FROM ai_moderation_log m LEFT JOIN listings l ON l.id = m.listing_id`,
    search: ['m.listing_name', 'm.reason', 'm.decision', 'm.model'],
    order: 'm.id DESC',
    defaultLimit: 50,
  },
  audit: {
    from: 'FROM ai_audit_log',
    select: 'SELECT * FROM ai_audit_log',
    search: ['kind', 'action', 'result'],
    order: 'id DESC',
    defaultLimit: 40,
  },
};

/* One filter builder feeds both the page and its total, so “load more” can never
   disagree with the count shown in the table header. */
function logsPage(kind, opts = {}) {
  const cfg = LOG_KINDS[kind];
  if (!cfg) {
    const err = new Error(`Unknown log “${kind}”.`);
    err.status = 422;
    throw err;
  }
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || cfg.defaultLimit));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const term = String(opts.q || '').trim().replace(/[%_*"']/g, '').slice(0, 60);
  const clauses = term ? cfg.search.map((col) => `${col} LIKE ?`) : [];
  const where = clauses.length ? `WHERE (${clauses.join(' OR ')})` : '';
  const params = term ? cfg.search.map(() => `%${term}%`) : [];
  const rows = db.prepare(
    `${cfg.select} ${where} ORDER BY ${cfg.order} LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS c ${cfg.from} ${where}`).get(...params).c;
  return {
    kind, rows, total, limit, offset,
    term,
    has_more: offset + rows.length < total,
  };
}

function recentModeration(limit = 50, offset = 0) {
  return logsPage('moderation', { limit, offset }).rows;
}

function recentAudit(limit = 40, offset = 0) {
  return logsPage('audit', { limit, offset }).rows;
}

/** Resolve a requested model against the active provider; fall back to its default. */
function chatModelFor(requested) {
  const cand = String(requested || '').trim();
  if (cand && llm.isKnownModel(cand, llm.activeId())) return cand;
  return llm.modelFor(llm.activeId());
}
/** Oldest un-reviewed submissions — feeds the “Review one now” picker. */
function oldestPending(limit = 30) {
  const n = Math.max(1, Math.min(100, Number(limit) || 30));
  return db.prepare(
    `SELECT id, name, category FROM listings WHERE status = 'pending'
     ORDER BY datetime(created_at) ASC, id ASC LIMIT ?`
  ).all(n);
}

function deleteAuditLogEntry(id) {
  return db.prepare('DELETE FROM ai_audit_log WHERE id = ?').run(Number(id) || 0);
}

function deleteModerationLogEntry(id) {
  return db.prepare('DELETE FROM ai_moderation_log WHERE id = ?').run(Number(id) || 0);
}


module.exports = {
  DEFAULT_MODERATION_RULES,
  audit, generateListing, publishListing, applyListingLimits, envKeySet,
  chatTurn, executePending, cancelPending,
  scheduleModeration, moderateListing, isModerationOn, moderationModelId,
  settingsSnapshot, saveSettings, recentModeration, recentAudit, logsPage, logSnapshot, oldestPending,
  deleteAuditLogEntry, deleteModerationLogEntry,
};
