# FirmLedger

**The business record layer for modern discovery.** Verified listings for companies, startups, agencies, organizations, products, services and publishers — with source transparency, confidence scores, ownership verification and a relationship graph.

Production site: **https://firmledger.co.ke**

Stack: Node.js + Express · EJS server-rendered views · SQLite (WAL) · no frontend build step.

---

## 1. Feature map

| Area | What it does |
|---|---|
| Directory | Search + filters (type, category, country, verified), sort, pagination, list/grid view toggle, name suggest (`/suggest.json`) — **fluid full-screen measure** on `/directory` and every `/directory/c/…` landing page: the card grid re-flows 1→5 columns with the window, the gutters stay equal on both sides, and nothing ever hugs one edge |
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
| Indexing | IndexNow push on approve/claim (+30 min re-ping) · sitemap **index** + 4 sub-sitemaps with `lastmod` · canonical/OG/Twitter/JSON-LD on every page · RSS · **automatic `noindex` + blocked robots.txt whenever `BASE_URL` is not a public origin** (dev/staging can never leak into an index) |

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

## 2b. Layout & design conventions (worth 2 minutes before editing a view)

There is no build step and no CSS framework: one stylesheet, **`public/css/app.css`**
(~106 KB raw, ~23 KB gzipped), organised as an original base followed by numbered
revision blocks — currently `r2, r19 … r23, r25 … r30`. Each block only *adds* rules for
classes the views already use or introduces a new piece; nothing is renamed, so a block can
be read as a changelog and deleted safely if you disagree with it.

**Horizontal layout — pick a container, never a margin.**

| Class | Measure | Use for |
|---|---|---|
| `.container` | 1200 px (1340 px on screens ≥1500 px), `margin-inline: auto` | almost every page band and section |
| `.container-wide` | `min(var(--wide-max, 1760px), 100%)`, centred, gutters `clamp(18px, 3.2vw, 46px)` | the directory + `/directory/c/…` landing pages, and anything else that should use the whole screen |
| `.container-narrow` | 800 px, centred | single-column flows: auth, claims, security, upgrade |
| `.center-col` | no width of its own — only `margin-inline: auto` | an opt-in centring utility for a deliberately narrow block (a `side-card`, a form) inside a wide container |

Because every one of those centres itself, a page is symmetric at 320 px and at 3440 px:
there is no "left-hugging content with a dead right gutter" state, and no page needs a
horizontal scrollbar. Grids inside them use `auto-fill` + `minmax()` (`.list-grid` →
`minmax(min(100%, 268px), 1fr)`), so they gain columns instead of stretching or squeezing;
grid children carry `min-width: 0` + `overflow-wrap: anywhere` so a long company name can
never push the page sideways. Mobile-only centring overrides live in the
`@media (max-width: 760px)` block.

**Form fields have one shape.** Inside `<form class="form form-card">`:

```ejs
<div class="form-section">Group title</div>
<label class="fl"><span>Caption <small>optional hint</small> <small class="count" data-count-for="field">0/80</small></span>
  <input class="input" name="field" maxlength="80" data-count>
</label>
<div class="form-two">…two paired fields…</div>   <!-- .form-row for the same rhythm in admin panels -->
<p class="form-note">…context under the group…</p>
<div class="form-actions"><button class="btn btn-primary">Save</button><a class="btn btn-ghost" href="…">Cancel</a></div>
```

`.fl` puts the caption above the control, `data-count` + `.count` wire the live
`0/N` counter in `public/js/main.js`, and `.form-two` / `.form-row` collapse to one column
under ~640 px. Do not put `<p>` hints inside a `<label>`; do not disable paste in
confirmation fields — retyping is the check, blocking the clipboard is not.

**Two rules that have caused real bugs, so they are now policy:**

1. **Every `<form method="post">` carries the CSRF field.** `csrfProtect` keys off the
   session cookie, not the page, so a pre-auth form (login, register, forgot/reset,
   removal request, admin gate) rendered for a *signed-in* visitor 403s without it.
   Snippet: `<% if (typeof csrfToken !== 'undefined' && csrfToken) { %><input type="hidden" name="_csrf" value="<%= csrfToken %>"><% } %>`.
   The repo convention is 117/117 POST forms carrying it — keep that number whole.
2. **`<%= %>` escapes, so never put markup or entities inside it.**
   `<%= x ? 'Upgrade &rsaquo;' : 'Manage &rsaquo;' %>` prints `Upgrade &amp;rsaquo;`;
   write `<%= x ? 'Upgrade' : 'Manage' %> &rsaquo;` and keep the entity in the markup.
   Use `<%- %>` only for HTML you built yourself (e.g. the search `hl()` highlight helper).

