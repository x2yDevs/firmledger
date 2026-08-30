# FirmLedger — Architecture & Flow Guide

> **README2** — serves as the engineering map of the whole app. It explains how the
> frontend and backend connect, walk-throughs of every feature flow end-to-end,
> the role of every file and the project layout.

---

## 1 · Tower-of-power overview

FirmLedger is a single-service Node.js application (Express 4) that server-renders
EJS views backed by SQLite (bundled `better-sqlite3`, no external DB to run).
It's monolith-by-design: every page, admin console, auth flow, mail composer,
verification script and payment hook lives in this one process so a clone of this
zip boots a full production-grade instance out of raw SQLite files.

```
        BROWSER                                    SERVER
+--------------------------------------------------------------+
        │                                   │
        ├── GET  /directory/… ──────────►   │ Express router (server.js)
        │                                    │     ↓ session.attach + csrfProtect
        │                                    │     ↓ route handlers in src/routes/
        │                                    │     ↓ db queries (src/db.js)
        │                                    │     ↓ res.render('views/…')
        │ ◄────── rendered HTML ───────     │
        │                                    │
        ├── POST form (with _csrf) ───►     │ same pipeline, route does the write
        │                                    │
        ├── upload file (multipart) ───►    │ multer (logos / support / backup files)
        │                                    │
        ├── GET /…/poll JSON prompt ──►     │ live-chat refresh (tickets) — same session check
        │                                    │
    STATIC ASSETS (public/css, js, images, favicon)
    UPLOADS mounted at /uploads (logos, support attachments)
```

---

## 2 · Project layout

```
firmledger/
├── server.js                    ← boot, security headers, static, session, CSRF, locals, routes
├── package.json
├── .env / .env.example          ← base URL, admin gate code, PayPal, SMTP, IndexNow
├── README.md / README2.md / ERD.svg / ERD.md
│
├── data/                        ← RUNTIME state, git-ignored, re-seeded on first boot
│   ├── firmledger.db*           ← SQLite (WAL) holding every table
│   ├── outbox.log               ← emails when no SMTP configured (dev fallback)
│   └── uploads/
│        ├── logos/              ← 256×256 normalized business logos
│        └── support/            ← support-chat attachments (≤ 8 MB)
│
├── public/
│   ├── css/app.css              ← ONE stylesheet — design tokens, cards, chat, admin, forms
│   ├── js/main.js               ← UI sprinkles (menu, copy-to-clipboard, pw-eye, pw-meter, dup-check)
│   └── assets/                  ← logo SVG, favicon, OG card
│
├── views/                       ← every page is EJS; each starts with partials/top and ends with partials/bottom
│   ├── partials/
│   │   ├── top.ejs              ← page head + util-bar + site header + search + hero + flash
│   │   ├── bottom.ejs           ← footer + global scripts
│   │   ├── adminnav.ejs         ← the admin tab bar (Overview … Settings + Tickets + Search)
│   │   └── relations.ejs        ← related-companies panel on a listing page
│   ├── home.ejs                  search results, claim directory, listing page, claim verification, API, docs, pricing
│   ├── auth/                     login, register (+password eye/meter), verify (OTP screen), forgot, reset
│   ├── dashboard/                user area: index (listings + account + security/support cards), form, upgrade,
│   │                             security (2FA enroll + recovery codes), support*.ejs (tickets + WhatsApp-style thread)
│   └── admin/                    gate, 2fa, 2fa-setup, 2fa-recovery, dashboard, listings, edit, categories, claims,
│                                 users (+backup grid), user-detail, plans, removals, email, settings, blog, tickets,
│                                 ticket-thread, new-listing
│
└── src/
    ├── db.js                     ← schema for EVERY table + migrations (ALTER TABLE wrapped in try/catch)
    │
    ├── lib/                      ← shared server logic
    │   ├── session.js            ← cookies (fl_session user / fl_admin), createSession, requireUser/Admin, CSRF
    │   ├── passwords.js          ← bcrypt hash/verify
    │   ├── totp.js               ← TOTP (secret generation, code, verify, otpAuthUrl)
    │   ├── user2fa.js            ← user account 2FA: enroll, recovery-code hash/burn, sensitive-action gate
    │   ├── backup.js             ← .firmledger export/backup/import + admin recovery codes + cascade user delete
    │   ├── mailer.js             ← branded HTML email composer; SMTP via nodemailer; outbox fallback; test-email
    │   ├── support.js            ← tickets: multer upload, open/reply with attachments, status transitions
    │   ├── util.js               ← fmtDate, siteUrl, slugify, escHtml, URLs, confidence score, site score
    │   ├── taxonomy.js           ← TYPES, SIZES, COUNTRIES, sizeMap…
    │   ├── categories.js         ← 20 official categories seeded on first boot
    │   ├── enrich.js             ← Wikipedia / Wikidata live enrichment + HTML meta enrichment (site badge path)
    │   ├── verify.js             ← DNS TXT / meta-tag / site-badge verification workers + status recorder
    │   ├── graph.js              ← relationships/ founders/ subsidiaries/ products/ services edge builder
    │   ├── socialicons.js        ← inline SVG map for the 9 social types
    │   ├── upload.js             ← logo uploads: multer disk, type/size validate, sharp normalize to 256×256 PNG
    │   ├── plans.js              ← Pro plan math: perksActive(l, u), isProUser, expiry enforcement
    │   ├── paypal.js             ← order create/capture/upgrade flows against PayPal sandbox/live
    │   ├── indexing.js           ← IndexNow submissions on new/updated listings
    │   ├── notify.js             ← in-app notifications (user + admin bells); unread = empty read_at
    │   ├── claimflow.js          ← claim finalization: owner moves, submitter stays, both emailed
    │   └── newsletter.js         ← digest, watchlist (in-app), jobs board
    │
    └── routes/
        ├── public.js             ← home, directory, listing page, search, sitemaps, RSS, blog, legal, API docs, 404
        ├── auth.js               ← register (+ OTP verify/resend), login, logout, forgot/reset password flows
        ├── claim.js              ← claim wizard, various verification methods (DNS/meta/badge), auto-approve
        ├── dashboard.js          ← the whole user cockpit (listings CRUD + evets + relations + delete + plan + IAP +
        │                          support tickets + 2FA + security + upgrade + account + password)
        ├── admin.js              ← the whole admin console (2FA + gate + listings + users (+backup) + claims +
        │                          categories + plans + removals + email + settings + blog + tickets)
        ├── api.js                ← JSON API keys + read endpoints (listings/detail/search/categories/countries)
        └── blog.js               ← blog viewer + admin CRUD routes split cleanly
```

