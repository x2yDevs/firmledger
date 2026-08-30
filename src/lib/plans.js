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
   owner account has an active Pro subscription. */
function perksActive(listing, now = new Date()) {
  if (isProListingActive(listing, now)) return true;
  if (!listing || !listing.owner_user_id) return false;
  const u = db.prepare('SELECT plan, plan_expires_at FROM users WHERE id=?').get(listing.owner_user_id);
  return active(u && u.plan, u && u.plan_expires_at, now);
}

/* SQL fragment (alias l/u) used where a JOIN users is possible. */
const PRO_USER_SQL = "(u.plan='pro' AND (u.plan_expires_at='' OR u.plan_expires_at IS NULL OR u.plan_expires_at >= date('now')))";
const PRO_LISTING_SQL = "(l.plan='pro' AND (l.plan_expires_at='' OR l.plan_expires_at IS NULL OR l.plan_expires_at >= date('now')))";

/* Grant a plan duration to a user, stacking on top of unexpired time. */
function grantUserPro(userId, durationDays) {
  const u = db.prepare('SELECT id, plan, plan_expires_at FROM users WHERE id = ?').get(userId);
  if (!u) return null;
  if (durationDays === null) {           // lifetime grant
    db.prepare("UPDATE users SET plan='pro', plan_expires_at='' WHERE id=?").run(u.id);
    return { user: u, expiry: null };
  }
  const now = new Date();
  const base = active(u.plan, u.plan_expires_at, now) && u.plan_expires_at
    ? new Date(Math.max(new Date(u.plan_expires_at).getTime(), now.getTime())) : now;
  const expiry = new Date(base.getTime() + Number(durationDays) * 24 * 3600 * 1000);
  db.prepare('UPDATE users SET plan=?, plan_expires_at=? WHERE id=?')
    .run('pro', expiry.toISOString().slice(0, 10), u.id);
  return { user: u, expiry };
}

function revokeUserPro(userId) {
  db.prepare("UPDATE users SET plan='free', plan_expires_at='' WHERE id=?").run(userId);
}

/* Viewing full detail scope — guests see basic profile; Pro members see all.
   Owners/admins always see their own listing's full story. */
function canViewFull({ user, admin, listing }) {
  if (admin) return true;
  if (user && listing && listing.owner_user_id === user.id) return true;
  return isProUser(user);
}

module.exports = {
  allPlans, getPlan, active,
  isProUser, isProListingActive, perksActive,
  PRO_USER_SQL, PRO_LISTING_SQL,
  grantUserPro, revokeUserPro, canViewFull,
};
