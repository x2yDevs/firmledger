# FirmLedger

**The business record layer for modern discovery.** Verified listings for companies, startups, agencies, organizations, products, services and publishers — with source transparency, confidence scores, ownership verification and a relationship graph.

Production site: **https://firmledger.co.ke**

Stack: Node.js + Express · EJS server-rendered views · SQLite (WAL) · no frontend build step.

---

## 1. Feature map

| Area | What it does |
|---|---|
| Directory | Search + filters (type, category, country, verified), sort, pagination, list/grid view toggle, name suggest (`/suggest.json`) |
| SEO landing pages | `/directory/c/<category>` and `/directory/c/<category>-in-<location>` — unique titles, JSON-LD `CollectionPage`+`ItemList`, breadcrumbs, `noindex` when empty, auto-sitemapped |
| Listing profiles | JSON-LD `Organization` + `FAQPage`, OG/Twitter cards, confidence meter, FirmLedger Score breakdown, key people + socials, ecosystem groups, technology radar + hiring signals, FAQs, competitors, related lists, removal requests |
| Wikipedia enrichment | One-click fetch resolves the real Wikipedia article + Wikidata entity — refuses to invent data when no genuine article exists |
| Duplicate protection | Name or website-domain match blocks a second record anywhere (user submission **and** admin add) and offers "Claim it now" instead |
| Relationship graph | founder, investor, parent, subsidiary, product, service, partner — radial SVG graph + ecosystem groups, managed by owners and admins |
| Verification | DNS TXT / HTML meta tag / homepage badge — live server-side checks, light & dark badge themes at `/badge/:slug.svg?theme=` |
| Accounts | Email + password (PBKDF2-SHA512 600k), sessions in SQLite, CSRF protection, throttling, account settings + password change with session rotation |
| Branded email notifications | **Sensitive** events still email the member a **FirmLedger-branded HTML mail** (outbox log in dev, real SMTP in prod): welcome, password reset, password/email/2FA changes, payment receipt, Pro granted/revoked, claim ownership transfer, account suspend/delete. Non-sensitive events (listing review, tickets, watchlist, digest of edits) land in the in-app notification bell instead |
| Dashboard | Own-listings table with scores + missing-field hints, plan column (Free/Pro), refresh-tech (stays on dashboard), searchable claim picker, request-removal for owned/submitted listings, in-app notifications, delete-my-account request |
| **FirmLedger Pro (account-scoped)** | One subscription unlocks **two things**. (1) **VIEWING**: every listing's full details — public website, email, phone, social links, events timeline, relationship graph. (2) **PERKS on listings you own**: blue verified tick on the company name (profile, search, directory, home), homepage Featured placement, premium (gold) embeddable company badge, priority admin verification & trust review. Guests and Free accounts see the basic profile only. Adding and editing listings is completely free — no paywalled fields. Time stacks; server verifies payments with PayPal before activating |
| Payments | PayPal REST Orders — credentials in Admin → Settings → Payments (or `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET`/`PAYPAL_MODE` env, which wins). Sandbox charges nothing. Server-side `/billing/callback` capture + verification (order id, exact amount, currency, reference) grants purchased time to the ACCOUNT, stacks on remaining time, emails a receipt, and writes to the `payments` ledger (dashboard + admin) |
| Plan offers | Admin-managed in **Admin console → Plan offers**: monthly, yearly, or any custom named offer, with price, duration in days, sort order, show/hide, and safe delete (deactivates when payments are attached). /pricing and /dashboard/upgrade render whatever is active |
| Pro grants | Admin can grant 30-day or lifetime Pro to any user, or revoke it, from **Admin → Users** (the grant emails the member). Admins can also boost a single listing record from Admin → Listings |
| Admin console | Hidden URL `/admin3119Musa` + secret code **+ TOTP two-factor** (QR enrollment) — global search, in-app inbox, listings search/filters + bulk approve/reject, full listing editor, add listing, categories, claims re-check (emails both claimant and previous submitter), removals, users (view/suspend/unsuspend/delete with email first, admin-initiated password reset), searchable email picker, blog CMS, settings, ticket auto-close, **Protection** (IP/domain lists + rate limits + maintenance mode), **Health** (disk, DB, memory, uptime, last backup), **Promos** |
| Promo codes | Admin generates codes such as `LAUNCH20` (percent off, usage cap, expiry, optional plan lock). Members apply them on Dashboard → Upgrade; PayPal is charged the discounted amount. Notify members by email and/or in-app when a code is created |
| Maintenance mode | Admin → Protection. Visitors see a branded “we’ll be back soon” page (HTTP 503); a signed-in admin keeps working. Optional email blast to account holders when turning it on |
| Spam protection | IP allow/block lists, email-domain allow/block (empty allow list = all domains), tunable rate limits on login, register, listings, claims, newsletter, search, scrape, and API RPM |
| Multi-SMTP failover | Same From address everywhere. Configure in `.env` (`SMTP_URL`, `SMTP2_URL`…) **and** Admin → Settings (Emitlo, Maileroo, Brevo, Mailjet, Mailtrap, SMTP2GO, Resend, AhaSend, SMTPfast, Forward Email, DNSExit, Zoho, custom). If a hop hits a sending limit the next hop is used automatically |
| Content | Blog (posts flow to footer News, RSS, sitemap), `/docs`, `/privacy`, `/terms`, global `/search` (listings + posts + docs) |
| Indexing | IndexNow push on approve/claim (+30 min re-ping) · sitemap index · robots.txt · RSS |

