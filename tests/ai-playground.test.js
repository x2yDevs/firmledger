/**
 * FirmLedger — AI Playground end-to-end suite.
 *
 *   node tests/ai-playground.test.js
 *
 * Proves the "real, functional" side of the playground against a throwaway
 * database, with the model call stubbed at the fetch layer (no key, no
 * network — the real gateway wire path in src/lib/llm.js still runs):
 *
 *   1. the listing generator returns a draft that respects the public API
 *      field limits;
 *   2. publishing the draft really inserts a pending listing;
 *   3. auto-moderation makes a real decision AND moves the listing's status
 *      (approve / reject / low-confidence stays pending), writing the log;
 *   4. a failed moderation call leaves the record pending and logs the error;
 *   5. publish with moderation on schedules the review, which runs on its own;
 *   6. a too-short brief and invalid model JSON are refused honestly.
 */
process.env.NODE_ENV = 'test';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-playground-'));
process.env.FIRMLEDGER_DATA_DIR = tmp;
process.env.BASE_URL = 'https://firmledger.test';
process.env.GROQ_API_KEY = 'test-key-not-used';

const { db, setSetting } = require('../src/db');
const ai = require('../src/lib/ai');

/* ------------------------------------------------------- model fetch stub */

const calls = [];
let responder = () => ({ status: 200, content: '{}' });

