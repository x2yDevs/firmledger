/**
 * Admin ops: health, spam protection, maintenance, promo codes, SMTP accounts.
 * Mounted after session/CSRF. requireAdmin on every /admin3119Musa/* route.
 */
const express = require('express');
const { db, getSetting, setSetting } = require('../db');
const { requireAdmin } = require('../lib/session');
const { sendBranded, mailConfigured, PROVIDERS, allAccountsRaw, addAccount,
  toggleAccount, deleteAccount, saveGlobalFrom, fromAddress, hops } = require('../lib/mailer');
const spam = require('../lib/spam');
const health = require('../lib/health');
const promos = require('../lib/promos');
const notify = require('../lib/notify');
const { allPlans } = require('../lib/plans');
const { siteUrl, escHtml } = require('../lib/util');
const backup = require('../lib/backup');

const router = express.Router();
router.use('/admin3119Musa', requireAdmin);

function back(res, path, kind, msg) {
  const q = kind + '=' + encodeURIComponent(msg);
  return res.redirect(path + (path.includes('?') ? '&' : '?') + q);
}

/* ================= Health ================= */
router.get('/admin3119Musa/health', (req, res) => {
  res.render('admin/health', {
    meta: { title: 'System health — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    snap: health.snapshot(),
    section: 'health',
    ok: req.query.ok || '', err: req.query.err || '',
  });
});

router.get('/admin3119Musa/health/backup.firmledger', (req, res) => {
  const body = backup.buildBackup();
  setSetting('last_backup_at', new Date().toISOString());
  const stamp = new Date().toISOString().slice(0, 10);
  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="firmledger-backup-${stamp}.firmledger"`);
  res.send(body);
});

/* ================= Protection (spam + maintenance) ================= */
router.get('/admin3119Musa/protection', (req, res) => {
  res.render('admin/protection', {
    meta: { title: 'Protection — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    section: 'protection',
    ips: spam.listIp(),
    domains: spam.listDomain(),
    limits: spam.limits(),
    defaults: spam.DEFAULTS,
    maintenance: {
      on: getSetting('maintenance_on', '0') === '1',
      title: getSetting('maintenance_title', "We'll be back soon"),
      message: getSetting('maintenance_message', 'FirmLedger is down for a short update. Your data is safe — please check back in a little while.'),
      eta: getSetting('maintenance_eta', ''),
    },
    ok: req.query.ok || '', err: req.query.err || '',
  });
});

router.post('/admin3119Musa/protection/limits', (req, res) => {
  spam.saveLimits(req.body);
  return back(res, '/admin3119Musa/protection', 'ok', 'Rate limits saved.');
});

router.post('/admin3119Musa/protection/ip', (req, res) => {
  const r = spam.addIp(req.body.value, req.body.kind, req.body.note);
  if (!r.ok) return back(res, '/admin3119Musa/protection', 'err', r.error);
  return back(res, '/admin3119Musa/protection', 'ok', 'IP added.');
});
router.post('/admin3119Musa/protection/ip/:id/delete', (req, res) => {
  spam.removeIp(req.params.id);
  return back(res, '/admin3119Musa/protection', 'ok', 'IP removed.');
});

router.post('/admin3119Musa/protection/domain', (req, res) => {
  const r = spam.addDomain(req.body.value, req.body.kind, req.body.note);
  if (!r.ok) return back(res, '/admin3119Musa/protection', 'err', r.error);
  return back(res, '/admin3119Musa/protection', 'ok', 'Domain added.');
});
router.post('/admin3119Musa/protection/domain/:id/delete', (req, res) => {
  spam.removeDomain(req.params.id);
  return back(res, '/admin3119Musa/protection', 'ok', 'Domain removed.');
});

router.post('/admin3119Musa/protection/maintenance', (req, res) => {
  const turningOn = req.body.maintenance_on === '1';
  const wasOn = getSetting('maintenance_on', '0') === '1';
  const title = String(req.body.maintenance_title || '').trim().slice(0, 120) || "We'll be back soon";
  const message = String(req.body.maintenance_message || '').trim().slice(0, 2000)
    || 'FirmLedger is down for a short update. Your data is safe — please check back in a little while.';
  const eta = String(req.body.maintenance_eta || '').trim().slice(0, 80);
  setSetting('maintenance_on', turningOn ? '1' : '0');
  setSetting('maintenance_title', title);
  setSetting('maintenance_message', message);
  setSetting('maintenance_eta', eta);

  if (turningOn && !wasOn && req.body.email_users === '1') {
    const users = db.prepare('SELECT email, name FROM users').all();
    const etaLine = eta ? ` Expected return: <b>${escHtml(eta)}</b>.` : '';
    for (const u of users) {
      sendBranded(u.email, 'FirmLedger is briefly offline for an update', {
        kicker: 'Status',
        title: escHtml(title),
        preheader: 'FirmLedger is down for a short update. Your data is safe.',
        alert: 'The directory is temporarily offline for maintenance. Listings, accounts and payments are untouched.',
        alertTone: 'info',
        paragraphs: [
          escHtml(message) + etaLine,
          'You do not need to do anything. We will be back as soon as the update finishes.',
        ],
        cta: { label: 'FirmLedger', url: siteUrl('/') },
        note: 'You received this because you hold a FirmLedger account.',
      }).catch(() => {});
    }
    return back(res, '/admin3119Musa/protection', 'ok',
      `Maintenance is ON — emailed ${users.length} account holder${users.length === 1 ? '' : 's'}.`);
  }
  return back(res, '/admin3119Musa/protection', 'ok',
    turningOn ? 'Maintenance mode is ON — visitors see the holding page. You stay signed in as admin.'
              : 'Maintenance mode is OFF — the site is public again.');
});

/* ================= Promo codes ================= */
router.get('/admin3119Musa/promos', (req, res) => {
  res.render('admin/promos', {
    meta: { title: 'Promo codes — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    section: 'promos',
    codes: promos.all(),
    plans: allPlans(false),
    ok: req.query.ok || '', err: req.query.err || '',
  });
});

router.post('/admin3119Musa/promos', (req, res) => {
  const r = promos.create({
    code: req.body.code,
    percent: req.body.percent,
    planId: req.body.plan_id,
    maxUses: req.body.max_uses,
    expiresAt: req.body.expires_at,
    note: req.body.note,
  });
  if (!r.ok) return back(res, '/admin3119Musa/promos', 'err', r.error);

  const channel = String(req.body.notify || 'none');
  if (channel === 'email' || channel === 'inapp' || channel === 'both') {
    const users = db.prepare('SELECT id, email, name FROM users').all();
    const pct = r.percent;
    const url = siteUrl('/dashboard/upgrade?promo=' + encodeURIComponent(r.code));
    if (channel === 'email' || channel === 'both') {
      for (const u of users) {
        sendBranded(u.email, `${r.code} — ${pct}% off FirmLedger Pro`, {
          kicker: 'Offer',
          title: `${pct}% off FirmLedger Pro`,
          preheader: `Use code ${r.code} at checkout for ${pct}% off Pro.`,
          alert: `Promo code <b>${escHtml(r.code)}</b> is live — <b>${pct}% off</b> at checkout.`,
          alertTone: 'ok',
          paragraphs: [
            `A FirmLedger Pro discount is available on your account. Enter <b>${escHtml(r.code)}</b> on the upgrade page before you pay.`,
          ],
          cta: { label: 'Upgrade with ' + r.code, url },
          note: 'One use per account. The code may expire or run out of redemptions.',
        }).catch(() => {});
      }
    }
    if (channel === 'inapp' || channel === 'both') {
      for (const u of users) {
        notify.notifyUser(u.id, {
          kind: 'pro',
          title: `${pct}% off Pro — ${r.code}`,
          body: `Use code ${r.code} at checkout.`,
          url: '/dashboard/upgrade?promo=' + encodeURIComponent(r.code),
        });
      }
    }
    return back(res, '/admin3119Musa/promos', 'ok',
      `Code ${r.code} created (${pct}% off) and members notified via ${channel === 'both' ? 'email and in-app' : channel}.`);
  }
  return back(res, '/admin3119Musa/promos', 'ok', `Code ${r.code} created — ${r.percent}% off.`);
});

router.post('/admin3119Musa/promos/:id/toggle', (req, res) => {
  const row = db.prepare('SELECT active, code FROM promo_codes WHERE id=?').get(req.params.id);
  if (row) promos.setActive(req.params.id, !row.active);
  return back(res, '/admin3119Musa/promos', 'ok', row ? `${row.code} is now ${row.active ? 'off' : 'live'}.` : 'Code not found.');
});

router.post('/admin3119Musa/promos/:id/delete', (req, res) => {
  const r = promos.remove(req.params.id);
  return back(res, '/admin3119Musa/promos', 'ok',
    r.deactivated ? 'Code has payments attached — deactivated instead of deleted.' : 'Code deleted.');
});

/* ================= SMTP accounts (also shown on Settings) ================= */
router.post('/admin3119Musa/mail/from', (req, res) => {
  saveGlobalFrom(req.body.smtp_from);
  return back(res, '/admin3119Musa/settings', 'ok', 'From address saved — used on every provider.');
});

router.post('/admin3119Musa/mail/accounts', (req, res) => {
  const r = addAccount(req.body);
  if (!r.ok) return back(res, '/admin3119Musa/settings', 'err', r.error);
  return back(res, '/admin3119Musa/settings', 'ok', 'Mail provider added. It is tried after earlier hops when a limit is hit.');
});

router.post('/admin3119Musa/mail/accounts/:id/toggle', (req, res) => {
  toggleAccount(req.params.id);
  return back(res, '/admin3119Musa/settings', 'ok', 'Mail provider updated.');
});
router.post('/admin3119Musa/mail/accounts/:id/delete', (req, res) => {
  deleteAccount(req.params.id);
  return back(res, '/admin3119Musa/settings', 'ok', 'Mail provider removed.');
});

module.exports = router;
module.exports.mailLocals = function mailLocals() {
  return {
    providers: PROVIDERS,
    mailAccounts: allAccountsRaw(),
    mailHops: hops(),
    mailFrom: fromAddress(),
    smtp_configured: mailConfigured(),
  };
};