---

## 3 · The request lifecycle (every page)

1. **Static try** — `express.static` serves `/public` directly (7-day cache, versioned via `ASSET_V`).
2. **Uploads** — `/uploads` serves files in `data/uploads` (30-day immutable).
3. **`session.attach`** — loads/creates a session. Two cookies:
   - `fl_session` → `sessions` table row `kind='user'`
   - `fl_admin` → `sessions` row `kind='admin'` (not present during the 2FA gate)
   It refreshes `user + sessions` into `req`, and exposes `csrfToken` for res.locals.
4. **`csrfProtect`** — blocks POSTs missing/mismatching the session-bound `_csrf`, except:
   - multipart uploads (runs multer first; routes then re-check via `validCsrf(req)`)
   - unauthenticated forms (registration/login/waitlist) — they hold no privilege
5. **`app.use((req,res) => {res.locals …})`** in `server.js` — exposes `SITE`, `fmtDate`,
   `ICONS`, `nav`, `initials`, `ICONS`, `perksActive`, `isProUser`, `SITE_SOCIALS` to every view.
6. **Route handlers** in `src/routes/` do their query + `res.render(view, …)`.
7. **Views** open with `<%- include('partials/top') %>` (last part: `main#main`), end with `partials/bottom`.

---

## 4 · Feature flows end-to-end

### 4.1 Register with OTP
```
POST /register
  ↑ validate name/email/password (must confirm, ≥ 8 chars, no dupe)
  → reg_otps row : email, name, bcrypt(password), 6-digit code, expires=now+15min
  → sendBranded(email, 'NNNNNN is your FirmLedger verification code', {otp: code})
  → 302 /register/verify?email=
GET /register/verify → renders code input (15-min note + resend form)
POST /register/verify
  → fetch latest reg_otps row
  → expired? delete row, 401 → tell user to resend
  → attempts ≥ 6? tell user to resend
  → wrong code? attempts++, 401
  → correct, email still free? inside a transaction: DELETE all reg_otps + INSERT user
  → createSession(user) + cookie + welcome email
  → 302 /dashboard?ok=Email verified…
POST /register/verify/resend → new 6-digit code with fresh 15-min expiry
```
*No user row exists until the code is confirmed—this blocks account creation on someone else’s email.*

### 4.2 Claiming a listing (3 verification methods)

`src/routes/claim.js` + `src/lib/verify.js`:

| Method | Ceremonial step | Worker |
|---|---|---|
| DNS TXT | claim page issues a unique `fl-verify=…` TXT record for the seller's domain | `verifyDns(domain, token)` — dig TXT for `fl-verify=$token` |
| Meta tag | same claim page but an `<meta name="firmledger-verify" content="…">` on `/` | `verifyMeta(url, token)` — fetch home page, regex the `<head>` for `<meta name="firmledger-verify" content="$token">` |
| Site badge | inline HTML badge (single-line `<div id="firmledger-badge" …>`) anywhere on homepage | `verifyBadge(url, token)` — fetch homepage DOM, look for the badge |

