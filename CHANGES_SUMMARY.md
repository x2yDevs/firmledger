# FirmLedger — change summary

## 2026-09-07 — Admin sign-in chain: secret → emailed OTP → authenticator

The admin gate is now a strict three-step chain, everything else untouched:

1. **The admin secret code** (`ADMIN_SECRET`) — the gate screen, as always.
2. **A one-time 6-digit code emailed to the admin inbox** — a dedicated
   verification screen right after the secret. The OTP inbox is
   `admin@firmledger.co.ke` by default: attached to the account in Settings
   (Admin → Settings → Two-factor → “Sign-in OTP inbox”), overridable with
   `ADMIN_2FA_EMAIL`. Codes live 10 minutes, work once, a newer email retires
   the last instantly, resends are one per minute, and five wrong attempts
   discard the verification.
3. **The authenticator (or a recovery code), as it always was** — TOTP codes,
   the 10 one-time recovery codes, the 5-attempt throttle and the Settings
   reset/regenerate actions are unchanged. The emailed fallback that used to
   sit *alongside* this step has moved out (it IS step 2 now, and is burned
   once used).

**The authenticator key is attached to the account, not a device.** The TOTP
secret lives in the database (`admin_totp_secret`), so the QR is shown exactly
once — at first enrollment. Every later sign-in, from any device and across
restarts, asks only for the code; an interrupted enrollment reuses the same
pending key so a half-scanned QR is never invalidated either.

Mechanically: the pending session now has two stages (`admin-pending` after
the secret, `admin-pending2` after the emailed code is proven), the step-2
routes live at `/admin3119Musa/2fa-email` (+ `/resend`), and the mail is a
real send through the configured SMTP chain (outbox fallback in dev).

```
npm run test:2fa   # 35 checks: the whole chain, real mail, nothing stubbed
npm test           # 10 suites
```

---

## 2026-09-07 — Indexing health: crawler-proof URLs, hosts and rate limiting

Four fixes for things a search crawler met as errors (Search Console-speak:
"Duplicate without user-selected canonical", "Invalid URL / invalid lastmod",
"Page fetch failed"). Nothing else moved — same pages, same markup, same limits.

### 1. One URL per page — trailing-slash 301s (`server.js`)

Every route was always defined without a trailing slash, but `/about/`,
`/directory/`, `/listing/acme/`, `/blog/` answered **200 alongside** the
canonical URL — the same page indexable twice with split signals. A GET/HEAD
on any `/path/` now answers **301** onto `/path` (query string preserved,
root `/` untouched, POSTs never redirected).

### 2. One host per site — `www.` 301s to the apex (`server.js`)

The existing `firmledger.onrender.com → firmledger.co.ke` redirect is joined
by a general one: a request whose Host is `www.<BASE_URL host>` answers 301 to
the apex origin, so the site can never be indexed under two hosts.

### 3. Sitemap hygiene (`src/routes/public.js`)

* **No fragment URLs** — `/careers#role-…` entries are gone from
  `static.xml`: `<loc>` must be a plain URL per the sitemap protocol and
  Search Console reported the anchors as errors. The `/careers` page itself
  stays in the sitemap; the role anchors are plain links on it.
* **No fabricated `lastmod`** — the `static.xml` entry in the sitemap index no
  longer stamps "today" on every fetch (a lastmod that always says now is
  noise to crawlers). Real dates (listings, blog posts) are untouched.

### 4. Rate limiting never blocks indexing (`src/lib/spam.js`)

The scrape ceiling (default 180 page loads/min/IP) stays exactly as
configured — but two carve-outs were added:

* **SEO files are always reachable**: `/robots.txt`, `/sitemap.xml`,
  `/sitemaps/*`, `/feed.xml` and the IndexNow key file skip the limiter, so a
  mid-throttle crawler still reads the sitemap instead of meeting a 429.
* **Verified search bots skip the page ceiling**: a Googlebot/Bingbot/
  DuckDuckBot/Yandex/Baidu/Applebot User-agent earns nothing by itself — the
  IP must pass the two-step check (reverse DNS lands on a bot domain, forward
  DNS returns the same IP, results cached 24 h, failing resolvers fail
  closed). Verified bots crawl bursts without 429s; spoofed UAs fall back to
  the normal limits.

