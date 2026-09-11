# FirmLedger database — entity relationship reference

**Generated 2026-09-11** from a fresh-boot SQLite schema (`src/db.js`, which also
applies everything under `migrations/`), cross-checked statement by statement
against the implementation in `src/lib/` and `src/routes/`. Every enum below cites
the file that enforces it.

> **Companion diagram:** `ERD.svg` in the repo root predates this regeneration and
> only covers the original ~20 tables — it is stale. This document is the accurate
> reference for all 50 tables until the diagram is redrawn.

## Global conventions (verified in `src/db.js`)

- **50 tables**, 56 explicit `CREATE INDEX` statements plus auto-indexes backing
  every `UNIQUE` / `PRIMARY KEY` constraint.
- `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`
  (`src/db.js:17-18`) — declared `REFERENCES … ON DELETE …` clauses **are
  enforced**, except inside the two legacy table-rebuild migrations, which toggle
  the pragma off and back on (`src/db.js:373-440`).
- **No `CHECK` constraints anywhere** — every enum/status is enforced in
  application code. The code reference is given per column.
- Timestamps are `TEXT` in UTC (`datetime('now')` / ISO-8601). Empty string `''`
  means "not set" for most optional date columns (`plan_expires_at`,
  `trial_reminders_sent`, …); a few use real `NULL` (`trial_expires_at`,
  `paid_at`, `resolved_at`, `last_verified_at`).
- Money is integer **cents** (`price_cents`, `amount`, `discount_cents`).
- Boolean flags are `INTEGER` `0/1` (`claimed`, `sponsored`, `active`, …).
- JSON-in-`TEXT` columns are used for small structured blobs (`socials`,
  `sources`, `tech`, `scopes`, `events`, `trial_reminders_sent`, …).

**Legend:** 📊 intentionally denormalized / derived analytics data ·
🔑 `UNIQUE` (or PK participant) · ➡ logical reference **without** a declared FK.

---

## 1 · Identity & access

### `users` — accounts (members; admins authenticate by session, not by flag)
- `id` INTEGER PK AUTOINCREMENT
- `email` TEXT 🔑 NOT NULL
- `password_hash` TEXT NOT NULL — PBKDF2-SHA512 600k (`src/lib/passwords.js`); OAuth-only accounts store a random placeholder (`src/lib/oauth.js`)
- `name` TEXT NOT NULL DEFAULT `''`
- `role` TEXT NOT NULL DEFAULT `'member'` — **reserved, effectively unused**: nothing reads it for authorization; admin access comes from the `admin` session kind (`src/lib/session.js`), never from this column
- `created_at` TEXT NOT NULL DEFAULT `datetime('now')`
- `suspended` INTEGER NOT NULL DEFAULT `0`
- `plan` TEXT NOT NULL DEFAULT `'free'` — enum `'free' | 'pro'` (`src/lib/plans.js`)
- `plan_expires_at` TEXT NOT NULL DEFAULT `''` — `''` = lifetime/non-expiring (`src/lib/plans.js:50-51`)
- `trial_started_at`, `trial_expires_at` DATETIME NULL · `trial_days` INTEGER NULL (`src/lib/plans.js`)
- `subscription_status` TEXT NULL — enum `'trialing' | 'active' | 'free'` + legacy NULL (`src/lib/plans.js:90-91,156`)
- `trial_reminders_sent` TEXT NOT NULL DEFAULT `''` — 📊 JSON array of sent ladder keys: `'half' | '3d' | '1d' | 'end'` (`src/lib/trialreminders.js:33-41,53-55`)
- `provider`, `provider_id`, `avatar_url` TEXT NULL — OAuth: `provider` ∈ `'google' | 'linkedin'` (`src/lib/oauth.js:97-112`); indexed (`idx_users_provider`)
- `leads_digest` TEXT NOT NULL DEFAULT `'both'` — weekly-report channel `'both' | 'email' | 'notification' | 'none'` (`src/routes/dashboard.js`, `src/lib/leadsdigest.js`)

### `user_totp` — member two-factor secrets
- `user_id` INTEGER PK ➡ FK `users(id)` ON DELETE CASCADE
- `secret`, `pending_secret` TEXT NOT NULL DEFAULT `''` · `recovery_codes` TEXT NOT NULL DEFAULT `'[]'` (JSON) · `enabled` INTEGER NOT NULL DEFAULT `0` · `enabled_at` TEXT NOT NULL DEFAULT `''` (`src/lib/user2fa.js`, `src/lib/totp.js`)

