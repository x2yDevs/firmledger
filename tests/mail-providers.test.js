/**
 * FirmLedger — mail providers: removal + bulk-send provider pinning.
 *
 *   node tests/mail-providers.test.js
 *
 *   A. Library level — Emitlo / Maileroo / Mailjet are no longer offered
 *      presets; stored credentials for them are dropped when the database
 *      boots (an existing deployment's DB is cleaned on the boot pass);
 *      hopsVia() pins a provider to the front of the failover chain while
 *      keeping every other hop armed; the bulk-via preference and the
 *      grouped provider lists behave.
 *
 *   B. HTTP level — the real server with a signed-in admin: Admin → Email
 *      carries the "Send through" picker (grouped by source), a bulk send
 *      goes out first through the pinned provider and the choice is
 *      remembered, paused/unknown providers fall back to automatic, and
 *      Admin → Settings no longer mentions the removed providers and
 *      groups the saved providers per preset.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => decodeURIComponent(String(s || '').replace(/\+/g, ' '));

/* ===================================================================== */
/* A. Library level                                                       */
/* ===================================================================== */
console.log('FirmLedger mail providers — A. library level\n');

const dataDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-mail-a-'));
process.env.FIRMLEDGER_DATA_DIR = dataDirA;
process.env.BASE_URL = 'https://firmledger.test';
process.env.SMTP_URL = 'smtp://user:pass@127.0.0.1:1'; // refuses instantly — no network in tests

const { db } = require(path.join(ROOT, 'src/db.js'));

const REMOVED = ['emitlo', 'maileroo', 'mailjet'];

/* Preset list no longer offers the three providers. */
const mailer = require(path.join(ROOT, 'src/lib/mailer.js'));
const ids = mailer.PROVIDERS.map((p) => p.id);
for (const r of REMOVED) check(`preset ${r} is removed from PROVIDERS`, !ids.includes(r), ids.join(','));
check('remaining presets still offered', ['zoho', 'zoho_pro', 'brevo', 'mailtrap', 'smtp2go', 'resend', 'custom'].every((p) => ids.includes(p)), ids.join(','));

/* An EXISTING deployment: rows already stored for the removed providers must
   be dropped when the database runs its boot pass (mirrors the migration). */
