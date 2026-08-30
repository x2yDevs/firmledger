# FirmLedger database — entity relationship reference

Generated 2026-08-28 from the live SQLite schema (`data/firmledger.db`). SVG companion: **ERD.svg**.

## Tables

| Table | Columns | Foreign keys | Notes |
|---|---|---|---|
| **users** | `id` INTEGER PK<br>`email` TEXT<br>`password_hash` TEXT<br>`name` TEXT<br>`role` TEXT<br>`created_at` TEXT<br>`suspended` INTEGER<br>`plan` TEXT<br>`plan_expires_at` TEXT | — | unique: email |
| **user_totp** | `user_id` INTEGER PK<br>`secret` TEXT<br>`pending_secret` TEXT<br>`recovery_codes` TEXT<br>`enabled` INTEGER<br>`enabled_at` TEXT | `user_id → users.id` |  |
| **sessions** | `token` TEXT PK<br>`user_id` INTEGER<br>`csrf` TEXT<br>`kind` TEXT<br>`expires_at` TEXT<br>`created_at` TEXT | `user_id → users.id` |  |
| **reg_otps** | `id` INTEGER PK<br>`email` TEXT<br>`name` TEXT<br>`password_hash` TEXT<br>`code` TEXT<br>`expires_at` TEXT<br>`attempts` INTEGER<br>`created_at` TEXT<br>`newsletter` INTEGER | — |  |
| **resets** | `token` TEXT PK<br>`email` TEXT<br>`expires_at` TEXT | — |  |
| **plans** | `id` INTEGER PK<br>`name` TEXT<br>`blurb` TEXT<br>`price_cents` INTEGER<br>`currency` TEXT<br>`duration_days` INTEGER<br>`active` INTEGER<br>`sort` INTEGER<br>`created_at` TEXT | — |  |
| **payments** | `id` INTEGER PK<br>`listing_id` INTEGER<br>`user_id` INTEGER<br>`plan_id` INTEGER<br>`duration_days` INTEGER<br>`order_id` TEXT<br>`reference` TEXT<br>`amount` INTEGER<br>`currency` TEXT<br>`status` TEXT<br>`channel` TEXT<br>`email` TEXT<br>`created_at` TEXT<br>`paid_at` TEXT | `user_id → users.id`, `listing_id → listings.id` | unique: reference |
| **waitlist** | `id` INTEGER PK<br>`email` TEXT<br>`created_at` TEXT | — |  |
| **listings** | `id` INTEGER PK<br>`slug` TEXT<br>`name` TEXT<br>`tagline` TEXT<br>`description` TEXT<br>`type` TEXT<br>`category` TEXT<br>`website` TEXT<br>`email` TEXT<br>`phone` TEXT<br>`country` TEXT<br>`city` TEXT<br>`region` TEXT<br>`address` TEXT<br>`logo_url` TEXT<br>`founded` TEXT<br>`size` TEXT<br>`tags` TEXT<br>`socials` TEXT<br>`sources` TEXT<br>`status` TEXT<br>`featured` INTEGER<br>`claimed` INTEGER<br>`confidence` INTEGER<br>`owner_user_id` INTEGER<br>`last_verified_at` TEXT<br>`created_at` TEXT<br>`updated_at` TEXT<br>`tech` TEXT<br>`tech_checked_at` TEXT<br>`hiring_url` TEXT<br>`plan` TEXT<br>`plan_expires_at` TEXT | `owner_user_id → users.id` | unique: slug |
| **listing_events** | `id` INTEGER PK<br>`listing_id` INTEGER<br>`event_date` TEXT<br>`kind` TEXT<br>`title` TEXT | `listing_id → listings.id` |  |
| **claims** | `id` INTEGER PK<br>`listing_id` INTEGER<br>`user_id` INTEGER<br>`method` TEXT<br>`token` TEXT<br>`domain` TEXT<br>`status` TEXT<br>`created_at` TEXT<br>`verified_at` TEXT | `user_id → users.id`, `listing_id → listings.id` |  |
| **favorites** 🆕 | `id` INTEGER PK<br>`user_id` INTEGER<br>`listing_id` INTEGER<br>`created_at` TEXT | `listing_id → listings.id`, `user_id → users.id` | Watchlist — `(user_id, listing_id)` is unique so a company can only be starred once. Joins users × listings. |
| **jobs** 🆕 | `id` INTEGER PK<br>`listing_id` INTEGER<br>`owner_user_id` INTEGER<br>`title` TEXT<br>`role_type` TEXT<br>`location` TEXT<br>`apply_url` TEXT<br>`description` TEXT<br>`featured` INTEGER<br>`status` TEXT<br>`created_at` TEXT | `owner_user_id → users.id`, `listing_id → listings.id` | Owner-posted openings; at most 5 open per listing; `featured=1` while listing Pro perks are active; shown on the listing page and /jobs. |
| **tickets** | `id` INTEGER PK<br>`ref` TEXT<br>`user_id` INTEGER<br>`subject` TEXT<br>`category` TEXT<br>`status` TEXT<br>`admin_seen_at` TEXT<br>`created_at` TEXT<br>`closed_at` TEXT<br>`updated_at` TEXT | `user_id → users.id` | unique: ref |
| **ticket_messages** | `id` INTEGER PK<br>`ticket_id` INTEGER<br>`sender` TEXT<br>`body` TEXT<br>`attachment` TEXT<br>`attachment_name` TEXT<br>`created_at` TEXT | `ticket_id → tickets.id` |  |
| **blog_posts** | `id` INTEGER PK<br>`slug` TEXT<br>`title` TEXT<br>`excerpt` TEXT<br>`body` TEXT<br>`status` TEXT<br>`created_at` TEXT<br>`updated_at` TEXT<br>`published_at` TEXT | — | unique: slug |
| **newsletter_subscribers** 🆕 | `id` INTEGER PK<br>`email` TEXT<br>`source` TEXT<br>`token` TEXT<br>`active` INTEGER<br>`created_at` TEXT | — | Visitors opt in via the footer band or the register tickbox; `token` powers one-click unsubscribe, `active=0` means unsubscribed. |
| **categories** | `id` INTEGER PK<br>`name` TEXT<br>`slug` TEXT<br>`official` INTEGER<br>`created_at` TEXT | — | unique: slug |
| **settings** | `key` TEXT PK<br>`value` TEXT | — |  |
| **removal_requests** | `id` INTEGER PK<br>`listing_id` INTEGER<br>`name` TEXT<br>`email` TEXT<br>`reason` TEXT<br>`status` TEXT<br>`created_at` TEXT<br>`resolved_at` TEXT | `listing_id → listings.id` |  |
| **admin_mail_log** | `id` INTEGER PK<br>`to_email` TEXT<br>`subject` TEXT<br>`body` TEXT<br>`delivered` INTEGER<br>`created_at` TEXT | — |  |
| **relationships** | `id` INTEGER PK<br>`listing_id` INTEGER<br>`rel_type` TEXT<br>`target_listing_id` INTEGER<br>`target_name` TEXT<br>`note` TEXT<br>`created_at` TEXT | `target_listing_id → listings.id`, `listing_id → listings.id` |  |

## Relationships

- **claims**.user_id → **users**.id
- **claims**.listing_id → **listings**.id
- **favorites**.listing_id → **listings**.id
- **favorites**.user_id → **users**.id
- **jobs**.owner_user_id → **users**.id
- **jobs**.listing_id → **listings**.id
- **listing_events**.listing_id → **listings**.id
- **listings**.owner_user_id → **users**.id
- **payments**.user_id → **users**.id
- **payments**.listing_id → **listings**.id
- **relationships**.target_listing_id → **listings**.id
- **relationships**.listing_id → **listings**.id
- **removal_requests**.listing_id → **listings**.id
- **sessions**.user_id → **users**.id
- **ticket_messages**.ticket_id → **tickets**.id
- **tickets**.user_id → **users**.id
- **user_totp**.user_id → **users**.id

## Round-20 highlights

- `newsletter_subscribers` — weekly "New verified companies" digest; sent automatically (hourly check, 6.5-day window) or on demand from Admin → Settings.
- `favorites` — watchlist; triggers instant branded digest emails when a watched listing's record materially changes.
- `jobs` — Pro-owner job posts; featured on the listing page and the public `/jobs` board with JSON-LD schema markup.