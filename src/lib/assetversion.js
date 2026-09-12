/**
 * FirmLedger — the cache-buster for everything under `public/`.
 *
 * `server.js` serves `/public` with `Cache-Control: max-age=604800` (7 days, by
 * design), and the only thing that invalidates a cached stylesheet is its URL.
 * So every view links the asset as `?v=<%= assetV %>`, and *the version has to
 * move whenever the bytes move* — that is the entire invalidation strategy.
 *
 * It used to be a constant a developer bumped by hand (`ASSET_V = '58'`). It was
 * bumped by hand 58 times, and then — across the leads-inbox rounds of
 * 2026-09-12 — `public/css/app.css` changed seven times in a row without the
 * constant moving once. Every one of those deploys shipped a *new* inbox
 * (the list became one full-width column, a conversation became its own page,
 * both pages moved to the wide container) behind *the same* URL
 * `/css/app.css?v=58`. Browsers held their 7-day copy, so the pages kept
 * rendering the old shape — the inbox as a narrow rail pinned to the left, the
 * conversation squeezed into the same rail — and each round of fixes read as
 * "nothing changed" no matter how correct the stylesheet had become.
 *
 * The version is now derived from the files themselves: hash the content, put
 * the hash in the URL. An edit changes the bytes, the bytes change the hash,
 * the hash changes the URL, and a stale copy is unreachable by construction —
 * there is no step left for a human to forget. Files that did not change keep
 * their URL (they stay cached for the full 7 days), which is the point of a
 * content hash rather than a counter.
 *
 * Add a path to `FILES` and it is covered; nothing else has to know.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/* Every file the pages request with `?v=<assetV>` — the stylesheet and the two
   scripts. Fonts and images are pulled in by the stylesheet (whose own hash
   covers them) or are small and unversioned, as they always were. */
const FILES = ['public/css/app.css', 'public/js/main.js', 'public/js/graph.js'];

/* Human-readable half of the version: the app generation the hash belongs to.
   It no longer has to be bumped (the hash does the work) — it is kept because a
   deploy log that reads `?v=58-1f3a9c2e` tells an operator which generation of
   the site served the file, and a bare hash does not. */
const BASE = '58';

/**
 * The version for a set of `[name, contents]` pairs. Pure — no disk, no
 * globals — so a test can ask "if this file changed, would the URL change?"
 * without touching the checked-in files.
 */
function versionOf(contents, base) {
  const h = crypto.createHash('sha256');
  for (const [name, body] of contents) {
    h.update(name).update('\0').update(body).update('\0');
  }
  return (base === undefined ? BASE : base) + '-' + h.digest('hex').slice(0, 8);
}

/** `[relativePath, Buffer]` for every file that exists, in a stable order. */
function assetContents() {
  return FILES
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)))
    .map((rel) => [rel, fs.readFileSync(path.join(ROOT, rel))]);
}

const ASSET_V = versionOf(assetContents());

module.exports = { ASSET_V, versionOf, assetContents, FILES, BASE, ROOT };
