const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, getSetting, setSetting } = require('../db');
const support = require('../lib/support');
const backup = require('../lib/backup');
const {
  ADMIN_COOKIE, createSession, destroySession, setSessionCookie, requireAdmin, loadSession,
} = require('../lib/session');
const totp = require('../lib/totp');
const { sendMail, sendBranded, sendTest, mailConfigured } = require('../lib/mailer');
const { TYPES, CATEGORIES, SIZES, COUNTRIES } = require('../lib/taxonomy');
const { runCheck } = require('../lib/verify');
const { submitForIndexing, getIndexNowKey } = require('../lib/indexing');
const { parseLines, normalizeUrl, slugify, domainOf, siteUrl, escHtml, randomToken } = require('../lib/util');
const catLib = require('../lib/categories');
const graphLib = require('../lib/graph');
const { deleteLogo } = require('../lib/upload');
const plans = require('../lib/plans');
const paypal = require('../lib/paypal');
const { allPlans, getPlan, grantUserPro, revokeUserPro, isProUser } = plans;
const notify = require('../lib/notify');
const notifications = require('../lib/notifications');
const { finalizeVerifiedClaim } = require('../lib/claimflow');
const ad = require('../lib/advertising');
const careers = require('../lib/careers');
const mon = require('../lib/statusMonitor');

const router = express.Router();
const adminmail2fa = require('../lib/adminmail2fa');

/** Where admin-side notifications go (tickets, 2FA fallbacks…). */
function adminNotifyEmail() {
  return getSetting('admin_email', '') || process.env.ADMIN_NOTIFY_EMAIL || 'hello@firmledger.co.ke';
}

/** Emailed one-time admin sign-in code (fallback for a lost authenticator). */
function sendAdminEmailCode(code) {
  const to = adminNotifyEmail();
  sendBranded(to, `Your admin sign-in code — ${code}`, {
    kicker: 'Admin security',
    title: 'Your admin sign-in code',
    preheader: 'Use this one-time code to finish signing in to the console.',
    otp: code,
    paragraphs: [
      `The admin secret code was just entered at the console’s sign-in gate with the correct secret — this email is your second factor while your authenticator is unreachable.`,
      `Enter the code above within <b>10 minutes</b>. It works exactly once, and asking for another email replaces this one immediately.`,
      `<b>Wasn't you?</b> If you did not just enter the admin secret code, rotate <code>ADMIN_SECRET</code> immediately — your first factor may be exposed.`,
    ],
    note: 'This is an automated security email. It contains no links on purpose — codes are typed at the console.',
    text: `Your admin sign-in code: ${code}\n\nValid for 10 minutes, one use. Enter it at the console's two-factor screen.\nIf you did not just enter the admin secret code, rotate ADMIN_SECRET immediately.`,
  }).catch(() => {});
}

/** Email the fresh set of 10 admin recovery codes — the set to keep offline for authenticator failure. */
function sendAdminRecoveryCodesEmail(codes, regenerated) {
  const to = adminNotifyEmail();
  const rows = codes.map((c, i) => `${i + 1}. ${c}`);
  sendBranded(to, regenerated ? 'Fresh set: your admin recovery codes — keep these safe' : 'Two-factor enabled — your admin recovery codes', {
    kicker: 'Admin security',
    title: regenerated ? 'Your new admin recovery codes' : 'Two-factor authentication is now ON',
    preheader: '10 one-time codes that open the admin console if the authenticator app is unreachable.',
    alertTone: 'warn',
    alert: regenerated
      ? 'All previous recovery codes stopped working the instant this set was generated.'
      : 'Two-factor is now required on the admin console. These codes are your only back-up when the authenticator is unavailable.',
    paragraphs: [
      `Each of the 10 codes below works <strong>exactly once</strong> at the console's two-factor screen, in place of the authenticator code — for example if you lose the phone or the app.`,
      `<code style="display:block;background:#F5F7FA;border:1px solid #E3E8EF;border-radius:10px;padding:14px 16px;font-family:ui-monospace,Consolas,monospace;font-size:13.5px;line-height:1.9;letter-spacing:.04em;white-space:pre-wrap;color:#0A1628">${rows.join('\n')}</code>`,
      `Keep them offline and private — anyone with a code and the ADMIN_SECRET can open the console. When the set runs low, regenerate it in <b>Admin → Settings → Two-factor</b> (regenerating immediately retires every old code and emails you the new set).`,
    ],
    note: 'The codes are also shown once, on-screen, right after enrollment — the screen and this email are the only two places they ever appear.',
    text: `Two-factor authentication is now required on the admin console.\n\n${regenerated ? 'This regenerated set replaces every previous recovery code.' : 'Save these 10 one-time recovery codes.'} Each code works exactly once at the two-factor screen if the authenticator is unreachable:\n\n${rows.map((r, i) => '  ' + (i + 1) + '. ' + codes[i]).join('\n')}\n\nKeep them offline — anyone with a code and the ADMIN_SECRET can open the console. Regenerate in Admin → Settings → Two-factor when the set runs low.`,
  }).catch(() => {});
}

function codeOk(sent) {
  const expected = String(process.env.ADMIN_SECRET || '');
  if (!sent || !expected) return false;
  const a = Buffer.from(String(sent));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------- Admin gate ---------------- */
router.get('/admin3119Musa', (req, res) => {
  if (req.admin) return res.redirect('/admin3119Musa/dashboard');
  res.render('admin/gate', {
    meta: { title: 'Admin access — FirmLedger', description: '', robots: 'noindex,nofollow' },
    error: '',
  });
});

router.post('/admin3119Musa', (req, res) => {
  if (!codeOk(req.body.code)) {
    return res.status(403).render('admin/gate', {
      meta: { title: 'Admin access — FirmLedger', description: '', robots: 'noindex,nofollow' },
      error: 'Invalid admin code.',
    });
  }
  // Secret code correct → second factor required: TOTP (Google Authenticator etc.)
  if (req.cookies[ADMIN_COOKIE]) destroySession(req.cookies[ADMIN_COOKIE]);
  const secret = getSetting('admin_totp_secret', '');
  const pending = createSession(null, 'admin-pending');
  res.cookie('fl_admin2fa', pending.token, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 10 * 60 * 1000, path: '/',
  });
  if (!secret) {
    // First login ever: generate the authenticator secret for enrollment.
    // Reuse an already-pending key — re-entering the first factor mid-enrollment
    // must not invalidate the QR code the operator just scanned.
    let fresh = getSetting('admin_totp_pending', '');
    if (!fresh) {
      fresh = totp.generateSecret();
      setSetting('admin_totp_pending', fresh);
    }
    return res.redirect('/admin3119Musa/2fa-setup');
  }
  // First factor passed with 2FA enrolled → email a one-time fallback code
  // (works exactly like the emailed codes on the member side: keep it in your
  // inbox, use it in place of the authenticator if the app ever fails).
  sendAdminEmailCode(adminmail2fa.createEmailCode());
  return res.redirect('/admin3119Musa/2fa');
});

/** Pending-2FA session guard (code accepted, authenticator not yet proven). */
function pendingAdmin(req, res, next) {
  const s = loadSession(req.cookies.fl_admin2fa, 'admin-pending');
  if (!s) return res.redirect('/admin3119Musa');
  req.pendingSession = s;
  next();
}

/*
 * Failed-attempt throttling on the second factor: max 5 wrong codes per
 * pending session (10-minute window), then the pending session is destroyed
 * and the admin code (first factor) must be proven again. Mirrors the
 * user-side login throttle.
 */
const twofaFails = new Map();
/** Returns true if this attempt exhausted the allowance (session now dead). */
function twoFaThrottle(req, res) {
  const tok = req.pendingSession.token;
  const now = Date.now();
  const rec = (twofaFails.get(tok) || []).filter((t) => now - t < 10 * 60 * 1000);
  rec.push(now);
  twofaFails.set(tok, rec);
  if (rec.length < 5) return false;
  destroySession(tok);
  twofaFails.delete(tok);
  res.clearCookie('fl_admin2fa', { path: '/' });
  return true;
}
function twoFaThrottleResponse(res) {
  return res.status(429).render('admin/gate', {
    meta: { title: 'Admin access — FirmLedger', description: '', robots: 'noindex,nofollow' },
    error: 'Too many incorrect two-factor codes. Sign in with the admin code again to restart verification.',
  });
}

