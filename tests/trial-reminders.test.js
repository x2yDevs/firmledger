/**
 * FirmLedger — free-trial reminder ladder test.
 *
 *   node tests/trial-reminders.test.js
 *
 * Boots src/lib against a throwaway database and drives the hourly trial sweep
 * (src/lib/trialreminders.js) with users placed at each stage of a trial:
 * roughly halfway through, a few days left, final day, just-expired (back on
 * Free), just-expired while holding paid Pro, and a fresh account. Asserts:
 *   • the right milestone fires for each stage (email subject + in-app
 *     notification), exactly once per trial,
 *   • emails really go through the FirmLedger mailer (data/outbox.log — no
 *     SMTP is configured, so nothing touches the wire),
 *   • the user gets BOTH channels: an outbound email and a notifications row,
 *   • finished trials flip back to 'free' before the notice,
 *   • starting a new trial resets the reminder ladder,
 *   • a second sweep sends nothing new.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-trial-'));
process.env.FIRMLEDGER_DATA_DIR = dataDir;
process.env.BASE_URL = 'https://firmledger.test';
process.env.SMTP_URL = ''; // no env mailer → everything lands in data/outbox.log

/* The mailer writes its outbox next to the app (ROOT/data/outbox.log), not in
   the throwaway data dir — preserve whatever was there so other suites that
   harvest the same file are unaffected. */
const OUTBOX = path.join(ROOT, 'data', 'outbox.log');
let outboxBefore = '';
if (fs.existsSync(OUTBOX)) outboxBefore = fs.readFileSync(OUTBOX, 'utf8');
/* Every writeOutbox() below rewrites exactly this prefix, so lines appended by
   THIS suite always start at outboxBefore.length — earlier suites that share
   the file (run under `npm test`) never leak into the assertions. */
const PREFIX_LEN = Buffer.byteLength(outboxBefore, 'utf8');
const writeOutbox = () => { try { fs.mkdirSync(path.dirname(OUTBOX), { recursive: true }); } catch { /* ignore */ } fs.writeFileSync(OUTBOX, outboxBefore); };

const { db } = require('../src/db');
const plans = require('../src/lib/plans');
const reminders = require('../src/lib/trialreminders');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

/* ------------------------------------------------------------- helpers */
const sqlDate = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