const insAcct = db.prepare(
  'INSERT INTO smtp_accounts (provider, label, host, port, secure, username, password, daily_limit, active, sort) VALUES (?,?,?,?,?,?,?,?,1,?)'
);
for (const r of REMOVED) insAcct.run(r, `Old ${r}`, `smtp.${r}.com`, 587, 0, 'old@x.com', 'secret', 0, 0);
const brevoIdA = Number(insAcct.run('brevo', 'Brevo bulk', '127.0.0.1', 1, 0, 'bulk@x.com', 'secret', 0, 10).lastInsertRowid);
const zohoIdA = Number(insAcct.run('zoho', 'Zoho main', '127.0.0.1', 1, 0, 'main@x.com', 'secret', 0, 20).lastInsertRowid);
execFileSync(process.execPath, ['-e', `
process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(dataDirA)};
process.env.SMTP_URL = 'smtp://user:pass@127.0.0.1:1';
require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
console.log('boot pass done');
`], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
for (const r of REMOVED) {
  const row = db.prepare('SELECT * FROM smtp_accounts WHERE provider=?').get(r);
  check(`stored ${r} account deleted on the boot pass`, !row, row ? `id ${row.id}` : '');
}
const survivors = db.prepare("SELECT COUNT(*) c FROM smtp_accounts WHERE provider IN ('brevo','zoho')").get().c;
check('kept providers untouched by the cleanup', survivors === 2, `found ${survivors}`);

/* hopsVia(): the pinned hop moves to the front, nothing else is dropped. */
{
  const chain = mailer.hops();
  check('env hop + both saved accounts form the chain', chain.length === 3, chain.map((h) => h.key).join(' → '));
  const via = `admin:${zohoIdA}`;
  const pinned = mailer.hopsVia(via);
  check('pinned provider goes first', pinned[0] && pinned[0].key === via, pinned.map((h) => h.key).join(' → '));
  check('every hop still armed behind it', pinned.length === chain.length && pinned.every((h) => chain.some((c) => c.key === h.key)), pinned.map((h) => h.key).join(' → '));
  check('unknown via key keeps the ordinary chain', mailer.hopsVia('admin:99999').map((h) => h.key).join('|') === chain.map((h) => h.key).join('|'));
}

/* Bulk-via preference: remembered per console, invalidated when the hop is gone. */
{
  check('no bulk-via preference by default', mailer.bulkVia() === '', mailer.bulkVia());
  mailer.saveBulkVia(`admin:${zohoIdA}`);
  check('preference is remembered', mailer.bulkVia() === `admin:${zohoIdA}`);
  mailer.saveBulkVia('');
  check('preference clears back to automatic', mailer.bulkVia() === '');
}

/* Grouped lists for the UIs. */
{
  const groups = mailer.bulkViaHops();
  const sources = groups.map((g) => g.source);
  check('picker groups: environment first, then saved providers', JSON.stringify(sources) === JSON.stringify(['env', 'admin']), sources.join(','));
  const adminGroup = groups.find((g) => g.source === 'admin');
  check('saved-provider group lists both accounts', adminGroup && adminGroup.hops.length === 2, adminGroup ? adminGroup.hops.map((h) => h.label).join(',') : 'missing group');
  const acctGroups = mailer.accountGroups();
  check('settings groups one row-set per preset, ordered by name',
    acctGroups.map((g) => g.name).join('|') === 'Brevo|Zoho Mail'
    && acctGroups.every((g) => g.accounts.length === 1),
    acctGroups.map((g) => `${g.name}:${g.accounts.length}`).join(','));
}

/* ===================================================================== */
/* B. HTTP level — real server, signed-in admin                           */
/* ===================================================================== */
console.log('\nFirmLedger mail providers — B. HTTP level\n');

const dataDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-mail-b-'));
const PORT = 4199 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
const env = {
  ...process.env,
  FIRMLEDGER_DATA_DIR: dataDirB,
  PORT: String(PORT),
  BASE_URL: BASE,
  ADMIN_SECRET: 'smoke-test-secret',
  SMTP_URL: 'smtp://user:pass@127.0.0.1:1',
  STATUS_UPDATE_INTERVAL: '3600',
};

const token = 'mail' + crypto.randomBytes(16).toString('hex');
const csrf = crypto.randomBytes(12).toString('hex');
const seed = `
process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(dataDirB)};
const { db, setSetting } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
const run = (sql, ...p) => db.prepare(sql).run(...p);
run(\"INSERT INTO users (email,password_hash,name,plan) VALUES ('mailqa@example.com','$2a$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','Mail QA','free')\");
const acct = (provider, label, sort) => run('INSERT INTO smtp_accounts (provider,label,host,port,secure,username,password,daily_limit,active,sort) VALUES (?,?,?,?,?,?,?,?,1,?)', provider, label, '127.0.0.1', 1, 0, 'qa@x.com', 'secret', 0, sort);
acct('emitlo', 'Old Emitlo', 1);
acct('maileroo', 'Old Maileroo', 2);
acct('mailjet', 'Old Mailjet', 3);
acct('brevo', 'Brevo bulk', 10);
acct('zoho', 'Zoho main', 20);
run(\"INSERT INTO sessions (token,user_id,csrf,kind,expires_at) VALUES (?,NULL,?, 'admin', datetime('now','+1 day'))\", ${JSON.stringify(token)}, ${JSON.stringify(csrf)});
console.log('seeded');
`;
execFileSync(process.execPath, ['-e', seed], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });

