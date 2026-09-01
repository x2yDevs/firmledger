/**
 * FirmLedger — Google & LinkedIn sign-in (Passport.js).
 *
 * The app owns its own cookie sessions (src/lib/session.js), so Passport runs
 * stateless: `session: false` everywhere, no serializeUser/deserializeUser and
 * no express-session dependency. Each strategy resolves an account and the
 * route hands it to createSession().
 *
 * Account resolution — in this order:
 *   1. provider + provider_id match  → sign that account in;
 *   2. same email already registered → LINK the provider to it (provider,
 *      provider_id, avatar_url) and sign in;
 *   3. nothing matches              → create a new account from the profile.
 *
 * Environment:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET
 * A provider with missing credentials is simply not registered, and its
 * buttons stay hidden on the login page.
 */
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const LinkedInStrategy = require('passport-linkedin-oauth2').Strategy;

const { db } = require('../db');
const { siteUrl, isEmail } = require('./util');
const passwords = require('./passwords');

const GOOGLE_CALLBACK = '/auth/google/callback';
const LINKEDIN_CALLBACK = '/auth/linkedin/callback';

function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
function linkedinConfigured() {
  return Boolean(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);
}

/* ---------------- Account resolution ---------------- */

/**
 * Find, link, or create the account behind an OAuth profile.
 * @param {{provider: string, providerId: string, email: string, name: string, avatarUrl: string}} p
 * @returns {{ok: boolean, user?: object, linked?: boolean, created?: boolean, error?: string}}
 */
function findOrCreateOAuthUser(p) {
  const provider = String(p.provider || '').toLowerCase();
  const providerId = String(p.providerId || '');
  const email = String(p.email || '').trim().toLowerCase();
  const name = String(p.name || '').trim().slice(0, 80);
  const avatarUrl = String(p.avatarUrl || '').slice(0, 500);
  if (!provider || !providerId) return { ok: false, error: 'The provider did not return an account id.' };

  /* 1. Same provider + provider_id — a returning OAuth user. */
  const byProvider = db.prepare('SELECT * FROM users WHERE provider = ? AND provider_id = ?').get(provider, providerId);
  if (byProvider) {
    if (byProvider.suspended) return { ok: false, error: 'suspended' };
    db.prepare('UPDATE users SET avatar_url = COALESCE(NULLIF(?, \'\'), avatar_url) WHERE id = ?').run(avatarUrl, byProvider.id);
    return { ok: true, user: db.prepare('SELECT * FROM users WHERE id=?').get(byProvider.id) };
  }

  if (!isEmail(email)) {
    return { ok: false, error: 'no-email' };
  }

  /* 2. The email is already registered — link the provider to that account. */
  const byEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (byEmail) {
    if (byEmail.suspended) return { ok: false, error: 'suspended' };
    db.prepare(
      `UPDATE users
          SET provider = ?, provider_id = ?,
              avatar_url = COALESCE(NULLIF(?, ''), avatar_url),
              name = CASE WHEN name = '' THEN ? ELSE name END
        WHERE id = ?`
    ).run(provider, providerId, avatarUrl, name, byEmail.id);
    return { ok: true, linked: true, user: db.prepare('SELECT * FROM users WHERE id=?').get(byEmail.id) };
  }

  /* 3. Brand new account. password_hash is NOT NULL — store an unusable
        random hash so the account can only be entered via OAuth (or after a
        password reset from /forgot). */
  const unusable = passwords.hash(require('crypto').randomBytes(32).toString('hex'));
  const info = db.prepare(
    `INSERT INTO users (email, password_hash, name, provider, provider_id, avatar_url)
     VALUES (?,?,?,?,?,?)`
  ).run(email, unusable, name || email.split('@')[0], provider, providerId, avatarUrl);
  return { ok: true, created: true, user: db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid) };
}

/* ---------------- Profile normalizers ---------------- */

function fromGoogleProfile(profile) {
  const emails = profile.emails || [];
  const photos = profile.photos || [];
  return {
    provider: 'google',
    providerId: String(profile.id || ''),
    email: (emails[0] && emails[0].value) || (profile._json && profile._json.email) || '',
    name: profile.displayName || (profile._json && profile._json.name) || '',
    avatarUrl: (photos[0] && photos[0].value) || (profile._json && profile._json.picture) || '',
  };
}

function fromLinkedInProfile(profile) {
  const j = profile._json || {};
  const emails = profile.emails || [];
  const photos = profile.photos || [];
  const name = profile.displayName || j.name
    || [j.given_name, j.family_name].filter(Boolean).join(' ');
  return {
    provider: 'linkedin',
    providerId: String(profile.id || j.sub || ''),
    email: (emails[0] && emails[0].value) || j.email || '',
    name: name || '',
    avatarUrl: (photos[0] && photos[0].value) || j.picture || '',
  };
}

/* ---------------- Strategies ---------------- */

let registered = false;

function register() {
  if (registered) return passport;
  registered = true;

  if (googleConfigured()) {
    passport.use(new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: siteUrl(GOOGLE_CALLBACK),
        scope: ['profile', 'email'],
      },
      (accessToken, refreshToken, profile, done) => {
        try {
          const r = findOrCreateOAuthUser(fromGoogleProfile(profile));
          if (!r.ok) return done(null, false, { message: r.error });
          return done(null, r.user, { linked: r.linked, created: r.created });
        } catch (e) {
          return done(e);
        }
      }
    ));
  }

  if (linkedinConfigured()) {
    /* LinkedIn "Sign In with LinkedIn using OpenID Connect": scopes
       openid/profile/email, claims read from /v2/userinfo. The strategy's
       built-in (deprecated) r_liteprofile lookup is replaced below. */
    const linkedin = new LinkedInStrategy(
      {
        clientID: process.env.LINKEDIN_CLIENT_ID,
        clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
        callbackURL: siteUrl(LINKEDIN_CALLBACK),
        scope: ['openid', 'profile', 'email'],
      },
      (accessToken, refreshToken, profile, done) => {
        try {
          const r = findOrCreateOAuthUser(fromLinkedInProfile(profile));
          if (!r.ok) return done(null, false, { message: r.error });
          return done(null, r.user, { linked: r.linked, created: r.created });
        } catch (e) {
          return done(e);
        }
      }
    );

    linkedin.userProfile = function userProfile(accessToken, done) {
      fetch('https://api.linkedin.com/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`LinkedIn userinfo HTTP ${r.status}`))))
        .then((j) => done(null, {
          provider: 'linkedin',
          id: j.sub,
          displayName: j.name || [j.given_name, j.family_name].filter(Boolean).join(' '),
          emails: j.email ? [{ value: j.email }] : [],
          photos: j.picture ? [{ value: j.picture }] : [],
          _json: j,
        }))
        .catch((e) => done(e));
    };

    passport.use(linkedin);
  }

  return passport;
}

module.exports = {
  passport, register,
  googleConfigured, linkedinConfigured,
  findOrCreateOAuthUser,
  fromGoogleProfile, fromLinkedInProfile,
  GOOGLE_CALLBACK, LINKEDIN_CALLBACK,
};
