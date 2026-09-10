/**
 * FirmLedger AI Playground — admin assistant, auto-moderation, audit.
 *
 * Nothing here calls a model or an external API. The assistant is a rule
 * engine (src/lib/assistant.js) that maps plain-language requests onto the
 * console's action registry (src/lib/aitools.js); auto-moderation is a
 * deterministic scorer over the listing's own fields.
 *
 * Mutating actions wait for UI confirmation (ai_pending_actions) unless the
 * admin ticked them under Settings → Auto-run. Lookups always run at once.
 * Sensitive actions (delete_user, bulk actions, email everyone…) always ask.
 *
 * The assistant is stateless on the server: the browser tab posts the visible
 * conversation back with every turn and the context (last listing, member,
 * ticket, open question) is rebuilt from it.
 */
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('../db');
const tools = require('./aitools');
const bot = require('./assistant');
const notify = require('./notify');
const { sendBranded } = require('./mailer');
const { siteUrl, escHtml, domainOf } = require('./util');

const DEFAULT_MODERATION_RULES = `# Auto-moderation rules (one per line, no model involved)
# Lines starting with "block:" reject the listing when the term appears anywhere.
# Lines starting with "flag:" leave it pending for a human when the term appears.
# Lines starting with "allow-domain:" trust that website domain (+score).
# Everything else is ignored. Scores: approve at >= approve_at, reject at <= reject_at.
block: casino
block: viagra
block: escort
block: porn
block: xxx
block: crypto giveaway
block: guaranteed returns
block: lorem ipsum
flag: bitcoin
flag: forex
flag: loan
flag: betting
flag: adult`;

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


function sweepPending() {
  try { db.prepare("DELETE FROM ai_pending_actions WHERE expires_at < datetime('now')").run(); } catch { /* ignore */ }
}

/**
 * Park one or more proposed actions for operator confirmation.
 * `steps` is always an array of { name, args, id } — a single proposal is a
 * one-element batch, so confirm/execute has exactly one code path.
 */
