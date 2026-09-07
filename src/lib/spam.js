/**
 * Spam / abuse controls — IP lists, email-domain lists, tunable rate limits.
 *
 * Lists live in SQLite (admin-editable). Rate counters are in-memory per process
 * (windows are minutes, not days). A whitelist IP skips every other check.
 */
const { db, getSetting, setSetting } = require('../db');

const DEFAULTS = {
  spam_rl_login: 10,        // / 10 minutes
  spam_rl_register: 5,      // / hour
  spam_rl_listing: 8,       // / hour
  spam_rl_claim: 6,         // / hour
  spam_rl_newsletter: 8,    // / hour
  spam_rl_status: 10,       // / hour (status page subscribe / unsubscribe)
  spam_rl_search: 60,       // / minute
  spam_rl_scrape: 180,      // / minute (directory, listing pages)
  api_read_rpm: 60,
  api_write_rpm: 20,
};

const WINDOWS = {
  login: 10 * 60 * 1000,
  register: 60 * 60 * 1000,
  listing: 60 * 60 * 1000,
  claim: 60 * 60 * 1000,
  newsletter: 60 * 60 * 1000,
  status: 60 * 60 * 1000,
  search: 60 * 1000,
  scrape: 60 * 1000,
};

const buckets = new Map();

const dns = require('dns');

/* SEO plumbing a crawler must always reach, even mid rate-limit window:
   a 429 on robots.txt or a sitemap is reported in Search Console as a crawl
   error and stalls indexing of every URL behind it. */
function isSeoFilePath(p) {
  return p === '/robots.txt' || p === '/sitemap.xml' || p === '/feed.xml'
    || p.startsWith('/sitemaps/')
    || /^\/[a-f0-9]{32}\.txt$/.test(p); /* IndexNow key file */
}

/* Search crawlers we verify by reverse DNS and then exempt from the scrape
   ceiling. Googlebot/Bingbot fetch in parallel bursts while processing a
   sitemap — a 429 at that moment reads as "server error" in Search Console
   and the whole crawl backs off. Verification is the classic two-step
   (reverse lookup must land on a bot domain, forward lookup must return the
   same IP), so a spoofed User-agent never earns the free pass; an
   unverifiable lookup simply falls back to the normal limits. */
const SEARCH_BOT_UA = /\b(Googlebot|Googlebot-Image|Googlebot-News|Bingbot|Slurp|DuckDuckBot|YandexBot|Baiduspider|Applebot)\b/i;
const BOT_RDNS_SUFFIXES = [
  '.googlebot.com', '.google.com',
  '.search.msn.com', '.bing.com',
  '.duckduckgo.com',
  '.yandex.ru', '.yandex.com', '.yandex.net',
  '.baidu.com', '.baiduspider', '.baidubot.com',
  '.apple.com',
];
const botVerifyCache = new Map(); /* ip → { verified, expires } */

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('dns timeout')), ms))]);
}

async function verifySearchBot(ip) {
  const hit = botVerifyCache.get(ip);
  const now = Date.now();
  if (hit && hit.expires > now) return hit.verified;
  let verified = false;
  try {
    const hostnames = await withTimeout(dns.promises.reverse(ip), 3000);
    const host = String((hostnames && hostnames[0]) || '').toLowerCase();
    if (host && BOT_RDNS_SUFFIXES.some((s) => host.endsWith(s))) {
      const addrs = await withTimeout(dns.promises.resolve(host), 3000);
      verified = (addrs || []).map(String).includes(ip);
    }
  } catch { verified = false; }
  botVerifyCache.set(ip, { verified, expires: now + (verified ? 24 * 60 * 60 * 1000 : 30 * 60 * 1000) });
  if (botVerifyCache.size > 5000) botVerifyCache.delete(botVerifyCache.keys().next().value);
  return verified;
}

function clientIp(req) {
  const xf = req.headers && req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim().replace(/^::ffff:/, '');
  return String((req.ip || (req.connection && req.connection.remoteAddress) || '')).replace(/^::ffff:/, '');
}

function numSetting(key) {
  const raw = getSetting(key, '');
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return DEFAULTS[key] || 0;
}

function limits() {
  return {
    login: numSetting('spam_rl_login'),
    register: numSetting('spam_rl_register'),
    listing: numSetting('spam_rl_listing'),
    claim: numSetting('spam_rl_claim'),
    newsletter: numSetting('spam_rl_newsletter'),
    status: numSetting('spam_rl_status'),
    search: numSetting('spam_rl_search'),
    scrape: numSetting('spam_rl_scrape'),
    api_read_rpm: numSetting('api_read_rpm'),
    api_write_rpm: numSetting('api_write_rpm'),
  };
}

function saveLimits(body) {
  for (const key of Object.keys(DEFAULTS)) {
    const n = parseInt(String(body[key] || ''), 10);
    if (Number.isFinite(n) && n >= 0 && n <= 100000) setSetting(key, String(n));
  }
}

