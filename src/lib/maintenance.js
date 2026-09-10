/**
 * Maintenance mode — visitors see a branded holding page; admin stays in.
 */
const { getSetting } = require('../db');
const { siteUrl } = require('./util');

function isOn() {
  return getSetting('maintenance_on', '0') === '1';
}

function locals() {
  return {
    title: getSetting('maintenance_title', "We'll be back soon") || "We'll be back soon",
    message: getSetting('maintenance_message',
      'FirmLedger is down for a short update. Your data is safe — please check back in a little while.'),
    eta: getSetting('maintenance_eta', ''),
  };
}

function gate(req, res, next) {
  if (!isOn()) return next();
  if (req.admin) return next();
  const p = req.path || '';
  if (p.startsWith('/admin3119Musa')) return next();
  if (p.startsWith('/status')) return next(); // the status page must stay up during an outage
  if (p.startsWith('/uploads') || p.startsWith('/fonts') || p.startsWith('/assets')) return next();
  if (/\.(css|js|png|jpg|jpeg|svg|woff2?|ico|txt|xml)$/i.test(p)) return next();
  res.set('Retry-After', '3600');
  const m = locals();
  /* Full site chrome (shared header/footer): the holding page lives inside the
     normal FirmLedger layout. The newsletter band is hidden — its subscribe
     form can't post while the gate is up — and the canonical keeps crawlers
     from treating the 503 body as a page of its own. */
  return res.status(503).render('maintenance', {
    meta: { title: m.title + ' — FirmLedger', description: m.message, robots: 'noindex,nofollow', canonical: siteUrl(req.path || '/') },
    m,
    hideNews: true,
  });
}

module.exports = { isOn, locals, gate };
