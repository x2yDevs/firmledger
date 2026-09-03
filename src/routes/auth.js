const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const passwords = require('../lib/passwords');
const { sendMail, sendBranded } = require('../lib/mailer');
const { randomToken, isEmail, siteUrl } = require('../lib/util');
const {
  USER_COOKIE, createSession, destroySession, setSessionCookie,
} = require('../lib/session');

const spam = require('../lib/spam');
const oauth = require('../lib/oauth');
const trialmail = require('../lib/trialmail');
oauth.register();

const router = express.Router();

const page = (view, meta, data = {}) => (req, res) => res.render(view, { meta, ...data, errors: [], old: {} });

/* ---------------- Register ---------------- */
router.get('/register', (req, res) => {
  res.render('auth/register', {
    meta: {
      title: 'Create your FirmLedger account',
      description: 'Join FirmLedger to submit listings, claim and manage business profiles, and build your verified presence.',
      canonical: siteUrl('/register'), robots: 'index, follow',
    },
    errors: [], old: {}, next: req.query.next || '', ...oauthLocals(),
  });
});

/* ---------------- Registration — step 1: request an OTP ----------------
   A user does not exist until the emailed code is confirmed, so nobody can
   create an account on someone else's email address. Codes live 15 minutes. */
const OTP_TTL_MIN = 15;
const OTP_TTL_MS = OTP_TTL_MIN * 60 * 1000;

function newOtp(email, name, passwordHash) {
  db.prepare('DELETE FROM reg_otps WHERE email = ?').run(email);
  const code = String(crypto.randomInt(100000, 1000000)); // 6 digits
  db.prepare('INSERT INTO reg_otps (email, name, password_hash, code, expires_at) VALUES (?,?,?,?,?)')
    .run(email, name, passwordHash, code, new Date(Date.now() + OTP_TTL_MS).toISOString());
  return code;
}

function sendOtpMailFix(email, name, code) {
  return sendBranded(email, `${code} is your FirmLedger verification code`, {
    kicker: 'Email verification',
    title: `Verify it's really you`,
    preheader: `Your FirmLedger verification code is ${code} — valid for ${OTP_TTL_MIN} minutes.`,
    paragraphs: [
      `Hi ${escBuzz(name)}, enter this code on the confirmation page to finish creating your account. It's valid for <b>${OTP_TTL_MIN} minutes</b>.`,
    ],
    otp: code,
    note: `If you didn't try to create a FirmLedger account, ignore this email — no account was created.`,
  });
}

router.post('/register', spam.gate('register', { checkEmail: true }), (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 80);
  const email = (req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const errors = [];

  if (!name) errors.push('Your name is required.');
  if (!isEmail(email)) errors.push('Enter a valid email address.');
  if (password.length < 8) errors.push('Password must be at least 8 characters.');
  if (String(req.body.password_confirm || '') !== password) errors.push('The two passwords do not match. Retype them carefully.');
  if (!errors.length && db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    errors.push('An account with this email already exists. Try signing in.');
  }
  if (errors.length) {
    return res.status(422).render('auth/register', {
      meta: { title: 'Create your FirmLedger account', description: '', robots: 'noindex' },
      errors, old: { name, email }, next: req.body.next || '', ...oauthLocals(),
    });
  }

  // stage Step 2: email a 6-digit OTP good for 15 minutes (newsletter opt-in carries over)
  const hash = passwords.hash(password);
  const code = newOtp(email, name, hash);
  if (req.body.newsletter === '1') db.prepare('UPDATE reg_otps SET newsletter=1 WHERE email=?').run(email);
  sendOtpMailFix(email, name, code).catch(() => {});
  res.redirect('/register/verify?email=' + encodeURIComponent(email));
});

router.get('/register/verify', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  res.render('auth/verify', {
    meta: { title: 'Check your email — FirmLedger', description: '', robots: 'noindex' },
    email, ttl: OTP_TTL_MIN, errors: [], resent: String(req.query.resent || '') === '1',
  });
});

