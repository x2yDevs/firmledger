/**
 * FirmLedger AI Playground — listing generator, admin assistant, auto-moderation.
 *
 * Every model call stays on the server and goes through src/lib/llm.js, so the
 * console works with whichever provider the admin connected (Groq, OpenAI,
 * Claude, Gemini, DeepSeek, Hugging Face, OpenRouter, Mistral, xAI, Together,
 * Cerebras, Fireworks, SambaNova, Perplexity, Azure or any OpenAI-compatible
 * endpoint). No key is ever exposed to the browser.
 *
 * Confirmation policy: lookups run immediately; write actions wait for the
 * operator's confirm (ai_pending_actions) unless they were ticked under
 * Settings → Auto-run; SENSITIVE actions (deletions, bulk operations, mailing
 * every member, credentials, security, site-wide switches) always confirm and
 * can never be auto-run.
 *
 * The assistant is stateless: no chat history is stored. Context comes from the
 * messages visible in the current browser tab plus the live site briefing built
 * by src/lib/sitecontext.js, so it answers from the real database rather than
 * from an idea of the site.
 */
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('../db');
const groq = require('./groq');
const llm = require('./llm');
const sitecontext = require('./sitecontext');
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
  const label = steps.length === 1
    ? `${tools.isSensitive(steps[0].name) ? '⚠ ' : ''}${steps[0].name}`
    : `${steps.length} actions${steps.some((s) => tools.isSensitive(s.name)) ? ' (sensitive)' : ''}`;
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
  const auto = [...tools.autoSet()];
  const sensitive = tools.catalog().filter((t) => t.sensitive).map((t) => t.name);
  const stats = tools.stats();
  const active = llm.activeProviderId();
  const autoLine = auto.length
    ? `These write tools are configured to run immediately (no confirm): ${auto.join(', ')}.`
    : 'Every write tool requires operator confirmation before it runs.';
  return `You are the FirmLedger admin assistant, operating the LIVE admin console of this exact installation. You have full administrative reach: ${stats.total} real actions across every console area — ${stats.reads} lookups that run immediately, ${stats.writes} write actions, ${stats.sensitive} of which are sensitive and always stop for the operator's confirmation. Nothing about this site is out of reach; when you do not know something, look it up instead of guessing.

=== THE SITE YOU OPERATE ===
${sitecontext.context({ compact: true })}

=== YOUR ACTIONS ===
${tools.capabilityPrompt()}
Each action's exact arguments travel in the tool schemas. Tag meanings: (read) runs immediately, (write) proposes first unless auto-run is on, (WRITE-CONFIRM) always proposes and waits for the operator.

=== HOW TO WORK ===
1. Understand first. For any question about the site itself — how a feature works, what a table holds, which page does what — use site_overview (topics: product, rules, admin, public, data, schema, live, settings, tools), get_site_schema, get_settings or query_database. You are expected to know this site completely.
2. Look up before you act. Never invent an id, slug, email, ref or count. Resolve records with get_listing, get_user, search_listings, search_users, search_admin, find_duplicate_listings, or the list_* tools, then act on what you actually found. query_database covers any lookup the dedicated tools do not (joins, aggregates, date ranges) — it is strictly read-only.
3. Finish the whole job. If a request needs several actions, call them — one after another is fine, and you may call several tools in a single response. You will be given each tool's real result before you answer, so keep going until the task is genuinely complete.
4. Ask when it is ambiguous. Which listing? Which member? What price? Ask one short clarifying question rather than acting on a guess.
5. Report only what happened. Never claim a write you did not make. If a tool returned an error, say so plainly, quote the reason, and do not describe it as done. If an action is waiting for confirmation, say exactly what will happen and that nothing has changed yet.
6. Propose sensitive work explicitly. For a sensitive action, restate the blast radius in your proposal — how many records, who gets emailed, what becomes irreversible — so the operator can decide with the facts in front of them.
7. Never batch a destructive action with unrelated ones just to save a step; group actions that belong to the same job.

=== RULES ===
- ${autoLine}
- Sensitive actions ALWAYS require the operator's confirmation and can never be auto-run: ${sensitive.join(', ')}.
- Irreversible or wide-reaching work (delete a listing or account, bulk actions, mailing every member, turning on maintenance, fulfilling a removal request, clearing logs, changing credentials or security settings) only when the operator explicitly asks for it. If the request is implied rather than explicit, confirm what they want first.
- API keys, passwords, OTPs, recovery codes, password hashes and the hidden console path are never repeated back, even partially. Refer to them as "stored on the server".
- Money and access: never invent a payment. Pro grants, plan changes, promo codes and sponsorships change what a member can see and are recorded in the audit log — state the reason in the note argument when there is one.
- Prefer the narrowest action that does the job (one listing rather than a filter; one member rather than an audience).
- Be concise. Lead with what changed or what you found, then the detail the operator needs.`;
}

