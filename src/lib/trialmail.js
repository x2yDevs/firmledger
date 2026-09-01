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
    kicker: 'Free trial',
    title: `Welcome${user.name ? `, ${esc(user.name)}` : ''} — your free Pro trial is ready`,
    preheader: `Activate ${TRIAL_SIGNUP_DAYS} days of full FirmLedger Pro — no card, one click on the pricing page.`,
    alert: `Your account comes with a <b>${TRIAL_SIGNUP_DAYS}-day free trial of FirmLedger Pro</b> — full access, no payment details needed. You switch it on yourself whenever you're ready.`,
    alertTone: 'info',
    paragraphs: [
      `While the trial runs you get everything Pro includes: <b>every listing's full details</b> (websites, emails, phones, events timeline and relationship graph), the <b>blue verified tick</b>, homepage <b>Featured placement</b> and the <b>gold badge</b> on listings you own, plus full <b>developer API access</b> with keys, docs and the playground.`,
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
    kicker: 'Free trial activated',
    title: 'FirmLedger Pro is live on your account',
    preheader: `Full Pro access until ${till} — enjoy!`,
    alert: `<b>Trial length:</b> ${days} days &nbsp;·&nbsp; <b>Full Pro access until:</b> ${till}`,
    alertTone: 'ok',
    paragraphs: [
      `Your free trial is on and it is the real thing: you can now view <b>every listing's full details</b>, your own listings carry the <b>blue tick</b>, homepage <b>Featured placement</b> and the <b>gold badge</b>, and the <b>developer API</b> area in your dashboard is unlocked.`,
      `When the trial ends on <b>${till}</b> your account returns to Free automatically — nothing is deleted and nothing is charged. Upgrade any time to keep Pro running.`,
    ],
    cta: { label: 'Open your dashboard', url: util.siteUrl('/dashboard') },
    note: `Want to keep Pro after the trial? See the offers at <a href="${util.siteUrl('/pricing')}" style="color:#1D4ED8;">/pricing</a>.`,
  });
}

module.exports = { sendTrialInvite, sendTrialActivated };
