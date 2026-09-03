/**
 * Indexing log — the audit trail for every search-engine ping the app makes.
 *
 * Both channels write here (IndexNow for Bing/Yandex/DuckDuckGo/Seznam, and the
 * Google Indexing API), so Admin → Settings can show what was actually sent,
 * what came back, and let the operator clear the noise. Deliberately small: the
 * table is pruned to the newest KEEP rows on every write.
 */
const { db } = require('../db');

const KEEP = 500;

/**
 * Record one attempt.
 * @param {{channel: string, url: string, ok: boolean, status?: number, message?: string}} e
 */
function add({ channel = 'indexnow', url = '', ok = false, status = 0, message = '' }) {
  try {
    db.prepare(
      'INSERT INTO indexing_log (channel, url, ok, http_status, message) VALUES (?,?,?,?,?)'
    ).run(
      String(channel).slice(0, 20),
      String(url).slice(0, 500),
      ok ? 1 : 0,
      Number(status) || 0,
      String(message || '').slice(0, 400)
    );
    prune();
  } catch (e) {
    // The log must never break a ping — it is diagnostic only.
    console.error('[indexing-log] failed to record entry:', e && e.message);
  }
}

/** Keep the table bounded — anything past the newest `keep` rows is dropped. */
function prune(keep = KEEP) {
  try {
    db.prepare(
      'DELETE FROM indexing_log WHERE id NOT IN (SELECT id FROM indexing_log ORDER BY id DESC LIMIT ?)'
    ).run(Number(keep) || KEEP);
  } catch { /* best-effort */ }
}

/** Newest first. */
function recent(limit = 100) {
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  return db.prepare('SELECT * FROM indexing_log ORDER BY id DESC LIMIT ?').all(n);
}

function remove(id) {
  return db.prepare('DELETE FROM indexing_log WHERE id=?').run(Number(id) || 0).changes;
}

function clearAll() {
  return db.prepare('DELETE FROM indexing_log').run().changes;
}

function count() {
  return db.prepare('SELECT COUNT(*) c FROM indexing_log').get().c;
}

module.exports = { add, prune, recent, remove, clearAll, count, KEEP };
