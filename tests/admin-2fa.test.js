/**
 * FirmLedger — admin sign-in chain.
 *
 *   node tests/admin-2fa.test.js
 *
 * The gate is a strict three-step chain, all of it real:
 *
 *   1. the ADMIN_SECRET code,
 *   2. a one-time 6-digit code emailed to the sign-in OTP inbox
 *      (admin@firmledger.co.ke by default, editable in Settings, stored on
 *      the account),
 *   3. the authenticator TOTP — or a recovery code — with the TOTP key
 *      attached to the ACCOUNT: scanned once at first sign-in, never
 *      re-scanned afterwards (on any device, even across restarts).
 *
 * The suite drives a real server with the real mailer — with no SMTP provider
 * configured, every email lands in data/outbox.log, which is exactly where
 * the test reads the OTPs from. Nothing is stubbed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-admin2fa-'));
const PORT = 4500 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;
const OUTBOX = path.join(ROOT, 'data', 'outbox.log');
const ADMIN_SECRET = 'test-admin-secret-2fa';

/* This process reads the same DB as the server (TOTP secret, sessions, settings). */
process.env.FIRMLEDGER_DATA_DIR = dataDir;

const env = {
  ...process.env,
  FIRMLEDGER_DATA_DIR: dataDir,
  PORT: String(PORT),
  BASE_URL: 'https://firmledger.co.ke',
  ADMIN_SECRET,
};