---

## 2. Run it locally (development quickstart)

Prerequisite: **Node.js 20+** (`node -v` to check). Everything else ships in the zip — there is no build step, no external database to install, no external services required.

```bash
# 1. Unpack
unzip firmledger.zip && cd firmledger

# 2. Install dependencies (express, ejs, better-sqlite3, cookie-parser, compression,
#    nodemailer, multer, sharp, qrcode — compiled once into node_modules/)
npm install

# 3. Environment — .env already contains a localhost-runnable default.
#    Only change if you want different values; nothing is required for local use.
#     PORT=3000
#     BASE_URL=http://localhost:3000        ← keep this for local
#     ADMIN_SECRET=fl-admin-9f27c4          ← local default, CHANGE for production

# 4. Start
npm start            # → FirmLedger running on http://0.0.0.0:3000
```

Open **http://localhost:3000**. On first boot the app creates `data/firmledger.db`, seeds the 20 official categories and three blog posts, and generates the IndexNow key — you'll see them all working immediately.

Local smoke tour:
- `/directory` — the ledger (empty on a fresh boot; add listings from **+ Add a listing** after registering a normal user account at `/register`)
- `/admin3119Musa` — the hidden admin console: enter the `ADMIN_SECRET` from `.env`, then **enroll two-factor** on the QR screen (scan with Google Authenticator / 1Password / Authy, or type the manual key; enter the 6-digit code shown)
- `/docs`, `/privacy`, `/terms`, `/blog`, `/search` — the built-in content

Stop with `Ctrl+C`. Data persists in `data/` between runs.

---

## 3. Go live for FREE — production + custom domain at $0/month

You can run FirmLedger in production, on `https://firmledger.co.ke`, without paying for hosting. What is genuinely free and what is not:

| Item | Cost |
|---|---|
| App hosting | **$0** — Oracle Cloud *Always Free* VM (recommended) or Render free web service (fastest) or Google Cloud always-free `e2-micro` |
| Database | **$0** — SQLite ships inside the app; no database server exists |
| HTTPS certificate | **$0** — Let's Encrypt via Caddy (VPS path) or automatic on Render |
| Custom domain DNS | **$0** — your registrar's DNS panel, or Cloudflare free plan |
| Outgoing email | **$0 to start** — Brevo free tier (300 emails/day), Mailjet free tier, or keep console outbox logging |
| **Domain name itself** | **Not free** — `firmledger.co.ke` is roughly KES 1,000–3,000/yr depending on registrar. This is the only unavoidable cost. |

**Pick your path:**

- **Path A — fastest (≈10 min, zero sysadmin):** Render free web service. Great for a demo or soft launch; read the disk warning inside.
- **Path B — best long-term free (a real server at $0 forever):** Oracle Cloud *Always Free* VM (4-core ARM, 24 GB RAM) or Google Cloud always-free `e2-micro`. Everything persists; then you follow **Section 4** for the app install.

---

### Path A — Render free web service (no server admin)

1. Create a free account at `render.com` (GitHub sign-in works).
2. Push this folder to a private GitHub repo (`git init && git add -A && git commit -m "FirmLedger"`, create the repo on GitHub, `git remote add origin … && git push -u origin main`). Private repos are free.
3. Render dashboard → **New → Web Service** → connect the repo. Settings:
   - **Runtime:** Node · **Build command:** `npm ci --omit=dev` · **Start command:** `node server.js`
   - **Instance type:** Free
