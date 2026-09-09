# FirmLedger — the complete overview

> **What this site is, how it works end to end, and every feature in one place.**
>
> Companion documents, each with a different job:
> **[README.md](README.md)** — install, deploy, day-to-day operations ·
> **[README2.md](README2.md)** — architecture and request flows ·
> **[README3.md](README3.md)** — server resources and hosting ·
> **[ERD.md](ERD.md)** — the database, table by table.

---

## 1 · What FirmLedger is

FirmLedger is a **verified business record layer** — a public directory of companies,
startups, agencies, organisations, products, services and publishers where every
record shows where its facts came from.

It is deliberately not a reviews site, not a crawler that guesses, and not a
marketplace of claims. A profile on FirmLedger is a small, checkable dossier:

- **who the company is** — name, category, location, size, founding year, contact details
- **where the facts came from** — a visible source trail, including the company's own website
- **how confident we are** — a confidence score (corroboration) and a FirmLedger Score (completeness)
- **whether the owner is verified** — proved live against the company's domain
- **how the company is wired into its market** — a relationship graph of investors, parents, products and partners
- **what it runs** — a technology radar detected from its own homepage
- **what is being published about it** — a news panel, gathered and moderated
- **what happened and when** — a timeline of real events

Anyone can read it. Owners can claim and maintain it. A moderation team sits
between a change and the public.

**One process, one database.** Node.js + Express, server-rendered EJS, SQLite in
WAL mode. No frontend build step, no external services required to boot.

---

## 2 · How it works — the pipeline

Every record travels the same path. Each stage exists to answer one question, and
each one can say "no".

```
                    ┌────────────────────────────────────────────────────────┐
   SUBMISSION       │  Owner submits · Admin adds · Wikipedia/Wikidata fetch │
                    └───────────────────────┬────────────────────────────────┘
                                            ▼
   1 · INGEST       Fields arrive from a real source or a typed form. Enrichment
                    reads Wikipedia + Wikidata and imports only citable fields.
                    If no genuine article exists, it says so and invents nothing.
                                            ▼
   2 · NORMALIZE    Names collapse to one spelling, categories dedupe
                    case/punctuation-insensitively ("Fintech" ≠ "fintech "),
                    locations split into country/city/region, logos resize to 256×256.
                                            ▼
   3 · RESOLVE      One business, one record. Name and website domain are checked
                    against the ledger; a duplicate is refused and the submitter is
                    pointed at the existing profile (and offered the claim flow).
                                            ▼
   4 · SCORE        Confidence score (are the facts corroborated?) and
                    FirmLedger Score (how complete is this record?) are computed
                    from real fields only — never from a guess.
                                            ▼
   5 · VERIFY       Optional but decisive: the owner proves control of the domain
                    by DNS TXT record, a meta tag, or the FirmLedger badge.
                    Checked live, at the moment it is requested.
                                            ▼
   6 · MODERATE     A human approves or rejects. Structural edits by a verified
                    owner go back through the same queue. Nothing publishes by itself.
                                            ▼
   7 · ENRICH       On approval (and on demand afterwards): the technology radar
                    scans the public homepage; the news layer searches for coverage.
                    Both are re-runnable, both are auditable, both can come back empty.
                                            ▼
   8 · PUBLISH &    Sitemap entry, IndexNow ping, Google Indexing API ping,
      KEEP FRESH    RSS feed entry — then hourly upkeep keeps tech snapshots and
                    news from going stale.
```

**The rule that ties it together:** anything that cannot be traced to something a
stranger can check does not go on a profile. An empty panel is an honest answer; a
plausible guess is not.

---

## 3 · Anatomy of a listing profile

| Part | What it shows | Where the data comes from |
|---|---|---|
| **Identity** | Name, type, category, tagline, description, logo | Submission or Wikipedia/Wikidata |
| **Facts** | Founded, team size, address, country/city/region, tags | Submission or enrichment |
| **Contact** | Website, email, phone, social profiles | Submission, socials detected during enrichment |
| **Confidence score** | 0–97 — how strongly the record is corroborated | Sources, verified ownership, review state |
| **FirmLedger Score** | 0–100 dial — profile health and completeness | Field completeness (48), independent sources (12), verified ownership (10), verification date (6), freshness (8), timeline (4), relationships (4), technology (4), social proof (4) |
| **Sources & provenance** | Every cited URL, with the record date | The enrichment article, the official website, contributor citations |
| **Timeline** | Dated events: founding, funding, product, leadership, acquisition | Owner or console, one event at a time |
| **Relationship graph** | Investors, parents, subsidiaries, products, partners, founders | Recorded relations, rendered as a live graph |
| **Technology radar** | Frameworks, CMS, payments, analytics, CDN, hosting | Detected from the company's own homepage (HTML, meta generator, headers) |
| **News** | Headline, publication, date, link to the story | Detected from a public news index under an accuracy gate, or submitted by a member and moderated |
| **Hiring signal** | A careers link found on the homepage | Detected during the technology scan |
| **Jobs** | Openings posted by Pro owners | Owner's dashboard |
| **FAQs** | Answers generated from the record's *own* fields | Computed per listing — never hand-written boilerplate |
| **Freshness marker** | How recently the record was touched | `updated_at` |

