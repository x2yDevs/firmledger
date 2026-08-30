/**
 * Outbound mail — REAL SENDING when SMTP is configured.
 *
 * Configuration is resolved in this order (first match wins):
 *   1. SMTP_URL           smtp(s)://user:pass@host[:port]
 *   2. MAIL_HOST/MAIL_PORT/MAIL_USER/MAIL_PASS/MAIL_FROM env vars
 *   3. Admin → Settings (stored in the settings table: smtp_host, smtp_port,
 *      smtp_user, smtp_pass, smtp_from, smtp_secure)
 *
 * Nothing configured → messages are written to data/outbox.log so nothing is
 * lost (password resets still work for admins reading the log). A configured
 * transport is verified once and reported on boot; send failures are caught,
 * logged to the console with detail AND recorded in the outbox log so no
 * notice is ever silently dropped.
 *
 *   sendMail(to, subject, text)        plain text
 *   sendBranded(to, subject, {...})    FirmLedger-branded HTML + text fallback
 *   sendTest(to, fromLabel)            admin test — verifies the live transport
 */
const fs = require('fs');
const path = require('path');

const outboxPath = path.join(__dirname, '..', '..', 'data', 'outbox.log');

/** Real FirmLedger logo for the email header — embedded as a CID attachment
 *  so it renders even with remote image loading off. */
let logoAttachment = null; // computed lazily
function getLogoAttachment() {
  if (logoAttachment) return logoAttachment;
  try {
    const p = path.join(__dirname, '..', '..', 'public', 'assets', 'logo-white.png');
    const buf = fs.readFileSync(p);
    logoAttachment = [{ filename: 'firmledger-logo.png', content: buf, cid: 'firmledger-logo' }];
  } catch {
    logoAttachment = []; // logo file missing — text-only header fallback
  }
  return logoAttachment;
}

/** Read a setting — lazy require to avoid a circular load with db.js. */
function setting(name) {
  try {
    const { getSetting } = require('../db');
    return getSetting(name, '');
  } catch { return ''; }
}

/** Build the effective SMTP configuration. Empty object = not configured. */
function smtpConfig() {
  const url = process.env.SMTP_URL;
  if (url) {
    const m = url.match(/^smtps?:\/\/([^:]+):([^@]+)@([^:/]+)(?::(\d+))?/i);
    if (!m) return { error: 'SMTP_URL is malformed — expected smtps://user:pass@host:port' };
    return {
      via: 'env SMTP_URL',
      host: m[3], port: Number(m[4]) || (url.startsWith('smtps://') ? 465 : 587),
      secure: url.startsWith('smtps://') || Number(m[4]) === 465,
      user: decodeURIComponent(m[1]), pass: decodeURIComponent(m[2]),
    };
  }
  const eh = process.env.MAIL_HOST;
  if (eh) {
    return {
      via: 'env MAIL_*',
      host: eh,
      port: Number(process.env.MAIL_PORT) || 587,
      secure: (process.env.MAIL_SECURE || '').toLowerCase() === '1' || (process.env.MAIL_SECURE || '').toLowerCase() === 'true' || Number(process.env.MAIL_PORT) === 465,
      user: process.env.MAIL_USER || '', pass: process.env.MAIL_PASS || '',
    };
  }
  const h = setting('smtp_host');
  if (h) {
    const p = Number(setting('smtp_port')) || 587;
    return {
      via: 'admin settings',
      host: h, port: p,
      secure: setting('smtp_secure') === '1' || p === 465,
      user: setting('smtp_user'), pass: setting('smtp_pass'),
    };
  }
  return {};
}

let transporter;      // undefined = not attempted, false = error, object = ready
let transporterKey;   // fingerprint of the config used to build it
function getTransporter() {
  const key = JSON.stringify(smtpConfig());
  if (key !== transporterKey) { transporter = undefined; transporterKey = key; }
  if (transporter !== undefined) return transporter || null;
  try {
    const cfg = smtpConfig();
    if (!cfg.host) { transporter = false; return null; }
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: cfg.host, port: cfg.port, secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });
  } catch (e) {
    console.warn('[mail] transporter init failed:', e.message);
    transporter = false;
    return null;
  }
  return transporter;
}

function fromAddress() {
  // Explicit wins: env, then Admin settings.
  if (process.env.MAIL_FROM) return process.env.MAIL_FROM;
  const f = setting('smtp_from');
  if (f) return f;
  // Providers like Zoho / Gmail reject relay (553 "Sender is not allowed to
  // relay emails") unless the From address matches the authenticated account —
  // default the From to the SMTP login itself so Zoho accepts it.
  try {
    const user = (smtpConfig().user || '').trim();
    if (user.includes('@')) return `FirmLedger <${user}>`;
  } catch {}
  return 'FirmLedger <no-reply@firmledger.co.ke>';
}