router.post('/register/verify', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').replace(/\D/g, '');
  const row = db.prepare('SELECT * FROM reg_otps WHERE email = ? ORDER BY id DESC LIMIT 1').get(email);
  const renderErr = (msg) => res.status(401).render('auth/verify', {
    meta: { title: 'Check your email — FirmLedger', description: '', robots: 'noindex' },
    email, ttl: OTP_TTL_MIN, errors: [msg], resent: false,
  });
  if (!row) return renderErr('No verification is pending for that email — start again at the sign-up page.');
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM reg_otps WHERE id = ?').run(row.id);
    return renderErr(`That code expired — press "Resend code" and we'll email you a fresh one.`);
  }
  if (row.attempts >= 6) return renderErr('Too many wrong codes — press "Resend code" for a fresh one.');
  if (code !== row.code) {
    db.prepare('UPDATE reg_otps SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return renderErr(`That code doesn't match. Check the latest email and try again.`);
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    db.prepare('DELETE FROM reg_otps WHERE id = ?').run(row.id);
    return res.redirect('/login?ok=' + encodeURIComponent('That email is already registered — sign in instead.'));
  }

  const info = db.transaction(() => {
    db.prepare('DELETE FROM reg_otps WHERE email = ?').run(email);
    return db.prepare('INSERT INTO users (email, password_hash, name) VALUES (?,?,?)').run(email, row.password_hash, row.name);
  })();
  if (row.newsletter) {
    try { require('../lib/newsletter').subscribe(email, 'register'); } catch {}
  }
  const sess = createSession(info.lastInsertRowid, 'user');
  setSessionCookie(req, res, USER_COOKIE, sess.token);
  sendBranded(email, 'Welcome to FirmLedger', {
    kicker: 'Account verified',
    title: `Welcome, ${escBuzz(row.name)}`,
    preheader: 'Your email is verified and your account is ready.',
    alert: `Your email address is verified. You're signed in and your account is live.`,
    alertTone: 'ok',
    paragraphs: [
      `From here you can submit a company listing, claim your business record, and upgrade to FirmLedger Pro whenever you're ready. Security-sensitive changes are confirmed to <b>${escBuzz(email)}</b> automatically.`,
      `Your account also includes a <b>free Pro trial</b> — a separate email with the activation link is on its way, or head straight to the <a href="${siteUrl('/pricing#free-trial')}" style="color:#1D4ED8;">pricing page</a> to switch it on.`,
    ],
    cta: { label: 'Open your dashboard', url: siteUrl('/dashboard') },
    note: `Tip: add your first listing at <a href="${siteUrl('/dashboard/listings/new')}" style="color:#1D4ED8;">/dashboard/listings/new</a>.`,
  }).catch(() => {});
  /* Free-trial invite — activated by the member on /pricing. */
  trialmail.sendTrialInvite({ id: info.lastInsertRowid, email, name: row.name }).catch(() => {});
  res.redirect('/dashboard?ok=' + encodeURIComponent('Email verified — welcome to FirmLedger. Check your inbox: your free Pro trial is waiting on the pricing page.'));
});

router.post('/register/verify/resend', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const row = db.prepare('SELECT * FROM reg_otps WHERE email = ? ORDER BY id DESC LIMIT 1').get(email);
  if (row && !db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    const code = newOtp(email, row.name, row.password_hash);
    sendOtpMailFix(email, row.name, code).catch(() => {});
  }
  res.redirect('/register/verify?email=' + encodeURIComponent(email) + '&resent=1');
});

function escBuzz(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

/* ---------------- Login ---------------- */
/* Which social buttons the login page may show. */
const oauthLocals = () => ({
  oauthGoogle: oauth.googleConfigured(),
  oauthLinkedIn: oauth.linkedinConfigured(),
});

router.get('/login', (req, res) => {
  res.render('auth/login', {
    meta: { title: 'Sign in — FirmLedger', description: 'Sign in to manage your FirmLedger listings.', canonical: siteUrl('/login'), robots: 'index, follow' },
    errors: [], old: {}, next: req.query.next || '', ...oauthLocals(),
  });
});

router.post('/login', spam.gate('login'), (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !passwords.verify(String(req.body.password || ''), user.password_hash)) {
    return res.status(422).render('auth/login', {
      meta: { title: 'Sign in — FirmLedger', description: '', robots: 'noindex' },
      errors: ['Incorrect email or password.'], old: { email }, next: req.body.next || '', ...oauthLocals(),
    });
  }
  if (user.suspended) {
    return res.status(403).render('auth/login', {
      meta: { title: 'Sign in — FirmLedger', description: '', robots: 'noindex' },
      errors: ['This account is suspended. Contact support@firmledger.co.ke if you believe this is a mistake.'], old: { email }, next: req.body.next || '', ...oauthLocals(),
    });
  }
  const sess = createSession(user.id, 'user');
  setSessionCookie(req, res, USER_COOKIE, sess.token);
  const next = String(req.body.next || '');
  res.redirect(next.startsWith('/') ? next : '/dashboard');
});