### Test

```
npm run test:health    # 33 checks: the crawl view above, regression-locked
npm test               # now 9 suites
```

`tests/indexing-health.test.js` boots the real server and asserts: the 301s
(slash + www + onrender, query strings riding along), sitemap hygiene (no
fragments, no fake lastmod, every `<loc>` absolute and every one of them
answering 200), robots.txt unchanged, and the limiter carve-outs — SEO files
200 mid-throttle, Retry-After on the 429 page, spoofed Googlebot still
throttled, real bot verification proven against a stubbed resolver.

---

## 2026-09-03 — Google Indexing API, featured-records marquee, permanent incident delete

### 1. Google Indexing API (`src/lib/googleIndexing.js`, new)

Approved and updated listings now ping Google directly, alongside the existing
IndexNow push to Bing/Yandex/DuckDuckGo.

| Piece | Where it lives |
| --- | --- |
| `pingGoogleNewListing(url)` — reusable background utility | `src/lib/googleIndexing.js` |
| Service-account key (upload or paste), saved permanently | Admin → Settings → Google Indexing API → `data/service-account.json` (0600) |
| Credentials in production | `GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON` (stringified JSON in the environment) |
| Back-fill button | Admin → Settings → **Submit first 200 listings** |
| Audit trail | Admin → Settings → **Indexing log** (scrollable, deletable) |

* **Credentials resolve in order:** `GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON` → the
  uploaded `data/service-account.json` → a local `./service-account.json` for
  development. All three are git-ignored; `.gitignore` now names
  `service-account.json`, `*service-account*.json` and `*.pem` explicitly.
* **Auth + publish** use `google.auth.GoogleAuth` (scope
  `https://www.googleapis.com/auth/indexing`) and
  `indexing.urlNotifications.publish` with `{ url, type: 'URL_UPDATED' }`.
* **Logs** — success: `console.log` with the target URL and the API status code;
  failure: `console.error` with the target URL, status and message. Both are also
  written to the `indexing_log` table shown in the console, where entries can be
  deleted one by one or cleared.
* **Controller integration** — the helper fires in the background (never awaited)
  from admin approve / bulk-approve / create / edit, dashboard create / edit, the
  claim flow and the AI tools, each time a record ends up public.
* **200/day quota + never twice** — every accepted URL is recorded in
  `google_indexing_submissions`; the manual run only ever picks URLs missing from
  that table, stops on HTTP 429 and reports how much quota is left. Progress is
  polled live on the settings page.

### 2. Homepage featured records (`views/home.ejs`, `src/routes/public.js`)

Up to **8** featured records render exactly as before in the grid. Beyond 8 the
strip becomes the same seamless horizontal marquee as the promoted (sponsored)
listings — two identical passes of the cards, one pass of travel, hover/focus or
the Pause button freezes it, and `prefers-reduced-motion` turns it into a
swipeable row. Same `l-card` markup, same spacing, same typography.

### 3. Admin → Status: permanent incident delete

Each incident card now carries a **Delete** button next to Resolve. It removes
the row and its whole timeline (`incident_updates` cascades), so the incident
disappears from the public `/status` page, from the 30-day history and from the
console. If that incident was the only thing holding its component down, the
component is healed back to operational; everything else on the page is untouched.

### 4. Tests

```
npm test                # everything
npm run test:indexing   # Google Indexing API + featured rail
```

`tests/google-indexing.test.js` (62 checks) runs the real server and the real
library against a stubbed `googleapis` client (`tests/helpers/googleapis-stub.js`,
preloaded with `node -r`), so it needs no Google credentials and no network.

---

## 2026-09-02 — Backup completeness, production-ready AI assistant, contained admin queues

### 1. `.firmledger` backup now carries the whole console (`src/lib/backup.js`)

**Download (Admin → Users → Full backup, Admin → Health → Backup)**

The file is still one pretty-printed JSON document, now with three readable
sections on top of the raw table dump:

