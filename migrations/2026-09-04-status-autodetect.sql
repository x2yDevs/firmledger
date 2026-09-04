-- Status auto-detection — probe telemetry on components + incident provenance.
-- Mirrors the DDL in src/db.js so existing deployments can apply the same
-- changes against a live database without a re-seed.
--
-- status_components.last_note / last_latency_ms / last_checked_at
--   What the most recent probe actually saw ("HTTP 200", "timed out", 143 ms).
--   Admin → Status shows this live so a detected problem is visible with its
--   evidence, not just a coloured pill.
--
-- incidents.source
--   'manual'  — opened by an admin from the console.
--   'auto'    — opened by the status monitor when a probe failed. Auto
--               incidents behave exactly like manual ones on /status and can
--               be updated, resolved or permanently deleted by an admin.

ALTER TABLE status_components ADD COLUMN last_note TEXT NOT NULL DEFAULT '';
ALTER TABLE status_components ADD COLUMN last_latency_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE status_components ADD COLUMN last_checked_at TEXT NOT NULL DEFAULT '';
ALTER TABLE incidents ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS idx_incidents_source ON incidents(source, status);