All three write a `claims` row `status='verified'` on success via `src/lib/claimflow.js`, which:

1. sets the listing `claimed=1, owner_user_id=<claimant>, last_verified_at=now, confidence+=13` — `submitter_user_id` is **not** moved,
2. listing-scoped Pro (`listings.plan`) stays on the record; account-scoped Pro never travels,
3. emails **both** the new owner and the previous submitter (sensitive ownership change),
4. previous submitter loses dashboard access; they can request admin to move remaining listing-Pro onto another listing they still own.

### 4.3 Edit an existing listing → back into moderation

In `dashboard.js`, `POST /dashboard/listings/:id/edit`:

```javascript
const needsReview = l.status === 'approved' || l.status === 'rejected';
// … then UPDATE listings SET … status = needsReview ? 'pending' : l.status
```

- The edit is applied **immediately to the pending copy** (owner sees it instantly),
- it shows to admins as `Pending` in `/admin3119Musa/listings`,
- **Accept** (approve button) re-publishes + emails the owner ("approved and pushed to search engines"), IndexNow bundled again,
- **Deny** (reject button) marks it `rejected` + emails the owner,
- rejected listings can be edited again — this sweetens the loop.

### 4.4 User 2FA + recovery codes (account-level)

`src/lib/user2fa.js`:

- Enroll: `startEnrollment(userId)` stores a pending secret → the security
  card draws a QR via `qrcode` package → `verifyTotp(pending_secret)` → 10 recovery codes →
  `recovery_codes` column = JSON array of `{h: sha256(code), used:0}` → page shows
  the 10 codes exactly once → **Download as `firmledger-recovery-codes.txt`** (CSRF-approved POST).
- Gate: `verifySensitive(userId, code)` — accepts a fresh 6-digit TOTP **or** a not-yet-used
  recovery code (hashes, burns the code on success, returns `{recovery:true, remaining}`).
- Applied on routes: `/dashboard/password`, `/dashboard/account` (email change), and disabling 2FA itself.

### 4.5 Admin console entry

`src/routes/admin.js` gate chain:

1. `POST /admin3119Musa {code: <ADMIN_GATE_CODE>}` → sets `fl_admin2fa` pending session cookie (10 min).
2. `/admin3119Musa/2fa-setup` (first-ever boot) — generates a fresh TOTP, shows QR + manual key.
   On correct code: sets `admin_totp_secret`, generates **10 admin recovery codes** (`admin_recovery_codes`),
   issues the real `fl_admin` session, and shows the one-time recovery page with a `.txt` download.
3. `/admin3119Musa/2fa` — every other login. Accepts either the 6-digit app code **or** one
   unused recovery code (hash lookup, burn on success).
4. `router.use('/admin3119Musa', requireAdmin)` covers every further route.

### 4.6 Support tickets + live chat

`src/lib/support.js` (data) + `views/dashboard/support*.ejs` / `views/admin/tickets*.ejs`:

```
openTicket(uid, subject, cat, body, attachment) →
  tickets row (ref='FL-' + 6 hex) + first ticket_messages row → branded ack email
reply(ticketId, sender='user'|'admin', body, attachment) →
  insert message, touch updated_at, admin_seen_at=now if admin
setStatus(ticketId, 'open'|'solved'|'closed') →
  status + closed_at stamped
```

- Both sides poll `…/poll` JSON **every 4 s** comparing `updated_at`; mismatch → silently reload the thread.
- Tickets notify in-app (bell) on open, reply, solve, close. Hourly auto-close: solved > 7d → closed; open with last admin message unanswered > 14d → closed.
- Admin filters come from SQL predicates (`new` = open + never-seen, `unread` = open + admin_seen_at < latest user message, open / solved / closed, all) with per-filter counts and row-unread styling with a pulsing unread dot.
- Attachments: `multer` to `data/uploads/support`, type/size validated, shown as WhatsApp-style chips inside bubbles.

### 4.7 Export / import / backup / delete user

`src/lib/backup.js`:

```
GET /admin3119Musa/users/export.firmledger  → every user row (id, name, email, password_hash, plan, plan_expires_at, suspended, created_at) as aligned JSON
GET /admin3119Musa/users/backup.firmledger   → the same PLUS per-user {twofa, listings, claims, tickets, payments}
POST /admin3119Musa/users/import  (multipart) → importUsers(buffer): validates format header, merges by email (update existing, insert new with original hash so logins still work)
POST /admin3119Musa/users/:id/delete → deleteUserCascade: listings → owner NULL + claimed=0 (they stay on the ledger), kill sessions/tickets+messages/user_totp/claims/payments/waitlist/reg_otps/resets, then DELETE the account
```

`.firmledger` files carry a `format: firmledger-backup@1` header + metadata and are 2-space-printed so columns line up.