### `sessions` — cookie sessions (30-day TTL)
- `token` TEXT PK · `user_id` INTEGER NULL ➡ FK `users(id)` ON DELETE CASCADE (NULL for admin sessions, which are not tied to a user row)
- `csrf` TEXT NOT NULL · `expires_at` TEXT NOT NULL, indexed (`idx_sessions_expiry`)
- `kind` TEXT NOT NULL DEFAULT `'user'` — enum `'user' | 'admin' | 'admin-pending'` (`src/lib/session.js`, `src/routes/admin.js:124,281`)

### `reg_otps` — pending registrations awaiting email code
- `id` INTEGER PK · `email`, `name`, `password_hash`, `code`, `expires_at` TEXT NOT NULL (`email` indexed) · `attempts` INTEGER NOT NULL DEFAULT `0` · `newsletter` INTEGER NOT NULL DEFAULT `0` (opt-in carried into `newsletter_subscribers`) (`src/routes/auth.js`)

### `resets` — password-reset tokens
- `token` TEXT PK · `email` TEXT NOT NULL · `expires_at` TEXT NOT NULL (`src/routes/auth.js`)

### `deletion_requests` — delete-my-account queue
- `id` INTEGER PK · `user_id` INTEGER NOT NULL ➡ FK `users(id)` ON DELETE CASCADE (indexed)
- `reason`, `improve`, `confirm_name` TEXT NOT NULL DEFAULT `''`
- `status` TEXT NOT NULL DEFAULT `'pending'`, indexed — enum `'pending' | 'completed'` (`src/routes/admin.js:1193`)
- `created_at` TEXT NOT NULL DEFAULT now · `resolved_at` TEXT NULL

---

## 2 · Listings core

### `listings` — the ledger itself (38 columns)
- `id` INTEGER PK AUTOINCREMENT · `slug` TEXT 🔑 NOT NULL · `name` TEXT NOT NULL
- `tagline`, `description` TEXT NOT NULL DEFAULT `''`
- `type` TEXT NOT NULL DEFAULT `'company'` — enum `company | startup | agency | organization | product | service | publisher` (`src/lib/taxonomy.js:3-11`), indexed
- `category` TEXT NOT NULL DEFAULT `'Other'` — 📊 **denormalized free-text label**, intentionally *not* an FK to `categories` (stable even if a category row is renamed/merged); controlled vocabulary of 20 official names in `src/lib/taxonomy.js:13-19`, indexed
- `website`, `email`, `phone` TEXT NOT NULL DEFAULT `''`
- `country` TEXT (indexed), `city`, `region`, `address` TEXT NOT NULL DEFAULT `''` — country suggestions in `src/lib/taxonomy.js:23-28`
- `logo_url` TEXT NOT NULL DEFAULT `''` · `founded` TEXT NOT NULL DEFAULT `''`
- `size` TEXT NOT NULL DEFAULT `''` — suggestions `1–10 | 11–50 | 51–200 | 201–500 | 501–1,000 | 1,000+` (`src/lib/taxonomy.js:21`)
- `tags` TEXT NOT NULL DEFAULT `''` (comma list) · `socials` TEXT NOT NULL DEFAULT `'{}'` (JSON) · `sources` TEXT NOT NULL DEFAULT `'[]'` (JSON)
- `status` TEXT NOT NULL DEFAULT `'pending'`, indexed — enum `'pending' | 'approved' | 'rejected'` (`src/lib/apilistings.js:421`, `src/lib/aitools-admin.js:345`)
- `featured` INTEGER NOT NULL DEFAULT `0` — admin pin (always leads the homepage rail)
- `claimed` INTEGER NOT NULL DEFAULT `0`
- `confidence` INTEGER NOT NULL DEFAULT `0` — 📊 **derived**: recomputed by `confidenceScore()` on every write (`src/routes/dashboard.js:285,393`); 0–97
- `owner_user_id` INTEGER NULL ➡ FK `users(id)` ON DELETE SET NULL (indexed) · `submitter_user_id` INTEGER NULL ➡ FK `users(id)` ON DELETE SET NULL
- `last_verified_at` TEXT NULL · `created_at`, `updated_at` TEXT NOT NULL DEFAULT now
- `tech` TEXT NOT NULL DEFAULT `'[]'` (JSON radar snapshot) · `tech_checked_at`, `news_checked_at`, `hiring_url` TEXT NOT NULL DEFAULT `''` (`src/lib/techrefresh.js`, `src/lib/upkeep.js`)
- `plan` TEXT NOT NULL DEFAULT `'free'` (`'free' | 'pro'`, listing-level boost) · `plan_expires_at` TEXT NOT NULL DEFAULT `''` (`''` = non-expiring, `src/lib/plans.js:51`)
- `sponsored` INTEGER NOT NULL DEFAULT `0` · `sponsored_expires_at` TEXT NOT NULL DEFAULT `''` (`''` = non-expiring) · `ad_reference` TEXT NOT NULL DEFAULT `''` (`src/lib/advertising.js:74-87`)

