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
<p>Publication is not the end of the pipeline. Approved records are added to the sitemap index automatically and pushed to search engines via IndexNow within about ten hours. A freshness marker on each profile tells visitors how recently the record was touched; technology snapshots are re-detectable on demand by the owner; and anyone can file a removal or correction request from the profile itself, which lands in the same human moderation queue.</p>
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
    body: `<p class="lead">FirmLedger’s directory has always been open for reading — that was the point of a public ledger. From today the same records are available over a single, key-authenticated REST API, and reading it requires a key like everything else. Unlocking it is one FirmLedger Pro plan, which also unlocks the directory, verified ticks and Featured placement.</p>
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
];

function seedBlog(db) {
  const count = db.prepare('SELECT COUNT(*) c FROM blog_posts').get().c;
  if (count) return;
  const ins = db.prepare(
    "INSERT INTO blog_posts (slug, title, excerpt, body, status, published_at) VALUES (?,?,?,?,'published', ?)"
  );
  // Space the seed dates out so the array order == blog order (newest last), and
  // the lead post (the API announcement) sits at the top of /blog on a fresh DB.
  const now = Date.now();
  for (let i = 0; i < POSTS.length; i++) {
    const p = POSTS[i];
    const daysAgo = (POSTS.length - 1 - i) * 2;
    ins.run(p.slug, p.title, p.excerpt, p.body, new Date(now - daysAgo * 86400000).toISOString().slice(0, 19).replace('T', ' '));
  }
}

module.exports = { seedBlog };