**Caching.** `server.js` serves `/public` with a 7-day max-age and appends
`?v=<%= assetV %>` from `ASSET_V`. Any commit that changes `public/css/app.css` or a file in
`public/js/` must bump `ASSET_V` — that is the entire cache-invalidation strategy.

**Panels and bands** (all defined, all used by the views): `.side-card`, `.form-card`,
`.panel`, `.card`/`.card-body`, `.alert alert-ok|err|warn`, `.pill pill-approved|pending|rejected`,
`.section-head`, `.empty-state`, `.page-head` + `.kicker` + `.h-display` + `.lede`, the dark
`.band` / `.cta-band` closing sections with `.btn-light`, and `.search-hero` (which must be the
`<form>` itself — never nested inside a `.form`, or `.form input[type=search]` out-specifies it).

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

## 4a. Hosting on your own server or VPS (any provider)

Section 4 is the free-VM runbook; this is the same thing written provider-neutral, for the
VPS you already have (Hetzner, DigitalOcean, Vultr, Linode, AWS Lightsail, OVH, Contabo, a
box under your desk). One process, one folder, no external database.

**What the box needs**

| Resource | Minimum | Comfortable |
|---|---|---|
| CPU / RAM | 1 vCPU / 1 GB (+ swap) | 2 vCPU / 2–4 GB |
| Disk | 10 GB | 20+ GB — logos and DB live in `data/` |
| OS | Ubuntu 22.04 / 24.04 LTS (Debian 12 works) | same |
| Open inbound ports | 22, 80, 443 | same — keep **3000 closed** to the internet, the proxy fronts it |
| Outbound | 443 (IndexNow, PayPal, SMTP-over-TLS providers) | add 25/587 only if you relay mail yourself |

**1 · Hardening + runtime (Ubuntu 22.04/24.04)**

```bash
sudo apt update && sudo apt -y full-upgrade
sudo apt -y install curl unzip ufw fail2ban
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable

# 1 GB boxes: swap, or npm's native-build fallback can be OOM-killed
if [ "$(free -m | awk '/^Mem:/{print $2}')" -lt 1500 ] && ! swapon --show | grep -q .; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile \
    && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt -y install nodejs
sudo timedatectl set-ntp true        # TOTP for the admin 2FA gate will not work with clock drift
```

**2 · App files, environment, service**

```bash
sudo mkdir -p /srv && sudo unzip firmledger.zip -d /srv/ && cd /srv/firmledger
sudo npm ci --omit=dev               # no build step; better-sqlite3 + sharp use prebuilt binaries
sudo install -d -m 750 /srv/firmledger/data /srv/backups
sudo nano /srv/firmledger/.env       # PORT, BASE_URL, ADMIN_SECRET, SMTP_URL — see Section 4 Step 4
sudo adduser --system --group --no-create-home firmledger || true
sudo chown -R firmledger:firmledger /srv/firmledger /srv/backups

sudo tee /etc/systemd/system/firmledger.service >/dev/null <<'UNIT'
[Unit]
Description=FirmLedger
After=network-online.target
Wants=network-online.target

[Service]
User=firmledger
WorkingDirectory=/srv/firmledger
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/srv/firmledger/data /srv/backups

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload && sudo systemctl enable --now firmledger
curl -sI http://127.0.0.1:3000/ | head -1     # HTTP/1.1 200 → the app is up
```

**3 · HTTPS-terminating proxy — pick one**

*Caddy (simplest, automatic renewals):* the config in Section 4 Step 6.

*nginx + Let's Encrypt (what most admins already run):*

```bash
sudo apt -y install nginx certbot python3-certbot-nginx
sudo tee /etc/nginx/sites-available/firmledger >/dev/null <<'NGX'
server {
  listen 80;
  listen [::]:80;
  server_name firmledger.co.ke www.firmledger.co.ke;

  access_log /var/log/nginx/firmledger.access.log;
  client_max_body_size 6m;          # logo uploads travel through here
  gzip on; gzip_types text/css application/javascript image/svg+xml;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;   # rate-limiting keys on the real client IP
    proxy_read_timeout 60s;
  }
}
NGX
sudo ln -s /etc/nginx/sites-available/firmledger /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d firmledger.co.ke -d www.firmledger.co.ke   # redirect: yes
```

