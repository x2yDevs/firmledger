/**
 * Cookie-backed sessions persisted in SQLite. Two session kinds:
 *  - user  (fl_session cookie) — registered members
 *  - admin (fl_admin cookie)  — granted exclusively via the admin secret code
 */
const crypto = require('crypto');
const { db } = require('../db');
const { randomToken } = require('./util');

const USER_COOKIE = 'fl_session';
const ADMIN_COOKIE = 'fl_admin';
const SESSION_DAYS = 30;

function createSession(userId, kind) {
  const token = randomToken(32);
  const csrf = randomToken(16);
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare(
    'INSERT INTO sessions (token, user_id, csrf, kind, expires_at) VALUES (?,?,?,?,?)'
  ).run(token, userId, csrf, kind, expires);
  return { token, csrf };
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function loadSession(token, kind) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ? AND kind = ?').get(token, kind);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    destroySession(token);
    return null;
  }
  return s;
}

function setSessionCookie(req, res, name, token) {
  res.cookie(name, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_DAYS * 864e5,
    path: '/',
  });
}

/** Attaches req.user / req.admin + template locals. Mount after cookie-parser. */
function attach(req, res, next) {
  // opportunistic cleanup of expired sessions (1% of requests)
  if (Math.random() < 0.01) {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  }

  const userSess = loadSession(req.cookies[USER_COOKIE], 'user');
  const adminSess = loadSession(req.cookies[ADMIN_COOKIE], 'admin');

  req.userSession = userSess;
  req.adminSession = adminSess;
  req.user = userSess
    ? db.prepare(`SELECT id, email, name, role, created_at, suspended, plan, plan_expires_at,
                         subscription_status, trial_started_at, trial_expires_at, trial_days,
                         provider, provider_id, avatar_url
                    FROM users WHERE id = ?`).get(userSess.user_id)
    : null;
  if (req.user && req.user.suspended) {
    destroySession(userSess.token);
    res.clearCookie(USER_COOKIE);
    req.user = null;
    req.userSession = null;
  }
  req.admin = adminSess ? { via: 'secret-code' } : null;

  res.locals.user = req.user;
  res.locals.admin = req.admin;
  res.locals.csrfToken = (userSess || adminSess || {}).csrf || '';
  res.locals.path = req.path;
  res.locals.q = req.query;
  res.locals.flash = { ok: req.query.ok || '', err: req.query.err || '' };
  try {
    const notify = require('./notify');
    res.locals.userUnread = req.user ? notify.unreadUser(req.user.id) : 0;
    res.locals.adminUnread = req.admin ? notify.unreadAdmin() : 0;
  } catch {
    res.locals.userUnread = 0;
    res.locals.adminUnread = 0;
  }
  next();
}

/** Length-safe constant-time token compare (timingSafeEqual throws on length mismatch). */
function tokenEq(sent, expected) {
  const a = Buffer.from(String(sent == null ? '' : sent));
  const b = Buffer.from(String(expected == null ? '' : expected));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

/** CSRF guard for state-changing requests made under an active session. */
function csrfProtect(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  // multipart bodies aren't parsed yet — those routes validate after multer (see validCsrf)
  if ((req.headers['content-type'] || '').includes('multipart/form-data')) return next();
  const sess = req.userSession || req.adminSession;
  if (!sess) return next(); // unauthenticated posts (login/register) hold no privilege
  const sent = (req.body && req.body._csrf)
    || req.get('x-csrf-token')
    || req.get('x-xsrf-token')
    || '';
  if (tokenEq(sent, sess.csrf)) return next();
  return csrfFail(res, req);
}

/** Re-check after multer has populated req.body on multipart/form-data routes. */
function validCsrf(req) {
  const sess = req.userSession || req.adminSession;
  if (!sess) return true;
  return tokenEq(req.body && req.body._csrf, sess.csrf);
}

function csrfFail(res, req) {
  const wantsJson = req && (
    String(req.headers.accept || '').includes('application/json')
    || String(req.headers['content-type'] || '').includes('application/json')
    || req.xhr
  );
  if (wantsJson) {
    return res.status(403).json({ ok: false, error: 'Security check failed. Reload the page and try again.' });
  }
  return res.status(403).render('error', {
    meta: { title: 'Session expired — FirmLedger', description: 'Security check failed.', robots: 'noindex' },
    code: 403,
    heading: 'Security check failed',
    message: 'The form expired or was tampered with. Go back, reload the page, and try again.',
  });
}

function requireUser(req, res, next) {
  if (req.user) return next();
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

function requireAdmin(req, res, next) {
  if (req.admin) return next();
  const wantsJson = String(req.headers.accept || '').includes('application/json')
    || String(req.headers['content-type'] || '').includes('application/json')
    || req.xhr;
  if (wantsJson) {
    return res.status(401).json({ ok: false, error: 'Admin session expired. Reload and sign in again.' });
  }
  res.redirect('/admin3119Musa');
}

module.exports = {
  USER_COOKIE, ADMIN_COOKIE,
  createSession, destroySession, setSessionCookie, loadSession,
  attach, csrfProtect, validCsrf, requireUser, requireAdmin,
};
