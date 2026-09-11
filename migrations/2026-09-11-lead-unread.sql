-- FirmLedger — per-side unread counters on Leads conversations.
-- Applied automatically at boot by src/db.js; this file is the reference copy
-- for applying the same change by hand against a live database.
--
-- Why: before this, the only "unread" signal in the Leads inbox was
-- status='new'. Once a business replied once (status → contacted) every later
-- customer message arrived with no indicator at all, and the member's Sent box
-- never showed that a business had answered. Both sides could miss a live
-- conversation entirely.
--
-- owner_unread     messages from the inquirer the business has not opened yet.
-- inquirer_unread  messages from the business the member has not opened yet.
--
-- Counters are incremented in src/lib/leads.js addMessage() (the OTHER side's
-- counter) and cleared by markRead() when that side opens the thread.
--
-- Existing rows default to 0 ("read"): a pre-migration thread cannot be proven
-- unopened, and a badge nobody can clear is worse than no badge. The one safe
-- exception is a lead still sitting at status='new' and not archived — it has
-- provably never been worked, so it starts with a single unread message.
-- Run the UPDATE only together with the ALTERs, never on its own afterwards.

ALTER TABLE leads ADD COLUMN owner_unread INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN inquirer_unread INTEGER NOT NULL DEFAULT 0;

UPDATE leads SET owner_unread = 1 WHERE status = 'new' AND archived = 0;