`trust proxy` is already enabled in `server.js`, so `X-Forwarded-For`/`X-Forwarded-Proto`
are honoured — spam throttling, IP allow/block lists and the login lockout keep working
behind nginx. Never `proxy_pass` to `0.0.0.0:3000`; use `127.0.0.1` and leave 3000 shut.

**4 · Provider-specific gotchas that actually bite**

| Provider | Watch out for |
|---|---|
| DigitalOcean, AWS Lightsail, Vultr, Oracle | **Outbound port 25 is blocked by default.** Use a submission provider over 465/587 (`SMTP_URL=smtps://…`) — don't try to relay directly. Lightsail also needs its own console firewall rules for 80/443 in addition to `ufw`. |
| Hetzner Cloud | Firewall in the Cloud Console (not just `ufw`); ARM (Cax) and x86 (CX) both fine — `npm ci` pulls the right prebuilds. |
| OVH | Anti-DDoS stays on; if you point a domain at the box, add the A record to the *OVH* DNS zone, and check `sudo iptables -L` for leftovers from old hostnames. |
| Contabo / cheap x86 | 1 GB RAM boxes need the swap above; also enable the extra IPv4 only if you need reverse DNS for mail. |
| Anything behind Cloudflare | Proxy the DNS record **after** the certificate exists (DNS-only first), set SSL mode to *Full (strict)*, and keep `BASE_URL` on the `https://` origin. |

**5 · Updates, backups, restore, logs**

```bash
# Update (zero-downtime enough for this app: it restarts in well under a second)
cd /srv/firmledger && sudo npm ci --omit=dev && sudo systemctl restart firmledger
tail -20 /var/log/syslog | grep firmledger        # or: journalctl -u firmledger -n 50 --no-pager

# Backup — one consistent snapshot, safe while traffic is live
sudo -u firmledger sqlite3 /srv/firmledger/data/firmledger.db \
  ".backup '/srv/backups/firmledger-$(date +%F).db'"
sudo tar czf "/srv/backups/uploads-$(date +%F).tar.gz" -C /srv/firmledger/data .
0 3 * * * test -f /srv/firmledger/data/firmledger.db && sudo -u firmledger sqlite3 /srv/firmledger/data/firmledger.db ".backup '/srv/backups/firmledger-\$(date +\%F).db'"

# Restore onto a fresh box: stop the service, drop the DB in, start it
sudo systemctl stop firmledger
sudo cp /srv/backups/firmledger-2026-08-01.db /srv/firmledger/data/firmledger.db
sudo chown firmledger:firmledger /srv/firmledger/data/* && sudo systemctl start firmledger
curl -s https://firmledger.co.ke/ | grep -o '<title>[^<]*'      # sanity check
```