4. **Environment** tab → add:
   - `BASE_URL` = `https://YOUR-SERVICE.onrender.com` (switch to your real domain later)
   - `ADMIN_SECRET` = a long random string
   - `SMTP_URL` / `MAIL_FROM` if you want real email (optional)
   - (`PORT` is injected by Render automatically — the app already reads `process.env.PORT` and binds `0.0.0.0`.)
5. Deploy. Open the `onrender.com` URL → boot → enroll admin 2FA exactly as in Section 2.

**Honest caveats of the free tier:**
- **Sleeps after ~15 min idle** — first request after sleep takes 30–60 s. Fine for early days; a free uptime monitor (UptimeRobot free tier) pinging `/` every 5 min keeps it warm.
- **Ephemeral disk — `data/` resets on every redeploy/restart.** Categories and seed blog posts re-create themselves on boot, but **listings, uploads and users do not**. Mitigate before you collect real data: schedule a daily off-box copy of `data/` (e.g. free Backblaze B2 10 GB via `rclone` in a cron), or move to Path B once you have real listings. There is no free Render tier with a persistent disk.

### Path B — Oracle Cloud Always Free VM ($0 forever, recommended)

1. Sign up at `cloud.oracle.com/free` (a credit/debit card is required for identity verification but is not charged on Always Free resources).
2. **Create instance** → image *Ubuntu 22.04/24.04* → shape **VM.Standard.A1.Flex (Ampere ARM, up to 4 OCPU / 24 GB RAM — Always Free eligible)**. (Alternative: *VM.Standard.E2.1.Micro*, 1 GB RAM.) Download the SSH private key.
3. In the instance's **Subnet → Security List**, add ingress rules for TCP **80** and **443** (SSH/22 is already there).
4. SSH in: `ssh -i key.pem ubuntu@<public-ip>`.
5. Continue at **Section 4, Step 1** and follow it verbatim — packages, Node.js, app, systemd, Caddy. Notes for this box:
   - `sharp`/`better-sqlite3` have ARM64 prebuilt binaries. If a build ever fails, `sudo apt -y install build-essential python3` and re-run `npm ci`.
   - Google Cloud's always-free `e2-micro` (us-west1/us-central1/us-east1, 1 GB RAM, 30 GB disk) is an equally valid substitute — same Section 4 runbook.

**Why a VM fits this app:** FirmLedger keeps its entire state in `data/` (SQLite + uploaded logos). A free VM gives you a real persistent disk, so backups = copying one folder (Section 4, Step 11).

---

### Connect your custom domain (both paths)

You already own `firmledger.co.ke`. Everything below is done in your registrar's DNS panel (or in Cloudflare's free DNS if you point your nameservers there — free CDN, DDoS protection and proxy status toggles included; optional but recommended).

**1 · Create the DNS records.**

| Record | Host/Name | Value/Points to | TTL |
|---|---|---|---|
| `A` | `@` | **VPS public IP** (Path B) — or the anycast IPs Render shows for apex domains (Path A) | 300 or Auto |
| `CNAME` | `www` | **VPS public hostname / same IP via a second `A` record** (Path B) — or `YOUR-SERVICE.onrender.com` (Path A) | 300 or Auto |
| `AAAA` | `@` | VPS IPv6 address, if your instance has one (optional) | 300 |

On Render also add the domain under **Settings → Custom Domains** and accept the values it shows; its TLS certificate issues automatically once DNS resolves.
On a VPS nothing else is needed — the Caddyfile in Section 4 Step 6 already covers `firmledger.co.ke` + `www` redirect, and Caddy gets the Let's Encrypt certificate itself the moment DNS points at the box.

**2 · Wait for propagation and verify** (usually minutes, occasionally up to a few hours):

```bash
dig +short firmledger.co.ke        # should print your VPS IP / Render IPs
dig +short www.firmledger.co.ke    # should print the CNAME target
curl -I https://firmledger.co.ke   # should answer over HTTPS with a valid certificate
```

If `curl` shows a certificate error right after the records resolve, give the ACME issuer a few more minutes and check the Caddy log (`journalctl -u caddy -f`). On Cloudflare, keep the record grey-cloud (DNS only) until the certificate exists; orange-cloud (proxied) also works with Caddy afterwards.

