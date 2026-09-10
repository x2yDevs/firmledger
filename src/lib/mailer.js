/**
 * Outbound mail — multi-provider SMTP with automatic failover.
 *
 * Same From address is used on every hop. Transports are tried in order:
 *   1. SMTP_URL / MAIL_* env (primary)
 *   2. SMTP2_URL … SMTP6_URL env failover slots
 *   3. Legacy Admin → Settings smtp_host (if env is empty)
 *   4. Admin → Settings mail accounts (smtp_accounts), by sort
 *
 * When a hop hits a daily cap or a rate/quota/limit error, the next hop is
 * used automatically. Failures still land in data/outbox.log.
 *
 * A single message may pin a provider to the front of the chain (viaKey on
 * sendMail/sendBranded) — the Admin → Email bulk-mailer does this when the
 * admin chooses which provider a mass send goes out on.
 *
 *   sendMail(to, subject, text)        plain text
 *   sendBranded(to, subject, {...})    FirmLedger-branded HTML + text fallback
 *                                      (pass alias:'billing'|'security'|… to
 *                                      pick the purpose-matched From address)
 *   sendTest(to)                       admin test through the live chain
 *   sendTestVia(key, to)               test ONE provider, bypassing failover
 *   keepAliveSweep()                   ping idle providers → admin@firmledger.co.ke
 *                                      so vendors don't close unused accounts
 */
const fs = require('fs');
const path = require('path');

const outboxPath = path.join(__dirname, '..', '..', 'data', 'outbox.log');

const PROVIDERS = [
  { id: 'zoho', name: 'Zoho Mail', host: 'smtp.zoho.com', port: 465, secure: 1 },
  { id: 'zoho_pro', name: 'Zoho Mail (smtppro)', host: 'smtppro.zoho.com', port: 465, secure: 1 },
  { id: 'brevo', name: 'Brevo', host: 'smtp-relay.brevo.com', port: 587, secure: 0 },
  { id: 'mailtrap', name: 'Mailtrap', host: 'live.smtp.mailtrap.io', port: 587, secure: 0 },
  { id: 'smtp2go', name: 'SMTP2GO', host: 'mail.smtp2go.com', port: 587, secure: 0 },
  { id: 'resend', name: 'Resend', host: 'smtp.resend.com', port: 465, secure: 1 },
  { id: 'ahasend', name: 'AhaSend', host: 'send.ahasend.com', port: 587, secure: 0 },
  { id: 'smtpfast', name: 'SMTPfast', host: 'smtp.smtpfast.com', port: 587, secure: 0 },
  { id: 'forwardemail', name: 'Forward Email', host: 'smtp.forwardemail.net', port: 465, secure: 1 },
  { id: 'dnsexit', name: 'DNSExit', host: 'mail.dnsexit.com', port: 587, secure: 0 },
  { id: 'custom', name: 'Custom SMTP', host: '', port: 587, secure: 0 },
];

/**
 * FirmLedger sender aliases — every outbound email picks the address that
 * matches its purpose, so replies and spam filtering land in the right place.
 * Pass `alias: '<key>'` to sendBranded (an explicit `from` still wins).
 */
const ALIASES = {
  admin:    { email: 'admin@firmledger.co.ke',    name: 'FirmLedger Admin',    purpose: 'Admin console notices, mail keep-alive & deliverability checks' },
  billing:  { email: 'billing@firmledger.co.ke',  name: 'FirmLedger Billing',  purpose: 'Receipts, checkout, plan & trial lifecycle' },
  careers:  { email: 'careers@firmledger.co.ke',  name: 'FirmLedger Careers',  purpose: 'Job openings & applications' },
  hello:    { email: 'hello@firmledger.co.ke',    name: 'FirmLedger',          purpose: 'Welcomes, newsletters, announcements & offers' },
  legal:    { email: 'legal@firmledger.co.ke',    name: 'FirmLedger Legal',    purpose: 'Ownership disputes, takedowns & legal notices' },
  noreply:  { email: 'noreply@firmledger.co.ke',  name: 'FirmLedger',          purpose: 'One-time codes & automated transactional mail' },
  privacy:  { email: 'privacy@firmledger.co.ke',  name: 'FirmLedger Privacy',  purpose: 'Account deletion & personal-data requests' },
  security: { email: 'security@firmledger.co.ke', name: 'FirmLedger Security', purpose: 'Password, 2FA, sign-in & account-security alerts' },
  status:   { email: 'status@firmledger.co.ke',   name: 'FirmLedger Status',   purpose: 'Uptime, incidents & maintenance notices' },
  support:  { email: 'support@firmledger.co.ke',  name: 'FirmLedger Support',  purpose: 'Claims, tickets & account help' },
};

/** RFC-5322 From string for an alias key — falls back to the global From. */
function aliasFrom(key) {
  const a = ALIASES[key];
  if (!a) return fromAddress();
  return `${a.name} <${a.email}>`;
}