function storePending({ steps, ctx = {} }) {
  sweepPending();
  const id = 'act_' + crypto.randomBytes(16).toString('hex');
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const label = steps.length === 1 ? steps[0].name : `${steps.length} actions`;
  db.prepare(
    `INSERT INTO ai_pending_actions (id, tool, args, messages, expires_at) VALUES (?,?,?,?,?)`
  ).run(
    id,
    label.slice(0, 80),
    JSON.stringify({ steps: steps.map((s) => ({ id: s.id, name: s.name, args: s.args, plan: s.plan })) }).slice(0, 200000),
    JSON.stringify({ ctx }).slice(0, 400000),
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


/* ---------------- Assistant (rule engine) ---------------- */

/**
 * Rebuild what the conversation was about from the visible messages. Every
 * assistant message carries a hidden marker line with the JSON context it
 * produced, so we never need server-side chat storage.
 */
const CTX_RE = /\u2063ctx:(\{.*?\})\u2063/;
function contextFrom(messages) {
  const ctx = {};
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const mm = String(m.content || '').match(CTX_RE);
    if (!mm) continue;
    try {
      const parsed = JSON.parse(mm[1]);
      Object.assign(ctx, parsed);
      /* an open question / open proposal only survives if the newest reply still carries it */
      if (!parsed.ask) ctx.ask = null;
      if (!parsed.pending) ctx.pending = null;
    } catch { /* ignore */ }
  }
  return ctx;
}
function stampContext(text, ctx) {
  const slim = {};
  for (const k of ['listing', 'user', 'ticket', 'incident', 'lastTool']) if (ctx[k]) slim[k] = ctx[k];
  slim.ask = ctx.ask || null;
  slim.pending = ctx.pending || null;
  return `${text}\n\u2063ctx:${JSON.stringify(slim)}\u2063`;
}
const stripContext = (text) => String(text || '').replace(/\n?\u2063ctx:\{.*?\}\u2063/g, '');

function sanitiseHistory(messages) {
  const out = [];
  const src = Array.isArray(messages) ? messages : [];
  for (const m of src.slice(-30)) {
    const role = m && m.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = String(m.content || '').slice(0, 6000);
    if (!content) continue;
    out.push({ role, content });
  }
  return out;
}

function receipt(ran) {
  return ran.map((r) => (r.ok
    ? `✓ ${tools.describeCall(r.tool, r.args)}`
    : `✗ ${tools.describeCall(r.tool, r.args)} — ${r.error}`)).join('\n');
}

/** Execute a list of steps in order. */
async function runSteps(steps, ran, { auto = false } = {}) {
  for (const step of steps) {
    let exec;
    try {
      exec = await tools.execute(step.name, step.args);
    } catch (e) {
      exec = { ok: false, error: e.message || 'The action failed.' };
    }
    audit({ kind: 'tool', action: (auto ? 'auto:' : '') + step.name, payload: step.args, result: exec, ok: exec.ok ? 1 : 0 });
    ran.push({ tool: step.name, args: step.args, ok: Boolean(exec.ok), result: exec.result, error: exec.error || '', plan: step.plan });
  }
  return ran;
}

/** Remember the entity a plan touched so "it / them" works next turn. */
function rememberFromPlan(ctx, plan, result) {
  if (plan.listing) ctx.listing = { id: plan.listing.id, name: plan.listing.name, slug: plan.listing.slug, status: plan.listing.status };
  if (plan.user) ctx.user = { id: plan.user.id, email: plan.user.email, name: plan.user.name };
  if (plan.ticket) ctx.ticket = { id: plan.ticket.id, ref: plan.ticket.ref };
  const r = result || {};
  if (r.listing && r.listing.id) ctx.listing = { id: r.listing.id, name: r.listing.name, slug: r.listing.slug, status: r.listing.status };
  if (r.user && r.user.id) ctx.user = { id: r.user.id, email: r.user.email, name: r.user.name };
  if (r.ticket && r.ticket.id) ctx.ticket = { id: r.ticket.id, ref: r.ticket.ref };
  if (plan.tool === 'create_incident' && r.id) ctx.incident = { id: r.id };
  if (plan.tool === 'approve_listing' && ctx.listing) ctx.listing.status = 'approved';
  if (plan.tool === 'reject_listing' && ctx.listing) ctx.listing.status = 'rejected';
  if (['delete_listing'].includes(plan.tool)) delete ctx.listing;
  if (['delete_user'].includes(plan.tool)) delete ctx.user;
  ctx.lastTool = plan.tool;
}

/** Compose the reply for a set of executed steps. */
function replyForRan(ran, ctx) {
  const parts = [];
  for (const r of ran) {
    const plan = r.plan || { tool: r.tool, args: r.args };
    if (!r.ok) { parts.push(bot.receiptFor(r.tool, r.args, false, r.error)); continue; }
    const t = tools.getTool(r.tool);
    if (t && !t.mutating) {
      const body = bot.formatResult(r.tool, r.result, plan);
      parts.push(body || bot.pick(bot.SAY.nothing));
    } else {
      /* writes get a one-line receipt; only tools with a bespoke formatter add detail */
      const extra = bot.hasFormatter(r.tool) ? bot.formatResult(r.tool, r.result, plan) : '';
      parts.push(bot.receiptFor(r.tool, r.args, true) + (extra ? `\n${extra}` : ''));
    }
    rememberFromPlan(ctx, plan, r.result);
  }
  const last = ran[ran.length - 1];
  const quick = last && last.ok ? bot.suggestionsFor(last.tool, last.plan, last.result, ctx) : [];
  return { content: parts.join('\n\n'), quick_replies: quick };
}

/* One-line consequence preview shown under a proposal so the admin knows what
   the click will do beyond the label. */
function impactNote(steps) {
  try {
    const notes = [];
    for (const s of steps) {
      const a = s.args || {};
      switch (s.name) {
        case 'delete_listing': notes.push('The listing, its claims, events and relations disappear from the directory and the sitemap.'); break;
        case 'delete_user': notes.push('The member, their listings ownership, tickets and API keys are removed permanently.'); break;
        case 'suspend_user': notes.push('They are signed out and cannot log in until unsuspended; their listings stay live.'); break;
        case 'approve_listing': notes.push('Goes live immediately, gets pinged to search engines and the owner is emailed.'); break;
        case 'reject_listing': notes.push('Hidden from the directory; the owner is emailed the reason if one was given.'); break;
        case 'accept_all_pending_listings': case 'bulk_listing_action': notes.push('Applies to every matching record in one go — there is no bulk undo.'); break;
        case 'email_all_users': notes.push('Sends to every active member — this cannot be recalled once queued.'); break;
        case 'email_users': if (a.audience && a.audience !== 'all' && !String(a.audience).includes('@')) notes.push(`Sends to the whole “${a.audience}” audience.`); break;
        case 'set_maintenance_mode': notes.push(a.on === false ? 'Visitors get the normal site again.' : 'Visitors see the maintenance page; the admin console stays reachable.'); break;
        case 'fulfill_removal': notes.push('Deletes the listing named in the request and closes it.'); break;
        case 'delete_category': notes.push('Listings in it are not deleted, they just lose the category.'); break;
        case 'remove_google_credentials': notes.push('Google indexing stops until a new service-account key is uploaded.'); break;
        case 'revoke_api_key': notes.push('Any integration using this key starts failing immediately.'); break;
        case 'set_smtp_settings': case 'set_paypal_settings': case 'set_admin_2fa_email': notes.push('Changes how the site sends mail / takes payments / signs you in — double-check the values.'); break;
        case 'run_google_indexing_batch': notes.push('Uses part of the 200/day Google quota.'); break;
        default: break;
      }
    }
    return [...new Set(notes)].slice(0, 2).join(' ');
  } catch { return ''; }
}

function proposalFor(steps, ctx, extraText) {
  const id = storePending({ steps, ctx });
  const labels = steps.map((s) => ({ name: s.name, label: tools.describeCall(s.name, s.args) }));
  const head = steps.length === 1 ? labels[0].label : `${steps.length} actions: ${labels.map((l) => l.label).join(' ')}`;
  const sensitive = steps.some((s) => { const t = tools.getTool(s.name); return t && (t.sensitive || t.neverAuto); });
  const impact = impactNote(steps);
  return {
    type: 'tool_proposal',
    content: stampContext(`${extraText ? extraText + '\n\n' : ''}${bot.pick(sensitive ? bot.SAY.confirmSensitive : bot.SAY.confirm)} **${head}**${impact ? `\n_${impact}_` : ''}`, { ...ctx, ask: null, pending: id }),
    pending_id: id,
    tool: { name: steps.length === 1 ? steps[0].name : 'batch', label: head, args: steps.length === 1 ? steps[0].args : { steps: steps.map((s) => ({ tool: s.name, args: s.args })) }, steps: labels },
    quick_replies: ['yes, run it', 'cancel'],
    model: 'rules',
  };
}

function message(content, ctx, quick = []) {
  return { type: 'message', content: stampContext(content, ctx), quick_replies: quick, model: 'rules' };
}

/**
 * One turn of conversation. `history` is the visible transcript; the last
 * entry must be the operator's new message.
 */
async function chatTurn(history) {
  const messages = sanitiseHistory(history);
  if (!messages.length) { const err = new Error('Send a message first.'); err.status = 422; throw err; }
  const last = messages[messages.length - 1];
  if (last.role !== 'user') { const err = new Error('The last message must come from you.'); err.status = 422; throw err; }

  const ctx = contextFrom(messages.slice(0, -1));
  const raw = String(last.content || '').trim();
  audit({ kind: 'chat', action: 'turn', payload: { text: raw.slice(0, 500) }, result: '', ok: 1 });

  /* A typed "yes" / "no" resolves an open confirmation (the UI usually does
     this itself, but the API contract should not depend on it). */
  if (ctx.pending) {
    const low = raw.toLowerCase();
    if (/^\s*(yes|y|yes,? run it|run it|go ahead|do it|confirm|ok|okay|proceed|sure)\s*[.!]?\s*$/.test(low)) {
      if (!loadPending(ctx.pending)) return message('That confirmation has expired or was already handled — ask me again if you still want it.', { ...ctx, pending: null }, ['help']);
      return executePending(ctx.pending);
    }
    if (/^\s*(no|n|cancel|stop|never ?mind|nevermind|forget it|don'?t)\s*[.!]?\s*$/.test(low)) return cancelPending(ctx.pending);
    ctx.pending = null;
  }

  /* Pending question from the previous turn (slot filling / disambiguation). */
  if (ctx.ask && ctx.ask.tool) {
    /* A clearly new command (own verb + entity, not a bare id/ordinal) wins
       over the open question — nobody should be trapped in a prompt. */
    let fresh = null;
    if (raw.split(/\s+/).length > 2 && !/^\s*(#?\d+|first|second|third|last|the \w+ one)\b/i.test(raw)) {
      const probe = bot.parseCommand(raw, { ...ctx, ask: null });
      const t = probe.type === 'plan' ? tools.getTool(probe.tool) : null;
      if (probe.type === 'plan' && !probe.guess && !['message', 'mail', 'title', 'fields'].includes(ctx.ask.entity)) fresh = probe;
      else if (probe.type === 'plan' && !probe.guess && probe.tool.startsWith('__')) fresh = probe;
      /* While waiting for prose (a message body, a title) only a short,
         clearly-a-command line escapes: a read-only lookup or a destructive
         verb, never something that could plausibly be the text itself. */
      else if (probe.type === 'plan' && !probe.guess && raw.split(/\s+/).length <= 5 && !/[.!?,]/.test(raw) && (t && (!t.mutating || t.sensitive || t.neverAuto))) fresh = probe;
    }
    const ans = fresh ? null : bot.answerAsk(raw, ctx.ask, ctx);
    if (ans && ans.cancelled) { const c2 = { ...ctx, ask: null }; return message(bot.pick(bot.SAY.cancelled), c2, ['how many pending', 'show open tickets', 'help']); }
    if (ans && ans.ask) return message(ans.ask.ask, { ...ctx, ask: ans.ask }, (ans.ask.options || []).slice(0, 4).map((o, i) => `${i + 1}`));
    if (ans && ans.resolved) {
      const plan = { type: 'plan', tool: ans.resolved.tool, args: ans.resolved.args };
      if (ans.resolved.row) { if (ans.resolved.entity === 'listing') plan.listing = ans.resolved.row; if (ans.resolved.entity === 'user') plan.user = ans.resolved.row; if (ans.resolved.entity === 'ticket') plan.ticket = ans.resolved.row; }
      return runPlans([plan], { ...ctx, ask: null });
    }
    /* null → treated as a fresh command below */
    ctx.ask = null;
  }

  /* Split compound requests and parse each. */
  const commands = bot.splitCommands(raw);
  const plans = [];
  for (const cmd of commands) {
    const p = bot.parseCommand(cmd, ctx);
    if (p.type === 'plan') {
      plans.push(p);
      /* let later commands in the same message refer to this entity */
      if (p.listing) ctx.listing = { id: p.listing.id, name: p.listing.name, slug: p.listing.slug, status: p.listing.status };
      if (p.user) ctx.user = { id: p.user.id, email: p.user.email, name: p.user.name };
      if (p.ticket) ctx.ticket = { id: p.ticket.id, ref: p.ticket.ref };
      continue;
    }
    if (p.type === 'ask') {
      /* run whatever was already understood, then ask */
      const ask = { tool: p.tool, entity: p.entity, partial: p.partial, options: (p.options || []).map((o) => ({ label: o.label, value: o.value, row: o.row ? slimRow(o.row) : undefined })) };
      const done = plans.filter((x) => x.type === 'plan');
      const prefix = done.length ? await runPlans(done, ctx, { silentCtx: true }) : null;
      const optionText = ask.options.length ? '\n' + ask.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n') : '';
      const text = (prefix ? stripContext(prefix.content) + '\n\n' : '') + p.ask + optionText;
      return message(text, { ...ctx, ask }, ask.options.length ? ask.options.slice(0, 4).map((o, i) => `${i + 1}`).concat(['cancel']) : ['cancel']);
    }
    if (p.type === 'none') {
      const done = plans.filter((x) => x.type === 'plan');
      const prefix = done.length ? await runPlans(done, ctx, { silentCtx: true }) : null;
      return message((prefix ? stripContext(prefix.content) + '\n\n' : '') + p.text + ' ' + recoveryHint(p), ctx, ['how many pending', 'show open tickets', 'help']);
    }
    /* unknown: keep going; handled below if nothing else parsed */
    plans.push(p);
  }

  const real = plans.filter((p) => p.type === 'plan');
  if (!real.length) return unknownReply(raw, plans[0], ctx);
  return runPlans(real, ctx);
}

function slimRow(r) { return { id: r.id, name: r.name, slug: r.slug, status: r.status, email: r.email, ref: r.ref }; }

function recoveryHint(p) {
  if (p.tool && /listing/.test(p.tool)) return 'Try the listing id, its slug, or say “show pending listings” to pick one.';
  if (p.tool && /user/.test(p.tool)) return 'Try their email address, or “show users” to browse.';
  if (p.tool && /ticket/.test(p.tool)) return 'Try “show open tickets” and pick one.';
  return '';
}

/** Nothing matched — offer the closest guesses instead of a dead end. */
function unknownReply(raw, p, ctx) {
  const c = (p && p.c) || bot.canon(raw);
  const guesses = [];
  if (/\blisting\b/.test(c)) guesses.push('show pending listings', 'how many listings');
  if (/\buser\b/.test(c)) guesses.push('show users', 'show user <email>');
  if (/\bticket\b/.test(c)) guesses.push('show open tickets');
  if (/\b(pay|revenue|money)\b/.test(c)) guesses.push('show revenue');
  if (/\b(mail|email)\b/.test(c)) guesses.push('email <address> subject: "…" message: "…"', 'send a test email');
  if (/\b(status|incident|down)\b/.test(c)) guesses.push('status page', 'open an incident titled "…"');
  if (/\b(setting|config)\b/.test(c)) guesses.push('show settings');
  if (!guesses.length) guesses.push('how many pending', 'show open tickets', 'show settings', 'help');
  const lines = [
    bot.pick(['I did not catch an action in that.', 'I am not sure what to do with that.', 'That did not match anything I know how to do.']),
    'I can look things up (listings, members, tickets, claims, removals, revenue, status page, inbox, settings) and act on them (approve, reject, feature, sponsor, suspend, grant pro, reply, email, maintenance, indexing, incidents…).',
    `Did you mean: ${guesses.map((g) => `“${g}”`).join(', ')}? Say “help” for the full list.`,
  ];
  audit({ kind: 'chat', action: 'unknown', payload: { text: raw.slice(0, 300) }, result: '', ok: 0 });
  return message(lines.join('\n'), ctx, guesses.slice(0, 4));
}

const TOPIC_ACTIONS = {
  news: {
    title: 'News actions',
    lines: ['show pending news', 'refresh news', 'refresh news for <listing>', 'approve story <id>', 'reject story <id>', 'add story to <listing> titled "…" url=…', 'news moderation on / news moderation off', 'delete story <id>'],
  },
  settings: {
    title: 'Settings & operations',
    lines: ['show settings', 'auto approve on / off', 'auto moderation on / off', 'show paypal settings', 'set paypal sandbox / live', 'email settings / send a test email', 'indexing status', 'health'],
  },
  paypal: {
    title: 'PayPal actions',
    lines: ['show settings', 'set paypal sandbox', 'set paypal live', 'set paypal client_id=… client_secret=…', 'show revenue', 'show pending payments'],
  },
  mail: {
    title: 'Email delivery actions',
    lines: ['email settings', 'send a test email', 'send a test email via <provider>', 'add smtp provider=brevo host=… username=… password=…', 'set mail from noreply@example.com', 'keep alive on / off', 'run keep alive now'],
  },
  email: {
    title: 'Email actions',
    lines: ['send a test email', 'email <address> subject: "…" message: "…"', 'email pro members about "…" saying: …', 'send newsletter digest now', 'set newsletter weekly', 'email settings'],
  },
  indexing: {
    title: 'Indexing & upkeep actions',
    lines: ['indexing status', 'indexing on / off', 'ping /listing/<slug>', 'google indexing on', 'run google indexing batch', 'refresh tech for all stale', 'run upkeep now', 'clear indexing logs'],
  },
  moderation: {
    title: 'Moderation actions',
    lines: ['moderation rules', 'moderation log', 'score <listing> (no changes)', 'review <listing> now', 'approve <listing> / reject <listing>', 'set approve threshold to 80', 'block term casino / flag term crypto', 'auto moderation on / off'],
  },
  listing: {
    title: 'Listing actions',
    lines: ['show pending listings', 'show <listing>', 'approve <listing> / reject <listing>', 'feature <listing> / sponsor <listing> 30 days', 'refresh tech for <listing>', 'edit <listing> tagline="…"', 'email the owner', 'delete <listing>'],
  },
  user: {
    title: 'Member actions',
    lines: ['show users', 'show user <email>', 'suspend / unsuspend <email>', 'give <email> Pro for 30 days', 'start a 14 day trial for <email>', 'send <email> a password reset', 'email <email> subject: "…" message: "…"', 'delete user <email>'],
  },
};
function topicKey(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (s === 'listings') return 'listing';
  if (s === 'users') return 'user';
  if (s === 'smtp') return 'mail';
  return s;
}
function topicMenu(topic) {
  const key = topicKey(topic);
  const menu = TOPIC_ACTIONS[key] || TOPIC_ACTIONS.settings;
  return [`**${menu.title}**`, 'Choose an action below, or type the full request. Reads run immediately; changes still ask for confirmation.', ...menu.lines.map((x) => `• ${x}`)].join('\\n');
}

/** Special (non-tool) intents. */
function special(plan, ctx) {
  switch (plan.tool) {
    case '__topic_menu': {
      const topic = topicKey(plan.args.topic || 'settings');
      const menu = TOPIC_ACTIONS[topic] || TOPIC_ACTIONS.settings;
      return message(topicMenu(topic), ctx, menu.lines.slice(0, 4));
    }
    case '__help': return message(bot.helpText(plan.args.topic || ''), ctx, ['how many pending', 'show open tickets', 'help listings', 'help users']);
    case '__hello': return message(bot.pick(bot.SAY.hello), ctx, ['how many pending', 'show open tickets', 'show revenue', 'help']);
    case '__thanks': return message(bot.pick(bot.SAY.thanks), ctx, ['how many pending', 'help']);
    case '__reset': return message('Fresh start — context cleared. What would you like to do?', {}, ['how many pending', 'show open tickets', 'help']);
    case '__cancelword': return message(ctx.ask ? bot.pick(bot.SAY.cancelled) : 'Nothing is waiting to be cancelled — what next?', { ...ctx, ask: null, pending: null }, ['how many pending', 'show open tickets', 'help']);
    case '__whoami': return message('You are signed in as the FirmLedger administrator. Everything I do runs with your admin session and is written to the audit log.', ctx, ['show audit log', 'help']);
    case '__api_playground': return message('Open the [Developer API Playground](/dashboard/api/playground) to run the complete authenticated v1 surface: discovery, health, usage, listings, owner CRUD, categories, countries, suggestions, verification, CSV export and webhooks.', ctx, ['show api keys', 'show settings', 'help']);
    case '__undo': {
      const l = ctx.lastTool;
      const inverse = { approve_listing: 'reject it', reject_listing: 'approve it', feature_listing: 'unfeature it', suspend_user: 'unsuspend them', unsuspend_user: 'suspend them', grant_user_pro: 'revoke their pro', sponsor_listing: 'unsponsor it', set_maintenance_mode: 'maintenance off', block_ip: 'unblock that ip' };
      if (l && inverse[l]) return message(`I cannot roll back automatically, but the opposite of the last action is “${inverse[l]}” — want me to?`, ctx, [inverse[l], 'no']);
      return message('There is no automatic undo. Tell me the opposite action (e.g. “unsuspend them”, “reject it”) and I will run it.', ctx, ['help']);
    }
    default: return null;
  }
}

/**
 * Execute a list of parsed plans: reads run at once, writes run when
 * auto-allowed, and the rest are parked as one confirmation batch.
 */
async function runPlans(plans, ctx, opts = {}) {
  if (plans.length === 1 && String(plans[0].tool || '').startsWith('__')) return special(plans[0], ctx);
  const ran = [];
  const needConfirm = [];
  const texts = [];
  let n = 0;
  for (const p of plans) {
    if (p.tool.startsWith('__')) { const sp = special(p, ctx); if (sp) texts.push(stripContext(sp.content)); continue; }
    const t = tools.getTool(p.tool);
    if (!t) { texts.push(`I do not have an action called ${p.tool}.`); continue; }
    n += 1;
    const step = { id: `call_${n}`, name: p.tool, args: p.args, plan: { tool: p.tool, args: p.args, focus: p.focus, listing: p.listing && slimRow(p.listing), user: p.user && slimRow(p.user), ticket: p.ticket && slimRow(p.ticket) } };
    if (!t.mutating) { await runSteps([step], ran); continue; }
    if (tools.isAuto(p.tool) && !tools.isSensitive(t)) { await runSteps([step], ran, { auto: true }); continue; }
    needConfirm.push(step);
  }
  const done = ran.length ? replyForRan(ran, ctx) : { content: '', quick_replies: [] };
  const soFar = [...texts, done.content].filter(Boolean).join('\n\n');
  if (needConfirm.length) return proposalFor(needConfirm, ctx, soFar);
  const anyFail = ran.some((r) => !r.ok);
  const out = message(soFar || bot.pick(bot.SAY.ran), ctx, done.quick_replies);
  if (ran.length) out.executed = ran.some((r) => r.ok && tools.getTool(r.tool).mutating);
  if (anyFail && ran.length === 1) out.quick_replies = ['show pending listings', 'show users', 'help'];
  return out;
}

/* ---------------- Pending confirmations ---------------- */

/** Operator pressed Run: execute the parked batch. */
async function executePending(pendingId) {
  const row = loadPending(pendingId);
  if (!row) { const err = new Error('That action expired or was already handled. Ask me again if you still want it.'); err.status = 410; throw err; }
  dropPending(row.id);
  let steps = [];
  let packed = { ctx: {} };
  try { const parsedArgs = JSON.parse(row.args); steps = Array.isArray(parsedArgs && parsedArgs.steps) ? parsedArgs.steps : [{ id: 'call_1', name: row.tool, args: parsedArgs || {} }]; } catch { steps = [{ id: 'call_1', name: row.tool, args: {} }]; }
  try { packed = JSON.parse(row.messages) || packed; } catch { /* ignore */ }
  const ctx = (packed && packed.ctx) || {};
  const ran = [];
  await runSteps(steps, ran);
  const done = replyForRan(ran, ctx);
  const executedNow = ran.every((r) => r.ok);
  return {
    type: 'message',
    content: stampContext(done.content, ctx),
    quick_replies: done.quick_replies,
    executed: executedNow,
    tool: steps.map((s) => s.name).join(' + '),
    result: ran.length ? ran[ran.length - 1].result : undefined,
    error: ran.filter((r) => !r.ok).map((r) => r.error).join(' ') || undefined,
    model: 'rules',
  };
}

async function cancelPending(pendingId) {
  const row = loadPending(pendingId);
  if (!row) return { type: 'message', content: 'That action was already cancelled or expired. Nothing ran.', model: 'rules' };
  dropPending(row.id);
  let steps = [];
  try { const parsedArgs = JSON.parse(row.args); steps = Array.isArray(parsedArgs && parsedArgs.steps) ? parsedArgs.steps : [{ id: 'call_1', name: row.tool, args: parsedArgs || {} }]; } catch { steps = [{ id: 'call_1', name: row.tool, args: {} }]; }
  audit({ kind: 'tool', action: 'cancel:' + steps.map((s) => s.name).join('+'), payload: { steps: steps.map((s) => ({ tool: s.name, args: s.args })) }, result: 'cancelled', ok: 1 });
  let ctx = {};
  try { ctx = (JSON.parse(row.messages) || {}).ctx || {}; } catch { /* ignore */ }
  const labels = steps.map((s) => tools.describeCall(s.name, s.args));
  const content = `${bot.pick(['Understood', 'Okay', 'No problem'])} — cancelled ${labels.length === 1 ? `“${labels[0]}”` : `${labels.length} actions`}. Nothing was changed.`;
  return { type: 'message', content: stampContext(content, ctx), cancelled: true, quick_replies: ['how many pending', 'help'], model: 'rules' };
}


/* ---------------- Auto-moderation (deterministic scorer) ---------------- */

function moderationRules() {
  const custom = String(getSetting('ai_moderation_rules', '') || '').trim();
  return custom || DEFAULT_MODERATION_RULES;
}

function parseRules(text) {
  const out = { block: [], flag: [], allowDomain: [] };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(block|flag|allow-domain)\s*:\s*(.+)$/i);
    if (!m) continue;
    const v = m[2].trim().toLowerCase();
    if (!v) continue;
    if (m[1].toLowerCase() === 'block') out.block.push(v);
    else if (m[1].toLowerCase() === 'flag') out.flag.push(v);
    else out.allowDomain.push(v.replace(/^www\./, ''));
  }
  return out;
}

function isModerationOn() {
  return getSetting('ai_moderation_on', '0') === '1';
}

function thresholds() {
  const a = Math.max(50, Math.min(100, Number(getSetting('ai_moderation_approve_at', '75')) || 75));
  const r = Math.max(0, Math.min(49, Number(getSetting('ai_moderation_reject_at', '25')) || 25));
  return { approveAt: a, rejectAt: r };
}

const PLACEHOLDER = /\b(lorem ipsum|test(ing)? (listing|company)|asdf|qwerty|example company|your company|sample text|placeholder)\b/i;
const GIBBERISH = /(.)\1{4,}|^[^aeiou\s]{8,}$/i;
const CONTACT_FREE_MAIL = /@(gmail|yahoo|hotmail|outlook|live|aol|icloud|proton|protonmail|mail)\./i;

/**
 * Score a listing 0–100 from its own fields. Pure function — exported for
 * tests and for the “Review one now” button.
 */
function scoreListing(l, rulesText = moderationRules()) {
  const rules = parseRules(rulesText);
  const reasons = [];
  let score = 50;
  const text = [l.name, l.tagline, l.description, l.tags, l.website, l.email].map((x) => String(x || '')).join(' \n ').toLowerCase();
  const desc = String(l.description || '').trim();
  const name = String(l.name || '').trim();
  const site = String(l.website || '').trim();
  const domain = domainOf(site) || '';

  for (const term of rules.block) if (text.includes(term)) { reasons.push(`Blocked term “${term}”.`); return { decision: 'reject', score: 0, reasons }; }
  if (PLACEHOLDER.test(text)) { reasons.push('Placeholder / test text.'); return { decision: 'reject', score: 0, reasons }; }
  if (name.length < 2 || GIBBERISH.test(name)) { reasons.push('Name looks like gibberish.'); return { decision: 'reject', score: 5, reasons }; }

  let flagged = false;
  for (const term of rules.flag) if (text.includes(term)) { flagged = true; reasons.push(`Contains “${term}” — needs a human look.`); }

  /* Substance */
  if (desc.length >= 300) { score += 15; reasons.push('Detailed description.'); }
  else if (desc.length >= 150) { score += 10; reasons.push('Reasonable description.'); }
  else if (desc.length >= 60) { score += 2; reasons.push('Short description.'); }
  else { score -= 20; reasons.push('Description too thin.'); }
  const words = desc.split(/\s+/).filter(Boolean);
  const uniq = new Set(words.map((w) => w.toLowerCase())).size;
  if (words.length > 20 && uniq / words.length < 0.45) { score -= 15; reasons.push('Repetitive text.'); }
  const caps = desc.replace(/[^A-Za-z]/g, '');
  if (caps.length > 40 && caps.replace(/[^A-Z]/g, '').length / caps.length > 0.6) { score -= 10; reasons.push('Mostly capitals.'); }
  const links = (desc.match(/https?:\/\//g) || []).length;
  if (links >= 3) { score -= 15; reasons.push(`${links} links in the description.`); }
  if (/\b(buy now|click here|limited offer|100% free|earn \$|make money fast|whatsapp me)\b/i.test(desc)) { score -= 20; reasons.push('Promotional spam phrasing.'); }
  if (String(l.tagline || '').trim().length >= 12) score += 4;

  /* Identity */
  if (!site) { score -= 15; reasons.push('No website.'); }
  else if (/example\.(com|org|net)|localhost|127\.0\.0\.1/i.test(site)) { score -= 20; reasons.push('Placeholder website.'); }
  else if (!/^https?:\/\/[^\s/]+\.[a-z]{2,}/i.test(site)) { score -= 10; reasons.push('Website is not a valid URL.'); }
  else {
    score += 10;
    if (rules.allowDomain.includes(domain.replace(/^www\./, ''))) { score += 20; reasons.push('Trusted domain.'); }
    const nameBits = name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
    if (nameBits.some((w) => domain.includes(w))) { score += 8; reasons.push('Website matches the name.'); }
    const mailDomain = String(l.email || '').split('@')[1] || '';
    if (mailDomain && domain && mailDomain.toLowerCase().replace(/^www\./, '') === domain.toLowerCase().replace(/^www\./, '')) { score += 6; reasons.push('Email on the company domain.'); }
    else if (l.email && CONTACT_FREE_MAIL.test(l.email)) { score -= 3; }
  }
  if (l.category && l.category !== 'Other') score += 4; else { score -= 4; reasons.push('No specific category.'); }
  if (l.country) score += 3; else { score -= 4; reasons.push('No country.'); }
  if (l.city) score += 2;
  if (l.founded && /^\d{4}$/.test(String(l.founded)) && Number(l.founded) >= 1800 && Number(l.founded) <= new Date().getFullYear()) score += 3;
  if (l.logo_url) score += 3;
  if (String(l.tags || '').split(',').filter((t) => t.trim()).length >= 2) score += 3;

  /* Duplicates */
  try {
    const dupName = db.prepare("SELECT id FROM listings WHERE id<>? AND lower(name)=lower(?) AND status<>'rejected' LIMIT 1").get(l.id || 0, name);
    const dupSite = domain ? db.prepare("SELECT id FROM listings WHERE id<>? AND status<>'rejected' AND lower(website) LIKE ? LIMIT 1").get(l.id || 0, `%${domain.toLowerCase()}%`) : null;
    if (dupName || dupSite) { flagged = true; reasons.push(`Possible duplicate of listing #${(dupName || dupSite).id}.`); }
  } catch { /* ignore */ }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const { approveAt, rejectAt } = thresholds();
  let decision = 'pending';
  if (score <= rejectAt) decision = 'reject';
  else if (score >= approveAt && !flagged) decision = 'approve';
  if (flagged && decision === 'approve') decision = 'pending';
  if (!reasons.length) reasons.push('Nothing notable either way.');
  return { decision, score, reasons };
}

function scheduleModeration(listingId) {
  if (!isModerationOn()) return;
  const id = Number(listingId);
  if (!id) return;
  setImmediate(() => {
    Promise.resolve().then(() => moderateListing(id)).catch((e) => {
      console.error('[ai-moderation]', e && e.message);
      audit({ kind: 'moderate', action: 'error', listingId: id, result: e.message, ok: 0 });
      try {
        db.prepare(`INSERT INTO ai_moderation_log (listing_id, listing_name, decision, reason, model) VALUES (?,?,?,?,?)`)
          .run(id, '', 'error', String(e.message || 'unknown').slice(0, 500), 'rules');
      } catch { /* ignore */ }
    });
  });
}

async function moderateListing(listingId) {
  const l = db.prepare('SELECT * FROM listings WHERE id=?').get(listingId);
  if (!l) return { skipped: true, reason: 'missing' };
  if (l.status !== 'pending') return { skipped: true, reason: 'not_pending' };

  const { decision, score, reasons } = scoreListing(l);
  const reason = `Score ${score}/100 — ${reasons.join(' ')}`.slice(0, 800);

  if (decision === 'approve') tools.approveListingRow(l);
  else if (decision === 'reject') tools.rejectListingRow(l);
  else notifyAdminUnsure(l, reason);

  db.prepare(`INSERT INTO ai_moderation_log (listing_id, listing_name, decision, reason, model) VALUES (?,?,?,?,?)`)
    .run(l.id, l.name, decision, reason, 'rules');
  audit({ kind: 'moderate', action: decision, listingId: l.id, payload: { score }, result: reason, ok: 1 });
  return { decision, reason, confidence: score, model: 'rules' };
}

function notifyAdminUnsure(l, reason) {
  notify.notifyAdmin({
    kind: 'listing',
    title: `Auto-moderation left “${l.name}” pending`,
    body: reason || 'The rules were not confident enough to approve or reject.',
    url: '/admin3119Musa/listings?status=pending',
  });
  if (getSetting('ai_moderation_email', '1') === '1') {
    sendBranded(adminNotifyEmail(), `Moderation needs you — ${l.name}`, {
      alias: 'admin',
      kicker: 'Auto-moderation',
      title: `“${escHtml(l.name)}” is still pending`,
      preheader: 'The moderation rules were not confident enough to approve or reject this listing.',
      alert: 'Auto-moderation left a listing in the review queue.',
      alertTone: 'info',
      paragraphs: [
        escHtml(reason || 'The rules were not confident.'),
        `Listing: <b>${escHtml(l.name)}</b> · ${escHtml(l.category || '')} · ${escHtml(l.website || '')}`,
      ],
      cta: { label: 'Review pending listings', url: siteUrl('/admin3119Musa/listings?status=pending') },
      note: 'Turn off these emails in Admin → AI Playground → Settings.',
    }).catch(() => {});
  }
}

function adminNotifyEmail() {
  return getSetting('admin_email', '') || process.env.ADMIN_NOTIFY_EMAIL || 'hello@firmledger.co.ke';
}

/* ---------------- Settings ---------------- */

function settingsSnapshot() {
  let pending = 0;
  try { pending = db.prepare('SELECT COUNT(*) AS c FROM ai_pending_actions').get().c; } catch { pending = 0; }
  const { approveAt, rejectAt } = thresholds();
  return {
    engine: 'rules',
    moderation_on: isModerationOn(),
    moderation_rules: getSetting('ai_moderation_rules', '') || DEFAULT_MODERATION_RULES,
    moderation_email: getSetting('ai_moderation_email', '1') === '1',
    moderation_approve_at: approveAt,
    moderation_reject_at: rejectAt,
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
  const on = (v) => v === '1' || v === true || v === 'on';
  // Unchecked boxes are omitted from the POST — treat missing as off on a settings save.
  if (body.ai_moderation_on !== undefined || body.ai_moderation_rules !== undefined || body.ai_moderation_present !== undefined) {
    setSetting('ai_moderation_on', on(body.ai_moderation_on) ? '1' : '0');
    setSetting('ai_moderation_email', on(body.ai_moderation_email) ? '1' : '0');
  }
  if (body.ai_moderation_rules !== undefined) {
    setSetting('ai_moderation_rules', String(body.ai_moderation_rules || '').slice(0, 8000));
  }
  if (body.ai_moderation_approve_at !== undefined) {
    const n = Number(body.ai_moderation_approve_at);
    if (!Number.isFinite(n) || n < 50 || n > 100) { const err = new Error('Approve threshold must be between 50 and 100.'); err.status = 422; throw err; }
    setSetting('ai_moderation_approve_at', String(Math.round(n)));
  }
  if (body.ai_moderation_reject_at !== undefined) {
    const n = Number(body.ai_moderation_reject_at);
    if (!Number.isFinite(n) || n < 0 || n > 49) { const err = new Error('Reject threshold must be between 0 and 49.'); err.status = 422; throw err; }
    setSetting('ai_moderation_reject_at', String(Math.round(n)));
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
      moderation_on: getSetting('ai_moderation_on', '0'),
      approve_at: getSetting('ai_moderation_approve_at', '75'),
      reject_at: getSetting('ai_moderation_reject_at', '25'),
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
  audit,
  chatTurn, executePending, cancelPending,
  scheduleModeration, moderateListing, isModerationOn, scoreListing, parseRules,
  settingsSnapshot, saveSettings, recentModeration, recentAudit, logsPage, logSnapshot, oldestPending,
  deleteAuditLogEntry, deleteModerationLogEntry, stripContext,
};
