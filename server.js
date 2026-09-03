/** FirmLedger — verified company intelligence. */
const fs = require('fs');
const path = require('path');

/* Minimal .env loader (no dependency) */
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const express = require('express');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const session = require('./src/lib/session');
const util = require('./src/lib/util');

/* Bumped on every deploy that changes public/ assets — defeats the 7-day static cache. */
const ASSET_V = '44';

const app = express();
app.set('trust proxy', true);

// ===== REDIRECT onrender.com → firmledger.co.ke =====
app.use((req, res, next) => {
  const host = req.get('host');
  if (host && host.toLowerCase() === 'firmledger.onrender.com') {
    return res.redirect(301, `https://firmledger.co.ke${req.originalUrl}`);
  }
  next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(compression());
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

/* Search-index guard: a box that isn't reachable at its own BASE_URL (unset value,
   localhost, .test, private IP) must never be indexed. Real deployments are untouched
   — see src/lib/util.js isPublicBaseUrl(), or set FORCE_INDEXABLE=1 to opt back in. */
const INDEXABLE = util.isPublicBaseUrl();

/* Security headers (kept permissive enough for same-origin CSS/inline SVG) */
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (!INDEXABLE) res.set('X-Robots-Tag', 'noindex, follow');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.svg')) res.setHeader('Cache-Control', 'public, max-age=86400');
  },
}));

/* Uploaded logos (256×256, normalized) */
const uploadsDir = path.join(__dirname, 'data', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir, { maxAge: '30d', immutable: true }));

/* Per-request context + CSRF */
app.use(session.attach);
/* Trial state (res.locals.isTrialUser / trialDaysRemaining) + lazy expiry. */
app.use(require('./src/lib/plans').trialMiddleware);
app.use((req, res, next) => {
  res.locals.SITE = util.siteUrl('');
  res.locals.nlFlash = req.query.nl ? String(req.query.nl).slice(0, 200) : '';
  res.locals.nlFlashKind = req.query.nl_err ? 'err' : 'ok';
  res.locals.assetV = ASSET_V;
  res.locals.fmtDate = util.fmtDate;
  res.locals.truncate = util.truncate;
  res.locals.ICONS = require('./src/lib/socialicons').ICONS;
  res.locals.todayIso = new Date().toISOString().slice(0, 10);
  res.locals.perksActive = require('./src/lib/plans').perksActive;
  res.locals.isProUser = require('./src/lib/plans').isProUser;
  res.locals.proAccess = require('./src/lib/plans').hasProAccess;
  res.locals.nav = req.path.startsWith('/directory') || req.path.startsWith('/listing') ? 'directory'
    : req.path.startsWith('/claim') ? 'claim' : req.path.startsWith('/api') ? 'api'
    : req.path.startsWith('/pricing') ? 'pricing' : req.path.startsWith('/status') ? 'status' : '';
  res.locals.initials = (name) => {
    const words = String(name || 'F').trim().split(/[\s-]+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
  };
  res.locals.SITE_SOCIALS = [
    { key: 'x', label: 'X', url: 'https://x.com/firmledger' },
    { key: 'linkedin', label: 'LinkedIn', url: 'https://linkedin.com/company/firmledger' },
    { key: 'facebook', label: 'Facebook', url: 'https://facebook.com/firmledger' },
    { key: 'instagram', label: 'Instagram', url: 'https://instagram.com/firmledger' },
    { key: 'youtube', label: 'YouTube', url: 'https://youtube.com/@firmledger' },
    { key: 'website', label: 'Email', url: 'mailto:hello@firmledger.co.ke' },
  ];
  res.locals.typeLabel = require('./src/lib/taxonomy').typeLabel;
  res.locals.listingLoc = (l) => [l.city, l.country].filter(Boolean).join(', ') || '—';
  res.locals.dial = (c) => {
    c = Math.max(0, Math.min(100, Math.round(Number(c) || 0)));
    const cls = c >= 80 ? 'd-ok' : c >= 60 ? 'd-ac' : 'd-wa';
    return `<svg class="dial" viewBox="0 0 42 42" aria-label="confidence ${c}"><circle class="dial-bg" cx="21" cy="21" r="15.9155"/><circle class="dial-val ${cls}" cx="21" cy="21" r="15.9155" stroke-dasharray="${c}, 100"/><text x="21" y="25" text-anchor="middle">${c}</text></svg>`;
  };
  try {
    res.locals.footerCats = require('./src/lib/categories').withCounts().filter((c) => c.cnt > 0).slice(0, 4);
  } catch { res.locals.footerCats = []; }
  try {
    res.locals.footerNews = require('./src/db').db.prepare(
      "SELECT slug, title, published_at FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 3"
    ).all();
  } catch { res.locals.footerNews = []; }
  res.locals.qs = (overrides = {}) => {
    const merged = { ...req.query, ...overrides };
    const parts = Object.entries(merged).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false);
    return parts.length ? '?' + parts.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
  };
  next();
});
/* REST API v1 — key-authenticated (no cookies), so it mounts before the
   session CSRF guard. Rate limiting and brute-force guards live inside. */
