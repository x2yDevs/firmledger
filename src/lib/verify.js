/**
 * Ownership verification for the "Claim this listing" flow.
 * Three independent methods, all checked server-side:
 *   dns   — TXT record on the domain: firmledger-verification=<token>
 *   meta  — <meta name="firmledger-verification" content="<token>"> on homepage
 *   badge — FirmLedger badge/snippet containing the token on homepage
 */
const dns = require('dns').promises;
const { normalizeUrl } = require('./util');

const UA = 'FirmLedgerBot/1.0 (+https://firmledger.co.ke/verification)';

async function fetchPage(domain) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(normalizeUrl(domain), {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) return null;
    const body = await res.text();
    return body.slice(0, 2_000_000); // 2 MB ceiling
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function checkDns(domain, token) {
  const names = [domain, `_firmledger.${domain}`];
  const accepted = [`firmledger-verification=${token}`, token];
  for (const name of names) {
    try {
      const records = await dns.resolveTxt(name);
      const flat = records.map((chunks) => chunks.join(''));
      if (flat.some((txt) => accepted.some((a) => txt.includes(a)))) {
        return { ok: true, detail: `TXT record found on ${name}` };
      }
    } catch { /* ENOTFOUND / ENODATA — try next */ }
  }
  return {
    ok: false,
    detail: `No matching TXT record yet on ${domain} or _firmledger.${domain}. DNS changes can take a few minutes to propagate.`,
  };
}

async function checkMeta(domain, token) {
  const html = await fetchPage(domain);
  if (html === null) return { ok: false, detail: `Could not reach https://${domain} — check the address and that the site is up.` };
  const re = new RegExp(
    `<meta[^>]+name=["']firmledger-verification["'][^>]+content=["']${token}["']`,
    'i'
  );
  const reAlt = new RegExp(
    `<meta[^>]+content=["']${token}["'][^>]+name=["']firmledger-verification["']`,
    'i'
  );
  if (re.test(html) || reAlt.test(html)) return { ok: true, detail: 'Meta tag found on homepage.' };
  return { ok: false, detail: 'Meta tag not detected on the homepage yet. Paste it inside <head> and retry.' };
}

async function checkBadge(domain, token) {
  const html = await fetchPage(domain);
  if (html === null) return { ok: false, detail: `Could not reach https://${domain} — check the address and that the site is up.` };
  const hasRef = /firmledger\.co\.ke/i.test(html);
  const hasToken = html.includes(token);
  if (hasRef && hasToken) return { ok: true, detail: 'FirmLedger badge detected on homepage.' };
  if (!hasRef) return { ok: false, detail: 'No reference to firmledger.co.ke found on the homepage yet.' };
  return { ok: false, detail: 'Badge found but the verification token is missing — paste the exact snippet we provided.' };
}

function runCheck(method, domain, token) {
  if (method === 'dns') return checkDns(domain, token);
  if (method === 'meta') return checkMeta(domain, token);
  if (method === 'badge') return checkBadge(domain, token);
  return Promise.resolve({ ok: false, detail: 'Unknown verification method.' });
}

module.exports = { runCheck };
