# FirmLedger — change summary

## 2026-09-04 — Live status auto-refresh, auto-detected incidents, API tutorial

### 1. Status auto-refresh (public + admin)

The status area now updates itself. Both pages render their live region
server-side (so nothing breaks with JavaScript off) and then swap in a freshly
rendered fragment on an interval.

| Piece | Where |
| --- | --- |
| Public live fragment | `GET /status/live` — `views/status/live.ejs` |
| Admin live fragment | `GET /admin3119Musa/incidents/live` — `views/admin/status-live.ejs` |
| Poller + manual button | `public/js/main.js` (`[data-status-live]`, `[data-status-refresh]`) |
| Bar styling | `.st-live-bar` in `public/css/app.css` |

* **Public `/status`** refreshes every **30s**; **Admin → Status** every **20s**.
* **`Refresh now` button on both pages** — the fallback if polling is blocked.
  It calls the fragment with `?force=1`, which re-runs the probes first, so the
  reading is genuinely fresh rather than the last cached sweep.
* Polling pauses on a hidden tab and refreshes once on return. Failures degrade
  to "Auto-refresh unavailable — use Refresh now" instead of silently stalling.
* `mon.runChecksNow()` coalesces concurrent manual refreshes into one sweep, so
  a jammed button cannot stampede the probes.

### 2. Detected status is always shown, and always manageable

The monitor now opens incidents by itself and records what it saw.

* **Probe evidence persisted** — `status_components.last_note`,
  `last_latency_ms`, `last_checked_at`. Admin → Status shows the probe's own
  words ("HTTP 503", "SMTP unreachable", "timed out") with latency and check
  time, next to state and 24h uptime.
* **Auto incidents** — a failing probe opens a real incident with
  `incidents.source = 'auto'`, severity derived from the state. It appears on
  public `/status`, emails subscribers and lands in the admin inbox.
* **Self-healing** — a green probe closes the monitor's *own* incident and heals
  the component. A manual incident is never touched by the monitor.
* **Full admin control** — auto incidents are tagged `auto` in the console and
  carry the same Resolve / Post update / **Delete** controls. Deleting removes
  the row and its whole timeline from `/status`, from history and from the
  console, healing the component if nothing else holds it down.
* Migration: `migrations/2026-09-04-status-autodetect.sql`, mirrored in `src/db.js`.

### 3. New blog post — "Build your first FirmLedger integration"

A real, hands-on API tutorial at
`/blog/firmledger-api-tutorial-first-integration`, written against the actual
`/api/v1` code: keys and scopes, discovery, directory search with every real
filter and sort, sparse fieldsets, the domain check, owner CRUD, CSV export,
webhooks with HMAC and idempotency, and the exact error codes and limits.

* **Every code block is `<pre><code>`**, which `.blog-body pre` renders as a
  contained, horizontally scrollable box (`max-width:100%`, `box-sizing:border-box`)
  — long curl and JSON lines can never widen the 780px prose column on any screen.
* **It states plainly that a key is required for every endpoint, and that keys
  are a FirmLedger Pro feature**, linking to `/pricing`, `/dashboard/api`,
  the playground and `/api/docs`.
* `seedBlog()` is now **idempotent per slug**, so new posts reach existing
  deployments without a re-seed and without overwriting editorial edits.

### 4. Tests

```
npm test              # everything
npm run test:status   # status auto-refresh, auto-detection, the new post
```

`tests/status-live.test.js` (50 checks) boots the real server and asserts the
live regions, the fragments and their no-store headers, the forced re-probe,
auto incident open/close, manual incidents left alone, the admin fragment's
manage + delete controls, a real delete through the admin route, and the blog
post's layout, Pro/key messaging and contained code blocks.

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
