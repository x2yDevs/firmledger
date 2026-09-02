-- Removal requests keep their history after the listing is deleted.
--
-- Before: listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE
-- Fulfilling a request deletes the listing, which cascaded the request away, so
-- Admin → Removals lost the "removed" outcome entirely.
-- After: listing_id is nullable and set to NULL when the listing goes.
-- src/db.js applies the same change automatically on boot.

PRAGMA foreign_keys = OFF;
BEGIN;

CREATE TABLE IF NOT EXISTS removal_requests__new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

INSERT INTO removal_requests__new (id, listing_id, name, email, reason, status, created_at, resolved_at)
  SELECT id, listing_id, name, email, reason, status, created_at, resolved_at FROM removal_requests;

DROP TABLE removal_requests;
ALTER TABLE removal_requests__new RENAME TO removal_requests;
CREATE INDEX IF NOT EXISTS idx_removal_listing ON removal_requests(listing_id);

COMMIT;
PRAGMA foreign_keys = ON;
