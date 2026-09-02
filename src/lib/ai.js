/**
 * FirmLedger AI Playground — listing generator, admin assistant, auto-moderation.
 * All Groq calls stay on the server. Mutating assistant tools wait for UI
 * confirmation (ai_pending_actions) unless the admin ticked them under Settings
 * → Auto-run. Lookups always run immediately. delete_user always confirms.
 */
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('../db');
const groq = require('./groq');
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
  const model = chatModelFor(opts.model, null);
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

function storePending({ tool, args, messages, assistantMessage, sessionId = 0 }) {
  sweepPending();
  const id = 'act_' + crypto.randomBytes(16).toString('hex');
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(
    `INSERT INTO ai_pending_actions (id, tool, args, messages, expires_at) VALUES (?,?,?,?,?)`
  ).run(id, tool, JSON.stringify(args || {}),
    JSON.stringify({ messages, assistantMessage, sessionId }), expires);
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
  const autoLine = auto.length
    ? `These write tools are configured to run immediately (no confirm): ${auto.join(', ')}.`
    : 'Every write tool requires operator confirmation before it runs.';
  return `You are the FirmLedger admin assistant. You operate the live admin console using tools — listings, users, billing, claims, tickets, removals, blog, email, careers, promos, advertising, protection, maintenance, status incidents, and settings.

Available tools:
${tools.capabilityPrompt()}

Rules:
- Prefer a tool for any admin action or factual lookup. Do not invent ids, emails, slugs or counts.
- If a request is ambiguous (which listing / which user?), ask a clarifying question instead of calling a tool.
- Never claim you already did a write. The UI either auto-runs allowed tools or asks the operator to confirm.
- ${autoLine}
- Destructive actions (delete user, delete listing, email everyone, maintenance on, fulfill removal) only when the operator is explicit.
- Be concise.`;
}

/**
 * One assistant turn.
 *
 * opts.session_id → the stored transcript is the source of truth. The tail of the
 *   conversation is read back from SQLite (never from the browser), the new line is
 *   written first, and the reply is written after, so a reload always shows exactly
 *   what the model saw. opts.text is the message being sent.
 * No session → the caller's `history` array is used and nothing is stored.
 */
async function chatTurn(history, opts = {}) {
  const session = opts.session_id ? getChatSessionForUser(opts.session_id, opts.userId) : null;
  const model = chatModelFor(opts.model, session);
  let messages;

  if (session) {
    const text = String(opts.text || '').trim().slice(0, 4000);
    if (text) addChatMessage(session.id, 'user', text, { model });
    messages = sanitiseHistory([...transcriptForModel(session.id)]);
  } else {
    messages = sanitiseHistory(history);
  }
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

  const useTools = groq.supportsTools(model);
  let data;
  try {
    data = await groq.chat({
      model,
      temperature: 0.2,
      max_tokens: 900,
      ...(useTools ? { tools: tools.groqTools(), tool_choice: 'auto' } : {}),
      messages: [{ role: 'system', content: assistantSystemPrompt() }, ...messages],
    });
  } catch (e) {
    if (session) {
      addChatMessage(session.id, 'assistant', `Groq could not answer: ${e.message}`, {
        model, ok: false,
      });
    }
    throw e;
  }

  const usedModel = data._model || model;
  const calls = useTools ? groq.toolCalls(data) : [];
  const text = groq.assistantText(data) || '';
  const choice = data.choices && data.choices[0];
  const assistantMessage = choice && choice.message ? choice.message : { role: 'assistant', content: text };

  if (calls.length) {
    const call = calls[0];
    const name = (call.function && call.function.name) || call.name;
    const args = tools.parseArgs(call.function && call.function.arguments);
    const t = tools.getTool(name);
    if (!t) {
      const content = text || `I wanted to run “${name}” but that action is not registered.`;
      if (session) addChatMessage(session.id, 'assistant', content, { model: usedModel, ok: false });
      return { type: 'message', content, model: usedModel, usage: groq.usage(data), session_id: session ? session.id : 0 };
    }
    if (tools.isAuto(name)) {
      audit({ kind: 'chat', action: 'auto:' + name, payload: args, result: 'auto-run' });
      return finishToolTurn({
        tool: name, args, messages, assistantMessage, auto: true, session, model: usedModel,
      });
    }
    const pendingId = storePending({
      tool: name, args, messages, assistantMessage, sessionId: session ? session.id : 0,
    });
    audit({ kind: 'chat', action: 'propose:' + name, payload: args, result: pendingId });
    const content = text || `I can ${tools.describeCall(name, args)}. Confirm to run it.`;
    if (session) {
      addChatMessage(session.id, 'assistant', content, { model: usedModel, tool: `propose:${name}` });
    }
    return {
      type: 'tool_proposal',
      pending_id: pendingId,
      content,
      model: usedModel,
      usage: groq.usage(data),
      session_id: session ? session.id : 0,
      expires_in_sec: 600,
      tool: {
        name,
        label: tools.describeCall(name, args),
        mutating: Boolean(t.mutating),
        auto: false,
        args,
      },
    };
  }

  audit({ kind: 'chat', action: 'reply', payload: { preview: last.content.slice(0, 200) }, result: text.slice(0, 400) });
  const content = text || 'Done.';
  if (session) addChatMessage(session.id, 'assistant', content, { model: usedModel });
  return { type: 'message', content, model: usedModel, usage: groq.usage(data), session_id: session ? session.id : 0 };
}