**3 · Point the app at the domain.** Edit `.env`:

```ini
BASE_URL=https://firmledger.co.ke
```

Then restart: `sudo systemctl restart firmledger` (VPS) — or on Render, update the env var and it redeploys automatically. **`BASE_URL` must match exactly, no trailing slash** — sitemap URLs, robots.txt, canonical links, OG tags, badge snippets, RSS and every email link are generated from it.

**4 · Confirm the domain took:**

```bash
curl -s https://firmledger.co.ke/robots.txt      # Sitemap line must show https://firmledger.co.ke/sitemap.xml
curl -s https://firmledger.co.ke/sitemap.xml     # loc entries must be https URLs on your domain
```

**5 · Post-domain checklist** (one-time, ~15 min):
- Google Search Console: add the domain property (DNS TXT is easiest) → submit sitemap (Section 4, Step 9).
- Bing Webmaster Tools: same sitemap; IndexNow starts working as soon as the domain property exists.
- Re-check `/robots.txt`, `/feed.xml`, and one listing's badge snippet — all must reference `https://firmledger.co.ke`.
- Sign in to the admin console over HTTPS and confirm 2FA still works (the authenticator secret lives in the database, so it travels with `data/`).
- If you used Path A first: make the production domain the public one, then take your first off-box backup of `data/`.

**If HTTPS fails on the VPS path:** the three usual suspects are (a) DNS still pointing elsewhere — re-check `dig`; (b) Oracle security list / `ufw` not allowing 80+443 — Let's Encrypt needs port 80 reachable; (c) a proxy (Cloudflare orange-cloud) enabled before the first certificate existed — switch to DNS-only, let Caddy succeed, then re-enable.

---

## 4. Step-by-step: from a fresh server to live

This is the complete server runbook — **Path B (free VM) hands off here at Step 1**. It is also the guide for any paid VPS (Hetzner, DigitalOcean, Contabo…) if you outgrow the free tier. Assumes Ubuntu 22.04/24.04 and the domain pointed at your server (Section 3 covered the DNS records).

### Step 1 — Server basics
```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install curl unzip ufw
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
```

### Step 2 — Node.js 20
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt -y install nodejs
node -v   # should print v20.x
```

### Step 3 — Deploy the app
```bash
sudo mkdir -p /srv && sudo unzip firmledger.zip -d /srv/
cd /srv/firmledger
npm ci --omit=dev
```

### Step 4 — Environment (`/srv/firmledger/.env`)
```ini
PORT=3000
BASE_URL=https://firmledger.co.ke
ADMIN_SECRET=pick-a-long-random-string-here
MAIL_FROM=FirmLedger <no-reply@firmledger.co.ke>
# SMTP — same From on every hop. Primary, then failover slots:
SMTP_URL=smtps://USER:PASS@smtp.your-provider.com:465
SMTP2_URL=
SMTP3_URL=
# PayPal — FirmLedger Pro payments (optional here; can also live in Admin → Settings)
PAYPAL_CLIENT_ID=your_paypal_app_client_id
PAYPAL_CLIENT_SECRET=your_paypal_app_secret
PAYPAL_MODE=live         # sandbox while testing, live for production
```
Notes:
- `BASE_URL` must be exact — verification tokens, badge snippets, canonical URLs, sitemaps and OG tags all derive from it.
- Without any SMTP hop, outgoing mail is written to `data/outbox.log` instead of being delivered.
- If the first hop hits a sending limit, `SMTP2_URL` / `SMTP3_URL` (and Admin → Settings providers) are tried automatically. The From address is the same on every hop.
- The app reads `.env` automatically on boot (no extra tooling needed).

### Step 4b — Switch on FirmLedger Pro payments (PayPal)
FirmLedger Pro is the paid tier — it is what turns listings into money. To accept payments:

1. Create a PayPal Business account, then at <https://developer.paypal.com> → **Apps & Credentials** create a **Sandbox** app first and copy its **Client ID** and **Secret**.
2. Paste them into **Admin console → Settings → Payments** (or set `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` in `.env` — env values always win) with **Mode = sandbox**.
3. Create your offers in **Admin console → Plan offers** (the install seeds Monthly $30 / 30 days and Yearly $300 / 365 days; edit A→ deactivate suggestions to whatever you like — monthly, yearly, quarterly, lifetime).
4. Test the whole flow end-to-end from **Dashboard → Upgrade** using the sandbox buyer account PayPal creates for you (charges nothing), then switch **Mode** to `live` (with your live app's credentials) when you're ready to accept real money.

How the flow works: the owner picks an offer in their dashboard → PayPal's hosted checkout opens → payment returns to `/billing/callback`, where the server captures the order and re-verifies it directly with PayPal (order id, exact amount, currency and reference) → the purchased days of Pro are granted to the member's **account**, stacked on any time remaining → a receipt is emailed and a row is written to the `payments` ledger (visible to the owner and the admin). Prices shown come from the server-side plan offers; the browser cannot change an amount.

### Step 5 — Keep it running (systemd)
Create `/etc/systemd/system/firmledger.service`:
```ini
[Unit]
Description=FirmLedger
After=network.target

