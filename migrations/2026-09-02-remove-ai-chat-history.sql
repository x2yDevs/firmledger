-- FirmLedger AI Playground: remove saved Admin assistant chat history.
-- The assistant remains available, but future turns are stateless and only keep
-- in-page context for the current browser tab. Pending action confirmations stay
-- in ai_pending_actions and continue to expire normally.

DELETE FROM ai_chat_messages;
DELETE FROM ai_chat_sessions;
