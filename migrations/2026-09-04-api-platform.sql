-- FirmLedger API platform: key scopes, durable usage aggregates and webhooks.
-- src/db.js applies this schema automatically on boot. The ALTER is intentionally
-- written like the other dated migrations: existing deployments should run it
-- once, while fresh installs get the column from the boot schema.

ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '["read:listings","write:listings","read:relationships","export","manage:webhooks","read:usage"]';

CREATE INDEX IF NOT EXISTS idx_api_usage_daily_day ON api_usage_daily(day, key_id);

CREATE TABLE IF NOT EXISTS api_usage_endpoint_daily (
  key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  method TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  writes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day, method, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_api_usage_endpoint_day ON api_usage_endpoint_daily(day, key_id);

CREATE TABLE IF NOT EXISTS api_webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  secret_prefix TEXT NOT NULL DEFAULT '',
  secret_ciphertext TEXT NOT NULL DEFAULT '',
  events TEXT NOT NULL DEFAULT '["listing.approved","listing.rejected","listing.updated","listing.created","claim.verified"]',
  categories TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  last_delivery_at TEXT,
  last_success_at TEXT,
  disabled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, url)
);
CREATE INDEX IF NOT EXISTS idx_api_webhooks_user ON api_webhooks(user_id, active);

CREATE TABLE IF NOT EXISTS api_webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id INTEGER NOT NULL REFERENCES api_webhooks(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  response_status INTEGER NOT NULL DEFAULT 0,
  response_body TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(webhook_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_api_webhook_deliveries_queue ON api_webhook_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_api_webhook_deliveries_webhook ON api_webhook_deliveries(webhook_id, created_at DESC);