function addUser(email, over = {}) {
  const info = db.prepare(
    `INSERT INTO users (email, password_hash, name, plan, plan_expires_at,
                        subscription_status, trial_days, trial_expires_at, trial_reminders_sent)
     VALUES (?, 'x', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    email,
    over.name || email.split('@')[0],
    over.plan || 'free', over.plan_expires_at || '',
    over.subscription_status || 'trialing',
    over.trial_days || null, over.trial_expires_at || null,
    over.trial_reminders_sent || ''
  );
  return db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid);
}

const inAppCount = (userId) => db.prepare(
  "SELECT COUNT(*) c FROM notifications WHERE audience='user' AND user_id=? AND kind='billing' AND deleted_at IS NULL"
).get(userId).c;

const inAppFor = (userId) => db.prepare(
  "SELECT title FROM notifications WHERE audience='user' AND user_id=? AND kind='billing' AND deleted_at IS NULL ORDER BY id ASC"
).all(userId);

const sentMark = (id) => {
  const r = db.prepare('SELECT trial_reminders_sent FROM users WHERE id=?').get(id);
  try { return JSON.parse(r.trial_reminders_sent || '[]'); } catch { return []; }
};

/** [{ to, subject }] parsed from the mailer outbox — only lines this suite
    appended (the shared file may hold mail from earlier suites). */
function mailRows() {
  if (!fs.existsSync(OUTBOX)) return [];
  const whole = fs.readFileSync(OUTBOX, 'utf8');
  const txt = Buffer.from(whole, 'utf8').subarray(PREFIX_LEN).toString('utf8');
  const rows = [];
  let to = '';
  for (const line of txt.split('\n')) {
    /* The mailer logs each envelope as “[timestamp] OUTBOX TO=…” on one line. */
    const toM = line.match(/(?:^|\s)TO=(\S+)/);
    if (toM) to = toM[1];
    else if (line.startsWith('SUBJECT=')) rows.push({ to, subject: line.slice(8).trim() });
  }
  return rows;
}

const now = () => new Date();
const hours = (h) => h * 3600e3;
const days = (d) => d * 864e5;

async function main() {
  console.log('FirmLedger free-trial reminder suite\n');

  /* ------------------------------------------------------------- fixtures */
  section('Setup');
  const halfUser = addUser('half@example.com', { name: 'Halfway Hal', trial_days: 14, trial_expires_at: sqlDate(new Date(now().getTime() + days(7) - 5 * 60e3)) });
  const soonUser = addUser('soon@example.com', { name: 'Soon Sam', trial_days: 5, trial_expires_at: sqlDate(new Date(now().getTime() + days(3) - 5 * 60e3)) });
  const finalUser = addUser('final@example.com', { name: 'Final Fay', trial_days: 7, trial_expires_at: sqlDate(new Date(now().getTime() + hours(20))) });
  const endedUser = addUser('ended@example.com', { name: 'Ended Ed', trial_days: 7, trial_expires_at: sqlDate(new Date(now().getTime() - hours(2))) });
  const endedProUser = addUser('endedpro@example.com', { name: 'Paid Pat', plan: 'pro', plan_expires_at: new Date(now().getTime() + days(30)).toISOString().slice(0, 10), subscription_status: 'active', trial_days: 7, trial_expires_at: sqlDate(new Date(now().getTime() - hours(2))) });
  const shortUser = addUser('short@example.com', { name: 'Short Sue', trial_days: 3, trial_expires_at: sqlDate(new Date(now().getTime() + days(2) - 5 * 60e3)) });
  const freshUser = addUser('fresh@example.com', { name: 'Fresh Fran', subscription_status: 'free', trial_days: null, trial_expires_at: null });
  check('fixtures created', [halfUser, soonUser, finalUser, endedUser, endedProUser, shortUser, freshUser].every(Boolean));

  /* Expired users still marked trialing — the sweep must flip them first. */
  db.prepare("UPDATE users SET subscription_status='trialing' WHERE id=?").run(endedUser.id);
  check('just-expired user still flagged trialing (pre-sweep)',
    db.prepare('SELECT subscription_status FROM users WHERE id=?').get(endedUser.id).subscription_status === 'trialing');

  writeOutbox();

  /* ------------------------------------------------------------- sweep #1 */
  section('First sweep');
  await reminders.sweep();

  section('Milestones fire once, through both channels');
  const mail = mailRows();
  /* Halfway — 14-day trial with 7 days left. */
  check('halfway user gets the half-time email',
    mail.some((m) => m.to === 'half@example.com' && m.subject === 'Halfway through your FirmLedger Pro trial'),
    JSON.stringify(mail));
  check('halfway user gets an in-app notification',
    inAppFor(halfUser.id).some((n) => /Halfway through your Pro trial — 7 days left/.test(n.title)),
    JSON.stringify(inAppFor(halfUser.id)));
  check('halfway milestone marked as sent once', JSON.stringify(sentMark(halfUser.id)) === '["half"]', sentMark(halfUser.id).join(','));

  /* A few days left — 5-day trial with 3 days left. */
  check('a-few-days user gets the “ends in 3 days” email',
    mail.some((m) => m.to === 'soon@example.com' && m.subject === 'Your FirmLedger Pro trial ends in 3 days'),
    JSON.stringify(mail));
  check('a-few-days user gets an in-app notification',
    inAppFor(soonUser.id).some((n) => /ends in 3 days/.test(n.title)),
    JSON.stringify(inAppFor(soonUser.id)));
  check('a-few-days milestone marked as sent once', JSON.stringify(sentMark(soonUser.id)) === '["3d"]', sentMark(soonUser.id).join(','));

  /* Final day. */
  check('final-day user gets the “Last day” email',
    mail.some((m) => m.to === 'final@example.com' && m.subject === 'Last day of your FirmLedger Pro trial'),
    JSON.stringify(mail));
  check('final-day user gets an in-app notification',
    inAppFor(finalUser.id).some((n) => /ends in a day/.test(n.title)),
    JSON.stringify(inAppFor(finalUser.id)));
  check('final-day milestone marked as sent once', JSON.stringify(sentMark(finalUser.id)) === '["1d"]', sentMark(finalUser.id).join(','));

  /* Just expired → flips back to free and gets the trial-ended notice. */
  const endedRow = db.prepare('SELECT subscription_status FROM users WHERE id=?').get(endedUser.id);
  check('just-expired trial flipped back to free before the notice', endedRow.subscription_status === 'free', endedRow.subscription_status);
  check('just-expired user gets the trial-ended email',
    mail.some((m) => m.to === 'ended@example.com' && m.subject === 'Your FirmLedger Pro trial has ended'),
    JSON.stringify(mail));
  check('just-expired user gets an in-app notification',
    inAppFor(endedUser.id).some((n) => /trial has ended/.test(n.title)),
    JSON.stringify(inAppFor(endedUser.id)));
  check('ended milestone marked as sent once', JSON.stringify(sentMark(endedUser.id)) === '["end"]', sentMark(endedUser.id).join(','));

  /* Expired trial while holding paid Pro → no “back on Free” nonsense. */
  check('paid-Pro user with an expired trial gets no ended notice',
    inAppCount(endedProUser.id) === 0
      && sentMark(endedProUser.id).length === 0
      && !mail.some((m) => m.to === 'endedpro@example.com'),
    JSON.stringify(mail));

  section('Thresholds respect trial length');
  /* A 3-day trial has no “3 days left” slot (that slot exists from day 5+). */
  check('short trial (3 days) receives no mid-trial reminder at 2 days left',
    inAppCount(shortUser.id) === 0 && sentMark(shortUser.id).length === 0);

  section('Fresh trials reset the ladder');
  await reminders.sweep(); // nothing should fire for the fresh (non-trial) account
  check('fresh non-trial account gets no reminders', inAppCount(freshUser.id) === 0);

  const r = plans.startTrial(freshUser.id, 14);
  check('startTrial reports a running trial', r.ok === true, (r && r.error) || '');
  db.prepare('UPDATE users SET trial_expires_at=? WHERE id=?').run(sqlDate(new Date(now().getTime() + hours(20))), freshUser.id);
  await reminders.sweep();
  check('new trial starts a clean reminder ladder (final-day fires)',
    inAppCount(freshUser.id) === 1
      && inAppFor(freshUser.id).some((n) => /ends in a day/.test(n.title))
      && sentMark(freshUser.id).includes('1d'),
    JSON.stringify({ titles: inAppFor(freshUser.id), marks: sentMark(freshUser.id) }));

  section('No double-sends on the next sweep');
  const before = [halfUser, soonUser, finalUser, endedUser, freshUser].reduce((o, u) => { o[u.id] = inAppCount(u.id); return o; }, {});
  writeOutbox();
  await reminders.sweep();
  const again = [halfUser, soonUser, finalUser, endedUser, freshUser].every((u) => inAppCount(u.id) === before[u.id]);
  check('second sweep sends no duplicate notifications', again);
  check('outbox unchanged on second sweep', mailRows().length === 0, JSON.stringify(mailRows()));

  /* ------------------------------------------------------------- summary */
  writeOutbox(); // leave the shared outbox as we found it
  console.log(`\n${'='.repeat(64)}`);
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  failures.forEach((f) => console.log('  • ' + f));
  console.log('='.repeat(64));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  try { writeOutbox(); } catch { /* ignore */ }
  process.exit(1);
});
