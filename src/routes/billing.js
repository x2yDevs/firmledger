const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { requireUser, validCsrf } = require('../lib/session');
const paypal = require('../lib/paypal');
const {
  allPlans, getPlan, isProUser, grantUserPro,
  startTrial, trialEligible, trialActive, trialDaysRemaining, TRIAL_SIGNUP_DAYS,
} = require('../lib/plans');
const util = require('../lib/util');
const { sendMail, sendBranded } = require('../lib/mailer');
const trialmail = require('../lib/trialmail');
const notify = require('../lib/notify');
const promos = require('../lib/promos');
const ad = require('../lib/advertising');

const router = express.Router();

/* Absolute URL PayPal redirects back to. When BASE_URL is a real public
   origin we use it; otherwise (dev, staging, previews) we derive the origin
   from the request so the round-trip works wherever the app is running. */
function returnBase(req, path) {
  if (util.isPublicBaseUrl()) return util.siteUrl(path);
  return `${req.protocol}://${req.get('host')}${path}`;
}

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
      returnUrl: returnBase(req, `/billing/callback?ref=${encodeURIComponent(reference)}`),
      cancelUrl: returnBase(req, `/billing/cancel?ref=${encodeURIComponent(reference)}`),
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

/* ---------------- Return from PayPal — user cancelled (no charge) ----------------
   No login required: the session cookie may not survive the round trip to
   PayPal, and this route only flips an 'initialized' record to 'cancelled'. */
router.get('/billing/cancel', (req, res) => {
  const reference = String(req.query.ref || '').trim();
  const payment = reference && db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
  if (payment && (!req.user || payment.user_id === req.user.id) && payment.status === 'initialized') {
    db.prepare("UPDATE payments SET status = 'cancelled' WHERE reference = ?").run(reference);
    const isAdCancel = payment.kind === 'ad';
    const plan = isAdCancel ? ad.getPackage(payment.plan_id) : getPlan(payment.plan_id);
    const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(payment.user_id);
    const to = (buyer && buyer.email) || payment.email;
    const dest = isAdCancel ? util.siteUrl('/dashboard/advertise') : util.siteUrl('/dashboard/upgrade');
    const label = isAdCancel ? 'advertising' : 'upgrade';
    if (to) {
      sendBranded(to, 'Checkout cancelled — no charge was made', {
      kicker: 'Checkout update',
      title: `Your ${label} checkout was cancelled`,
      preheader: 'No charge was made — you can finish whenever you\'re ready.',
      alert: `Your FirmLedger ${label} checkout${plan ? ` (<b>${util.escHtml(plan.name)}</b> — ${plan.currency} ${paypal.decimal(payment.amount || plan.price_cents)})` : ''} was cancelled before payment. <b>No charge was made.</b>`,
      alertTone: 'info',
      paragraphs: isAdCancel
        ? ['Nothing was charged and your listing is unchanged. You can return and complete the advertising checkout at any time — once confirmed, your listing appears on the homepage Sponsored Content strip, clearly labelled as Sponsored.']
        : ['Nothing was charged and your account is unchanged. You can return and complete the upgrade at any time — Pro unlocks every listing\'s full details (email, phone, website, events, relationship graph) plus the verified tick, Featured placement and gold badge on listings you own.'],
      cta: { label: `Return to ${label}`, url: dest },
      note: `Reference <b>${util.escHtml(reference)}</b> — quote it if anything looks wrong. Questions? ${isAdCancel ? '<a href="mailto:advertising@firmledger.co.ke" style="color:#1D4ED8;">advertising@firmledger.co.ke</a>' : '<a href="mailto:billing@firmledger.co.ke" style="color:#1D4ED8;">billing@firmledger.co.ke</a>'}`,
      }).catch(() => {});
    }
  }
  const cancelDest = payment && payment.kind === 'ad' ? '/dashboard/advertise' : '/dashboard/upgrade';
  return res.redirect(cancelDest + '?err=' + encodeURIComponent('Checkout cancelled — no charge was made.'));
});

/* ---------------- Return from PayPal — capture + verify, server-side ----------------
   No login required: the account is resolved from our own payment record and
   the money is verified against PayPal (status/amount/currency/reference), so
   a session cookie that didn't survive the redirect can never lose a payment. */