async function finishToolTurn({ tool, args, messages, assistantMessage, auto = false, session = null, model = '' }) {
  let exec;
  try {
    exec = await tools.execute(tool, args);
  } catch (e) {
    audit({ kind: 'tool', action: tool, payload: args, result: e.message, ok: 0 });
    const err = new Error(e.message || 'The action failed.');
    err.status = 500;
    if (session) addChatMessage(session.id, 'assistant', `“${tool}” failed: ${e.message}`, { model, tool, ok: false });
    throw err;
  }
  audit({
    kind: 'tool',
    action: (auto ? 'auto:' : '') + tool,
    payload: args,
    result: exec,
    ok: exec.ok ? 1 : 0,
  });

  const history = sanitiseHistory(messages);
  const assistant = assistantMessage || { role: 'assistant', content: '' };
  const toolCallId = (assistant.tool_calls && assistant.tool_calls[0] && assistant.tool_calls[0].id) || 'call_1';
  const follow = [
    { role: 'system', content: assistantSystemPrompt() },
    ...history,
    assistant,
    {
      role: 'tool',
      tool_call_id: toolCallId,
      name: tool,
      content: JSON.stringify(exec).slice(0, 6000),
    },
  ];

  let content;
  let usedModel = model;
  try {
    const data = await groq.chat({
      ...(model && groq.isKnownModel(model) ? { model } : {}),
      temperature: 0.2,
      max_tokens: 700,
      messages: follow,
    });
    content = groq.assistantText(data);
    usedModel = data._model || usedModel;
  } catch (e) {
    content = exec.ok
      ? `Action completed: ${tool}. ${JSON.stringify(exec.result || exec).slice(0, 400)}`
      : `Action failed: ${exec.error || 'unknown error'}`;
  }
  if (session) {
    addChatMessage(session.id, 'assistant', content || (exec.ok ? 'Done.' : exec.error), {
      model: usedModel, tool, ok: Boolean(exec.ok),
    });
  }
  if (!exec.ok) {
    return {
      type: 'message', content: content || exec.error, error: exec.error,
      executed: false, auto, tool, model: usedModel, session_id: session ? session.id : 0,
    };
  }
  return {
    type: 'message', content: content || 'Done.', executed: true, tool, result: exec.result, auto,
    model: usedModel, session_id: session ? session.id : 0,
  };
}

async function executePending(pendingId, opts = {}) {
  const row = loadPending(pendingId);
  if (!row) {
    const err = new Error('That action expired or was already handled. Ask me again if you still want it.');
    err.status = 410;
    throw err;
  }
  dropPending(row.id);
  const args = tools.parseArgs(row.args);
  let packed;
  try { packed = JSON.parse(row.messages); } catch { packed = { messages: [], assistantMessage: { role: 'assistant', content: '' } }; }
  const sessionId = Number(opts.session_id || packed.sessionId || 0) || 0;
  const session = sessionId ? getChatSessionForUser(sessionId, opts.userId) : null;
  return finishToolTurn({
    tool: row.tool,
    args,
    messages: packed.messages,
    assistantMessage: packed.assistantMessage,
    auto: false,
    session,
  });
}

