/** Minimal RFC 6238 TOTP (HMAC-SHA1) implementation for the admin console's two-factor step. */
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = Buffer.alloc(Math.floor(clean.length * 5 / 8));
  let idx = 0;
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out[idx++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return out.slice(0, idx);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20)); // 160-bit, standard
}

function hotp(secret, counter, digits = 6) {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % (10 ** digits)).padStart(digits, '0');
}

function totp(secret, timestamp = Date.now()) {
  return hotp(secret, Math.floor(timestamp / 30000));
}

/** Accept current step ±1 (clock drift). Constant-time compare. */
function verifyTotp(secret, code, timestamp = Date.now()) {
  if (!secret || typeof secret !== 'string') return false; // no secret enrolled → nothing is valid
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  for (const step of [-1, 0, 1]) {
    const expected = hotp(secret, Math.floor(timestamp / 30000) + step);
    try {
      if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return true;
    } catch { /* length guard above makes equality safe */ }
  }
  return false;
}

/** otpauth:// URI for authenticator enrollment (Google Authenticator, 1Password, Authy…). */
function otpAuthUrl(secret, label = 'FirmLedger:admin') {
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=FirmLedger&period=30&digits=6&algorithm=SHA1`;
}

module.exports = { generateSecret, totp, verifyTotp, otpAuthUrl };
