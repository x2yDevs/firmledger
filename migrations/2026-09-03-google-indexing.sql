-- Google Indexing API — submission ledger + shared indexing log.
-- Mirrors the CREATE statements in src/db.js so existing deployments can run
-- this file against a live database without a full re-seed.
--
-- indexing_log
--   Every search-engine ping the app makes (IndexNow and the Google Indexing
--   API), with the outcome, so Admin → Settings → Indexing log can show what
--   was actually sent and what came back.
--
-- google_indexing_submissions
--   URLs already published to Google through the Indexing API. Two rules hang
--   off this table:
--     • Google's default quota is 200 URL_UPDATED notifications per day, so
--       the manual "submit first 200 listings" run is capped by however many
--       were submitted in the last 24 hours.
--     • A URL that has been pinged is never pinged again — the batch run only
--       ever selects URLs missing from this table.

CREATE TABLE IF NOT EXISTS indexing_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL DEFAULT 'indexnow',
  url TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_indexing_log_created ON indexing_log(created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS google_indexing_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  listing_id INTEGER,
  http_status INTEGER NOT NULL DEFAULT 0,
  response TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_google_sub_created ON google_indexing_submissions(created_at DESC);
