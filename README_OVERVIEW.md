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
record shows where its facts came from, and where being listed turns into being
contacted: visitors inquire, owners get **leads**, and the site tracks the whole
journey from first impression to won deal.

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
- **who wants to talk to it** — inquiries from visitors, delivered as leads to the owner

Anyone can read it. Anyone can contact a listed business. Owners can claim and
maintain their records, watch their conversion funnel, and get a weekly report on
how their listings performed. A moderation team sits between a change and the public.

**One process, one database.** Node.js + Express, server-rendered EJS, SQLite in
WAL mode. No frontend build step, no external services required to boot.

---

## 2 · How it works — the record pipeline

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

## 3 · How it works — the business pipeline

Getting listed is only half the story. The other half is what a listing *earns*,
and the site measures every step of it:

```
   EXPOSURE         Sponsored placements + homepage Featured rail
                    (every card view recorded as an impression)
                                            ▼
   ATTENTION        Profile views + clicks through to the company website
                                            ▼
   CONTACT          A signed-in member sends an inquiry from the profile → a LEAD
                                            ▼
   QUALIFICATION    The owner works the lead: contacted → qualified → won/lost
                                            ▼
   REPORTING        Funnel analytics on the dashboard + a weekly leads report
                    by email and/or in-app notification
```

The owner never has to set any of this up. Impressions and views are recorded
automatically (bots, admins and the owner's own views are excluded), the inquiry
form appears on every claimed listing that can actually receive one, and the funnel panel on
`/dashboard/analytics` turns the raw events into a plain-English headline such as
*"Your FirmLedger listings generated 37 leads this month, including 6 qualified
leads and 2 won opportunities."*

---

## 4 · Anatomy of a listing profile

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
| **Contact panel** | "Contact this business" → a signed-in member sends the owner a lead, then both keep talking in one thread | The member, at that moment — their account name and email are attached automatically |
| **Freshness marker** | How recently the record was touched | `updated_at` |

Every public profile also carries: a watchlist star (logged in), an add-to-compare
control, a removal request link, a claim link, and structured data
(`Organization` + `FAQPage` JSON-LD) for search engines.

---

## 5 · What anyone can do without an account

| Area | What's there |
|---|---|
| **Home** (`/`) | Live counters, sponsored strip, Featured rail, newest verified companies, category shortcuts |
| **Directory** (`/directory`) | Filter by category, country, type, Pro status; sort by newest, confidence, name; paginated; relevance-matched sponsored cards inline |
| **Search** (`/search`) | Global search across companies, blog posts and docs, with query-matched sponsored hits on top |
| **Category pages** (`/directory/c/…`) | One landing page per category (and per category × location), each with matching sponsored cards |
| **Profiles** (`/listing/:slug`) | Everything in §4 that is public — identity, sources, score, graph, radar, news, FAQs — plus the contact panel (sign in to use it) |
| **Compare** (`/compare`) | Put up to four companies side by side |
| **Jobs board** (`/jobs`) | Openings posted by Pro companies |
| **Docs** (`/docs`) | Plain-language explanations of scoring, claiming, the radar, indexing, removal, the API |
| **Blog** (`/blog`) | Methodology notes and release write-ups, plus an RSS feed |
| **Status** (`/status`) | Live component health, incidents, uptime history, subscribe to updates |
| **Business pages** | Pricing, advertise, careers, about, privacy, terms |
| **Machine-readable** | `/sitemap.xml` (+ child sitemaps), `/feed.xml`, `/robots.txt`, `/api/docs` |

**Free vs Pro on the public site:** browsing the directory, reading profiles and
searching are free and always will be. Contacting a verified business is free for
any **signed-in member** — a free account is enough, and the conversations a
member starts stay readable under **Sent** forever. FirmLedger Pro unlocks the
*full* record for viewing (public contact details, social links, the events
timeline and the relationship graph), plus API keys, job posting, and reading and
managing the leads a business receives.

---

## 6 · Accounts: what members get

**Signing up.** Register with an email (a one-time code confirms the inbox before
the account exists), or sign in with Google or LinkedIn. Sessions are
httpOnly cookies; CSRF protects every state-changing form; the whole site is
rate-limited per bucket (login, register, listing, claim, lead, newsletter, search).

**Your dashboard:**

| Page | What it does |
|---|---|
| **Overview** | Your listings, their status, and shortcuts |
| **Add / edit a listing** | The full submission form, with duplicate guards and an optional "fetch from Wikipedia" |
| **Leads** | Two boxes on one page: **Received** — inquiries on your listings, with reply, status (new → contacted → qualified → won/lost), private notes, archive and permanent delete (Pro to read/manage) — and **Sent** — every conversation you started with a business, always free |
| **Analytics** | Views, website clicks, top locations, per-listing totals — and the conversion funnel with its plain-English headline |
| **Refresh technology** | Re-scan your homepage and refresh the radar on demand |
| **Timeline & relations** | Add events and relationships on listings you own |
| **Watchlist** | Companies you star; you get a digest when a record changes |
| **Jobs** | Post openings on a Pro listing; they appear on the profile and `/jobs` |
| **Notifications** | In-app inbox with archive and trash |
| **Security** | Password change, TOTP two-factor with recovery codes |
| **API keys** | Create scoped keys, watch usage, revoke instantly (Pro) |
| **Support** | Ticket threads with the moderation team |
| **Billing / upgrade** | Plans, trials, promo codes, payment history |
| **Settings** | Newsletter preference, weekly-leads-report channel (notification / email / both / none), account details |
| **Delete account** | A request that goes to the moderation queue |

**Ownership.** Submitting a listing makes you its submitter. *Claiming* it —
proving the domain — makes you its verified owner and transfers editorial control
to you. The original submitter is remembered on the record.

---

## 7 · Leads: from inquiry to won deal

Any **signed-in FirmLedger member** can contact any claimed (verified-owner)
business straight from its profile — a free account is enough, and no Pro is
needed on either side to start or continue a conversation. The member's account
name and email are attached automatically, so the business is always replying to
a real account. That inquiry becomes a **lead** in the owner's dashboard, and the
owner works it through a simple pipeline:

```
member fills the contact form → owner is notified instantly (in-app + email)
→ lead lands in the Leads inbox as "new"
→ both sides keep talking in ONE thread (owner: Received · member: Sent)
→ contacted → qualified → won (or lost)
```

- **The panel only appears when an inquiry would be accepted.** One rule
  (`leads.contactState`) decides both: claimed, published, and a live owner
  account. Unclaimed records, records still in review, records whose owner deleted
  their account, and suspended owners show no form at all — nobody ever types a
  message into a dead end.
- **Receiving is free, reading is Pro.** A Free owner never misses business: every
  inquiry is stored, counted and notified. But opening the inbox, reading messages
  and managing statuses requires FirmLedger Pro — the upgrade incentive that never
  blocks a customer from reaching a business. The member's own **Sent** box is
  always free, so the person who asked is never locked out of the answer.
- **The owner's address stays private.** Inquiries arrive through FirmLedger; the
  inquirer never sees the owner's email. The owner sees the member's address and
  can also reply by email — the alert carries it as the reply-to.
- **One email per side, then notifications.** The opening inquiry emails the
  business; the business's first reply emails the member. Everything after that is
  an in-app notification, so long threads cannot flood anybody's inbox.
- **Nothing typed is ever lost, and nothing is silently cut.** The limits in the
  HTML are the limits on the server (message 10–4,000 characters, subject 140): an
  over-long submission is refused with the limit named, and a refused submission
  comes back with every field re-filled — once.
- **Double submits fold instead of duplicating.** The same inquiry posted twice in
  ten minutes returns the member to the conversation already open; the same reply
  posted twice in a minute is stored once. Submit buttons lock after a valid post
  as well.
- **Spam is stopped at the door.** Honeypot field, per-IP rate limits on both
  writes (new inquiries *and* thread replies, both tunable in Admin → Protection),
  email-domain screening, CSRF and validation — a bad post bounces back to the
  form with an error, never into the inbox.
- **Every lead feeds the funnel.** Status changes flow into the conversion funnel
  (§8) and the weekly report (§10), so "qualified" and "won" actually mean
  something measurable.

---

## 8 · Owner analytics and the conversion funnel

`/dashboard/analytics` answers two questions: *who looked at my listings?* and
*what did it turn into?*

**Traffic.** Profile views, clicks through to the company website, top
countries/cities, per-listing totals and trend windows — all counted from human
traffic only. Bots, admins and the owner's own visits never inflate the numbers,
and website clicks are recorded by a dedicated beacon when a human actually leaves
for the business site.

**The conversion funnel.** One panel rolls exposure, attention and outcomes into a
single ladder over the last 30 days:

```
sponsored impressions → featured impressions → profile views
→ website clicks → leads → qualified → won
```

with contact rate (leads ÷ views), qualification rate (qualified ÷ leads) and win
rate (won ÷ qualified) beside it, plus the headline sentence (§3) that states the
month in words. Owners with no activity yet see an honest empty state, not zeros
dressed up as insight.

**Retention.** Raw view/impression events older than 400 days are purged
automatically — beyond every reporting window the product offers — so the events
table stays bounded as traffic grows.

---

## 9 · Sponsored placements and fair rotation

Sponsored cards are a separate, clearly labelled product — they never pretend to
be organic results, and they never *replace* organic results. They appear in four
places: the homepage strip (12 cards), inline in the directory, on category pages,
and as the top hits on search.

Three rules govern them:

1. **Relevant or absent.** In the directory, on category pages and in search, the
   sponsored cards always match the active filters — the category being browsed,
   the query being searched. If nothing matches, no cards show. There is no
   "close enough".
2. **Fair rotation.** The homepage draws are random over the *whole* eligible pool
   on every visit — no record is pinned to the top, no record is starved. When the
   pool overflows the visible slots, the strip becomes a scrolling marquee so every
   drawn card still gets screen time. The Featured rail (Pro listings on the
   homepage) rotates the same way: eligibility, not entitlement.
3. **Measured.** Every sponsored/featured card view is recorded as an impression
   (one batched write per page, and a page never breaks if recording fails), so
   advertisers' exposure shows up in the same funnel as everything else.

Fairness isn't a claim — it's a test. `npm run test:scale` seeds hundreds of
sponsored and Featured-eligible listings, hammers the real server, and asserts
coverage, per-record appearance bounds and chi-square uniformity of the draw
(§21).

---

## 10 · The weekly leads report

Once a week, every owner whose listings saw activity gets a **weekly leads
report** — automatically, with no subscription step beyond owning a listing:

- **Pro owners** get the full funnel: impressions, views, website clicks, leads by
  status and the headline numbers, linking straight to `/dashboard/analytics`.
- **Free owners** get a teaser: something is waiting in their inbox, without exact
  analytics figures — and a link to the upgrade page.
- **Quiet weeks stay silent.** No activity, no report, no noise.
- **Channel choice.** Each owner picks *notification*, *email*, *both* (the
  default) or *none* in Settings → "Weekly leads report". One owner, one report,
  on their chosen channels.

The report is only ever *in addition to* instant notification: a new inquiry still
pings the owner immediately, both in-app and by email. The weekly report is the
summary; the instant ping is the doorbell.

---

## 11 · Ownership verification (three methods)

All three prove the same thing — that you control the company's official domain —
and all three are checked live, by our servers, the moment you press verify. There
is no human in the loop and no waiting period.

| Method | What you add | Best for | Watch out for |
|---|---|---|---|
| **DNS TXT** | `firmledger-verification=<token>` | Anyone with registrar/DNS access; survives site redesigns | Propagation (wait ~10 min, re-check unlimited) |
| **Meta tag** | `<meta name="firmledger-verification" content="<token>">` in `<head>` | Site owners and CMS users — usually fastest | Must be in served HTML, not injected by JavaScript |
| **FirmLedger badge** | The badge snippet anywhere on the homepage | Anyone who can edit page content but nothing technical | Keep it in place; removing it can revert the claim |

Verified ownership raises the confidence score, shows the ✓, unlocks editing from
your dashboard, turns on the contact form's lead delivery, and — because edits
still pass moderation — never lets a verified owner publish structural changes
unreviewed.

---

## 12 · FirmLedger Pro

| | Free | Pro |
|---|---|---|
| Browse directory, profiles, search | ✓ | ✓ |
| Contact a verified business (signed in) / receive inquiries | ✓ | ✓ |
| Submit listings | ✓ | ✓ |
| Claim and verify a business | ✓ | ✓ |
| **Full record**: contact details, socials, timeline, relationship graph | — | ✓ |
| **Read and manage your leads** | — | ✓ |
| API keys + REST access | — | ✓ |
| Post jobs on your listing | — | ✓ |
| Homepage Featured placement eligibility | — | ✓ |
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

## 13 · The admin console

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
| **AI Playground** | A rule-based admin assistant (no model, no API key) that understands the whole console — 129 tools behind confirmations, pronoun memory, disambiguation and quick replies — plus rule-based auto-moderation of new listings and full audit logs. |
| **Inbox / Search** | Admin notifications; global search across users, listings, tickets, claims and posts |
| **Settings** | Moderation and indexing switches, IndexNow key, Google Indexing API, **automated upkeep**, console 2FA, SMTP providers, environment view |

Nothing in the console is a "quick script": every action writes through the same
event boundary as the rest of the app, so webhooks, notifications and audit trails
stay consistent no matter which surface triggered the change.

---

## 14 · The news layer

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

## 15 · Automated upkeep

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

The same hourly tick also runs the quieter chores: the **weekly leads report**
(§10), trial-reminder ladders, the newsletter window, notification expiry,
stale-ticket auto-close, raw analytics-event retention (§8), mail-provider
keep-alive and the status-page digest.

---

## 16 · The public API

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

## 17 · Trust, safety and moderation

- **Human moderation** — submissions are approved or rejected by a person; structural edits by verified owners re-enter the queue.
- **Removal and correction** — anyone can file a request from a profile; it lands in the same queue, with a public moderation log.
- **Spam controls** — IP and email-domain allow/block lists, per-bucket rate limits (including leads and contact posts), a light scraper ceiling that never touches robots.txt, sitemaps, the feed or verified search bots.
- **Console security** — the three-step admin chain with single-use email codes (10-minute expiry, one resend per minute), TOTP with recovery codes, and a settings page that can reset enrollment.
- **Member security** — email-verified registration, optional TOTP with recovery codes, password reset tokens, session revocation on suspension.
- **Backups** — a complete `.firmledger` file from Admin → Health (users, listings, configuration) that restores into an empty database and can be imported in Users.
- **Maintenance mode** — a branded holding page that leaves the console and status page up.
- **Privacy** — no third-party trackers; the verification badge does not track anyone; analytics count humans only and raw events expire; newsletters unsubscribe in one click.

---

## 18 · Search and discovery

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

## 19 · Email and notifications

- **Multi-provider SMTP** with automatic failover (`SMTP_URL`, `SMTP2_URL`, … or providers added in Settings), a single From address, and an outbox fallback when nothing is configured.
- **Branded templates** for verification, approvals, claims, trials, payments, leads, digests and security alerts.
- **Instant lead pings** — a new inquiry notifies the owner at once, in-app and by email.
- **In-app notifications** for members (bell) and the console (Inbox), with archive, trash and expiry.
- **Weekly leads reports** (§10) on each owner's chosen channels — notification, email, both, or none.
- **Watchlist digests** fire when a watched record changes — including a refreshed technology stack.
- **Newsletter** — a weekly "new verified companies" digest, cadence configurable (daily/weekly/monthly), one-click unsubscribe.
- **Status subscribers** get incident updates from `/status`.

---

## 20 · Where things live

```
server.js                 Express bootstrap, security headers, hourly jobs, 404/500
src/db.js                 SQLite schema + migrations + settings helpers
src/routes/               public · auth · dashboard · billing · claim ·
                          admin · adminops · adminai · api · status
src/lib/                  analytics · leads · leadsdigest · advertising · plans ·
                          paypal · promos · apikeys · apilimit · apilistings ·
                          webhooks · enrich · verify · claimflow · score · news ·
                          techrefresh · upkeep · indexing · googleIndexing ·
                          graph · categories · taxonomy · compare · docs ·
                          notifications · notify · mailer · newsletter ·
                          trialreminders · trialmail · statusMonitor · support ·
                          careers · backup · health · maintenance · spam ·
                          session · passwords · totp · user2fa · adminmail2fa ·
                          oauth · upload · socialicons · listingevents ·
                          indexlog · blogseed · ai · assistant · aitools(+core,+admin)
views/                    EJS templates (public, dashboard/, admin/, blog/, partials/)
public/                   css, js, fonts, assets (no build step)
migrations/               SQL migrations
tests/                    20 suites in `npm test` + the standalone scale test
data/                     firmledger.db, uploads, outbox, backups (gitignored)
```

**Stack:** Node 20+ · Express 4 · EJS · better-sqlite3 (WAL) · sharp · nodemailer ·
multer · passport (Google, LinkedIn) · googleapis · qrcode · bcryptjs. No bundler,
no queue, no external database.

---

## 21 · Running it

```bash
npm install
cp .env.example .env      # set BASE_URL and ADMIN_SECRET at minimum
npm start                 # http://localhost:3000
npm run dev               # reloads on change
npm test                  # 20 suites, all offline
npm run test:scale        # realistic load + rotation-fairness test (boots a server)
```

`ADMIN_SECRET` opens the console; `BASE_URL` decides whether search engines are
allowed to index. Everything else — payments, SMTP, OAuth, IndexNow, Google
Indexing, the AI assistant — is optional and degrades to a switched-off state
rather than a broken one. Deployment, systemd, Caddy and backup routines live in
[README.md](README.md); the machine-level resource story is in
[README3.md](README3.md).

**Tests** (`npm test`, 20 suites, all offline):

| Suite | Proves |
|---|---|
| **AI admin tools** | all 129 assistant tools really change the database, and sensitive ones can never be auto-run |
| **AI admin assistant** | intent understanding, slot filling, pronoun memory, disambiguation, confirm/cancel flows, audit logging, rule-based auto-moderation |
| **AI assistant end-to-end** | every admin action reachable and correct through chat |
| **AI assistant HTTP / hardening** | the assistant API under production conditions |
| **AI Playground areas** | every console area plus conversation memory and clock handling |
| **Maintenance page + error pages** | the 503 holding page and animated error pages |
| **Backup round trip** | `.firmledger` export and restore into an empty database |
| **Mail providers** | multi-SMTP configuration and failover |
| **Admin pages** | every console page renders; long lists scroll in place |
| **Free trial reminders** | the trial reminder ladder by email + notification |
| **Admin technology refresh** | technology radar maintenance end to end |
| **Listing news & upkeep** | the news accuracy gate, moderation, sweeps and the hourly schedule |
| **Admin 2FA chain** | the full admin sign-in chain with real mail |
| **API surface & discovery** | key auth, scopes, discovery and rate limits |
| **Google Indexing + featured rail** | Indexing API (stubbed), the never-ping-twice ledger, the 200/day quota, featured rail |
| **Indexing health (crawl view)** | one URL per page, one host per site, sitemap hygiene, crawler-safe limits |
| **Robots & Auth OAuth** | robots.txt behaviour and OAuth wiring |
| **Status monitor accuracy** | `/status` accuracy — no false outages, real healing |
| **Pro growth** | fair sponsored/featured rotation, owner analytics, lead capture and gating |
| **Conversion funnel + digest** | impression recording, funnel math and headline, digest channels, quiet weeks, Pro-vs-Free reports, event retention |

**Scale test** (`npm run test:scale`, standalone — boots a real server with
hundreds of sponsored and Featured-eligible listings, then checks rotation
coverage and per-record fairness bounds, chi-square uniformity of the sponsored
draw, sponsored relevance under directory/search/category filters, concurrent
users, repeated refreshes, inquiry posting and per-endpoint latency budgets).
Knobs: `SCALE_SPONSORED` (400) · `SCALE_FEATURED` (300) · `SCALE_ORGANIC` (200) ·
`SCALE_ROUNDS` (60) · `SCALE_CONCURRENCY` (16) · `SCALE_PORT` (3217).

---

## 22 · The principles underneath

1. **Provenance beats volume.** One fact a stranger can re-check is worth more than ten nobody can.
2. **Nothing is invented.** If enrichment finds no article, the record says so. If a scan finds no technologies, the panel is empty. If no news clears the gate, there is no news.
3. **One business, one record.** Duplicates are refused at the door, so sources, timelines and verification never scatter.
4. **Ownership is proven, not claimed.** Control of a domain, checked live — not an email address.
5. **Humans decide what the public sees.** Automation proposes; a moderator disposes.
6. **Contact is never paywalled.** Any signed-in member can reach a verified business, and receiving inquiries is free; Pro pays for reading and working them — the customer's business is never the hostage.
7. **Promotion is labelled, relevant and fair.** Sponsored cards say so, match the context, and rotate without favouritism.
8. **Every surface writes through the same door.** Console, dashboard, API, assistant and AI all land on one event boundary, so nothing silently skips the record.

---

## 23 · Glossary

| Term | Meaning |
|---|---|
| **Confidence score** | How strongly a record's facts are corroborated (sources, verification, review) |
| **FirmLedger Score** | 0–100 profile health: completeness, sources, ownership, freshness, coverage |
| **Claim** | Proving control of a company's domain to take over its record |
| **Lead** | An inquiry a signed-in member sends a verified business; one shared thread, worked new → contacted → qualified → won/lost |
| **Funnel** | Exposure → views → contact → lead → qualified → won, with rates and a headline |
| **Impression** | One recorded view of a sponsored or Featured card (humans only) |
| **Weekly leads report** | The per-owner funnel summary, on notification/email/both/none channels |
| **Technology radar** | Technologies detected from a company's public homepage |
| **News gate** | The name-or-domain test a story must pass before it is stored |
| **Upkeep** | The hourly sweep that refreshes stale technology snapshots and news |
| **Relationship graph** | Investors, parents, products, partners and founders linked to a record |
| **Freshness** | How recently a record — or one of its snapshots — was last checked |
| **Pro** | The account-level subscription that opens full records, lead management, the API and job posting |
| **IndexNow** | The instant crawl-ping protocol search engines accept |