let logoAttachment = null;
function getLogoAttachment() {
  if (logoAttachment) return logoAttachment;
  try {
    const p = path.join(__dirname, '..', '..', 'public', 'assets', 'logo-white.png');
    const buf = fs.readFileSync(p);
    logoAttachment = [{ filename: 'firmledger-logo.png', content: buf, cid: 'firmledger-logo' }];
  } catch {
    logoAttachment = [];
  }
  return logoAttachment;
}

function setting(name) {
  try { return require('../db').getSetting(name, ''); } catch { return ''; }
}
function setSettingSafe(name, value) {
  try { require('../db').setSetting(name, value); } catch { /* ignore */ }
}

function parseSmtpUrl(url, via) {
  const m = String(url || '').match(/^smtps?:\/\/([^:]+):([^@]+)@([^:/]+)(?::(\d+))?/i);
  if (!m) return null;
  const secure = String(url).toLowerCase().startsWith('smtps://') || Number(m[4]) === 465;
  return {
    via, source: 'env', id: via,
    host: m[3], port: Number(m[4]) || (secure ? 465 : 587), secure,
    user: decodeURIComponent(m[1]), pass: decodeURIComponent(m[2]),
    daily_limit: 0, label: via,
  };
}

function envSlots() {
  const out = [];
  if (process.env.SMTP_URL) {
    const p = parseSmtpUrl(process.env.SMTP_URL, 'env SMTP_URL');
    if (p) out.push(p);
  } else if (process.env.MAIL_HOST) {
    const port = Number(process.env.MAIL_PORT) || 587;
    const sec = (process.env.MAIL_SECURE || '').toLowerCase();
    out.push({
      via: 'env MAIL_*', source: 'env', id: 'env MAIL_*',
      host: process.env.MAIL_HOST, port,
      secure: sec === '1' || sec === 'true' || port === 465,
      user: process.env.MAIL_USER || '', pass: process.env.MAIL_PASS || '',
      daily_limit: 0, label: 'MAIL_*',
    });
  }
  for (let n = 2; n <= 6; n++) {
    const u = process.env['SMTP' + n + '_URL'] || process.env['SMTP_URL_' + n];
    if (!u) continue;
    const p = parseSmtpUrl(u, 'env SMTP' + n + '_URL');
    if (p) out.push(p);
  }
  return out;
}

function dbAccounts() {
  try {
    return require('../db').db.prepare(
      'SELECT * FROM smtp_accounts WHERE active=1 ORDER BY sort ASC, id ASC'
    ).all();
  } catch { return []; }
}

function allAccountsRaw() {
  try {
    return require('../db').db.prepare('SELECT * FROM smtp_accounts ORDER BY sort ASC, id ASC').all();
  } catch { return []; }
}

function hopKey(h) { return `${h.source}:${h.id}`; }

function adminHop(a) {
  return {
    via: a.label || a.provider, source: 'admin', id: a.id,
    provider: a.provider, host: a.host, port: a.port, secure: Boolean(a.secure),
    user: a.username, pass: a.password,
    daily_limit: a.daily_limit || 0,
    sent_today: a.sent_today || 0, sent_on: a.sent_on || '',
    last_error: a.last_error || '', last_error_at: a.last_error_at || '',
    last_ok_at: a.last_ok_at || '', active: Boolean(a.active),
    created_at: a.created_at || '',
    label: a.label || a.provider,
  };
}

/** Ordered hop list used at send time. */
function hops() {
  const list = envSlots();
  if (!list.length) {
    const h = setting('smtp_host');
    if (h) {
      const p = Number(setting('smtp_port')) || 587;
      list.push({
        via: 'admin settings', source: 'settings', id: 'settings',
        host: h, port: p,
        secure: setting('smtp_secure') === '1' || p === 465,
        user: setting('smtp_user'), pass: setting('smtp_pass'),
        daily_limit: 0, label: 'Primary (settings)',
      });
    }
  }
  for (const a of dbAccounts()) list.push(adminHop(a));
  return list.filter((h) => h.host).map((h) => ({ ...h, key: hopKey(h) }));
}

/** Every configured hop, including paused Admin providers — used by the
 *  per-provider tester and the inactivity keep-alive (a paused provider can
 *  still be deactivated by its vendor for sitting idle). */
function allHops() {
  const list = envSlots();
  if (!list.length) {
    const h = setting('smtp_host');
    if (h) {
      const p = Number(setting('smtp_port')) || 587;
      list.push({
        via: 'admin settings', source: 'settings', id: 'settings',
        host: h, port: p,
        secure: setting('smtp_secure') === '1' || p === 465,
        user: setting('smtp_user'), pass: setting('smtp_pass'),
        daily_limit: 0, label: 'Primary (settings)',
      });
    }
  }
  for (const a of allAccountsRaw()) list.push(adminHop(a));
  return list.filter((h) => h.host).map((h) => ({ ...h, key: hopKey(h), active: h.active !== false }));
}

