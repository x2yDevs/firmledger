# FirmLedger — Server Resources & Hosting Guide

**Companion docs:** [README2.md](README2.md) (architecture & flows) · [ERD.md](ERD.md) (database)

This document explains **exactly what resources the site needs on one server**, what it
uses at runtime, and what it can optionally consume for production. FirmLedger is a
**single-process, self-contained Node.js application** — no external services are
required for it to boot, seed, and run fully.

---

## 1 · The single-process model

```
┌──────────────────────────────────────────────────────────────┐
│  Server (VPS / bare metal / PaaS)                            │
│                                                              │
│  node server.js                                              │
│    ├── Express app        → HTTP on PORT (default 3000)      │
│    ├── data/firmledger.db → SQLite in WAL mode (embedded)    │
│    ├── data/uploads/      → user files (logos, attachments)  │
│    └── data/backups/      → .firmledger backup/restore files │
└──────────────────────────────────────────────────────────────┘
```

**One process does everything.** No separate database server, background worker,
cron daemon, cache layer, or queue is needed. The database, file storage, and
background timers all live inside the same Node process. (Your existing SMTP and
PayPal integrations remain supported as purely optional external resources.)

---

## 2 · Runtime requirements

| Resource | Requirement | Verified |
|---|---|---|
| Node.js | **v18 or newer (v20+ recommended)** | `v20.20.2` |
| OS | Any Linux (Ubuntu/Debian/ AlmaLinux), macOS, or Windows Node host | — |
| RAM | **≥ 256 MB** (comfortable at 512 MB) | footprint grows with SQLite cache |
| CPU | **1 vCPU** is enough; 2+ for image resizing with `sharp` | — |
| Disk | **≥ 2 GB** (code + deps ≈ 200 MB; database and uploads grow over time) | `data/` starts at ~1.4 MB seeded |
| Network | One public URL, one open port | — |

---

## 3 · npm dependencies (locked, no native builder required for most)

```json
"bcryptjs": "^3.0.3",        // password hashing
"better-sqlite3": "^12.11.1", // embedded SQL database (prebuilt binaries)
"compression": "^1.8.1",     // gzip responses
"cookie-parser": "^1.4.7",   // session cookies
"ejs": "^6.0.1",             // server-side templates
"express": "^4.22.2",        // HTTP framework
"multer": "^2.2.0",          // file uploads
"nodemailer": "^9.0.5",      // SMTP delivery
"qrcode": "^1.5.4",          // admin 2FA QR generation
"sharp": "^0.35.3"           // image resizing for logos (prebuilt binaries)
```

All packages ship **prebuilt**; `npm install` on the target server requires no
Python/C++ toolchain in the common case. If `sharp` cannot find a prebuilt binary
for an unusual architecture, the app degrades gracefully — logos are stored
unresized (see `src/lib/upload.js` try/catch).

---

## 4 · What lives on disk (`data/`)

Everything mutable lives in one directory. **Back up `data/` and the site is fully portable.**

```
firmledger/
├── data/
│   ├── firmledger.db        ← SQLite database (WAL mode; deletes only with intent)
│   ├── firmledger.db-wal / -shm   ← WAL companion files (keep them together)
│   ├── outbox.log           ← email spool fallback when SMTP is not configured
│   └── uploads/
│       ├── logos/           ← listing logos (≤ 2 MB, auto-resized to 256×256)
│       └── support/         ← ticket attachments (≤ 8 MB)

  (.firmledger backups are generated on demand from Admin → Users and streamed as
  downloads — nothing accumulates on disk for them; import uploads a single JSON file.)
├── .env                     ← runtime secrets (never commit)
└── (all application code above is read-only at runtime)
```

Key properties:

- **SQLite is embedded** — the DB is a file beside the code. No `postgres`, `mysql`,
  or `mongodb` process, user, or port ever needed.
- **WAL mode** means safe concurrent reads while writes happen (sessions, digests,
  moderation). Always copy `firmledger.db` **and** `-wal`/`-shm` together (or use the
  built-in `.firmledger` backup which checkpoints cleanly).
- **Uploads are local files** — no object storage required. Point a volume at
  `data/uploads/` if you expect many attachments.

---

## 5 · Environment configuration (`.env` — loaded by `server.js`, zero dependencies)

The app ships with `.env.example`. Copy it to `.env` and change what you need —
**no restart-only-on-first-boot requirement; changes apply with a normal process restart.**

