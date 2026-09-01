-- Public status page: monitored components, incident history, email subscribers.
-- Mirrors the CREATE/ALTER statements in src/db.js so existing deployments
-- can run this file against a live database without a full re-seed.

-- Components the status monitor checks (Web Application, API, Database, Email).
CREATE TABLE IF NOT EXISTS status_components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'operational',
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every health check writes a row here; the 24h/7d/30d/90d uptime bars are
-- derived from this. Kept to the last 90 days by the monitor.
CREATE TABLE IF NOT EXISTS component_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  component_id INTEGER NOT NULL REFERENCES status_components(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_status_hist_component ON component_status_history(component_id, checked_at);

-- Incidents / outages. status: investigating -> identified -> monitoring -> resolved.
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'investigating',
  severity TEXT NOT NULL DEFAULT 'minor',
  component_id INTEGER REFERENCES status_components(id) ON DELETE SET NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_component ON incidents(component_id);
CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents(created_at DESC);

-- Timeline entries attached to an incident (public page + RSS-style updates).
CREATE TABLE IF NOT EXISTS incident_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_incident_updates_incident ON incident_updates(incident_id, id);

-- Email subscribers for status alerts (double-opt-in via verification_token).
CREATE TABLE IF NOT EXISTS status_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  verified INTEGER NOT NULL DEFAULT 1,
  verification_token TEXT NOT NULL DEFAULT '',
  subscribed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Housekeeping: drop history older than 90 days (keeps uptime stats honest and the DB small).
DELETE FROM component_status_history WHERE checked_at < datetime('now', '-90 days');
