## 2026-09-10 (production audit #2) — Every console area, greetings that know the time

**New gate: `tests/ai-areas.test.js` (232 checks, in `npm test` / `npm run test:areas`).**
Every admin console area — Search, Inbox, Listings, News, Categories, Claims,
Users, Plan offers, Pricing, Advertising, Careers, Status, Promos, Protection,
Health, Removals, Tickets, Email, Blog, AI Playground, Settings and Maintenance —
is driven through the real chat pipeline (chatTurn → proposal → “yes, run it”)
and verified in the **database**, with an audit row required for every executed
action. Includes a safety sweep (dangerous phrasings across areas always propose
and park a confirmation; auto-run executes an opted-in write but a sensitive one
still asks; no orphaned proposals) and a guarantee that **every command suggested
by every area menu parses** (171 expanded lines).

**Conversational layer — greetings now know the real time of day.**
- “good morning / afternoon / evening / night”, “hello”, “hi”, “hey”, “greetings”,
  “goodnight” are answered with a greeting grounded in the server clock
  (morning 05–12, afternoon 12–17, evening 17–20, night otherwise) — and a
  gentle correction when the operator greets evening at breakfast.
- “what time is it?”, “what day is it?”, “what is the date today” answer from the
  clock; “how are you”, “who are you”, “are you a robot / chatgpt” get honest
  rule-engine answers; bare “thanks” is now thanked (it used to say “Hello!”).
- One clock implementation (`assistant.js`: `now/timeOfDay/clockText`, with a
  test-only pin `__setTestNow`) — the suites test all four day-parts and every
  boundary hour deterministically, plus the full flow over live HTTP.

**Area menus.** A bare area name (“pricing”, “plan offers”, “careers”,
“advertising”, “promos”, “protection”, “status”, “blog”, “inbox”, “ai playground”,
“maintenance” …) now opens a menu of real commands for that area instead of the
generic settings fallback — 23 menus, every line verified parseable.

**Bugs found and fixed by the new suite.**
- “maintenance status” / “show maintenance” proposed flipping maintenance **ON**
  (a status question must never mutate) — status/state/mode questions are now
  reads that report the real flag; only explicit on/off/take/bring wording writes.
- “resume promo CODE” failed with “Promo not found” — the verb “resume” was being
  swallowed as the promo code. (`resume` is now vocabulary → `on`.)
- “create blog post title=… body=… published” was hijacked by the
  publish/unpublish toggle rule and asked “Which post?”.
- “show plan 3” / “show package 4” listed everything instead of flipping that one
  record — the console’s Show/Hide semantics now win for the specific-id form
  (“show 5 plans” stays a list).

## 2026-09-10 (production audit) — Every admin action verified through chat

**Route audit.** Every admin route was compared against the assistant's tool list;
two genuine gaps were closed: `set_mail_keepalive` (Email → keep-alive on/off,
cadence, recipient, run now) and `regenerate_indexnow_key` (Indexing → rotate key).
129 tools total, all reachable from plain language.

**Understanding fixes.** Trailing reasons ("… because the domain is dead") are
captured as a slot instead of polluting the target; quoted text and message bodies
are never split on "and"/"then"; "link A with B as partner" works; API-key prefixes
are picked out of prose; "bulk/mass" no longer implies "all".

**Bugs found and fixed by the new suites.**
- `runPlans` crashed (TypeError) when a message mixed unparseable fragments with a
  clarifying question — e.g. SQL-looking garbage like `'; DROP TABLE listings; --`.
  Fragments are now filtered before running.
- Malformed JSON / oversized bodies on any route returned a 500 page that itself
  crashed (`error.ejs` rendered before session locals existed). Body-parser errors
  now answer 400/413 (JSON for API callers), and the 500 handler is
  render-failure-safe.

**Tests.** Two new suites in `npm test`: `ai-e2e` (147 checks — every mutating and
read tool driven through `chatTurn` in plain language and verified by DB rows) and
`ai-http` (38 checks — real server: session + CSRF, chat→execute→cancel contract,
hostile input never executes or 500s, audit rows, 50-turn latency budget, 20-way
concurrency, no leaked pending proposals). `ai-tools` 193, `ai-assistant` 55.