function normalizeIp(v) {
  return String(v || '').trim().replace(/^::ffff:/, '').slice(0, 80);
}
function normalizeDomain(v) {
  return String(v || '').trim().toLowerCase().replace(/^@/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').slice(0, 120);
}

function listed(table, value, kind) {
  if (!value) return false;
  return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE kind=? AND value=?`).get(kind, value));
}

function ipAllowed(ip) { return listed('spam_ip', ip, 'allow'); }
function ipBlocked(ip) { return listed('spam_ip', ip, 'block'); }

function emailDomainStatus(email) {
  const domain = normalizeDomain(String(email || '').split('@')[1] || '');
  if (!domain) return { ok: false, reason: 'Enter a valid email address.' };
  if (listed('spam_domain', domain, 'block')) {
    return { ok: false, reason: 'That email domain is not accepted on FirmLedger.' };
  }
  const allowN = db.prepare("SELECT COUNT(*) c FROM spam_domain WHERE kind='allow'").get().c;
  if (allowN && !listed('spam_domain', domain, 'allow')) {
    return { ok: false, reason: 'Registration is limited to approved email domains.' };
  }
  return { ok: true, domain };
}

function charge(kind, ip) {
  const max = limits()[kind];
  const windowMs = WINDOWS[kind] || 60 * 1000;
  if (!max) return { ok: true, remaining: Infinity };
  const key = kind + ':' + ip;
  const now = Date.now();
  let rec = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (rec.length >= max) {
    buckets.set(key, rec);
    const retry = Math.max(1, Math.ceil((windowMs - (now - rec[0])) / 1000));
    return { ok: false, remaining: 0, retryAfterSec: retry };
  }
  rec.push(now);
  buckets.set(key, rec);
  return { ok: true, remaining: max - rec.length };
}

function deny(req, res, status, heading, message) {
  if (req.path && req.path.endsWith('.json') || (req.headers.accept || '').includes('application/json')) {
    return res.status(status).json({ error: { code: status === 429 ? 'rate_limited' : 'forbidden', message } });
  }
  return res.status(status).render('error', {
    meta: { title: heading + ' — FirmLedger', description: '', robots: 'noindex' },
    code: status, heading, message,
  });
}

/** Express middleware. `kind` is a rate-limit bucket. `opts.checkEmail` reads req.body.email. */
function gate(kind, opts = {}) {
  return (req, res, next) => {
    const ip = clientIp(req);
    if (ipAllowed(ip)) return next();
    if (ipBlocked(ip)) {
      return deny(req, res, 403, 'Access denied', 'Requests from this network are not accepted.');
    }
    if (opts.checkEmail) {
      const email = String((req.body && req.body.email) || '').trim().toLowerCase();
      if (email) {
        const d = emailDomainStatus(email);
        if (!d.ok) return deny(req, res, 403, 'Not accepted', d.reason);
      }
    }
    const r = charge(kind, ip);
    if (!r.ok) {
      res.set('Retry-After', String(r.retryAfterSec || 60));
      return deny(req, res, 429, 'Too many requests',
        'You have made too many requests in a short time. Wait a minute and try again.');
    }
    next();
  };
}

/** Light GET scraper ceiling — skips static-ish assets, admin, SEO files and
    reverse-DNS-verified search crawlers. */
function scrapeGate(req, res, next) {
  if (req.method !== 'GET') return next();
  if (req.admin) return next();
  const p = req.path || '';
  if (p.startsWith('/admin3119Musa') || p.startsWith('/uploads') || p.startsWith('/assets')
      || p.startsWith('/fonts') || p.startsWith('/badge')) return next();
  if (isSeoFilePath(p)) return next();
  const ip = clientIp(req);
  if (ipAllowed(ip)) return next();
  if (ipBlocked(ip)) {
    return deny(req, res, 403, 'Access denied', 'Requests from this network are not accepted.');
  }
  const chargeOrDeny = () => {
    const r = charge('scrape', ip);
    if (!r.ok) {
      res.set('Retry-After', String(r.retryAfterSec || 60));
      return deny(req, res, 429, 'Slow down', 'Too many page loads from this address. Wait a moment and try again.');
    }
    next();
  };
  if (SEARCH_BOT_UA.test(String(req.headers['user-agent'] || ''))) {
    verifySearchBot(ip).then((verified) => (verified ? next() : chargeOrDeny())).catch(chargeOrDeny);
    return;
  }
  chargeOrDeny();
}

function listIp() { return db.prepare('SELECT * FROM spam_ip ORDER BY kind, id DESC').all(); }
function listDomain() { return db.prepare('SELECT * FROM spam_domain ORDER BY kind, id DESC').all(); }

function addIp(value, kind, note) {
  const v = normalizeIp(value);
  const k = kind === 'allow' ? 'allow' : 'block';
  if (!v) return { ok: false, error: 'Enter an IP address.' };
  try {
    db.prepare('INSERT INTO spam_ip (value, kind, note) VALUES (?,?,?)').run(v, k, String(note || '').slice(0, 200));
    return { ok: true };
  } catch {
    return { ok: false, error: 'That IP is already on this list.' };
  }
}
function addDomain(value, kind, note) {
  const v = normalizeDomain(value);
  const k = kind === 'allow' ? 'allow' : 'block';
  if (!v || !v.includes('.')) return { ok: false, error: 'Enter a domain such as example.com.' };
  try {
    db.prepare('INSERT INTO spam_domain (value, kind, note) VALUES (?,?,?)').run(v, k, String(note || '').slice(0, 200));
    return { ok: true };
  } catch {
    return { ok: false, error: 'That domain is already on this list.' };
  }
}
function removeIp(id) { db.prepare('DELETE FROM spam_ip WHERE id=?').run(id); }
function removeDomain(id) { db.prepare('DELETE FROM spam_domain WHERE id=?').run(id); }

module.exports = {
  DEFAULTS, clientIp, limits, saveLimits, gate, scrapeGate,
  isSeoFilePath, verifySearchBot,
  emailDomainStatus, ipAllowed, ipBlocked,
  listIp, listDomain, addIp, addDomain, removeIp, removeDomain,
  numSetting,
};