const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`).catch(() => fetch(BASE));
      if (res) return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return false;
}

const adminCookie = { cookie: `fl_admin=${token}` };
const readDb = () => new (require('better-sqlite3'))(path.join(dataDirB, 'firmledger.db'), { readonly: true });
const getSettingVal = (key) => {
  const ro = readDb();
  const row = ro.prepare('SELECT value FROM settings WHERE key=?').get(key);
  ro.close();
  return row ? row.value : null;
};
const acctId = (provider) => {
  const ro = readDb();
  const row = ro.prepare('SELECT id FROM smtp_accounts WHERE provider=?').get(provider);
  ro.close();
  return row ? row.id : null;
};

const post = (url, body) => fetch(BASE + url, {
  method: 'POST', redirect: 'manual',
  headers: { ...adminCookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ _csrf: csrf, ...body }).toString(),
});

(async function main() {
  const up = await waitForServer();
  if (!up) {
    console.log('server did not start:\n' + serverLog.slice(-2000));
    server.kill('SIGKILL');
    process.exit(1);
  }

  /* The removed providers are gone from the live database on boot. */
  for (const r of REMOVED) check(`boot deleted the stored ${r} account`, acctId(r) === null, `id ${acctId(r)}`);
  const brevoId = acctId('brevo');
  const zohoId = acctId('zoho');
  check('kept accounts survive the boot', brevoId && zohoId, `brevo=${brevoId} zoho=${zohoId}`);
  const zohoKey = `admin:${zohoId}`;
  const brevoKey = `admin:${brevoId}`;

  /* Admin → Email carries the "Send through" picker, grouped. */
  const emailHtml = await (await fetch(BASE + '/admin3119Musa/email', { headers: adminCookie })).text();
  check('email page renders', !/<h1>Server error/i.test(emailHtml));
  check('"Send through" select exists', /name="via" id="mailVia"/.test(emailHtml));
  check('automatic failover is the default pick', /<option value="" selected>Automatic — full failover chain \(default\)<\/option>/.test(emailHtml));
  check('picker groups: Environment (.env)', /<optgroup label="Environment \(\.env\)">/.test(emailHtml));
  check('picker groups: Saved providers', /<optgroup label="Saved providers">/.test(emailHtml));
  check('picker lists both saved providers', /value="admin:\d+"[^>]*>Brevo bulk — 127\.0\.0\.1:1/.test(emailHtml) && /value="admin:\d+"[^>]*>Zoho main — 127\.0\.0\.1:1/.test(emailHtml));
  check('email page never mentions the removed providers', !/Emitlo|Maileroo|Mailjet/i.test(emailHtml));
  check('picker explains the bulk-mail reason', /Some relays do not allow bulk mail/.test(emailHtml));

  /* A bulk send pinned to Zoho goes out first through Zoho and is remembered. */
  const r1 = await post('/admin3119Musa/email', {
    to: '', external: 'qa-bulk@example.com', via: zohoKey,
    subject: 'Bulk pin test', body: 'Testing provider pinning for bulk mail.', format: 'text',
  });
  const loc1 = decode(r1.headers.get('location') || '');
  check('pinned bulk send redirects with a result', r1.status === 302, `HTTP ${r1.status}`);
  check('result names the pinned provider first', /Sent out first through Zoho main/.test(loc1), loc1);
  check('choice remembered in settings', getSettingVal('mail_bulk_via') === zohoKey, getSettingVal('mail_bulk_via'));
  {
    const ro = readDb();
    const row = ro.prepare("SELECT * FROM admin_mail_log WHERE subject='Bulk pin test'").get();
    ro.close();
    check('the send is in the recent-sends log', Boolean(row), 'no admin_mail_log row');
  }
  const emailHtml2 = await (await fetch(BASE + '/admin3119Musa/email', { headers: adminCookie })).text();
  check('next visit pre-selects the remembered provider', new RegExp(`value="${zohoKey}" selected`).test(emailHtml2));

  /* Unknown provider → back to automatic, nothing pinned. */
  const r2 = await post('/admin3119Musa/email', {
    to: '', external: 'qa-bulk@example.com', via: 'admin:999999',
    subject: 'Unknown provider', body: 'Testing the unknown-provider fallback.', format: 'text',
  });
  const loc2 = decode(r2.headers.get('location') || '');
  check('unknown via falls back to automatic', r2.status === 302 && !/Sent out first through/.test(loc2), loc2 || `HTTP ${r2.status}`);
  check('unknown via clears the preference', getSettingVal('mail_bulk_via') === null || getSettingVal('mail_bulk_via') === '', String(getSettingVal('mail_bulk_via')));

  /* Paused provider → not offerable, treated as automatic. */
  const t = await post(`/admin3119Musa/mail/accounts/${brevoId}/toggle`, {});
  check('pause toggle works', t.status === 302, `HTTP ${t.status}`);
  const r3 = await post('/admin3119Musa/email', {
    to: '', external: 'qa-bulk@example.com', via: brevoKey,
    subject: 'Paused provider', body: 'Testing the paused-provider fallback.', format: 'text',
  });
  const loc3 = decode(r3.headers.get('location') || '');
  check('paused provider falls back to automatic', r3.status === 302 && !/Sent out first through/.test(loc3), loc3 || `HTTP ${r3.status}`);

  /* Admin → Settings: no removed providers anywhere, saved list grouped. */
  const settingsHtml = await (await fetch(BASE + '/admin3119Musa/settings', { headers: adminCookie })).text();
  check('settings page renders', !/<h1>Server error/i.test(settingsHtml));
  check('settings never mention the removed providers', !/Emitlo|Maileroo|Mailjet/i.test(settingsHtml));
  check('add-provider dropdown offers remaining presets', /<option value="brevo"/.test(settingsHtml) && /<option value="zoho"/.test(settingsHtml));
  check('saved providers grouped per preset',
    /<td colspan="4"[^>]*>Brevo</.test(settingsHtml) && /<td colspan="4"[^>]*>Zoho Mail</.test(settingsHtml));

  console.log(`\n${'='.repeat(64)}`);
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  failures.forEach((f) => console.log('  • ' + f));
  if (failures.length) console.log('\nserver log tail:\n' + serverLog.slice(-1500));
  console.log('='.repeat(64));

  server.kill('SIGKILL');
  try { fs.rmSync(dataDirA, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(dataDirB, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
})();