Copy `/srv/backups` off-box (rclone to any S3-compatible bucket, `restic`, or the free tier
of your provider's object storage) — a backup on the same disk is not a backup. Admin →
**Health** shows disk, DB size, memory, uptime and the last backup; **Users → Backup**
exports the whole `data/` as a single `.firmledger` archive you can keep off-box.

Also: Admin → **Protection** → maintenance mode serves a branded 503 while you migrate, which
keeps search engines from recording a dead site during the move (503 = "come back later",
so nothing is dropped from the index).

---

## 4b. Getting indexed — what the app does, what you do

**Automatically, with no configuration:**

| Mechanism | Where |
|---|---|
| Canonical URL, `<title>`, meta description, OG + Twitter cards, `theme-color` | every HTML page (`views/partials/top.ejs`) |
| Structured data — `WebSite` + `SearchAction`, `Organization` + `FAQPage` on listing profiles, `CollectionPage` + `ItemList` on category/location pages, `Article` on blog posts, `TechArticle` on the API docs, `BreadcrumbList` on listings, blog, docs, API docs, `/about`, `/privacy`, `/terms` | per-route `meta.jsonld` / `meta.breadcrumbs`, emitted by `views/partials/top.ejs` |
| `robots` meta — `index,follow,max-image-preview:large,max-snippet:-1` by default, `noindex,follow` where it should be | `views/partials/top.ejs` |
| `sitemap.xml` **index** → `/sitemaps/static.xml`, `listings.xml`, `categories.xml`, `locations.xml` (only `status='approved'` listings; `lastmod` from `updated_at`) | `src/routes/public.js` |
| `robots.txt` — allows the public site (including `/login`, `/search`, `/claim`, `/register`), disallows `/dashboard`, `/admin3119Musa`, `/removal/`, `/forgot`, and points at the sitemap | `src/routes/public.js` |
| **IndexNow** push the moment a listing is approved or claimed, plus a re-ping 30 min later; key auto-generated and served at `/<key>.txt` | `src/lib/indexing.js` |
| **Google Indexing API** push (`URL_UPDATED`) the moment a listing is approved or updated, plus a manual "Submit first 200 listings" back-fill that respects Google's 200/day quota — a URL that has been pinged is never pinged again | `src/lib/googleIndexing.js`, Admin → Settings → Google Indexing API |
| RSS/`feed.xml` (blog + new listings) for discovery and fast re-crawl | `src/routes/public.js` |
| Empty category/location landing pages are `noindex,follow`, so they are never thin-indexed; `/directory?page=2` and `/directory/c/x?page=2` canonicalise back to page 1 on purpose (pagination and filters must not multiply in the index), and follow-links are still crawled | `src/routes/public.js` |
| **Staging guard** — if `BASE_URL` is unset or points at `localhost`, a `.test/.local/.internal` name or a private IP, every response carries `X-Robots-Tag: noindex, follow` **and** `/robots.txt` becomes `Disallow: /`, so a dev or preview box can never leak into an index. The boot log tells you when this is active. Override: `FORCE_INDEXABLE=1`. | `server.js`, `src/lib/util.js` |

### Google Indexing API — one-time setup

IndexNow (Bing/Yandex/DuckDuckGo) needs nothing. Google's Indexing API needs a
service-account key, and the app gives you two ways to supply it:

1. **Production (recommended)** — put the whole JSON payload on one line in
   `GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON` (`.env`, or your host's environment
   panel). Nothing sensitive ever touches the repository.
2. **Admin console** — Admin → **Settings → Google Indexing API** → upload
   `service-account.json` (or paste its contents). It is written to
   `data/service-account.json` with `0600` permissions and survives restarts.

Resolution order is: environment variable → uploaded file → `./service-account.json`
(local development). All three locations are git-ignored — never commit a key.

To create the key: Google Cloud → **IAM & Admin → Service accounts → Create service
account → Keys → Add key → JSON**, then in **Google Search Console** add that
service account as an *Owner* (or at least URL owner) of the property, and enable
the **Indexing API** for the project.

What happens then:

- `pingGoogleNewListing(url)` fires `{ url, type: 'URL_UPDATED' }` at
  `indexing.urlNotifications.publish` in the background whenever a listing is
  approved or updated — the moderation response never waits on Google.
- **Submit first 200 listings** back-fills the backlog inside the 200/day quota.
  Every accepted URL is recorded in `google_indexing_submissions`, so it can never
  be submitted twice.
- Successes and failures are both `console.log`/`console.error`ed (with the target
  URL and the API status) **and** written to **Admin → Settings → Indexing log**,
  which scrolls inside its card and can be cleared entry-by-entry or all at once.

```bash
node -e "require('./src/lib/googleIndexing')"   # no output = the module loads cleanly
npm run test:indexing                          # full Google Indexing suite, client stubbed
```

**You do these five things once the domain is live:**

1. **Fix `BASE_URL` before anything else.** Every canonical, OG URL, sitemap `<loc>`,
   badge snippet and email link is built from it. `BASE_URL=http://localhost:3000` on a
   public host means Google is told the canonical page lives on localhost — the site will
   never rank. No trailing slash, `https://`, real domain.
2. **Verify the site answers the way a crawler sees it:**

   ```bash
   curl -sI https://firmledger.co.ke/ | grep -i 'x-robots-tag' || echo "no X-Robots-Tag → indexable ✓"
   curl -s https://firmledger.co.ke/robots.txt                  # Allow: / + Sitemap: line on your domain
   curl -s https://firmledger.co.ke/sitemap.xml | head          # <sitemapindex> with 4 sub-sitemaps
   curl -s https://firmledger.co.ke/sitemaps/listings.xml | grep -c '<loc>'   # > 0 once listings are approved
   curl -s https://firmledger.co.ke/ | grep -o '<link rel="canonical"[^>]*>' # must be your https domain
   curl -s -o /dev/null -w '%{http_code}\n' https://firmledger.co.ke/<indexnow-key>.txt   # 200
   ```
   If the first line prints anything at all, `BASE_URL` is still a dev value — fix it and restart.
3. **Google Search Console** → add a *Domain* property → TXT record → **Sitemaps** →
   submit `https://your-domain/sitemap.xml`. Bing Webmaster Tools → add the same sitemap
   (claim it via the meta tag, Google file, or DNS); IndexNow starts working as soon as the
   Bing property exists, which is why Bing/Yandex/DuckDuckGo pick pages up within hours while
   Google takes days.
4. **Give Google something to crawl first:** approve 5–10 real listings, then use *URL
   Inspection → Request Indexing* on your homepage and two of them. Indexing follows links, so
   make sure the footer/nav links (which the app renders) actually reach the pages you care about.
5. **Watch it, don't force it:** the *Pages* report is the truth. `Crawled – currently not
   indexed` = content quality/duplication, not a technical fault; `Disallowed` = you blocked
   something you wanted; `Duplicate without user-selected canonical` = `BASE_URL`/proxy mismatch.

**Deliberately not indexed** (and why): `/dashboard/*` and `/admin3119Musa/*` (both
`noindex,nofollow` in-page **and** disallowed in `robots.txt` — belt and braces, because a
logged-out crawler must never see them), `/login` and `/forgot` (no content, and they'd be
duplicate shells), `/search` (query-space duplication: thousands of near-identical result
pages), `/removal/*` (private forms), `/claim` and everything under it (so the token-carrying
`/claim/verify/<id>` URLs can never be crawled). `/register` **is** indexed and listed in the
static sitemap on purpose — it's the entry point people search for.
`/newsletter/unsubscribe?token=…` carries a secret in the URL, so it is `noindex` by design.

**Do not** add `Disallow: /` "temporarily" while testing in production, and do not
`noindex` the homepage: the app already keeps the private half out of the index.

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
Every page is complete server-rendered HTML — the directory, listing profiles, docs and legal
pages need no JavaScript to render or to be crawled (a page is ~21–35 KB raw, ~6–9 KB gzipped,
plus one 23 KB-gzipped stylesheet). That is the structural reason this app indexes well: what
Googlebot fetches is what a human sees. There is no hydration step, no client route and no
`noscript` fallback to maintain.

No platform can guarantee a fixed indexing deadline — crawling is the search engine's decision. FirmLedger does the maximum possible the moment a listing is approved: IndexNow push (Bing/Yandex/DuckDuckGo, typically hours), refreshed sitemap + RSS, per-page structured data, and a re-ping 30 minutes later.

## 10. Troubleshooter

| Symptom | Fix |
|---|---|
| Page looks shifted left, or a section stretches oddly on a big monitor | the block is missing its container class — `.container` / `.container-wide` / `.container-narrow` (or `.center-col` for a narrow card). Never fix it with a one-sided margin |
| CSS change did not appear | `ASSET_V` in `server.js` was not bumped — static files are cached for 7 days by design |
| Directory looks empty / `429` while load-testing | the spam throttle answered — that is protection working; raise the limit in Admin → Protection or wait a minute |
| Gate rejects the admin code | `ADMIN_SECRET` in `.env` doesn't match — check for stray quotes/spaces, restart |
| 2FA code never accepted | Server clock drift — run `timedatectl status`, enable NTP (`sudo timedatectl set-ntp true`) |
| Claim verification says domain unreachable | The target website blocks the fetch or is down — verify manually from the server: `curl -I https://domain` |
| Mail never arrives | Check `SMTP_URL` format and `data/outbox.log` — if entries are landing there, SMTP isn't configured |
| IndexNow returns 4xx | Re-check `BASE_URL` matches the site's real public origin, and the key file `/<key>.txt` returns 200 |
| Sitemap has localhost URLs | `BASE_URL` is unset — set it and restart |
| Site refuses to get indexed, `X-Robots-Tag: noindex` in `curl -sI` | `BASE_URL` is a localhost/`.test`/private-IP value — set the real public https origin and restart (or `FORCE_INDEXABLE=1` for an intentionally odd host) |
| `/robots.txt` says `Disallow: /` on production | same cause as above — the staging guard is active because `BASE_URL` doesn't look public |
| "Payments are not configured" on upgrade | No PayPal credentials saved — paste your Client ID and Secret in Admin → Settings → Payments (or set `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET`) |
| Payment made but plan not active | Check the reference in Admin → Settings → Recent Pro payments; if still `initialized`, the buyer never returned from PayPal — ask them to finish checkout, or grant Pro manually from Admin → Users |

## 11. Roadmap hooks already in the schema
- `listing_events` → company timelines (done — Pro feature, rendered publicly) → can power change alerts later
- `relationships` → the graph (done) → API `/:slug/relationships` endpoint is a read away
- `listings.plan` / `plan_expires_at` + `payments` ledger → Pro subscriptions (done) → renewal reminders / monthly analytics are queries away
- `waitlist` → early-access list (the developer API itself is live — Pro accounts get keys, docs and a playground)
- Field-level `sources` (JSON array) → provenance shown publicly (admin-editable today)