[Service]
WorkingDirectory=/srv/firmledger
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now firmledger
systemctl status firmledger
```

### Step 6 — HTTPS with Caddy (simplest)
```bash
sudo apt install -y caddy
# /etc/caddy/Caddyfile — replace contents with:
firmledger.co.ke {
  root * /usr/share/caddy
  reverse_proxy 127.0.0.1:3000
}
www.firmledger.co.ke { redir https://firmledger.co.ke{uri} permanent }
sudo systemctl reload caddy
```
Caddy provisions and renews TLS automatically. (nginx + certbot works too: `certbot --nginx -d firmledger.co.ke -d www.firmledger.co.ke`.)

### Step 7 — First boot checks
```bash
curl -s https://firmledger.co.ke/robots.txt          # should print the robots file with your domain
curl -s https://firmledger.co.ke/sitemap.xml | head  # sitemap index
```
The SQLite database, 20 official categories and the IndexNow key are generated on first boot inside `data/`.

### Step 8 — Admin console + two-factor
1. Open `https://firmledger.co.ke/admin3119Musa` (unlisted URL — never linked publicly; keep it private).
2. Enter your `ADMIN_SECRET`.
3. On **first** sign-in you are shown a QR code — scan it with Google Authenticator / 1Password / Authy (or type the manual key beneath it), enter the 6-digit code. That's permanent: every future sign-in requires **secret code + authenticator code**.
4. If you ever lose the authenticator: `sqlite3 /srv/firmledger/data/firmledger.db "DELETE FROM settings WHERE key='admin_totp_secret';"` — the next sign-in re-enrolls. (You can also reset from Settings → Console security when signed in.)

### Step 9 — Search engines
1. Google Search Console → verify `firmledger.co.ke` → submit `https://firmledger.co.ke/sitemap.xml`.
2. Bing Webmaster Tools → same sitemap.
3. Verify the IndexNow key file returns 200: `https://firmledger.co.ke/<key>.txt` (key shown in Admin → Settings).
4. Approve a test listing in the admin and watch the server log: `[indexnow] submitted … status 200` (or 202).

### Step 10 — Content gates before announcement
- Admin → Blog: the three methodology seed posts are real and safe to keep; write your own launch post.
- Check `/docs`, `/privacy`, `/terms` and the contact addresses (`privacy@`, `legal@`, `support@firmledger.co.ke`) — create or forward those mailboxes.
- Register a normal user account for yourself (submission + claim flow testing) — admin powers only come from the console.
- Add your first real listings from Admin → Listings → **+ Add listing**, or from the user-facing form.

### Step 11 — Backups
```bash
# Daily cron, e.g.:
0 3 * * * test -f /srv/firmledger/data/firmledger.db && cp "/srv/firmledger/data/firmledger.db" "/srv/backups/firmledger-$(date +\%F).db"
```
`data/` (DB + uploaded logos + outbox) is the entire site state.

---

## 4x. Production-readiness checklist — the last pass before launch

The public site ships fully production-looking (no sandbox mentions anywhere visitors can see).
Sandbox stays available **for you, the operator**, documented right here. Work this list
top to bottom and FirmLedger is ready for real customers:

1. **Domain + HTTPS** — `BASE_URL=https://yourdomain.com` in `.env`, Caddy (or your proxy) terminating TLS. Canonical URLs, OG tags and sitemap all derive from `BASE_URL`.
2. **Admin gate** — strong `ADMIN_SECRET` in `.env`, then enroll the TOTP two-factor in Admin → Settings → Console security (QR scan) on first login.
3. **Payments — flip sandbox to live**:
   - Keep testing free: PayPal developer portal → your **Sandbox** app credentials + `PAYPAL_MODE=sandbox` (charges nothing).
   - Ready for real money: create a **Live** app in the PayPal developer portal, paste its Client ID + Secret into **Admin → Settings → Payments** (or `.env` `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`), and set **Mode = live** (`PAYPAL_MODE=live`). Env values always win over settings.
   - Nothing else changes — the buyer-facing pages never mentioned sandbox; only this README and the admin settings page carry the mode vocabulary.
4. **Email (REQUIRED for production** — nothing on the internet gets delivered without SMTP configured**).** Three ways, first found wins:
   - **Admin console (easiest, no redeploy)** — **Admin → Settings → Email — SMTP**: host, port (587 STARTTLS or 465 TLS), username, password, From address. Then press **Verify & send test** — it opens a live connection and sends a real branded test email to any address you choose. If the test says OK, every lifecycle email is live.
   - **`.env` URL** — `SMTP_URL=smtps://user:pass@smtp.resend.com:465` (plus optional `MAIL_FROM`).
   - **`.env` pieces** — `MAIL_HOST=smtp.resend.com MAIL_PORT=465 MAIL_SECURE=1 MAIL_USER=resend MAIL_PASS=...`.
   Without any of these, every outgoing mail lands in `data/outbox.log` (dev only — fine for local, useless for members).
   Providers that work out of the box: Resend, Brevo/Sendinblue, Amazon SES, Postmark, Mailgun, Gmail (app password), **Zoho** (see below). When configured, members receive the FirmLedger-branded HTML mails (welcome, password changes, receipts, moderation outcomes) in production deliverability quality.

   **Zoho Mail setup** (the user asked for this): in Admin → Settings → Email — SMTP —
   host `smtppro.zoho.com` (paid Zoho Mail) or `smtp.zoho.com` (free), port `465`, **TLS checked**,
   username = your full Zoho email, password = account password — or an **App Password** if Zoho
   two-factor is on (accounts.zoho.com → Security → App Passwords). **Zoho rejects relay with
   `553 Sender is not allowed` if the From address doesn't match the login account** — FirmLedger
   handles this automatically: leave "From address" empty and it's set to your SMTP username.
   Then press **Verify & send test**.
5. **Seed content** — approve at least the 10 starter listings, write 1–2 blog posts, review `/about`, `/docs`, `/privacy`, `/terms`.
6. **Search engines** — IndexNow key auto-rotates on boot; verify sitemap at `/sitemap-index.xml` and submit to Bing/Google.
7. **Backups** — nightly `sqlite3 data/firmledger.db ".backup ..."` + `data/uploads` (Step 11 above).
8. **Smoke test end-to-end** — register → submit listing → approve in admin (branded approval mail arrives) → claim flow → upgrade with a real card → refund path. Every step above sends the matching branded email when SMTP is live.

## 5. Day-to-day operations

| Task | Where |
|---|---|
| Moderate submissions | Admin → Listings (search/filters, approve/reject/edit, bulk pending) |
| Global search | Admin → Search (users, listings, claims, tickets, blog) |
| In-app notifications | Header bell (user) · Admin → Inbox |
| Reset a member's password | Admin → Users → Reset password (reuses `/reset/:token`) |
| Delete a member | Admin → Users → Delete (emails them first) or honour a pending deletion request |
| Ticket auto-close | Hourly timer: solved > 7 days, or no user reply > 14 days after last admin message |
| Add a listing directly | Admin → Listings → **+ Add listing** (dup-guarded, IndexNow-pushed) |
| Email one user | Admin → Users → Email (prefilled) — or Users → detail → Email |
| Email everyone | Admin → Email → "All users" (uses SMTP when configured, otherwise outbox) |
| Suspend/block a user | Admin → Users → suspend (sign-in returns 403, sessions revoked) |
| Resolve removal requests | Admin → Removals (dismiss, or delete the listing) |
| Write news/blog | Admin → Blog (published posts appear in footer News, the RSS feed, the sitemap) |
| Rotate IndexNow key | Admin → Settings → Regenerate |
| Rotate admin 2FA | Admin → Settings → Console security → Reset two-factor |
| Rotate `ADMIN_SECRET` | edit `.env`, `systemctl restart firmledger` |
| Manage Pro offers and prices | Admin → Plan offers (seeds Monthly $30/30d and Yearly $300/365d) |
| Promo / discount codes | Admin → Promos — create `LAUNCH20`-style codes, cap uses, expiry, plan lock; notify by email or in-app |
| Maintenance mode | Admin → Protection — custom holding page, optional email to users |
| Spam / scrape controls | Admin → Protection — IP + email-domain lists and rate limits |
| System health | Admin → Health — disk, DB size, Node memory, uptime, last backup |
| Mail providers + failover | Admin → Settings → Email, or `SMTP_URL` / `SMTP2_URL` in `.env` |
| Grant Pro without payment | Admin → Users → Grant 30d / Lifetime (emails the member) |
| Grant/refund Pro manually | Admin → Listings → Grant Pro (30d) · Lifetime · Revoke Pro |

## 6. Data & files

| Path | Contents |
|---|---|
| `data/firmledger.db` | SQLite database (users, listings, claims, sessions, settings, blog, mail log, `payments`, `notifications`, `deletion_requests`, `pro_transfer_requests`, `spam_ip`, `spam_domain`, `smtp_accounts`, `promo_codes`, `promo_redemptions`) |
| `data/uploads/logos/` | Uploaded logos (normalized 256×256), served at `/uploads/logos/…` |
| `data/outbox.log` | Outbound mail when SMTP is not configured |

## 7. Reset / migrations
- Full reset: stop the service, delete `data/firmledger.db*`, start again (schema + categories + IndexNow key regenerate; blog re-seeds).
- Schema migrations run automatically on boot (`CREATE IF NOT EXISTS` + `ALTER` guards).

## 8. Verification snippet formats (shown to users in the claim flow)
```dns
TXT  @  firmledger-verification=flv_…
```
```html
<meta name="firmledger-verification" content="flv_…">
```
```html
<a href="https://firmledger.co.ke/listing/SLUG" rel="noopener" title="… on FirmLedger" data-firmledger-claim="flv_…">
  <img src="https://firmledger.co.ke/badge/SLUG.svg?theme=light" alt="… — verified on FirmLedger" width="200" height="56">
</a>
```
The badge renders live from the DB (verified → green "VERIFIED BUSINESS" state, unclaimed → "LISTED PROFILE"), with the FirmLedger monogram, in light or dark themes, and links back to the profile.

## 9. Honest SEO note
No platform can guarantee a fixed indexing deadline — crawling is the search engine's decision. FirmLedger does the maximum possible the moment a listing is approved: IndexNow push (Bing/Yandex/DuckDuckGo, typically hours), refreshed sitemap + RSS, per-page structured data, and a re-ping 30 minutes later.

## 10. Troubleshooter

| Symptom | Fix |
|---|---|
| Gate rejects the admin code | `ADMIN_SECRET` in `.env` doesn't match — check for stray quotes/spaces, restart |
| 2FA code never accepted | Server clock drift — run `timedatectl status`, enable NTP (`sudo timedatectl set-ntp true`) |
| Claim verification says domain unreachable | The target website blocks the fetch or is down — verify manually from the server: `curl -I https://domain` |
| Mail never arrives | Check `SMTP_URL` format and `data/outbox.log` — if entries are landing there, SMTP isn't configured |
| IndexNow returns 4xx | Re-check `BASE_URL` matches the site's real public origin, and the key file `/<key>.txt` returns 200 |
| Sitemap has localhost URLs | `BASE_URL` is unset — set it and restart |
| "Payments are not configured" on upgrade | No PayPal credentials saved — paste your Client ID and Secret in Admin → Settings → Payments (or set `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET`) |
| Payment made but plan not active | Check the reference in Admin → Settings → Recent Pro payments; if still `initialized`, the buyer never returned from PayPal — ask them to finish checkout, or grant Pro manually from Admin → Users |

## 11. Roadmap hooks already in the schema
- `listing_events` → company timelines (done — Pro feature, rendered publicly) → can power change alerts later
- `relationships` → the graph (done) → API `/:slug/relationships` endpoint is a read away
- `listings.plan` / `plan_expires_at` + `payments` ledger → Pro subscriptions (done) → renewal reminders / monthly analytics are queries away
- `waitlist` → API launch list
- Field-level `sources` (JSON array) → provenance shown publicly (admin-editable today)