Every public profile also carries: a watchlist star (logged in), an add-to-compare
control, a removal request link, a claim link, and structured data
(`Organization` + `FAQPage` JSON-LD) for search engines.

---

## 4 · What anyone can do without an account

| Area | What's there |
|---|---|
| **Home** | Live counters, featured rail, newest verified companies, category shortcuts |
| **Directory** (`/directory`) | Filter by category, country, type, Pro status; sort by newest, confidence, name; paginated |
| **Search** (`/search`) | Global search across companies, blog posts and docs |
| **Profiles** (`/listing/:slug`) | Everything in §3 that is public — identity, sources, score, graph, radar, news, FAQs |
| **Compare** (`/compare`) | Put up to four companies side by side |
| **Jobs board** (`/jobs`) | Openings posted by Pro companies |
| **Docs** (`/docs`) | Plain-language explanations of scoring, claiming, the radar, indexing, removal, the API |
| **Blog** (`/blog`) | Methodology notes and release write-ups, plus an RSS feed |
| **Status** (`/status`) | Live component health, incidents, uptime history, subscribe to updates |
| **Business pages** | Pricing, advertise, careers, about, privacy, terms |
| **Machine-readable** | `/sitemap.xml` (+ child sitemaps), `/feed.xml`, `/robots.txt`, `/api/docs` |

**Free vs Pro on the public site:** browsing the directory, reading profiles and
searching are free and always will be. FirmLedger Pro unlocks the *full* record —
public contact details, social links, the events timeline and the relationship
graph — plus API keys and job posting.

---

## 5 · Accounts: what members get

**Signing up.** Register with an email (a one-time code confirms the inbox before
the account exists), or sign in with Google or LinkedIn. Sessions are
httpOnly cookies; CSRF protects every state-changing form; the whole site is
rate-limited per bucket (login, register, listing, claim, newsletter, search).

**Your dashboard:**

| Page | What it does |
|---|---|
| **Overview** | Your listings, their status, and shortcuts |
| **Add / edit a listing** | The full submission form, with duplicate guards and an optional "fetch from Wikipedia" |
| **Refresh technology** | Re-scan your homepage and refresh the radar on demand |
| **Timeline & relations** | Add events and relationships on listings you own |
| **Watchlist** | Companies you star; you get a digest when a record changes |
| **Jobs** | Post openings on a Pro listing; they appear on the profile and `/jobs` |
| **Notifications** | In-app inbox with archive and trash |
| **Security** | Password change, TOTP two-factor with recovery codes |
| **API keys** | Create scoped keys, watch usage, revoke instantly (Pro) |
| **Support** | Ticket threads with the moderation team |
| **Billing / upgrade** | Plans, trials, promo codes, payment history |
| **Settings** | Newsletter preference, account details |
| **Delete account** | A request that goes to the moderation queue |

**Ownership.** Submitting a listing makes you its submitter. *Claiming* it —
proving the domain — makes you its verified owner and transfers editorial control
to you. The original submitter is remembered on the record.

---

## 6 · Ownership verification (three methods)

All three prove the same thing — that you control the company's official domain —
and all three are checked live, by our servers, the moment you press verify. There
is no human in the loop and no waiting period.

| Method | What you add | Best for | Watch out for |
|---|---|---|---|
| **DNS TXT** | `firmledger-verification=<token>` | Anyone with registrar/DNS access; survives site redesigns | Propagation (wait ~10 min, re-check unlimited) |
| **Meta tag** | `<meta name="firmledger-verification" content="<token>">` in `<head>` | Site owners and CMS users — usually fastest | Must be in served HTML, not injected by JavaScript |
| **FirmLedger badge** | The badge snippet anywhere on the homepage | Anyone who can edit page content but nothing technical | Keep it in place; removing it can revert the claim |

Verified ownership raises the confidence score, shows the ✓, unlocks editing from
your dashboard, and — because edits still pass moderation — never lets a verified
owner publish structural changes unreviewed.