/* How far one turn may go on its own before it must come back to the operator. */
const MAX_MODEL_STEPS = 6;   // model round-trips per turn
const MAX_TOOL_RUNS = 12;    // tool executions per turn

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
  const useTools = groq.supportsTools(model);

  for (let step = 0; step < budgetSteps; step++) {
    const data = await groq.chat({
      model,
      temperature: 0.2,
      max_tokens: 900,
      ...(useTools ? { tools: tools.groqTools(), tool_choice: 'auto' } : {}),
      messages: convo,
    });
    usedModel = data._model || usedModel;
    usage = groq.usage(data) || usage;

    const text = groq.assistantText(data) || '';
    const choice = data.choices && data.choices[0];
    const assistantMessage = (choice && choice.message) || { role: 'assistant', content: text };
    const calls = useTools ? readCalls(groq.toolCalls(data)) : [];

    if (!calls.length) {
      audit({ kind: 'chat', action: 'reply', payload: { steps: ran.length }, result: text.slice(0, 400) });
      const content = text
        || (ran.length ? receipt(ran) : 'I could not verify an action or lookup from that request, so nothing was changed. Please rephrase it or include the listing, user, or record identifier.');
      return {
        type: 'message',
        content,
        model: usedModel,
        usage,
        executed: ran.some((r) => r.ok),
        steps: ran.map((r) => ({ tool: r.tool, ok: r.ok, error: r.error })),
        tool: ran.length ? ran[ran.length - 1].tool : '',
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

    /* Anything not explicitly allowed to auto-run stops here for the operator:
       every write, and always every sensitive action. */
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
      const sensitive = calls.some((c) => tools.isSensitive(c.name));
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
        sensitive,
        tool: {
          name: calls.length === 1 ? calls[0].name : calls.map((c) => c.name).join(' + '),
          label,
          mutating: calls.some((c) => Boolean((tools.getTool(c.name) || {}).mutating)),
          sensitive,
          auto: false,
          args: calls.length === 1 ? calls[0].args : calls.map((c) => ({ action: c.name, arguments: c.args })),
          /* One row per step, with everything the confirm dialog needs to show
             the operator exactly what is about to happen. */
          steps: calls.map((c) => ({
            name: c.name,
            label: tools.describeCall(c.name, c.args),
            args: c.args,
            sensitive: tools.isSensitive(c.name),
            group: (tools.getTool(c.name) || {}).group || 'ops',
          })),
        },
        done: ran.map((r) => ({ tool: r.tool, ok: r.ok })),
      };
    }

    if (ran.length + calls.length > MAX_TOOL_RUNS) {
      return {
        type: 'message',
        content: `${receipt(ran)}\n\nI stopped there — that request needs more than ${MAX_TOOL_RUNS} actions in one turn. Ask me to continue and I will pick up from here.`,
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

  /* Budget spent — ask for a plain summary of what actually happened. */
  let content = receipt(ran);
  try {
    const data = await groq.chat({
      /* `model` already came from chatModelFor(), so it is provider-aware. */
      ...(model ? { model } : {}),
      temperature: 0.2,
      max_tokens: 500,
      messages: [...convo, { role: 'user', content: 'Summarise, in two sentences, exactly what was done and what is still outstanding. Do not claim anything the tool results do not show.' }],
    });
    content = groq.assistantText(data) || content;
    usedModel = data._model || usedModel;
  } catch { /* the receipt is a perfectly good fallback */ }
  return {
    type: 'message',
    content,
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

/* Auto-moderation can run on a different model — even a different provider —
   than the assistant: "gemini:gemini-2.5-flash-lite" or a bare id. Falls back
   to the active provider's model when unset. */
function moderationModelId() {
  const m = String(getSetting('ai_moderation_model', '') || '').trim();
  if (!m) return llm.activeModel();
  const ref = llm.splitModelRef(m);
  if (ref.provider && llm.configured(ref.provider)) return m;
  if (llm.isKnownModel(ref.model)) return ref.model;
  return llm.activeModel();
}

/** Moderation model options for the settings UI, across every connected provider. */
function moderationModelChoices() {
  const out = [];
  for (const p of llm.providerSnapshot()) {
    if (!p.configured) continue;
    for (const m of p.models) {
      if (!m.json) continue;
      out.push({
        id: p.id === llm.activeProviderId() ? m.id : `${p.id}:${m.id}`,
        label: `${m.label} · ${p.label}`,
        provider: p.id,
      });
    }
  }
  return out.slice(0, 200);
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
        ).run(id, '', 'error', String(e.message || 'unknown').slice(0, 500), moderationModelId());
      } catch { /* ignore */ }
    });
  });
}

