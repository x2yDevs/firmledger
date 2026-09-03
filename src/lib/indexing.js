/**
 * Search-engine indexing.
 * - Serves the IndexNow key file (auto-generated, stored in settings)
 * - Pings IndexNow (Bing, Yandex, DuckDuckGo, Seznam…) the moment a listing
 *   goes live, and re-pings 30 minutes later. Combined with the auto-updated
 *   sitemap, new listings are typically picked up within a few hours.
 *
 * Every attempt is written to the indexing log (Admin → Settings → Indexing log)
 * so an operator can see exactly what left the building and what each engine
 * answered.
 */
const crypto = require('crypto');
const { getSetting, setSetting } = require('../db');
const { siteUrl } = require('./util');
const log = require('./indexlog');

function getIndexNowKey() {
  let key = getSetting('indexnow_key');
  if (!key) {
    key = crypto.randomBytes(16).toString('hex');
    setSetting('indexnow_key', key);
  }
  return key;
}

function enabled() {
  return getSetting('indexing_enabled', '1') === '1';
}

/**
 * Submit URLs to IndexNow. Never throws — failures are logged (console + the
 * indexing log) so a broken key never takes a listing submission down with it.
 */
async function pingIndexNow(paths) {
  const urlList = (Array.isArray(paths) ? paths : [paths]).filter(Boolean).map((p) => siteUrl(p));
  if (!urlList.length) return { ok: false, skipped: true };

  if (!enabled()) {
    console.log(`[indexnow] indexing is switched off — skipped ${urlList.length} url(s)`);
    return { ok: false, skipped: true };
  }

  const key = getIndexNowKey();
  const payload = {
    host: new URL(siteUrl('/')).hostname,
    key,
    keyLocation: siteUrl(`/${key}.txt`),
    urlList,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const ok = res.status >= 200 && res.status < 300;
    const note = ok ? `${urlList.length} url(s) accepted` : `HTTP ${res.status}`;
    console.log(`[indexnow] submitted ${urlList.length} url(s) — status ${res.status}`);
    for (const u of urlList) log.add({ channel: 'indexnow', url: u, ok, status: res.status, message: note });
    return { ok, status: res.status };
  } catch (e) {
    clearTimeout(timer);
    const msg = String((e && e.message) || e || 'request failed').slice(0, 300);
    console.error(`[indexnow] submission failed for ${urlList.length} url(s) — ${msg}`);
    for (const u of urlList) log.add({ channel: 'indexnow', url: u, ok: false, status: 0, message: msg });
    return { ok: false, status: 0, error: msg };
  }
}

/** Fire-and-forget: submit now, then once more in 30 minutes. */
function submitForIndexing(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!list.length) return;
  pingIndexNow(list).catch(() => {});
  setTimeout(() => pingIndexNow(list).catch(() => {}), 30 * 60 * 1000).unref();
}

module.exports = { getIndexNowKey, pingIndexNow, submitForIndexing, enabled };