/* ================= OAuth — Google & LinkedIn =================
   Stateless Passport (session: false): the strategy resolves the account and
   we mint a normal FirmLedger session cookie. The intended destination rides
   in a short-lived cookie so ?next= survives the round trip to the provider. */
const OAUTH_NEXT_COOKIE = 'fl_oauth_next';

function rememberNext(req, res) {
  const raw = String(req.query.next || '');
  const dest = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/dashboard';
  res.cookie(OAUTH_NEXT_COOKIE, dest, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 10 * 60 * 1000, path: '/',
  });
}

function takeNext(req, res) {
  const raw = String(req.cookies[OAUTH_NEXT_COOKIE] || '');
  res.clearCookie(OAUTH_NEXT_COOKIE, { path: '/' });
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/dashboard';
}

const OAUTH_ERRORS = {
  suspended: 'This account is suspended. Contact support@firmledger.co.ke if you believe this is a mistake.',
  'no-email': 'Your provider did not share an email address, so we could not match or create an account. Sign in with your email and password instead.',
};

/** Shared callback handler for both providers. */
function oauthCallback(strategy, label) {
  return (req, res, nextFn) => {
    oauth.passport.authenticate(strategy, { session: false }, (err, user, info) => {
      const dest = takeNext(req, res);
      if (err) {
        console.error(`[oauth:${strategy}]`, err.message || err);
        return res.redirect('/login?err=' + encodeURIComponent(`${label} sign-in failed. Please try again.`));
      }
      if (!user) {
        const msg = OAUTH_ERRORS[(info && info.message) || ''] || `${label} sign-in was cancelled or could not be completed.`;
        return res.redirect('/login?err=' + encodeURIComponent(msg));
      }
      const sess = createSession(user.id, 'user');
      setSessionCookie(req, res, USER_COOKIE, sess.token);
      if (info && info.created) {
        /* Brand-new account via Google/LinkedIn — same welcome as email
           sign-up: a free-trial invite the member activates on /pricing. */
        sendBranded(user.email, 'Welcome to FirmLedger', {
          kicker: 'Account created',
          title: `Welcome, ${escBuzz(user.name || user.email)}`,
          preheader: `Your FirmLedger account is ready — created with ${label}.`,
          alert: `Your account was created with <b>${escBuzz(label)}</b> sign-in and is live.`,
          alertTone: 'ok',
          paragraphs: [
            `From here you can submit a company listing, claim your business record, and upgrade to FirmLedger Pro whenever you're ready.`,
            `Your account also includes a <b>free Pro trial</b> — a separate email with the activation link is on its way, or head straight to the <a href="${siteUrl('/pricing#free-trial')}" style="color:#1D4ED8;">pricing page</a> to switch it on.`,
          ],
          cta: { label: 'Open your dashboard', url: siteUrl('/dashboard') },
          note: `Tip: add your first listing at <a href="${siteUrl('/dashboard/listings/new')}" style="color:#1D4ED8;">/dashboard/listings/new</a>.`,
        }).catch(() => {});
        trialmail.sendTrialInvite(user).catch(() => {});
        return res.redirect('/dashboard?ok=' + encodeURIComponent(
          `Welcome to FirmLedger — your account was created with ${label}. Check your inbox: your free Pro trial is waiting on the pricing page.`));
      }
      return res.redirect(dest);
    })(req, res, nextFn);
  };
}

/* Google */
router.get('/auth/google', (req, res, nextFn) => {
  if (!oauth.googleConfigured()) {
    return res.redirect('/login?err=' + encodeURIComponent('Google sign-in is not configured on this installation.'));
  }
  rememberNext(req, res);
  return oauth.passport.authenticate('google', {
    session: false, scope: ['profile', 'email'], prompt: 'select_account',
  })(req, res, nextFn);
});
router.get('/auth/google/callback', oauthCallback('google', 'Google'));

/* LinkedIn */
router.get('/auth/linkedin', (req, res, nextFn) => {
  if (!oauth.linkedinConfigured()) {
    return res.redirect('/login?err=' + encodeURIComponent('LinkedIn sign-in is not configured on this installation.'));
  }
  rememberNext(req, res);
  return oauth.passport.authenticate('linkedin', {
    session: false, scope: ['openid', 'profile', 'email'],
  })(req, res, nextFn);
});
router.get('/auth/linkedin/callback', oauthCallback('linkedin', 'LinkedIn'));

