-- FirmLedger — AI Playground chat transcript columns
-- Applied automatically at boot by src/db.js (idempotent; re-running is a no-op).
--
-- The admin assistant keeps its transcripts in ai_chat_sessions / ai_chat_messages.
-- These extra columns let a reloaded conversation show *what actually happened*
-- rather than only the prose the model emitted:
--   ai_chat_messages.model — the Groq model id that produced an assistant line
--   ai_chat_messages.tool  — the console action attached to a line (executed,
--                            cancelled or failed), empty for plain messages
--   ai_chat_messages.ok    — 0 when the attached action failed, 1 otherwise
--   ai_chat_sessions.last_message_at — denormalised stamp used for grouping
--                            (Today / Yesterday / Earlier) in the history rail
--
-- Index backs the history rail query: one operator's chats, active first,
-- newest touched at the top.

ALTER TABLE ai_chat_messages ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_chat_messages ADD COLUMN tool TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_chat_messages ADD COLUMN ok INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_chat_sessions ADD COLUMN last_message_at TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_owner
  ON ai_chat_sessions(user_id, archived, updated_at DESC);
