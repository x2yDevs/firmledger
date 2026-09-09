/* Free-trial reminder ladder — one sweep, three jobs.
 *
 * Runs hourly from server.js (same tick that expires finished trials):
 *
 *  1. expire   — every finished trial keeps an honest subscription_status
 *                (delegated to plans.expireTrials()).
 *  2. ended    — the moment a trial really ends (within the last ~26h) the
 *                member gets the "trial over, account back on Free" email AND
 *                an in-app notification — unless they now hold paid Pro.
 *  3. countdown— while a trial is still running, reminders fire as it winds
 *                down: roughly halfway through (long trials), then when a few
 *                days remain, then on the final day. Every milestone is an
 *                email + in-app notification, and each is sent exactly once
 *                per trial (tracked in users.trial_reminders_sent).
 *
 * Milestones are stored as stable keys ("half" | "3d" | "1d" | "end") so a
 * restart or a missed hour can never cause a double-send, and copy always uses
 * the real remaining days + expiry date so late sweeps stay accurate.
 */
const { db } = require('../db');
const plans = require('./plans');
const notify = require('./notify');
const trialmail = require('./trialmail');

/* Only users whose trial ended inside this window get the “ended” notice — a
   trial that ran out weeks ago (before this feature existed) is not re-mailed
   retroactively. */
const END_LOOKBACK_HOURS = 26;

/** Reminder slots for a trial of `days` days, ordered most-urgent last.
    A slot fires when `remaining` whole days fall inside its [min, max] window,
    so an hourly sweep that misses a boundary still lands the next slot. */
function slotsFor(days) {
  const d = Math.round(Number(days)) || plans.TRIAL_DEFAULT_DAYS;
  const half = Math.ceil(d / 2);
  const slots = [];
  if (d >= 10 && half >= 5) slots.push({ key: 'half', min: half - 1, max: half });
  if (d >= 5) slots.push({ key: '3d', min: 2, max: 3 });
  if (d >= 2) slots.push({ key: '1d', min: 1, max: 1 });
  return slots;
}

function sentKeys(user) {
  if (!user || !user.trial_reminders_sent) return new Set();
  try {
    const arr = JSON.parse(user.trial_reminders_sent);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

function markSent(userId, keys) {
  const merged = [...new Set(keys.map(String))];
  db.prepare("UPDATE users SET trial_reminders_sent = ? WHERE id = ?")
    .run(JSON.stringify(merged), userId);
  return merged;
}

const USER_COLS = 'id, email, name, plan, plan_expires_at, subscription_status, trial_days, trial_expires_at, trial_reminders_sent';

function inApp(user, title, body) {
  try {
    notify.notifyUser(user.id, {
      kind: 'billing',
      title: String(title).slice(0, 200),
      body: String(body || '').slice(0, 2000),
      url: '/dashboard/upgrade',
    });
  } catch (e) {
    console.error('[trial-reminders] in-app notification failed:', e && e.message);
  }
}

/** Send the single “trial ended” notice for trials that just finished. */
function sendEndedNotices() {
  const rows = db.prepare(
    `SELECT ${USER_COLS} FROM users
      WHERE trial_expires_at IS NOT NULL AND trial_expires_at <> ''
        AND trial_expires_at <= datetime('now')
        AND trial_expires_at >= datetime('now', ?)
        AND NOT (plan='pro' AND (plan_expires_at IS NULL OR plan_expires_at='' OR plan_expires_at >= date('now')))`
  ).all(`-${END_LOOKBACK_HOURS} hours`);
  let n = 0;
  for (const u of rows) {
    const sent = sentKeys(u);
    if (sent.has('end')) continue;
    markSent(u.id, [...sent, 'end']);
    trialmail.sendTrialEnded(u).catch((e) => console.error('[trial-reminders] ended email failed:', e && e.message));
    inApp(u,
      'Your FirmLedger Pro trial has ended',
      `Your free trial ended ${String(u.trial_expires_at || '').slice(0, 10)} and the account is back on the Free plan — nothing was deleted. Upgrade any time to keep Pro.`);
    n += 1;
  }
  return n;
}

/** Send the countdown reminders for trials that are still running. */
function sendCountdownReminders() {
  const rows = db.prepare(
    `SELECT ${USER_COLS} FROM users
      WHERE subscription_status = 'trialing'
        AND trial_expires_at IS NOT NULL AND trial_expires_at <> ''
        AND trial_expires_at > datetime('now')`
  ).all();
  let n = 0;
  for (const u of rows) {
    const remaining = plans.trialDaysRemaining(u);
    if (remaining < 1) continue;
    const sent = sentKeys(u);
    const slots = slotsFor(u.trial_days);
    for (const slot of slots) {
      if (sent.has(slot.key)) continue;
      if (remaining < slot.min || remaining > slot.max) continue;
      markSent(u.id, [...sent, slot.key]);
      trialmail.sendTrialReminder(u, { slot: slot.key, remaining }).catch((e) => console.error('[trial-reminders] reminder email failed:', e && e.message));
      if (slot.key === 'half') {
        inApp(u, `Halfway through your Pro trial — ${remaining} day${remaining === 1 ? '' : 's'} left`,
          `${remaining} day${remaining === 1 ? '' : 's'} of full Pro access remain (until ${String(u.trial_expires_at || '').slice(0, 10)}). Upgrade before then to keep Pro running.`);
      } else if (slot.key === '1d') {
        inApp(u, 'Your Pro trial ends in a day',
          `Full access runs until ${String(u.trial_expires_at || '').slice(0, 10)}. Upgrade now to keep Pro — nothing is charged until you do.`);
      } else {
        inApp(u, `Your Pro trial ends in ${remaining} day${remaining === 1 ? '' : 's'}`,
          `${remaining} day${remaining === 1 ? '' : 's'} left (until ${String(u.trial_expires_at || '').slice(0, 10)}) — upgrade before the trial ends to keep full access.`);
      }
      n += 1;
      break; // one reminder per user per sweep; the next milestone waits its turn
    }
  }
  return n;
}

/**
 * Run the whole ladder. Safe to call hourly — every reminder is idempotent per
 * milestone. Email sends are fire-and-forget (caught), so SMTP slowness never
 * blocks the sweep; counts are returned for logs/tests.
 */
async function sweep() {
  try {
    plans.expireTrials(); // finished trials flip back to 'active' / 'free' first
  } catch (e) {
    console.error('[trial-reminders] expire failed:', e && e.message);
  }
  let ended = 0;
  let reminders = 0;
  try { ended = sendEndedNotices(); } catch (e) { console.error('[trial-reminders] ended sweep failed:', e && e.message); }
  try { reminders = sendCountdownReminders(); } catch (e) { console.error('[trial-reminders] countdown sweep failed:', e && e.message); }
  if (ended || reminders) console.log(`[trial-reminders] ended notices: ${ended}, countdown reminders: ${reminders}`);
  return { ended, reminders, expired: 0 };
}

module.exports = { sweep, slotsFor, sentKeys, markSent, sendEndedNotices, sendCountdownReminders, END_LOOKBACK_HOURS };
