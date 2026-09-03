/**
 * Shared claim-finalization: ownership moves to the verified claimant,
 * listing-scoped Pro stays on the listing, account Pro never travels,
 * original submitter loses dashboard access, both parties are emailed.
 */
const { db } = require('../db');
const { sendBranded } = require('./mailer');
const { siteUrl, escHtml } = require('./util');
const notify = require('./notify');
const { submitForIndexing } = require('./indexing');
const googleIndexing = require('./googleIndexing');
const { isProListingActive } = require('./plans');

function finalizeVerifiedClaim(c, l, newUser) {
  const prevOwnerId = l.owner_user_id;
  const now = new Date().toISOString();
  db.prepare("UPDATE claims SET status='verified', verified_at=? WHERE id=?").run(now, c.id);
  // Listing-scoped Pro (listings.plan) is not touched — it travels with the record.
  db.prepare(
    "UPDATE listings SET claimed=1, owner_user_id=?, last_verified_at=?, confidence=MIN(97, confidence + 13), updated_at=datetime('now') WHERE id=?"
  ).run(newUser.id, now, l.id);
  db.prepare("UPDATE claims SET status='rejected' WHERE listing_id=? AND id<>? AND status='pending'").run(l.id, c.id);
  if (l.slug) {
    submitForIndexing([`/listing/${l.slug}`]);
    // Ownership just became verified — nudge Google to re-crawl the live record.
    googleIndexing.pingGoogleNewListingBackground(siteUrl(`/listing/${l.slug}`));
  }

  const listingPro = isProListingActive(l);
  const prev = prevOwnerId && prevOwnerId !== newUser.id
    ? db.prepare('SELECT id, name, email FROM users WHERE id=?').get(prevOwnerId)
    : null;

  sendBranded(newUser.email, `Ownership verified — ${l.name}`, {
    kicker: 'Claim verified',
    title: `You now manage ${escHtml(l.name)}`,
    preheader: `Ownership of ${l.name} on FirmLedger has been verified.`,
    alert: `Your ownership of <b>${escHtml(l.name)}</b> is now verified. The listing carries the claimed mark, and you control its record from your dashboard.`,
    alertTone: 'ok',
    paragraphs: [
      listingPro
        ? 'This listing carries remaining Listing-scoped Pro time — it travels with the record, so the perks stay on while you are responsible for it.'
        : 'From your dashboard you can update contact details, add events and enrich the company profile.',
    ],
    cta: { label: 'Manage your listing', url: siteUrl(`/dashboard/listings/${l.id}/edit`) },
    note: 'Keep your verification token in place — removing it may trigger a re-verification check.',
  }).catch(() => {});
  notify.notifyUser(newUser.id, {
    kind: 'claim',
    title: `You now own ${l.name}`,
    body: 'Ownership is verified. You can edit the listing from your dashboard.',
    url: `/dashboard/listings/${l.id}/edit`,
  });

  if (prev) {
    sendBranded(prev.email, `A verified owner claimed ${l.name}`, {
      kicker: 'Listing claimed',
      title: `${escHtml(l.name)} now has a verified owner`,
      preheader: `Someone proved domain control and now manages ${l.name} on FirmLedger.`,
      alert: `A verified owner claimed <b>${escHtml(l.name)}</b>. You no longer have dashboard access to that record — editorial control moved with the claim.`,
      alertTone: 'info',
      paragraphs: [
        listingPro
          ? 'Listing-scoped Pro time stays on the listing (the new owner is now responsible for it). Account-scoped Pro on your user never travels. If you paid specifically for this listing, you can ask admin to transfer the remaining Pro time onto another listing you still own — from your dashboard.'
          : 'The public profile is unchanged. If anything looks wrong you can file a removal request from the listing page.',
      ],
      cta: { label: `View ${escHtml(l.name)}`, url: siteUrl(`/listing/${l.slug}`) },
      note: 'Questions? Write to support@firmledger.co.ke quoting the listing name.',
    }).catch(() => {});
    notify.notifyUser(prev.id, {
      kind: 'claim',
      title: `${l.name} was claimed`,
      body: listingPro
        ? 'You lost dashboard access. Listing-scoped Pro stayed with the record — you can request a transfer to another of your listings.'
        : 'You no longer have dashboard access to this listing. A verified owner now manages it.',
      url: `/listing/${l.slug}`,
    });
  }

  notify.notifyAdmin({
    kind: 'claim',
    title: `${l.name} claimed`,
    body: `${newUser.email} verified ownership${prev ? ` (previous submitter ${prev.email})` : ''}.`,
    url: '/admin3119Musa/claims',
  });

  return { prev, listingPro };
}

module.exports = { finalizeVerifiedClaim };