async function cancelPending(pendingId, opts = {}) {
  const row = loadPending(pendingId);
  if (!row) return { type: 'message', content: 'That action was already cancelled or expired. Nothing ran.' };
  dropPending(row.id);
  audit({ kind: 'tool', action: 'cancel:' + row.tool, payload: tools.parseArgs(row.args), result: 'cancelled', ok: 1 });

  let packed;
  try { packed = JSON.parse(row.messages); } catch { packed = { messages: [] }; }
  const history = sanitiseHistory(packed.messages);
  const assistantMessage = packed.assistantMessage || { role: 'assistant', content: '' };
  const toolCallId = (assistantMessage.tool_calls && assistantMessage.tool_calls[0] && assistantMessage.tool_calls[0].id)
    || 'call_1';

  let content = `Understood — cancelled “${tools.describeCall(row.tool, tools.parseArgs(row.args))}”. Nothing was changed.`;
  const sessionId = Number(opts.session_id || packed.sessionId || 0) || 0;
  const session = sessionId ? ownedChatSession(sessionId, opts.userId) : null;
  try {
    const data = await groq.chat({
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: 'system', content: assistantSystemPrompt() },
        ...history,
        assistantMessage,
        {
          role: 'tool',
          tool_call_id: toolCallId,
          name: row.tool,
          content: JSON.stringify({ cancelled: true, note: 'The operator cancelled this action. Do not retry it unless they ask again.' }),
        },
      ],
    });
    content = groq.assistantText(data) || content;
    if (session) addChatMessage(session.id, 'assistant', content, { model: data._model || '', tool: `cancel:${row.tool}` });
  } catch { /* keep the canned acknowledgement if the model is unreachable */ }
  return { type: 'message', content, cancelled: true, session_id: session ? session.id : 0 };
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
  return groq.isKnownModel(m) ? m : groq.modelId();
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