---

## 7 · FirmLedger Pro

| | Free | Pro |
|---|---|---|
| Browse directory, profiles, search | ✓ | ✓ |
| Submit listings | ✓ | ✓ |
| Claim and verify a business | ✓ | ✓ |
| **Full record**: contact details, socials, timeline, relationship graph | — | ✓ |
| API keys + REST access | — | ✓ |
| Post jobs on your listing | — | ✓ |
| Premium badge on your profile and badge image | — | ✓ |

**Prices** (editable in the console): **$30 / 30 days** and **$300 / 365 days**
(two months free). Payments run through PayPal; every payment is recorded with its
order id and reference. **Trials**: a 14-day self-serve trial from `/pricing`, and
the console can grant any length up to 90 days. **Promo codes** carry a percentage,
a usage cap, an optional expiry and an optional plan lock.

Pro is account-level: one subscription opens every listing on the site for you.
The console can also boost a *single listing record* independently of its owner's
plan, and sponsored placements on the homepage are a separate, clearly labelled
product.

---

## 8 · The admin console

Signed in at `/admin3119Musa` behind a three-step chain (secret code → emailed
one-time code → authenticator or recovery code).

| Area | What it's for |
|---|---|
| **Overview** | Counters for everything needing attention, latest submissions |
| **Listings** | Search and filter (status, type, category, claimed, plan, tech freshness), approve/reject/edit/delete, feature, grant or revoke Pro, bulk approve/reject, **technology radar maintenance** (one record, a selection, the whole filtered view, everything stale, the whole directory) |
| **News** | The news queue: member submissions to moderate, detected stories, hand-written stories, detection sweeps with live progress, and the "hold detected stories for review" switch |
| **Categories** | Create, rename, merge usage, delete |
| **Claims** | Review ownership claims, re-check verification live, reject |
| **Users** | Search, suspend, reset passwords, grant or revoke Pro and trials, email, delete with a confirmation mail |
| **Plan offers / Pricing** | Edit Pro offers and prices, grant and revoke trials |
| **Advertising** | Sponsored packages and placements |
| **Careers** | Role postings for the public careers page |
| **Status** | Components, incidents, updates, subscribers |
| **Promos** | Discount codes with caps and expiries |
| **Protection** | IP and email-domain blocklists, per-bucket rate limits, maintenance mode |
| **Health** | Disk, database size, memory, uptime, mail hops, backups |
| **Removals** | Removal and correction requests; dismiss or remove the listing |
| **Tickets** | Support threads with replies, status and auto-close rules |
| **Email** | Compose to one member, a segment, or everyone |
| **Blog** | Write, edit, publish — posts flow to `/blog`, the footer, RSS and the sitemap |
| **AI Playground** | An assistant that runs real console actions (113 tools — the whole admin surface) behind confirmations, with 20 sensitive actions locked to always-confirm, on any of 18 model providers. **Any selected model executes admin queries for real**: if the picked model has no tool calling, the action transparently runs on a tool-capable model (same provider first, then another configured one) and the reply names the model that ran. A reply that executed nothing is stamped “No console action ran in this turn”, so the assistant can never report a change that did not happen |
| **Inbox / Search** | Admin notifications; global search across users, listings, tickets, claims and posts |
| **Settings** | Moderation and indexing switches, IndexNow key, Google Indexing API, **automated upkeep**, console 2FA, SMTP providers, environment view |

Nothing in the console is a "quick script": every action writes through the same
event boundary as the rest of the app, so webhooks, notifications and audit trails
stay consistent no matter which surface triggered the change.

---

## 9 · The news layer

Profiles can carry published coverage of the company. Three kinds of story exist,
and the record always remembers which one it is:

| Kind | How it arrives | Published? |
|---|---|---|
| **Detected** | A sweep searches a public news index (Google News RSS by default; `NEWS_SEARCH_URL` points it elsewhere) | Immediately — but only after clearing the accuracy gate |
| **Submitted** | A signed-in member fills in `/listing/:slug/news` | No — held in **pending** until a moderator approves |
| **Written here** | A moderator adds it from the console | Yes, immediately — a human chose it |