### `categories` — official + custom category rows (also seeds the 20 officials on boot)
- `id` INTEGER PK · `name` TEXT NOT NULL · `slug` TEXT 🔑 NOT NULL · `official` INTEGER NOT NULL DEFAULT `0` · `created_at` (`src/lib/categories.js`)

### `listing_events` — profile timeline entries
- `id` INTEGER PK · `listing_id` INTEGER NOT NULL ➡ FK `listings(id)` ON DELETE CASCADE (indexed)
- `event_date` TEXT NOT NULL DEFAULT `''` · `title` TEXT NOT NULL
- `kind` TEXT NOT NULL DEFAULT `'milestone'` — open vocabulary; dashboard allows `founded | funding | product | leadership | acquisition | milestone` (`src/routes/dashboard.js:520`); console accepts free text ≤30 chars (`src/routes/admin.js:997`); assistant also suggests `launch | award` (`src/lib/aitools-admin.js:738`)

### `relationships` — relationship graph edges
- `id` INTEGER PK · `listing_id` INTEGER NOT NULL ➡ FK `listings(id)` ON DELETE CASCADE (indexed)
- `rel_type` TEXT NOT NULL — enum `founder | investor | parent_company | subsidiary | product | service | partner` (`src/lib/graph.js:5-13`)
- `target_listing_id` INTEGER NULL ➡ FK `listings(id)` ON DELETE CASCADE (indexed) — NULL when the target is not on FirmLedger
- `target_name` TEXT NOT NULL DEFAULT `''` (free-text fallback) · `note` TEXT NOT NULL DEFAULT `''` · `created_at`

### `favorites` — member watchlist (star)
- `id` INTEGER PK · `user_id` ➡ FK `users(id)` CASCADE (indexed) · `listing_id` ➡ FK `listings(id)` CASCADE · 🔑 `UNIQUE(user_id, listing_id)` · `created_at`

---

## 3 · Moderation & ownership queues

### `claims` — domain-ownership verification attempts
- `id` INTEGER PK · `listing_id` ➡ FK `listings(id)` CASCADE (indexed) · `user_id` ➡ FK `users(id)` CASCADE (indexed)
- `method` TEXT NOT NULL — enum `'dns' | 'meta' | 'badge'` (`src/routes/claim.js:57`)
- `token`, `domain` TEXT NOT NULL
- `status` TEXT NOT NULL DEFAULT `'pending'` — enum `'pending' | 'verified' | 'rejected'` (`src/lib/claimflow.js:18,23`)
- `created_at` · `verified_at` TEXT NULL

### `removal_requests` — takedown / correction requests (survive listing deletion)
- `id` INTEGER PK · `listing_id` INTEGER NULL ➡ FK `listings(id)` ON DELETE **SET NULL** (indexed) — history is kept even after the listing is removed (`migrations/2026-09-02-removal-requests-history.sql`)
- `name`, `email`, `reason` TEXT NOT NULL DEFAULT `''`
- `status` TEXT NOT NULL DEFAULT `'pending'` — enum `'pending' | 'dismissed' | 'removed'` (`src/routes/admin.js:1611,1621`)
- `created_at` · `resolved_at` TEXT NULL

### `pro_transfer_requests` — move a listing-level Pro boost between records
- `id` INTEGER PK · `user_id` ➡ FK `users(id)` CASCADE (indexed) · `from_listing_id`, `to_listing_id` ➡ FK `listings(id)` CASCADE
- `note` TEXT NOT NULL DEFAULT `''`
- `status` TEXT NOT NULL DEFAULT `'pending'` — enum `'pending' | 'approved' | 'rejected'` (`src/routes/admin.js:2272-2290`)
- `created_at` · `resolved_at` TEXT NULL