router.get('/billing/callback', async (req, res) => {
  const reference = String(req.query.ref || '').trim();
  const orderId = String(req.query.token || '').trim(); // PayPal returns ?token=<ORDER-ID>
  const payment = reference ? db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference) : null;
  // Advertising checkouts fail back to /dashboard/advertise; plan checkouts to /dashboard/upgrade.
  const fail = (m) => res.redirect(((payment && payment.kind === 'ad') ? '/dashboard/advertise' : '/dashboard/upgrade') + '?err=' + encodeURIComponent(m));
  if (!reference || !orderId) return fail('Checkout was interrupted before payment completed.');
  if (!payment) return fail('Unknown payment reference.');
  if (req.user && payment.user_id !== req.user.id) return fail('This payment belongs to a different account.');
  const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(payment.user_id);
  if (!buyer) return fail('The account behind this payment no longer exists — contact support quoting reference ' + reference + '.');
  if (payment.order_id && payment.order_id !== orderId) return fail('Order mismatch — payment reference does not match PayPal.');
  if (payment.status === 'success') {
    const okDest = payment.kind === 'ad' ? '/dashboard/advertise' : '/dashboard/upgrade';
    return res.redirect(okDest + '?okmsg=' + encodeURIComponent('This payment was already applied.'));
  }
  if (!paypal.configured()) return fail('Payments are not configured on this installation.');

  /* Resolve what was bought: an account Pro plan (kind='pro') or a sponsored
     advertising spot (kind='ad', where plan_id holds the ad_package id). */
  const isAd = payment.kind === 'ad';
  const plan = isAd ? ad.getPackage(payment.plan_id) : getPlan(payment.plan_id);
  const planLike = plan ? {
    name: plan.name, price_cents: plan.price_cents, currency: plan.currency, duration_days: plan.duration_days,
  } : null;
  if (!planLike) return fail(isAd
    ? 'The advertising package for this payment is no longer available — contact support with reference ' + reference + '.'
    : 'The plan attached to this payment is no longer available — contact support with reference ' + reference + '.');

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
      try { promos.redeem(buyer.id, payment.promo_id, payment.id); } catch { /* already redeemed */ }
    }

    if (isAd) {
      /* ---- Sponsored Content: mark the listing sponsored for the package duration ---- */
      const listing = db.prepare('SELECT id, slug, name FROM listings WHERE id=?').get(payment.listing_id);
      let until = '';
      if (listing) {
        const g = ad.grantSponsorship(listing.id, payment.duration_days || planLike.duration_days, reference);
        until = g.until || '';
      }
      notify.notifyUser(buyer.id, {
        kind: 'advertising',
        title: 'Payment confirmed — your listing is now Sponsored',
        body: `${planLike.name} is live on the homepage Sponsored Content strip${until !== 'lifetime' && until ? ` until ${until}` : '.'}. Reference ${reference}.`,
        url: '/dashboard/advertise',
      });
      if (listing) {
        sendBranded(cap.payer.email || payment.email || buyer.email, `Payment receipt — Sponsored Content (${planLike.name})`, {
          kicker: 'Advertising receipt',
          title: `Thank you${cap.payer.name ? `, ${util.escHtml(cap.payer.name)}` : ''} — your listing is sponsored`,
          preheader: 'Your FirmLedger Sponsored Content placement was confirmed.',
          alert: `<b>Package:</b> ${util.escHtml(planLike.name)} (${planLike.duration_days} days) &nbsp;·&nbsp; <b>Amount:</b> ${planLike.currency} ${paypal.decimal(payment.amount)} &nbsp;·&nbsp; <b>Listing:</b> ${util.escHtml(listing.name)}`,
          alertTone: 'ok',
          paragraphs: [
            `Your payment was confirmed and <b>${util.escHtml(listing.name)}</b> is now live on the FirmLedger homepage <b>Sponsored Content</b> strip${until !== 'lifetime' && until ? ` until <b>${until}</b>` : ''}. It's clearly labelled <b>Sponsored</b>.`,
            `Reference <b>${util.escHtml(reference)}</b> · PayPal order <b>${util.escHtml(orderId)}</b>.`,
          ],
          cta: { label: 'Manage your advertising', url: util.siteUrl('/dashboard/advertise') },
          note: 'Keep this email as your receipt. Questions? Reply to <a href="mailto:advertising@firmledger.co.ke" style="color:#1D4ED8;">advertising@firmledger.co.ke</a> quoting your reference.',
        }).catch(() => {});
      }
      return res.redirect('/dashboard/advertise?ok=' + encodeURIComponent(
        `Payment confirmed — ${listing ? listing.name : 'your listing'} is now sponsored${until !== 'lifetime' && until ? ` until ${until}` : ''}.`));
    }

    const granted = grantUserPro(buyer.id, payment.duration_days || planLike.duration_days);

    if (granted) {
      const till = granted.expiry ? granted.expiry.toISOString().slice(0, 10) : '';
      notify.notifyUser(buyer.id, {
        kind: 'billing',
        title: 'Payment confirmed — FirmLedger Pro is active',
        body: `${planLike.name} (${planLike.duration_days} days) is live on your account${till ? ` until ${till}` : ''}. Reference ${reference}.`,
        url: '/dashboard/upgrade',
      });
      sendBranded(cap.payer.email || payment.email || buyer.email, `Payment receipt — FirmLedger Pro (${planLike.name})`, {
        kicker: 'Payment receipt',
        title: `Thank you${cap.payer.name ? `, ${util.escHtml(cap.payer.name)}` : ''} — Pro is active`,
        preheader: `Your FirmLedger Pro payment was confirmed.`,
        alert: `<b>Plan:</b> ${util.escHtml(planLike.name)} (${planLike.duration_days} days) &nbsp;·&nbsp; <b>Amount:</b> ${planLike.currency} ${paypal.decimal(payment.amount)}${payment.discount_cents ? ` <span style="opacity:.8">(saved ${planLike.currency} ${paypal.decimal(payment.discount_cents)})</span>` : ''} &nbsp;·&nbsp; <b>Active to:</b> ${till}`,
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
      `Payment confirmed — FirmLedger Pro is active on your account${granted && granted.expiry ? ` until ${granted.expiry.toISOString().slice(0, 10)}` : ''}.`));
  } catch (e) {
    console.error('[billing] capture failed:', e.message);
    return fail('PayPal could not verify the payment just now. If you were charged, contact support quoting reference ' + reference + '.');
  }
});