**The accuracy gate.** A story is stored only if it carries the company's **full
name as a phrase** (legal suffixes stripped, so "Safari Fintech Ltd" and "Safari
Fintech Limited" are one company) **or** it sits on — or cites — the company's
**own domain** (including the publisher link of a wrapped news feed). A partial
name, a namesake, or unrelated coverage is **dropped**, not demoted. A scan that
finds nothing records nothing.

**Submissions.** Rate limited, CSRF-protected, duplicate links refused, guests sent
to sign in first. Pending stories are invisible publicly; the console and the owner
are notified; the submitter sees the status of their own stories. Approving or
rejecting tells the submitter which way it went.

**Freshness.** Stories are capped per profile (the freshest twelve), re-checked on
a schedule, and re-scannable per listing with **Look for stories now**.

---

## 10 · Automated upkeep

An hourly sweep, **on by default**, that keeps records from going stale without
anyone clicking:

| Job | What it does | Default cap |
|---|---|---|
| **Technology** | Re-detects the stack of listings whose snapshot is missing or older than the stale window (90 days) | 25 per hour |
| **News** | Re-checks news coverage for listings not looked at recently | 20 per hour, re-check after 7 days |

Both are switchable independently, both clamp their limits on save, and both hand
the work to the same background runners the console uses — so they never stack two
runs, never block a request, and can be watched live and stopped. The console's own
buttons ignore the schedule entirely.

---

## 11 · The public API

`/api/v1`, key-authenticated (`Authorization: Bearer fl_live_…`). Keys are created
by Pro members, shown once, stored as a SHA-256 hash, and scoped.

| Scope | Grants |
|---|---|
| `read:listings` | Directory, profiles, filters, categories, countries, suggestions, domain verification |
| `write:listings` | Create, update and delete your listings |
| `export` | CSV export of the ledger |
| `manage:webhooks` | Create and manage webhook endpoints |
| `read:usage` | Usage analytics and rate-limit snapshots |

Endpoints cover: listings and directory, "my listings", categories, countries,
suggest, domain verification, CSV export, webhooks, usage and health. Rate limits
(default 60 reads/min and 20 writes/min per key, plus a global write ceiling) come
back in `X-RateLimit-*` headers. Every response carries a stable error code
(`missing_key`, `pro_required`, `rate_limited`, …). Full reference at **`/api/docs`**.

**Webhooks** fire on `listing.created`, `listing.approved`, `listing.rejected`,
`listing.updated`, `listing.deleted` and `claim.verified`. Each is signed and
retried, routes to a URL on your own infrastructure, and keeps a delivery log in
Settings.

---

## 12 · Trust, safety and moderation

- **Human moderation** — submissions are approved or rejected by a person; structural edits by verified owners re-enter the queue.
- **Removal and correction** — anyone can file a request from a profile; it lands in the same queue, with a public moderation log.
- **Spam controls** — IP and email-domain allow/block lists, per-bucket rate limits, a light scraper ceiling that never touches robots.txt, sitemaps, the feed or verified search bots.
- **Console security** — the three-step admin chain with single-use email codes (10-minute expiry, one resend per minute), TOTP with recovery codes, and a settings page that can reset enrollment.
- **Member security** — email-verified registration, optional TOTP with recovery codes, password reset tokens, session revocation on suspension.
- **Backups** — a complete `.firmledger` file from Admin → Health (users, listings, configuration) that restores into an empty database and can be imported in Users.
- **Maintenance mode** — a branded holding page that leaves the console and status page up.
- **Privacy** — no third-party trackers; the verification badge does not track anyone; newsletters unsubscribe in one click.

---

## 13 · Search and discovery

| Mechanism | What it does |
|---|---|
| **Canonical URLs** | One URL per page (trailing slashes 301), one host per site (www → apex) |
| **Sitemaps** | `/sitemap.xml` indexing static pages, listings, categories and locations — generated with real last-modified dates, no fragment URLs |
| **IndexNow** | Approved listings are pinged automatically; the key is served at `/:key.txt` and rotatable in Settings |
| **Google Indexing API** | Optional service-account integration, 200 submissions per day, a "never ping twice" ledger and an auditable log |
| **Structured data** | `Organization` + `FAQPage` JSON-LD on every profile, breadcrumbs on every page |
| **RSS** | `/feed.xml` carries listings and blog posts |
| **Robots** | Generated `robots.txt`; the whole site is `noindex` until `BASE_URL` is a public origin |

---

## 14 · Email and notifications

- **Multi-provider SMTP** with automatic failover (`SMTP_URL`, `SMTP2_URL`, … or providers added in Settings), a single From address, and an outbox fallback when nothing is configured.
- **Branded templates** for verification, approvals, claims, trials, payments, digests and security alerts.
- **In-app notifications** for members (bell) and the console (Inbox), with archive, trash and expiry.
- **Watchlist digests** fire when a watched record changes — including a refreshed technology stack.
- **Newsletter** — a weekly "new verified companies" digest, cadence configurable (daily/weekly/monthly), one-click unsubscribe.
- **Status subscribers** get incident updates from `/status`.

---

## 15 · Where things live

```
server.js                 Express bootstrap, security headers, hourly jobs, 404/500
src/db.js                 SQLite schema + migrations + settings helpers
src/routes/               public · auth · dashboard · billing · claim · admin · adminops · adminai · api · status
src/lib/                  enrichment · verify · claimflow · score · news · techrefresh · upkeep ·
                          indexing · googleIndexing · graph · categories · notifications · notify ·
                          mailer · plans · paypal · promos · advertising · careers · backup ·
                          spam · maintenance · health · statusMonitor · ai · aitools · docs · …
views/                    EJS templates (public, dashboard/, admin/, blog/, partials/)
public/                   css, js, fonts, assets (no build step)
migrations/               SQL migrations
tests/                    12 suites, `npm test`
data/                     firmledger.db, uploads, outbox, backups (gitignored)
```

**Stack:** Node 20+ · Express 4 · EJS · better-sqlite3 (WAL) · sharp · nodemailer ·
multer · passport (Google, LinkedIn) · googleapis · qrcode · bcryptjs. No bundler,
no queue, no external database.

---

## 16 · Running it

```bash
npm install
cp .env.example .env      # set BASE_URL and ADMIN_SECRET at minimum
npm start                 # http://localhost:3000
npm run dev               # reloads on change
npm test                  # 12 suites
```

`ADMIN_SECRET` opens the console; `BASE_URL` decides whether search engines are
allowed to index. Everything else — payments, SMTP, OAuth, IndexNow, Google
Indexing, the AI assistant — is optional and degrades to a switched-off state
rather than a broken one. Deployment, systemd, Caddy and backup routines live in
[README.md](README.md); the machine-level resource story is in
[README3.md](README3.md).

**Tests** (`npm test`, 12 suites, all offline):

| Suite | Proves |
|---|---|
| **AI admin tools** | all 113 assistant tools really change the database, and sensitive ones can never be auto-run |
| **AI agent loop** | chaining, batched confirmation, cancellation, honest failures (model stubbed) |
| **AI model providers** | Groq / OpenAI / Claude / Gemini / DeepSeek / Hugging Face / OpenRouter + 11 more: wire formats, key resolution, switching, fallback, rate limits, console UI |
| **Backup round trip** | `.firmledger` export and restore into an empty database |
| **Admin pages** | every console page renders; long lists scroll in place |
| **Admin technology refresh** | technology radar maintenance end to end |
| **Listing news & upkeep** | the news accuracy gate, moderation, sweeps and the hourly schedule |
| **Admin 2FA chain** | the full admin sign-in chain with real mail |
| **API surface & discovery** | key auth, scopes, discovery and rate limits |
| **Google Indexing + featured rail** | Indexing API (stubbed), the never-ping-twice ledger, the 200/day quota, featured rail |
| **Indexing health (crawl view)** | one URL per page, one host per site, sitemap hygiene, crawler-safe limits |
| **Robots & Auth OAuth** | robots.txt behaviour and OAuth wiring |
| **Status monitor accuracy** | `/status` accuracy — no false outages, real healing |

---

## 17 · The principles underneath

1. **Provenance beats volume.** One fact a stranger can re-check is worth more than ten nobody can.
2. **Nothing is invented.** If enrichment finds no article, the record says so. If a scan finds no technologies, the panel is empty. If no news clears the gate, there is no news.
3. **One business, one record.** Duplicates are refused at the door, so sources, timelines and verification never scatter.
4. **Ownership is proven, not claimed.** Control of a domain, checked live — not an email address.
5. **Humans decide what the public sees.** Automation proposes; a moderator disposes.
6. **Every surface writes through the same door.** Console, dashboard, API, assistant and AI all land on one event boundary, so nothing silently skips the record.

---

## 18 · Glossary

| Term | Meaning |
|---|---|
| **Confidence score** | How strongly a record's facts are corroborated (sources, verification, review) |
| **FirmLedger Score** | 0–100 profile health: completeness, sources, ownership, freshness, coverage |
| **Claim** | Proving control of a company's domain to take over its record |
| **Technology radar** | Technologies detected from a company's public homepage |
| **News gate** | The name-or-domain test a story must pass before it is stored |
| **Upkeep** | The hourly sweep that refreshes stale technology snapshots and news |
| **Relationship graph** | Investors, parents, products, partners and founders linked to a record |
| **Freshness** | How recently a record — or one of its snapshots — was last checked |
| **Pro** | The account-level subscription that opens full records, the API and job posting |
| **IndexNow** | The instant crawl-ping protocol search engines accept |
