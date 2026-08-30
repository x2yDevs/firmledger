const crypto = require('crypto');

function slugify(s) {
  return (
    s.toString().toLowerCase().trim()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'listing'
  );
}

function randomToken(bytes = 24) { return crypto.randomBytes(bytes).toString('hex'); }
function claimToken() { return 'flv_' + crypto.randomBytes(10).toString('hex'); }

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function truncate(s, n = 160) {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

function escXml(s) {
  return String(s || '').replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function siteUrl(path = '') {
  const base = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return base + path;
}

function normalizeUrl(u) {
  u = (u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

function domainOf(u) {
  try { return new URL(normalizeUrl(u)).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

/** Parse "one per line" textarea or JSON array into a clean array of strings */
function parseLines(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(String).map((s) => s.trim()).filter(Boolean);
  return String(input).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function parseComma(input) {
  return String(input || '').split(',').map((s) => s.trim()).filter(Boolean).join(', ');
}

/**
 * Data-confidence score (0–97): how complete + verified a record is.
 * Shown publicly — part of FirmLedger's trust layer.
 */
function confidenceScore(l) {
  let s = 18;
  if (l.website) s += 10;
  if ((l.description || '').length > 120) s += 10;
  if (l.logo_url) s += 7;
  if (l.founded) s += 6;
  if (l.country && l.city) s += 8; else if (l.country) s += 4;
  if (l.email || l.phone) s += 6;
  if (l.tags) s += 4;
  let socials = l.socials; try { if (typeof socials === 'string') socials = JSON.parse(socials); } catch { socials = {}; }
  if (Object.keys(socials || {}).length >= 2) s += 7; else if (Object.keys(socials || {}).length === 1) s += 3;
  let sources = l.sources; try { if (typeof sources === 'string') sources = JSON.parse(sources); } catch { sources = []; }
  if ((sources || []).length >= 1) s += 7;
  if ((sources || []).length >= 3) s += 5;
  if (l.claimed) s += 8;
  if (l.last_verified_at) s += 5;
  return Math.min(97, s);
}

function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim()) && e.length < 190;
}

module.exports = {
  slugify, randomToken, claimToken, fmtDate, truncate, escXml,
  siteUrl, normalizeUrl, domainOf, parseLines, parseComma,
  confidenceScore, isEmail, escHtml,
};