globalThis.fetch = async function stub(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  const body = init && init.body ? JSON.parse(init.body) : {};
  calls.push({ url, body });
  const out = responder(body) || { status: 200, content: '{}' };
  return {
    ok: out.status >= 200 && out.status < 300,
    status: out.status,
    url,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      id: 'chatcmpl-stub',
      model: body.model,
      choices: [{ message: { role: 'assistant', content: out.content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }),
  };
};

/* --------------------------------------------------------------- harness */

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const one = (sql, ...p) => db.prepare(sql).get(...p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GENERATOR_DRAFT = JSON.stringify({
  name: 'Acme Cold Chain Ltd',
  tagline: 'Refrigerated freight between Mombasa and Kampala for horticulture exporters.',
  description: 'Acme Cold Chain operates a 12-truck refrigerated fleet moving fresh horticulture between Mombasa port and Kampala wholesale markets. It serves exporters and auction houses, with pre-cooling at origin, temperature logging on every load, and same-week billing. Headquartered in Nairobi since 2019 with about 40 staff across two hubs.',
  category: 'Logistics',
  tags: ['cold-chain', 'logistics', 'export'],
  founded: '2019',
  country: 'Kenya',
  type: 'company',
  website: 'https://acmecold.co.ke',
  email: 'ops@acmecold.co.ke',
  city: 'Nairobi',
  size: '11-50',
});

(async function main() {
  console.log('FirmLedger AI playground end-to-end suite\n');

  /* 1 — the generator really drafts a constrained listing */
  console.log('Listing generator');
  responder = () => ({ status: 200, content: GENERATOR_DRAFT });
  let gen = await ai.generateListing('Acme Cold Chain Ltd, acmecold.co.ke — refrigerated freight between Mombasa and Kampala, founded 2019, ~40 staff, Nairobi.');
  check('draft keeps the model name', gen.draft.name === 'Acme Cold Chain Ltd', gen.draft.name);
  check('draft respects the description ceiling', gen.draft.description.length <= 1200 && gen.draft.description.length >= 100);
  check('draft keeps a real URL', gen.draft.website === 'https://acmecold.co.ke');
  check('the JSON mode flag went over the wire',
    calls.some((c) => c.body.response_format && c.body.response_format.type === 'json_object'));

  /* 2 — publishing the draft really inserts a pending listing */
  console.log('\nPublish draft');
  const outcome = ai.publishListing(gen.draft);
  check('publish reports 201', outcome.status === 201, String(outcome.status));
  const created = one('SELECT * FROM listings WHERE name = ?', 'Acme Cold Chain Ltd');
  check('the listing really exists in the directory', Boolean(created), JSON.stringify(outcome.body && outcome.body.meta));
  check('it starts pending, not live', created && created.status === 'pending', created && created.status);
  check('it has a slug + confidence', created && created.slug === 'acme-cold-chain-ltd' && created.confidence > 0, created && `${created.slug}/${created.confidence}`);

  /* 3 — moderation makes a real decision and moves the state */
  console.log('\nAuto-moderation decisions are real');
  setSetting('ai_moderation_on', '1');
  const goodId = db.prepare(
    `INSERT INTO listings (slug, name, tagline, description, type, category, website, country, status)
     VALUES ('solid-co','Solid Co','Solid Co tagline','Solid Co builds invoicing software for Kenyan SMEs, serving 2,000 customers from Nairobi with payroll, tax filing and bank integrations since 2017.','company','Software','https://solid.example.com','Kenya','pending')`
  ).run().lastInsertRowid;
  const spamId = db.prepare(
    `INSERT INTO listings (slug, name, tagline, description, type, category, website, country, status)
     VALUES ('click-here','Click Here Now!!!','Best prices!!!!!','Buy cheap stuff now. Best deal in the world. Click the link. No company facts at all.','company','Other','https://example.com','Kenya','pending')`
  ).run().lastInsertRowid;

  responder = (body) => {
    const userMsg = (body.messages || []).map((m) => String(m.content || '')).join('\n');
    if (/listing moderator/i.test(userMsg)) {
      if (/Solid Co/i.test(userMsg)) return { status: 200, content: '{"decision":"approve","reason":"Real business with substance.","confidence":92}' };
      if (/Click Here Now/i.test(userMsg)) return { status: 200, content: '{"decision":"reject","reason":"Placeholder spam with no company facts.","confidence":95}' };
      return { status: 200, content: '{"decision":"approve","reason":"Low confidence guess.","confidence":30}' };
    }
    return { status: 200, content: GENERATOR_DRAFT };
  };

  const good = await ai.moderateListing(goodId);
  check('approve decision is real — status flipped', one('SELECT status FROM listings WHERE id=?', goodId).status === 'approved', JSON.stringify(good));
  check('the moderation log row exists', Boolean(one("SELECT * FROM ai_moderation_log WHERE listing_id=? AND decision='approve'", goodId)));

  const spam = await ai.moderateListing(spamId);
  check('reject decision is real — status flipped', one('SELECT status FROM listings WHERE id=?', spamId).status === 'rejected', JSON.stringify(spam));

  const unsureId = db.prepare(
    `INSERT INTO listings (slug, name, tagline, description, type, category, website, country, status)
     VALUES ('maybe-co','Maybe Co','Maybe Co tagline','Maybe Co is a company. It does things in the city and serves local customers with a small team and a basic website offering general services in the region.','company','Other','https://maybe.example.com','Kenya','pending')`
  ).run().lastInsertRowid;
  await ai.moderateListing(unsureId);
  check('low confidence stays pending (human review)', one('SELECT status FROM listings WHERE id=?', unsureId).status === 'pending');

  /* 4 — a failed moderation call is honest: pending + error log */
  console.log('\nModeration failure path');
  const failId = db.prepare(
    `INSERT INTO listings (slug, name, tagline, description, type, category, website, country, status)
     VALUES ('fail-co','Fail Co','Fail Co tagline','Fail Co provides reliable accounting and bookkeeping services to manufacturing firms in East Africa, with a team of ten chartered accountants in Nairobi.','company','Finance','https://fail.example.com','Kenya','pending')`
  ).run().lastInsertRowid;
  responder = () => ({ status: 500, content: 'upstream down' });
  const failed = await ai.moderateListing(failId);
  check('a failed call leaves the record pending', one('SELECT status FROM listings WHERE id=?', failId).status === 'pending');
  check('the failure is logged, not swallowed', failed.failed === true && Boolean(one("SELECT * FROM ai_moderation_log WHERE listing_id=? AND decision='error'", failId)));

  /* 5 — publish with moderation on: the scheduled review runs itself */
  console.log('\nPublish → scheduled auto-moderation');
  responder = () => ({ status: 200, content: GENERATOR_DRAFT
    .replace('Acme Cold Chain Ltd', 'Auto Review Co')
    .replace(/acmecold\.co\.ke/g, 'autoreview.co.ke')
    .replace(/ops@acmecold\.co\.ke/g, 'ops@autoreview.co.ke') });
  const auto = await ai.generateListing('Auto Review Co, autoreview.co.ke — quality audits for food processors in Nairobi, founded 2021.');
  ai.publishListing(auto.draft);
  const autoRow = one("SELECT * FROM listings WHERE name = ?", 'Auto Review Co');
  check('new record starts pending', autoRow && autoRow.status === 'pending');
  responder = (body) => {
    const userMsg = (body.messages || []).map((m) => String(m.content || '')).join('\n');
    if (/listing moderator/i.test(userMsg)) return { status: 200, content: '{"decision":"approve","reason":"Real business.","confidence":88}' };
    return { status: 200, content: GENERATOR_DRAFT };
  };
  let approved = false;
  for (let i = 0; i < 40 && !approved; i++) {
    await sleep(100);
    approved = one('SELECT status FROM listings WHERE id=?', autoRow.id).status === 'approved';
  }
  check('the background review approved it on its own', approved);
  setSetting('ai_moderation_on', '0');

  /* 6 — honest refusals */
  console.log('\nHonest refusals');
  let short = false;
  try { await ai.generateListing('hi'); } catch (e) { short = e.status === 422; }
  check('a too-short brief is refused with 422', short);
  responder = () => ({ status: 200, content: 'I cannot return JSON right now, sorry.' });
  let badJson = false;
  try {
    await ai.generateListing('Acme Cold Chain Ltd, acmecold.co.ke — refrigerated freight, founded 2019, Nairobi.');
  } catch (e) { badJson = e.status === 502; }
  check('invalid model JSON is refused (and audited), not published',
    badJson && Boolean(one("SELECT * FROM ai_audit_log WHERE action='invalid_json' AND ok=0")));

  console.log(`\n${'='.repeat(64)}`);
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  failures.forEach((f) => console.log('  • ' + f));
  console.log('='.repeat(64));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