router.get('/admin3119Musa/2fa-setup', pendingAdmin, async (req, res) => {
  const secret = getSetting('admin_totp_pending', '');
  if (!secret || getSetting('admin_totp_secret', '')) return res.redirect('/admin3119Musa/dashboard');
  const uri = totp.otpAuthUrl(secret);
  let qr = '';
  try {
    const QRCode = require('qrcode');
    qr = await QRCode.toDataURL(uri, { margin: 1, width: 240, color: { dark: '#0A1628', light: '#FFFFFF' } });
  } catch { /* package missing — manual key still shown */ }
  res.render('admin/2fa-setup', {
    meta: { title: 'Set up two-factor — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    secret, qr, error: '', pendingCsrf: req.pendingSession.csrf,
  });
});

router.post('/admin3119Musa/2fa-setup', pendingAdmin, async (req, res) => {
  const secret = getSetting('admin_totp_pending', '');
  if (!secret) return res.redirect('/admin3119Musa');
  const ok = totp.verifyTotp(secret, req.body.code);
  if (!ok) {
    if (twoFaThrottle(req, res)) return twoFaThrottleResponse(res);
    // Re-render with the REAL QR image — a wrong code must not make the
    // scanned QR vanish or claim rendering is unavailable.
    let qr = '';
    try {
      const QRCode = require('qrcode');
      qr = await QRCode.toDataURL(totp.otpAuthUrl(secret), {
        margin: 1, width: 240, color: { dark: '#0A1628', light: '#FFFFFF' },
      });
    } catch { /* package missing — manual key still shown */ }
    return res.status(403).render('admin/2fa-setup', {
      meta: { title: 'Set up two-factor — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
      secret, qr, error: 'That code did not match. Scan the entry again and try the latest 6-digit code — make sure your phone clock is set automatically.',
      pendingCsrf: req.pendingSession.csrf,
    });
  }
  // verify accepted → activate 2FA, generate 10 recovery codes, and create the real admin session
  setSetting('admin_totp_secret', secret);
  setSetting('admin_totp_pending', '');
  const codes = backup.genAdminRecoveryCodes(10);
  setSetting('admin_recovery_codes', JSON.stringify(codes.map((c) => ({ h: backup.hashAdminCode(c), used: 0 }))));
  destroySession(req.pendingSession.token); res.clearCookie('fl_admin2fa', { path: '/' });
  const sess = createSession(null, 'admin');
  setSessionCookie(req, res, ADMIN_COOKIE, sess.token);
  sendAdminRecoveryCodesEmail(codes, false); // the keep-set, delivered to the admin inbox
  // codes shown exactly once, immediately after enrollment — downloadable as a file
  res.render('admin/2fa-recovery', {
    meta: { title: 'Your admin recovery codes — FirmLedger', description: '', robots: 'noindex,nofollow' },
    codes,
    dlCsrf: sess.csrf,
  });
});

router.post('/admin3119Musa/2fa-recovery.txt', (req, res) => {
  if (!req.admin) return res.status(403).redirect('/admin3119Musa');
  const codes = String(req.body.codes || '').split(',').map((c) => c.trim()).filter(Boolean);
  if (!codes.length) return res.status(400).send('No recovery codes on this console.');
  const lines = [
    'FirmLedger Admin Recovery Codes',
    '===============================',
    'Two-factor authentication — admin console',
    `Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`,
    '',
    'These one-time codes replace the authenticator app at the /admin3119Musa gate if it',
    'is ever unreachable. Each code works exactly once. Store this file offline.',
    '',
    ...codes.map((c, i) => `${String(i + 1).padStart(2, '0')}. ${c}`),
    '',
    '— FirmLedger',
  ];
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="firmledger-admin-recovery-codes.txt"');
  res.send(lines.join('\n'));
});

router.get('/admin3119Musa/2fa', pendingAdmin, (req, res) => {
  res.render('admin/2fa', {
    meta: { title: 'Two-factor check — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    error: '', pendingCsrf: req.pendingSession.csrf,
    ok: req.query.ok || '',
    notifyEmail: adminNotifyEmail(),
  });
});

router.post('/admin3119Musa/2fa', pendingAdmin, (req, res) => {
  const secret = getSetting('admin_totp_secret', '');
  const input = String(req.body.code || '').trim();
  // 6 digits → TOTP or the emailed one-time code. xxxx-xxxx-xxxx → a recovery code.
  const viaTotp = /^\d{6}$/.test(input) && totp.verifyTotp(secret, input);
  const viaEmail = !viaTotp && adminmail2fa.verifyEmailCode(input).ok;
  const viaRecovery = !viaTotp && !viaEmail && backup.verifyAdminRecovery(input).ok;
  if (!viaTotp && !viaEmail && !viaRecovery) {
    if (twoFaThrottle(req, res)) return twoFaThrottleResponse(res);
    return res.status(403).render('admin/2fa', {
      meta: { title: 'Two-factor check — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
      error: 'That code did not match. Use the 6-digit app code, the 6-digit code we emailed to the admin inbox, or one of your unused recovery codes (xxxx-xxxx-xxxx).',
      pendingCsrf: req.pendingSession.csrf,
      ok: '',
    });
  }
  twofaFails.delete(req.pendingSession.token);
  adminmail2fa.clearEmailCode(); // sign-in finished — any emailed code dies with it
  destroySession(req.pendingSession.token); res.clearCookie('fl_admin2fa', { path: '/' });
  const sess = createSession(null, 'admin');
  setSessionCookie(req, res, ADMIN_COOKIE, sess.token);
  if (viaRecovery) {
    return res.redirect('/admin3119Musa/dashboard?ok=' + encodeURIComponent('Signed in with a recovery code — that code is now spent. Regenerate a fresh set in Settings → Two-factor when you can.'));
  }
  if (viaEmail) {
    return res.redirect('/admin3119Musa/dashboard?ok=' + encodeURIComponent('Signed in with the emailed code — it is now spent. It always pays to keep the authenticator working, too.'));
  }
  res.redirect('/admin3119Musa/dashboard');
});

/* Resend the emailed one-time code (one per minute; each resend invalidates the last). */
router.post('/admin3119Musa/2fa/resend', pendingAdmin, (req, res) => {
  if (!getSetting('admin_totp_secret', '')) return res.redirect('/admin3119Musa');
  if (!adminmail2fa.resendAllowed()) {
    return res.status(429).render('admin/2fa', {
      meta: { title: 'Two-factor check — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
      error: 'Hold on one minute before asking for another email — the most recent code is still on its way (check spam, too).',
      pendingCsrf: req.pendingSession.csrf,
      ok: '',
    });
  }
  sendAdminEmailCode(adminmail2fa.createEmailCode());
  const show = adminNotifyEmail();
  res.redirect('/admin3119Musa/2fa?ok=' + encodeURIComponent(`Fresh code emailed to ${show} — it replaces the last one, valid 10 minutes.`));
});

router.post('/admin3119Musa/logout', (req, res) => {
  destroySession(req.cookies[ADMIN_COOKIE]);
  if (req.cookies.fl_admin2fa) destroySession(req.cookies.fl_admin2fa);
  res.clearCookie(ADMIN_COOKIE, { path: '/' });
  res.clearCookie('fl_admin2fa', { path: '/' });
  res.redirect('/admin3119Musa');
});

/* ---------------- Everything below requires admin ---------------- */
router.use('/admin3119Musa', requireAdmin);

router.get('/admin3119Musa/dashboard', (req, res) => {
  const stats = {
    pending: db.prepare("SELECT COUNT(*) c FROM listings WHERE status='pending'").get().c,
    approved: db.prepare("SELECT COUNT(*) c FROM listings WHERE status='approved'").get().c,
    claimed: db.prepare('SELECT COUNT(*) c FROM listings WHERE claimed=1').get().c,
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    pendingClaims: db.prepare("SELECT COUNT(*) c FROM claims WHERE status='pending'").get().c,
  };
  stats.pendingRemovals = db.prepare("SELECT COUNT(*) c FROM removal_requests WHERE status='pending'").get().c;
  stats.posts = db.prepare('SELECT COUNT(*) c FROM blog_posts').get().c;
  stats.suspended = db.prepare('SELECT COUNT(*) c FROM users WHERE suspended=1').get().c;
  stats.pendingDeletions = db.prepare("SELECT COUNT(*) c FROM deletion_requests WHERE status='pending'").get().c;
  stats.openTickets = db.prepare("SELECT COUNT(*) c FROM tickets WHERE status='open'").get().c;
  stats.sponsored = ad.allSponsored().length;
  stats.careersOpen = db.prepare("SELECT COUNT(*) c FROM careers WHERE status='open'").get().c;
  const recent = db.prepare("SELECT * FROM listings ORDER BY created_at DESC LIMIT 8").all();
  res.render('admin/dashboard', {
    meta: { title: 'Admin — FirmLedger', description: '', robots: 'noindex,nofollow' },
    stats, recent, section: 'dashboard',
  });
});

/* ---------------- Listings management ---------------- */
router.get('/admin3119Musa/listings', (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : '';
  const q = String(req.query.q || '').trim().slice(0, 80);
  const type = String(req.query.type || '').trim();
  const category = String(req.query.category || '').trim();
  const claimed = String(req.query.claimed || '').trim();
  const planF = String(req.query.plan || '').trim();
  const clauses = [];
  const params = [];
  if (status) { clauses.push('l.status = ?'); params.push(status); }
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    clauses.push('(l.name LIKE ? OR l.website LIKE ? OR l.slug LIKE ? OR u.email LIKE ? OR u.name LIKE ?)');
    params.push(like, like, like, like, like);
  }
  if (type) { clauses.push('l.type = ?'); params.push(type); }
  if (category) { clauses.push('l.category = ?'); params.push(category); }
  if (claimed === '1') clauses.push('l.claimed = 1');
  if (claimed === '0') clauses.push('l.claimed = 0');
  if (planF === 'pro') clauses.push("(l.plan='pro' OR u.plan='pro')");
  if (planF === 'free') clauses.push("(l.plan<>'pro' AND (u.plan IS NULL OR u.plan<>'pro'))");
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const listings = db.prepare(
    `SELECT l.*, u.email AS owner_email,
            u.plan AS owner_plan, u.plan_expires_at AS owner_plan_expires
     FROM listings l
     LEFT JOIN users u ON u.id = l.owner_user_id
     ${where} ORDER BY CASE l.status WHEN 'pending' THEN 0 ELSE 1 END, l.created_at DESC LIMIT 400`
  ).all(...params);
  const transferReqs = db.prepare(
    `SELECT r.*, u.email AS user_email, u.name AS user_name,
            a.name AS from_name, a.slug AS from_slug, a.plan_expires_at AS from_expires,
            b.name AS to_name, b.slug AS to_slug
     FROM pro_transfer_requests r
     JOIN users u ON u.id = r.user_id
     JOIN listings a ON a.id = r.from_listing_id
     JOIN listings b ON b.id = r.to_listing_id
     WHERE r.status='pending' ORDER BY r.created_at DESC LIMIT 50`
  ).all();
  res.render('admin/listings', {
    meta: { title: 'Listings — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    listings, status, section: 'listings',
    filters: { q, type, category, claimed, plan: planF, status },
    TYPES, allCats: catLib.all(),
    transferReqs,
    // Record-level Pro override (admin boost) for the Plan column; perks also
    // derive from the owner's account plan — shown via owner_plan on the view.
    planOf: (l) =>
      l.plan === 'pro'
        ? (l.plan_expires_at ? `record boost · until ${l.plan_expires_at}` : 'record boost · lifetime')
        :   l.owner_plan === 'pro'
          ? (l.owner_plan_expires_at ? `owner Pro · until ${l.owner_plan_expires_at}` : 'owner Pro · lifetime')
          : 'free',
  });
});

router.post('/admin3119Musa/listings/:id/approve', (req, res) => {
  const l = db.prepare('SELECT * FROM listings WHERE id=?').get(req.params.id);
  if (!l) return res.redirect('/admin3119Musa/listings');
  const firstApproval = l.status !== 'approved';
  db.prepare("UPDATE listings SET status='approved', last_verified_at=?, updated_at=datetime('now') WHERE id=?")
    .run(new Date().toISOString(), l.id);
  if (firstApproval) {
    const catSlug = (db.prepare('SELECT slug FROM categories WHERE name = ?').get(l.category) || {}).slug;
    submitForIndexing([`/listing/${l.slug}`, catSlug ? `/directory/c/${catSlug}` : null].filter(Boolean));
  }
  if (firstApproval && l.owner_user_id) {
    notify.notifyUser(l.owner_user_id, {
      kind: 'listing',
      title: `${l.name} is live`,
      body: 'Your listing passed review and is now public in the directory.',
      url: `/listing/${l.slug}`,
    });
  }
  res.redirect(`/admin3119Musa/listings?ok=${encodeURIComponent(`${l.name} approved and pushed to search engines.`)}`);
});

router.post('/admin3119Musa/listings/:id/reject', (req, res) => {
  const l = db.prepare('SELECT * FROM listings WHERE id=?').get(req.params.id);
  db.prepare("UPDATE listings SET status='rejected', updated_at=datetime('now') WHERE id=?").run(req.params.id);
  if (l && l.owner_user_id) {
    notify.notifyUser(l.owner_user_id, {
      kind: 'listing',
      title: `${l.name} was not approved`,
      body: 'Update the listing and resubmit — common reasons are incomplete contact details or a duplicate record.',
      url: `/dashboard/listings/${l.id}/edit`,
    });
  }
  res.redirect('/admin3119Musa/listings?ok=' + encodeURIComponent('Listing rejected.'));
});

function listingIdsFromBody(body) {
  const raw = body.ids;
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return [...new Set(arr.map((x) => Number(x)).filter((n) => n > 0))];
}

router.post('/admin3119Musa/listings/bulk', (req, res) => {
  const ids = listingIdsFromBody(req.body);
  const act = String(req.body.bulk_action || '');
  if (!ids.length) return res.redirect('/admin3119Musa/listings?err=' + encodeURIComponent('Select at least one listing.'));
  if (act !== 'approve' && act !== 'reject') {
    return res.redirect('/admin3119Musa/listings?err=' + encodeURIComponent('Choose Approve or Reject.'));
  }
  let n = 0;
  for (const id of ids) {
    const l = db.prepare('SELECT * FROM listings WHERE id=?').get(id);
    if (!l || l.status !== 'pending') continue;
    if (act === 'approve') {
      db.prepare("UPDATE listings SET status='approved', last_verified_at=?, updated_at=datetime('now') WHERE id=?")
        .run(new Date().toISOString(), l.id);
      const catSlug = (db.prepare('SELECT slug FROM categories WHERE name = ?').get(l.category) || {}).slug;
      submitForIndexing([`/listing/${l.slug}`, catSlug ? `/directory/c/${catSlug}` : null].filter(Boolean));
      if (l.owner_user_id) {
        notify.notifyUser(l.owner_user_id, {
          kind: 'listing', title: `${l.name} is live`,
          body: 'Your listing passed review and is now public in the directory.',
          url: `/listing/${l.slug}`,
        });
      }
    } else {
      db.prepare("UPDATE listings SET status='rejected', updated_at=datetime('now') WHERE id=?").run(l.id);
      if (l.owner_user_id) {
        notify.notifyUser(l.owner_user_id, {
          kind: 'listing', title: `${l.name} was not approved`,
          body: 'Update the listing and resubmit from your dashboard.',
          url: `/dashboard/listings/${l.id}/edit`,
        });
      }
    }
    n += 1;
  }
  res.redirect('/admin3119Musa/listings?ok=' + encodeURIComponent(
    n ? `${n} listing${n === 1 ? '' : 's'} ${act === 'approve' ? 'approved' : 'rejected'}.` : 'No pending listings in that selection.'
  ));
});

router.post('/admin3119Musa/listings/:id/feature', (req, res) => {
  const l = db.prepare('SELECT featured FROM listings WHERE id=?').get(req.params.id);
  if (l) db.prepare('UPDATE listings SET featured=? WHERE id=?').run(l.featured ? 0 : 1, req.params.id);
  res.redirect('/admin3119Musa/listings?ok=' + encodeURIComponent(l && l.featured ? 'Removed from featured.' : 'Marked as featured.'));
});

router.post('/admin3119Musa/listings/:id/delete', (req, res) => {
  const l = db.prepare('SELECT logo_url FROM listings WHERE id=?').get(req.params.id);
  if (l) deleteLogo(l.logo_url);
  db.prepare('DELETE FROM listings WHERE id=?').run(req.params.id);
  res.redirect('/admin3119Musa/listings?ok=' + encodeURIComponent('Listing deleted.'));
});

/* ---- Per-listing Pro boost (plan override on a specific listing) ---- */
router.post('/admin3119Musa/listings/:id/plan', (req, res) => {
  const l = db.prepare('SELECT id, name, plan, plan_expires_at FROM listings WHERE id=?').get(req.params.id);
  if (!l) return res.redirect('/admin3119Musa/listings');
  const act = String(req.body.plan_action || '');
  const ok = (m) => res.redirect('/admin3119Musa/listings?ok=' + encodeURIComponent(m));
  if (act === 'grant') {
    // 30 days on this record only, stacking on any unexpired record-level time.
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const cur = l.plan === 'pro' && l.plan_expires_at && l.plan_expires_at >= today ? new Date(l.plan_expires_at) : now;
    const expiry = new Date(Math.max(cur.getTime(), now.getTime()) + 30 * 24 * 3600 * 1000);
    db.prepare('UPDATE listings SET plan=?, plan_expires_at=? WHERE id=?')
      .run('pro', expiry.toISOString().slice(0, 10), l.id);
    return ok(`Pro boost granted to ${l.name} (30 days, until ${expiry.toISOString().slice(0, 10)}).`);
  }
  if (act === 'lifetime') {
    db.prepare('UPDATE listings SET plan=?, plan_expires_at=? WHERE id=?').run('pro', '', l.id);
    return ok(`Lifetime Pro boost granted to ${l.name}.`);
  }
  if (act === 'revoke') {
    db.prepare("UPDATE listings SET plan='free', plan_expires_at='' WHERE id=?").run(l.id);
    return ok(`Listing-level Pro revoked — ${l.name} keeps perks only if the owner's account is Pro.`);
  }
  res.redirect('/admin3119Musa/listings');
});

/* ---- Account-level Pro: grant / lifetime / revoke on a USER ----------------
   Pro is account-scoped: one subscription unlocks full-details viewing for the
   account and applies the listing perks (tick, Featured, badge) to every
   listing the account owns. */
router.post('/admin3119Musa/users/:id/plan', (req, res) => {
  const u = db.prepare('SELECT id, name, email FROM users WHERE id=?').get(req.params.id);
  if (!u) return backToUsers(req, res, 'User not found.', 'err');
  const act = String(req.body.plan_action || '');
  if (act === 'grant' || act === 'lifetime') {
    const r = grantUserPro(u.id, act === 'lifetime' ? null : 30);
    const expiry = r && r.expiry ? r.expiry.toISOString().slice(0, 10) : null;
    const what = expiry ? `FirmLedger Pro granted to ${u.name} (${u.email}) until ${expiry}.`
                        : `Lifetime FirmLedger Pro granted to ${u.name} (${u.email}).`;
    const { siteUrl: su8, escHtml: eh8 } = require('../lib/util');
    sendBranded(u.email, `You've been upgraded to FirmLedger Pro`, {
      kicker: 'Pro activated',
      title: `Welcome to FirmLedger Pro${u.name ? `, ${eh8(u.name)}` : ''}`,
      preheader: 'FirmLedger Pro is now active on your account.',
      alert: expiry ? `FirmLedger Pro is active on <b>${eh8(u.email)}</b> until <b>${expiry}</b>.` : `<b>Lifetime</b> FirmLedger Pro is active on <b>${eh8(u.email)}</b>.`,
      alertTone: 'ok',
      paragraphs: [
        'Every listing in the directory is now fully unlocked for you — business email, phone, website, events timeline and relationship graph included.',
        'Any listings you own gain the blue verified tick next to the company name, Featured placement on the homepage, the premium gold badge, and priority admin verification & trust review.',
      ],
      cta: { label: 'Explore the directory', url: su8('/directory') },
      note: `Access details: ${expiry ? `Pro renews until <b>${expiry}</b>` : '<b>Lifetime access</b> — no renewal required'}.`,
    }).catch(() => {});
    return backToUsers(req, res, what);
  }
  if (act === 'revoke') {
    revokeUserPro(u.id);
    const { siteUrl: su9, escHtml: eh9 } = require('../lib/util');
    sendBranded(u.email, 'Your FirmLedger Pro access has ended', {
      kicker: 'Plan update',
      title: 'Your Pro access has ended',
      preheader: 'FirmLedger Pro access on your account has ended.',
      alert: `FirmLedger Pro access on <b>${eh9(u.email)}</b> has ended. Your account is back on the Free plan.`,
      alertTone: 'info',
      paragraphs: [
        'You can still browse the directory, submit listings and manage your records. Upgrade again at any time to unlock full listing details, verified ticks and Featured placement.',
      ],
      cta: { label: 'Upgrade to Pro', url: su9('/dashboard/upgrade') },
      note: 'This change was made by FirmLedger support. If you believe this is an error, reply to this email.',
    }).catch(() => {});
    return backToUsers(req, res, `Pro revoked — ${u.name} (${u.email}) is back on Free.`);
  }
  backToUsers(req, res, 'Choose a plan action first.', 'err');
});

/* ---- Admin listing editor (trust fields: sources, confidence, events) ---- */
router.get('/admin3119Musa/listings/:id/edit', (req, res) => {
  const l = db.prepare('SELECT * FROM listings WHERE id=?').get(req.params.id);
  if (!l) return res.redirect('/admin3119Musa/listings');
  let sources = [];
  try { sources = JSON.parse(l.sources); } catch {}
  const events = db.prepare('SELECT * FROM listing_events WHERE listing_id=? ORDER BY event_date ASC').all(l.id);
  const ownerOptions = db.prepare(
    'SELECT id, email, name FROM users ORDER BY COALESCE(nullif(name,\'\'), email) LIMIT 500'
  ).all();
  res.render('admin/edit', {
    meta: { title: `Edit ${l.name} — FirmLedger Admin`, description: '', robots: 'noindex,nofollow' },
    l, sources: sources.join('\n'), events,
    TYPES, CATEGORIES, SIZES, COUNTRIES, section: 'listings', errors: [],
    allCats: catLib.all(),
    relations: graphLib.buildGraph(l).items,
    REL_TYPES: graphLib.REL_TYPES,
    ownerOptions, ok: req.query.ok || '', err: req.query.err || '',
  });
});

router.post('/admin3119Musa/listings/:id/edit', async (req, res) => {
  const l = db.prepare('SELECT * FROM listings WHERE id=?').get(req.params.id);
  if (!l) return res.redirect('/admin3119Musa/listings');
  if (!require('../lib/session').validCsrf(req)) {
    return res.status(403).redirect(`/admin3119Musa/listings/${l.id}/edit`);
  }
  const b = req.body;
  const sources = JSON.stringify(parseLines(b.sources));
  const category = catLib.ensure(b.category).name;

  // Logo: remove > pasted URL > keep
  let logo = normalizeUrl(b.logo_url || '');
  if (b.remove_logo === '1') logo = '';
  if (!logo && b.remove_logo !== '1') logo = l.logo_url || '';

  db.prepare(
    `UPDATE listings SET name=?, tagline=?, description=?, type=?, category=?, website=?, email=?, phone=?,
       country=?, city=?, region=?, address=?, logo_url=?, founded=?, size=?, tags=?, sources=?, confidence=?,
       status=?, featured=?, claimed=?, last_verified_at=?, updated_at=datetime('now')
     WHERE id=?`
  ).run(
    (b.name || '').trim(), (b.tagline || '').trim(), (b.description || '').trim(),
    TYPES.some((t) => t.value === b.type) ? b.type : l.type,
    category,
    normalizeUrl(b.website || ''), (b.email || '').trim(), (b.phone || '').trim(),
    (b.country || '').trim(), (b.city || '').trim(), (b.region || '').trim(), (b.address || '').trim(),
    logo, (b.founded || '').trim(), (b.size || '').trim(),
    (b.tags || '').trim(), sources,
    Math.max(0, Math.min(97, parseInt(b.confidence, 10) || l.confidence)),
    ['pending', 'approved', 'rejected'].includes(b.status) ? b.status : l.status,
    b.featured === '1' ? 1 : 0, b.claimed === '1' ? 1 : 0,
    (b.last_verified_at || '').trim() || null,
    l.id
  );
  submitForIndexing([`/listing/${l.slug}`]);
  res.redirect(`/admin3119Musa/listings/${l.id}/edit?ok=` + encodeURIComponent('Saved.'));
});

/* Timeline events */
router.post('/admin3119Musa/listings/:id/events', (req, res) => {
  const title = (req.body.title || '').trim().slice(0, 200);
  if (title) {
    db.prepare('INSERT INTO listing_events (listing_id, event_date, kind, title) VALUES (?,?,?,?)')
      .run(req.params.id, (req.body.event_date || '').trim(), (req.body.kind || 'milestone').slice(0, 30), title);
  }
  res.redirect(`/admin3119Musa/listings/${req.params.id}/edit#timeline`);
});

router.post('/admin3119Musa/events/:eid/delete', (req, res) => {
  const e = db.prepare('SELECT * FROM listing_events WHERE id=?').get(req.params.eid);
  if (e) {
    db.prepare('DELETE FROM listing_events WHERE id=?').run(e.id);
    return res.redirect(`/admin3119Musa/listings/${e.listing_id}/edit#timeline`);
  }
  res.redirect('/admin3119Musa/listings');
});

/* ---- Relationships (admin) ---- */
router.post('/admin3119Musa/listings/:id/relations', (req, res) => {
  const l = db.prepare('SELECT id FROM listings WHERE id=?').get(req.params.id);
  if (!l) return res.redirect('/admin3119Musa/listings');
  const r = graphLib.addRelationship(l.id, req.body.rel_type, req.body.target, req.body.note);
  res.redirect(`/admin3119Musa/listings/${l.id}/edit?` + (r.error
    ? `err=${encodeURIComponent(r.error)}#relations`
    : `ok=${encodeURIComponent('Relationship added.')}#relations`));
});

router.post('/admin3119Musa/relations/:rid/delete', (req, res) => {
  const rel = db.prepare('SELECT * FROM relationships WHERE id=?').get(req.params.rid);
  const back = req.body.back || '/admin3119Musa/listings';
  if (rel) {
    graphLib.removeRelationship(rel.id);
    return res.redirect(`/admin3119Musa/listings/${rel.listing_id}/edit#relations`);
  }
  res.redirect(back.startsWith('/admin3119Musa') ? back : '/admin3119Musa/listings');
});

/* ---------------- Categories ---------------- */
router.get('/admin3119Musa/categories', (req, res) => {
  const cats = catLib.withCounts().map((c) => ({ ...c, in_use: catLib.usageCount(c.name) }));
  res.render('admin/categories', {
    meta: { title: 'Categories — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    cats, section: 'categories',
  });
});

router.post('/admin3119Musa/categories', (req, res) => {
  const r = catLib.ensure(req.body.name || '');
  res.redirect('/admin3119Musa/categories?ok=' + encodeURIComponent(
    r.created ? `Category “${r.name}” created.` : `“${r.name}” already exists — duplicates are merged automatically.`
  ));
});

router.post('/admin3119Musa/categories/:id/rename', (req, res) => {
  const cat = db.prepare('SELECT * FROM categories WHERE id=?').get(req.params.id);
  if (!cat) return res.redirect('/admin3119Musa/categories');
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) return res.redirect('/admin3119Musa/categories?err=' + encodeURIComponent('Name required.'));
  const clash = db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND id <> ?').get(name, cat.id);
  if (clash) return res.redirect('/admin3119Musa/categories?err=' + encodeURIComponent(`“${name}” already exists — use merge instead.`));
  const slug = require('../lib/util').slugify(name);
  const slugClash = db.prepare('SELECT id FROM categories WHERE slug = ? AND id <> ?').get(slug, cat.id);
  db.prepare('UPDATE listings SET category=? WHERE category=?').run(name, cat.name);
  db.prepare('UPDATE categories SET name=?, slug=? WHERE id=?').run(name, slugClash ? cat.slug : slug, cat.id);
  res.redirect('/admin3119Musa/categories?ok=' + encodeURIComponent(`Renamed to “${name}” (listings moved too).`));
});

router.post('/admin3119Musa/categories/:id/delete', (req, res) => {
  const cat = db.prepare('SELECT * FROM categories WHERE id=?').get(req.params.id);
  if (!cat) return res.redirect('/admin3119Musa/categories');
  const inUse = catLib.usageCount(cat.name);
  db.prepare("UPDATE listings SET category='Other' WHERE category=?").run(cat.name);
  // make sure "Other" exists
  catLib.ensure('Other');
  db.prepare('DELETE FROM categories WHERE id=?').run(cat.id);
  res.redirect('/admin3119Musa/categories?ok=' + encodeURIComponent(
    inUse ? `Deleted — ${inUse} listing(s) were moved to “Other”.` : 'Category deleted.'
  ));
});

/* ---------------- Claims review ---------------- */
router.get('/admin3119Musa/claims', (req, res) => {
  const claims = db.prepare(
    `SELECT c.*, l.name AS listing_name, l.slug AS listing_slug, u.email AS user_email
     FROM claims c JOIN listings l ON l.id=c.listing_id JOIN users u ON u.id=c.user_id
     ORDER BY CASE c.status WHEN 'pending' THEN 0 ELSE 1 END, c.created_at DESC LIMIT 200`
  ).all();
  res.render('admin/claims', {
    meta: { title: 'Claims — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    claims, section: 'claims',
  });
});

router.post('/admin3119Musa/claims/:id/recheck', async (req, res) => {
  const c = db.prepare('SELECT * FROM claims WHERE id=?').get(req.params.id);
  if (c && c.status === 'pending') {
    const result = await runCheck(c.method, c.domain, c.token);
    if (result.ok) {
      const l = db.prepare('SELECT * FROM listings WHERE id=?').get(c.listing_id);
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(c.user_id);
      if (l && u) finalizeVerifiedClaim(c, l, u);
      return res.redirect('/admin3119Musa/claims?ok=' + encodeURIComponent(`Verified: ${result.detail}`));
    }
    return res.redirect('/admin3119Musa/claims?err=' + encodeURIComponent(`Not verified yet: ${result.detail}`));
  }
  res.redirect('/admin3119Musa/claims');
});

router.post('/admin3119Musa/claims/:id/reject', (req, res) => {
  const c = db.prepare('SELECT * FROM claims WHERE id=?').get(req.params.id);
  db.prepare("UPDATE claims SET status='rejected' WHERE id=?").run(req.params.id);
  if (c && c.user_id) {
    const u = db.prepare('SELECT name, email FROM users WHERE id=?').get(c.user_id);
    const l = db.prepare('SELECT name FROM listings WHERE id=?').get(c.listing_id);
    if (u) {
      const { siteUrl: su4, escHtml: eh4 } = require('../lib/util');
      sendBranded(u.email, `Ownership claim update — ${l ? l.name : 'your listing'}`, {
        kicker: 'Claim review',
        title: 'Your ownership claim was not verified',
        preheader: `Your ownership claim for ${l ? l.name : 'a listing'} could not be verified.`,
        alert: `Your ownership claim for <b>${l ? eh4(l.name) : 'the listing'}</b> was reviewed and could not be verified with the evidence provided.`,
        alertTone: 'warn',
        paragraphs: [
          'Ownership is verified via a DNS token, website tag or email on the business domain. Make sure the verification token is correctly placed in your domain DNS record or published on your website, then submit a fresh claim from your dashboard.',
        ],
        cta: { label: 'Submit a new claim', url: su4('/dashboard/claims') },
        note: 'If you believe this is a mistake, contact <a href="mailto:support@firmledger.co.ke" style="color:#1D4ED8;">support@firmledger.co.ke</a> with your business registration details.',
      }).catch(() => {});
      notify.notifyUser(u.id, {
        kind: 'claim',
        title: 'Ownership claim was not verified',
        body: l ? `Your claim on ${l.name} could not be verified.` : 'Your ownership claim could not be verified.',
        url: '/dashboard',
      });
    }
  }
  res.redirect('/admin3119Musa/claims?ok=' + encodeURIComponent('Claim rejected.'));
});

/* ---------------- Users: export/import, backup, delete ---------------- */

/** GET — every user + their details as a .firmledger file (aligned, importable). */
router.get('/admin3119Musa/users/export.firmledger', (req, res) => {
  const body = backup.buildExport();
  const stamp = new Date().toISOString().slice(0, 10);
  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="firmledger-users-${stamp}.firmledger"`);
  res.send(body);
});

/** GET — full backup of every user and everything attached to their account. */
router.get('/admin3119Musa/users/backup.firmledger', (req, res) => {
  const body = backup.buildBackup();
  setSetting('last_backup_at', new Date().toISOString());
  const stamp = new Date().toISOString().slice(0, 10);
  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="firmledger-backup-${stamp}.firmledger"`);
  res.send(body);
});

/** POST — import a previously exported .firmledger file. */
router.post('/admin3119Musa/users/import', backup.backupField('backup_file'), (req, res) => {
  if (!require('../lib/session').validCsrf(req)) return res.status(403).redirect('/admin3119Musa/users');
  if (req.uploadError) return usersFail(req, res, req.uploadError);
  if (!req.file) return usersFail(req, res, 'Choose a .firmledger file to import.');
  const fname = String(req.file.originalname || '').toLowerCase();
  if (!fname.endsWith('.firmledger') && !fname.endsWith('.json')) {
    return usersFail(req, res, 'That file is not a FirmLedger export — choose the .firmledger file you downloaded from the admin console.');
  }
  const r = backup.importUsers(req.file.buffer.toString('utf8'));
  if (!r.ok) return usersFail(req, res, r.error);
  backToUsers(req, res,
    `Import complete — ${r.created} created, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped (invalid rows)` : ''}.`
  );
});

/** POST — permanently delete a user + everything attributable to their account. */
router.post('/admin3119Musa/users/:id/delete', (req, res) => {
  if (!require('../lib/session').validCsrf(req)) return res.status(403).redirect('/admin3119Musa/users');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return usersFail(req, res, 'User not found.');
  sendBranded(u.email, 'Your FirmLedger account has been deleted', {
    kicker: 'Account deleted',
    title: 'Your account has been deleted',
    preheader: 'Your FirmLedger account and personal data have been permanently removed.',
    alert: 'Your FirmLedger account has been permanently deleted. Personal data, sessions and tickets are gone.',
    alertTone: 'warn',
    paragraphs: [
      'Listings you submitted remain on the public ledger as factual records, with your name removed as owner. If this was a mistake, contact support@firmledger.co.ke — we cannot restore a deleted account.',
    ],
    cta: { label: 'Visit FirmLedger', url: siteUrl('/') },
  }).catch(() => {});
  db.prepare("UPDATE deletion_requests SET status='completed', resolved_at=datetime('now') WHERE user_id=? AND status='pending'").run(u.id);
  const r = backup.deleteUserCascade(Number(req.params.id));
  if (!r.ok) return usersFail(req, res, r.error);
  backToUsers(req, res, `${r.name} (${r.email}) was permanently deleted and emailed.`);
});

/* ---------------- Users ---------------- */
/** Redirect back to the users list, keeping the active search/filter alive. */
function backToUsers(req, res, msg, kind) {
  const keep = [];
  const q = String((req.body && req.body.uq) || (req.query.q || '')).trim().slice(0, 80);
  const f = String((req.body && req.body.uf) || (req.query.f || '')).trim();
  if (q) keep.push('q=' + encodeURIComponent(q));
  if (f) keep.push('f=' + encodeURIComponent(f));
  if (msg) keep.push(`${kind || 'ok'}=` + encodeURIComponent(msg));
  return res.redirect('/admin3119Musa/users' + (keep.length ? '?' + keep.join('&') : ''));
}
/** Error variant used by routes that only care about the failure message. */
function usersFail(req, res, error) { return backToUsers(req, res, error, 'err'); }

const USER_FILTERS = { pro: 'pro', free: 'free', suspended: 'suspended', active: 'active' };

router.get('/admin3119Musa/users', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const f = USER_FILTERS[String(req.query.f || '').trim()] || '';
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const where = [];
  const args = [];
  if (q) { where.push('(u.email LIKE ? OR u.name LIKE ?)'); args.push(like, like); }
  if (f === 'pro') where.push(`u.plan='pro' AND (u.plan_expires_at='' OR u.plan_expires_at IS NULL OR u.plan_expires_at >= date('now'))`);
  if (f === 'free') where.push(`NOT (u.plan='pro' AND (u.plan_expires_at='' OR u.plan_expires_at IS NULL OR u.plan_expires_at >= date('now')))`);
  if (f === 'suspended') where.push('u.suspended=1');
  if (f === 'active') where.push('u.suspended=0');
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const users = db.prepare(
    `SELECT u.*, (SELECT COUNT(*) FROM listings l WHERE l.owner_user_id = u.id) AS listing_count
     FROM users u ${sqlWhere} ORDER BY u.created_at DESC LIMIT 500`
  ).all(...args);
  const totalUsers = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const deletionReqs = db.prepare(
    `SELECT d.*, u.email, u.name FROM deletion_requests d JOIN users u ON u.id = d.user_id
     WHERE d.status='pending' ORDER BY d.created_at DESC`
  ).all();
  res.render('admin/users', {
    meta: { title: 'Users — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    users, section: 'users',
    isProUser,
    q, f, totalUsers,
    deletionReqs,
    ok: req.query.ok || '', err: req.query.err || '',
  });
});

/* ---------------- Plan offers (admin-managed pricing) ---------------- */
router.get('/admin3119Musa/plans', (req, res) => {
  res.render('admin/plans', {
    meta: { title: 'Plan offers — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    plans: allPlans(false),
    ok: (req.query.ok !== undefined ? String(req.query.ok) : ''),
    err: (req.query.err !== undefined ? String(req.query.err) : ''),
    section: 'plans',
  });
});

router.post('/admin3119Musa/plans', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const price = parseFloat(String(req.body.price_usd || '').replace(',', '.'));
  const days = Math.round(Number(req.body.duration_days || 0));
  const blurb = String(req.body.blurb || '').trim().slice(0, 240);
  const sort = Math.round(Number(req.body.sort || 0)) || (allPlans(false).length + 1);
  const back = (q) => res.redirect('/admin3119Musa/plans?' + q);
  if (!name) return back('err=' + encodeURIComponent('The offer needs a name.'));
  if (!(price > 0) || price > 1e6) return back('err=' + encodeURIComponent('Enter a valid price above 0.'));
  if (!(days >= 1) || days > 3650) return back('err=' + encodeURIComponent('Duration must be between 1 and 3650 days.'));
  db.prepare('INSERT INTO plans (name, blurb, price_cents, currency, duration_days, active, sort) VALUES (?,?,?,?,?,1,?)')
    .run(name, blurb, Math.round(price * 100), 'USD', days, sort);
  return back('ok=' + encodeURIComponent(`Offer "${name}" created — $${price.toFixed(2)} / ${days} days.`));
});

router.post('/admin3119Musa/plans/:id/toggle', (req, res) => {
  const p = getPlan(req.params.id);
  if (p) db.prepare('UPDATE plans SET active=? WHERE id=?').run(p.active ? 0 : 1, p.id);
  res.redirect('/admin3119Musa/plans?ok=' + encodeURIComponent(p ? `"${p.name}" is now ${p.active ? 'hidden' : 'live'} on /pricing.` : 'Offer not found.'));
});

router.post('/admin3119Musa/plans/:id/delete', (req, res) => {
  const p = getPlan(req.params.id);
  // Offers referenced by payments are kept for history — deactivate instead.
  const refs = p ? db.prepare('SELECT COUNT(*) c FROM payments WHERE plan_id=?').get(p.id).c : 0;
  if (p && refs > 0) {
    db.prepare('UPDATE plans SET active=0 WHERE id=?').run(p.id);
    return res.redirect('/admin3119Musa/plans?ok=' + encodeURIComponent(`"${p.name}" has payments attached — deactivated instead of deleted (history preserved).`));
  }
  if (p) db.prepare('DELETE FROM plans WHERE id=?').run(p.id);
  res.redirect('/admin3119Musa/plans?ok=' + encodeURIComponent(p ? `"${p.name}" deleted.` : 'Offer not found.'));
});

/* ---------------- Free trials (Admin → Pricing) ----------------
   Lives inside the admin area only, behind the same secret-path + session
   guard as every other console page (router.use('/admin3119Musa', requireAdmin)). */
function pricingPage(req, res) {
  const users = db.prepare(
    `SELECT id, email, name, plan, plan_expires_at, subscription_status,
            trial_started_at, trial_expires_at, trial_days
       FROM users ORDER BY created_at DESC LIMIT 50`
  ).all();
  res.render('admin/pricing', {
    meta: { title: 'Pricing & trials — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    section: 'pricing',
    users,
    statusOf: plans.statusOf,
    trialDaysRemaining: plans.trialDaysRemaining,
    TRIAL_DEFAULT_DAYS: plans.TRIAL_DEFAULT_DAYS,
    TRIAL_MAX_DAYS: plans.TRIAL_MAX_DAYS,
    TRIAL_SIGNUP_DAYS: plans.TRIAL_SIGNUP_DAYS,
    prefillEmail: String(req.query.email || ''),
    ok: req.query.ok || '', err: req.query.err || '',
  });
}

function grantTrial(req, res) {
  const back = (q) => res.redirect('/admin3119Musa/pricing?' + q);
  const email = String(req.body.email || '').trim().toLowerCase();
  const days = Math.round(Number(req.body.days || plans.TRIAL_DEFAULT_DAYS));
  if (!email) return back('err=' + encodeURIComponent('Enter the account email address.'));
  if (!(days >= 1) || days > plans.TRIAL_MAX_DAYS) {
    return back('err=' + encodeURIComponent(`Trial length must be between 1 and ${plans.TRIAL_MAX_DAYS} days.`));
  }
  const u = db.prepare('SELECT id, email, name FROM users WHERE email = ?').get(email);
  if (!u) return back('err=' + encodeURIComponent(`No account found for ${email}.`));
  const r = plans.startTrial(u.id, days);
  if (!r.ok) return back('err=' + encodeURIComponent(r.error));
  notify.notifyUser(u.id, {
    kind: 'billing',
    title: `Your ${days}-day FirmLedger Pro trial is active`,
    body: `A free trial was activated on your account. It runs until ${String(r.expiresAt).slice(0, 10)}.`,
    url: '/dashboard/upgrade',
  });
  require('../lib/trialmail').sendTrialActivated(u, { days, expiresAt: r.expiresAt }).catch(() => {});
  return back('ok=' + encodeURIComponent(`${days}-day trial granted to ${email} (ends ${String(r.expiresAt).slice(0, 10)}).`));
}

function revokeTrialRoute(req, res) {
  const back = (q) => res.redirect('/admin3119Musa/pricing?' + q);
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = email
    ? db.prepare('SELECT id, email FROM users WHERE email = ?').get(email)
    : db.prepare('SELECT id, email FROM users WHERE id = ?').get(Number(req.body.user_id || 0));
  if (!u) return back('err=' + encodeURIComponent('No account found for that user.'));
  const r = plans.revokeTrial(u.id);
  if (!r.ok) return back('err=' + encodeURIComponent(r.error));
  return back('ok=' + encodeURIComponent(`Trial revoked for ${u.email}.`));
}

router.get('/admin3119Musa/pricing', pricingPage);
router.post('/admin3119Musa/pricing/free-trial', grantTrial);
router.post('/admin3119Musa/pricing/revoke-trial', revokeTrialRoute);

/* ---------------- Settings ---------------- */
router.get('/admin3119Musa/settings', (req, res) => {
  const payments = db.prepare(
    `SELECT p.*, l.name AS listing_name, pl.name AS plan_name, u.name AS user_name, u.email AS user_email
     FROM payments p
     LEFT JOIN listings l ON l.id = p.listing_id
     LEFT JOIN plans pl ON pl.id = p.plan_id
     LEFT JOIN users u ON u.id = p.user_id
     ORDER BY p.created_at DESC LIMIT 100`
  ).all();
  res.render('admin/settings', {
    meta: { title: 'Settings — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    settings: {
      auto_approve: getSetting('auto_approve', '0'),
      indexing_enabled: getSetting('indexing_enabled', '1'),
      indexnow_key: getIndexNowKey(),
      base_url: process.env.BASE_URL || '',
      smtp_configured: mailConfigured(),
      smtp_env: Boolean(process.env.SMTP_URL || process.env.MAIL_HOST),
      smtp_host: getSetting('smtp_host', ''),
      smtp_port: getSetting('smtp_port', '587'),
      smtp_user: getSetting('smtp_user', ''),
      smtp_pass_set: Boolean(getSetting('smtp_pass', '')),
      smtp_from: getSetting('smtp_from', ''),
      smtp_secure: getSetting('smtp_secure', '0'),
      totp_enrolled: Boolean(getSetting('admin_totp_secret', '')),
      recovery_remaining: (() => { try { return JSON.parse(getSetting('admin_recovery_codes', '[]')).filter((c) => !c.used).length; } catch { return 0; } })(),
      paypal_env: Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
      paypal_key_set: paypal.configured(),
      paypal_client_id_set: Boolean(process.env.PAYPAL_CLIENT_ID || getSetting('paypal_client_id', '')),
      paypal_mode: paypal.mode(),
      nl_subscribers: require('../lib/newsletter').subCount(true),
      nl_last_sent: getSetting('newsletter_last_sent', '') || 'never',
      nl_cadence: require('../lib/newsletter').digestCadence(),
      jobs_open: db.prepare("SELECT COUNT(*) c FROM jobs WHERE status='open'").get().c,
      favorites_total: db.prepare('SELECT COUNT(*) c FROM favorites').get().c,
      ad_packages: db.prepare('SELECT COUNT(*) c FROM ad_packages WHERE active=1').get().c,
      sponsored_active: ad.allSponsored().length,
      careers_open: db.prepare("SELECT COUNT(*) c FROM careers WHERE status='open'").get().c,
    },
    payments,
    section: 'settings',
    ...require('./adminops').mailLocals(),
  });
});

router.post('/admin3119Musa/settings', (req, res) => {
  setSetting('auto_approve', req.body.auto_approve === '1' ? '1' : '0');
  setSetting('indexing_enabled', req.body.indexing_enabled === '1' ? '1' : '0');
  // Payments (PayPal) — credentials only updated when non-empty values are pasted;
  // environment variables always win at runtime.
  if (!process.env.PAYPAL_CLIENT_ID) {
    const cid = String(req.body.paypal_client_id || '').trim();
    if (cid) setSetting('paypal_client_id', cid);
    if (String(req.body.paypal_client_id_clear || '') === '1') setSetting('paypal_client_id', '');
  }
  if (!process.env.PAYPAL_CLIENT_SECRET) {
    const cs = String(req.body.paypal_client_secret || '').trim();
    if (cs) setSetting('paypal_client_secret', cs);
    if (String(req.body.paypal_client_secret_clear || '') === '1') setSetting('paypal_client_secret', '');
  }
  if (!process.env.PAYPAL_MODE) {
    const m = String(req.body.paypal_mode || '').trim().toLowerCase();
    if (m === 'sandbox' || m === 'live') setSetting('paypal_mode', m);
  }
  // Email — SMTP from Admin → Settings. env (SMTP_URL or MAIL_*) always wins.
  // Only touch SMTP keys when this POST actually included them (the Payments
  // form and the SMTP form are separate — saving one must not wipe the other).
  if (!process.env.SMTP_URL && !process.env.MAIL_HOST && req.body.smtp_host !== undefined) {
    setSetting('smtp_host', String(req.body.smtp_host || '').trim().slice(0, 200));
    setSetting('smtp_port', String(req.body.smtp_port || '').trim().slice(0, 6));
    setSetting('smtp_user', String(req.body.smtp_user || '').trim().slice(0, 200));
    if (String(req.body.smtp_pass || '').trim()) setSetting('smtp_pass', String(req.body.smtp_pass || '').trim().slice(0, 500));
    if (String(req.body.smtp_pass_clear || '') === '1') setSetting('smtp_pass', '');
    setSetting('smtp_secure', req.body.smtp_secure === '1' ? '1' : '0');
  }
  if (req.body.smtp_from !== undefined) {
    setSetting('smtp_from', String(req.body.smtp_from || '').trim().slice(0, 200));
  }
  res.redirect('/admin3119Musa/settings?ok=' + encodeURIComponent('Settings saved.'));
});

/* Digest automation cadence: daily / weekly / monthly. */
router.post('/admin3119Musa/settings/newsletter-cadence', (req, res) => {
  const c = String(req.body.cadence || '').trim();
  if (!['daily', 'weekly', 'monthly'].includes(c)) {
    return res.redirect('/admin3119Musa/settings?err=' + encodeURIComponent('Unknown cadence.'));
  }
  setSetting('newsletter_cadence', c);
  const when = { daily: 'every day', weekly: 'every week', monthly: 'every month' }[c];
  res.redirect('/admin3119Musa/settings?ok=' + encodeURIComponent(`Digest automation set to ${when} — the hourly checker sends whenever a ${c} window has passed.`));
});

/* Force-send the weekly newsletter digest. */
router.post('/admin3119Musa/settings/newsletter-send', async (req, res) => {
  const r = await require('../lib/newsletter').sendWeeklyDigest(true).catch((e) => ({ sent: 0, reason: 'error', error: e.message }));
  if (r.reason === 'ok') {
    return res.redirect('/admin3119Musa/settings?ok=' + encodeURIComponent(`Digest sent to ${r.sent} subscribers (${r.verified} verified + ${r.fresh} new listings).`));
  }
  const why = r.reason === 'no_subscribers' ? 'no active subscribers yet'
    : r.reason === 'nothing_new' ? `no new/verified listings inside the current ${require('../lib/newsletter').digestCadence().windowDays}-day window to report`
    : (r.error || r.reason);
  res.redirect('/admin3119Musa/settings?err=' + encodeURIComponent(`Digest not sent — ${why}.`));
});

/* Send a real test email through the configured transport. */
router.post('/admin3119Musa/settings/test-mail', async (req, res) => {
  const to = String(req.body.test_to || '').trim().toLowerCase().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
    return res.redirect('/admin3119Musa/settings?err=' + encodeURIComponent('Enter a valid address for the test email.'));
  }
  const r = await sendTest(to);
  if (r.ok) return res.redirect('/admin3119Musa/settings?ok=' + encodeURIComponent(`Test email sent to ${to} — check the inbox (and spam folder).`));
  return res.redirect('/admin3119Musa/settings?err=' + encodeURIComponent(`Test failed: ${r.error}`));
});

router.post('/admin3119Musa/settings/regen-key', (req, res) => {
  setSetting('indexnow_key', crypto.randomBytes(16).toString('hex'));
  res.redirect('/admin3119Musa/settings?ok=' + encodeURIComponent('IndexNow key regenerated. The old key file is now invalid.'));
});

router.post('/admin3119Musa/settings/2fa-reset', (req, res) => {
  setSetting('admin_totp_secret', '');
  setSetting('admin_totp_pending', '');
  setSetting('admin_recovery_codes', '[]'); // old set must never survive a reset
  adminmail2fa.clearEmailCode(); // and no emailed fallback survives either
  res.redirect('/admin3119Musa/settings?ok=' + encodeURIComponent('Two-factor reset — the authenticator and all recovery codes are wiped. Your next sign-in enrolls a fresh key and a new code set.'));
});

/*
 * Regenerate the 10 recovery codes without touching the authenticator.
 * Old codes stop working immediately; the new set is shown once, here.
 */
router.post('/admin3119Musa/settings/recovery-regenerate', (req, res) => {
  if (!getSetting('admin_totp_secret', '')) {
    return res.redirect('/admin3119Musa/settings?ok=' + encodeURIComponent('Enroll two-factor first — recovery codes are generated during enrollment.'));
  }
  const codes = backup.genAdminRecoveryCodes(10);
  setSetting('admin_recovery_codes', JSON.stringify(codes.map((c) => ({ h: backup.hashAdminCode(c), used: 0 }))));
  sendAdminRecoveryCodesEmail(codes, true); // the fresh keep-set lands in the admin inbox too
  res.render('admin/2fa-recovery', {
    meta: { title: 'New recovery codes — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    codes,
    dlCsrf: res.locals.csrfToken,
    regenerated: true,
  });
});

/* ---------------- Removal requests ---------------- */
router.get('/admin3119Musa/removals', (req, res) => {
  const rows = db.prepare(
    `SELECT r.*, l.name AS listing_name, l.slug AS listing_slug, l.status AS listing_status
     FROM removal_requests r LEFT JOIN listings l ON l.id = r.listing_id
     ORDER BY r.status='pending' DESC, r.created_at DESC LIMIT 300`
  ).all();
  res.render('admin/removals', {
    meta: { title: 'Removal requests — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    rows, section: 'removals',
  });
});

router.post('/admin3119Musa/removals/:id/dismiss', (req, res) => {
  db.prepare("UPDATE removal_requests SET status='dismissed', resolved_at=datetime('now') WHERE id=?").run(req.params.id);
  res.redirect('/admin3119Musa/removals?ok=' + encodeURIComponent('Request dismissed.'));
});

router.post('/admin3119Musa/removals/:id/remove-listing', (req, res) => {
  const r = db.prepare('SELECT * FROM removal_requests WHERE id=?').get(req.params.id);
  if (!r) return res.redirect('/admin3119Musa/removals');
  const l = db.prepare('SELECT * FROM listings WHERE id=?').get(r.listing_id);
  if (l) {
    deleteLogo(l.logo_url);
    db.prepare('DELETE FROM listings WHERE id=?').run(l.id);
  }
  db.prepare("UPDATE removal_requests SET status='removed', resolved_at=datetime('now') WHERE id=?").run(r.id);
  res.redirect('/admin3119Musa/removals?ok=' + encodeURIComponent(`Listing “${l ? l.name : '—'}” removed from the ledger and the request resolved.`));
});

/* ---------------- User management ---------------- */
router.get('/admin3119Musa/users/:id', (req, res, next) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return next();
  const listings = db.prepare(
    'SELECT id, slug, name, type, status, claimed, confidence, created_at FROM listings WHERE owner_user_id=? ORDER BY created_at DESC'
  ).all(u.id);
  const claims = db.prepare(
    `SELECT c.*, l.name AS listing_name FROM claims c LEFT JOIN listings l ON l.id=c.listing_id WHERE c.user_id=? ORDER BY c.created_at DESC`
  ).all(u.id);
  const sessions = db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id=?').get(u.id).c;
  const tickets = db.prepare(
    'SELECT id, ref, subject, category, status, created_at, updated_at FROM tickets WHERE user_id=? ORDER BY updated_at DESC LIMIT 10'
  ).all(u.id);
  const payments = db.prepare(
    "SELECT id, reference, amount, currency, status, created_at, paid_at FROM payments WHERE user_id=? AND status='success' ORDER BY COALESCE(paid_at, created_at) DESC LIMIT 10"
  ).all(u.id);
  const pendingDeletion = db.prepare(
    "SELECT id, reason, created_at FROM deletion_requests WHERE user_id=? AND status='pending' ORDER BY id DESC LIMIT 1"
  ).get(u.id);
  const submitted = db.prepare(
    'SELECT COUNT(*) c FROM listings WHERE submitter_user_id=?'
  ).get(u.id).c;
  const back = (() => {
    const keep = [];
    const q = String(req.query.q || '').trim().slice(0, 80);
    const f = USER_FILTERS[String(req.query.f || '').trim()] || '';
    if (q) keep.push('q=' + encodeURIComponent(q));
    if (f) keep.push('f=' + encodeURIComponent(f));
    return '/admin3119Musa/users' + (keep.length ? '?' + keep.join('&') : '');
  })();
  res.render('admin/user-detail', {
    meta: { title: `${u.name} — FirmLedger Admin`, description: '', robots: 'noindex,nofollow' },
    u, listings, claims, sessions, tickets, payments, pendingDeletion, submitted, back,
    q: String(req.query.q || '').trim().slice(0, 80),
    f: String(req.query.f || '').trim(),
    isProUser, section: 'users',
  });
});

router.post('/admin3119Musa/users/:id/suspend', (req, res) => {
  const u = db.prepare('SELECT name, email, suspended FROM users WHERE id=?').get(req.params.id);
  db.prepare('UPDATE users SET suspended=1 WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.params.id);
  if (u && !u.suspended) {
    const { siteUrl: su6 } = require('../lib/util');
    sendBranded(u.email, 'Your FirmLedger account has been suspended', {
      kicker: 'Account notice',
      title: 'Your account is suspended',
      preheader: 'Your FirmLedger account has been suspended by our team.',
      alert: 'Your FirmLedger account has been suspended. Active sessions were signed out and sign-in is blocked while the suspension is in effect.',
      alertTone: 'warn',
      paragraphs: [
        'This usually happens when an account violates our terms — for example submitting misleading listings or abusing contact data. If you believe this is an error, our support team can review the suspension and restore access.',
      ],
      cta: { label: 'Contact support', url: 'mailto:support@firmledger.co.ke' },
      note: 'Please reference your account email when contacting support so we can locate your record quickly.',
    }).catch(() => {});
  }
  backToUsers(req, res, 'User suspended — sessions revoked and sign-in blocked.');
});

router.post('/admin3119Musa/users/:id/unsuspend', (req, res) => {
  const u = db.prepare('SELECT name, email, suspended FROM users WHERE id=?').get(req.params.id);
  db.prepare('UPDATE users SET suspended=0 WHERE id=?').run(req.params.id);
  if (u && u.suspended) {
    const { siteUrl: su7 } = require('../lib/util');
    sendBranded(u.email, 'Your FirmLedger account has been reinstated', {
      kicker: 'Account notice',
      title: 'Welcome back',
      preheader: 'Your FirmLedger account suspension has been lifted.',
      alert: 'Your account suspension has been reviewed and lifted. You can sign in and use your account as normal.',
      alertTone: 'ok',
      paragraphs: [
        'All account features, including your dashboard and any listings you own, are available again. New sessions will start working from your next sign-in.',
      ],
      cta: { label: 'Sign in', url: su7('/login') },
      note: 'Questions about your account? Contact <a href="mailto:support@firmledger.co.ke" style="color:#1D4ED8;">support@firmledger.co.ke</a>.',
    }).catch(() => {});
  }
  backToUsers(req, res, 'User reinstated — sessions allowed again.');
});

/* ---------------- Blog / news ---------------- */
function postBody(b) {
  return {
    slug: String(b.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 120),
    title: String(b.title || '').trim().slice(0, 200),
    excerpt: String(b.excerpt || '').trim().slice(0, 400),
    body: String(b.body || '').trim(),
    status: b.status === 'published' ? 'published' : 'draft',
  };
}

router.get('/admin3119Musa/blog', (req, res) => {
  const posts = db.prepare('SELECT * FROM blog_posts ORDER BY created_at DESC').all();
  res.render('admin/blog', {
    meta: { title: 'Blog — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    posts, section: 'blog',
  });
});

router.get('/admin3119Musa/blog/new', (req, res) => {
  res.render('admin/blog-form', {
    meta: { title: 'New post — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    p: { slug: '', title: '', excerpt: '', body: '', status: 'draft' }, action: '/admin3119Musa/blog/new', section: 'blog',
  });
});

router.post('/admin3119Musa/blog/new', (req, res) => {
  const p = postBody(req.body);
  if (!p.slug) {
    p.slug = p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
  }
  if (!p.title) return res.redirect('/admin3119Musa/blog/new');
  if (db.prepare('SELECT id FROM blog_posts WHERE slug=?').get(p.slug)) {
    p.slug = `${p.slug}-${Date.now().toString(36)}`;
  }
  db.prepare(
    "INSERT INTO blog_posts (slug, title, excerpt, body, status, published_at) VALUES (?,?,?,?,?, CASE WHEN ?='published' THEN datetime('now') ELSE NULL END)"
  ).run(p.slug, p.title, p.excerpt, p.body, p.status, p.status);
  res.redirect('/admin3119Musa/blog?ok=' + encodeURIComponent('Post saved.'));
});

router.get('/admin3119Musa/blog/:id/edit', (req, res, next) => {
  const p = db.prepare('SELECT * FROM blog_posts WHERE id=?').get(req.params.id);
  if (!p) return next();
  res.render('admin/blog-form', {
    meta: { title: `Edit: ${p.title} — FirmLedger Admin`, description: '', robots: 'noindex,nofollow' },
    p, action: `/admin3119Musa/blog/${p.id}/edit`, section: 'blog',
  });
});

router.post('/admin3119Musa/blog/:id/edit', (req, res) => {
  const cur = db.prepare('SELECT * FROM blog_posts WHERE id=?').get(req.params.id);
  if (!cur) return res.redirect('/admin3119Musa/blog');
  const p = postBody(req.body);
  const slug = p.slug || cur.slug;
  const dup = db.prepare('SELECT id FROM blog_posts WHERE slug=? AND id<>?').get(slug, cur.id);
  db.prepare(
    `UPDATE blog_posts SET slug=?, title=?, excerpt=?, body=?, status=?, updated_at=datetime('now'),
       published_at=CASE WHEN ?='published' AND published_at IS NULL THEN datetime('now') ELSE published_at END
     WHERE id=?`
  ).run(dup ? `${slug}-${Date.now().toString(36)}` : slug, p.title, p.excerpt, p.body, p.status, p.status, cur.id);
  res.redirect('/admin3119Musa/blog?ok=' + encodeURIComponent('Post updated.'));
});

router.post('/admin3119Musa/blog/:id/toggle', (req, res) => {
  db.prepare(
    `UPDATE blog_posts SET status = CASE status WHEN 'published' THEN 'draft' ELSE 'published' END,
       published_at = CASE WHEN status<>'published' AND published_at IS NULL THEN datetime('now') ELSE published_at END
     WHERE id=?`
  ).run(req.params.id);
  res.redirect('/admin3119Musa/blog?ok=' + encodeURIComponent('Status flipped.'));
});

router.post('/admin3119Musa/blog/:id/delete', (req, res) => {
  db.prepare('DELETE FROM blog_posts WHERE id=?').run(req.params.id);
  res.redirect('/admin3119Musa/blog?ok=' + encodeURIComponent('Post deleted.'));
});

/* ---------------- Email members ---------------- */
function emailCounts() {
  const today = new Date().toISOString().slice(0, 10);
  const proSql = "(plan='pro' AND (plan_expires_at IS NULL OR plan_expires_at='' OR plan_expires_at >= ?))";
  return {
    all: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    pro: db.prepare(`SELECT COUNT(*) c FROM users WHERE ${proSql}`).get(today).c,
    free: db.prepare(`SELECT COUNT(*) c FROM users WHERE NOT ${proSql}`).get(today).c,
    newsletter: db.prepare('SELECT COUNT(*) c FROM newsletter_subscribers WHERE active=1').get().c,
    nl_guests: db.prepare(`SELECT COUNT(*) c FROM newsletter_subscribers WHERE active=1 AND email NOT IN (SELECT email FROM users)`).get().c,
  };
}

router.get('/admin3119Musa/email/users.json', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (!q) {
    const users = db.prepare('SELECT id, name, email FROM users ORDER BY name LIMIT 40').all();
    return res.json({ users });
  }
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const users = db.prepare(
    'SELECT id, name, email FROM users WHERE name LIKE ? OR email LIKE ? ORDER BY name LIMIT 40'
  ).all(like, like);
  res.json({ users });
});

router.get('/admin3119Musa/email', (req, res) => {
  const users = db.prepare('SELECT id, name, email FROM users ORDER BY name LIMIT 1000').all();
  const log = db.prepare('SELECT * FROM admin_mail_log ORDER BY created_at DESC LIMIT 25').all();
  res.render('admin/email', {
    meta: { title: 'Email — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    users, log, counts: emailCounts(), preset: String(req.query.to || ''), smtp: mailConfigured(), section: 'email',
  });
});

router.post('/admin3119Musa/email', async (req, res) => {
  const to = String(req.body.to || '').trim().toLowerCase();
  const subject = String(req.body.subject || '').trim().slice(0, 200);
  const body = String(req.body.body || '').trim().slice(0, 10000);
  const format = req.body.format === 'html' ? 'html' : 'text';
  const err = [];
  if (!subject) err.push('A subject is required.');
  if (body.length < 10) err.push('Write a message of at least 10 characters.');
  const today = new Date().toISOString().slice(0, 10);
  const proSql = "(plan='pro' AND (plan_expires_at IS NULL OR plan_expires_at='' OR plan_expires_at >= ?))";
  let recipients = [];
  if (to === 'all') {
    recipients = db.prepare('SELECT email FROM users ORDER BY email').all().map((u) => u.email);
  } else if (to === 'pro') {
    recipients = db.prepare(`SELECT email FROM users WHERE ${proSql} ORDER BY email`).all(today).map((u) => u.email);
    if (!recipients.length) err.push('There are no Pro members right now.');
  } else if (to === 'free') {
    recipients = db.prepare(`SELECT email FROM users WHERE NOT ${proSql} ORDER BY email`).all(today).map((u) => u.email);
    if (!recipients.length) err.push('There are no Free members to email.');
  } else if (to === 'newsletter') {
    recipients = db.prepare('SELECT email FROM newsletter_subscribers WHERE active=1 ORDER BY email').all().map((n) => n.email);
    if (!recipients.length) err.push('No active newsletter subscribers yet.');
  } else if (to === 'nl_guests') {
    recipients = db.prepare(`SELECT email FROM newsletter_subscribers WHERE active=1 AND email NOT IN (SELECT email FROM users) ORDER BY email`).all().map((n) => n.email);
    if (!recipients.length) err.push('No guest-only newsletter subscribers (every subscriber holds an account).');
  } else if (to) {
    const u = db.prepare('SELECT email FROM users WHERE email = ?').get(to);
    const n = u ? null : db.prepare('SELECT email FROM newsletter_subscribers WHERE email = ? AND active=1').get(to);
    if (!u && !n) err.push('Select a recipient — or one of the audience groups.');
    else recipients = [(u || n).email];
  } else {
    err.push('Select a recipient — or one of the audience groups.');
  }
  if (err.length) {
    const users = db.prepare('SELECT id, name, email FROM users ORDER BY name LIMIT 1000').all();
    const log = db.prepare('SELECT * FROM admin_mail_log ORDER BY created_at DESC LIMIT 25').all();
    return res.status(422).render('admin/email', {
      meta: { title: 'Email — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
      users, log, counts: emailCounts(), preset: to, smtp: mailConfigured(), section: 'email',
      errors: err, draft: { subject, body, format },
    });
  }
  let sent = 0, logged = 0, failed = 0;
  const ins = db.prepare('INSERT INTO admin_mail_log (to_email, subject, body, delivered) VALUES (?,?,?,?)');
  // Blank-line separated paragraphs; the body can carry <b>, <a>, <em>, lists etc.
  const htmlParas = format === 'html'
    ? body.split(/\n\s*\n/).map((p) => p.replace(/\n/g, '<br>').trim()).filter(Boolean)
    : null;
  const { isEmail: _ie } = require('../lib/util');
  for (const rcpt of recipients) {
    try {
      let r;
      if (format === 'html') {
        r = await sendBranded(rcpt, `[FirmLedger] ${subject}`, {
          title: subject,
          paragraphs: htmlParas,
          note: 'You received this because you\'re part of FirmLedger. Reply to this email to contact the team.',
        });
      } else {
        r = await sendMail(rcpt, `[FirmLedger] ${subject}`, body);
      }
      ins.run(rcpt, subject, body, r.delivered ? 1 : 0);
      if (r.delivered) sent++; else logged++;
    } catch {
      ins.run(rcpt, subject, body, 0);
      failed++;
    }
  }
  const msg = failed
    ? `Delivered ${sent}, logged to outbox ${logged}, failed ${failed}.`
    : mailConfigured()
      ? `Email delivered to ${sent} recipient${sent === 1 ? '' : 's'}.`
      : `No SMTP configured — ${logged} message${logged === 1 ? '' : 's'} written to data/outbox.log for later delivery.`;
  res.redirect('/admin3119Musa/email?ok=' + encodeURIComponent(msg));
});

/* ---------------- Admin: add a listing ---------------- */
router.get('/admin3119Musa/listings/new', (req, res) => {
  res.render('admin/new-listing', {
    meta: { title: 'Add a listing — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    l: {}, errors: [], TYPES, SIZES, COUNTRIES, allCats: catLib.all(), section: 'listings',
  });
});

router.post('/admin3119Musa/listings/new', async (req, res) => {
  if (!require('../lib/session').validCsrf(req)) return res.status(403).redirect('/admin3119Musa/listings/new');
  const b = req.body;
  const errors = [];
  const name = String(b.name || '').trim();
  const type = TYPES.some((t) => t.value === b.type) ? b.type : '';
  const category = String(b.category || '').trim();
  const website = normalizeUrl(b.website || '');
  if (!name) errors.push('Name is required.');
  if (!type) errors.push('Pick an entity type.');
  if (!category) errors.push('Category is required.');
  if (String(b.description || '').trim().length < 100) errors.push('Description needs at least 100 characters.');
  // duplicate guard: same name or same domain
  const dom = domainOf(website || '');
  if (!errors.length && name) {
    const dupName = db.prepare('SELECT id, slug, name FROM listings WHERE name = ? COLLATE NOCASE').get(name);
    if (dupName) errors.push(`A listing named “${dupName.name}” already exists (/listing/${dupName.slug}). Edit it instead.`);
  }
  if (!errors.length && dom) {
    const dupWeb = db.prepare('SELECT id, slug, name, website FROM listings WHERE lower(website) LIKE ? LIMIT 1').get(`%${dom}%`);
    if (dupWeb) errors.push(`“${dupWeb.name}” already uses that domain. Edit it instead.`);
  }
  if (errors.length) {
    return res.status(422).render('admin/new-listing', {
      meta: { title: 'Add a listing — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
      l: b, errors, TYPES, SIZES, COUNTRIES, allCats: catLib.all(), section: 'listings',
    });
  }
  let logo = normalizeUrl(b.logo_url || '');

  let slug = slugify(name) || 'listing';
  let n = 2;
  while (db.prepare('SELECT id FROM listings WHERE slug=?').get(slug)) slug = `${slugify(name)}-${n++}`;
  const socials = {};
  try { Object.assign(socials, JSON.parse(b.socials || '{}')); } catch { /* ignore bad JSON — keep listing without socials */ }
  const status = ['pending', 'approved', 'rejected'].includes(b.status) ? b.status : 'approved';
  const info = db.prepare(
    `INSERT INTO listings (slug, name, tagline, description, type, category, website, email, phone,
       country, city, region, address, logo_url, founded, size, tags, socials, sources, status, featured, claimed, confidence)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    slug, name, String(b.tagline || '').trim(), String(b.description || '').trim(), type,
    catLib.ensure(category).name,
    website, String(b.email || '').trim(), String(b.phone || '').trim(),
    String(b.country || '').trim(), String(b.city || '').trim(), String(b.region || '').trim(), String(b.address || '').trim(),
    logo, String(b.founded || '').trim(), String(b.size || '').trim(), String(b.tags || '').trim(),
    JSON.stringify(socials), JSON.stringify(parseLines(b.sources)),
    status, b.featured === '1' ? 1 : 0, 0,
    Math.max(0, Math.min(97, parseInt(b.confidence, 10) || 55))
  );
  if (status === 'approved') submitForIndexing([`/listing/${slug}`]);
  res.redirect(`/admin3119Musa/listings/${info.lastInsertRowid}/edit?ok=` + encodeURIComponent('Listing created — review fields and add sources/graph below.'));
});

/* ================= Support tickets ================= */
const FILTER_DEFS = {
  all:    { label: 'All',      where: "1=1",                                       params: [] },
  new:    { label: 'New',      where: "t.status='open' AND t.admin_seen_at = ''",  params: [] },
  unread: { label: 'Unread',   where: "t.status='open' AND t.admin_seen_at < COALESCE((SELECT MAX(created_at) FROM ticket_messages WHERE ticket_id=t.id AND sender='user'), '')", params: [] },
  open:   { label: 'Open',     where: "t.status='open'",                            params: [] },
  solved: { label: 'Solved',   where: "t.status='solved'",                          params: [] },
  closed: { label: 'Closed',   where: "t.status='closed'",                          params: [] },
};

router.get('/admin3119Musa/tickets', (req, res) => {
  const filter = String(req.query.filter || 'all').toLowerCase();
  const def = FILTER_DEFS[filter] || FILTER_DEFS.all;
  const tickets = db.prepare(
    `SELECT t.*, u.name AS user_name, u.email AS user_email,
       (SELECT COUNT(*) FROM ticket_messages WHERE ticket_id = t.id) msg_count,
       (SELECT COALESCE(MAX(created_at), '') FROM ticket_messages WHERE ticket_id = t.id) last_msg_at,
       (SELECT COALESCE(MAX(created_at), '') FROM ticket_messages WHERE ticket_id = t.id AND sender='user') last_user_msg_at,
       (SELECT COALESCE((SELECT 1 FROM ticket_messages WHERE ticket_id=t.id AND sender='admin' LIMIT 1), 0)) admin_replied
     FROM tickets t JOIN users u ON u.id = t.user_id
     WHERE ${def.where}
     ORDER BY CASE WHEN last_user_msg_at > t.admin_seen_at THEN 0 ELSE 1 END, t.updated_at DESC
     LIMIT 100`
  ).all(...def.params);
  const counts = Object.fromEntries(
    Object.entries(FILTER_DEFS).map(([k, d]) => [k, db.prepare(`SELECT COUNT(*) c FROM tickets t WHERE ${d.where}`).get(...d.params).c])
  );
  res.render('admin/tickets', {
    meta: { title: 'Support tickets — FirmLedger', description: '', robots: 'noindex' },
    tickets, filter, counts, section: 'tickets',
  });
});

function loadTicket(req, res, next) {
  const t = db.prepare(
    `SELECT t.*, u.name AS user_name, u.email AS user_email
     FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?`
  ).get(req.params.id);
  if (!t) return res.status(404).redirect('/admin3119Musa/tickets');
  req.ticket = t;
  support.markAdminSeen(t.id);
  next();
}

router.get('/admin3119Musa/tickets/:id', loadTicket, (req, res) => {
  const messages = db.prepare(
    'SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id ASC'
  ).all(req.ticket.id);
  const more = db.prepare(
    'SELECT id, ref, subject, status, updated_at FROM tickets WHERE user_id = ? AND id <> ? ORDER BY updated_at DESC LIMIT 5'
  ).all(req.ticket.user_id, req.ticket.id);
  res.render('admin/ticket-thread', {
    meta: { title: `${req.ticket.subject} — Admin — FirmLedger`, description: '', robots: 'noindex' },
    t: req.ticket, messages, more, section: 'tickets', flashMsg: req.query.ok || '',
  });
});

router.post('/admin3119Musa/tickets/:id/reply', loadTicket, (req, res) => {
  if (!require('../lib/session').validCsrf(req)) {
    return res.status(403).redirect('/admin3119Musa/tickets');
  }
  const body = String(req.body.body || '').trim();
  const action = String(req.body.action || '');
  const errors = [];
  if (body.length < 2 && action === 'reply') errors.push('Write a reply message first.');
  if (errors.length) {
    return res.redirect(`/admin3119Musa/tickets/${req.ticket.id}?ok=` + encodeURIComponent(errors[0]));
  }

  if (action === 'reply') {
    support.reply(req.ticket.id, 'admin', body, '', '');
    if (req.ticket.status === 'open') support.setStatus(req.ticket.id, 'open'); // stays open until explicitly solved/closed
    notify.notifyUser(req.ticket.user_id, {
      kind: 'ticket',
      title: `Reply on ticket ${req.ticket.ref}`,
      body: body.length > 180 ? body.slice(0, 180) + '…' : body,
      url: `/dashboard/support/${req.ticket.id}`,
    });
    return res.redirect(`/admin3119Musa/tickets/${req.ticket.id}?ok=` + encodeURIComponent('Reply posted — member notified.'));
  }

  if (action === 'solve') {
    support.setStatus(req.ticket.id, 'solved');
    notify.notifyUser(req.ticket.user_id, {
      kind: 'ticket',
      title: `Ticket ${req.ticket.ref} marked Solved`,
      body: 'Reply any time if something else comes up — the ticket reopens.',
      url: `/dashboard/support/${req.ticket.id}`,
    });
    return res.redirect(`/admin3119Musa/tickets/${req.ticket.id}?ok=` + encodeURIComponent('Marked Solved — member notified.'));
  }

  if (action === 'close') {
    support.setStatus(req.ticket.id, 'closed');
    notify.notifyUser(req.ticket.user_id, {
      kind: 'ticket',
      title: `Ticket ${req.ticket.ref} was closed`,
      body: 'History stays in your support area. Open a fresh ticket for a new issue.',
      url: '/dashboard/support',
    });
    return res.redirect(`/admin3119Musa/tickets/${req.ticket.id}?ok=` + encodeURIComponent('Ticket closed — member notified.'));
  }

  if (action === 'reopen') {
    support.setStatus(req.ticket.id, 'open');
    return res.redirect(`/admin3119Musa/tickets/${req.ticket.id}?ok=` + encodeURIComponent('Ticket reopened.'));
  }

  return res.redirect(`/admin3119Musa/tickets/${req.ticket.id}`);
});

router.get('/admin3119Musa/tickets/:id/poll', loadTicket, (req, res) => {
  res.json({
    status: req.ticket.status,
    updatedAt: req.ticket.updated_at,
    lastMsgAt: db.prepare("SELECT COALESCE(MAX(created_at), '') t FROM ticket_messages WHERE ticket_id = ?").get(req.ticket.id).t,
  });
});


/* ================= Admin global search ================= */
router.get('/admin3119Musa/search', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const like = q ? `%${q.replace(/[%_]/g, '')}%` : '';
  const empty = { users: [], listings: [], claims: [], tickets: [], posts: [] };
  if (!q || q.length < 2) {
    return res.render('admin/search', {
      meta: { title: 'Search — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
      q, results: empty, section: 'search',
    });
  }
  const results = {
    users: db.prepare(
      'SELECT id, name, email, suspended, created_at FROM users WHERE name LIKE ? OR email LIKE ? ORDER BY created_at DESC LIMIT 20'
    ).all(like, like),
    listings: db.prepare(
      `SELECT id, slug, name, status, claimed, category, country, city, website, logo_url FROM listings
       WHERE name LIKE ? OR slug LIKE ? OR website LIKE ? OR email LIKE ? ORDER BY updated_at DESC LIMIT 20`
    ).all(like, like, like, like),
    claims: db.prepare(
      `SELECT c.id, c.status, c.method, c.domain, l.name AS listing_name, u.email AS user_email
       FROM claims c JOIN listings l ON l.id=c.listing_id JOIN users u ON u.id=c.user_id
       WHERE l.name LIKE ? OR u.email LIKE ? OR c.domain LIKE ? ORDER BY c.created_at DESC LIMIT 20`
    ).all(like, like, like),
    tickets: db.prepare(
      `SELECT t.id, t.ref, t.subject, t.status, u.email AS user_email
       FROM tickets t JOIN users u ON u.id=t.user_id
       WHERE t.ref LIKE ? OR t.subject LIKE ? OR u.email LIKE ? ORDER BY t.updated_at DESC LIMIT 20`
    ).all(like, like, like),
    posts: db.prepare(
      'SELECT id, slug, title, status FROM blog_posts WHERE title LIKE ? OR slug LIKE ? OR excerpt LIKE ? ORDER BY updated_at DESC LIMIT 12'
    ).all(like, like, like),
  };
  res.render('admin/search', {
    meta: { title: `Search “${q}” — FirmLedger Admin`, description: '', robots: 'noindex,nofollow' },
    q, results, section: 'search',
  });
});

/* ================= Admin notifications ================= */
router.get('/admin3119Musa/notifications', (req, res) => {
  const items = notify.listAdmin();
  res.render('admin/notifications', {
    meta: { title: 'Notifications — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    items, section: 'notifications',
    trashCount: notifications.getTrash(null).length,
    ok: req.query.ok || '', err: req.query.err || '',
  });
});

/* ---- Admin's own archived notifications ---- */
router.get('/admin3119Musa/notifications/trash', (req, res) => {
  res.render('admin/notifications-trash', {
    meta: { title: 'Archived notifications — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    section: 'notifications',
    global: false,
    items: notifications.getTrash(null),
    daysLeft: notifications.daysLeft,
    ok: req.query.ok || '', err: req.query.err || '',
  });
});

/* ---- Moderation: every archived notification, all accounts ---- */
router.get('/admin3119Musa/notifications/trash/global', (req, res) => {
  res.render('admin/notifications-trash', {
    meta: { title: 'All archived notifications — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    section: 'notifications',
    global: true,
    items: notifications.getGlobalTrash(),
    daysLeft: notifications.daysLeft,
    ok: req.query.ok || '', err: req.query.err || '',
  });
});

router.post('/admin3119Musa/notifications/:id/archive', (req, res) => {
  const r = notifications.archive(Number(req.params.id), null, req.body.duration);
  res.redirect('/admin3119Musa/notifications?' + (r.ok
    ? 'ok=' + encodeURIComponent(`Archived — it will be deleted automatically in ${r.days} day${r.days === 1 ? '' : 's'}.`)
    : 'err=' + encodeURIComponent(r.error)));
});

router.post('/admin3119Musa/notifications/:id/restore', (req, res) => {
  const r = notifications.restore(Number(req.params.id), null);
  res.redirect('/admin3119Musa/notifications/trash?' + (r.ok
    ? 'ok=' + encodeURIComponent('Notification restored to the console inbox.')
    : 'err=' + encodeURIComponent(r.error)));
});

router.post('/admin3119Musa/notifications/:id/delete', (req, res) => {
  const r = notifications.permanentDelete(Number(req.params.id), null);
  const back = String(req.body.from || '') === 'trash' ? '/admin3119Musa/notifications/trash' : '/admin3119Musa/notifications';
  res.redirect(back + '?' + (r.ok
    ? 'ok=' + encodeURIComponent('Notification permanently deleted.')
    : 'err=' + encodeURIComponent(r.error)));
});

/* Moderation delete — any archived notification, whoever owns it. */
router.post('/admin3119Musa/notifications/:id/delete-any', (req, res) => {
  const r = notifications.adminDeleteAny(Number(req.params.id));
  res.redirect('/admin3119Musa/notifications/trash/global?' + (r.ok
    ? 'ok=' + encodeURIComponent('Notification permanently deleted.')
    : 'err=' + encodeURIComponent(r.error)));
});

router.post('/admin3119Musa/notifications/:id/read', (req, res) => {
  notify.markRead(Number(req.params.id), { audience: 'admin' });
  const row = db.prepare("SELECT url FROM notifications WHERE id=? AND audience='admin'").get(req.params.id);
  const dest = row && row.url && String(row.url).startsWith('/') ? row.url : '/admin3119Musa/notifications';
  res.redirect(dest);
});

router.post('/admin3119Musa/notifications/read-all', (req, res) => {
  notify.markAllRead({ audience: 'admin' });
  res.redirect('/admin3119Musa/notifications?ok=' + encodeURIComponent('All notifications marked read.'));
});

/* ================= Admin-initiated password reset ================= */
router.post('/admin3119Musa/users/:id/reset', (req, res) => {
  if (!require('../lib/session').validCsrf(req)) return res.status(403).redirect('/admin3119Musa/users');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return usersFail(req, res, 'User not found.');
  const token = randomToken(32);
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM resets WHERE email=?').run(u.email);
  db.prepare('INSERT INTO resets (email, token, expires_at) VALUES (?,?,?)').run(u.email, token, expires);
  const url = siteUrl('/reset/' + token);
  sendBranded(u.email, 'Reset your FirmLedger password', {
    kicker: 'Password reset',
    title: 'Reset your password',
    preheader: 'An administrator started a password reset for your FirmLedger account.',
    alert: 'A FirmLedger administrator started a password reset for your account. The link below is valid for 1 hour.',
    alertTone: 'warn',
    paragraphs: [
      'If you did not expect this, you can ignore the email — your current password stays the same until you use the link.',
    ],
    cta: { label: 'Choose a new password', url },
    note: `Or paste this URL: <a href="${url}" style="color:#1D4ED8;">${url}</a>`,
  }).catch(() => {});
  notify.notifyUser(u.id, {
    kind: 'account',
    title: 'Password reset sent',
    body: 'An administrator emailed you a one-hour reset link.',
    url: '/login',
  });
  backToUsers(req, res, `Password reset emailed to ${u.email}.`);
});

/* ================= Pro transfer approve/reject ================= */
router.post('/admin3119Musa/pro-transfer/:id/approve', (req, res) => {
  const r = db.prepare('SELECT * FROM pro_transfer_requests WHERE id=?').get(req.params.id);
  if (!r || r.status !== 'pending') return res.redirect('/admin3119Musa/listings');
  const from = db.prepare('SELECT * FROM listings WHERE id=?').get(r.from_listing_id);
  const to = db.prepare('SELECT * FROM listings WHERE id=?').get(r.to_listing_id);
  if (!from || !to) {
    db.prepare("UPDATE pro_transfer_requests SET status='rejected', resolved_at=datetime('now') WHERE id=?").run(r.id);
    return res.redirect('/admin3119Musa/listings?err=' + encodeURIComponent('One of the listings is gone — request closed.'));
  }
  db.prepare('UPDATE listings SET plan=?, plan_expires_at=? WHERE id=?').run(from.plan, from.plan_expires_at, to.id);
  db.prepare("UPDATE listings SET plan='free', plan_expires_at='' WHERE id=?").run(from.id);
  db.prepare("UPDATE pro_transfer_requests SET status='approved', resolved_at=datetime('now') WHERE id=?").run(r.id);
  notify.notifyUser(r.user_id, {
    kind: 'pro',
    title: 'Listing Pro transferred',
    body: `Remaining Pro time moved from ${from.name} onto ${to.name}.`,
    url: `/dashboard/listings/${to.id}/edit`,
  });
  res.redirect('/admin3119Musa/listings?ok=' + encodeURIComponent(`Moved remaining listing-scoped Pro from ${from.name} onto ${to.name}.`));
});

router.post('/admin3119Musa/pro-transfer/:id/reject', (req, res) => {
  const r = db.prepare('SELECT * FROM pro_transfer_requests WHERE id=?').get(req.params.id);
  if (r && r.status === 'pending') {
    db.prepare("UPDATE pro_transfer_requests SET status='rejected', resolved_at=datetime('now') WHERE id=?").run(r.id);
    notify.notifyUser(r.user_id, {
      kind: 'pro',
      title: 'Pro transfer was declined',
      body: 'Admin declined moving remaining listing-scoped Pro. Listing Pro stays on the claimed record.',
      url: '/dashboard',
    });
  }
  res.redirect('/admin3119Musa/listings?ok=' + encodeURIComponent('Transfer request declined.'));
});

/* ================= Ownership: make anyone owner / remove owner ================= */
router.post('/admin3119Musa/listings/:id/owner', (req, res) => {
  const l = db.prepare('SELECT id, slug, name FROM listings WHERE id=?').get(req.params.id);
  if (!l) return res.redirect('/admin3119Musa/listings?err=' + encodeURIComponent('Listing not found.'));
  const userId = Number(req.body.owner_user_id) || 0;
  let ownerName = 'nobody';
  if (userId > 0) {
    const u = db.prepare('SELECT id, email, name FROM users WHERE id=?').get(userId);
    if (!u) return res.redirect(`/admin3119Musa/listings/${l.id}/edit?err=${encodeURIComponent('That user does not exist.')}`);
    ownerName = u.name || u.email;
  }
  db.prepare('UPDATE listings SET owner_user_id = ? WHERE id = ?').run(userId || null, l.id);
  // If we removed the owner, drop the claimed flag too — ownership is what carries it.
  if (!userId) db.prepare('UPDATE listings SET claimed = 0 WHERE id = ?').run(l.id);
  const msg = userId
    ? `Ownership of “${l.name}” transferred to ${ownerName}.`
    : `Owner removed from “${l.name}” — it is now unclaimed.`;
  if (userId > 0) {
    notify.notifyUser(userId, {
      kind: 'listing',
      title: `You now own “${l.name}”`,
      body: 'An administrator transferred ownership of this listing to you. It appears in your dashboard.',
      url: `/dashboard/listings/${l.id}/edit`,
    });
  }
  res.redirect(`/admin3119Musa/listings/${l.id}/edit?ok=` + encodeURIComponent(msg));
});

/* ================= Advertising (Sponsored Content) ================= */
function advertisingPage(req, res) {
  const packages = ad.allPackages(false);
  const sponsored = ad.allSponsored();
  const q = String(req.query.q || '').trim().slice(0, 80);
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : '';
  const where = [];
  const params = [];
  if (q) {
    where.push('(l.name LIKE ? OR l.category LIKE ? OR l.tagline LIKE ? OR u.email LIKE ?)');
    const like = `%${q.replace(/[%_]/g, '')}%`;
    params.push(like, like, like, like);
  }
  if (status) { where.push('l.status = ?'); params.push(status); }
  const listings = db.prepare(
    `SELECT l.id, l.slug, l.name, l.category, l.tagline, l.status, l.claimed, l.sponsored, l.sponsored_expires_at, l.ad_reference,
            u.email AS owner_email
       FROM listings l LEFT JOIN users u ON u.id = l.owner_user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY l.status='approved' DESC, l.updated_at DESC LIMIT 200`
  ).all(...params);
  res.render('admin/advertising', {
    meta: { title: 'Advertising — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    packages, sponsored, listings, section: 'advertising',
    today: new Date().toISOString().slice(0, 10),
    ad, ok: req.query.ok || '', err: req.query.err || '',
    q, status, totalListings: db.prepare("SELECT COUNT(*) c FROM listings").get().c,
  });
}

router.get('/admin3119Musa/advertising', advertisingPage);

router.post('/admin3119Musa/advertising/packages', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const price = parseFloat(String(req.body.price_usd || '').replace(',', '.'));
  const days = Math.round(Number(req.body.duration_days || 0));
  const back = (q) => res.redirect('/admin3119Musa/advertising?' + q);
  if (!name) return back('err=' + encodeURIComponent('The package needs a name.'));
  if (!(price > 0) || price > 1e6) return back('err=' + encodeURIComponent('Enter a valid price above 0.'));
  if (!(days >= 1) || days > 3650) return back('err=' + encodeURIComponent('Duration must be between 1 and 3650 days.'));
  ad.createPackage({ name, blurb: req.body.blurb, priceCents: Math.round(price * 100), currency: req.body.currency || 'USD', durationDays: days, sort: req.body.sort });
  return back('ok=' + encodeURIComponent(`Package \"${name}\" created — $${price.toFixed(2)} / ${days} days.`));
});

router.post('/admin3119Musa/advertising/packages/:id/toggle', (req, res) => {
  const p = ad.togglePackage(req.params.id);
  res.redirect('/admin3119Musa/advertising?ok=' + encodeURIComponent(p ? `\"${p.name}\" is now ${p.active ? 'live' : 'hidden'}.` : 'Package not found.'));
});

router.post('/admin3119Musa/advertising/packages/:id/delete', (req, res) => {
  const p = ad.getPackage(req.params.id);
  ad.deletePackage(req.params.id);
  res.redirect('/admin3119Musa/advertising?ok=' + encodeURIComponent(p ? `\"${p.name}\" deleted.` : 'Package not found.'));
});

/* Sponsor / unsponsor any listing directly. */
router.post('/admin3119Musa/listings/:id/sponsor', (req, res) => {
  const daysRaw = String(req.body.days || '').trim();
  const days = daysRaw === 'lifetime' ? null : (parseInt(daysRaw, 10) || 30);
  const r = ad.grantSponsorship(req.params.id, days, 'admin');
  res.redirect('/admin3119Musa/advertising?' + (r.ok
    ? 'ok=' + encodeURIComponent(`“${r.listing}” is now sponsored${r.until === 'lifetime' ? ' (lifetime)' : ` until ${r.until}`}.`)
    : 'err=' + encodeURIComponent(r.error)));
});

router.post('/admin3119Musa/listings/:id/unsponsor', (req, res) => {
  const r = ad.revokeSponsorship(req.params.id);
  res.redirect('/admin3119Musa/advertising?' + (r.ok
    ? 'ok=' + encodeURIComponent(`Sponsored placement removed from “${r.listing}”.`)
    : 'err=' + encodeURIComponent(r.error)));
});

/* ================= Careers — FirmLedger is hiring ================= */
function careersPage(req, res) {
  res.render('admin/careers', {
    meta: { title: 'Careers — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    roles: careers.listAll(), section: 'careers',
    ROLE_TYPES: careers.ROLE_TYPES,
    errors: [], old: {}, ok: req.query.ok || '', err: req.query.err || '',
  });
}

router.get('/admin3119Musa/careers', careersPage);

router.post('/admin3119Musa/careers', (req, res) => {
  const r = careers.create(req.body);
  if (!r.ok) {
    return res.status(422).render('admin/careers', {
      meta: { title: 'Careers — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
      roles: careers.listAll(), section: 'careers', ROLE_TYPES: careers.ROLE_TYPES,
      errors: r.errors, old: req.body, ok: '', err: '',
    });
  }
  res.redirect('/admin3119Musa/careers?ok=' + encodeURIComponent('Role published on /careers.'));
});

router.post('/admin3119Musa/careers/:id/toggle', (req, res) => {
  const r = careers.toggleStatus(req.params.id);
  res.redirect('/admin3119Musa/careers?ok=' + encodeURIComponent(r ? `Role is now ${r.status}.` : 'Role not found.'));
});

router.post('/admin3119Musa/careers/:id/delete', (req, res) => {
  careers.remove(req.params.id);
  res.redirect('/admin3119Musa/careers?ok=' + encodeURIComponent('Role removed.'));
});

/* ================= Incidents — public status page ================= */
function incidentsPage(req, res, extra = {}) {
  const incidents = mon.allIncidents();
  res.render('admin/incidents', {
    meta: { title: 'Incidents — FirmLedger Admin', description: '', robots: 'noindex,nofollow' },
    section: 'incidents',
    incidents,
    components: mon.components(),
    severityLabels: mon.SEVERITY_LABELS,
    incidentStatusLabels: mon.INCIDENT_STATUS_LABELS,
    errors: extra.errors || [],
    old: extra.old || {},
    weeklyReportOn: getSetting('status_weekly_report', '0') === '1',
    ok: req.query.ok || '', err: req.query.err || '',
  });
}

function incidentFull(id) {
  return db.prepare(
    `SELECT i.*, c.name AS component_name FROM incidents i LEFT JOIN status_components c ON c.id=i.component_id WHERE i.id=?`
  ).get(Number(id) || 0) || null;
}

function incidentEmail(incident, update, params = {}) {
  const statusLabel = (mon.INCIDENT_STATUS_LABELS[incident.status] || incident.status);
  const component = incident.component_name ? `<b>${escHtml(incident.component_name)}</b>` : 'FirmLedger';
  const severityWord = incident.severity === 'critical' ? 'A critical incident' : incident.severity === 'major' ? 'An incident' : 'A service disruption';
  const tone = incident.status === 'resolved' ? 'ok' : (incident.status === 'monitoring' ? 'info' : 'warn');
  const heading = incident.status === 'resolved'
    ? `Resolved: ${incident.title}`
    : `${statusLabel}: ${incident.title}`;
  return {
    kicker: 'Status update',
    title: heading,
    preheader: `FirmLedger status — ${statusLabel.toLowerCase()}.`,
    alert: `${severityWord} affects ${component}.`,
    alertTone: tone,
    paragraphs: [
      update && update.message ? update.message : (incident.description || incident.title),
      `Current status: <b>${statusLabel}</b>${incident.resolved_at ? ` (resolved ${String(incident.resolved_at).slice(0, 16).replace('T', ' ')})` : ''}.`,
    ],
    cta: { label: 'View status', url: siteUrl('/status') },
    note: 'You received this because you subscribed to FirmLedger status updates. Unsubscribe any time from the status page.',
  };
}

router.get('/admin3119Musa/incidents', incidentsPage);

/* Toggle the optional weekly status report email to subscribers. */
router.post('/admin3119Musa/incidents/config/weekly', (req, res) => {
  setSetting('status_weekly_report', req.body.weekly_on === '1' ? '1' : '0');
  res.redirect('/admin3119Musa/incidents?ok=' + encodeURIComponent(
    (req.body.weekly_on === '1' ? 'Weekly status report enabled' : 'Weekly status report disabled') + '.'));
});

router.post('/admin3119Musa/incidents', (req, res) => {
  const r = mon.createIncident({
    title: req.body.title,
    description: req.body.description,
    status: req.body.status,
    severity: req.body.severity,
    component_id: req.body.component_id || null,
  });
  if (!r.ok) { res.status(422); return incidentsPage(req, res, { errors: [r.error], old: req.body }); }
  const incident = db.prepare(
    `SELECT i.*, c.name AS component_name FROM incidents i LEFT JOIN status_components c ON c.id=i.component_id WHERE i.id=?`
  ).get(r.id);
  notify.notifyAdmin({
    kind: 'status', title: `Incident opened: ${incident.title}`,
    body: `${mon.INCIDENT_STATUS_LABELS[incident.status]} · ${incident.severity}${incident.component_name ? ' · ' + incident.component_name : ''}`,
    url: '/admin3119Musa/incidents',
  });
  mon.notifySubscribers(`FirmLedger status: ${incident.title}`, incidentEmail(incident, null)).catch(() => {});
  res.redirect('/admin3119Musa/incidents?ok=' + encodeURIComponent(`Incident opened — it's now live on /status.`));
});

/* GET view for a single incident's update form (renders the dashboard focused). */
router.get('/admin3119Musa/incidents/:id/update', (req, res) => {
  const inc = mon.incidentById(req.params.id);
  if (!inc) return res.redirect('/admin3119Musa/incidents?err=' + encodeURIComponent('Incident not found.'));
  return incidentsPage(req, res);
});

router.post('/admin3119Musa/incidents/:id/update', (req, res) => {
  const r = mon.addIncidentUpdate(req.params.id, { status: req.body.status, message: req.body.message });
  if (!r.ok) return res.redirect('/admin3119Musa/incidents?err=' + encodeURIComponent(r.error));
  const inc = incidentFull(r.incident.id);
  const newUpdate = r.newUpdate;
  notify.notifyAdmin({
    kind: 'status', title: `Incident updated: ${inc.title}`,
    body: `${mon.INCIDENT_STATUS_LABELS[inc.status]} · ${newUpdate.message}`,
    url: '/admin3119Musa/incidents',
  });
  mon.notifySubscribers(`FirmLedger status: ${inc.title}`, incidentEmail(inc, newUpdate)).catch(() => {});
  res.redirect('/admin3119Musa/incidents?ok=' + encodeURIComponent(`Update posted — status is now “${mon.INCIDENT_STATUS_LABELS[inc.status]}”.`));
});

router.post('/admin3119Musa/incidents/:id/resolve', (req, res) => {
  const r = mon.resolveIncident(req.params.id);
  if (!r.ok) return res.redirect('/admin3119Musa/incidents?err=' + encodeURIComponent(r.error));
  const inc = incidentFull(r.incident.id);
  notify.notifyAdmin({
    kind: 'status', title: `Incident resolved: ${inc.title}`,
    body: `Resolved at ${String(inc.resolved_at || '').slice(0, 16).replace('T', ' ')}.`,
    url: '/admin3119Musa/incidents',
  });
  mon.notifySubscribers(`FirmLedger status: ${inc.title} resolved`, incidentEmail(inc, null)).catch(() => {});
  res.redirect('/admin3119Musa/incidents?ok=' + encodeURIComponent(`Incident resolved — marked live on /status.`));
});

module.exports = router;
