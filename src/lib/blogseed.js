/** Seed the news area with real methodology posts on a fresh database. Idempotent. */
const POSTS = [
  {
    slug: 'how-firmledger-builds-a-trustworthy-record',
    title: 'How FirmLedger builds a trustworthy business record',
    excerpt: 'The five-layer pipeline behind every profile: ingest, normalize, resolve, verify, refresh — and why provenance matters more than volume.',
    body: `<p class="lead">Most business directories are mirrors of self-reported data: a company says what it is, and the directory repeats it forever. FirmLedger takes the opposite position. A record only earns a place on this site when it can point to where its facts came from — and every profile shows that citation trail publicly.</p>
<h2>The problem with business data on the web</h2>
<p>Company information is fragmented across registries, encyclopedias, news archives, social profiles and the companies' own websites. Each source is partial, differently formatted, and frequently out of date. Aggregators that merge these signals typically do so silently: you see a description, a founding year, a headcount — with no way to know which of them is current, or why you should believe any of it.</p>
<p>The result is an ecosystem where a two-year-old funding headline can look more authoritative than a claim submitted yesterday by the actual owner. We think that is backwards, and it is exactly what our pipeline is designed to correct.</p>
<h2>Layer 1 — Ingest</h2>
<p>Records enter the ledger in two ways. First, structured enrichment: when a listing is created, we resolve the business's Wikipedia article and its linked Wikidata entity and import only real, citable fields — the summary description, official website, founding year, headquarters, logo and social handles. Second, direct submission: owners and contributors type records in by hand. If a business has no genuine Wikipedia article, enrichment refuses to invent data and the record is simply marked as submission-sourced. Both paths are legitimate; what matters is that the profile always shows which one produced it.</p>
<h2>Layer 2 — Normalize</h2>
<p>Raw input is standardized before it is stored. Names collapse onto one spelling; categories are deduplicated case- and punctuation-insensitively, so "Fintech", " Fintech " and "FINTECH" can never become three categories; locations split into country, city and region; logos are normalized to uniform 256×256 assets. The schema is strict at the field level — a founding year must be a year, a description must carry real substance of at least one hundred characters, taglines are capped so the directory stays a directory and not a billboard.</p>
<h2>Layer 3 — Resolve</h2>
<p>One business, one record. The ledger refuses duplicates by name and by website domain, whether the record was fetched from Wikipedia or typed in manually. When a second submission matches an existing record, the submitter is redirected to that record and offered the claim flow instead of a new page. This is the single most important structural decision in the product: everything else the ledger knows — sources, timelines, relationships, verification — attaches to one canonical profile per entity rather than scattering across near-duplicates.</p>
<h2>Layer 4 — Verify</h2>
<p>Review happens at two levels. Every submission is moderated by a human before publication. Separately, the actual owner of a business can cryptographically claim its record: add a DNS TXT record, one meta tag line, or our badge snippet to the official domain, and our servers check for it live. Verified ownership both raises the profile's confidence score and transfers editorial control to the owner — they can edit fields, post timeline events and record relationships, subject to continued moderation of structural changes.</p>
<h2>Layer 5 — Refresh</h2>
<p>Publication is not the end of the pipeline. Approved records are added to the sitemap index automatically and pinged to search engines via IndexNow the moment they go live, so new profiles are indexed. A freshness marker on each profile tells visitors how recently the record was touched; technology snapshots are re-detectable on demand by the owner; and anyone can file a removal or correction request from the profile itself, which lands in the same human moderation queue.</p>
<h2>Why one Wikipedia source is worth more than ten anonymous ones</h2>
<p>It would be trivial to scrape ten aggregators and report a median headcount. We do not, because reproducibility beats volume: a fact a third party can re-check beats five facts nobody can. Every field we import is traceable to an article a skeptic can open, and when the article changes, the citation on the profile tells a reviewer exactly where to look. That is what "source-backed" means on this site — not a badge, a trail.</p>`,
  },
  {
    slug: 'dns-meta-or-badge-choosing-a-verification-method',
    title: 'DNS, meta tag or badge: choosing a verification method for your listing',
    excerpt: 'All three claim methods cryptographically prove the same thing. Here is how they differ, who each one suits, and what our servers actually check.',
    body: `<p class="lead">Claiming a FirmLedger profile takes minutes, and all three supported methods prove the same fact: that you control the official domain of the business. This note explains what each method involves, when to pick which, and what happens behind the "Verify now" button.</p>
<h2>Why domain proof?</h2>
<p>A business profile is only meaningfully "owned" if control can be tied to something the business itself controls. Email addresses, names and phone numbers are all easy to fake on a directory; a domain is not. Whoever controls a domain's DNS zone, its homepage HTML, or its visible content controls the business's canonical identity on the web — so that is the identity we verify, live, at the moment you ask us to check.</p>
<h2>Method 1 — DNS TXT record (strongest)</h2>
<p>You add a single TXT record to the domain: host <code>@</code> (or <code>_firmledger</code>), value <code>firmledger-verification=&lt;your-token&gt;</code>, TTL five minutes. We query the domain's resolvers directly and check for the exact token.</p>
<p><em>Choose this when:</em> you manage the company's DNS (registrar, Cloudflare, Route 53) but perhaps not its website code — common when marketing runs the site through an agency. DNS is also immune to website redesigns wiping the proof, so it is the most durable choice.</p>
<p><em>Watch out for:</em> propagation. Most resolvers see a TXT record within minutes, but some corporate DNS setups cache aggressively. If the first check fails after adding the record, wait ten minutes and press "Verify now" again — re-checks are unlimited.</p>
<h2>Method 2 — HTML meta tag (fastest for site owners)</h2>
<p>You paste one line, <code>&lt;meta name="firmledger-verification" content="&lt;your-token&gt;"&gt;</code>, inside the homepage's <code>&lt;head&gt;</code>. We fetch the homepage and verify the tag, byte for byte.</p>
<p><em>Choose this when:</em> you have access to the site's code or to a CMS feature like "custom head code" (every major CMS has one — WordPress theme headers, Webflow's head-code setting, Shopify's theme.liquid). It is usually the fastest path: no IT ticket, no DNS console.</p>
<p><em>Watch out for:</em> tag managers and client-side injection. The check reads the served HTML, so a tag injected after page load by JavaScript will not be found. The line must be present in the source document itself.</p>
<h2>Method 3 — The FirmLedger badge (zero code access)</h2>
<p>You embed the badge snippet anywhere on the homepage — the footer works well. The badge is a small image linking back to your FirmLedger profile, and its embed code carries your verification token as a data attribute. We fetch the page and confirm the snippet is present. Once verified, the badge also advertises your "Verified" status to your visitors; it ships in light and dark themes and never tracks anyone.</p>
<p><em>Choose this when:</em> you can edit some page content but nothing technical — or when you want the trust signal on your own site anyway. It is the only method your customers can see.</p>
<h2>What our servers actually check</h2>
<p>Verification is fully automated and runs at the moment you press the button: a live DNS query for method one, or a live fetch of your homepage for methods two and three. There is no human in the loop and no waiting period. If the token is there, the profile flips to "Verified owner" immediately; its confidence score rises; and the record becomes editable from your dashboard the same second. If it is not there, you get the exact reason — "tag not found", "record propagating" — not a generic failure.</p>
<h2>After verification</h2>
<p>Keep the proof in place. Re-checks can happen at any time after verification, and removing the proof can revert a profile to unclaimed. Pending competing claims are rejected automatically when a claim succeeds, and only one verified owner can hold a record at a time — by design, the ledger never shows two managers for one business.</p>`,
  },
  {
    slug: 'why-we-fetch-from-wikipedia-and-nothing-else',
    title: 'Why we fetch from Wikipedia, and nothing else',
    excerpt: 'Our enrichment policy in one sentence: if it is not citable, it does not go on a profile. Here is the reasoning — and what that means for smaller businesses.',
    body: `<p class="lead">When you press "Fetch from Wikipedia" on the FirmLedger form, you are triggering the most opinionated line of code in the product: the part that refuses to guess. This post explains why our auto-fill speaks to exactly one source — Wikipedia and its structured sibling Wikidata — and what that choice means in practice.</p>
<h2>The alternative we rejected</h2>
<p>The standard industry approach is breadth: scrape search-engine snippets, social profiles, aggregator sites and the open web freely, then let a model summarize the mess into a confident-sounding profile. It produces more data per company, faster — and it is precisely why so much business intelligence on the internet is quietly wrong. Snippet text is taken out of context, aggregators copy each other's errors, and language models fill gaps with the most statistically plausible answer rather than the true one. The output looks authoritative. It is not auditable.</p>
<p>A business record that investors, journalists and partners will rely on cannot work like that. Every number and every sentence needs a handrail: somewhere a skeptic can go to re-verify it.</p>
<h2>What Wikipedia gives us — and what it refuses to</h2>
<p>Wikipedia's biography-of-organizations content sits behind a notability requirement and a citation norm that ordinary directories simply do not have. When a business has a genuine article, that article has usually been argued over by strangers with no stake in flattering the company — which is the best free noise filter on the internet. Its linked Wikidata entity then exposes the same facts as structured fields: official website, inception year, headquarters, logo image, social identifiers. Our fetch reads exactly those fields. Nothing is interpolated; missing fields stay empty.</p>
<p>Just as important is what the check refuses to do. If the search returns only a disambiguation page, we skip it. If nothing titled like your query exists, we say so plainly — "has no real Wikipedia article; fill the record in manually" — instead of grabbing the closest full-text mention. An early build of the fetcher once returned a U.S. government finance agency for a Kenyan startup because the agency was mentioned in the startup's funding news. That is exactly the kind of answer the current fetcher is designed never to give: a wrong record, confidently presented.</p>
<h2>Where the source shows up</h2>
<p>The article used for enrichment is stored on the record as provenance. Open any fetched profile and look at "Sources &amp; provenance": you will see the Wikipedia article listed alongside the company's official website, with the date of record. The confidence score counts those citations; the public can check every claim against them without asking us.</p>
<h2>What this means for smaller businesses</h2>
<p>Most African SMEs do not have Wikipedia articles, and that is fine. Notability is a property of encyclopedias, not of legitimacy. A small business belongs on FirmLedger exactly as much as a blue-chip — it simply enters through manual submission instead of the one-click fetch, and its profile honestly reports that its data is submission-sourced until cited references exist. Owners can then make the record first-party true by claiming it through domain verification.</p>
<p>We would rather ship a ledger that is slightly harder to fill than one that is easy to fill with noise. The bet is simple: ten records a skeptic can verify beat a hundred a skeptic cannot.</p>`,
  },
  {
    slug: 'introducing-the-firmledger-api',
    title: 'The FirmLedger API: a production guide to the ledger',
    excerpt: 'A practical guide to every FirmLedger API capability: keys, scopes, listings, filters, webhooks, exports, limits and production-safe integration patterns.',
    body: `<p class="lead">FirmLedger’s directory has always been open for reading — that was the point of a public ledger. From today the same records are available over a single, key-authenticated REST API, and reading it requires a key like everything else. Unlocking it is one FirmLedger Pro plan, which also unlocks the directory, verified ticks, eligibility for Featured placement, Audience Analytics and the Leads inbox.</p>
<h2>Why every endpoint now needs a key</h2>
<p>We used to keep a small set of public read endpoints — a liveness probe, a discovery index and a couple of directory reads — on the theory that “open data” should be open. In practice that made the directory easy to scrape wholesale and impossible to meter or protect. So we closed the door. There is no public, key-less endpoint left on <code>/api/v1</code>: <code>/health</code>, the discovery index, the directory — all of them answer <code>401 missing_key</code> unless you send a valid key.</p>
<p>The trade-off is deliberately generous. A single Pro API key unlocks the entire surface, per-key read and write rate limits keep things fair, and the endpoints return the same approved, sourced, moderated records your browser sees — with the contact details and CSV export you would otherwise have to hand-collect.</p>
<h2>What you can do</h2>
<div class="table-wrap">
<table class="table">
<thead><tr><th>Endpoint</th><th>What it does</th></tr></thead>
<tbody>
<tr><td><code>GET /api/v1</code></td><td>Discovery — name, version, the endpoint list and live limits.</td></tr>
<tr><td><code>GET /api/v1/health</code></td><td>Liveness probe. Still key-authenticated, returns no business data.</td></tr>
<tr><td><code>GET /api/v1/listings</code></td><td>The approved directory, with <code>q</code>, <code>type</code>, <code>category</code>, <code>country</code>, <code>city</code>, <code>region</code>, <code>sponsored</code>, <code>sort</code> and pagination.</td></tr>
<tr><td><code>GET /api/v1/listings/:slug</code></td><td>The full company profile, with sources, technology radar and hiring link.</td></tr>
<tr><td><code>GET /api/v1/categories</code></td><td>Every category, with its slug and a live listing count.</td></tr>
<tr><td><code>GET /api/v1/countries</code></td><td>The countries present in the ledger, each with its count.</td></tr>
<tr><td><code>GET /api/v1/suggest</code></td><td>Autocomplete — listings, categories, countries, cities for a search box.</td></tr>
<tr><td><code>GET /api/v1/verify/domain/:domain</code></td><td>Check whether a domain is already listed.</td></tr>
<tr><td><code>GET /api/v1/export/listings.csv</code></td><td>The approved ledger as a downloadable CSV.</td></tr>
<tr><td><code>GET/POST /api/v1/my/listings</code></td><td>CRUD over the records you own, exactly like the dashboard.</td></tr>
</tbody>
</table>
</div>
<h2>Get a key in under a minute</h2>
<p>Keys are created in the dashboard under <strong>Developer API</strong>. The console also holds your usage counters, rate-limit settings and a live playground that runs real calls against the ledger so you can try everything without writing a line of code.</p>
<pre><code># 1. Go Pro, then create a key at /dashboard/api
# 2. Browse the approved directory
curl "https://firmledger.co.ke/api/v1/listings?category=Fintech" \\
  -H "Authorization: Bearer fl_live_your_key"


# 3. Export it all as CSV
curl "https://firmledger.co.ke/api/v1/export/listings.csv?country=Kenya" \\
  -H "Authorization: Bearer fl_live_your_key" \\
  --output firmledger-listings.csv</code></pre>
<h2>Webhooks for production systems</h2>
<p>When polling is not enough, create a webhook at <code>POST /api/v1/webhooks</code> with the <code>manage:webhooks</code> scope. FirmLedger signs each delivery with HMAC and returns a secret once; verify the timestamp and raw request body, then use <code>X-Idempotency-Key</code> to make retries safe. Delivery failures retry with backoff and can be inspected from the API console.</p>
<h2>One key, one plan</h2>
<p>Every endpoint is a FirmLedger Pro feature. If your plan lapses, keys reply <code>403 pro_required</code> with an <code>upgrade_url</code> so your integration can point customers somewhere useful — and the moment Pro is active again the same key works. Keys are shown once at creation and stored only as a hash; revoke or rotate them instantly from the console.</p>
<p>Rate limits are honest and per rolling 60 seconds: reads and writes are budgeted separately, a concurrency gate rejects pile-ups, and a brute-force guard locks out an address after too many bad keys. Every response carries <code>X-RateLimit-*</code> headers and a <code>X-Request-Id</code> you can quote when writing to support. The full reference — parameters, errors and curl for every endpoint — lives at <a href="/api/docs">/api/docs</a>.</p>
<h2>What stays open</h2>
<p>The <em>web</em> remains fully public — browse <a href="/directory">the directory</a>, read any profile, subscribe to <a href="/feed.xml">RSS</a>. The API is the paid, metered, machine-readable door. If you just want to read about companies, the browser is already enough.</p>`,
  },
  {
    slug: 'firmledger-api-production-guide',
    title: 'How to use the FirmLedger API — every endpoint needs a key',
    excerpt: 'A production walkthrough of the key-authenticated FirmLedger API: getting a key, authenticating every call, reading the directory, CRUD on your own records, webhooks and the limits to respect.',
    body: `<p class="lead">The FirmLedger API is the machine-readable door to the same approved, sourced, moderated business records you see on this site. It is <b>production-ready</b> — a stable <code>v1</code> contract with predictable JSON, honest rate limits and response shapes that will not break. One rule governs the whole surface: <b>every endpoint requires an API key</b>, including the health check.</p>
<h2>Why every endpoint needs a key</h2>
<p>There used to be a few public read endpoints on <code>/api/v1</code> — a liveness probe, a discovery index and some directory reads — on the idea that open data should be open. In practice that let the directory be scraped wholesale and made it impossible to meter or protect. So we closed the door. Now <code>/health</code>, the discovery index, the directory — every one of them answers <code>401 missing_key</code> unless you send a valid key. This is deliberate: it keeps the ledger fair, metered and auditable, and it is why the API is a <b>FirmLedger Pro</b> feature.</p>
<h2>Step 1 — get a Pro key</h2>
<p>API access is bundled with FirmLedger Pro. Upgrade from the <a href="/pricing">pricing page</a> or jump straight to <a href="/dashboard/api">your developer console</a> once you are signed in. In the console:</p>
<ol>
<li>Create a key — give it a label like <code>production-sync</code> and tick the scopes it needs.</li>
<li>Copy it <b>immediately</b>. It is shown once, then stored only as a SHA-256 hash. FirmLedger cannot display it again.</li>
<li>Keep it server-side. Never ship a key in browser code, a public repository or a mobile app — proxy every call through your backend.</li>
</ol>
<p>You can hold up to 3 active keys per account, revoke or rotate them instantly, and narrow each one with scopes so an integration only gets the power it needs.</p>
<h2>Step 2 — authenticate every call</h2>
<p>Send the key in the <code>Authorization</code> header as a Bearer token. Never put it in a URL or a request body. The same key works on every endpoint.</p>
<pre><code># Read a single approved company profile
curl "https://firmledger.co.ke/api/v1/listings/acme-logistics-ltd" \
  -H "Authorization: Bearer fl_live_your_key"

# X-API-Key: fl_live_your_key   ← accepted alternative header</code></pre>
<h2>Step 3 — explore the endpoint surface</h2>
<div class="table-wrap">
<table class="table">
<thead><tr><th>Method</th><th>Endpoint</th><th>What it does</th></tr></thead>
<tbody>
<tr><td><code>GET</code></td><td><code>/api/v1</code></td><td>Discovery — version, the endpoint list and live limits.</td></tr>
<tr><td><code>GET</code></td><td><code>/api/v1/health</code></td><td>Liveness probe — still key-authenticated, returns no business data.</td></tr>
<tr><td><code>GET</code></td><td><code>/api/v1/me</code> · <code>/usage</code></td><td>Your account, key scopes and durable usage analytics.</td></tr>
<tr><td><code>GET</code></td><td><code>/api/v1/listings</code></td><td>The approved directory, filterable by <code>q</code>, <code>type</code>, <code>category</code>, <code>country</code>, <code>city</code>, <code>region</code> and sortable.</td></tr>
<tr><td><code>GET</code></td><td><code>/api/v1/listings/:slug</code></td><td>The full company profile, with sources, technology radar and hiring link.</td></tr>
<tr><td><code>GET</code></td><td><code>/api/v1/categories</code> · <code>/countries</code></td><td>Categories and countries present in the ledger, with counts.</td></tr>
<tr><td><code>GET</code></td><td><code>/api/v1/suggest</code></td><td>Type-ahead suggestions for a search box: listings, categories, countries, cities.</td></tr>
<tr><td><code>GET</code></td><td><code>/api/v1/verify/domain/:domain</code></td><td>Check whether a domain is already listed.</td></tr>
<tr><td><code>GET</code></td><td><code>/api/v1/export/listings.csv</code></td><td>Download the approved ledger as a CSV, with optional filters.</td></tr>
<tr><td><code>GET/POST/PUT/DELETE</code></td><td><code>/api/v1/my/listings</code></td><td>Full CRUD over the records you own — same moderation pipeline as the dashboard.</td></tr>
<tr><td><code>GET/POST/PATCH/DELETE</code></td><td><code>/api/v1/webhooks</code></td><td>Signed, retryable push notifications instead of polling.</td></tr>
</tbody>
</table>
</div>
<h2>Step 4 — browse the directory in code</h2>
<p>The directory is the most common call. It returns approved records with full profile fields (including contact details) for Pro members, paginated and filterable.</p>
<pre><code># Pull the first page of Kenyan Fintech companies, newest first
curl "https://firmledger.co.ke/api/v1/listings?category=Fintech&amp;country=Kenya&amp;sort=newest&amp;per_page=50" \
  -H "Authorization: Bearer fl_live_your_key"

{
  "data": [ { "slug": "safiri-fintech", "name": "Safiri Fintech", "category": "Fintech", "email": "...", "url": "https://firmledger.co.ke/listing/safiri-fintech" } ],
  "meta": { "page": 1, "per_page": 50, "total": 1, "total_pages": 1 }
}</code></pre>
<h2>Step 5 — manage the records you own</h2>
<p>Use <code>/api/v1/my/listings</code> to create, update and delete records you own. New records enter as <code>pending</code> and go live after the standard moderation pass — exactly like submissions from the dashboard. Send only the fields you want to change on an update; unknown fields are rejected so typos never silently drop.</p>
<pre><code>curl -X POST "https://firmledger.co.ke/api/v1/my/listings" \
  -H "Authorization: Bearer fl_live_your_key" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Acme Logistics Ltd", "tagline": "Cold-chain freight for East African exporters end to end", "description": "Acme Logistics runs refrigerated trucking and bonded warehousing between Mombasa, Nairobi and Kampala.", "website": "https://acme-logistics.example", "country": "Kenya", "type": "company", "founded": "2019", "city": "Nairobi", "tags": ["logistics","cold-chain"] }'</code></pre>
<h2>Scopes, limits and errors</h2>
<p>Narrow each key with scopes: <code>read:listings</code>, <code>write:listings</code>, <code>export</code>, <code>manage:webhooks</code> and <code>read:usage</code>. A missing permission returns <code>403 insufficient_scope</code> with <code>required_scope</code> in the error details.</p>
<p>Limits are per rolling 60 seconds, per key — reads and writes are budgeted separately, an in-flight concurrency gate rejects pile-ups, and a brute-force guard locks out an address after too many bad keys. Every response carries <code>X-RateLimit-*</code> headers and an <code>X-Request-Id</code> you can quote when writing to support. Errors are a consistent machine-readable envelope (<code>{ "error": { "code", "message", "details" } }</code>), so parsing a failure is as predictable as parsing a success.</p>
<h2>Webhooks — stop polling</h2>
<p>When you need to react to changes, create a webhook with the <code>manage:webhooks</code> scope. FirmLedger signs every delivery with HMAC and returns the secret once — verify the timestamp and the raw request body, and use <code>X-Idempotency-Key</code> so retries are safe. Failed deliveries retry with backoff and can be inspected from the API console.</p>
<h2>Try it without writing code</h2>
<p>The <a href="/dashboard/api/playground">API playground</a> runs live calls against the ledger from your browser — the exact code path, key rules and limits as <code>/api/v1</code>. Compose a request or pick a preset, and read the status, rate-limit headers and JSON body directly. The full reference — every parameter, every error code and a curl example per endpoint — is at <a href="/api/docs">/api/docs</a>.</p>
<h2>Production readiness</h2>
<p><code>v1</code> is the stable public contract. Response shapes, field names and error codes are frozen; breaking changes ship only as <code>/api/v2</code> and <code>v1</code> keeps working. If your plan lapses, keys reply <code>403 pro_required</code> with an <code>upgrade_url</code> so your integration can point customers somewhere useful — and the same key works again the moment Pro is active. The <em>web</em> stays fully public, so your users can browse <a href="/directory">the directory</a> or read any profile even while your key is parked. If you just want to read about companies, the browser is already enough; if you want to build on the ledger, the key is your door.</p>`,
  },
  {
    slug: 'news-on-firmledger-what-a-profile-is-allowed-to-say-about-the-news',
    title: 'News on FirmLedger: what a profile is allowed to say about the news',
    excerpt: 'Every company profile can now carry published coverage of the business. Here is where those stories come from, the test each one has to pass before we store it, and why a story submitted by a member waits for a human.',
    body: `<p class="lead">A directory record answers one question well: <em>who is this company?</em> It answers a second question badly: <em>what is happening to them?</em> Registered details, a verified owner and a source trail tell you a business exists and is real — not whether it raised money last month, opened a branch, or was in the headlines at all. That second question is what the news layer on every profile is for.</p>
<h2>What counts as a news story here</h2>
<p>One row of news on FirmLedger is deliberately small: a <b>headline</b>, the <b>publication</b> that carried it, the <b>date</b> it was published, and a <b>link</b> to the story itself. That is the whole shape. We do not rewrite headlines, we do not write summaries in our own words, and we do not generate a paragraph of context around a story we found. If we cannot point at the published article, we have nothing to show, so we show nothing.</p>
<p>That constraint is the same one that governs the rest of the ledger. Company descriptions come from cited sources; ownership comes from a live domain check; technology comes from the company's own homepage. News follows the same rule: a claim is only ours to display if we can show where it came from.</p>
<h2>Three doors, one standard</h2>
<p>Stories reach a profile in three ways, and each one is labelled internally so we can always tell them apart.</p>
<ul>
  <li><b>Detected.</b> A sweep searches a public news index for the company and keeps what is genuinely about it.</li>
  <li><b>Submitted.</b> A signed-in member sends us a story from the profile's submit page. It is held for moderation.</li>
  <li><b>Written here.</b> A moderator adds a story by hand from the console. A human chose it, so it publishes immediately.</li>
</ul>
<p>Only the middle one waits. Automatic detection is held to a mechanical test before it is ever stored, and a moderator's own entry is a human decision by definition — but anything arriving from a member goes into a queue, because trust on a public record should not be granted by a form submission.</p>
<h2>The accuracy gate</h2>
<p>Detection is the part that has to earn its keep. A search for a company name returns a mixture: stories about the company, stories about a namesake, stories that mention one word of the name, and stories that merely appeared in the same results. Storing all of it would be easy and useless, so a story is kept only when one of two things is true.</p>
<p><b>It carries the company's full name as a phrase.</b> Not a fragment of it. For a company called <em>Safari Fintech</em>, a headline about <em>Safari Fintech raising a round</em> matches. A headline about <em>Safari launching long-distance buses</em> does not — one word of a two-word name is not that company. Legal suffixes are stripped before the comparison, so <em>Safari Fintech Limited</em> and <em>Safari Fintech Ltd</em> are understood to be the same business, and neither is confused with a different company that happens to share a word.</p>
<p><b>Or it sits on the company's own domain.</b> A story hosted on the company's website — or a feed whose publisher link points at it — is about the company by construction, even when the headline never repeats the name. Coverage from a company's own newsroom often reads <em>Expansion plan revealed</em> with no company name anywhere in it; the domain is the evidence.</p>
<p>Everything else is dropped. Not flagged, not demoted, not shown with a disclaimer — dropped. A near-miss is never "close enough", because a confident wrong story on a business record is worse than an empty panel. When a scan finds nothing that clears the bar, the profile simply has no news, and the check is recorded as having happened. Zero is an honest answer; a guess is not.</p>
<h2>Why submissions wait for a person</h2>
<p>Anyone signed in can send us a story from a profile: headline, link, publication, date, and an optional note for the moderator. It is rate limited and CSRF-protected like every other form on the site, duplicate links are refused outright, and guests are sent to sign in first so every submission has an account behind it.</p>
<p>Once submitted, the story is <b>pending</b>: invisible on the public profile, visible to the console, and the company's owner is told it is waiting. A moderator approves or rejects it, and the submitter is notified either way — and can see the status of their own submissions on the same page they submitted from. Approved stories appear on the profile with their publication and date; rejected ones stay out, and the reason is the one that matters: a story needs a link a stranger can open and check.</p>
<p>This is slower than publishing everything and sorting it out later. It is also the only version of this feature we were willing to ship on a site whose entire premise is that its records can be audited.</p>
<h2>Keeping it current, with or without you</h2>
<p>News goes stale faster than a company's registered address, so freshness is a scheduled job rather than a good intention. An hourly sweep re-checks a capped number of listings for new coverage, oldest first, alongside the same sweep that refreshes stale technology snapshots. Both are switchable, both are capped per hour, and both run in the background — the console shows live progress and can stop a run mid-flight, and the whole schedule can be turned off from Settings without losing the buttons.</p>
<p>On top of the schedule, a moderator can sweep everything that is due, sweep the entire directory, or press <b>Look for stories now</b> on a single listing's edit page. Each profile keeps its freshest stories — currently twelve — so a busy company's panel turns over instead of growing without limit.</p>
<h2>What we deliberately do not do</h2>
<ul>
  <li><b>No machine-written summaries.</b> The words on a profile about a news story are the publication's words, not a model's paraphrase of them.</li>
  <li><b>No paid placement.</b> News is not an advertising slot. Sponsorship is a separate, clearly labelled product; it never buys a story in this panel.</li>
  <li><b>No stories without a citable link.</b> A press release that only exists in an inbox, or a claim with nothing behind it, does not go on a profile.</li>
  <li><b>No silent edits.</b> Every story records where it came from — detected, submitted or written here — and who approved it.</li>
  <li><b>No scraping of the company's own site as news.</b> Blog posts on a company domain are marketing, not coverage; they are only matched when a real publication is carrying the story.</li>
</ul>
<h2>The short version</h2>
<p>FirmLedger now tells you what is being published about a company, not just what the company says about itself — and it does it under the same rule the rest of the ledger lives by. Detected stories have to prove they are about the business. Submitted stories wait for a human. Nothing appears without a link you can open yourself.</p>
<p>Browse <a href="/directory">the directory</a> to see it on a live profile, or read <a href="/blog/how-firmledger-builds-a-trustworthy-record">how a record is built</a> for the pipeline underneath it.</p>`,
  },
  {
    slug: 'how-featured-placement-works',
    title: 'How Featured placement works on FirmLedger',
    excerpt: 'Pro listings are eligible for Featured placement — but eligibility is not a guarantee. Here is how the fair rotation chooses what appears on the homepage.',
    body: `<p class="lead">The Featured section is the highest-visibility slot on FirmLedger — and the most misunderstood. This note explains exactly what FirmLedger Pro buys you there: eligibility for Featured placement, with the system choosing a fair subset on every visit.</p>
<h2>Eligibility, not entitlement</h2>
<p>Pro listings are <strong>eligible for Featured placement</strong>. That word matters. The homepage can only show a handful of cards at once, so if every eligible listing were shown, the section would either stretch forever or silently favour whoever loaded first. Instead, every visit draws a random subset of the eligible pool — and every eligible listing has exactly the same probability of appearing.</p>
<p>In plain terms: Pro puts your listing in the draw; it does not pin it to the page. Over days and weeks of traffic, every eligible listing gets its turn on screen.</p>
<h2>What the system chooses on each visit</h2>
<p>On every homepage load the system assembles up to eight Featured cards. Records pinned by the FirmLedger team — genuine editorial picks, used sparingly — always lead. The remaining slots are filled by a uniform random draw from the other eligible Pro listings. Reload the page and you will see a different mix; that is the fairness working as designed.</p>
<h2>What keeps you in the draw</h2>
<p>Eligibility follows your Pro subscription, not your listing. While your account holds active FirmLedger Pro, every approved listing you own is in the eligible pool. If Pro lapses, your listings simply leave the rotation — nothing is deleted, and they rejoin automatically when you renew. A listing that is rejected or removed from the directory is never drawn, no matter whose it is.</p>
<h2>Featured is not Sponsored</h2>
<p>The two strips look similar but mean different things. Featured placement is a Pro perk: no per-placement fee, chosen by the rotation described here. Sponsored Content is paid advertising, always labelled <strong>Sponsored</strong>, with its own fair rotation — read <a href="/blog/how-advertising-works-on-firmledger">how advertising works</a> for that side. Neither strip is for sale as an editorial endorsement, and neither affects where a listing ranks in the organic directory.</p>
<h2>The one-line version</h2>
<p>Pro makes your listings eligible; the system rotates a fair random subset onto the homepage on every visit, so every eligible listing has the same chance of appearing. See <a href="/pricing">pricing</a> for what else Pro unlocks.</p>`,
  },
  {
    slug: 'how-advertising-works-on-firmledger',
    title: 'How advertising works on FirmLedger',
    excerpt: 'Sponsored Content is paid placement, always labelled, fairly rotated — even with ten thousand sponsors. How the draw works and what your money buys.',
    body: `<p class="lead">FirmLedger sells exactly one kind of advertising: time-based Sponsored Content placements for verified listings. Every placement is clearly labelled, and visibility is shared by fair random draw — this note explains the mechanics.</p>
<h2>What you are buying</h2>
<p>A Sponsored Content package puts your listing into the sponsored rotation for its duration — currently 7, 30 or 90 days (see <a href="/advertise">packages</a>). Your card links straight to your verified company profile. The moment PayPal confirms your payment, the placement goes live: no setup calls, no creative review queue — the card is your profile, rendered by the ledger.</p>
<h2>Fair rotation, even at ten thousand sponsors</h2>
<p>The homepage can only show a few sponsored cards at once, so it never tries to show all of them. Every visit draws a random subset of the active sponsors, and every sponsor has exactly the same probability of appearing — whether there are twelve sponsors or ten thousand. When someone searches or browses a category, the same rule applies inside that slice: up to three matching sponsors are drawn at random and shown first with a clear <strong>Sponsored</strong> label, while the organic results below exclude the drawn cards so nothing appears twice.</p>
<p>This is deliberate. A directory that showed every advertiser would either paginate its sponsors into oblivion or quietly rank them by spend. The draw treats a one-week package exactly like a quarterly one while both are active: presence in the pool is what matters, not budget.</p>
<h2>Always labelled, never ranked</h2>
<p>Every sponsored card carries a <strong>Sponsored</strong> label — paid placement is never presented as an editorial pick. And sponsorship buys visibility, not rank: it never changes where a listing appears in organic directory results, search relevance, confidence scores or the Featured rotation. Those are earned or drawn, never sold.</p>
<h2>Who can advertise</h2>
<p>Any account with at least one approved listing it owns. Advertising is separate from FirmLedger Pro: Pro unlocks viewing full profiles and perks on your listings, while advertising buys placement in the sponsored rotation. Claiming and verifying your listing first is free, and sponsored cards for verified businesses carry the verified badge too.</p>
<h2>The one-line version</h2>
<p>You buy time in the pool; the system draws a fair random subset onto every page, always labelled Sponsored. Start at <a href="/advertise">Advertise on FirmLedger</a>.</p>`,
  },
  {
    slug: 'turning-your-listing-into-leads',
    title: 'Turning your FirmLedger listing into leads',
    excerpt: 'Every claimed listing carries a Contact this business button for signed-in FirmLedger members. How inquiries reach you, the one-email-per-conversation rule, and how to convert them.',
    body: `<p class="lead">Every claimed listing on FirmLedger carries a <strong>Contact this business</strong> button. When a signed-in FirmLedger member finds your profile, they can send an inquiry in under a minute — it lands in your Leads inbox, and your email address is never shown on the profile. This guide walks through the whole loop as it works today.</p>
<h2>What the member sees</h2>
<p>On any claimed (verified-owner) profile, <strong>Contact this business</strong> sits with the profile actions. Inquiries are a member feature by design: the person writing to you is signed in to a FirmLedger account, and their account name and email travel with the message automatically — never typed freehand, never spoofable. The form itself asks only for what you need to reply: phone (optional), what they are looking for, and a message. Spam-grade rate limiting plus honeypot checks keep the inbox clean.</p>
<h2>What you receive</h2>
<p>The opening inquiry reaches you twice: as an in-app notification and as an email to your account address, carrying the member's details and message, with their address as the reply-to. From there the conversation lives on-platform: each side gets exactly one email per conversation, and every later reply arrives as a site notification instead — so a ten-message negotiation produces one email, not ten. Your address is never exposed on the profile; you choose when to take it direct.</p>
<h2>The Leads inbox</h2>
<p><strong>Dashboard → Leads</strong> is where inquiries live. Reading and managing them is a FirmLedger Pro feature (inquiries keep arriving either way — upgrading unlocks the backlog). Every lead carries a status pipeline — <strong>New, Contacted, Qualified, Won, Lost</strong> — plus private notes only you can see, filtering by status and listing, archiving, and a permanent delete for conversations that are truly done. The member you are talking with sees the same thread under their Sent box, so both sides share one timeline.</p>
<h2>Closing the loop with Analytics</h2>
<p>Leads pair naturally with <strong>Audience Analytics</strong>, also Pro: views today, this week and this month, the top locations your audience comes from, and a drill-down per location showing views, unique visitors, profile clicks, website clicks and leads. If a city sends views but no inquiries, your profile — not your traffic — is the problem, and now you can see it.</p>
<h2>Three habits of listings that convert</h2>
<p><strong>Claim first.</strong> Only claimed listings receive inquiries — verification is free and takes minutes. <strong>Reply fast.</strong> The opening inquiry lands as an email instantly, and your first reply is the member's one email for the whole thread — same-day replies win. <strong>Work the pipeline.</strong> Move every lead out of New within a day, even if only to Lost — an honest pipeline is what turns a directory profile into a sales channel.</p>
<p>Claim your listing from <a href="/claim">the claim page</a>, then see <a href="/pricing">what Pro unlocks</a>: the Leads inbox, Audience Analytics, Featured eligibility and more.</p>`,
  },
  {
    slug: 'where-to-list-your-startup-in-2026',
    title: 'Where to List Your Startup in 2026 for Instant Verification & SEO',
    excerpt: 'Google Business Profile, Crunchbase, Product Hunt, review sites and verification-first ledgers each earn you a different kind of trust. A plain-English map of where to list, what verification means on each, and where the SEO value actually comes from.',
    body: `<p class="lead">A startup in 2026 does not have a visibility problem; it has a trust problem. Anyone can publish a landing page in an afternoon, which is exactly why buyers, partners and investors cross-check you against third-party records before they reply. The platforms below are the ones that matter — not because they are the loudest, but because each one answers a different question about your company, and each one hands you a different kind of search-engine value.</p>
<h2>What a listing should actually do for you</h2>
<p>Two things. First, <strong>verification</strong>: a third party confirms you are a real business with a real domain, so strangers can trust the record without emailing you first. Second, <strong>SEO</strong>: a crawlable profile on an established domain — a stable canonical URL, structured data, and a backlink from a site search engines already trust. A directory that blocks crawlers or mints a new URL every redesign gives you neither. Judge every platform on those two axes before you spend an afternoon filling in forms.</p>
<h2>Google Business Profile — local intent</h2>
<p>If customers visit, call or drive to you, Google Business Profile is non-negotiable: it is the record behind the map pack and the "near me" results. Verification usually means a postcard, a phone code or a video walkthrough of the premises, and the payoff is local search — queries made five minutes from your door. Pure software companies with no footprint to visit get less from it; a headquarters card is fine, but it is not where your story lives.</p>
<h2>Crunchbase — the investor's cross-check</h2>
<p>Crunchbase is where funding history, founders and company milestones get checked by analysts, journalists and sales teams. You can create and edit your own profile, and its data is syndicated widely enough that keeping it current is basic hygiene before a raise. Treat it as your financial biography: accurate rounds, accurate people, accurate dates — because the audience is doing diligence, not shopping.</p>
<h2>Product Hunt — a launch, not a listing</h2>
<p>Product Hunt is a moment, not a record. A well-timed launch day brings early adopters, feedback and a spike of traffic that can mint your first thousand users — and then it fades. The permanent residue is small but real: a canonical launch page that ranks for your product's launch and gets cited in round-ups. Ship one good launch, keep the page live, and move on.</p>
<h2>Review-led profiles — G2 and category sites</h2>
<p>If you sell software, review platforms like G2 add the strand nobody else can: what customers say, in public, on the record. Reviews age quickly, so the profile rewards companies that keep asking. Its SEO value is category-page visibility — ranking for the "tools for …" searches your own site will not win directly for years.</p>
<h2>FirmLedger — the verifiable company record</h2>
<p>FirmLedger occupies a different slot from all of the above: a verification-first business ledger. One canonical profile per company — the ledger refuses duplicates by name and by domain — so every source, relationship and update attaches to a single stable URL instead of scattering across near-duplicates. Ownership is proven the way domain control is proven everywhere else: a DNS TXT record, a meta tag or a badge on your official site, checked live at the moment you press verify. And every field carries its citation trail, distilled into a public confidence score that tells a reader how much of the record is sourced, claimed and verified.</p>
<p>For SEO specifically, a FirmLedger profile is built to be crawled: a canonical URL per company, structured data on every profile, inclusion in the sitemap index, and search-engine pings when the record changes. If you want to see what a finished record reads like, <a href="/directory">explore the business intelligence data</a> in the public directory; when you are ready to own yours, <a href="/claim">claim your verified business profile</a> and editorial control comes with it.</p>
<h2>Using them together</h2>
<p>The platforms compound when they agree. Use the same legal name, the same domain and the same founding facts everywhere, and let each record link back to the same canonical website. A buyer who finds matching facts on Google, Crunchbase and a verification-led ledger has no reason to doubt you — and that, not any single badge, is what a 2026 listing strategy is actually for.</p>`,
  },
];

