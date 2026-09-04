/**
 * FirmLedger advertising — Sponsored Content.
 *
 * Users buy a spot (an ad_package) for one of their OWN approved listings.
 * On payment confirmation the listing is flagged `sponsored` until the package
 * duration lapses, and it surfaces on the homepage Sponsored Content strip
 * with a clear "Sponsored" label. Admin can grant / revoke sponsorship on any
 * listing directly, and manages the packages themselves (Admin → Advertising).
 *
 * Spot advertising and account Pro are deliberately separate: Pro unlocks
 * viewing + perks; advertising buys a home page slot.
 */
const { db } = require('../db');
const listingEvents = require('./listingevents');

/* ---------------- Packages ---------------- */
function allPackages(activeOnly = false) {
  return db.prepare(
    `SELECT * FROM ad_packages ${activeOnly ? 'WHERE active=1' : ''} ORDER BY sort ASC, price_cents ASC`
  ).all();
}
function getPackage(id) {
  return db.prepare('SELECT * FROM ad_packages WHERE id=?').get(Number(id) || 0) || null;
}
function createPackage({ name, blurb, priceCents, currency, durationDays, sort }) {
  return db.prepare(
    'INSERT INTO ad_packages (name, blurb, price_cents, currency, duration_days, active, sort) VALUES (?,?,?,?,?,1,?)'
  ).run(
    String(name || '').trim().slice(0, 60),
    String(blurb || '').trim().slice(0, 240),
    Math.round(Number(priceCents) || 0),
    String(currency || 'USD').slice(0, 8).toUpperCase(),
    Math.round(Number(durationDays) || 0),
    Math.round(Number(sort) || 0) || (allPackages(false).length + 1),
  );
}
function updatePackage(id, fields) {
  const p = getPackage(id);
  if (!p) return null;
  const next = {
    name: fields.name !== undefined ? String(fields.name).trim().slice(0, 60) : p.name,
    blurb: fields.blurb !== undefined ? String(fields.blurb).trim().slice(0, 240) : p.blurb,
    price_cents: fields.price_cents !== undefined ? Math.round(Number(fields.price_cents) || 0) : p.price_cents,
    currency: fields.currency !== undefined ? String(fields.currency).slice(0, 8).toUpperCase() : p.currency,
    duration_days: fields.duration_days !== undefined ? Math.round(Number(fields.duration_days) || 0) : p.duration_days,
    sort: fields.sort !== undefined ? Math.round(Number(fields.sort) || 0) : p.sort,
  };
  db.prepare(
    `UPDATE ad_packages SET name=?, blurb=?, price_cents=?, currency=?, duration_days=?, sort=? WHERE id=?`
  ).run(next.name, next.blurb, next.price_cents, next.currency, next.duration_days, next.sort, id);
  return getPackage(id);
}
function togglePackage(id) {
  const p = getPackage(id);
  if (!p) return null;
  db.prepare('UPDATE ad_packages SET active=? WHERE id=?').run(p.active ? 0 : 1, p.id);
  return getPackage(id);
}
function deletePackage(id) {
  db.prepare('DELETE FROM ad_packages WHERE id=?').run(Number(id) || 0);
}

/* ---------------- Sponsored listings ---------------- */
function isSponsored(listing) {
  return Boolean(listing && listing.sponsored) && !(listing.sponsored_expires_at && listing.sponsored_expires_at < new Date().toISOString().slice(0, 10));
}

/** SQLite UTC date N days from today. */
function plusDays(days, from = new Date()) {
  return new Date(from.getTime() + Number(days) * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Grant a sponsorship (days or lifetime). Stacks on any unexpired time. */
function grantSponsorship(listingId, days, ref = 'admin') {
  const l = db.prepare('SELECT id, name, sponsored, sponsored_expires_at FROM listings WHERE id=?').get(Number(listingId) || 0);
  if (!l) return { ok: false, error: 'Listing not found.' };
  const today = new Date().toISOString().slice(0, 10);
  let until = '';
  if (days === null || days === undefined) {
    until = ''; // lifetime
  } else {
    const base = l.sponsored && l.sponsored_expires_at && l.sponsored_expires_at >= today
      ? new Date(l.sponsored_expires_at) : new Date();
    until = plusDays(Math.max(1, Math.round(Number(days) || 1)), base);
  }
  db.prepare('UPDATE listings SET sponsored=1, sponsored_expires_at=?, ad_reference=? WHERE id=?')
    .run(until, String(ref || 'admin').slice(0, 120), l.id);
  listingEvents.updated(db.prepare('SELECT * FROM listings WHERE id=?').get(l.id), { change: 'sponsorship' });
  return { ok: true, listing: l.name, until: until || 'lifetime' };
}

/** Remove the sponsored flag. */
function revokeSponsorship(listingId) {
  const l = db.prepare('SELECT id, name FROM listings WHERE id=?').get(Number(listingId) || 0);
  if (!l) return { ok: false, error: 'Listing not found.' };
  db.prepare("UPDATE listings SET sponsored=0, sponsored_expires_at='' WHERE id=?").run(l.id);
  listingEvents.updated(db.prepare('SELECT * FROM listings WHERE id=?').get(l.id), { change: 'sponsorship' });
  return { ok: true, listing: l.name };
}

/**
 * Homepage Sponsored Content strip — every active placement, newest first.
 * `limit` is optional: pass a positive number to cap the result (SQLite's
 * `LIMIT -1` means "no limit"). The homepage marquee scrolls the whole strip,
 * so it asks for all of them rather than the first four.
 */
function sponsoredStrip(limit = 0) {
  const today = new Date().toISOString().slice(0, 10);
  const cap = Number(limit) > 0 ? Math.floor(Number(limit)) : -1;
  return db.prepare(
    `SELECT l.*, u.plan AS owner_plan, u.plan_expires_at AS owner_plan_expires
       FROM listings l
       LEFT JOIN users u ON u.id = l.owner_user_id
      WHERE l.status='approved' AND l.sponsored=1
        AND (l.sponsored_expires_at='' OR l.sponsored_expires_at >= ?)
      ORDER BY l.updated_at DESC LIMIT ?`
  ).all(today, cap);
}

/** Current sponsored listings (admin console + sanity). */
function allSponsored() {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare(
    `SELECT l.id, l.name, l.slug, l.sponsored, l.sponsored_expires_at, l.ad_reference
       FROM listings l
      WHERE l.status='approved' AND l.sponsored=1
        AND (l.sponsored_expires_at='' OR l.sponsored_expires_at >= ?)
      ORDER BY l.updated_at DESC`
  ).all(today);
}

module.exports = {
  allPackages, getPackage, createPackage, updatePackage, togglePackage, deletePackage,
  isSponsored, grantSponsorship, revokeSponsorship, sponsoredStrip, allSponsored, plusDays,
};