## 2026-09-10 (later) — Assistant covers the whole console; more templates

**10 new console tools** (127 at the time, all wired to the assistant): `review_listing_now`
(rule-based review or dry-run score of one listing), `set_moderation_thresholds`,
`edit_moderation_rules` (block/flag/allow-domain lines), `get_moderation_rules`,
`get_audit_log`, `get_moderation_log`, `list_protection_rules` (IP/domain rules +
rate limits), `list_mail_accounts`, `list_api_keys`, `revoke_api_key` (sensitive).

**Understanding.** ~120 new phrases ("what's pending", "briefing", "is everything
up", "what did I just do", "whitelist 8.8.8.8", "who owns…", "top 5…", "this
month", "never mind", "post a job", "make listing 2 live", "review it" …),
contractions expanded, bare plural queries ("pending listings", "listings in
Fintech", "listings from Kenya", "sponsored listings"), explicit id lists
("approve listings 1 2 3" → bulk), category lookup by partial name, domain / IP
protected as single tokens, `clear`/`live`/`review` no longer collide with
approve/pending. Honest "console-only" answers for restore-backup, 2FA
enrollment, sign-everyone-out and default trial length.

**Templates.** New formatters for health, global search, audit log, moderation
log/rules, protection rules, mail accounts, API keys and the review score; a
"briefing" template that lists what needs attention; more phrasing variants for
receipts, confirmations, cancellations and empty results; sensitive proposals
get their own wording plus a one-line impact note ("They are signed out and
cannot log in until unsuspended…"). Help topics added for moderation, audit,
protection, mail, backup and briefing. Extra starter chips in the chat pane.

**Tests.** `ai-tools` 191 checks (all 127 tools exercised), `ai-assistant` 50.

## 2026-09-10 — AI Playground: rule-based assistant, no models, no API keys

**Model/provider layer removed.** `src/lib/llm.js`, `src/lib/groq.js`, every
provider preset, API-key storage and the "Model providers" settings block are
gone. The `.env.example` provider section is replaced by a note. Nothing in the
admin area calls an external AI service any more, and there is no local model.

**Listing generator removed** from Admin → AI Playground (tab, route and
`generateListing`/`publishListing`).

**Email → "Rephrase with AI" removed** (`POST /admin3119Musa/email/rephrase`,
the button and its script).

**New admin assistant — `src/lib/assistant.js` (rule engine).** Replaces the
LLM agent behind the same chat UI and keeps the full 117-tool registry
(`aitools*.js`). Techniques: input normalisation + stemming + one-edit typo
repair, phrase/synonym expansion, ~150 ordered regex intents with resolvers,
slot extraction (ids, slugs, emails, ticket refs, IPs, domains, dates,
percentages, "N uses", quoted/`saying:` payloads, key=value pairs, ordinals,
recency phrases), name lookup with disambiguation ("which one? 1. … 2. …"),
multi-turn context carried in a hidden marker (pronouns "it/them/their" resolve
to the last listing/member/ticket), slot-filling questions with a state
machine that a fresh command can always escape, compound sentences
("approve 1 and then feature it"), confirmation for every write (typed
yes/no or buttons; sensitive writes always confirm), personalised receipts,
varied phrasing, proactive next-step quick replies, honest recovery with
"did you mean" suggestions, and audit rows for every turn and action.

**Auto-moderation is rule-based.** `scoreListing()` scores 0–100 from the
listing's own fields plus admin-editable rules (`block:`, `flag:`,
`allow-domain:`) and thresholds; approve / hold / reject with reasons in the
moderation log. Runs in the background on new submissions as before.

**Tools.** `list_listings` gained an `owner` filter; `list_users`,
`list_tickets`, `get_ticket` added; `get_ai_playground` reports the engine.

**Tests.** `tests/ai-agent.test.js`, `ai-playground.test.js` and
`ai-providers.test.js` replaced by `tests/ai-assistant.test.js` (38 checks);
`ai-tools` updated (178 checks). `npm run test:ai` runs both.

# FirmLedger — change summary

## 2026-09-09 — Trial countdown emails + in-app reminders, console scroll audit, email AI rephrase hardening

**Free-trial reminder ladder — every member gets told, in email AND in-app,
before and when their trial ends.** A new hourly sweep (`src/lib/trialreminders.js`,
running on the same server tick that expires finished trials) walks every active
trial and fires a milestone the moment it becomes due, each exactly once per
trial (`users.trial_reminders_sent` tracks the ladder, and a brand-new trial
clears it):

- **roughly halfway** (long trials only — 14 days → 7 to go, etc.),
- **a few days left** (fires when 2–3 whole days remain; subject carries the
  real count, so a sweep that misses a day is still accurate),
- **the final day**, and
- **trial ended** — sent once the account has genuinely dropped back to Free
  (within ~26h of expiry, so trials that ended before this feature existed are
  never re-mailed). Users who kept paid Pro are skipped, and the "ended" mail
  points at `/dashboard/upgrade`.

Each milestone is a real branded email through the normal mailer (outbox when
no SMTP is configured) **and** a bell notification on the member's dashboard.
The end-of-trial status flip already happened; now the member hears about it
too. Covered by a new suite (`tests/trial-reminders.test.js`, wired into
`npm test`) that places accounts at every stage — halfway, a few days left,
final day, just-expired Free, just-expired-but-paid — and asserts the exact
email subject, the in-app row, the one-time marker, and that a second sweep is
silent.

**Console scroll audit.** Every long surface in the admin area is contained, so
records piling up never stretch the page. The user detail page (their listings,
claims, tickets, paid invoices) now uses the console's standard `.scroll-table`
surfaces alongside the already-contained queues, and the admin page smoke suite
asserts the user detail page scrolls in place too.

**Email → Rephrase with AI hardened.** The button always resolves the exact
provider/key/model configured in **Admin → AI Playground → Settings → Model
providers** (with a fallback to that provider's default model when the saved
choice is no longer known), so it can never drift from what works in the
playground. The page now shows which provider/model will do the rewriting (or a
clear "no AI provider configured" hint), and failures come back as actionable
JSON (`ok:false, error, code`) — missing key, rejected key and empty-reply
cases each tell the operator exactly where to fix it instead of surfacing a
bare gateway error.

## 2026-09-09 — Admin: searchable pickers, AI Playground 502 fix, external email + AI rephrase

**Searchable pickers in the console.** Long `<select>` lists the admin has to
pick from now filter live: a small search box above the picker hides
non-matching options and shows "n of N matches". Implemented once in
`public/js/main.js` (`data-filter-for`) and used where it hurts most — the
**news "Add a story by hand"** listing picker (500 options) and the **listing
editor's ownership picker** (500 users). The news queue's filter box also
searches the submitter's email now, so a story can be found by who filed it.
No JS = no filtering, everything still works.

**AI Playground 502 errors fixed.** Every OpenAI-format call sent the legacy
`max_tokens` field. Groq deprecated that field in favour of
`max_completion_tokens` (their current API reference uses the new name for
every model), and OpenAI's reasoning families (o-series, GPT-5.x, GPT-OSS)
refuse `max_tokens` outright — so the default provider + model combination
400'd upstream, and the console surfaced it as a wall of 502s. The gateway
(`src/lib/llm.js`) now picks the token field per provider/model:
`max_completion_tokens` for Groq and for reasoning model ids, `max_tokens`
elsewhere. Groq's Qwen 3.6/3.8 additionally get `reasoning_format: hidden`
when tool calling or JSON mode is used (required by Groq for those models —
without it the request 400s). A transient upstream 5xx is retried once after
a short backoff before it reaches the console, so a provider blip no longer
surfaces as a hard error. New wire-format and retry assertions landed in
`tests/ai-providers.test.js`, and five stale Part-B assertions (the provider
grid became a picker + config card) were updated to match the current view.

**Email members: external recipients + AI rephrase.** Admin → Email now
accepts **external addresses** (comma-separated, anyone — no FirmLedger
account needed) on top of the existing audience groups and member search;
addresses are validated, de-duplicated and merged with the picked audience,
and the "To" picker is no longer the only way to send. The message box gained
a **Rephrase with AI** button that rewrites the draft — plain text in → plain
text out, HTML in → HTML out, `{{name}}` placeholders and links preserved —
using whatever provider/model is configured in the AI Playground
(`POST /admin3119Musa/email/rephrase`). The result lands back in the box for
review; the endpoint never sends mail.

## 2026-09-08 — Blog: how listing news works, plus a complete site overview README

**Blog post.** A new post ships in the seed (`src/lib/blogseed.js`), so every
install gets it at the top of `/blog`, in `/feed.xml` and in the sitemap:
*News on FirmLedger: what a profile is allowed to say about the news*. It follows
the existing post layout — `<p class="lead">` opener, `<h2>` sections, `<code>`
and lists — and explains the feature in the same voice as the rest of the blog:
what counts as a story here, the three doors it can arrive through, the accuracy
gate (full name as a phrase, or the company's own domain — everything else is
dropped), why member submissions wait for a moderator, the hourly upkeep that
keeps stories from going stale, and the list of things we deliberately don't do
(no machine-written summaries, no paid placement, no story without a citable link).

**New README.** `README_OVERVIEW.md` documents the whole site in one place: what
FirmLedger is, the eight-stage pipeline (ingest → normalize → resolve → score →
verify → moderate → enrich → publish), the anatomy of a listing profile with a
field-by-field provenance table, what visitors / members / owners / moderators can
each do, the three verification methods, what Pro unlocks and what stays free, a
map of every console area, the news layer and automated upkeep, the public API,
trust and safety, the indexing stack, email and notifications, the project layout,
the stack, how to run and test it, the six principles underneath, and a glossary.
`README.md` now points at it from the top instead of leaving a new reader to guess.

**Tests.** The news suite grew post-content checks (88 checks, up from 81) and the
API suite's blog ordering check now asserts the invariant that actually matters —
the production API guide sits above the announcement it supersedes — rather than
assuming it will forever be the newest post. All 12 suites pass.

## 2026-09-08 — Listing news: automatic detection, member submissions, moderation

Every profile can now carry what is being published about the company, and the
ledger keeps it honest in both directions.

**Detection.** A sweep searches a public news index (Google News RSS by default,
`NEWS_SEARCH_URL` to point it elsewhere) for each company. A story is stored
only if it clears the accuracy gate in `lib/news.js`: it carries the company's
**full name as a phrase** (legal suffixes stripped, so "Safari Fintech Ltd" and
"Safari Fintech Limited" are one company), or it sits on — or cites — the
company's **own domain** (the `<source url="…">` of wrapped feeds counts). A
partial name ("Safari" for "Safari Fintech"), a namesake, or unrelated coverage
is dropped: near-misses are never stored, and a failed scan records nothing
rather than guessing.

**Member submissions.** Anyone signed in can submit a story from
`/listing/:slug/news` (headline, link, publication, date, note). It lands in
`pending`, is invisible on the public profile, and notifies the console and the
owner. A moderator approves or rejects it in **Admin → News** — the submitter is
told either way, and the page shows them the status of their own submissions.
Duplicate links are refused, CSRF and the rate limiter apply, and guests are
sent to sign in first.

**The console.** Admin → **News** is one queue for all of it: pending
submissions to moderate, detected stories, stories written by hand (published
immediately, because a human wrote them), filters by status and origin, and the
sweep controls — *Check N due listings* / *Check all N listings* — with the same
background-runner contract as the technology radar (live progress, one run at a
time, stoppable, last run recorded). Each listing's edit page has its own News
panel: its stories, **Look for stories now**, and add-one-by-hand. Detected
stories can be held for moderation instead of publishing (`news_review_auto`).
The assistant gained `approve_news` / `reject_news` (63 tools).

**Automated upkeep** (the scheduled sweep that was still missing): an hourly
job, on by default, that refreshes stale technology snapshots and re-checks
news coverage — capped per hour, per-job switchable, and clamped when saved.
Admin → Settings → **Automated upkeep** carries the switches, the caps, the
last run and a **Run upkeep now** button. The console's own buttons are
unaffected by the schedule.

```
npm test                          # 12 suites
node tests/news-upkeep.test.js    # 81 checks, fully offline
```

---

## 2026-09-08 — Admin → Listings: refresh the technology radar (one, a selection, or all)

Keeping every profile's technology snapshot honest is now a first-class admin
maintenance job instead of something that only happens when a record is created
or an owner clicks refresh on their own listing.

**One place, five ways to run it** — every path lands on the same engine in
`src/lib/techrefresh.js`, which calls the existing detector in `lib/enrich.js`:

| Where | Action |
| --- | --- |
| Admin → Listings, row button **↻ Tech** | re-scans that one company |
| Admin → Listings → edit → **Technology radar** panel | shows the current chips + scan date, refreshes in place |
| Bulk action **Refresh technology radar** | any ticked rows — every row is tickable now, not only pending ones |
| **Refresh all N in this view** | exactly the rows the current filter renders |
| **Refresh N stale** / **Refresh entire directory (N)** | never-scanned or older than 90 days, or every listing with a website |

**It runs in the background.** A run takes a pool of four homepages at a time
(8s timeout each), never stacks a second run on top of a live one, can be
**Stop**ped mid-flight, and reports `done / changed / unchanged / without a
website / failed` live on `/admin3119Musa/listings/tech-job.json` — the page
polls it and reloads when the run lands. The last run's summary is kept on the
page, and the console gets an in-app notification when a run finishes.

**Nothing is invented.** A page that answers nothing gets `0 technologies`
recorded with today's scan date, a listing with no website is reported as
skipped (never "scanned successfully"), and a real change to a stack still
notifies the listing's watchers exactly as an owner-triggered refresh does.
The new **Tech** column and the **Any tech scan / Never scanned / Stale / Fresh**
filter make the backlog visible, and the admin dashboard carries the stale
count with a one-click shortcut.

The assistant can do it too: `refresh_listing_tech` (61 tools now) re-scans a
listing by id or slug from the AI Playground.

```
npm test                            # 11 suites
node tests/admin-tech-refresh.test.js   # 66 checks, fully offline
```

---

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
| `tests/ai-tools.test.js` | all 113 assistant tools really change the database, and sensitive ones can never be auto-run |
| `tests/ai-agent.test.js` | chaining, batched confirmation, cancellation, honest failures (model stubbed — no key needed) |
| `tests/ai-providers.test.js` | every provider dialect on the wire (OpenAI, Anthropic, Gemini, Cohere), key resolution, provider switching, fallback, rate limits + the Playground console UI |
| `tests/backup.test.js` | backup carries users + all listings + configuration, restores into an empty database, and is idempotent |
| `tests/admin-pages.test.js` | boots the real server and checks every admin page renders with its list in a scroll region |
| `tests/admin-tech-refresh.test.js` | technology-radar maintenance end to end, offline: one listing, a selection, a filtered view, stale and whole-directory runs, the single-run lock, cancellation, CSRF and the tech filter |
| `tests/news-upkeep.test.js` | the news accuracy gate (name, domain, near-miss and wrapped-link cases), detection, member submission → pending → approval, console moderation, background sweeps and the hourly upkeep schedule |

`FIRMLEDGER_DATA_DIR` was added to `src/db.js` so suites run against a temporary
database and never touch `data/`.

---

# AI Playground Admin Area - Changes Summary (2026-09-01)

See git history for the previous round: model registry refresh, stateless
assistant (chat history removed), audit/moderation log deletion.