const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${BASE}/admin3119Musa`); if (r.status === 200) return true; } catch {}
    await sleep(250);
  }
  return false;
}

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const finish = (code = 0) => {
  console.log(`\n================================================================\nchecks passed: ${passed}   failed: ${failures.length}`);
  if (failures.length) console.log(failures.map((f) => '  ✗ ' + f).join('\n'));
  server.kill('SIGKILL');
  process.exit(failures.length || code ? 1 : 0);
};

/* ---- tiny cookie jar over fetch ---- */
function makeJar() {
  const store = new Map();
  return {
    header() { return [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
    get(name) { return store.get(name) || ''; },
    absorb(res) {
      for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const pair = c.split(';')[0];
        const i = pair.indexOf('=');
        if (i > 0) store.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
  };
}
async function req(jar, method, pathname, body) {
  const res = await fetch(BASE + pathname, {
    method,
    redirect: 'manual',
    headers: {
      ...(jar && jar.header() ? { cookie: jar.header() } : {}),
      ...(body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body !== undefined ? new URLSearchParams(body).toString() : undefined,
  });
  if (jar) jar.absorb(res);
  return res;
}

/* ---- OTP harvest from the real mail outbox ----
   Returns the LATEST matching code in the appended tail — mail sends are
   fire-and-forget, so an older code's write can land after our offset
   snapshot; only the newest code is ever live. */
function outboxSize() { try { return fs.statSync(OUTBOX).size; } catch { return 0; } }
async function waitForOtp(toEmail, fromOffset, timeoutMs = 8000) {
  const start = Date.now();
  let latest = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const tail = fs.readFileSync(OUTBOX).slice(fromOffset).toString('utf8');
      for (const b of tail.split('-'.repeat(60))) {
        const to = (b.match(/TO=([^\n]+)/) || [])[1] || '';
        const code = (b.match(/sign-in code[^\d]{0,4}(\d{6})/i) || b.match(/Your code: (\d{6})/) || [])[1];
        if (code && to === toEmail) latest = code;
      }
      if (latest) return latest;
    } catch { /* file not written yet */ }
    await sleep(150);
  }
  return latest;
}

(async function main() {
  console.log('FirmLedger admin 2FA chain test\n');
  if (!(await waitUp())) {
    console.log('server did not start:\n' + serverLog.slice(-2000));
    server.kill('SIGKILL');
    process.exit(1);
  }
  const { db, getSetting, setSetting } = require(path.join(ROOT, 'src/db.js'));
  const totp = require(path.join(ROOT, 'src/lib/totp.js'));
  const nowCode = (secret) => totp.totp(secret);

  /* ================= A. first sign-in: secret → email → enrollment ================= */
  console.log('A. first sign-in — secret, emailed code, one-time QR enrollment');
  {
    const j = makeJar();
    let size = outboxSize();

    const gate = await (await req(j, 'GET', '/admin3119Musa')).text();
    check('gate describes the three-step chain', /three-step chain/.test(gate) && /emailed to the admin inbox/.test(gate));

    const bad = await req(j, 'POST', '/admin3119Musa', { code: 'totally-wrong' });
    check('wrong secret is refused (403)', bad.status === 403, `got ${bad.status}`);

    const ok = await req(j, 'POST', '/admin3119Musa', { code: ADMIN_SECRET });
    check('correct secret moves to the email step',
      ok.status === 302 && (ok.headers.get('location') || '').includes('/admin3119Musa/2fa-email'),
      `${ok.status} → ${ok.headers.get('location')}`);

    const emailPage = await (await req(j, 'GET', '/admin3119Musa/2fa-email')).text();
    check('email step shows step 2 of 3', /step 2 of 3/.test(emailPage));
    check('email step names admin@firmledger.co.ke', emailPage.includes('admin@firmledger.co.ke'));

    const otp = await waitForOtp('admin@firmledger.co.ke', size);
    check('the OTP email really went to admin@firmledger.co.ke', Boolean(otp));

    const wrongOtp = await req(j, 'POST', '/admin3119Musa/2fa-email', { code: '000000' });
    check('wrong OTP is refused (403)', wrongOtp.status === 403, `got ${wrongOtp.status}`);

    size = outboxSize();
    const good = await req(j, 'POST', '/admin3119Musa/2fa-email', { code: otp });
    check('correct OTP advances (first sign-in → enrollment)',
      good.status === 302 && (good.headers.get('location') || '').includes('/admin3119Musa/2fa-setup'),
      `${good.status} → ${good.headers.get('location')}`);

    const setupPage = await (await req(j, 'GET', '/admin3119Musa/2fa-setup')).text();
    check('enrollment shows a QR code', /data:image\/png;base64/.test(setupPage));
    const shownSecret = (setupPage.match(/id="totpKey"[^>]*>([A-Z2-7]+)</) || [])[1];
    const dbSecret = getSetting('admin_totp_pending', '');
    check('the manual key matches the pending secret on the account', shownSecret === dbSecret && Boolean(dbSecret));

    const enroll = await req(j, 'POST', '/admin3119Musa/2fa-setup', { code: nowCode(dbSecret) });
    const enrollBody = await enroll.text();
    check('TOTP confirmation activates two-factor', /recovery code/i.test(enrollBody) && /Save these now/.test(enrollBody), `HTTP ${enroll.status}`);
    check('the key is now attached to the account (admin_totp_secret set)', getSetting('admin_totp_secret', '') === dbSecret && Boolean(dbSecret));
    const recoveryCodes = [...enrollBody.matchAll(/<li><code>([A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4})<\/code><\/li>/g)].map((m) => m[1]);
    check('10 one-time recovery codes are issued', recoveryCodes.length === 10, `${recoveryCodes.length} found`);

    const dash = await req(j, 'GET', '/admin3119Musa/dashboard');
    check('the console opens after enrollment', dash.status === 200, `got ${dash.status}`);
    global.__recoveryCodes = recoveryCodes;
    global.__adminJar = j;
  }

  /* ================= B. second sign-in: no QR, ever ================= */
  console.log('B. second sign-in — same account, no re-scan');
  {
    const j = makeJar(); // a different device: no cookies at all
    let size = outboxSize();
    const ok = await req(j, 'POST', '/admin3119Musa', { code: ADMIN_SECRET });
    const loc = ok.headers.get('location') || '';
    check('secret lands on the email step (not the QR)', ok.status === 302 && loc.includes('/2fa-email') && !loc.includes('setup'), `${ok.status} → ${loc}`);

    const otp2 = await waitForOtp('admin@firmledger.co.ke', size);
    check('a fresh OTP is emailed for the new sign-in', Boolean(otp2));
    const good = await req(j, 'POST', '/admin3119Musa/2fa-email', { code: otp2 });
    const loc2 = good.headers.get('location') || '';
    check('OTP leads straight to the authenticator step', good.status === 302 && loc2.includes('/admin3119Musa/2fa') && !loc2.includes('setup'), `${good.status} → ${loc2}`);

    const totpPage = await (await req(j, 'GET', '/admin3119Musa/2fa')).text();
    check('the authenticator screen shows no QR (account already enrolled)', !/data:image\/png;base64/.test(totpPage) && !/Set up two-factor/.test(totpPage));
    check('the authenticator screen is step 3 of 3', /step 3 of 3/.test(totpPage));

    const done = await req(j, 'POST', '/admin3119Musa/2fa', { code: nowCode(getSetting('admin_totp_secret', '')) });
    check('TOTP opens the console', done.status === 302 && (done.headers.get('location') || '').includes('dashboard'), `${done.status} → ${done.headers.get('location')}`);
    const dash = await req(j, 'GET', '/admin3119Musa/dashboard');
    check('dashboard reachable on the second device', dash.status === 200);
  }

  /* ================= C. resilience of the chain ================= */
  console.log('C. resilience — throttles, fallbacks, boundaries');
  {
    /* wrong OTP ×5 kills the pending session */
    const j = makeJar();
    await req(j, 'POST', '/admin3119Musa', { code: ADMIN_SECRET });
    let last;
    for (let i = 0; i < 5; i++) last = await req(j, 'POST', '/admin3119Musa/2fa-email', { code: '313131' });
    check('five wrong OTPs discard the verification (429 back to the gate)', last.status === 429, `got ${last.status}`);

    /* resend cooldown: one email per minute — age the last-send stamp so the
       first resend is genuinely allowed, then prove the cooldown re-arms */
    const j2 = makeJar();
    await req(j2, 'POST', '/admin3119Musa', { code: ADMIN_SECRET });
    setSetting('admin_email_otp_sent_at', '0'); // as if last email was long ago
    const r1 = await req(j2, 'POST', '/admin3119Musa/2fa-email/resend', {});
    const r2 = await req(j2, 'POST', '/admin3119Musa/2fa-email/resend', {});
    check('a resend is allowed, then throttled for a minute', r1.status === 302 && r2.status === 429, `${r1.status} then ${r2.status}`);

    /* step skipping is impossible without the cookie */
    const direct = await req(null, 'GET', '/admin3119Musa/2fa');
    check('the authenticator step cannot be reached without passing step 2', direct.status === 302 && (direct.headers.get('location') || '').includes('/admin3119Musa'), `${direct.status}`);

    /* a recovery code still works at step 3 (as it always did) */
    const j3 = makeJar();
    let size = outboxSize();
    await req(j3, 'POST', '/admin3119Musa', { code: ADMIN_SECRET });
    const otp3 = await waitForOtp('admin@firmledger.co.ke', size);
    await req(j3, 'POST', '/admin3119Musa/2fa-email', { code: otp3 });
    const rec = global.__recoveryCodes[0];
    const viaRec = await req(j3, 'POST', '/admin3119Musa/2fa', { code: rec });
    check('a recovery code still opens the console at step 3',
      viaRec.status === 302 && decodeURIComponent(viaRec.headers.get('location') || '').includes('recovery code'),
      `${viaRec.status} → ${viaRec.headers.get('location')}`);
    const spent = await (await req(j3, 'POST', '/admin3119Musa/2fa', { code: rec })).text();
    void spent;

    /* the burned recovery code cannot be reused on the next attempt */
    const j4 = makeJar();
    let size4 = outboxSize();
    await req(j4, 'POST', '/admin3119Musa', { code: ADMIN_SECRET });
    const otp4 = await waitForOtp('admin@firmledger.co.ke', size4);
    await req(j4, 'POST', '/admin3119Musa/2fa-email', { code: otp4 });
    const reuse = await req(j4, 'POST', '/admin3119Musa/2fa', { code: rec });
    check('a spent recovery code is refused', reuse.status === 403, `got ${reuse.status}`);
  }

  /* ================= D. the OTP inbox is on the account, changeable ================= */
  console.log('D. OTP inbox — account setting, editable in Settings');
  {
    const j = global.__adminJar;
    const token = j.get('fl_admin');
    const csrf = (db.prepare('SELECT csrf FROM sessions WHERE token = ?').get(token) || {}).csrf || '';
    const save = await req(j, 'POST', '/admin3119Musa/settings/2fa-email', { email: 'not-an-email', _csrf: csrf });
    check('an invalid inbox address is rejected', (save.headers.get('location') || '').includes('err=') || save.status === 302 && /err=/.test(save.headers.get('location') || ''), save.headers.get('location'));

    const size = outboxSize();
    const saveOk = await req(j, 'POST', '/admin3119Musa/settings/2fa-email', { email: 'ops-admin@firmledger.co.ke', _csrf: csrf });
    check('a valid address is saved from Settings', /ok=/.test(saveOk.headers.get('location') || ''), saveOk.headers.get('location'));

    const j5 = makeJar();
    await req(j5, 'POST', '/admin3119Musa', { code: ADMIN_SECRET });
    const page = await (await req(j5, 'GET', '/admin3119Musa/2fa-email')).text();
    check('the email step reflects the new inbox', page.includes('ops-admin@firmledger.co.ke'));
    const otp5 = await waitForOtp('ops-admin@firmledger.co.ke', size);
    check('the OTP is delivered to the new inbox', Boolean(otp5));
    await req(j5, 'POST', '/admin3119Musa/2fa-email', { code: otp5 });
    await req(j5, 'POST', '/admin3119Musa/2fa', { code: nowCode(getSetting('admin_totp_secret', '')) });

    /* blank → back to the default admin@firmledger.co.ke */
    await req(j, 'POST', '/admin3119Musa/settings/2fa-email', { email: '', _csrf: csrf });
    const j6 = makeJar();
    const size6 = outboxSize();
    await req(j6, 'POST', '/admin3119Musa', { code: ADMIN_SECRET });
    const otp6 = await waitForOtp('admin@firmledger.co.ke', size6);
    check('blanking the inbox restores the admin@firmledger.co.ke default', Boolean(otp6));
    await req(j6, 'POST', '/admin3119Musa/2fa-email', { code: otp6 });
    await req(j6, 'POST', '/admin3119Musa/2fa', { code: nowCode(getSetting('admin_totp_secret', '')) });
  }

  /* ================= E. the account outlives the server ================= */
  console.log('E. restart — enrollment survives, still no re-scan');
  {
    server.kill('SIGKILL');
    await sleep(400);
    const server2 = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server2.stdout.on('data', (d) => { serverLog += d; });
    server2.stderr.on('data', (d) => { serverLog += d; });
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      try { const r = await fetch(`${BASE}/admin3119Musa`); if (r.status === 200) up = true; } catch {}
      await sleep(250);
    }
    check('the server restarts cleanly', up);

    const j = makeJar();
    const size = outboxSize();
    const ok = await req(j, 'POST', '/admin3119Musa', { code: ADMIN_SECRET });
    const otp = await waitForOtp('admin@firmledger.co.ke', size);
    check('the chain works after restart (fresh OTP)', Boolean(otp));
    const good = await req(j, 'POST', '/admin3119Musa/2fa-email', { code: otp });
    const loc = good.headers.get('location') || '';
    check('still no QR after a restart — the key is on the account', loc.includes('/admin3119Musa/2fa') && !loc.includes('setup'), loc);
    const done = await req(j, 'POST', '/admin3119Musa/2fa', { code: nowCode(getSetting('admin_totp_secret', '')) });
    check('the same authenticator key opens the console', done.status === 302 && (done.headers.get('location') || '').includes('dashboard'));
    server2.kill('SIGKILL');
  }

  finish();
})().catch((e) => {
  console.error('test crashed:', e);
  server.kill('SIGKILL');
  process.exit(1);
});
