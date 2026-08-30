const express = require('express');
const { db } = require('../db');
const { requireUser } = require('../lib/session');
const { claimToken, domainOf, siteUrl } = require('../lib/util');
const { runCheck } = require('../lib/verify');
const { submitForIndexing } = require('../lib/indexing');
const { sendBranded } = require('../lib/mailer');
const { escHtml } = require('../lib/util');

const router = express.Router();

/* ---------------- Public claim hub (before auth guard) ---------------- */
router.get('/claim', (req, res) => {
  const unclaimed = db.prepare(
    "SELECT slug, name, tagline, type, category, last_verified_at FROM listings WHERE status='approved' AND claimed=0 ORDER BY confidence DESC, name LIMIT 12"
  ).all();
  res.render('claim/hub', {
    meta: {
      title: 'Claim your business profile — FirmLedger',
      description: 'Take control of your FirmLedger record in minutes. Cryptographic domain verification via DNS, meta tag, or badge.',
      canonical: siteUrl('/claim'),
    },
    unclaimed,
  });
});

router.use('/claim', requireUser);

/* ---------------- Start a claim ---------------- */
router.get('/claim/:slug', (req, res) => {
  const l = db.prepare("SELECT * FROM listings WHERE slug = ? AND status='approved'").get(req.params.slug);
  if (!l) {
    return res.status(404).render('error', {
      meta: { title: 'Not found — FirmLedger', description: '', robots: 'noindex' },
      code: 404, heading: 'Listing not found', message: 'We could not find that listing.',
    });
  }
  if (l.claimed) return res.redirect(`/listing/${l.slug}`);
  const pending = db.prepare(
    "SELECT * FROM claims WHERE listing_id = ? AND user_id = ? AND status='pending' ORDER BY id DESC LIMIT 1"
  ).get(l.id, req.user.id);
  if (pending) return res.redirect(`/claim/verify/${pending.id}`);

  res.render('claim/start', {
    meta: { title: `Claim ${l.name} — FirmLedger`, description: '', robots: 'noindex' },
    l, suggestedDomain: domainOf(l.website), errors: [],
  });
});

router.post('/claim/:slug', (req, res) => {
  const l = db.prepare("SELECT * FROM listings WHERE slug = ? AND status='approved'").get(req.params.slug);
  if (!l || l.claimed) return res.redirect('/directory');
  const method = ['dns', 'meta', 'badge'].includes(req.body.method) ? req.body.method : 'meta';
  const domain = (req.body.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  const errors = [];
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) errors.push('Enter a valid domain, e.g. yourcompany.co.ke');
  if (l.website && domainOf(l.website) && domain !== domainOf(l.website)) {
    errors.push(`For your protection, the verification domain must match the listing website (${domainOf(l.website)}).`);
  }
  if (errors.length) {
    return res.status(422).render('claim/start', {
      meta: { title: `Claim ${l.name} — FirmLedger`, description: '', robots: 'noindex' },
      l, suggestedDomain: domainOf(l.website), errors,
    });
  }

  const token = claimToken();
  const info = db.prepare(
    'INSERT INTO claims (listing_id, user_id, method, token, domain) VALUES (?,?,?,?,?)'
  ).run(l.id, req.user.id, method, token, domain);
  claimStartEmail(req.user, l, db.prepare('SELECT * FROM claims WHERE id=?').get(info.lastInsertRowid));
  res.redirect(`/claim/verify/${info.lastInsertRowid}`);
});

/* ---------------- Claim instructions + verification ---------------- */
function loadClaim(req, res) {
  const c = db.prepare('SELECT * FROM claims WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!c) {
    res.status(404).render('error', {
      meta: { title: 'Not found — FirmLedger', description: '', robots: 'noindex' },
      code: 404, heading: 'Claim not found', message: 'That verification request does not exist.',
    });
    return null;
  }
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(c.listing_id);
  return { c, l };
}

router.get('/claim/verify/:id', (req, res) => {
  const ctx = loadClaim(req, res);
  if (!ctx) return;
  res.render('claim/verify', {
    meta: { title: `Verify ${ctx.l.name} — FirmLedger`, description: '', robots: 'noindex' },
    ...ctx, result: null, badgeUrl: siteUrl(`/badge/${ctx.l.slug}.svg`), profileUrl: siteUrl(`/listing/${ctx.l.slug}`),
  });
});