/* Content fixes for posts that were seeded before a product change. A stored
   post is rewritten only while it still contains one of its stale markers —
   i.e. it is still the old seed version. Anything an admin has reworded is
   left alone, exactly like the insert-if-absent rule above. */
const STALE_MARKERS = {
  'turning-your-listing-into-leads': ['guests can inquire as easily as members'],
  'how-firmledger-builds-a-trustworthy-record': ['within about ten hours', 'typically picked up within a few hours'],
};

function seedBlog(db) {
  // Idempotent per-slug: insert every seed post that doesn't already exist, so a
  // fresh database gets the full set and an existing database picks up newly
  // added posts on the next boot without disturbing existing or admin-authored
  // content (rows are only inserted when their slug is absent).
  const ins = db.prepare(
    `INSERT INTO blog_posts (slug, title, excerpt, body, status, published_at)
     SELECT ?,?,?,?,'published', ?
      WHERE NOT EXISTS (SELECT 1 FROM blog_posts WHERE slug = ?)`
  );
  const upd = db.prepare(
    `UPDATE blog_posts SET title = ?, excerpt = ?, body = ?, updated_at = datetime('now')
      WHERE id = ?`
  );
  // Space the seed dates out so the array order == blog order (newest last), and
  // the lead post (the newest guide) sits at the top of /blog.
  const now = Date.now();
  for (let i = 0; i < POSTS.length; i++) {
    const p = POSTS[i];
    const daysAgo = (POSTS.length - 1 - i) * 2;
    ins.run(p.slug, p.title, p.excerpt, p.body,
      new Date(now - daysAgo * 86400000).toISOString().slice(0, 19).replace('T', ' '),
      p.slug);
    const markers = STALE_MARKERS[p.slug];
    if (markers) {
      const row = db.prepare('SELECT id, body FROM blog_posts WHERE slug = ?').get(p.slug);
      if (row && markers.some((m) => row.body.includes(m))) {
        upd.run(p.title, p.excerpt, p.body, row.id);
      }
    }
  }
}

module.exports = { seedBlog };
