-- FirmLedger AI Playground: remove saved Admin assistant chat history.
-- The assistant remains available, but every turn is stateless and only keeps
-- in-page context for the current browser tab. Pending action confirmations stay
-- in ai_pending_actions and continue to expire normally.
--
-- Applied automatically at boot by src/db.js (idempotent; re-running is a no-op).
-- Messages are dropped first because they reference the session rows.

DROP TABLE IF EXISTS ai_chat_messages;
DROP TABLE IF EXISTS ai_chat_sessions;