---

## 4 · Leads & analytics 📊

### `leads` — visitor inquiries sent to businesses
- `id` INTEGER PK · `listing_id` ➡ FK `listings(id)` CASCADE · `owner_user_id` ➡ FK `users(id)` CASCADE — composite index `idx_leads_owner(owner_user_id, archived, status, created_at DESC)` serves the inbox; `idx_leads_listing(listing_id, created_at DESC)` serves per-listing counts
- `name`, `email`, `phone`, `looking_for`, `message`, `city`, `country` TEXT NOT NULL DEFAULT `''`
- `status` TEXT NOT NULL DEFAULT `'new'` — enum `'new' | 'contacted' | 'qualified' | 'won' | 'lost'` (`src/lib/leads.js:15`)
- `archived` INTEGER NOT NULL DEFAULT `0` · `created_at`, `updated_at` (`src/lib/leads.js`)

### `lead_notes` — owner notes on a lead
- `id` INTEGER PK · `lead_id` ➡ FK `leads(id)` CASCADE (indexed with `id`) · `user_id` ➡ FK `users(id)` CASCADE · `note` TEXT NOT NULL DEFAULT `''` · `created_at`

### `listing_stat_events` 📊 — raw analytics events (views, clicks, impressions)
- `id` INTEGER PK · `listing_id` INTEGER NOT NULL ➡ FK `listings(id)` CASCADE
- `kind` TEXT NOT NULL DEFAULT `'view'` — enum `'view' | 'website_click' | 'sponsored_impression' | 'featured_impression'` (`src/lib/analytics.js:31-32`)
- `visitor_hash` (salted daily hash, not an identity), `city`, `country`, `referrer` TEXT NOT NULL DEFAULT `''` · `created_at`
- Indexes: `(listing_id, created_at)`, `(listing_id, kind, created_at)`, `(listing_id, country, city)`
- **Retention:** rows older than 400 days are purged by the scheduled jobs (`purgeOldEvents`, `src/lib/analytics.js`; every reporting window is ≤365 days)

---

## 5 · News

### `listing_news` — detected / submitted / hand-written stories
- `id` INTEGER PK · `listing_id` ➡ FK `listings(id)` CASCADE (indexed)
- `title` TEXT NOT NULL · `url` TEXT NOT NULL DEFAULT `''` · `source`, `published_at`, `summary` TEXT NOT NULL DEFAULT `''`
- `origin` TEXT NOT NULL DEFAULT `'auto'` — enum `'auto' | 'user' | 'admin'` (`src/lib/news.js:365,385,465`)
- `status` TEXT NOT NULL DEFAULT `'pending'`, indexed — enum `'pending' | 'approved' | 'rejected'` (`src/lib/news.js:248`)
- `match` TEXT NOT NULL DEFAULT `''` — gate evidence: `'domain' | 'name'` for auto (`src/lib/news.js:194-213`), `'submitted'` for user rows, `'manual'` for admin rows
- `submitted_by` INTEGER NULL ➡ FK `users(id)` ON DELETE SET NULL · `submitter_email`, `submitter_note`, `reviewed_by`, `reviewed_at` TEXT NOT NULL DEFAULT `''` · `created_at` (indexed), `updated_at`
- 🔑 partial unique `UNIQUE(listing_id, url) WHERE url <> ''` (`idx_news_dupe`) — duplicate links refused per listing

---

## 6 · Monetization

### `plans` — Pro plan offers (admin-managed)
- `id` INTEGER PK · `name` TEXT NOT NULL · `blurb` TEXT NOT NULL DEFAULT `''` · `price_cents` INTEGER NOT NULL · `currency` TEXT NOT NULL DEFAULT `'USD'` · `duration_days` INTEGER NOT NULL · `active` INTEGER NOT NULL DEFAULT `1` · `sort` INTEGER NOT NULL DEFAULT `0` · `created_at` (`src/lib/plans.js`)