/* ================= Self-serve free trial (activated on /pricing) =================
   Every new account (email, Google or LinkedIn) receives an email inviting it
   to activate a free Pro trial. The button lives on /pricing — one click, no
   payment details, and the trial is REAL Pro access until it expires. */
router.post('/pricing/free-trial', requireUser, (req, res) => {
  if (!validCsrf(req)) return res.status(403).redirect('/pricing#free-trial');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (trialActive(u)) {
    return res.redirect('/pricing?trial_ok=' + encodeURIComponent(
      `Your free trial is already running — ${trialDaysRemaining(u)} day(s) left.`) + '#free-trial');
  }
  if (!trialEligible(u)) {
    return res.redirect('/pricing?trial_err=' + encodeURIComponent(
      isProUser(u)
        ? 'You already have an active Pro subscription — no trial needed.'
        : 'Your account has already used its free trial. Upgrade to keep Pro access.') + '#free-trial');
  }
  const r = startTrial(u.id, TRIAL_SIGNUP_DAYS);
  if (!r.ok) {
    return res.redirect('/pricing?trial_err=' + encodeURIComponent(r.error || 'Could not start the trial — please try again.') + '#free-trial');
  }
  notify.notifyUser(u.id, {
    kind: 'billing',
    title: `Your ${r.days}-day FirmLedger Pro trial is active`,
    body: `Full Pro access until ${String(r.expiresAt).slice(0, 10)} — every listing's details, the verified tick, Featured placement and the developer API.`,
    url: '/dashboard',
  });
  trialmail.sendTrialActivated(u, { days: r.days, expiresAt: r.expiresAt }).catch(() => {});
  return res.redirect('/pricing?trial_ok=' + encodeURIComponent(
    `Your ${r.days}-day free trial is active — full Pro access until ${String(r.expiresAt).slice(0, 10)}. Enjoy!`) + '#free-trial');
});

module.exports = router;
