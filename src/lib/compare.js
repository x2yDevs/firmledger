/**
 * FirmLedger Compare — side-by-side company comparison.
 *
 * Selection lives in a short-lived cookie (works for guests AND signed-in
 * users, no account required), capped at MAX items. The /compare page reads it
 * and renders a side-by-side table of the selected (approved) listings.
 */
const MAX = 4;
const COOKIE = 'fl_compare';

function read(req) {
  const raw = req.cookies ? req.cookies[COOKIE] : '';
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? [...new Set(arr.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))].slice(0, MAX)
      : [];
  } catch { return []; }
}

function write(res, ids, req) {
  res.cookie(COOKIE, JSON.stringify(ids), {
    httpOnly: true, sameSite: 'lax', secure: Boolean(req && req.secure), path: '/', maxAge: 30 * 24 * 3600 * 1000,
  });
}

function add(id, res, req) {
  let ids = read(req);
  id = Number(id) || 0;
  if (id < 1) return { ok: false, ids, reason: 'not_found' };
  if (ids.includes(id)) return { ok: true, added: false, ids };
  if (ids.length >= MAX) return { ok: false, ids, reason: 'full', max: MAX };
  ids = [...ids, id];
  write(res, ids, req);
  return { ok: true, added: true, ids };
}

function remove(id, res, req) {
  let ids = read(req).filter((x) => x !== Number(id));
  write(res, ids, req);
  return { ok: true, ids };
}

function clear(res, req) {
  write(res, [], req);
}

function includes(req, id) {
  return read(req).includes(Number(id) || 0);
}

module.exports = { MAX, COOKIE, read, write, add, remove, clear, includes };
