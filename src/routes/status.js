/**
 * FirmLedger status — public status page, JSON API and email subscriptions.
 *
 * Mounted at /status (after the session/CSRF guard). The page is intentionally
 * public and indexable; subscriptions are double-opt-in and rate-limited.
 */
const express = require('express');
const mon = require('../lib/statusMonitor');
const spam = require('../lib/spam');
const { siteUrl } = require('../lib/util');
const { sendBranded, mailConfigured } = require('../lib/mailer');

const router = express.Router();

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- Public status page ---------------- */
router.get('/', (req, res) => {
  const snap = mon.snapshot();
  res.render('status/index', {
    meta: {
      title: 'System status — FirmLedger',
      description: 'Live status of FirmLedger — the web application, API, database and email delivery. Incident history, uptime percentages and email subscriptions.',
      canonical: siteUrl('/status'),
    },
    snap,
    labels: mon.OVERALL_LABELS,
    componentLabels: mon.STATUS_LABELS,
    ok: req.query.ok || '',
    err: req.query.err || '',
  });
});

/* ---------------- JSON API ---------------- */
router.get('/api', (req, res) => {
  res.json(mon.snapshot());
});

/* ---------------- Email subscription (double-opt-in) ---------------- */
router.post('/subscribe', spam.gate('status', { checkEmail: true }), async (req, res) => {
  const back = (m, kind = 'err') => res.redirect('/status?' + kind + '=' + encodeURIComponent(m) + '#subscribe');
  const email = String(req.body.email || '').trim().toLowerCase();
  const r = mon.addSubscriber(email);
  if (!r.ok) return back(r.error);

  if (r.already) {
    return back(`You're already subscribed with ${email} — we'll email you the moment anything changes.`, 'ok');
  }

  // Double-opt-in: send a verification link before we start emailing them.
  const verifyUrl = siteUrl('/status/verify?token=' + encodeURIComponent(r.token));
  const unsubscribeUrl = siteUrl('/status/unsubscribe?token=' + encodeURIComponent(r.token));
  if (mailConfigured()) {
    const from = process.env.STATUS_EMAIL_FROM || undefined;
    sendBranded(email, 'Confirm your FirmLedger status subscription', {
      from,
      kicker: 'Status subscription',
      title: 'Confirm your subscription',
      preheader: 'One click to confirm FirmLedger status alerts.',
      alert: `We'll email <b>${esc(email)}</b> when FirmLedger has an incident or a resolved update. Confirm first so we know it's you.`,
      alertTone: 'info',
      paragraphs: [
        'Click the button below to confirm. We only alert you about real incidents and their resolutions — no spam, no daily noise.',
      ],
      cta: { label: 'Confirm subscription', url: verifyUrl },
      note: `If this wasn't you, you can ignore this email — nothing will change. Unsubscribe any time at <a href="${unsubscribeUrl}" style="color:#1D4ED8;">${unsubscribeUrl}</a>.`,
    }).catch(() => {});
    return back(`Almost done — a confirmation email is on its way to ${email}. Click the link inside to start receiving status alerts.`, 'ok');
  }

  // No SMTP configured locally — accept single-opt-in so the feature still works.
  mon.verifySubscriber(r.token);
  return back(`You're subscribed to FirmLedger status updates as ${email}.`, 'ok');
});

/* ---------------- Verify / unsubscribe ---------------- */
router.get('/verify', (req, res) => {
  const r = mon.verifySubscriber(req.query.token);
  res.render('message', {
    meta: { title: r.ok ? 'Subscription confirmed — FirmLedger' : 'Link not valid — FirmLedger', description: '', robots: 'noindex' },
    heading: r.ok ? 'You are subscribed to status updates' : 'That confirmation link is not valid',
    text: r.ok
      ? `Confirmed for <b>${esc(r.email)}</b>. We'll email you when FirmLedger has an incident or resolves one.`
      : 'The link may be old or mistyped. Try subscribing again from the status page.',
    link: { href: '/status', label: 'Back to status' },
  });
});

router.get('/unsubscribe', (req, res) => {
  const r = mon.unsubscribeSubscriber(req.query.token);
  res.render('message', {
    meta: { title: r.ok ? 'Unsubscribed — FirmLedger' : 'Link not valid — FirmLedger', description: '', robots: 'noindex' },
    heading: r.ok ? 'You have been unsubscribed' : 'That unsubscribe link is not valid',
    text: r.ok
      ? 'Confirmed — no more status alerts will arrive. You can re-subscribe anytime from the status page.'
      : 'The link may be old or mistyped. Use the status page to manage your subscription.',
    link: { href: '/status', label: 'Back to status' },
  });
});

module.exports = router;
