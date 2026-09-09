-- Mail providers: Emitlo / Maileroo / Mailjet removed.
--
-- The three presets are no longer offered in Admin → Settings (and their
-- bulk-mail terms / availability made them poor failover hops), so any
-- credentials saved for them are dropped — kept accounts would still be
-- walked by the SMTP failover chain and pinged by the inactivity keep-alive.
--
-- Mirrored in src/db.js so existing deployments clean up on boot without a
-- manual SQL pass.

DELETE FROM smtp_accounts WHERE provider IN ('emitlo', 'maileroo', 'mailjet');
