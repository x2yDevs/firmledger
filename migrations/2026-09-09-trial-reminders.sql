-- FirmLedger — free-trial reminder milestones
-- Applied automatically at boot by src/db.js.
--
-- trial_reminders_sent: JSON array of reminder keys already delivered for the
-- current (or most recent) trial: "half" | "3d" | "1d" | "end".
-- The hourly trial sweep (src/lib/trialreminders.js) reads this so each
-- milestone emails + in-app notifications exactly once per trial.
-- startTrial() clears it, so a brand-new trial starts a fresh reminder ladder.

ALTER TABLE users ADD COLUMN trial_reminders_sent TEXT NOT NULL DEFAULT '';