### 4.8 Mail — one pipeline, branded everywhere

`src/lib/mailer.js`:

- Resolves SMTP config from env then the Admin Settings page (settings table keys `smtp_host/port/user/pass/from`).
- Builds emails from a single `brandedHtml({kicker, title, alert{,Tone}, paragraphs, cta, otp, note})`.
- If nothing is configured it writes everything to `data/outbox.log` (dev mode) — no message is lost.
- `sendTest(to)` verifies the live transport (`transporter.verify()`), then sends the test email whose **"Open admin console"** CTA points at `{BASE_URL}/admin3119Musa/settings` via `siteUrl()`.

### 4.9 Listing submission / verification

`GET /dashboard/listings/new` ↛ `POST` validates (name/URL/dup) → optional Wikipedia
enrichment via `fetchSiteDetails` → `INSERT listings` → status `pending`.
Admin approves → `approved` + `claimed=1` if owner exists + IndexNow.
Admin asks for other bullets on `/admin3119Musa/listings/new` — admin-created listings
go straight live with 95 confidence.

### 4.11 Engagement — newsletter, watchlist & jobs (round 20)
```
src/lib/newsletter.js
  Newsletter   POST /newsletter/subscribe (footer band on every page, guests OK)
               → newsletter_subscribers (email UNIQUE, source, token, active)
               subscribe {isNew} → sendSubscribeWelcome() branded email + subscribe
               toast on the landing page (window.__flToast + ?nl= flash)
               register tickbox → reg_otps.newsletter → auto-subscribes on /register/verify
               GET /newsletter/unsubscribe?token=… → one-click opt-out
               sendWeeklyDigest() — hourly interval, fires when settings.newsletter_last_sent
               is >6.5 days old; subscribers get verified≤7d + fresh≤7d listings;
               Admin → Settings → "Send digest now" force-sends.
               Admin → Email → audience 'newsletter' (all active subs) ·
               'nl_guests' (subscribers without accounts).
  Prefs        GET /dashboard/settings (notification center — digest ON/OFF toggle)
               POST /dashboard/settings/digest (digest=1/0; ON re-sends welcome email)
  Icons        emojis removed from all UIs — inline <svg class="ric"> lucide-style
               icons (briefcase, lock, download, star, paperclip, envelope, ticket)

  Watchlist    POST /dashboard/watchlist/toggle (☆ Watch on any listing, login required)
               → favorites (UNIQUE(user_id,listing_id)) → /dashboard/watchlist (table)
               Pro: GET /dashboard/watchlist.csv → name/email/website/tech/… for CRM
               notifyWatchers() writes an in-app notification (not SMTP) when a watched listing
               changes (user edit diffs + tech-stack refresh).
  Jobs         GET/POST /dashboard/listings/:id/jobs (owner, Pro-gated, max 5 open)
               → jobs table → listing page "Open positions" panel + public /jobs board
               (FEATURED JOB pill, verified tick, JSON-LD CollectionPage)
```
### 4.10 Payments (Pro) — PayPal

`src/lib/paypal.js`: server-side order create + capture against the PayPal API,
plus `verifying the JWT-free payer_id + signature` pattern FirmLedger's interface uses today.
Plans seed in `plans` (30-day / monthly defaults exist to keep pricing real on first boot).

---

## 5 · Common knobs

| Env var / setting | Where | What it does |
|---|---|---|
| `BASE_URL` | `.env` | Canonical domain; used in every generated URL (emails, sitemap, feeds) |
| `ADMIN_GATE_CODE` | `.env` | First-factor gate code for the admin console |
| `SMTP_URL` or `MAIL_*` | `.env` / admin settings | Live mail transport; missing → `data/outbox.log` |
| `PAYPAL_*` | `.env` | PayPal keys + sandbox flag |
| `SESSION_SECRET` | server state | Signs both session cookie flavors |

| Cookie | Table | Purpose |
|---|---|---|
| `fl_session` | `sessions(kind='user')` | Logged-in member |
| `fl_admin` | `sessions(kind='admin')` | Unlocked admin console |
| `fl_admin2fa` | `sessions(kind='admin-pending')` | Waiting for authenticator/recovery code |

---

## 6 · Run / probe

```bash
npm install          # one step. Then:
node server.js       # seeds DB on first boot, serves http://0.0.0.0:3000
# admin: http://localhost:3000/admin3119Musa  gate → 2FA setup → 10 recovery codes
# register: http://localhost:3000/register    (email OTP, 15-min expiry)
# users:    /dashboard · /dashboard/security · /dashboard/support
# admin:    /admin3119Musa/users → Backup & export cards at the top
```

The database file (`data/firmledger.db`) plus `data/uploads/` are the only state to back
up in production; `.firmledger` files exist specifically for the users-table side of that.
