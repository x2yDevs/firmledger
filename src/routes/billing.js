const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { requireUser, validCsrf } = require('../lib/session');
const paypal = require('../lib/paypal');
const { allPlans, getPlan, isProUser, grantUserPro } = require('../lib/plans');
const util = require('../lib/util');
const { sendMail, sendBranded } = require('../lib/mailer');
const promos = require('../lib/promos');

const router = express.Router();

/* ---------------- Upgrade page — pick an offer, pay with PayPal ---------------- */
router.get('/dashboard/upgrade', requireUser, (req, res) => {
  const offers = allPlans(true);
  const payments = db.prepare(
    `SELECT p.*, pl.name AS plan_name FROM payments p
     LEFT JOIN plans pl ON pl.id = p.plan_id
     WHERE p.user_id = ? ORDER BY p.created_at DESC LIMIT 12`
  ).all(req.user.id);
  const promoCode = promos.normalize(req.query.promo || '');
  const priced = offers.map((p) => {
    const applied = promoCode ? promos.preview(promoCode, p) : null;
    if (applied && applied.ok) {
      return { ...p, pay_cents: applied.amount, discount_cents: applied.discount, promo_ok: true, promo_pct: applied.percent };
    }
    return { ...p, pay_cents: p.price_cents, discount_cents: 0, promo_ok: false, promo_pct: 0 };
  });
  const promoPreview = promoCode ? promos.preview(promoCode, offers[0] || { price_cents: 0, id: 0 }) : null;
  res.render('dashboard/upgrade', {
    meta: { title: 'Upgrade to FirmLedger Pro', description: '', robots: 'noindex' },
    offers: priced,
    payments,
    isPro: isProUser(req.user),
    planExpires: req.user.plan_expires_at || '',
    paypalReady: paypal.configured(),
    paypalMode: paypal.mode(),
    err: req.query.err || '',
    okmsg: req.query.okmsg || '',
    promoCode,
    promoPreview,
  });
});

// Backwards-compat: old per-listing upgrade URLs point at the account page.
router.get('/dashboard/listings/:id/upgrade', requireUser, (req, res) => {
  res.redirect('/dashboard/upgrade');
});

