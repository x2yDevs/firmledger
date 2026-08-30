/**
 * Search-engine indexing.
 * - Serves the IndexNow key file (auto-generated, stored in settings)
 * - Pings IndexNow (Bing, Yandex, DuckDuckGo, Seznam…) the moment a listing
 *   goes live, and re-pings 30 minutes later. Combined with the auto-updated
 *   sitemap, new listings are typically picked up within a few hours.
 */
const crypto = require('crypto');
const { getSetting, setSetting } = require('../db');
const { siteUrl } = require('./util');

function getIndexNowKey() {
  let key = getSetting('indexnow_key');
  if (!key) {
    key = crypto.randomBytes(16).toString('hex');
    setSetting('indexnow_key', key);
  }
  return key;
}

async function pingIndexNow(paths) {
  if (getSetting('indexing_enabled', '1') !== '1') return;
  const key = getIndexNowKey();
  const urlList = paths.map((p) => siteUrl(p));
  const payload = {
    host: new URL(siteUrl('/')).hostname,
    key,
    keyLocation: siteUrl(`/${key}.txt`),
    urlList,
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    console.log(`[indexnow] submitted ${urlList.length} url(s) — status ${res.status}`);
  } catch (e) {
    console.warn('[indexnow] submission failed:', e.message);
  }
}

/** Fire-and-forget: submit now, then once more in 30 minutes. */
function submitForIndexing(paths) {
  pingIndexNow(paths).catch(() => {});
  setTimeout(() => pingIndexNow(paths).catch(() => {}), 30 * 60 * 1000).unref();
}

module.exports = { getIndexNowKey, submitForIndexing };