router.post('/claim/verify/:id', async (req, res) => {
  const ctx = loadClaim(req, res);
  if (!ctx) return;
  const { c, l } = ctx;

  if (c.status === 'verified') return res.redirect('/dashboard');

  const result = await runCheck(c.method, c.domain, c.token);
  if (result.ok) {
    const now = new Date().toISOString();
    db.prepare("UPDATE claims SET status='verified', verified_at=? WHERE id=?").run(now, c.id);
    db.prepare(
      "UPDATE listings SET claimed=1, owner_user_id=?, last_verified_at=?, confidence=MIN(97, confidence + 13), updated_at=datetime('now') WHERE id=?"
    ).run(req.user.id, now, l.id);
    // expire any other pending claims on this listing
    db.prepare("UPDATE claims SET status='rejected' WHERE listing_id=? AND id<>? AND status='pending'").run(l.id, c.id);
    submitForIndexing([`/listing/${l.slug}`]);
    return res.redirect('/dashboard?ok=' + encodeURIComponent(`Ownership verified — ${l.name} is now yours to manage.`));
  }

  res.render('claim/verify', {
    meta: { title: `Verify ${l.name} — FirmLedger`, description: '', robots: 'noindex' },
    c, l, result, badgeUrl: siteUrl(`/badge/${l.slug}.svg`), profileUrl: siteUrl(`/listing/${l.slug}`),
  });
});

router.post('/claim/:id/cancel', (req, res) => {
  const ctx = loadClaim(req, res);
  if (!ctx) return;
  db.prepare("UPDATE claims SET status='rejected' WHERE id = ?").run(ctx.c.id);
  claimCancelEmail(req.user, ctx.l, ctx.c);
  res.redirect('/dashboard?ok=' + encodeURIComponent('Claim cancelled.'));
});



/* ---- Claim lifecycle emails: started / verified / cancelled ---- */
function esc(s) { return escHtml(String(s == null ? '' : s)); }

function claimStartEmail(user, l, c) {
  const verifyUrl = siteUrl(`/claim/verify/${c.id}`);
  const methodLabel = { dns: 'a DNS TXT record', meta: 'an HTML meta tag', badge: 'the FirmLedger website badge' }[c.method] || 'the verification method you chose';
  sendBranded(user.email, `Verify your claim — ${l.name}`, {
    kicker: 'Claim started',
    title: `Your claim on ${esc(l.name)} is underway`,
    preheader: 'Complete the verification to take control of the record.',
    text: `Your claim on ${l.name} is underway.\n\nWe opened verification for ${l.name} (${l.category}${l.country ? ' of ' + l.country : ''}). Complete it with ${methodLabel} using the code from your verify page, and the record becomes yours to manage: ${verifyUrl}\nIf you did not start this claim you can ignore this email — the listing stays exactly as it is.\nCancel the claim any time from the verification page.`,
    paragraphs: [
      `We opened a verification file for <b>${esc(l.name)}</b>${l.category ? ` (${esc(l.category)}${l.country ? ', ' + esc(l.country) : ''})` : ''} — claim reference <code>#${c.id}</code>.`,
      `Finish it with ${methodLabel} using the code on your verification page; the moment we detect it, the record is yours to manage and verified publicly.`,
      `Didn't start this claim? You can safely ignore this email — the listing stays exactly as it is. You can also cancel the claim at any time from the verification page.`,
    ],
    cta: { label: 'Continue verification', url: verifyUrl },
    note: 'Claims are verified cryptographically — no personal documents are collected.',
  }).catch(() => {});
}

function claimCancelEmail(user, l, c) {
  sendBranded(user.email, `Claim cancelled — ${l.name}`, {
    kicker: 'Claim cancelled',
    title: `Your claim on ${esc(l.name)} was cancelled`,
    preheader: 'The claim file is closed; the listing is unchanged.',
    text: `Your claim on ${l.name} was cancelled at your request.\nThe verification file (reference #${c.id}) is closed and the listing stays publicly available exactly as before.\nYou can start a fresh claim at any time: ${siteUrl(`/claim/${l.slug}`)}\nIf you did not cancel this claim, contact support@firmledger.co.ke immediately.`,
    paragraphs: [
      `Your claim on <b>${esc(l.name)}</b> (reference <code>#${c.id}</code>) is now closed at your request. The listing remains publicly available, unchanged.`,
      `Want to take control of the record after all? You can start a fresh claim at any time — verification via DNS, meta tag, or badge usually takes under five minutes.`,
    ],
    cta: { label: `View ${esc(l.name)}`, url: siteUrl(`/listing/${l.slug}`) },
    note: `If you did not cancel this claim, contact support@firmledger.co.ke immediately.`,
    alertTone: 'warn',
    alert: 'If you did not request this cancellation, your account may be compromised — sign in and change your password.',
  }).catch(() => {});
}


module.exports = router;