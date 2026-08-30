/** FirmLedger documentation sections — real user documentation (no placeholders). */
const SECTIONS = [
  {
    id: 'getting-started',
    title: 'Getting started',
    lede: 'What FirmLedger is, and how to get a record into the ledger.',
    body: [
      'FirmLedger is a canonical business ledger. Every approved entity — company, startup, agency, organization, product, service or publisher — exists exactly once, with a structured profile built from real, cited data. Records are moderated before publication; nothing on this site is machine-invented filler.',
      'To publish a record you need a free account (email + password). From your dashboard choose “Add a listing”, then either pull the business’s real details from Wikipedia with one click or type the record in manually. Submissions enter moderation review; approved records go live, are added to the sitemap automatically, and are pushed to search engines for indexing within about ten hours.',
    ],
  },
  {
    id: 'wikipedia-enrichment',
    title: 'Wikipedia enrichment',
    lede: 'Where auto-filled data comes from — and why it is Wikipedia only.',
    body: [
      'The “Fetch from Wikipedia” button resolves the business’s Wikipedia article and its linked Wikidata entity. From those two real sources we fill: the summary description, official website, logo (Wikidata logo image), founding year, headquarters city and country, and social profiles (X, LinkedIn, Facebook, Instagram, YouTube). The article URL is stored as the record’s source and displayed publicly under “Sources & provenance”.',
      'If a business has no genuine Wikipedia article, the fetch refuses to invent data and asks you to fill the form manually. This is deliberate: a record without real-world citation is exactly what this ledger exists to prevent. Smaller businesses are welcome — simply enter the details yourself; the record is marked as submission-sourced until cited references appear.',
      'Search behavior: exact-title matches are preferred; disambiguation pages are skipped; unrelated full-text mentions are never used. If the wrong article comes up, type the business’s commonly used name instead of its domain.',
    ],
  },
  {
    id: 'claiming',
    title: 'Claiming & ownership verification',
    lede: 'Taking control of an existing record using DNS, a meta tag, or the badge.',
    body: [
      'Any approved, unclaimed record can be claimed by the actual owner. Claiming gives you editorial control: you can edit every field, manage the timeline and relationship graph, and the profile displays a “Verified owner” badge.',
      'Three cryptographic methods are supported. DNS: add a TXT record `firmledger-verification=<token>` to your domain — the strongest proof. Meta tag: place one `<meta name="firmledger-verification" content="<token>">` line in your homepage head. Badge: embed the badge snippet (light or dark theme) anywhere on your homepage; it also advertises your verified status to visitors. All three are checked live against your domain in seconds — there is no manual review queue for verification.',
      'For everyone’s protection, the verification domain must match the website on the listing. If your business has two domains, list the canonical one and redirect the other.',
    ],
  },
  {
    id: 'confidence-score',
    title: 'The confidence score & FirmLedger Score',
    lede: 'How records are weighted, and how profile health is measured.',
    body: [
      'Every record carries two honest numbers. The confidence score reflects how strongly the underlying data is corroborated — driven by cited sources, verified ownership and review status. The FirmLedger Score (shown as a dial on each profile) measures health: field completeness (up to 48 points across fourteen fields), independent sources (12), verified ownership (10), recency (8), and coverage bonuses for a timeline, relationships, detected technology and social proof — a transparent 100-point breakdown any visitor can audit.',
      'Scores are computed from real data at render time. There is no paid boosting and no way to buy a higher score; the only path is a complete, verified, well-sourced record.',
    ],
  },
  {
    id: 'relationship-graph',
    title: 'The relationship & ecosystem graph',
    lede: 'Mapping founders, investors, parents, subsidiaries, products and partners.',
    body: [
      'Businesses do not exist in a vacuum. Owners (and moderators) can record relationships on any listing: founder, investor, parent company, subsidiary, product, service or partner. When the related entity is itself on FirmLedger, profiles link automatically in both directions — the outbound side shows the relationship, the inbound side shows its inverse label (for example “Parent of” or “Founded by them”).',
      'The profile renders these as an interactive radial graph with relationship labels on the edges, plus structured ecosystem groups: key people (founders, with their social profiles when linked), capital (investors, parents, subsidiaries) and offerings (products, services, partners). Only relationships you or moderators recorded are shown — the graph never fabricates connections.',
    ],
  },
  {
    id: 'technology-radar',
    title: 'Technology radar & hiring signals',
    lede: 'What the “Tech stack” snapshot is, and where it comes from.',
    body: [
      'When a listing is created or its website changes, we fetch the public homepage once and look for real technology signatures: frameworks (Next.js, React, Vue, Angular), CMS platforms (WordPress, Shopify, Webflow and friends), payments (Stripe, PayPal), analytics, support tools and CDN hints from HTTP headers. Findings appear as the “Technology radar” panel with the exact detection date shown.',
      'Hiring signals work the same honest way: if the homepage links to a careers page or a known job board (Greenhouse, Lever, Workable, Ashby, Breezy), we record and display that link. We never invent headcounts or job titles. Owners can refresh detection at any time from the listing editor; snapshots older than the last edit are superseded automatically.',
    ],
  },
  {
    id: 'seo-indexing',
    title: 'Indexing: sitemaps, RSS and IndexNow',
    lede: 'How approved records reach Google and Bing.',
    body: [
      'The site publishes a standards-compliant sitemap index at /sitemap.xml, segmented by content type exactly the way large reference sites do it: static pages, listing profiles, category pages and category-plus-location pages. Only canonical, indexable URLs that return a real 200 appear; empty category slices carry a noindex marker and stay out of the sitemap.',
      'On approval, each new or updated record is also pushed instantly via the IndexNow protocol (Bing, Yandex and partners), and RSS at /feed.xml exposes the freshest listings and news for aggregators. Category pages are generated for every real category × location combination actually present in the ledger — never thin, auto-inflated pages.',
    ],
  },
  {
    id: 'removal-policy',
    title: 'Corrections & removal requests',
    lede: 'Anyone can ask for a record to be corrected or removed.',
    body: [
      'Every public profile carries a “Request removal” link. A removal request asks for your name, email and a reason — for example the business closed, a record is factually wrong, or you act for the owner. Requests land in the moderation console and are reviewed by a human; listings removed this way leave the ledger completely.',
      'Owners who prefer to fix rather than remove should claim the listing instead — editing is instant after domain verification. Our policy is deliberately simple: accurate, current, sourced records stay up; wrong or outdated records get corrected or removed.',
    ],
  },
  {
    id: 'api',
    title: 'The API — live with Pro',
    lede: 'REST access, keys, limits and the Playground.',
    body: [
      'The FirmLedger API is live for Pro members: full CRUD over the records you own (GET, POST, PUT, DELETE), API-key authentication, per-key read/write rate limits, a concurrency gate and a brute-force lockout guard. The complete endpoint reference lives at /api/docs.',
      'Keys are created in the dashboard under Developer API — up to three per account, shown once and stored hashed. The same page holds usage counters and a live playground that runs real calls against your own records. API access is included with FirmLedger Pro; if your plan lapses, keys reply 403 pro_required until you renew.',
    ],
  },
];

module.exports = { SECTIONS };