function hopByKey(key) {
  return allHops().find((h) => h.key === key) || null;
}

/**
 * Resolve the friendly provider name an administrator types in chat to the
 * exact hop key used by the mailer. The settings page exposes hop keys, but a
 * person should be able to say "Brevo", "smtp-relay.brevo.com", "provider 3"
 * or the displayed label without knowing that implementation detail.
 */
function resolveProviderKey(value) {
  const needle = String(value || '').trim().toLowerCase();
  if (!needle) return '';
  const hops = allHops();
  const exact = hops.find((h) => String(h.key).toLowerCase() === needle);
  if (exact) return exact.key;
  const numeric = needle.match(/^(?:provider|hop|account)\s*#?\s*(\d+)$/);
  if (numeric) {
    const byId = hops.find((h) => String(h.id) === numeric[1]);
    if (byId) return byId.key;
  }
  const hit = hops.find((h) => [h.provider, h.label, h.host, h.id, h.via]
    .some((part) => part && String(part).toLowerCase() === needle))
    || hops.find((h) => [h.provider, h.label, h.host, h.via]
      .some((part) => part && String(part).toLowerCase().includes(needle)));
  return hit ? hit.key : '';
}

/** Human-facing provider choices for command menus and the assistant. */
function providerChoices() {
  return allHops().map((h) => ({
    key: h.key,
    label: `${h.label || h.provider || 'SMTP provider'} — ${h.host}:${h.port}`,
    provider: h.provider || h.label || h.host,
  }));
}

/**
 * Failover chain for one message. When `viaKey` names an active hop, that
 * provider goes FIRST (the admin pinned it — e.g. the one relay that allows
 * bulk mail) and the rest of the chain stays armed behind it as failover.
 * Unknown/empty keys keep the ordinary chain.
 */
function hopsVia(viaKey) {
  const chain = hops();
  const i = chain.findIndex((h) => h.key === viaKey);
  if (!viaKey || i <= 0) return chain;
  return [chain[i], ...chain.slice(0, i), ...chain.slice(i + 1)];
}

function fromAddress() {
  if (process.env.MAIL_FROM) return process.env.MAIL_FROM;
  const f = setting('smtp_from');
  if (f) return f;
  const first = hops()[0];
  if (first && first.user && String(first.user).includes('@')) return `FirmLedger <${first.user}>`;
  return 'FirmLedger <noreply@firmledger.co.ke>';
}

const transportCache = new Map();
function transporterFor(hop) {
  const key = `${hop.host}:${hop.port}:${hop.user}`;
  if (transportCache.has(key)) return transportCache.get(key);
  try {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({
      host: hop.host, port: hop.port, secure: Boolean(hop.secure),
      auth: hop.user ? { user: hop.user, pass: hop.pass } : undefined,
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });
    transportCache.set(key, t);
    return t;
  } catch (e) {
    console.warn('[mail] transporter init failed:', hop.host, e.message);
    return null;
  }
}

function isLimitError(err) {
  const msg = String((err && (err.response || err.message)) || err || '').toLowerCase();
  const code = String((err && (err.responseCode || err.code)) || '');
  if (['421', '450', '451', '452'].includes(code)) return true;
  return /rate|quota|limit|throttl|too many|daily sending|sending limit|4\.7\.|5\.4\.5|try again later|temporarily deferred/.test(msg);
}

function todayStamp() { return new Date().toISOString().slice(0, 10); }

function hopOverLimit(hop) {
  if (!hop.daily_limit) return false;
  if (hop.source !== 'admin') return false;
  const today = todayStamp();
  if (hop.sent_on !== today) return false;
  return (hop.sent_today || 0) >= hop.daily_limit;
}

/* Per-hop "last successfully used" clock. Admin providers keep it in
   smtp_accounts.last_ok_at; env/settings hops keep it in a small JSON blob in
   settings so the inactivity keep-alive can watch every hop equally. */
function hopActivity() {
  try { return JSON.parse(setting('mail_hop_activity') || '{}') || {}; } catch { return {}; }
}
function touchHopActivity(hop) {
  try {
    const map = hopActivity();
    map[hop.key || hopKey(hop)] = new Date().toISOString();
    setSettingSafe('mail_hop_activity', JSON.stringify(map));
  } catch { /* ignore */ }
}
/** ISO timestamp of the last successful send through this hop ('' if never). */
function hopLastUsed(hop) {
  if (hop.source === 'admin' && hop.last_ok_at) {
    // sqlite datetime('now') → "YYYY-MM-DD HH:MM:SS" (UTC, no zone marker)
    return hop.last_ok_at.includes('T') ? hop.last_ok_at : hop.last_ok_at.replace(' ', 'T') + 'Z';
  }
  const map = hopActivity();
  return map[hop.key || hopKey(hop)] || '';
}

function markSent(hop) {
  touchHopActivity(hop);
  if (hop.source !== 'admin' || !hop.id) return;
  try {
    const { db } = require('../db');
    const today = todayStamp();
    const row = db.prepare('SELECT sent_today, sent_on FROM smtp_accounts WHERE id=?').get(hop.id);
    const n = row && row.sent_on === today ? (row.sent_today || 0) + 1 : 1;
    db.prepare("UPDATE smtp_accounts SET sent_today=?, sent_on=?, last_ok_at=datetime('now'), last_error='' WHERE id=?")
      .run(n, today, hop.id);
  } catch { /* ignore */ }
}

function markError(hop, err) {
  if (hop.source !== 'admin' || !hop.id) return;
  try {
    require('../db').db.prepare("UPDATE smtp_accounts SET last_error=?, last_error_at=datetime('now') WHERE id=?")
      .run(String(err || '').slice(0, 400), hop.id);
  } catch { /* ignore */ }
}

const BRAND = {
  navy: '#0A1628', navy2: '#12203A', accent: '#1D4ED8', accentSoft: '#EFF4FF',
  ink: '#1B2438', muted: '#5B6478', line: '#E3E8F2', bg: '#F6F8FC',
  ok: '#0E9F6E', gold: '#D9A848', url: 'https://firmledger.co.ke',
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function logoHtml() {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="vertical-align:middle;">
      <img src="cid:firmledger-logo" width="36" height="36" alt="FirmLedger" style="display:block;width:36px;height:36px;border:0;outline:none;">
    </td>
    <td style="padding-left:12px;font-family:Georgia,serif;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:.01em;vertical-align:middle;">
      Firm<span style="color:${BRAND.gold};">Ledger</span>
    </td>
  </tr></table>`;
}

function brandedHtml(opts = {}) {
  const pre = opts.preheader || '';
  const paras = (opts.paragraphs || []).map((p) =>
    `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:${BRAND.ink};">${p}</p>`).join('');
  const cta = opts.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px;"><tr>
        <td style="background:${BRAND.accent};border-radius:10px;">
          <a href="${esc(opts.cta.url)}" style="display:inline-block;padding:13px 26px;font-family:Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">${esc(opts.cta.label)}</a>
        </td>
      </tr></table>`
    : '';
  const note = opts.note
    ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:${BRAND.muted};">${opts.note}</p>`
    : '';
  const alert = opts.alert
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;"><tr>
        <td style="background:${opts.alertTone === 'warn' ? '#FFF7E8' : opts.alertTone === 'ok' ? '#EDF9F3' : '#EFF4FF'};
                   border-left:3px solid ${opts.alertTone === 'warn' ? '#D97706' : opts.alertTone === 'ok' ? '#0E9F6E' : BRAND.accent};
                   border-radius:8px;padding:12px 14px;font-size:14px;line-height:1.55;color:${BRAND.ink};">${opts.alert}</td>
      </tr></table>`
    : '';
  const otp = opts.otp
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 20px;"><tr>
        <td align="center" style="background:${BRAND.accentSoft};border:1px dashed #B8CBEF;border-radius:12px;padding:18px;">
          <span style="font-family:Arial,sans-serif;font-size:30px;font-weight:800;letter-spacing:10px;color:${BRAND.navy};">${esc(opts.otp)}</span>
        </td>
      </tr></table>`
    : '';
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(pre)}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BRAND.bg};">
    <tr><td style="padding:24px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" align="center" style="max-width:600px;width:100%;">
        <tr><td style="background:${BRAND.navy};border-radius:16px 16px 0 0;padding:20px 28px;">${logoHtml()}</td></tr>
        ${opts.kicker ? `<tr><td style="background:${BRAND.navy2};padding:0 28px 16px;">
            <span style="display:inline-block;padding:5px 12px;border:1px solid rgba(255,255,255,.25);border-radius:999px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:.12em;color:#ffffff;text-transform:uppercase;">${esc(opts.kicker)}</span>
          </td></tr>` : ''}
        <tr><td style="background:#ffffff;padding:32px 28px 28px;border-left:1px solid ${BRAND.line};border-right:1px solid ${BRAND.line};">
          ${opts.title ? `<h1 style="margin:0 0 18px;font-family:Georgia,serif;font-size:24px;font-weight:700;line-height:1.3;color:${BRAND.navy};">${opts.title}</h1>` : ''}
          ${alert}
          ${paras}
          ${otp}
          ${cta}
          ${note}
        </td></tr>
        <tr><td style="background:${BRAND.bg};border:1px solid ${BRAND.line};border-top:none;border-radius:0 0 16px 16px;padding:20px 28px;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:${BRAND.muted};">
            Sent by <a href="${BRAND.url}" style="color:${BRAND.accent};text-decoration:none;font-weight:600;">FirmLedger</a> ·
            <a href="${BRAND.url}/directory" style="color:${BRAND.muted};text-decoration:none;">Directory</a> ·
            <a href="${BRAND.url}/pricing" style="color:${BRAND.muted};text-decoration:none;">Pricing</a> ·
            <a href="mailto:support@firmledger.co.ke" style="color:${BRAND.muted};text-decoration:none;">support@firmledger.co.ke</a>
          </p>
          <p style="margin:8px 0 0;font-size:11px;color:#9AA3B4;">${esc(ts)} · This is an automated message about your FirmLedger account. If you didn't expect it, contact support.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function unescEntities(s) {
  return String(s).replace(/&(amp|lt|gt|quot|#39);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[k]));
}

function brandedText(opts = {}) {
  const lines = [];
  if (opts.title) { lines.push(unescEntities(opts.title.replace(/<[^>]+>/g, '')), ''); }
  (opts.paragraphs || []).forEach((p) => lines.push(unescEntities(p.replace(/<[^>]+>/g, '')), ''));
  if (opts.otp) lines.push(`Your code: ${opts.otp}`, '');
  if (opts.cta) lines.push(`${opts.cta.label}: ${opts.cta.url}`, '');
  if (opts.note) lines.push(opts.note.replace(/<[^>]+>/g, ''));
  lines.push('— The FirmLedger team', 'https://firmledger.co.ke');
  return lines.join('\n');
}

function logOutbox(to, msg, via, extra = '') {
  fs.mkdirSync(path.dirname(outboxPath), { recursive: true });
  const body = msg.html ? msg.text : msg.text;
  const line = `[${new Date().toISOString()}] ${via}${extra ? ' ' + extra : ''} TO=${to}\nSUBJECT=${msg.subject}\n${body}\n${'-'.repeat(60)}\n`;
  fs.appendFileSync(outboxPath, line);
}

async function sendVia(hop, to, msg) {
  const t = transporterFor(hop);
  if (!t) throw new Error('Could not build transport for ' + hop.host);
  // msg.from (if provided) overrides the global From for this one message.
  const payload = { ...msg, from: msg.from || fromAddress(), to };
  if (msg.html && msg.html.includes('cid:firmledger-logo')) payload.attachments = getLogoAttachment();
  await t.sendMail(payload);
}

async function deliver(to, msg, viaKey) {
  const chain = hopsVia(viaKey);
  if (!chain.length) {
    logOutbox(to, msg, 'OUTBOX');
    console.log('[mail:outbox]', msg.subject, '→', to);
    return { delivered: false, logged: true };
  }
  const errors = [];
  for (const hop of chain) {
    if (hopOverLimit(hop)) {
      errors.push(`${hop.label}: daily limit reached`);
      continue;
    }
    try {
      await sendVia(hop, to, msg);
      markSent(hop);
      logOutbox(to, msg, 'SENT', `via=${hop.host}`);
      console.log('[mail:sent]', msg.subject, '→', to, 'via', hop.host);
      return { delivered: true, via: hop.host };
    } catch (e) {
      const m = e.message || String(e);
      markError(hop, m);
      errors.push(`${hop.label}: ${m}`);
      if (isLimitError(e)) {
        console.warn('[mail:failover]', hop.host, 'hit a limit — trying next hop');
        continue;
      }
      // Connection/auth failures also fail over so a dead primary does not
      // strand account/money mail. Non-limit errors still try the next hop.
      console.warn('[mail:failover]', hop.host, m);
    }
  }
  const joined = errors.join(' | ');
  console.error('[mail:SEND-FAILED]', to, msg.subject, '—', joined);
  logOutbox(to, msg, 'FAILED', `error=${joined}`);
  return { delivered: false, error: joined || 'All SMTP hops failed' };
}

/* `viaKey` (optional, on sendMail/sendBranded) pins ONE provider to the front
   of the failover chain for that message — used by the admin bulk-mailer to
   keep mass sends on the relay whose terms allow them. Failover still runs:
   if the pinned hop hits a limit, the rest of the chain catches the mail. */
async function sendMail(to, subject, text, html, viaKey) {
  return deliver(to, { subject, text, html }, viaKey);
}

async function sendBranded(to, subject, opts = {}, viaKey) {
  // From resolution: explicit `from` wins, then a named alias (billing,
  // security, noreply, …), then the global From address.
  const from = opts.from || (opts.alias ? aliasFrom(opts.alias) : undefined);
  return deliver(to, { subject, text: opts.text || brandedText(opts), html: brandedHtml(opts), from }, viaKey);
}

async function sendTest(to) {
  const chain = hops();
  if (!chain.length) return { ok: false, error: 'No SMTP configuration found — add a provider in Admin → Settings or set SMTP_URL / SMTP2_URL in .env.' };
  const hosts = chain.map((h) => `${h.host}:${h.port}`).join(' → ');
  const r = await sendBranded(to, 'FirmLedger test email', {
    alias: 'admin',
    kicker: 'Configuration check',
    title: 'SMTP is working',
    preheader: 'This test email confirms your FirmLedger SMTP settings are live.',
    alert: 'Your FirmLedger SMTP configuration is verified and this email was delivered through it.',
    alertTone: 'ok',
    paragraphs: [
      `From address (same on every hop): <b>${esc(fromAddress())}</b>.`,
      `Failover chain: <b>${esc(hosts)}</b>. If the first hop hits a sending limit, the next one is used automatically.`,
    ],
    cta: { label: 'Open admin console', url: require('./util').siteUrl('/admin3119Musa/settings') },
    note: 'This is a one-off test triggered from your admin settings.',
  });
  if (r.delivered) return { ok: true, via: r.via };
  return { ok: false, error: r.error || 'Unknown send failure' };
}

/**
 * Test ONE specific provider (no failover) — the admin picks a hop in
 * Settings and this pushes a branded test email through that hop only, so a
 * broken failover provider can't hide behind a healthy primary.
 */
async function sendTestVia(key, to) {
  const hop = hopByKey(key);
  if (!hop) return { ok: false, error: 'That mail provider no longer exists — refresh the page.' };
  const msgOpts = {
    kicker: 'Provider check',
    title: `Provider test — ${hop.label}`,
    preheader: `Direct test through ${hop.host}:${hop.port} (no failover).`,
    alert: `This email was sent through <b>${esc(hop.label)}</b> (<code>${esc(hop.host)}:${hop.port}</code>) <b>only</b> — the failover chain was bypassed on purpose.`,
    alertTone: 'ok',
    paragraphs: [
      `If you are reading this, the provider <b>${esc(hop.label)}</b> is authenticated, connected and delivering.`,
      `From address: <b>${esc(aliasFrom('admin'))}</b>. Source: <b>${esc(hop.source)}</b>.`,
    ],
    cta: { label: 'Open admin settings', url: require('./util').siteUrl('/admin3119Musa/settings') },
    note: 'One-off provider test triggered from Admin → Settings. Check spam if it took a detour.',
  };
  const msg = {
    subject: `FirmLedger provider test — ${hop.label}`,
    text: brandedText(msgOpts), html: brandedHtml(msgOpts),
    from: aliasFrom('admin'),
  };
  try {
    await sendVia(hop, to, msg);
    markSent(hop);
    logOutbox(to, msg, 'SENT', `via=${hop.host} (direct test)`);
    return { ok: true, via: `${hop.host}:${hop.port}`, label: hop.label };
  } catch (e) {
    const m = e.message || String(e);
    markError(hop, m);
    logOutbox(to, msg, 'FAILED', `via=${hop.host} (direct test) error=${m}`);
    return { ok: false, error: `${hop.label} (${hop.host}:${hop.port}): ${m}`, label: hop.label };
  }
}

/* ================= Inactivity keep-alive =================
 * Several SMTP relays (Brevo, Mailtrap, SMTP2GO free tiers…) disable
 * or delete accounts that go unused for a while. To stop that happening to a
 * configured-but-idle hop, every hop that has not delivered anything for
 * `mail_keepalive_days` (default 14 — roughly twice inside a typical 30-day
 * deactivation window) automatically sends itself a branded keep-alive email
 * to admin@firmledger.co.ke. Applies to EVERY configured provider: env slots,
 * legacy settings SMTP, saved presets and custom entries — paused ones too,
 * because a vendor can still expire a paused account.
 */
const KEEPALIVE_TO = 'admin@firmledger.co.ke';
const KEEPALIVE_DEFAULT_DAYS = 14;

function keepAliveSettings() {
  const raw = parseInt(setting('mail_keepalive_days'), 10);
  return {
    on: setting('mail_keepalive_on') !== '0',
    days: Number.isFinite(raw) && raw >= 1 ? raw : KEEPALIVE_DEFAULT_DAYS,
    to: (setting('mail_keepalive_to') || KEEPALIVE_TO).trim() || KEEPALIVE_TO,
    last_run: setting('mail_keepalive_last_run') || '',
    last_report: (() => { try { return JSON.parse(setting('mail_keepalive_last_report') || '[]'); } catch { return []; } })(),
  };
}

function keepAliveAttempts() {
  try { return JSON.parse(setting('mail_keepalive_attempts') || '{}') || {}; } catch { return {}; }
}
function markKeepAliveAttempt(key) {
  try {
    const map = keepAliveAttempts();
    map[key] = new Date().toISOString();
    setSettingSafe('mail_keepalive_attempts', JSON.stringify(map));
  } catch { /* ignore */ }
}

function keepAliveMessage(hop, days, lastUsed) {
  const opts = {
    kicker: 'Mail keep-alive',
    title: `Keep-alive ping — ${hop.label}`,
    preheader: `Automatic activity ping through ${hop.host} so the account is not closed for inactivity.`,
    alert: `Provider <b>${esc(hop.label)}</b> (<code>${esc(hop.host)}:${hop.port}</code>) had not sent anything for ${lastUsed ? `<b>${days}+ days</b> (last send ${esc(String(lastUsed).slice(0, 10))})` : '<b>as long as FirmLedger has tracked it</b>'} — this automated email keeps the account active with its vendor.`,
    alertTone: 'info',
    paragraphs: [
      'Some SMTP vendors deactivate or delete accounts that stay idle. FirmLedger pings every configured provider (env, legacy, preset and custom) that has gone quiet, so the failover chain stays healthy without anyone clicking anything.',
      `Nothing to do — if this provider were broken, the send would have failed and the error would show in Admin → Settings instead of this email arriving.`,
    ],
    cta: { label: 'Review mail providers', url: require('./util').siteUrl('/admin3119Musa/settings') },
    note: `Automatic keep-alive, sent at most once per idle window (${days} days) per provider.`,
  };
  return {
    subject: `Mail keep-alive — ${hop.label} is idle, pinging to stay active`,
    text: brandedText(opts), html: brandedHtml(opts),
    from: aliasFrom('admin'),
  };
}

/**
 * Walk every configured hop and push a keep-alive email through any that has
 * been idle longer than the configured window. Safe to call often — it
 * throttles per hop (one attempt per ~20h) and only sends when actually idle.
 */
async function keepAliveSweep(force = false) {
  const cfg = keepAliveSettings();
  if (!cfg.on && !force) return { checked: 0, sent: 0, skipped: 'off' };
  const now = Date.now();
  const windowMs = cfg.days * 864e5;
  const attempts = keepAliveAttempts();
  const report = [];
  let sent = 0;
  for (const hop of allHops()) {
    const entry = { key: hop.key, label: hop.label, host: hop.host, source: hop.source, active: hop.active !== false };
    const last = hopLastUsed(hop);
    const idleMs = last ? now - Date.parse(last) : Infinity;
    // Never-used brand-new admin rows get a grace period from created_at so a
    // provider added this morning is not instantly pinged.
    const created = hop.created_at ? Date.parse(hop.created_at.replace(' ', 'T') + (hop.created_at.includes('Z') ? '' : 'Z')) : 0;
    const ageMs = created ? now - created : Infinity;
    const idle = Math.min(idleMs, ageMs);
    if (!force && idle < windowMs) {
      entry.status = 'recently active';
      entry.last_used = last;
      report.push(entry);
      continue;
    }
    // Throttle: one attempt per hop per ~20 hours even if it keeps failing.
    const lastTry = attempts[hop.key] ? Date.parse(attempts[hop.key]) : 0;
    if (!force && lastTry && now - lastTry < 20 * 3600e3) {
      entry.status = 'attempted recently';
      report.push(entry);
      continue;
    }
    markKeepAliveAttempt(hop.key);
    try {
      const msg = keepAliveMessage(hop, cfg.days, last);
      await sendVia(hop, cfg.to, msg);
      markSent(hop);
      logOutbox(cfg.to, msg, 'SENT', `via=${hop.host} (keep-alive)`);
      console.log('[mail:keep-alive]', hop.label, 'pinged →', cfg.to);
      entry.status = 'keep-alive sent';
      sent++;
    } catch (e) {
      const m = e.message || String(e);
      markError(hop, m);
      console.warn('[mail:keep-alive]', hop.label, 'FAILED —', m);
      entry.status = 'failed';
      entry.error = m.slice(0, 200);
    }
    report.push(entry);
  }
  setSettingSafe('mail_keepalive_last_run', new Date().toISOString());
  setSettingSafe('mail_keepalive_last_report', JSON.stringify(report.slice(0, 40)));
  return { checked: report.length, sent, report };
}

function saveKeepAliveSettings(body = {}) {
  setSettingSafe('mail_keepalive_on', body.mail_keepalive_on === '1' ? '1' : '0');
  const d = parseInt(body.mail_keepalive_days, 10);
  if (Number.isFinite(d) && d >= 1 && d <= 90) setSettingSafe('mail_keepalive_days', String(d));
  const to = String(body.mail_keepalive_to || '').trim().toLowerCase().slice(0, 200);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) setSettingSafe('mail_keepalive_to', to);
}

function mailConfigured() { return hops().length > 0; }

function accountStatus() {
  return {
    configured: mailConfigured(),
    from: fromAddress(),
    hops: hops().map((h) => ({
      id: h.id, source: h.source, label: h.label, host: h.host, port: h.port,
      provider: h.provider || '', daily_limit: h.daily_limit || 0,
      sent_today: h.sent_on === todayStamp() ? (h.sent_today || 0) : 0,
      last_error: h.last_error || '',
    })),
  };
}

function addAccount(body) {
  const { db } = require('../db');
  const provider = PROVIDERS.some((p) => p.id === body.provider) ? body.provider : 'custom';
  const preset = PROVIDERS.find((p) => p.id === provider) || PROVIDERS[PROVIDERS.length - 1];
  const host = String(body.host || preset.host || '').trim().slice(0, 200);
  const port = Math.max(1, Math.min(65535, parseInt(body.port, 10) || preset.port || 587));
  const secure = body.secure === '1' || body.secure === 1 || port === 465 ? 1 : 0;
  const username = String(body.username || '').trim().slice(0, 200);
  const password = String(body.password || '').trim().slice(0, 500);
  const label = String(body.label || preset.name || provider).trim().slice(0, 80);
  const daily = Math.max(0, parseInt(body.daily_limit, 10) || 0);
  const sort = Math.max(0, parseInt(body.sort, 10) || 0);
  if (!host) return { ok: false, error: 'SMTP host is required.' };
  if (!username) return { ok: false, error: 'Username is required.' };
  if (!password) return { ok: false, error: 'Password is required.' };
  db.prepare(
    `INSERT INTO smtp_accounts (provider, label, host, port, secure, username, password, daily_limit, active, sort)
     VALUES (?,?,?,?,?,?,?,?,1,?)`
  ).run(provider, label, host, port, secure, username, password, daily, sort);
  transportCache.clear();
  return { ok: true };
}

function updateAccount(id, body) {
  const { db } = require('../db');
  const row = db.prepare('SELECT * FROM smtp_accounts WHERE id=?').get(id);
  if (!row) return { ok: false, error: 'Account not found.' };
  const host = String(body.host || row.host).trim().slice(0, 200);
  const port = Math.max(1, Math.min(65535, parseInt(body.port, 10) || row.port));
  const secure = body.secure === undefined ? row.secure : (body.secure === '1' || body.secure === 1 ? 1 : 0);
  const username = String(body.username || row.username).trim().slice(0, 200);
  const password = String(body.password || '').trim() || row.password;
  const label = String(body.label || row.label).trim().slice(0, 80);
  const daily = body.daily_limit === undefined ? row.daily_limit : Math.max(0, parseInt(body.daily_limit, 10) || 0);
  db.prepare(
    'UPDATE smtp_accounts SET label=?, host=?, port=?, secure=?, username=?, password=?, daily_limit=? WHERE id=?'
  ).run(label, host, port, secure, username, password, daily, id);
  transportCache.clear();
  return { ok: true };
}

function toggleAccount(id) {
  const { db } = require('../db');
  const row = db.prepare('SELECT active FROM smtp_accounts WHERE id=?').get(id);
  if (!row) return;
  db.prepare('UPDATE smtp_accounts SET active=? WHERE id=?').run(row.active ? 0 : 1, id);
  transportCache.clear();
}
function deleteAccount(id) {
  require('../db').db.prepare('DELETE FROM smtp_accounts WHERE id=?').run(id);
  transportCache.clear();
}

function saveGlobalFrom(from) {
  setSettingSafe('smtp_from', String(from || '').trim().slice(0, 200));
}

/* ================= Bulk-mail provider preference =================
 * Some relays do not allow bulk mail (newsletters, announcements), so the
 * admin can pin the one provider a mass send must go out on first. The
 * preference is remembered per console, not per click. Empty = automatic
 * failover chain. */
function saveBulkVia(key) {
  setSettingSafe('mail_bulk_via', String(key || '').trim().slice(0, 120));
}
/** Currently pinned provider — '' when nothing is pinned or the hop is gone. */
function bulkVia() {
  const key = setting('mail_bulk_via');
  if (!key) return '';
  return hops().some((h) => h.key === key) ? key : '';
}
/** Active hops grouped by source for the "send through" picker (Admin → Email). */
function bulkViaHops() {
  const groups = [
    { source: 'env', label: 'Environment (.env)' },
    { source: 'settings', label: 'Legacy settings primary' },
    { source: 'admin', label: 'Saved providers' },
  ];
  const all = hops();
  return groups
    .map((g) => ({ ...g, hops: all.filter((h) => h.source === g.source) }))
    .filter((g) => g.hops.length);
}

/** Saved providers grouped by preset (Zoho Mail, Brevo, …) for Admin → Settings. */
function accountGroups() {
  const map = new Map();
  for (const a of allAccountsRaw()) {
    const id = a.provider || 'custom';
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(a);
  }
  const nameOf = (id) => (PROVIDERS.find((p) => p.id === id) || { name: 'Custom SMTP' }).name;
  return [...map.entries()]
    .map(([id, accounts]) => ({ provider: id, name: nameOf(id), accounts }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

module.exports = {
  sendMail, sendBranded, sendTest, sendTestVia, brandedHtml, mailConfigured,
  PROVIDERS, ALIASES, aliasFrom, hops, hopsVia, allHops, hopByKey, resolveProviderKey,
  providerChoices, hopLastUsed, fromAddress, accountStatus, allAccountsRaw,
  addAccount, updateAccount, toggleAccount, deleteAccount, saveGlobalFrom,
  saveBulkVia, bulkVia, bulkViaHops, accountGroups,
  keepAliveSweep, keepAliveSettings, saveKeepAliveSettings,
};