function settingsSnapshot(userId = 0) {
  const keySet = groq.groqConfigured();
  const src = groq.groqKeySource();
  const live = groq.liveSnapshot();
  let pending = 0;
  try { pending = db.prepare('SELECT COUNT(*) AS c FROM ai_pending_actions').get().c; } catch { pending = 0; }
  return {
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
    chat_window: CHAT_WINDOW,
    moderation_on: isModerationOn(),
    moderation_model: moderationModelId(),
    moderation_rules: getSetting('ai_moderation_rules', '') || DEFAULT_MODERATION_RULES,
    moderation_email: getSetting('ai_moderation_email', '1') === '1',
    default_rules: DEFAULT_MODERATION_RULES,
    tools: tools.catalog(),
    tool_groups: tools.GROUPS,
    auto_tools: [...tools.autoSet()],
    counts: countChatSessions(userId),
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
  if (body.groq_model !== undefined) {
    const m = String(body.groq_model || '').trim();
    if (groq.MODELS.some((x) => x.id === m)) setSetting('groq_model', m);
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
    else if (groq.isKnownModel(m)) setSetting('ai_moderation_model', m);
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
      model: getSetting('groq_model', ''),
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

/* ---------------- Legacy chat session helpers (history disabled in admin UI) ---------------- */

const CHAT_WINDOW = 24;              // stored turns replayed to Groq per request
const MAX_SESSIONS_PER_USER = 400;   // archived chats are pruned past this
const PLACEHOLDER_TITLES = new Set(['', 'new chat', 'new conversation', 'untitled chat']);

function titleFromText(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return 'New chat';
  return flat.length > 56 ? `${flat.slice(0, 55).trimEnd()}…` : flat;
}

function cleanTitle(title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return t || 'New chat';
}

function chatModelFor(requested, session) {
  const cand = String(requested || (session && session.model) || '').trim();
  if (groq.isKnownModel(cand)) return cand;
  return groq.modelId();
}

function getChatSession(sessionId) {
  return db.prepare('SELECT * FROM ai_chat_sessions WHERE id = ?').get(Number(sessionId) || 0) || null;
}

/** Non-fatal variant used after an action resolves: a gone/foreign chat just means “do not persist”. */
function ownedChatSession(sessionId, userId) {
  const s = getChatSession(sessionId);
  if (!s) return null;
  if (userId != null && Number(s.user_id) !== Number(userId || 0)) return null;
  return s;
}

/** Ownership gate — every /session/:id route resolves through this. */
function getChatSessionForUser(sessionId, userId) {
  const s = getChatSession(sessionId);
  if (!s) {
    const err = new Error('That chat no longer exists.');
    err.status = 404;
    throw err;
  }
  if (Number(s.user_id) !== Number(userId || 0)) {
    const err = new Error('That chat belongs to a different operator.');
    err.status = 403;
    throw err;
  }
  return s;
}

function countChatSessions(userId) {
  const row = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS live,
            SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived
       FROM ai_chat_sessions WHERE user_id = ?`
  ).get(Number(userId) || 0);
  return {
    total: Number(row && row.total) || 0,
    live: Number(row && row.live) || 0,
    archived: Number(row && row.archived) || 0,
  };
}

function listChatSessions(userId, opts = {}) {
  const uid = Number(userId) || 0;
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 80));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const term = String(opts.q || '').trim().replace(/[%_*"']/g, '').slice(0, 60);
  const clauses = [`s.user_id = ?`];
  const params = [uid];
  if (opts.archivedOnly) clauses.push('s.archived = 1');
  else if (!opts.includeArchived) clauses.push('s.archived = 0');
  if (term.length >= 2) {
    clauses.push(`(s.title LIKE ? OR EXISTS (SELECT 1 FROM ai_chat_messages mm
      WHERE mm.session_id = s.id AND mm.content LIKE ?))`);
    params.push(`%${term}%`, `%${term}%`);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const rows = db.prepare(
    `SELECT s.*,
            (SELECT COUNT(*) FROM ai_chat_messages m WHERE m.session_id = s.id) AS message_count,
            (SELECT substr(replace(m.content, char(10), ' '), 1, 110)
               FROM ai_chat_messages m WHERE m.session_id = s.id ORDER BY m.id DESC LIMIT 1) AS preview
     FROM ai_chat_sessions s ${where}
     ORDER BY s.is_active DESC, datetime(s.updated_at) DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM ai_chat_sessions s ${where}`)
    .get(...params).c;
  return { sessions: rows, total, limit, offset, has_more: offset + rows.length < total };
}

function activeChatSession(userId) {
  return db.prepare(
    'SELECT * FROM ai_chat_sessions WHERE user_id = ? AND archived = 0 AND is_active = 1 ORDER BY id DESC LIMIT 1'
  ).get(Number(userId) || 0) || null;
}

function createChatSession(userId, title, model) {
  const uid = Number(userId) || 0;
  const m = chatModelFor(model, null);
  const held = db.prepare('SELECT COUNT(*) AS c FROM ai_chat_sessions WHERE user_id = ?').get(uid).c;
  if (held >= MAX_SESSIONS_PER_USER) {
    const overflow = held - MAX_SESSIONS_PER_USER + 1;
    db.prepare(
      `DELETE FROM ai_chat_sessions
       WHERE id IN (SELECT id FROM ai_chat_sessions WHERE user_id = ? AND archived = 1
                    ORDER BY datetime(updated_at) ASC LIMIT ?)`
    ).run(uid, overflow);
  }
  db.prepare('UPDATE ai_chat_sessions SET is_active = 0 WHERE user_id = ?').run(uid);
  const info = db.prepare(
    `INSERT INTO ai_chat_sessions (user_id, title, model, is_active, archived, archived_at, last_message_at)
     VALUES (?,?,?,1,0,'',datetime('now'))`
  ).run(uid, cleanTitle(title), m);
  const session = getChatSession(info.lastInsertRowid);
  audit({ kind: 'chat', action: 'session:create', payload: { session_id: session.id, model: m } });
  return session;
}

/**
 * Ensures the operator has somewhere to write. Reuses the active chat when it is
 * still empty, otherwise opens a new one — so pressing send on a fresh tab never
 * needs a second round trip, and repeated empty chats never pile up.
 */
function ensureChatSession(userId, { title, model } = {}) {
  const active = activeChatSession(userId);
  if (active) {
    const empty = !db.prepare('SELECT 1 FROM ai_chat_messages WHERE session_id = ? LIMIT 1').get(active.id);
    if (empty) {
      const m = chatModelFor(model, active);
      if (m !== active.model) setChatSessionModel(active.id, m);
      return getChatSession(active.id);
    }
  }
  return createChatSession(userId, title, model);
}

function renameChatSession(sessionId, title) {
  db.prepare('UPDATE ai_chat_sessions SET title = ? WHERE id = ?').run(cleanTitle(title), Number(sessionId) || 0);
  return getChatSession(sessionId);
}

function setChatSessionModel(sessionId, model) {
  const m = chatModelFor(model, null);
  db.prepare('UPDATE ai_chat_sessions SET model = ? WHERE id = ?').run(m, Number(sessionId) || 0);
  return getChatSession(sessionId);
}

function setActiveSession(sessionId, userId) {
  const session = getChatSessionForUser(sessionId, userId);
  db.prepare('UPDATE ai_chat_sessions SET is_active = 0 WHERE user_id = ?').run(session.user_id);
  db.prepare('UPDATE ai_chat_sessions SET is_active = 1 WHERE id = ?').run(session.id);
  return getChatSession(session.id);
}

function touchSession(sessionId, patch = {}) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (patch.title) {
    db.prepare(
      'UPDATE ai_chat_sessions SET updated_at = datetime(\'now\'), last_message_at = datetime(\'now\'), title = ? WHERE id = ?'
    ).run(cleanTitle(patch.title), Number(sessionId) || 0);
    return;
  }
  db.prepare(
    'UPDATE ai_chat_sessions SET updated_at = datetime(\'now\'), last_message_at = datetime(\'now\') WHERE id = ?'
  ).run(Number(sessionId) || 0);
}

/**
 * Persist one transcript line. `meta` carries what the UI needs to replay the
 * bubble faithfully: which model answered, and whether the line records a
 * console action (and whether that action succeeded).
 */
function addChatMessage(sessionId, role, content, meta = {}) {
  const sid = Number(sessionId) || 0;
  if (!sid) return null;
  const body = String(content == null ? '' : content).slice(0, 12000);
  const info = db.prepare(
    `INSERT INTO ai_chat_messages (session_id, role, content, model, tool, ok)
     VALUES (?,?,?,?,?,?)`
  ).run(sid, role === 'user' ? 'user' : 'assistant', body,
    String(meta.model || '').slice(0, 100), String(meta.tool || '').slice(0, 80),
    meta.ok === false ? 0 : 1);
  const session = getChatSession(sid);
  if (session && role === 'user' && PLACEHOLDER_TITLES.has(String(session.title || '').toLowerCase())) {
    touchSession(sid, { title: titleFromText(body) });
  } else {
    touchSession(sid);
  }
  return { id: Number(info.lastInsertRowid), session_id: sid, role, content: body, model: meta.model || '', tool: meta.tool || '', ok: meta.ok === false ? 0 : 1 };
}

const appendChatMessage = addChatMessage;

function clearChatMessages(sessionId) {
  const info = db.prepare('DELETE FROM ai_chat_messages WHERE session_id = ?').run(Number(sessionId) || 0);
  touchSession(sessionId);
  return { removed: info.changes };
}

function sessionTranscript(sessionId, opts = {}) {
  const sid = Number(sessionId) || 0;
  const limit = Math.max(1, Math.min(300, Number(opts.limit) || 120));
  const beforeId = Math.max(0, Number(opts.before) || 0);
  const rows = db.prepare(
    `SELECT * FROM ai_chat_messages
     WHERE session_id = ? AND (? = 0 OR id < ?)
     ORDER BY id DESC LIMIT ?`
  ).all(sid, beforeId, beforeId, limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    messages: page.reverse(),
    has_more: hasMore,
    oldest_id: page.length ? page[0].id : 0,
  };
}

/** Model-facing history: role + content only, trimmed to the recent window. */
function transcriptForModel(sessionId) {
  const rows = db.prepare(
    'SELECT role, content FROM ai_chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?'
  ).all(Number(sessionId) || 0, CHAT_WINDOW);
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

function deleteChatSession(sessionId) {
  const sid = Number(sessionId) || 0;
  const session = getChatSession(sid);
  if (!session) return { deleted: false, reason: 'missing' };
  db.prepare('DELETE FROM ai_chat_messages WHERE session_id = ?').run(sid);
  db.prepare('DELETE FROM ai_chat_sessions WHERE id = ?').run(sid);
  if (session.is_active) {
    const next = db.prepare(
      'SELECT id FROM ai_chat_sessions WHERE user_id = ? AND archived = 0 ORDER BY datetime(updated_at) DESC LIMIT 1'
    ).get(session.user_id);
    if (next) db.prepare('UPDATE ai_chat_sessions SET is_active = 1 WHERE id = ?').run(next.id);
  }
  audit({ kind: 'chat', action: 'session:delete', payload: { session_id: sid, title: session.title } });
  return { deleted: true, id: sid };
}

function archiveChatSession(sessionId) {
  const session = getChatSession(sessionId);
  if (!session) return { archived: false, reason: 'missing' };
  db.prepare(
    "UPDATE ai_chat_sessions SET archived = 1, is_active = 0, archived_at = datetime('now') WHERE id = ?"
  ).run(session.id);
  if (session.is_active) {
    const next = db.prepare(
      'SELECT id FROM ai_chat_sessions WHERE user_id = ? AND archived = 0 ORDER BY datetime(updated_at) DESC LIMIT 1'
    ).get(session.user_id);
    if (next) db.prepare('UPDATE ai_chat_sessions SET is_active = 1 WHERE id = ?').run(next.id);
  }
  return { archived: true, id: session.id };
}

/** Restores a chat without stealing the active slot — activating is its own action. */
function unarchiveChatSession(sessionId) {
  const session = getChatSession(sessionId);
  if (!session) return { unarchived: false, reason: 'missing' };
  db.prepare("UPDATE ai_chat_sessions SET archived = 0, archived_at = '' WHERE id = ?").run(session.id);
  return { unarchived: true, id: session.id };
}

function purgeArchivedChats(userId, days = 30) {
  const d = Math.max(1, Math.min(365, Number(days) || 30));
  const doomed = db.prepare(
    `SELECT id FROM ai_chat_sessions
     WHERE user_id = ? AND archived = 1 AND datetime(COALESCE(NULLIF(archived_at, ''), updated_at)) < datetime('now', ?)`
  ).all(Number(userId) || 0, `-${d} days`).map((r) => r.id);
  if (!doomed.length) return { purged: 0, days: d, removed_messages: 0 };
  const del = db.prepare('DELETE FROM ai_chat_messages WHERE session_id IN (' + doomed.map(() => '?').join(',') + ')').run(...doomed);
  db.prepare('DELETE FROM ai_chat_sessions WHERE id IN (' + doomed.map(() => '?').join(',') + ')').run(...doomed);
  audit({ kind: 'chat', action: 'session:purge', payload: { days: d, count: doomed.length } });
  return { purged: doomed.length, days: d, removed_messages: del.changes };
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
  chatTurn, executePending, cancelPending,
  scheduleModeration, moderateListing, isModerationOn, moderationModelId,
  settingsSnapshot, saveSettings, recentModeration, recentAudit, logsPage, logSnapshot, oldestPending,
  /* legacy chat sessions — admin history is disabled */
  createChatSession, ensureChatSession, getChatSession, getChatSessionForUser, listChatSessions,
  countChatSessions, activeChatSession, sessionTranscript, transcriptForModel,
  addChatMessage, clearChatMessages, renameChatSession, setChatSessionModel,
  deleteChatSession, archiveChatSession, unarchiveChatSession, purgeArchivedChats,
  setActiveSession,
  deleteAuditLogEntry, deleteModerationLogEntry,
};