### `payments` — payment ledger (Pro + advertising)
- `id` INTEGER PK · `user_id` ➡ FK `users(id)` CASCADE · `listing_id` INTEGER NULL ➡ FK `listings(id)` SET NULL (indexed)
- `plan_id` INTEGER NOT NULL DEFAULT `0` — ➡ **logical**: `plans(id)` when `kind='pro'`, `ad_packages(id)` when `kind='ad'` (no declared FK by design, `src/routes/billing.js:177-178`)
- `kind` TEXT NOT NULL DEFAULT `'pro'` — enum `'pro' | 'ad'` (`src/routes/billing.js:128-178`)
- `duration_days` INTEGER NOT NULL DEFAULT `30` · `order_id` TEXT NOT NULL DEFAULT `''` (PayPal order id)
- `reference` TEXT 🔑 NOT NULL (idempotency key) · `amount` INTEGER NOT NULL (cents) · `currency` TEXT NOT NULL DEFAULT `'USD'`
- `status` TEXT NOT NULL DEFAULT `'initialized'`, indexed — enum `'initialized' | 'success' | 'failed' | 'cancelled'` (`src/routes/billing.js:106-194`)
- `channel` TEXT NOT NULL DEFAULT `''` — `'paypal'` in practice (`src/routes/billing.js:195`)
- `email` TEXT NOT NULL DEFAULT `''` · `created_at` · `paid_at` TEXT NULL
- `promo_id` INTEGER NOT NULL DEFAULT `0` (➡ logical `promo_codes(id)`) · `discount_cents` INTEGER NOT NULL DEFAULT `0` (`src/lib/promos.js`)

### `promo_codes` — discount codes
- `id` INTEGER PK · `code` TEXT 🔑 NOT NULL · `percent` INTEGER NOT NULL DEFAULT `0`
- `plan_id` INTEGER NOT NULL DEFAULT `0` (➡ logical `plans(id)`; `0` = any plan)
- `max_uses` INTEGER NOT NULL DEFAULT `0` (`0` = unlimited) · `used_count` INTEGER NOT NULL DEFAULT `0` — 📊 **derived counter**, incremented on redemption (`src/lib/promos.js:53`)
- `expires_at` TEXT NOT NULL DEFAULT `''` · `active` INTEGER NOT NULL DEFAULT `1` · `note` TEXT NOT NULL DEFAULT `''` · `created_at`

### `promo_redemptions` — one row per (code, user)
- `id` INTEGER PK · `promo_id` ➡ FK `promo_codes(id)` CASCADE · `user_id` ➡ FK `users(id)` CASCADE · 🔑 `UNIQUE(promo_id, user_id)` · `payment_id` INTEGER NULL (➡ logical `payments(id)`, no declared FK) · `created_at`

### `ad_packages` — sponsored-placement packages (admin-managed)
- Same shape as `plans`: `id`, `name`, `blurb`, `price_cents`, `currency`, `duration_days`, `active`, `sort`, `created_at` (`src/lib/advertising.js`)

---

## 7 · Messaging & support

### `notifications` — in-app inbox (members + console)
- `id` INTEGER PK · `user_id` INTEGER NULL ➡ FK `users(id)` CASCADE (NULL for console-wide rows)
- `audience` TEXT NOT NULL DEFAULT `'user'` — enum `'user' | 'admin'`, validated on insert (`src/lib/notify.js:11-18`)
- `title`, `body`, `url` TEXT NOT NULL DEFAULT `''`
- `kind` TEXT NOT NULL DEFAULT `'info'` — 16 live values, all verified in use: `info | account | advertising | billing | claim | lead | lead_digest | listing | moderate | pro | removal | settings | status | system | ticket | watchlist` (`src/lib/notify.js`, `src/lib/leadsdigest.js`, routes)
- `read_at` TEXT NOT NULL DEFAULT `''` (`''` = unread) · `created_at`
- `archived_at`, `deleted_at`, `archive_expires_at` DATETIME NULL — archive/trash lifecycle (`migrations/2026-09-01-notifications-archive.sql`, `purgeExpired` in `src/lib/notifications.js`)
- Indexes: `(audience, user_id, read_at)`, `(audience, created_at DESC)`, `(archive_expires_at)`, `(deleted_at)`

### `newsletter_subscribers` — weekly-digest recipients
- `id` INTEGER PK · `email` TEXT 🔑 NOT NULL · `source` TEXT NOT NULL DEFAULT `'footer'` · `token` TEXT NOT NULL DEFAULT `''` (one-click unsubscribe) · `active` INTEGER NOT NULL DEFAULT `1` · `created_at` (`src/lib/newsletter.js`)

