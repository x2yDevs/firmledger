-- FirmLedger — OAuth (Google / LinkedIn) identity columns on users
-- Applied automatically at boot by src/db.js.
--
-- provider:    'google' | 'linkedin' (NULL for password-only accounts)
-- provider_id: the provider's stable subject id for the account
-- avatar_url:  profile picture returned by the provider

ALTER TABLE users ADD COLUMN provider TEXT;
ALTER TABLE users ADD COLUMN provider_id TEXT;
ALTER TABLE users ADD COLUMN avatar_url TEXT;

CREATE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id);