/* ---------------- Start checkout — create a PayPal order ---------------- */
router.post('/dashboard/upgrade', requireUser, async (req, res) => {
  const back = (m) => res.redirect('/dashboard/upgrade?err=' + encodeURIComponent(m));
  if (!validCsrf(req)) return res.status(403).redirect('/dashboard/upgrade');
  if (!paypal.configured()) return back('Online payments are not configured on this installation yet — please contact support.');

  const plan = getPlan(req.body.plan_id);
  if (!plan || !plan.active) return back('That plan offer is no longer available — pick one of the current offers.');

  let amount = plan.price_cents;
  let discount = 0;
  let promoId = 0;
  const promoIn = String(req.body.promo || '').trim();
  if (promoIn) {
    const applied = promos.usableBy(req.user.id, promoIn, plan);
    if (!applied.ok) return back(applied.error);
    amount = applied.amount;
    discount = applied.discount;
    promoId = applied.promo.id;
  }

  const reference = `FLPRO-${req.user.id}-${plan.id}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  // Account-scoped payments carry no listing — listing_id stays NULL so the
  // FK to listings is satisfied. Any DB problem here is caught and reported
  // instead of crashing the server before PayPal is even touched.
  try {
    db.prepare(
      'INSERT INTO payments (listing_id, user_id, plan_id, duration_days, reference, amount, currency, status, email, promo_id, discount_cents) VALUES (NULL,?,?,?,?,?,?,?,?,?,?)'
    ).run(req.user.id, plan.id, plan.duration_days, reference, amount, plan.currency, 'initialized', req.user.email, promoId, discount);
  } catch (e) {
    console.error('[billing] payment insert failed:', e.message);
    return back('Internal error starting your checkout — no charge was made. Please try again in a moment.');
  }

  try {
    const order = await paypal.createOrder({
      reference, plan, amountCents: amount,
      returnUrl: util.siteUrl(`/billing/callback?ref=${encodeURIComponent(reference)}`),
      cancelUrl: util.siteUrl(`/billing/cancel?ref=${encodeURIComponent(reference)}`),
      payerEmail: req.user.email,
    });
    if (!order.ok) {
      db.prepare("UPDATE payments SET status = 'failed' WHERE reference = ?").run(reference);
      return back('PayPal could not start the checkout: ' + order.error);
    }
    db.prepare('UPDATE payments SET order_id = ? WHERE reference = ?').run(order.id, reference);
    if (!order.approveUrl) {
      return back('PayPal did not return an approval link — please try again.');
    }
    return res.redirect(order.approveUrl);
  } catch (e) {
    db.prepare("UPDATE payments SET status = 'failed' WHERE reference = ?").run(reference);
    return back('Could not reach PayPal right now — please try again in a moment.');
  }
});

/* ---------------- Return from PayPal — user cancelled (no charge) ---------------- */
router.get('/billing/cancel', requireUser, (req, res) => {
  const reference = String(req.query.ref || '').trim();
  const payment = reference && db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
  if (payment && payment.user_id === req.user.id && payment.status === 'initialized') {
    db.prepare("UPDATE payments SET status = 'cancelled' WHERE reference = ?").run(reference);
    const plan = getPlan(payment.plan_id);
    sendBranded(req.user.email, 'Checkout cancelled — no charge was made', {
      kicker: 'Checkout update',
      title: 'Your upgrade checkout was cancelled',
      preheader: 'No charge was made — you can finish upgrading whenever you\'re ready.',
      alert: `Your FirmLedger Pro checkout${plan ? ` (<b>${util.escHtml(plan.name)}</b> — ${plan.currency} ${paypal.decimal(payment.amount || plan.price_cents)})` : ''} was cancelled before payment. <b>No charge was made.</b>`,
      alertTone: 'info',
      paragraphs: [
        'Nothing was charged and your account is unchanged. You can return and complete the upgrade at any time — Pro unlocks every listing\'s full details (email, phone, website, events, relationship graph) plus the verified tick, Featured placement and gold badge on listings you own.',
      ],
      cta: { label: 'Return to upgrade', url: util.siteUrl('/dashboard/upgrade') },
      note: `Reference <b>${util.escHtml(reference)}</b> — quote it if anything looks wrong. Questions? <a href="mailto:billing@firmledger.co.ke" style="color:#1D4ED8;">billing@firmledger.co.ke</a>`,
    }).catch(() => {});
  }
  res.redirect('/dashboard/upgrade?err=' + encodeURIComponent('Checkout cancelled — no charge was made.'));
});

/* ---------------- Return from PayPal — capture + verify, server-side ---------------- */
router.get('/billing/callback', requireUser, async (req, res) => {
  const fail = (m) => res.redirect('/dashboard/upgrade?err=' + encodeURIComponent(m));
  const reference = String(req.query.ref || '').trim();
  const orderId = String(req.query.token || '').trim(); // PayPal returns ?token=<ORDER-ID>
  if (!reference || !orderId) return fail('Checkout was interrupted before payment completed.');

  const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
  if (!payment) return fail('Unknown payment reference.');
  if (payment.user_id !== req.user.id) return fail('This payment belongs to a different account.');
  if (payment.order_id && payment.order_id !== orderId) return fail('Order mismatch — payment reference does not match PayPal.');
  if (payment.status === 'success') {
    return res.redirect('/dashboard/upgrade?okmsg=' + encodeURIComponent('This payment was already applied to your account.'));
  }
  if (!paypal.configured()) return fail('Payments are not configured on this installation.');
  const plan = getPlan(payment.plan_id);
  if (!plan) return fail('The plan attached to this payment is no longer available — contact support with reference ' + reference + '.');

  try {
    const cap = await paypal.captureOrder(orderId, { reference, plan, amountCents: payment.amount });
    if (!cap.ok) {
      db.prepare("UPDATE payments SET status = 'failed', order_id = ? WHERE reference = ?").run(orderId, reference);
      const payerHint = cap.payer && cap.payer.email ? ` (PayPal account ${cap.payer.email})` : '';
      return fail(`Payment not confirmed by PayPal${payerHint}: ${cap.reason}. If you were charged, contact support quoting reference ${reference}.`);
    }
    db.prepare("UPDATE payments SET status = 'success', channel = ?, paid_at = ?, order_id = ? WHERE reference = ?")
      .run(cap.channel || 'paypal', cap.paidAt || new Date().toISOString(), orderId, reference);
    if (payment.promo_id) {
      try { promos.redeem(req.user.id, payment.promo_id, payment.id); } catch { /* already redeemed */ }
    }
    const granted = grantUserPro(req.user.id, payment.duration_days || plan.duration_days);

    if (granted) {
      const till = granted.expiry.toISOString().slice(0, 10);
      sendBranded(cap.payer.email || payment.email || req.user.email, `Payment receipt — FirmLedger Pro (${plan.name})`, {
        kicker: 'Payment receipt',
        title: `Thank you${cap.payer.name ? `, ${util.escHtml(cap.payer.name)}` : ''} — Pro is active`,
        preheader: `Your FirmLedger Pro payment was confirmed.`,
        alert: `<b>Plan:</b> ${util.escHtml(plan.name)} (${plan.duration_days} days) &nbsp;·&nbsp; <b>Amount:</b> ${plan.currency} ${paypal.decimal(payment.amount)}${payment.discount_cents ? ` <span style="opacity:.8">(saved ${plan.currency} ${paypal.decimal(payment.discount_cents)})</span>` : ''} &nbsp;·&nbsp; <b>Active to:</b> ${till}`,
        alertTone: 'ok',
        paragraphs: [
          `Your payment was confirmed and FirmLedger Pro is live on your account${till ? ` until <b>${till}</b>` : ''}. Here are your details: reference <b>${util.escHtml(reference)}</b>, PayPal order <b>${util.escHtml(orderId)}</b>.`,
          `You can now view every listing's full details — public email, phone, website, events timeline and relationship graph. Any listings you own carry the blue verified tick, homepage Featured placement, the premium gold badge, and priority admin verification & trust review.`,
        ],
        cta: { label: 'Open your dashboard', url: util.siteUrl('/dashboard') },
        note: 'Keep this email as your receipt. Questions about the charge? Reply to <a href="mailto:billing@firmledger.co.ke" style="color:#1D4ED8;">billing@firmledger.co.ke</a> quoting your reference.',
      }).catch(() => {});
    }
    return res.redirect('/dashboard/upgrade?okmsg=' + encodeURIComponent(
      `Payment confirmed — FirmLedger Pro is active on your account${granted ? ` until ${granted.expiry.toISOString().slice(0, 10)}` : ''}.`));
  } catch (e) {
    return fail('PayPal could not verify the payment just now. If you were charged, contact support quoting reference ' + reference + '.');
  }
});

module.exports = router;
