/* Free-trial emails.
 *
 * sendTrialInvite(user)    — sent right after an account is created (email
 *   OTP sign-up, Google or LinkedIn). Invites the member to activate their
 *   free Pro trial themselves on the /pricing page.
 * sendTrialActivated(user, {days, expiresAt}) — confirmation once the member
 *   (or an admin) switches the trial on. The trial is REAL Pro access.
 */
const { sendBranded } = require('./mailer');
const util = require('./util');
const { TRIAL_SIGNUP_DAYS } = require('./plans');

function esc(s) { return util.escHtml ? util.escHtml(String(s || '')) : String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

function sendTrialInvite(user) {
  if (!user || !user.email) return Promise.resolve();
  return sendBranded(user.email, `Your ${TRIAL_SIGNUP_DAYS}-day FirmLedger Pro trial is waiting`, {
    alias: 'billing',
    kicker: 'Free trial',
    title: `Welcome${user.name ? `, ${esc(user.name)}` : ''} — your free Pro trial is ready`,
    preheader: `Activate ${TRIAL_SIGNUP_DAYS} days of full FirmLedger Pro — no card, one click on the pricing page.`,
    alert: `Your account comes with a <b>${TRIAL_SIGNUP_DAYS}-day free trial of FirmLedger Pro</b> — full access, no payment details needed. You switch it on yourself whenever you're ready.`,
    alertTone: 'info',
    paragraphs: [
      `While the trial runs you get everything Pro includes: <b>every listing's full details</b> (websites, emails, phones, events timeline and relationship graph), the <b>blue verified tick</b>, eligibility for <b>Featured placement</b>, <b>Audience Analytics</b>, the <b>Leads inbox</b> and the <b>gold badge</b> on listings you own, plus full <b>developer API access</b> with keys, docs and the playground.`,
      `To start it, open the pricing page and press <b>“Start my free trial”</b>. The countdown only begins when you activate it.`,
    ],
    cta: { label: `Activate my ${TRIAL_SIGNUP_DAYS}-day free trial`, url: util.siteUrl('/pricing#free-trial') },
    note: `One trial per account. When it ends your account simply returns to Free — nothing is deleted and there is no charge. Questions? <a href="mailto:support@firmledger.co.ke" style="color:#1D4ED8;">support@firmledger.co.ke</a>`,
  });
}

function sendTrialActivated(user, { days, expiresAt }) {
  if (!user || !user.email) return Promise.resolve();
  const till = String(expiresAt || '').slice(0, 10);
  return sendBranded(user.email, `Your ${days}-day FirmLedger Pro trial is active`, {
    alias: 'billing',
    kicker: 'Free trial activated',
    title: 'FirmLedger Pro is live on your account',
    preheader: `Full Pro access until ${till} — enjoy!`,
    alert: `<b>Trial length:</b> ${days} days &nbsp;·&nbsp; <b>Full Pro access until:</b> ${till}`,
    alertTone: 'ok',
    paragraphs: [
      `Your free trial is on and it is the real thing: you can now view <b>every listing's full details</b>, your own listings carry the <b>blue tick</b>, eligibility for <b>Featured placement</b>, <b>Audience Analytics</b>, the <b>Leads inbox</b> and the <b>gold badge</b>, and the <b>developer API</b> area in your dashboard is unlocked.`,
      `When the trial ends on <b>${till}</b> your account returns to Free automatically — nothing is deleted and nothing is charged. Upgrade any time to keep Pro running.`,
    ],
    cta: { label: 'Open your dashboard', url: util.siteUrl('/dashboard') },
    note: `Want to keep Pro after the trial? See the offers at <a href="${util.siteUrl('/pricing')}" style="color:#1D4ED8;">/pricing</a>.`,
  });
}

function pluralDay(n) { return `${n} day${n === 1 ? '' : 's'}`; }

/**
 * One scheduled trial reminder. `slot` is the milestone that fired:
 *   'half' — roughly halfway through the trial (long trials only)
 *   '3d'   — a few days left (fires when 2–3 whole days remain)
 *   '1d'   — the final day
 * The subject and copy always use the REAL remaining days and expiry date, so
 * a reminder that lands a day late (sweep downtime) is still accurate.
 */
function sendTrialReminder(user, { slot, remaining }) {
  if (!user || !user.email || !(remaining > 0)) return Promise.resolve();
  const till = String(user.trial_expires_at || '').slice(0, 10);
  const who = user.name ? `, ${esc(user.name)}` : '';
  const days = pluralDay(remaining);
  let subject; let kicker; let title; let preheader; let alert; let paragraphs; let note;
  if (slot === 'half') {
    subject = 'Halfway through your FirmLedger Pro trial';
    kicker = 'Trial check-in';
    title = `You're halfway through${who}`;
    preheader = `${days} of FirmLedger Pro left on your free trial.`;
    alert = `<b>${days} of Pro remaining</b> &nbsp;·&nbsp; full access until <b>${till}</b>`;
    paragraphs = [
      `Your free trial is past its midpoint — <b>${remaining} ${remaining === 1 ? 'day' : 'days'}</b> of full FirmLedger Pro remain. You can keep viewing every listing's complete details, and any listings you own carry the verified tick, Featured eligibility, Analytics, Leads and the gold badge.`,
      `When the trial ends on <b>${till}</b> your account returns to the Free plan automatically — nothing is deleted, nothing is charged. If Pro is earning its keep, upgrade before then and nothing changes.`,
    ];
    note = `You are receiving this because your ${user.trial_days || ''}-day free trial is running. Questions? <a href="mailto:support@firmledger.co.ke" style="color:#1D4ED8;">support@firmledger.co.ke</a>`;
  } else if (slot === '1d') {
    subject = 'Last day of your FirmLedger Pro trial';
    kicker = 'Trial ending';
    title = `Your free trial ends in a day${who}`;
    preheader = `Today is the final stretch — Pro access until ${till}.`;
    alert = `<b>1 day left</b> &nbsp;·&nbsp; full Pro access ends <b>${till}</b>`;
    paragraphs = [
      `Your FirmLedger Pro trial ends <b>${till}</b> — under 24 hours of full access remain. After that your account returns to the Free plan: listings stay, nothing is deleted, no card is charged.`,
      `Keep the unlocked details, the verified tick, Featured eligibility, Analytics, Leads and the developer API by upgrading now — it takes about a minute.`,
    ];
    note = 'This is the final countdown email for your free trial. When it ends your account simply returns to Free.';
  } else {
    subject = `Your FirmLedger Pro trial ends in ${days}`;
    kicker = 'Trial ending soon';
    title = `${days} left on your free trial${who}`;
    preheader = `Your FirmLedger Pro trial ends on ${till} — a few days of full access remain.`;
    alert = `<b>${days} remaining</b> &nbsp;·&nbsp; full Pro access until <b>${till}</b>`;
    paragraphs = [
      `Your free trial of FirmLedger Pro is almost over — <b>${remaining} ${remaining === 1 ? 'day' : 'days'}</b> of full access remain, ending on <b>${till}</b>.`,
      `After the trial your account goes back to the Free plan automatically. To keep viewing every listing's full details — and keep the blue verified tick, Featured eligibility, Analytics, Leads and the gold badge on listings you own — upgrade to Pro before the countdown hits zero.`,
    ];
    note = `You are receiving this because your ${user.trial_days || ''}-day free trial is running out. No action needed if you're happy on Free.`;
  }
  return sendBranded(user.email, subject, {
    alias: 'billing',
    kicker,
    title,
    preheader,
    alert,
    alertTone: 'warn',
    paragraphs,
    cta: { label: 'Upgrade to FirmLedger Pro', url: util.siteUrl('/dashboard/upgrade') },
    note,
  });
}

/** Sent once the trial has genuinely ended and the account is back on Free. */
function sendTrialEnded(user) {
  if (!user || !user.email) return Promise.resolve();
  const ended = String(user.trial_expires_at || '').slice(0, 10) || 'recently';
  const who = user.name ? `, ${esc(user.name)}` : '';
  return sendBranded(user.email, 'Your FirmLedger Pro trial has ended', {
    alias: 'billing',
    kicker: 'Plan update',
    title: `Your free trial has ended${who}`,
    preheader: `Your FirmLedger Pro trial ended on ${ended} — the account is back on the Free plan.`,
    alert: `Your <b>${user.trial_days || ''}-day free trial ended on ${ended}</b> and your account is back on the <b>Free plan</b>.`,
    alertTone: 'info',
    paragraphs: [
      'Nothing was deleted and nothing was charged. Your account, your listings and their public data are all exactly where you left them — only the Pro extras (full listing details, verified tick, Featured eligibility, Analytics, Leads, gold badge, developer API) are paused.',
      'Upgrade to FirmLedger Pro any time to switch those extras back on for as long as you need them.',
    ],
    cta: { label: 'Upgrade to FirmLedger Pro', url: util.siteUrl('/dashboard/upgrade') },
    note: 'If you believe this is an error, reply to this email and our support team will take a look.',
  });
}

module.exports = { sendTrialInvite, sendTrialActivated, sendTrialReminder, sendTrialEnded };