| Variable | Required | What it controls |
|---|:---:|---|
| `PORT` | — | HTTP listen port. **Default 3000.** The app binds `0.0.0.0` so your proxy or load balancer can reach it. |
| `BASE_URL` | ✅ for production | The absolute public URL, e.g. `https://firmledger.co.ke`. Used to build canonical links, unsubscribe URLs, verification links, and sitemap/og URLs. Set it exactly once. |
| `ADMIN_SECRET` | ✅ | Secret code for the `/admin3119Musa` gate. **Change before going live.** This is compared with a timing-safe equality check. |
| `SMTP_URL` | — | Full SMTP connection string: `smtps://user:pass@smtp.provider.com` (implicit TLS) or `smtp://…:587` (STARTTLS). If left blank → emails are written to `data/outbox.log` instead of a live inbox. |
| `MAIL_FROM` | — | Envelope/display From address when `SMTP_URL` is used, e.g. `FirmLedger <no-reply@yourdomain.com>`. |
| `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_USER`, `MAIL_PASS` | — | Alternative discrete SMTP knobs. Same effect as `SMTP_URL` (checked only when `SMTP_URL` is unset). |
| `PAYPAL_CLIENT_ID` | — | PayPal REST app client ID. Leave blank and paste credentials in `Admin → Settings` instead. |
| `PAYPAL_CLIENT_SECRET` | — | PayPal REST app secret. |
| `PAYPAL_MODE` | — | `sandbox` (default, nothing is charged) or `live`. |

The app binds `0.0.0.0`: any host that can reach the machine's IP can reach the site.
**Put an HTTPS-terminating reverse proxy in front (Nginx/Caddy/Cloudflare) and set
`BASE_URL` to the public https URL** so generated links (unsubscribe, verification,
sitemap) are correct.

---

## 6 · Outbound resources the app *can* use (all optional, all graceful if absent)

These are **live-third-party** resources the code detects at runtime and uses when
configured:

| External | Env / admin setting | What it buys | Fails safe |
|---|---|---|---|
| **SMTP relay** (Zoho, Gmail app pass, Resend, any host+port+auth) | `SMTP_URL` or Admin → Settings | Real branded emails: welcome, digests, receipts, moderation | Writes to `data/outbox.log`, zero errors |
| **PayPal REST** | `PAYPAL_CLIENT_ID/...` | Live Pro checkout & capture at `/pricing` | Pricing page shows "payments not configured" |
| **IndexNow** | Auto-managed key (Admin → Settings) | Instant Bing/Yandex/DuckDuckGo submission on approve/claim | Logs an IndexNow error row, no user impact |

**Inbound only:** the public site, admin console, RSS feed, sitemap, and JSON API all
make **no outbound calls** at request time. Rendering stays fast even with no internet.

---

## 7 · Background timers inside the process (no system cron needed)

- **Weekly digest loop** — an hourly `setInterval` checks whether `newsletter_last_sent`
  (stored in the `settings` table) is > 6.5 days old, then sends the "new verified
  companies" email to all active subscribers. One boot-time timer at 90 s primes it.
  Optional: delete the interval and drive it from an external cron instead.

Everything else — image resizing, email sends, captures — happens synchronously on
the request that triggered it.

---

## 8 · Resource footprint (what the site actually consumes)

| Layer | Fresh install | Working site (~100 listings / 500 users) |
|---|---|---|
| App + node_modules on disk | ~200 MB | ~200 MB |
| Database (SQLite) | ~1 MB | 20–200 MB |
| `data/uploads/` | empty | 50 MB – 5 GB (logos + ticket files) |
| Peak memory | ~150 MB Node heap + SQLite cache | ~300–500 MB |
| CPU per request | near-zero for page reads | "listing auto-fill" runs remote image/HTML fetches — the heaviest task |

Logging: `console.log` to stdout (redirect to a file via systemd or `node server.js >
/var/log/firmledger.log 2>&1`).

---

## 9 · Recommended minimal hosting layouts

**A. Single VPS (simplest, fully supported):**

```
$ apt install nodejs npm
$ git clone <repo> firmledger && cd firmledger
$ npm ci
$ cp .env.example .env && nano .env   # set PORT / BASE_URL / ADMIN_SECRET / SMTP_URL
$ npm start
# → http://server-ip:3000
```

**B. Production with reverse proxy + process manager:**

```
[ Internet ] → [ Nginx/Caddy :443 HTTPS ] → [ node server.js :3000 ]
                                                   ↑ pm2 / systemd with
                                                   Restart=always
```

Generate a free TLS cert via Caddy or Let's Encrypt. Set `BASE_URL=https://yourdomain`.

**C. PaaS (Railway / Render / Fly / Heroku):** build = `npm ci`, start = `npm start`, attach a persistent volume for `data/` and the app bootstraps itself. Set env vars in the dashboard.

---

## 10 · Operator security checklist (resources to protect)

- [ ] Change `ADMIN_SECRET` from the default.
- [ ] Set a real `BASE_URL` (HTTPS).
- [ ] Point SMTP at a reputable relay; verify with **Admin → Settings → Send test mail**.
- [ ] Run behind HTTPS; the app only signs session cookies and issues TOTP recovery
      codes — transport is your responsibility.
- [ ] Back up `data/` (or use Admin → Users → **Full backup (.firmledger)**).
- [ ] Keep raw uploads out of backups stored off-server if not needed — files under
      `data/uploads/` are served publicly at `/uploads/*` (immutable 30-day cache), so
      any submitted attachment is publicly addressable by URL.

---

*Everything documented here reflects the current codebase exactly — no server
resource is required to keep the site running beyond Node ≥18, the `data/` folder,
and one port.*