| Section | Contents |
| --- | --- |
| `users` | every account: name, email, password hash, plan, expiry, suspension, 2FA state, their listings/claims/tickets/payments |
| `listings` | **every listing in the ledger** (owned or not) with a spelled-out `configuration` block — status, category, type, featured, claimed, sponsorship + expiry, listing Pro plan + expiry, verified badge, socials, sources, tags — plus its jobs, relationships and the owner's e-mail |
| `configuration` | settings (all key/values), categories, plan offers, promo codes, advertising packages, careers, blog posts, protection IP/domain rules, status components + incidents, newsletter subscribers |
| `database` | authoritative table-by-table snapshot used by the restore |

Sessions, password-reset tokens, registration OTPs and TOTP secrets are still
excluded on purpose.

**Import (Admin → Users → Import from file)**

Import used to restore identities only. It now rebuilds the ledger and the
configuration as well:

* users merge by e-mail (unchanged behaviour, original password hashes kept);
* listings merge by slug, with ownership re-attached through the owner e-mail so
  a restore into a fresh database keeps the right owner even when ids shift;
* every other table is restored on its natural key (slug / code / value / key),
  and keyless tables are matched on the whole row — importing the same file
  twice creates no duplicates;
* nothing is deleted; the flash message reports accounts *and* records restored.

### 2. AI Playground — a real agent, tested action by action

Design and layout unchanged. The engine underneath is new (`src/lib/ai.js`):

* **Agent loop.** The assistant can look a record up and then act on it inside
  one turn: tool results are fed back to the model and it continues until the job
  is finished (6 model steps / 12 tool runs per turn, then it says what is left).
* **Multi-action turns are executed, not refused.** Previously two tool calls in
  one response were rejected outright. They are now parked as a single numbered
  confirmation and executed in order when the operator presses Run.
* **Honest reporting.** The summary is generated from actual tool return values;
  a failed tool is reported as failed and `executed` stays false.
* **Unknown tool names** no longer end the turn — the model is told and retries.
* Cancellation still executes nothing, and `delete_user` still always confirms.

**All 60 admin tools are tested for real effect**, not for a happy-looking
response: `tests/ai-tools.test.js` runs every tool against a throwaway database
and asserts the resulting database state (76 checks). One real bug was found and
fixed on the way: fulfilling a removal request deleted the request along with the
listing (FK cascade), so the "removed" outcome vanished from Admin → Removals.

* `migrations/2026-09-02-removal-requests-history.sql` (and the equivalent
  automatic migration in `src/db.js`) makes `removal_requests.listing_id`
  nullable `ON DELETE SET NULL`;
* both the AI tool and the admin route now resolve the request before deleting
  the listing, so the record survives.

### 3. Admin queues scroll inside their cards

Long lists no longer stretch the console into an extra-tall page. Two classes in
`public/css/app.css`, both modelled on the notifications inbox (contained, quiet
scrollbar, sticky table header, `overscroll-behavior: contain`):

* `.scroll-table` — wraps a `.table-wrap`;
* `.scroll-panel` — for card lists that are not tables.

Applied to: Listings, Ownership claims, Users, Categories, Pricing (free trials),
Advertising (currently sponsored + all listings), Careers (roles), Status (recent
incidents), Promos (codes), Protection (IP rules + domain rules), Health (mail
hops), Removal requests, Support tickets, Email (recent sends), Blog posts, and
Settings (recent Pro payments).

### 4. Tests

```
npm test            # everything
npm run test:ai     # AI tools + agent loop
npm run test:backup # .firmledger round trip
npm run test:pages  # every admin page renders and its list scrolls
```

| Suite | What it proves |
| --- | --- |
| `tests/ai-tools.test.js` | all 60 assistant tools really change the database |
| `tests/ai-agent.test.js` | chaining, batched confirmation, cancellation, honest failures (Groq stubbed — no key needed) |
| `tests/backup.test.js` | backup carries users + all listings + configuration, restores into an empty database, and is idempotent |
| `tests/admin-pages.test.js` | boots the real server and checks every admin page renders with its list in a scroll region |

`FIRMLEDGER_DATA_DIR` was added to `src/db.js` so suites run against a temporary
database and never touch `data/`.

---

# AI Playground Admin Area - Changes Summary (2026-09-01)

See git history for the previous round: model registry refresh, stateless
assistant (chat history removed), audit/moderation log deletion.
