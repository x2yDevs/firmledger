-- FirmLedger — notification archiving (trash + auto-expiry)
-- Applied automatically at boot by src/db.js; kept here for manual/psql-style runs.
-- SQLite has no "ADD COLUMN IF NOT EXISTS": running a statement twice errors
-- harmlessly with "duplicate column name".

ALTER TABLE notifications ADD COLUMN archived_at DATETIME;
ALTER TABLE notifications ADD COLUMN deleted_at DATETIME;
ALTER TABLE notifications ADD COLUMN archive_expires_at DATETIME;

CREATE INDEX IF NOT EXISTS idx_notif_trash ON notifications(deleted_at);
CREATE INDEX IF NOT EXISTS idx_notif_expiry ON notifications(archive_expires_at);
