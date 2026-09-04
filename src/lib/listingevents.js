/**
 * One small event boundary for every listing write path (dashboard, REST, admin
 * and AI). Keeping status transitions here prevents one moderation surface from
 * silently skipping a webhook event.
 */
const { db } = require('../db');
const webhooks = require('./webhooks');

function fresh(id) {
  return db.prepare('SELECT * FROM listings WHERE id=?').get(Number(id));
}

function approved(row, firstApproval = true) {
  if (!row) return;
  webhooks.dispatch('listing.approved', { listing: row, targetUserId: row.owner_user_id });
  if (firstApproval) webhooks.dispatch('listing.created', { listing: row });
}

function rejected(row) {
  if (!row) return;
  webhooks.dispatch('listing.rejected', { listing: row, targetUserId: row.owner_user_id });
}

function updated(row, extra = {}) {
  if (!row) return;
  webhooks.dispatch('listing.updated', { listing: row, targetUserId: row.owner_user_id, data: extra });
}

function deleted(row) {
  if (!row) return;
  webhooks.dispatch('listing.deleted', {
    targetUserId: row.owner_user_id,
    data: { listing: { id: row.id, slug: row.slug, name: row.name, category: row.category, status: row.status } },
  });
}

function transition(before, after) {
  if (!after) return;
  if (before && before.status !== 'approved' && after.status === 'approved') approved(after, true);
  if (before && before.status !== 'rejected' && after.status === 'rejected') rejected(after);
  updated(after, { previous_status: before ? before.status : null });
}

module.exports = { fresh, approved, rejected, updated, deleted, transition };