const BRAND = {
  navy: '#0A1628',
  navy2: '#12203A',
  accent: '#1D4ED8',
  accentSoft: '#EFF4FF',
  ink: '#1B2438',
  muted: '#5B6478',
  line: '#E3E8F2',
  bg: '#F6F8FC',
  ok: '#0E9F6E',
  gold: '#D9A848',
  url: 'https://firmledger.co.ke',
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** FirmLedger logo lockup for the email header — real brand mark + wordmark. */
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

/**
 * Build a branded HTML email.
 * opts: preheader, title, paragraphs[], cta:{label,url}, note, alert, alertTone ('ok'|'warn'|'info')
 */
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
        <!-- header -->
        <tr><td style="background:${BRAND.navy};border-radius:16px 16px 0 0;padding:20px 28px;">${logoHtml()}</td></tr>
        ${opts.kicker ? `<tr><td style="background:${BRAND.navy2};padding:0 28px 16px;">
            <span style="display:inline-block;padding:5px 12px;border:1px solid rgba(255,255,255,.25);border-radius:999px;font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:.12em;color:#ffffff;text-transform:uppercase;">${esc(opts.kicker)}</span>
          </td></tr>` : ''}
        <!-- body card -->
        <tr><td style="background:#ffffff;padding:32px 28px 28px;border-left:1px solid ${BRAND.line};border-right:1px solid ${BRAND.line};">
          ${opts.title ? `<h1 style="margin:0 0 18px;font-family:Georgia,serif;font-size:24px;font-weight:700;line-height:1.3;color:${BRAND.navy};">${opts.title}</h1>` : ''}
          ${alert}
          ${paras}
          ${otp}
          ${cta}
          ${note}
        </td></tr>
        <!-- footer -->
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

/** Derive a plain-text fallback from the branded payload. */
function brandedText(opts = {}) {
  const lines = [];
  if (opts.title) { lines.push(opts.title.replace(/<[^>]+>/g, ''), ''); }
  (opts.paragraphs || []).forEach((p) => lines.push(p.replace(/<[^>]+>/g, ''), ''));
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

async function deliver(to, msg) {
  const t = getTransporter();
  if (!t) {
    logOutbox(to, msg, 'OUTBOX');
    console.log('[mail:outbox]', msg.subject, '→', to);
    return { delivered: false, logged: true };
  }
  try {
    const payload = { from: fromAddress(), to, ...msg };
    if (msg.html && msg.html.includes('cid:firmledger-logo')) payload.attachments = getLogoAttachment();
    await t.sendMail(payload);
    logOutbox(to, msg, 'SENT');
    console.log('[mail:sent]', msg.subject, '→', to);
    return { delivered: true };
  } catch (e) {
    console.error('[mail:SEND-FAILED]', to, msg.subject, '—', e.message);
    logOutbox(to, msg, 'FAILED', `error=${e.message}`);
    return { delivered: false, error: e.message };
  }
}

async function sendMail(to, subject, text, html) {
  return deliver(to, { subject, text, html });
}

async function sendBranded(to, subject, opts = {}) {
  return deliver(to, { subject, text: opts.text || brandedText(opts), html: brandedHtml(opts) });
}

/** Verify the live transport by sending a real test email. */
async function sendTest(to) {
  const cfg = smtpConfig();
  if (!cfg.host) return { ok: false, error: 'No SMTP configuration found — none of SMTP_URL, MAIL_* env or Admin settings are set.' };
  if (!cfg.user && !process.env.SMTP_URL) return { ok: false, error: 'SMTP host set but no username provided.' };
  const t = getTransporter();
  if (!t) return { ok: false, error: 'Could not build a mail transport — check the host/port/secure settings.' };
  try {
    await t.verify();
  } catch (e) {
    return { ok: false, error: `SMTP connection failed: ${e.message}` };
  }
  const r = await sendBranded(to, 'FirmLedger test email', {
    kicker: 'Configuration check',
    title: 'SMTP is working',
    preheader: 'This test email confirms your FirmLedger SMTP settings are live.',
    alert: 'Your FirmLedger SMTP configuration is verified and this email was delivered through it.',
    alertTone: 'ok',
    paragraphs: [
      `Transport: <b>${esc(cfg.host)}:${cfg.port}</b> (${cfg.secure ? 'TLS' : 'STARTTLS/plain'}) via <b>${cfg.via}</b>.`,
      'All lifecycle emails — welcome, receipts, security notices and moderation updates — will now reach real inboxes with this branding.',
    ],
    cta: { label: 'Open admin console', url: require('./util').siteUrl('/admin3119Musa/settings') },
    note: 'This is a one-off test triggered from your admin settings.',
  });
  if (r.delivered) return { ok: true };
  return { ok: false, error: r.error || 'Unknown send failure' };
}

module.exports = { sendMail, sendBranded, sendTest, brandedHtml, mailConfigured: () => Boolean(smtpConfig().host) };
