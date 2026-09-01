/* FirmLedger plans — single source of truth for Free vs Pro gating.
 *
 * TWO scopes:
 *  1. Account Pro (users.plan): paid subscription bought via PayPal. A Pro
 *     member sees every listing's FULL details site-wide, and their OWN
 *     listings automatically carry the Pro perks: blue tick, homepage
 *     featured slot, premium gold badge, trust-boost flag.
 *  2. Listing Pro override (listings.plan): an admin boost granting the same
 *     perks to one listing without changing the account's subscription.
 *
 * Adding complete listing details is FREE for everyone. Pro gates VIEWING the
 * full details (for visitors) and the PERKS (for the listing). */

const { db } = require('../db');

/* ---------------- Plan offers (admin-managed) ---------------- */
function allPlans(activeOnly = false) {
  return db.prepare(
    `SELECT * FROM plans ${activeOnly ? 'WHERE active=1' : ''} ORDER BY sort ASC, price_cents ASC`
  ).all();
}
function getPlan(id) {
  return db.prepare('SELECT * FROM plans WHERE id=?').get(Number(id) || 0) || null;
}

/* ---------------- Pro checks ---------------- */
function active(plan, expires, now = new Date()) {
  if (plan !== 'pro') return false;
  if (expires && new Date(expires) < now) return false;
  return true;
}
function isProUser(user, now = new Date()) {
  return Boolean(user) && active(user.plan, user.plan_expires_at, now);
}
function isProListingActive(listing, now = new Date()) {
  return Boolean(listing) && active(listing.plan, listing.plan_expires_at, now);
}

/* Perks render on the listing when EITHER the listing boost is pro or the
   owner account has an active Pro subscription (paid or free trial). */
function perksActive(listing, now = new Date()) {
  if (isProListingActive(listing, now)) return true;
  if (!listing || !listing.owner_user_id) return false;
  const u = db.prepare('SELECT plan, plan_expires_at, trial_expires_at FROM users WHERE id=?').get(listing.owner_user_id);
  return active(u && u.plan, u && u.plan_expires_at, now) || trialActive(u, now);
}

/* SQL fragment (alias l/u) used where a JOIN users is possible.
   An active free trial counts exactly like a paid Pro subscription. */
const PRO_USER_SQL = "((u.plan='pro' AND (u.plan_expires_at='' OR u.plan_expires_at IS NULL OR u.plan_expires_at >= date('now'))) OR (u.trial_expires_at IS NOT NULL AND u.trial_expires_at > datetime('now')))";
const PRO_LISTING_SQL = "(l.plan='pro' AND (l.plan_expires_at='' OR l.plan_expires_at IS NULL OR l.plan_expires_at >= date('now')))";

/* Grant a plan duration to a user, stacking on top of unexpired time. */
function grantUserPro(userId, durationDays) {
  const u = db.prepare('SELECT id, plan, plan_expires_at FROM users WHERE id = ?').get(userId);
  if (!u) return null;
  if (durationDays === null) {           // lifetime grant
    db.prepare("UPDATE users SET plan='pro', plan_expires_at='', subscription_status='active' WHERE id=?").run(u.id);
    return { user: u, expiry: null };
  }
  const now = new Date();
  const base = active(u.plan, u.plan_expires_at, now) && u.plan_expires_at
    ? new Date(Math.max(new Date(u.plan_expires_at).getTime(), now.getTime())) : now;
  const expiry = new Date(base.getTime() + Number(durationDays) * 24 * 3600 * 1000);
  db.prepare("UPDATE users SET plan=?, plan_expires_at=?, subscription_status='active' WHERE id=?")
    .run('pro', expiry.toISOString().slice(0, 10), u.id);
  return { user: u, expiry };
}

function revokeUserPro(userId) {
  db.prepare("UPDATE users SET plan='free', plan_expires_at='' WHERE id=?").run(userId);
  db.prepare("UPDATE users SET subscription_status='free' WHERE id=? AND (subscription_status IS NULL OR subscription_status<>'trialing')").run(userId);
}

/* ============================================================================
 * Free trials — REAL Pro access, time-boxed.
 *
 * Two triggers:
 *   A) self-serve — every new account (email, Google or LinkedIn sign-up) is
 *      invited by email to activate its own free trial on /pricing;
 *   B) manual — Admin → Pricing grants 1–90 days to any email address.
 *
 * While trial_expires_at is in the future the account has FULL Pro access:
 * hasProAccess() is true, canViewFull() opens every listing, PRO_USER_SQL
 * matches (tick / Featured / gold badge on owned listings) and the developer
 * API accepts the account's keys. Nothing about it is a demo.
 *
 * Columns (migrations/2026-09-01-user-trials.sql):
 *   trial_started_at, trial_expires_at, trial_days, subscription_status
 * subscription_status: 'trialing' while the trial runs, then 'active' if the
 * account still holds paid Pro, otherwise 'free'.
 * ==========================================================================*/
const TRIAL_SIGNUP_DAYS = 14;       // self-serve trial for new accounts (activated on /pricing)
const TRIAL_DEFAULT_DAYS = 14;      // default in the admin grant form
const TRIAL_MAX_DAYS = 90;

/** SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) → Date. */
function parseSqlDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const d = new Date(/[T ]/.test(s) && !/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function trialActive(user, now = new Date()) {
  if (!user || !user.trial_expires_at) return false;
  const exp = parseSqlDate(user.trial_expires_at);
  return Boolean(exp) && exp.getTime() > now.getTime();
}

/** Whole days left on the trial (0 when it ends today). */
function trialDaysRemaining(user, now = new Date()) {
  if (!trialActive(user, now)) return 0;
  const exp = parseSqlDate(user.trial_expires_at);
  return Math.max(0, Math.ceil((exp.getTime() - now.getTime()) / 864e5));
}

/**
 * REAL Pro access — paid subscription OR a running free trial.
 * This is the single gate every Pro feature checks.
 */
function hasProAccess(user, now = new Date()) {
  return isProUser(user, now) || trialActive(user, now);
}

/**
 * Can this account still activate the self-serve free trial?
 * One trial per account, and paid Pro members don't need one.
 */
function trialEligible(user, now = new Date()) {
  if (!user) return false;
  if (user.trial_started_at || user.trial_expires_at) return false; // already used (or running)
  return !isProUser(user, now);
}

/**
 * Open a trial on an account.
 * @param {number} userId
 * @param {number} days 1–90
 * @param {{onlyIfNone?: boolean}} opts  skip when a trial is already running
 */
function startTrial(userId, days = TRIAL_DEFAULT_DAYS, opts = {}) {
  const u = db.prepare('SELECT id, trial_expires_at FROM users WHERE id=?').get(userId);
  if (!u) return { ok: false, error: 'No account with that id.' };
  const d = Math.round(Number(days));
  if (!(d >= 1) || d > TRIAL_MAX_DAYS) {
    return { ok: false, error: `Trial length must be between 1 and ${TRIAL_MAX_DAYS} days.` };
  }
  if (opts.onlyIfNone && trialActive(u)) return { ok: false, error: 'A trial is already running.' };
  db.prepare(
    `UPDATE users
        SET trial_started_at = datetime('now'),
            trial_expires_at = datetime('now', '+' || ? || ' days'),
            trial_days = ?,
            subscription_status = 'trialing'
      WHERE id = ?`
  ).run(d, d, u.id);
  const row = db.prepare('SELECT trial_expires_at FROM users WHERE id=?').get(u.id);
  return { ok: true, days: d, expiresAt: row ? row.trial_expires_at : '' };
}

/** Clear a trial. subscription_status falls back to paid 'active' or 'free'. */
function revokeTrial(userId) {
  const u = db.prepare('SELECT id, plan, plan_expires_at FROM users WHERE id=?').get(userId);
  if (!u) return { ok: false, error: 'No account with that id.' };
  db.prepare(
    `UPDATE users
        SET trial_started_at = NULL, trial_expires_at = NULL, trial_days = NULL,
            subscription_status = ?
      WHERE id = ?`
  ).run(isProUser(u) ? 'active' : 'free', u.id);
  return { ok: true };
}

/** Effective status shown in the console: 'trialing' | 'active' | 'free'. */
function statusOf(user, now = new Date()) {
  if (trialActive(user, now)) return 'trialing';
  if (isProUser(user, now)) return 'active';
  return 'free';
}

/**
 * Flip every finished trial back to 'active' (still paying) or 'free'.
 * Runs hourly from server.js and on each request through trialMiddleware.
 */
function expireTrials() {
  const rows = db.prepare(
    "SELECT id, plan, plan_expires_at FROM users WHERE subscription_status='trialing' AND trial_expires_at IS NOT NULL AND trial_expires_at <= datetime('now')"
  ).all();
  const upd = db.prepare('UPDATE users SET subscription_status=? WHERE id=?');
  for (const u of rows) upd.run(isProUser(u) ? 'active' : 'free', u.id);
  return rows.length;
}

/**
 * Per-request trial state. Mount after session.attach:
 *   app.use(require('./src/lib/plans').trialMiddleware);
 * Sets res.locals.isTrialUser, res.locals.trialDaysRemaining,
 * res.locals.trialExpiresAt and res.locals.subscriptionStatus.
 */
function trialMiddleware(req, res, next) {
  res.locals.isTrialUser = false;
  res.locals.trialDaysRemaining = 0;
  res.locals.trialExpiresAt = '';
  res.locals.subscriptionStatus = 'free';
  res.locals.hasProAccess = false;
  const u = req.user;
  if (!u) return next();
  try {
    if (u.subscription_status === 'trialing' && !trialActive(u)) {
      /* Trial just ran out — revert immediately so the very next render is honest. */
      const status = isProUser(u) ? 'active' : 'free';
      db.prepare('UPDATE users SET subscription_status=? WHERE id=?').run(status, u.id);
      u.subscription_status = status;
    }
    const isTrial = trialActive(u);
    res.locals.isTrialUser = isTrial;
    res.locals.trialDaysRemaining = isTrial ? trialDaysRemaining(u) : 0;
    res.locals.trialExpiresAt = isTrial ? u.trial_expires_at : '';
    res.locals.subscriptionStatus = statusOf(u);
    res.locals.hasProAccess = hasProAccess(u);
    req.isTrialUser = isTrial;
  } catch { /* never block a request on trial bookkeeping */ }
  next();
}

/* Viewing full detail scope — guests see basic profile; Pro members (paid or
   on a free trial) see all. Owners/admins always see their own listing's full
   story. */
function canViewFull({ user, admin, listing }) {
  if (admin) return true;
  if (user && listing && listing.owner_user_id === user.id) return true;
  return hasProAccess(user);
}

module.exports = {
  allPlans, getPlan, active,
  isProUser, isProListingActive, perksActive, hasProAccess,
  PRO_USER_SQL, PRO_LISTING_SQL,
  grantUserPro, revokeUserPro, canViewFull,
  /* trials */
  TRIAL_SIGNUP_DAYS, TRIAL_DEFAULT_DAYS, TRIAL_MAX_DAYS,
  startTrial, revokeTrial, trialActive, trialDaysRemaining, trialEligible,
  statusOf, expireTrials, trialMiddleware,
};
