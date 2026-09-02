/**
 * FirmLedger — AI assistant agent-loop test.
 *
 *   node tests/ai-agent.test.js
 *
 * Groq is stubbed (no key, no network) so the loop itself is under test:
 *   1. chained work — look a record up, then act on it, in one turn;
 *   2. multi-action turns are batched into ONE confirmation instead of refused;
 *   3. confirming a batch really executes every step, in order;
 *   4. cancelling executes nothing;
 *   5. a failing tool is reported as failed — never as done.
 */
process.env.NODE_ENV = 'test';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-agent-'));
process.env.FIRMLEDGER_DATA_DIR = tmp;
process.env.BASE_URL = 'https://firmledger.test';
process.env.GROQ_API_KEY = 'test-key-not-used';

const { db, setSetting } = require('../src/db');
const groq = require('../src/lib/groq');
const ai = require('../src/lib/ai');

/* ------------------------------------------------------------ Groq stub */
let script = [];      // queue of canned model responses
const seen = [];      // every message array the "model" was handed

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
function reply(content, calls) {
  return {
    _model: 'openai/gpt-oss-120b',
    choices: [{ message: { role: 'assistant', content: content || '', ...(calls ? { tool_calls: calls } : {}) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}
groq.chat = async (opts) => {
  seen.push(opts.messages);
  if (!script.length) return reply('Nothing further.');
  return script.shift();
};

/* ------------------------------------------------------------ harness */
let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const one = (sql, ...p) => db.prepare(sql).get(...p);

/* ------------------------------------------------------------ fixtures */
const userId = db.prepare(
  "INSERT INTO users (email, password_hash, name, plan, plan_expires_at) VALUES (?,?,?,'free','')"
).run('agent@example.com', '$2a$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Agent Target').lastInsertRowid;

const listingId = db.prepare(
  `INSERT INTO listings (slug, name, tagline, description, type, category, website, country, status)
   VALUES ('agent-co','Agent Co','Agent Co tagline','Agent Co is a fixture listing for the agent-loop test suite and nothing else.','company','Technology','https://agent.example.com','Kenya','pending')`
).run().lastInsertRowid;

(async function main() {
  console.log('FirmLedger AI agent-loop suite\n');

  /* 1 — chained: search_listings (auto, read-only) then approve (auto-allowed) */
  console.log('Chained multi-step turn');
  setSetting('ai_auto_tools', JSON.stringify(['approve_listing']));
  script = [
    reply('', [toolCall('c1', 'search_listings', { q: 'Agent Co' })]),
    reply('', [toolCall('c2', 'approve_listing', { id_or_slug: 'agent-co' })]),
    reply('Agent Co is approved and live.'),
  ];
  let out = await ai.chatTurn([{ role: 'user', content: 'Find Agent Co and approve it.' }]);
  check('turn completes as a message', out.type === 'message', out.type);
  check('listing really approved', one('SELECT status FROM listings WHERE id=?', listingId).status === 'approved');
  check('both steps recorded', (out.steps || []).length === 2, JSON.stringify(out.steps));
  check('tool results were fed back to the model',
    seen.some((msgs) => msgs.some((m) => m.role === 'tool' && m.name === 'search_listings')));
  check('reported as executed', out.executed === true);

  /* 2 — several write actions in one response become ONE confirmation */
  console.log('\nMulti-action confirmation batch');
  setSetting('ai_auto_tools', JSON.stringify([]));
  script = [
    reply('', [
      toolCall('c1', 'suspend_user', { user: 'agent@example.com' }),
      toolCall('c2', 'feature_listing', { id_or_slug: 'agent-co', featured: true }),
    ]),
    reply('Both actions are done: the account is suspended and the listing is featured.'),
  ];
  out = await ai.chatTurn([{ role: 'user', content: 'Suspend agent@example.com and feature agent-co.' }]);
  check('a proposal is returned', out.type === 'tool_proposal', out.type);
  check('both actions are in the batch', (out.tool.steps || []).length === 2, JSON.stringify(out.tool && out.tool.steps));
  check('nothing has run yet', one('SELECT suspended FROM users WHERE id=?', userId).suspended === 0);
  check('one pending row stored', db.prepare('SELECT COUNT(*) c FROM ai_pending_actions').get().c === 1);

  /* 3 — confirming runs every step */
  out = await ai.executePending(out.pending_id);
  check('confirmation executes step 1', one('SELECT suspended FROM users WHERE id=?', userId).suspended === 1);
  check('confirmation executes step 2', one('SELECT featured FROM listings WHERE id=?', listingId).featured === 1);
  check('pending row consumed', db.prepare('SELECT COUNT(*) c FROM ai_pending_actions').get().c === 0);
  check('reported as executed', out.executed === true, JSON.stringify(out.executed));

  /* 4 — cancelling runs nothing */
  console.log('\nCancellation');
  script = [
    reply('', [toolCall('c1', 'delete_listing', { id_or_slug: 'agent-co' })]),
    reply('Cancelled — the listing is untouched.'),
  ];
  out = await ai.chatTurn([{ role: 'user', content: 'Delete agent-co.' }]);
  check('delete is proposed, not run', out.type === 'tool_proposal' && Boolean(one('SELECT id FROM listings WHERE id=?', listingId)));
  await ai.cancelPending(out.pending_id);
  check('listing still there after cancel', Boolean(one('SELECT id FROM listings WHERE id=?', listingId)));
  check('no pending rows left', db.prepare('SELECT COUNT(*) c FROM ai_pending_actions').get().c === 0);

  /* 5 — a failing tool must be reported as failed */
  console.log('\nHonest failure reporting');
  setSetting('ai_auto_tools', JSON.stringify(['approve_listing']));
  script = [
    reply('', [toolCall('c1', 'approve_listing', { id_or_slug: 'does-not-exist' })]),
    reply('That listing does not exist, so nothing was approved.'),
  ];
  out = await ai.chatTurn([{ role: 'user', content: 'Approve does-not-exist.' }]);
  check('failure is not reported as executed', out.executed === false, JSON.stringify(out.steps));
  check('the error reached the model',
    seen[seen.length - 1].some((m) => m.role === 'tool' && String(m.content).includes('No listing matches')));

  /* 6 — unknown tool names do not break the turn */
  console.log('\nUnknown tool recovery');
  script = [
    reply('', [toolCall('c1', 'make_coffee', { strength: 'strong' })]),
    reply('That is not something I can do in the admin console.'),
  ];
  out = await ai.chatTurn([{ role: 'user', content: 'Make me a coffee.' }]);
  check('turn recovers with a message', out.type === 'message' && /admin console/i.test(out.content), out.content);

  console.log(`\n${'='.repeat(64)}`);
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  failures.forEach((f) => console.log('  • ' + f));
  console.log('='.repeat(64));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
})();