### `smtp_accounts` — admin-configured mail hops (failover chain)
- `id` INTEGER PK · `provider` TEXT NOT NULL DEFAULT `'custom'` — enum of 11 presets: `zoho | zoho_pro | brevo | mailtrap | smtp2go | resend | ahasend | smtpfast | forwardemail | dnsexit | custom` (`src/lib/mailer.js:31-43`)
- `label`, `host`, `username`, `password` TEXT NOT NULL DEFAULT `''` · `port` INTEGER NOT NULL DEFAULT `587` · `secure` INTEGER NOT NULL DEFAULT `0`
- `daily_limit` INTEGER NOT NULL DEFAULT `0` (`0` = unlimited) · `sent_today` INTEGER NOT NULL DEFAULT `0` + `sent_on` TEXT — 📊 **derived daily counter**, reset when the day rolls (`src/lib/mailer.js:291-323`)
- `active` INTEGER NOT NULL DEFAULT `1` · `sort` INTEGER NOT NULL DEFAULT `0` · `last_error`, `last_error_at`, `last_ok_at` TEXT NOT NULL DEFAULT `''` · `created_at`

### `admin_mail_log` — console-sent mail audit
- `id` INTEGER PK · `to_email`, `subject`, `body` TEXT NOT NULL DEFAULT `''` · `delivered` INTEGER NOT NULL DEFAULT `0` · `created_at` (indexed DESC)

### `tickets` — support threads
- `id` INTEGER PK · `ref` TEXT 🔑 NOT NULL · `user_id` ➡ FK `users(id)` CASCADE · `subject` TEXT NOT NULL
- `category` TEXT NOT NULL DEFAULT `'general'` — accepted set `billing | technical | listing | account | verification | other`, anything else stored as `'general'` (`src/lib/support.js:11,63`)
- `status` TEXT NOT NULL DEFAULT `'open'` — enum `'open' | 'solved' | 'closed'` (`src/lib/aitools-admin.js:523-526`)
- `admin_seen_at`, `closed_at` TEXT NOT NULL DEFAULT `''` · `created_at`, `updated_at` (`src/lib/support.js`)

### `ticket_messages` — replies within a thread
- `id` INTEGER PK · `ticket_id` ➡ FK `tickets(id)` CASCADE, indexed `(ticket_id, id)`
- `sender` TEXT NOT NULL — enum `'user' | 'admin'` (`src/lib/support.js:81,117-120`)
- `body`, `attachment`, `attachment_name` TEXT NOT NULL DEFAULT `''` · `created_at`

---

## 8 · API platform

### `api_keys` — Pro member keys (hash only persisted)
- `id` INTEGER PK · `user_id` ➡ FK `users(id)` CASCADE (indexed)
- `label` TEXT NOT NULL DEFAULT `''` · `prefix` TEXT NOT NULL (`'fl_live_'` + fingerprint) · `key_hash` TEXT 🔑 NOT NULL (SHA-256; raw key shown once, max 3 active keys/user)
- `scopes` TEXT NOT NULL DEFAULT `'…5 scopes…'` — JSON array; live vocabulary (validated, `src/lib/apikeys.js:14-22`): `read:listings | write:listings | export | manage:webhooks | read:usage`. Note: `migrations/2026-09-04-api-platform.sql` still names a `read:relationships` scope in its historical default string — it is **not** in the boot schema default and not accepted by the code.
- `total_requests`, `write_requests` INTEGER NOT NULL DEFAULT `0` — 📊 **derived counters**
- `created_at` · `last_used_at`, `revoked_at` TEXT NULL (non-NULL `revoked_at` = revoked)

### `api_usage_daily` 📊 — durable per-key day rollups
- 🔑 PK `(key_id, day)` · `key_id` ➡ FK `api_keys(id)` CASCADE
- `day` TEXT (`YYYY-MM-DD`) · `requests`, `writes` INTEGER NOT NULL DEFAULT `0`, indexed `(day, key_id)` (`src/lib/apilimit.js`)

### `api_usage_endpoint_daily` 📊 — per-key × day × method × endpoint rollups
- 🔑 PK `(key_id, day, method, endpoint)` · `key_id` ➡ FK `api_keys(id)` CASCADE · `requests`, `writes` INTEGER NOT NULL DEFAULT `0`, indexed `(day, key_id)` (`src/lib/apilimit.js`)