/* ---------------- Logout ---------------- */
router.post('/logout', (req, res) => {
  destroySession(req.cookies[USER_COOKIE]);
  res.clearCookie(USER_COOKIE, { path: '/' });
  res.redirect('/');
});

/* ---------------- Password reset ---------------- */
router.get('/forgot', (req, res) => {
  res.render('auth/forgot', {
    meta: { title: 'Reset your password — FirmLedger', description: '', robots: 'noindex' },
    sent: false, errors: [],
  });
});

router.post('/forgot', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const user = isEmail(email) && db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
  if (user) {
    const token = randomToken(24);
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO resets (token, email, expires_at) VALUES (?,?,?)').run(token, email, expires);
    sendBranded(email, 'Reset your FirmLedger password', {
      kicker: 'Password reset',
      title: 'Reset your password',
      preheader: 'A password reset was requested for your FirmLedger account.',
      alert: `A reset request was made for <b>${escBuzz(email)}</b>. The link below is valid for <b>1 hour</b>.`,
      alertTone: 'warn',
      paragraphs: [
        'Use the button below to choose a new password for your FirmLedger account. For your security, this link can only be used once and expires in an hour.',
      ],
      cta: { label: 'Choose a new password', url: siteUrl(`/reset/${token}`) },
      note: `If you didn't request this, you can ignore this email — your password stays unchanged.`,
    }).catch(() => {});
  }
  // never reveal whether the account exists
  res.render('auth/forgot', {
    meta: { title: 'Reset your password — FirmLedger', description: '', robots: 'noindex' },
    sent: true, errors: [],
  });
});

router.get('/reset/:token', (req, res) => {
  const r = db.prepare('SELECT * FROM resets WHERE token = ?').get(req.params.token);
  const valid = r && new Date(r.expires_at).getTime() > Date.now();
  if (!valid) {
    return res.status(410).render('error', {
      meta: { title: 'Link expired — FirmLedger', description: '', robots: 'noindex' },
      code: 410, heading: 'This reset link has expired',
      message: 'Password reset links are valid for one hour. Request a new one.',
    });
  }
  res.render('auth/reset', {
    meta: { title: 'Choose a new password — FirmLedger', description: '', robots: 'noindex' },
    token: req.params.token, errors: [],
  });
});

router.post('/reset/:token', (req, res) => {
  const r = db.prepare('SELECT * FROM resets WHERE token = ?').get(req.params.token);
  const valid = r && new Date(r.expires_at).getTime() > Date.now();
  const password = String(req.body.password || '');
  if (!valid) return res.redirect('/forgot');
  if (password.length < 8) {
    return res.status(422).render('auth/reset', {
      meta: { title: 'Choose a new password — FirmLedger', description: '', robots: 'noindex' },
      token: req.params.token, errors: ['Password must be at least 8 characters.'],
    });
  }
  if (String(req.body.password_confirm || '') !== password) {
    return res.status(422).render('auth/reset', {
      meta: { title: 'Choose a new password — FirmLedger', description: '', robots: 'noindex' },
      token: req.params.token, errors: ['The two passwords do not match. Retype them carefully.'],
    });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(passwords.hash(password), r.email);
  db.prepare('DELETE FROM resets WHERE email = ?').run(r.email);
  // revoke existing sessions for that account
  db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)').run(r.email);
  sendBranded(r.email, 'Your FirmLedger password was changed', {
    kicker: 'Security notice',
    title: 'Your password was changed',
    preheader: 'Your FirmLedger password was changed and all other sessions were signed out.',
    alert: `If this wasn't you, contact <b>support@firmledger.co.ke</b> immediately so your account can be secured.`,
    alertTone: 'warn',
    paragraphs: [
      `The password for <b>${escBuzz(r.email)}</b> was just changed. All previous sessions on this account have been signed out.`,
    ],
    cta: { label: 'Sign in to your account', url: siteUrl('/login') },
    note: 'You\'re receiving this because security-sensitive changes to FirmLedger accounts are always confirmed by email.',
  }).catch(() => {});
  res.redirect('/login?ok=' + encodeURIComponent('Password updated — sign in with your new password.'));
});

module.exports = router;