async function moderateListing(listingId) {
  const l = db.prepare('SELECT * FROM listings WHERE id=?').get(listingId);
  if (!l) return { skipped: true, reason: 'missing' };
  if (l.status !== 'pending') return { skipped: true, reason: 'not_pending' };
  if (!llm.configured(llm.activeProviderId())) {
    audit({ kind: 'moderate', action: 'skipped_no_key', listingId: l.id, result: 'no provider key', ok: 0 });
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

/** Every connected provider, ready for the Providers panel in the console. */
function providerSnapshot() {
  const active = llm.activeProviderId();
  return {
    active,
    active_label: (llm.provider(active) || {}).label || active,
    model: llm.savedModel(active),
    failover: llm.failoverEnabled(),
    rate_limit_per_min: llm.rateLimitPerMinute(),
    order: llm.providerOrder(),
    providers: llm.providerSnapshot(),
  };
}

function settingsSnapshot() {
  const active = llm.activeProviderId();
  const providers = providerSnapshot();
  const keySet = llm.configured(active);
  const live = llm.liveSnapshot(active);
  let pending = 0;
  try { pending = db.prepare('SELECT COUNT(*) c FROM ai_pending_actions').get().c; } catch { pending = 0; }
  return {
    /* ---- provider-neutral surface the playground UI is built on ---- */
    configured: keySet,
    provider: active,
    provider_label: providers.active_label,
    providers,
    provider_list: providers.providers,
    model: llm.savedModel(active),
    models: llm.usableModels(active),
    key_source: llm.keySource(active),
    key_set: keySet,
    key_hint: llm.maskKey(llm.apiKey(active)),
    base_url: llm.baseUrl(active),
    failover: llm.failoverEnabled(),
    rate_limit_per_min: llm.rateLimitPerMinute(),
    live_models: live.ids,
    live_checked_at: live.checked_at,

    /* ---- legacy names, still consumed by the view and older bookmarks ---- */
    groq_configured: keySet,
    groq_key_source: llm.keySource(active),
    groq_key_set: keySet,
    groq_env: llm.keySource(active) === 'env',
    groq_key_hint: llm.maskKey(llm.apiKey(active)),
    groq_base_url: llm.baseUrl(active),
    groq_model: llm.savedModel(active),
    groq_default_model: (llm.provider(active) || {}).defaultModel || groq.DEFAULT_MODEL,
    groq_provider: active,

    /* ---- moderation ---- */
    moderation_on: isModerationOn(),
    moderation_model: moderationModelId(),
    moderation_model_choices: moderationModelChoices(),
    moderation_rules: getSetting('ai_moderation_rules', '') || DEFAULT_MODERATION_RULES,
    moderation_email: getSetting('ai_moderation_email', '1') === '1',
    default_rules: DEFAULT_MODERATION_RULES,

    /* ---- assistant policy ---- */
    tools: tools.catalog(),
    tool_groups: tools.GROUPS,
    enabled_groups: tools.enabledGroups(),
    auto_tools: [...tools.autoSet()],
    tool_stats: tools.stats(),
    pending_actions: pending,

    /* ---- what the assistant is told about the site ---- */
    site_briefing_chars: sitecontext.context({ compact: true }).length,
  };
}

/** Rows for the Settings tab tables (also the JSON endpoint behind “Load more”). */
function logSnapshot(limit = 40) {
  return {
    moderation: logsPage('moderation', { limit: 50 }),
    audit: logsPage('audit', { limit }),
  };
}

/**
 * Persist the Playground settings form.
 *
 * Provider keys are only written when the POST actually carries them, and an
 * environment variable always wins over the stored value — a deployment that
 * pins a key in .env cannot have it overwritten from the browser. Unchecked
 * boxes never arrive in a POST body, so "present" markers decide the booleans.
 */
function saveSettings(body) {
  const b = body || {};

  /* ---- active provider + failover + rate cap ---- */
  if (b.ai_provider !== undefined) {
    const pid = String(b.ai_provider || '').trim().toLowerCase();
    if (llm.isProviderId(pid)) setSetting('ai_provider', pid);
  }
  if (b.ai_failover !== undefined || b.ai_failover_present !== undefined) {
    setSetting('ai_failover', b.ai_failover === '1' || b.ai_failover === true || b.ai_failover === 'on' ? '1' : '0');
  }
  if (b.ai_rate_limit_per_min !== undefined) {
    const n = Math.round(Number(b.ai_rate_limit_per_min));
    if (n >= 1 && n <= 600) setSetting('ai_rate_limit_per_min', String(n));
  }
  if (b.ai_provider_order !== undefined) {
    const raw = b.ai_provider_order;
    let list = Array.isArray(raw) ? raw : String(raw || '').split(',');
    llm.saveProviderOrder(list.map((x) => String(x).trim()));
  }

  /* ---- per-provider keys, models, base URLs, hand-typed model ids ---- */
  for (const p of llm.PROVIDERS) {
    const envLocked = (p.envKeys || []).some((k) => String(process.env[k] || '').trim());

    const keyField = b[`${p.id}_api_key`];
    if (!envLocked && keyField !== undefined) {
      const k = String(keyField || '').trim();
      if (k) setSetting(p.keySetting, k.slice(0, 300));
    }
    if (!envLocked && String(b[`${p.id}_api_key_clear`] || '') === '1') setSetting(p.keySetting, '');

    const modelField = b[`${p.id}_model`];
    if (modelField !== undefined) {
      const m = String(modelField || '').trim().slice(0, 160);
      if (m) {
        if (!llm.knownModelIds(p.id).includes(m)) llm.addCustomModelId(p.id, m);
        llm.setSavedModel(p.id, m);
      }
    }

    if (b[`${p.id}_base_url`] !== undefined) {
      const url = String(b[`${p.id}_base_url`] || '').trim().replace(/\/+$/, '').slice(0, 300);
      if (url && !/^https?:\/\//i.test(url)) {
        const err = new Error(`${p.label}: the base URL must start with http:// or https://.`);
        err.status = 422;
        throw err;
      }
      setSetting(`ai_base_url_${p.id}`, url);
    }

    const extraField = b[`${p.id}_extra_models`];
    if (extraField !== undefined) {
      const ids = String(extraField).split(/[\n,]+/).map((x) => x.trim()).filter(Boolean).slice(0, 40);
      setSetting(`ai_custom_models_${p.id}`, JSON.stringify([...new Set(ids)]));
    }
  }
  if (b.ai_custom_auth_header !== undefined) {
    const h = String(b.ai_custom_auth_header || '').trim().toLowerCase();
    setSetting('ai_custom_auth_header', h === 'api-key' ? 'api-key' : 'bearer');
  }

  /* ---- legacy Groq field names (older bookmarks / scripts) ---- */
  if (b.groq_model !== undefined && !b.groq_model.startsWith('groq:')) {
    const m = String(b.groq_model || '').trim();
    if (m) llm.setSavedModel('groq', m);
  }
  if (!process.env.GROQ_API_KEY && b.groq_api_key !== undefined && b.groq_provider === undefined) {
    const k = String(b.groq_api_key || '').trim();
    if (k) setSetting('groq_api_key', k.slice(0, 300));
    if (String(b.groq_api_key_clear || '') === '1') setSetting('groq_api_key', '');
  }

  /* ---- auto-moderation ---- */
  if (b.groq_model !== undefined || b.ai_moderation_on !== undefined || b.ai_moderation_rules !== undefined
    || b.ai_provider !== undefined) {
    setSetting('ai_moderation_on', b.ai_moderation_on === '1' || b.ai_moderation_on === true || b.ai_moderation_on === 'on' ? '1' : '0');
    setSetting('ai_moderation_email', b.ai_moderation_email === '1' || b.ai_moderation_email === true || b.ai_moderation_email === 'on' ? '1' : '0');
  }
  if (b.ai_moderation_rules !== undefined) {
    setSetting('ai_moderation_rules', String(b.ai_moderation_rules || '').slice(0, 8000));
  }
  if (b.ai_moderation_model !== undefined) {
    const m = String(b.ai_moderation_model || '').trim();
    if (!m || m === '__default__') setSetting('ai_moderation_model', '');
    else setSetting('ai_moderation_model', m.slice(0, 160));
  }

  /* ---- assistant policy: auto-run + which tool groups are in reach ---- */
  if (b.ai_auto_tools_present !== undefined) {
    const raw = b.ai_auto_tools;
    const names = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    tools.saveAutoTools(names);
  }
  if (b.ai_tool_groups_present !== undefined) {
    const raw = b.ai_tool_groups;
    const groups = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    tools.saveEnabledGroups(groups);
  }

  audit({
    kind: 'settings',
    action: 'save',
    payload: {
      provider: llm.activeProviderId(),
      model: llm.savedModel(llm.activeProviderId()),
      failover: llm.failoverEnabled(),
      moderation_on: getSetting('ai_moderation_on', '0'),
      moderation_model: getSetting('ai_moderation_model', ''),
      auto_tools: [...tools.autoSet()],
      tool_groups: tools.enabledGroups(),
    },
  });
}

/** "Use this provider" from the console — switches the live backend at once. */
function useProvider(providerId, model) {
  const pid = String(providerId || '').trim().toLowerCase();
  if (!llm.isProviderId(pid)) {
    const err = new Error(`“${String(providerId || '').slice(0, 40)}” is not a supported provider.`);
    err.status = 422;
    throw err;
  }
  if (!llm.configured(pid)) {
    const p = llm.provider(pid);
    const err = new Error(`${p.label} has no API key yet. Paste one and save before switching to it${p.envKeys && p.envKeys[0] ? ` (or set ${p.envKeys[0]} in .env)` : ''}.`);
    err.status = 422;
    throw err;
  }
  if (!llm.baseUrl(pid)) {
    const err = new Error(`${llm.provider(pid).label} needs a base URL before it can be used.`);
    err.status = 422;
    throw err;
  }
  llm.setActiveProvider(pid);
  const m = String(model || '').trim();
  if (m) {
    if (!llm.knownModelIds(pid).includes(m)) llm.addCustomModelId(pid, m);
    llm.setSavedModel(pid, m);
  }
  audit({ kind: 'settings', action: 'use_provider', payload: { provider: pid, model: llm.savedModel(pid) } });
  return { provider: pid, label: llm.provider(pid).label, model: llm.savedModel(pid) };
}

/** Verify one provider end to end: key, live model list, one tiny completion. */
async function testProvider(providerId, model) {
  const pid = String(providerId || '').trim().toLowerCase() || llm.activeProviderId();
  if (!llm.isProviderId(pid)) {
    const err = new Error(`“${String(providerId || '').slice(0, 40)}” is not a supported provider.`);
    err.status = 422;
    throw err;
  }
  const result = await llm.testConnection(pid, model);
  audit({
    kind: 'settings',
    action: 'test',
    payload: { provider: pid, model: model || llm.savedModel(pid) },
    result: result.ok ? `ok${result.used_model ? ` · ${result.used_model}` : ''}` : (result.error || 'failed'),
    ok: result.ok ? 1 : 0,
  });
  return result;
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

/**
 * Resolve the model the console should use for a call.
 * Accepts "model-id" (active provider) or "provider:model-id" (an explicit
 * backend — auto-moderation can run on a different vendor than the assistant),
 * plus any id the provider's live list or the admin's typed list contains.
 * Falls back to the active provider's saved model.
 */
function chatModelFor(requested) {
  const cand = String(requested || '').trim();
  if (!cand) return llm.activeModel();
  const ref = llm.splitModelRef(cand);
  if (ref.provider) return cand;                 // keep the explicit provider
  if (llm.isKnownModel(ref.model)) return ref.model;
  /* Unknown id: still pass it through when it looks like a real model name —
     vendors ship models faster than the catalogue, and llm.chat falls back. */
  if (ref.model && ref.model.length <= 160 && /[a-z0-9]/i.test(ref.model)) return ref.model;
  return llm.activeModel();
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
  audit, generateListing, publishListing, applyListingLimits,
  chatTurn, executePending, cancelPending, assistantSystemPrompt,
  scheduleModeration, moderateListing, isModerationOn, moderationModelId, moderationModelChoices,
  settingsSnapshot, saveSettings, providerSnapshot, useProvider, testProvider,
  recentModeration, recentAudit, logsPage, logSnapshot, oldestPending,
  deleteAuditLogEntry, deleteModerationLogEntry, chatModelFor,
};