### `api_webhooks` — event subscriptions (max 10/user)
- `id` INTEGER PK · `user_id` ➡ FK `users(id)` CASCADE, indexed `(user_id, active)`
- `label` TEXT NOT NULL DEFAULT `''` · `url` TEXT NOT NULL · 🔑 `UNIQUE(user_id, url)`
- `secret_prefix` TEXT (fingerprint) · `secret_ciphertext` TEXT (encrypted at rest) · `events` TEXT JSON — subset of `listing.approved | listing.rejected | listing.updated | listing.created | listing.deleted | claim.verified` (`src/lib/webhooks.js:16-24`) · `categories` TEXT JSON DEFAULT `'[]'`
- `active` INTEGER NOT NULL DEFAULT `1` · `failure_count` INTEGER NOT NULL DEFAULT `0` — 📊 derived; auto-disables after 10 consecutive failures (`MAX_ACTIVE_FAILURES`, `src/lib/webhooks.js:25`) · `last_error` TEXT · `last_delivery_at`, `last_success_at`, `disabled_at` TEXT NULL · `created_at`, `updated_at`

### `api_webhook_deliveries` — signed delivery attempts with retry queue
- `id` INTEGER PK · `webhook_id` ➡ FK `api_webhooks(id)` CASCADE (indexed with `created_at DESC`) · 🔑 `UNIQUE(webhook_id, event_id)` (exactly-once queueing per event)
- `event_id`, `event_type` TEXT NOT NULL · `payload` TEXT NOT NULL (JSON)
- `status` TEXT NOT NULL DEFAULT `'pending'` — enum `'pending' | 'succeeded' | 'failed'` (`src/lib/webhooks.js:290-421`); queue index `(status, next_attempt_at)`
- `attempts` INTEGER NOT NULL DEFAULT `0` · `next_attempt_at` TEXT NULL (backoff) · `response_status` INTEGER NOT NULL DEFAULT `0` · `response_body`, `error` TEXT NOT NULL DEFAULT `''` · `delivered_at` TEXT NULL · `created_at`, `updated_at`

---

## 9 · Status page

### `status_components` — monitored components
- `id` INTEGER PK · `name` TEXT NOT NULL · `slug` TEXT 🔑 NOT NULL · `description` TEXT NOT NULL DEFAULT `''`
- `status` TEXT NOT NULL DEFAULT `'operational'` — enum `operational | degraded | partial_outage | major_outage` (`src/lib/statusMonitor.js:30-35`)
- `display_order` INTEGER NOT NULL DEFAULT `0` · `created_at`, `updated_at`

### `component_status_history` 📊 — periodic status snapshots
- `id` INTEGER PK · `component_id` ➡ FK `status_components(id)` CASCADE, indexed `(component_id, checked_at)` · `status` TEXT NOT NULL (same 4-value enum) · `checked_at` TEXT NOT NULL DEFAULT now (`src/lib/statusMonitor.js`)

### `incidents` — incident records
- `id` INTEGER PK · `title` TEXT NOT NULL · `description` TEXT NOT NULL DEFAULT `''`
- `status` TEXT NOT NULL DEFAULT `'investigating'`, indexed — enum `investigating | identified | monitoring | resolved` (`src/lib/statusMonitor.js:51`)
- `severity` TEXT NOT NULL DEFAULT `'minor'` — enum `minor | major | critical` (`src/lib/statusMonitor.js:52`)
- `component_id` INTEGER NULL ➡ FK `status_components(id)` ON DELETE SET NULL (indexed) · `resolved_at` TEXT NULL · `created_at` (indexed DESC), `updated_at`

### `incident_updates` — timeline entries on an incident
- `id` INTEGER PK · `incident_id` ➡ FK `incidents(id)` CASCADE, indexed `(incident_id, id)` · `status` TEXT NOT NULL (incident-status enum at that moment) · `message` TEXT NOT NULL DEFAULT `''` · `created_at`

### `status_subscribers` — incident-update recipients
- `id` INTEGER PK · `email` TEXT 🔑 NOT NULL · `verified` INTEGER NOT NULL DEFAULT `1` · `verification_token` TEXT NOT NULL DEFAULT `''` · `subscribed_at` TEXT NOT NULL DEFAULT now (`src/routes/status.js`)

---

## 10 · Content & jobs

### `blog_posts` — CMS posts
- `id` INTEGER PK · `slug` TEXT 🔑 NOT NULL · `title` TEXT NOT NULL · `excerpt`, `body` TEXT NOT NULL DEFAULT `''`
- `status` TEXT NOT NULL DEFAULT `'draft'` — enum `'draft' | 'published'` (`src/routes/admin.
...[truncated 8318 chars]