app.use('/api/v1', require('./src/routes/api'));

app.use(session.csrfProtect);

/* Maintenance holding page — after sessions so a signed-in admin still works. */
app.use(require('./src/lib/maintenance').gate);
app.use(require('./src/lib/spam').scrapeGate);

/* Routes */
app.use('/', require('./src/routes/public'));
app.use('/status', require('./src/routes/status'));
app.use('/', require('./src/routes/auth'));
app.use('/', require('./src/routes/dashboard'));
app.use('/', require('./src/routes/billing'));
app.use('/', require('./src/routes/claim'));
app.use('/', require('./src/routes/admin'));
app.use('/', require('./src/routes/adminops'));
app.use('/', require('./src/routes/adminai'));

/* 404 */
app.use((req, res) => {
  res.status(404).render('error', {
    meta: { title: 'Page not found — FirmLedger', description: '', robots: 'noindex' },
    code: 404,
    heading: 'Page not found',
    message: 'The page you are looking for does not exist or was moved.',
  });
});

/* 500 */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).render('error', {
    meta: { title: 'Something went wrong — FirmLedger', description: '', robots: 'noindex' },
    code: 500,
    heading: 'Something went wrong',
    message: 'An unexpected error occurred. Our team has been notified.',
  });
});

const PORT = Number(process.env.PORT) || 3000;

/* Weekly newsletter digest — checked hourly, fires when the last send is >6.5 days old.
   Ticket auto-close runs on the same hourly tick: solved >7d, unanswered admin replies >14d.
   Archived notifications past their archive_expires_at are hard-deleted on the same tick. */
const newsletter = require('./src/lib/newsletter');
const supportLib = require('./src/lib/support');
const notificationsLib = require('./src/lib/notifications');
function hourlyJobs() {
  newsletter.sendWeeklyDigest().catch(() => {});
  try { supportLib.autoCloseStale(); } catch (e) { console.error('[auto-close]', e.message); }
  try {
    const purged = notificationsLib.purgeExpired();
    if (purged) console.log(`[notifications] purged ${purged} expired archived notification(s)`);
  } catch (e) { console.error('[notif-purge]', e.message); }
  try { require('./src/lib/plans').expireTrials(); } catch (e) { console.error('[trials]', e.message); }
  try { require('./src/lib/statusMonitor').sendWeeklyStatusDigest().catch(() => {}); } catch (e) { console.error('[status-digest]', e.message); }
}
setInterval(hourlyJobs, 3600e3);
setTimeout(hourlyJobs, 90e3);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FirmLedger running on http://0.0.0.0:${PORT} — public base: ${util.siteUrl('/')}`);
  /* Start the public status monitor once we're listening, so the first
     self-probe against our own origin succeeds. */
  try {
    require('./src/lib/statusMonitor').startMonitoring();
  } catch (e) {
    console.error('[status-monitor] failed to start:', e && e.message);
  }
  if (!INDEXABLE) {
    console.warn('⚠  BASE_URL is not a public origin — search engines are blocked with X-Robots-Tag: noindex and a "Disallow: /" robots.txt.');
    console.warn('   Before launch set BASE_URL=https://your-domain (no trailing slash) in .env and restart. Set FORCE_INDEXABLE=1 to override.');
  }
});
