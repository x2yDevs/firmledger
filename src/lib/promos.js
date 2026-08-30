/**
 * Pro promo / discount codes — percent off at checkout, optional plan lock,
 * usage cap, expiry. One redemption per user per code.
 */
const { db } = require('../db');

function normalize(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32);
}

function getByCode(code) {
  const c = normalize(code);
  if (!c) return null;
  return db.prepare('SELECT * FROM promo_codes WHERE code=?').get(c) || null;
}

function all() {
  return db.prepare('SELECT * FROM promo_codes ORDER BY active DESC, id DESC').all();
}

function preview(code, plan) {
  const p = getByCode(code);
  if (!p) return { ok: false, error: 'That code is not recognised.' };
  if (!p.active) return { ok: false, error: 'That code is no longer active.' };
  if (p.expires_at) {
    const exp = Date.parse(p.expires_at.length === 10 ? p.expires_at + 'T23:59:59Z' : p.expires_at);
    if (Number.isFinite(exp) && exp < Date.now()) return { ok: false, error: 'That code has expired.' };
  }
  if (p.max_uses > 0 && p.used_count >= p.max_uses) return { ok: false, error: 'That code has reached its usage limit.' };
  if (p.plan_id && plan && Number(plan.id) !== Number(p.plan_id)) {
    return { ok: false, error: 'That code does not apply to this offer.' };
  }
  const pct = Math.max(0, Math.min(100, Number(p.percent) || 0));
  const original = plan ? Number(plan.price_cents) : 0;
  const discount = plan ? Math.round(original * pct / 100) : 0;
  const amount = plan ? Math.max(1, original - discount) : 0;
  return { ok: true, promo: p, percent: pct, original, discount, amount };
}

function usableBy(userId, code, plan) {
  const r = preview(code, plan);
  if (!r.ok) return r;
  const used = db.prepare('SELECT 1 FROM promo_redemptions WHERE promo_id=? AND user_id=?').get(r.promo.id, userId);
  if (used) return { ok: false, error: 'You have already used that code.' };
  return r;
}

function redeem(userId, promoId, paymentId) {
  try {
    db.prepare('INSERT INTO promo_redemptions (promo_id, user_id, payment_id) VALUES (?,?,?)')
      .run(promoId, userId, paymentId || null);
  } catch { /* unique — already redeemed */ }
  db.prepare('UPDATE promo_codes SET used_count = used_count + 1 WHERE id=?').run(promoId);
}

function create({ code, percent, planId, maxUses, expiresAt, note }) {
  const c = normalize(code);
  if (!c || c.length < 3) return { ok: false, error: 'Code needs at least 3 letters or numbers (e.g. LAUNCH20).' };
  const pct = Math.round(Number(percent) || 0);
  if (pct < 1 || pct > 90) return { ok: false, error: 'Percent off must be between 1 and 90.' };
  const max = Math.max(0, Math.round(Number(maxUses) || 0));
  const plan = Math.max(0, Math.round(Number(planId) || 0));
  const exp = String(expiresAt || '').trim().slice(0, 10);
  try {
    const info = db.prepare(
      'INSERT INTO promo_codes (code, percent, plan_id, max_uses, expires_at, note, active) VALUES (?,?,?,?,?,?,1)'
    ).run(c, pct, plan, max, exp, String(note || '').trim().slice(0, 200));
    return { ok: true, id: info.lastInsertRowid, code: c, percent: pct };
  } catch {
    return { ok: false, error: `Code ${c} already exists.` };
  }
}

function setActive(id, on) {
  db.prepare('UPDATE promo_codes SET active=? WHERE id=?').run(on ? 1 : 0, id);
}

function remove(id) {
  const p = db.prepare('SELECT * FROM promo_codes WHERE id=?').get(id);
  if (!p) return { ok: false };
  const refs = db.prepare('SELECT COUNT(*) c FROM payments WHERE promo_id=?').get(id).c;
  if (refs > 0) {
    db.prepare('UPDATE promo_codes SET active=0 WHERE id=?').run(id);
    return { ok: true, deactivated: true };
  }
  db.prepare('DELETE FROM promo_codes WHERE id=?').run(id);
  return { ok: true };
}

module.exports = { normalize, getByCode, all, preview, usableBy, redeem, create, setActive, remove };
