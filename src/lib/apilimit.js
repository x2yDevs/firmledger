/**
 * FirmLedger API protection layer.
 *
 * Guards against the three classic ways an API kills a SQLite-backed app:
 *  1. Brute-force key guessing  → per-IP failure counter that locks the IP
 *     after repeated bad/expired keys (429 + Retry-After).
 *  2. Traffic floods            → fixed 60-second windows per key
 *     (reads and writes limited separately) + a global write ceiling.
 *  3. Concurrent-write pile-ups → an in-flight concurrency gate per key, so
 *     parallel writes from one client queue politely instead of stampeding
 *     the write journal. better-sqlite3 is synchronous, so writes already
 *     serialize safely; these gates keep request *arrival* rate sane.
 *
 * Everything is in-memory (per process) on purpose: counters are cheap,
 * restart-safe limits are not needed for abuse windows measured in seconds.
 */

const READ_RPM = Math.max(5, parseInt(process.env.API_READ_RPM || '60', 10) || 60);
const WRITE_RPM = Math.max(2, parseInt(process.env.API_WRITE_RPM || '20', 10) || 20);
const GLOBAL_WRITE_RPM = Math.max(10, parseInt(process.env.API_GLOBAL_WRITE_RPM || '120', 10) || 120);
const MAX_INFLIGHT = Math.max(2, parseInt(process.env.API_MAX_INFLIGHT || '6', 10) || 6);
const BRUTE_MAX_FAILS = Math.max(3, parseInt(process.env.API_BRUTE_MAX_FAILS || '8', 10) || 8);
const BRUTE_LOCK_MIN = Math.max(1, parseInt(process.env.API_BRUTE_LOCK_MIN || '15', 10) || 15);

const WINDOW_MS = 60_000;

/* bucket: name -> { start, reads, writes } */
const buckets = new Map();
const inflight = new Map();
const brute = new Map(); // ip -> { fails, lockedUntil }

function nowMs() { return Date.now(); }

function bucketFor(name) {
  let b = buckets.get(name);
  const t = nowMs();
  if (!b || t - b.start >= WINDOW_MS) {
    b = { start: t, reads: 0, writes: 0 };
    buckets.set(name, b);
  }
  return b;
}

/**
 * Check (and charge) one request. `name` is a bucket key (api key id or
 * playground user id). Returns { ok, remaining, resetInSec, limit, kind }.
 */
function liveLimits() {
  try {
    const spam = require('./spam');
    const l = spam.limits();
    return {
      read: Math.max(1, l.api_read_rpm || READ_RPM),
      write: Math.max(1, l.api_write_rpm || WRITE_RPM),
    };
  } catch {
    return { read: READ_RPM, write: WRITE_RPM };
  }
}

function charge(name, isWrite, { commit = true } = {}) {
  const b = bucketFor(name);
  const live = liveLimits();
  const limit = isWrite ? live.write : live.read;
  const used = isWrite ? b.writes : b.reads;
  const resetInSec = Math.max(1, Math.ceil((WINDOW_MS - (nowMs() - b.start)) / 1000));
  if (used >= limit) return { ok: false, remaining: 0, resetInSec, limit, kind: isWrite ? 'write' : 'read' };
  if (commit) { if (isWrite) b.writes += 1; else b.reads += 1; }
  return { ok: true, remaining: limit - used - (commit ? 1 : 0), resetInSec, limit, kind: isWrite ? 'write' : 'read' };
}

/** Global ceiling on writes across ALL keys — protects the journal from floods. */
function chargeGlobalWrite({ commit = true } = {}) {
  const b = bucketFor('__global_writes__');
  const resetInSec = Math.max(1, Math.ceil((WINDOW_MS - (nowMs() - b.start)) / 1000));
  if (b.writes >= GLOBAL_WRITE_RPM) return { ok: false, resetInSec };
  if (commit) b.writes += 1;
  return { ok: true, resetInSec };
}

/* ---------------- in-flight concurrency gate ---------------- */
function acquireSlot(name) {
  const n = inflight.get(name) || 0;
  if (n >= MAX_INFLIGHT) return false;
  inflight.set(name, n + 1);
  return true;
}
function releaseSlot(name) {
  const n = (inflight.get(name) || 1) - 1;
  if (n <= 0) inflight.delete(name); else inflight.set(name, n);
}

/* ---------------- brute-force guard (bad API keys per IP) ---------------- */
function ipLocked(ip) {
  const e = brute.get(ip);
  if (!e) return { locked: false, retryAfterSec: 0 };
  if (e.lockedUntil && e.lockedUntil > nowMs()) {
    return { locked: true, retryAfterSec: Math.ceil((e.lockedUntil - nowMs()) / 1000) };
  }
  return { locked: false, retryAfterSec: 0 };
}
function registerFail(ip) {
  const e = brute.get(ip) || { fails: 0, lockedUntil: 0 };
  e.fails += 1;
  if (e.fails >= BRUTE_MAX_FAILS) {
    e.lockedUntil = nowMs() + BRUTE_LOCK_MIN * 60_000;
    e.fails = 0;
  }
  brute.set(ip, e);
  return ipLocked(ip);
}
function clearFails(ip) { brute.delete(ip); }

/* ---------------- standard JSON error envelope ---------------- */
function apiError(res, status, code, message, extra = {}) {
  const body = { error: { code, message } };
  if (extra.details) body.error.details = extra.details;
  if (extra.retryAfterSec) {
    body.error.retry_after_seconds = extra.retryAfterSec;
    res.set('Retry-After', String(extra.retryAfterSec));
  }
  return res.status(status).json(body);
}

function rateHeaders(res, chargeInfo, isWrite) {
  res.set('X-RateLimit-Limit', String(chargeInfo.limit));
  res.set('X-RateLimit-Remaining', String(chargeInfo.remaining));
  res.set('X-RateLimit-Reset', String(chargeInfo.resetInSec));
  res.set('X-RateLimit-Scope', isWrite ? 'write' : 'read');
}

module.exports = {
  READ_RPM, WRITE_RPM, GLOBAL_WRITE_RPM, MAX_INFLIGHT, BRUTE_MAX_FAILS, BRUTE_LOCK_MIN,
  charge, chargeGlobalWrite, acquireSlot, releaseSlot,
  ipLocked, registerFail, clearFails, apiError, rateHeaders,
};
