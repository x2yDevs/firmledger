-- FirmLedger — free trial columns on users
-- Applied automatically at boot by src/db.js.
--
-- subscription_status: NULL / 'free' | 'trialing' | 'active'
-- trial_started_at / trial_expires_at: UTC datetimes ('YYYY-MM-DD HH:MM:SS')
-- trial_days: length of the granted trial in days

ALTER TABLE users ADD COLUMN trial_started_at DATETIME;
ALTER TABLE users ADD COLUMN trial_expires_at DATETIME;
ALTER TABLE users ADD COLUMN trial_days INTEGER;
ALTER TABLE users ADD COLUMN subscription_status TEXT;

CREATE INDEX IF NOT EXISTS idx_users_trial ON users(trial_expires_at);
