/**
 * Site context — what the admin assistant *knows* about FirmLedger.
 *
 * The assistant is only as good as its grounding. This module assembles the
 * briefing it is handed on every turn: what the product is, how the money and
 * the moderation flows work, every page in the admin console, the real database
 * schema (read live from SQLite, never a stale copy), the current operational
 * numbers, and the settings inventory with secrets masked.
 *
 * Two consumers:
 *   - src/lib/ai.js      → the system prompt (context({ compact: true }))
 *   - the site_overview / get_site_schema / get_settings assistant tools
 *                          → the same material on demand, in more detail
 */
const { db, getSetting } = require('../db');

/* ------------------------------------------------------------------ static */

const PRODUCT = `FirmLedger (https://firmledger.co.ke) is the business record layer for modern discovery: a verified directory of companies, startups, agencies, organisations, products, services and publishers, with source transparency, confidence scores, ownership verification and a relationship graph.
Stack: Node.js + Express, EJS server-rendered views, one stylesheet (public/css/app.css), SQLite in WAL mode (data/firmledger.db) through better-sqlite3, no frontend build step. Everything the assistant can do is a real server-side operation against this database and these libraries — there is no mock mode.`;

const BUSINESS_RULES = `Business rules the assistant must respect:
- Listing lifecycle: status is pending → approved or rejected. Only approved listings are public, sitemapped and pinged to IndexNow/Google. Approving a listing for the first time also emails/notifies the owner and submits it for indexing.
- Duplicate protection: a name match (case-insensitive) or a website-domain match blocks a second record anywhere — user submissions AND admin adds. The right move is to point the person at the existing record ("claim it now"), never to create a near-duplicate.
- Confidence score (0–97) is computed from how complete the record is (website, email, phone, socials, sources, founded, size, location). Editing a listing should keep it honest; do not inflate confidence by hand.
- Ownership: claims are verified with a DNS TXT record, an HTML meta tag, or an email on the business domain (src/lib/verify.js). A claim only finalises when a live check passes; re-running the check is the correct action when a member says "it's set up now".
- FirmLedger Pro is ACCOUNT-scoped and buys two things: (1) viewing full details on every listing (website, email, phone, socials, events, relationship graph), and (2) perks on listings the member owns — verified tick, homepage Featured placement, gold embeddable badge, priority review. Adding and editing listings is always free; there are no paywalled fields. Pro time stacks; payments are verified server-side with PayPal before activation.
- A separate LISTING-level Pro boost (grant_listing_pro) and sponsored placement (advertising) exist and are independent of account Pro.
- Free trials are real Pro access, time-boxed (1–90 days, default 14), self-serve on /pricing or granted by an admin; they expire hourly via plans.expireTrials().
- Money: the payments table is the ledger. Never invent a payment. Plan offers referenced by a payment are deactivated, not deleted, so history survives; promo codes with redemptions behave the same way.
- Email vs in-app: SENSITIVE events (welcome, password reset, password/email/2FA change, payment receipt, Pro granted/revoked, claim ownership transfer, account suspend/delete) go out as branded HTML email through the multi-SMTP hop chain. Non-sensitive events (listing review, tickets, watchlist, edit digests) go to the in-app notification bell to protect SMTP quotas. Without SMTP configured, mail lands in data/outbox.log.
- Moderation priority: AI auto-moderation (ai_moderation_on) takes precedence over simple auto-approve (auto_approve). A model that is not confident leaves the listing pending and notifies the admin — that is a success, not a failure.
- Indexing hygiene: if BASE_URL is not a public origin the whole site is noindex + robots-blocked, so dev boxes can never leak into a search index. Google's Indexing API has a hard 200 URL_UPDATED quota per rolling day, and a URL that has been submitted must never be submitted twice (google_indexing_submissions ledger).
- Protection: spam_ip / spam_domain carry allow and block lists (an empty allow list means all domains allowed), rate limits are tunable per surface, and maintenance mode shows visitors a branded 503 holding page while a signed-in admin keeps working.
- The admin console is hidden behind the URL /admin3119Musa plus ADMIN_SECRET + an emailed one-time code + TOTP two-factor. Never reveal the secret path, the secret, OTP codes, recovery codes, API keys, SMTP passwords, or password hashes — refer to them as "stored on the server" instead.
- Privacy: personal data (emails, hashes, tokens) is only ever surfaced to the admin console. When reporting, prefer ids, slugs and masked values.`;

const ADMIN_CONSOLE = `Admin console pages (all under /admin3119Musa, section name in brackets):
- /dashboard [dashboard] — counts, queues, what needs attention, last backup.
- /search [search] — global search across users, listings, tickets, claims, posts.
- /notifications [notifications] + /notifications/trash — the in-console inbox, archive/restore/delete.
- /listings [listings] — search, status/category/country filters, bulk approve/reject, refresh-tech (one, a selection, everything stale, the whole directory), feature, delete, plan boost, owner transfer, sponsor.
- /listings/:id/edit [listings] — the full editor: every field, sources, status, featured/claimed, confidence, timeline events, relationship graph, technology radar, listing news.
- /listings/new [listings] — admin add (same duplicate protection as user submissions).
- /news [news] — listing news moderation queue (auto-detected, member-submitted, console-written), sweep settings, refresh runs.
- /categories [categories] — create / rename (moves listings) / delete (moves listings to Other).
- /claims [claims] — ownership claims: re-check the live verification, or reject.
- /users [users] — filters, per-user detail page, suspend/unsuspend, delete (email first), grant/revoke Pro, admin-initiated password reset, export/import .firmledger.
- /plans [plans] — plan offers (name, price, duration in days, blurb, sort, show/hide, safe delete).
- /pricing [pricing] — grant or revoke free trials per account.
- /advertising [advertising] — ad packages + sponsored placements.
- /careers [careers] — FirmLedger's own job roles (create, edit, open/close, delete).
- /incidents [incidents] — public /status page: components, incidents, updates, weekly digest config, manual probe run.
- /promos [promos] — percent-off promo codes with usage caps, expiry, optional plan lock, member notification.
- /protection [protection] — IP + email-domain allow/block lists, rate limits, maintenance mode.
- /health [health] — disk, database size, memory, uptime, last backup + full .firmledger backup download.
- /removals [removals] — listing removal requests: dismiss or fulfil (fulfil deletes the listing).
- /tickets [tickets] — support threads: reply, set status, auto-close stale.
- /email [email] — compose branded mail to a picked audience; admin_mail_log records every send.
- /blog [blog] — posts (draft/published) that flow to the footer News, RSS and sitemap.
- /ai [ai] — THIS playground: listing generator, admin assistant, provider connections, auto-moderation, auto-run policy, audit + moderation logs.
- /settings [settings] — auto-approve, indexing, Google Indexing API service account + 200-URL backfill, IndexNow key, SMTP (host/port/user/pass/from/secure), multi-SMTP accounts, PayPal credentials + mode, payments ledger, newsletter cadence + force-send, test email, upkeep schedule, admin 2FA reset / OTP inbox / recovery codes.`;

const PUBLIC_SITE = `Public site map (what members and crawlers see):
/ (home: featured + sponsored rails, categories, latest news) · /directory (fluid full-screen grid, filters, sort, list/grid toggle) · /directory/c/<category> and /directory/c/<category>-in-<location> (SEO landing pages, JSON-LD CollectionPage+ItemList, noindex when empty) · /listing/<slug> (profile: JSON-LD Organization+FAQPage, confidence meter, FirmLedger Score, key people, ecosystem groups, technology radar, hiring signals, FAQs, competitors, news, events timeline, relationship graph) · /suggest.json (typeahead) · /claim/<slug> (ownership claim) · /register /login /forgot /reset (accounts: PBKDF2-SHA512 600k, sessions in SQLite, CSRF, throttling, optional TOTP) · /dashboard (own listings, scores + missing-field hints, plan, notifications, claim picker, removal requests, API keys, watchlist) · /dashboard/upgrade + /pricing (Pro purchase via PayPal REST Orders, plan offers, promos) · /billing/callback (server-side capture + verification) · /blog /blog/<slug> /feed.xml · /docs /api (public REST API v1, key-authenticated, per-endpoint daily usage) · /status (+ /status/api, subscribe, verify, unsubscribe) · /about /privacy /terms /contact · /search (listings + posts + docs) · /badge/:slug.svg?theme=light|dark (embeddable verification badge) · /sitemap.xml (index + 4 sub-sitemaps with lastmod) · /robots.txt.`;

const DATA_MODEL_NOTES = `Data model notes (full column lists come from get_site_schema):
- listings: the ledger. slug (unique), name, tagline, description, type (company|startup|agency|organization|product|service|publisher), category (FK by name to categories), website/email/phone, country/city/region/address, logo_url, founded, size, tags, socials (JSON), sources (JSON array of URLs), status, featured, claimed, sponsored (+sponsored_expires_at, ad_reference), plan (+plan_expires_at — 'pro' boosts a listing), confidence, tech (JSON technology radar), tech_checked_at, news_checked_at, last_verified_at, owner_user_id, submitter_user_id.
- users: email (unique), password_hash, name, role, suspended, plan ('free'|'pro'), plan_expires_at ('' = lifetime), subscription_status ('free'|'active'|'trialing'), trial_started_at/expires_at/days, totp secret + recovery codes, pro granted/revoked by admin.
- relationships: listing_id, rel_type (founder|investor|parent|subsidiary|product|service|partner), target (free text or another listing), note — powers the radial graph and ecosystem groups.
- listing_events: dated timeline (funding, launch, milestone, award…) shown on the profile.
- listing_news: headline/url/source/summary, origin (auto|user|admin), status (pending|approved|rejected), match quality, reviewed_by/at — the accuracy gate is name-or-domain-or-nothing.
- claims: listing_id, user_id, method (dns|meta|email), domain, token, status.
- tickets + ticket_messages: support threads with refs like FL-XXXX, statuses open/solved/closed, attachments under data/uploads/support.
- payments: PayPal ledger (reference, amount, currency, status, plan_id, promo_id, user_id, listing_id, paid_at).
- plans / promo_codes / promo_redemptions / pro_transfer_requests / ad_packages: commerce.
- blog_posts, careers, jobs (member-posted roles), favorites (watchlist), newsletter_subscribers.
- notifications: audience 'admin' | 'user', read_at, archived_at, archive_expires_at, deleted_at.
- incidents / incident_updates / status_components / component_status_history / status_subscribers: the public status page.
- spam_ip / spam_domain / settings / sessions / resets / reg_otps / user_totp / deletion_requests / removal_requests.
- ai_audit_log (every assistant + generator + moderation action), ai_moderation_log (decision, reason, model), ai_pending_actions (proposals awaiting the operator's confirm, 10-minute expiry).
- api_keys / api_usage_daily / api_usage_endpoint_daily / api_webhooks / api_webhook_deliveries: the public API surface.
- indexing_log / google_indexing_submissions: what was actually sent to search engines.`;

/* -------------------------------------------------------------- live reads */

function safeAll(sql, ...params) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}
function safeCount(sql, ...params) {
  try { return db.prepare(sql).get(...params).c; } catch { return 0; }
}

/** Every table with its row count and (optionally) its columns — read live. */
function dataModel({ tables = '', withColumns = true } = {}) {
  const wanted = String(tables || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  const rows = safeAll("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const out = [];
  for (const r of rows) {
    if (wanted.length && !wanted.some((w) => r.name.toLowerCase().includes(w.toLowerCase()))) continue;
    const entry = { table: r.name, rows: safeCount(`SELECT COUNT(*) c FROM "${r.name}"`) };
    if (withColumns) {
      entry.columns = safeAll(`PRAGMA table_info("${r.name}")`).map((c) => `${c.name}${c.pk ? ' (pk)' : ''}${c.notnull && !c.pk ? ' NOT NULL' : ''}`);
    }
    out.push(entry);
  }
  return { count: out.length, tables: out };
}

/** Operational numbers — the same ones Admin → Overview shows. */
function liveCounts() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    listings: {
      total: safeCount('SELECT COUNT(*) c FROM listings'),
      pending: safeCount("SELECT COUNT(*) c FROM listings WHERE status='pending'"),
      approved: safeCount("SELECT COUNT(*) c FROM listings WHERE status='approved'"),
      rejected: safeCount("SELECT COUNT(*) c FROM listings WHERE status='rejected'"),
      claimed: safeCount('SELECT COUNT(*) c FROM listings WHERE claimed=1'),
      featured: safeCount('SELECT COUNT(*) c FROM listings WHERE featured=1'),
      sponsored: safeCount("SELECT COUNT(*) c FROM listings WHERE sponsored=1 AND (sponsored_expires_at='' OR sponsored_expires_at IS NULL OR sponsored_expires_at >= ?)", today),
      pro_boosted: safeCount("SELECT COUNT(*) c FROM listings WHERE plan='pro' AND (plan_expires_at='' OR plan_expires_at IS NULL OR plan_expires_at='lifetime' OR plan_expires_at >= ?)", today),
      categories: safeCount('SELECT COUNT(*) c FROM categories'),
      with_news: safeCount("SELECT COUNT(DISTINCT listing_id) c FROM listing_news WHERE status='approved'"),
      pending_news: safeCount("SELECT COUNT(*) c FROM listing_news WHERE status='pending'"),
      relationships: safeCount('SELECT COUNT(*) c FROM relationships'),
      events: safeCount('SELECT COUNT(*) c FROM listing_events'),
    },
    people: {
      users: safeCount('SELECT COUNT(*) c FROM users'),
      suspended: safeCount('SELECT COUNT(*) c FROM users WHERE suspended=1'),
      pro: safeCount("SELECT COUNT(*) c FROM users WHERE plan='pro' AND (plan_expires_at='' OR plan_expires_at >= ?)", today),
      trialing: safeCount("SELECT COUNT(*) c FROM users WHERE subscription_status='trialing'"),
      open_tickets: safeCount("SELECT COUNT(*) c FROM tickets WHERE status='open'"),
      solved_tickets: safeCount("SELECT COUNT(*) c FROM tickets WHERE status='solved'"),
      pending_claims: safeCount("SELECT COUNT(*) c FROM claims WHERE status='pending'"),
      pending_removals: safeCount("SELECT COUNT(*) c FROM removal_requests WHERE status='pending'"),
      pending_deletions: safeCount("SELECT COUNT(*) c FROM deletion_requests WHERE status='pending'"),
      pending_pro_transfers: safeCount("SELECT COUNT(*) c FROM pro_transfer_requests WHERE status='pending'"),
      newsletter_subs: safeCount('SELECT COUNT(*) c FROM newsletter_subscribers WHERE active=1'),
      status_subs: safeCount('SELECT COUNT(*) c FROM status_subscribers WHERE verified=1'),
      unread_admin_notifications: safeCount("SELECT COUNT(*) c FROM notifications WHERE audience='admin' AND deleted_at IS NULL AND (read_at IS NULL OR read_at='')"),
    },
    commerce: {
      payments: safeCount('SELECT COUNT(*) c FROM payments'),
      successful_payments: safeCount("SELECT COUNT(*) c FROM payments WHERE status='success'"),
      revenue_usd_cents: safeCount("SELECT COALESCE(SUM(amount),0) c FROM payments WHERE status='success' AND currency='USD'"),
      plan_offers: safeCount('SELECT COUNT(*) c FROM plans WHERE active=1'),
      active_promos: safeCount('SELECT COUNT(*) c FROM promo_codes WHERE active=1'),
      promo_redemptions: safeCount('SELECT COUNT(*) c FROM promo_redemptions'),
      ad_packages: safeCount('SELECT COUNT(*) c FROM ad_packages WHERE active=1'),
    },
    content: {
      blog_published: safeCount("SELECT COUNT(*) c FROM blog_posts WHERE status='published'"),
      blog_drafts: safeCount("SELECT COUNT(*) c FROM blog_posts WHERE status<>'published'"),
      careers_open: safeCount("SELECT COUNT(*) c FROM careers WHERE status='open'"),
      member_jobs_open: safeCount("SELECT COUNT(*) c FROM jobs WHERE status='open'"),
    },
    operations: {
      open_incidents: safeCount("SELECT COUNT(*) c FROM incidents WHERE status<>'resolved'"),
      blocked_ips: safeCount("SELECT COUNT(*) c FROM spam_ip WHERE kind='block'"),
      allowed_ips: safeCount("SELECT COUNT(*) c FROM spam_ip WHERE kind='allow'"),
      blocked_domains: safeCount("SELECT COUNT(*) c FROM spam_domain WHERE kind='block'"),
      indexnow_pings: safeCount("SELECT COUNT(*) c FROM indexing_log WHERE channel='indexnow' AND ok=1"),
      google_submissions_24h: safeCount("SELECT COUNT(*) c FROM google_indexing_submissions WHERE created_at >= datetime('now','-24 hours')"),
      google_submitted_total: safeCount('SELECT COUNT(*) c FROM google_indexing_submissions'),
      ai_pending_actions: safeCount('SELECT COUNT(*) c FROM ai_pending_actions'),
      ai_audit_entries: safeCount('SELECT COUNT(*) c FROM ai_audit_log'),
      ai_moderation_entries: safeCount('SELECT COUNT(*) c FROM ai_moderation_log'),
    },
  };
}

const SECRET_KEYS = new Set([
  'admin_totp_secret', 'admin_totp_pending', 'admin_recovery_codes', 'indexnow_key',
  'smtp_pass', 'smtp_user', 'paypal_client_secret', 'paypal_client_id',
  'groq_api_key', 'openai_api_key', 'anthropic_api_key', 'gemini_api_key',
  'deepseek_api_key', 'huggingface_api_key', 'openrouter_api_key', 'mistral_api_key',
  'xai_api_key', 'together_api_key', 'cerebras_api_key', 'fireworks_api_key',
  'sambanova_api_key', 'perplexity_api_key', 'azure_api_key', 'custom_api_key',
  'google_sa_client_email', 'google_sa_project_id', 'base_url',
]);

const SETTING_LABELS = {
  admin_email: 'Admin notification inbox',
  admin_2fa_email: 'Where console sign-in OTPs go',
  auto_approve: 'Simple auto-approve of new listings',
  ai_moderation_on: 'AI auto-moderation of new listings',
  ai_moderation_email: 'Email admin when the model is unsure',
  ai_moderation_model: 'Model used for auto-moderation',
  ai_provider: 'Active AI provider',
  ai_failover: 'Fall over to another configured provider on error',
  indexing_enabled: 'IndexNow pings enabled',
  google_indexing_enabled: 'Google Indexing API enabled',
  newsletter_cadence: 'Newsletter digest cadence',
  newsletter_last_sent: 'Last digest sent',
  news_review_auto: 'Detected news waits for moderation',
  maintenance_on: 'Maintenance holding page',
  maintenance_title: 'Maintenance page title',
  maintenance_eta: 'Maintenance expected return',
  smtp_from: 'Email From address (every provider)',
  smtp_host: 'Primary SMTP host',
  smtp_port: 'Primary SMTP port',
  smtp_secure: 'Primary SMTP TLS mode',
  paypal_mode: 'PayPal mode (sandbox/live)',
  upkeep_on: 'Automated hourly upkeep',
  upkeep_tech_on: 'Upkeep refreshes technology radars',
  upkeep_news_on: 'Upkeep checks listing news',
  status_weekly_report: 'Weekly status digest',
  last_backup_at: 'Last full backup taken',
  ai_auto_tools: 'Assistant write actions allowed to auto-run',
};

/** Settings inventory — labels + values, secrets reduced to "set / not set". */
function settingsInventory() {
  const rows = safeAll('SELECT key, value FROM settings ORDER BY key');
  const out = [];
  for (const r of rows) {
    if (SECRET_KEYS.has(r.key)) {
      out.push({ key: r.key, label: SETTING_LABELS[r.key] || '', secret: true, set: Boolean(String(r.value || '').trim()) });
      continue;
    }
    if (/^ai_(live_models|live_checked|model|base_url|custom_models|custom_auth|rate_limit)/.test(r.key)) {
      // provider plumbing is reported by the Providers panel instead
      continue;
    }
    if (/^groq_(live_models|live_checked_at|model|api_key)/.test(r.key)) continue;
    out.push({
      key: r.key,
      label: SETTING_LABELS[r.key] || '',
      value: String(r.value == null ? '' : r.value).slice(0, 200),
    });
  }
  return out;
}

function flagsSnapshot() {
  const on = (k, d = '0') => getSetting(k, d) === '1';
  return {
    maintenance_on: on('maintenance_on'),
    auto_approve: on('auto_approve'),
    ai_moderation_on: on('ai_moderation_on'),
    indexing_enabled: on('indexing_enabled', '1'),
    google_indexing_enabled: on('google_indexing_enabled', '1'),
    news_review_auto: on('news_review_auto'),
    upkeep_on: on('upkeep_on', '1'),
    status_weekly_report: on('status_weekly_report', '1'),
    newsletter_cadence: getSetting('newsletter_cadence', 'weekly'),
    paypal_mode: getSetting('paypal_mode', process.env.PAYPAL_MODE || 'sandbox'),
    smtp_configured: Boolean(getSetting('smtp_host', '') || process.env.SMTP_URL || process.env.MAIL_HOST),
    admin_email: getSetting('admin_email', '') || process.env.ADMIN_NOTIFY_EMAIL || 'hello@firmledger.co.ke',
    base_url: process.env.BASE_URL || getSetting('base_url', ''),
    last_backup_at: getSetting('last_backup_at', '') || 'never',
  };
}

/* ---------------------------------------------------------------- assembly */

const TOPICS = ['product', 'rules', 'admin', 'public', 'data', 'schema', 'live', 'settings', 'tools'];

function topicText(name) {
  switch (name) {
    case 'product': return PRODUCT;
    case 'rules': return BUSINESS_RULES;
    case 'admin': return ADMIN_CONSOLE;
    case 'public': return PUBLIC_SITE;
    case 'data': return DATA_MODEL_NOTES;
    case 'schema': {
      const dm = dataModel({ withColumns: true });
      return `Live schema — ${dm.count} tables:\n` + dm.tables
        .map((t) => `${t.table} (${t.rows} rows): ${t.columns.join(', ')}`)
        .join('\n');
    }
    case 'live': return JSON.stringify(liveCounts(), null, 1);
    case 'settings': return JSON.stringify({ flags: flagsSnapshot(), settings: settingsInventory() }, null, 1);
    default: return '';
  }
}

/**
 * The briefing. `compact` trims the schema to table names + counts so the
 * system prompt stays small; the assistant can pull the full column list with
 * get_site_schema whenever it needs to write a query or explain a record.
 */
/* The briefing runs a few dozen COUNTs; cache it briefly so a chat turn and a
   page render in the same second do not both pay for it. */
let contextCache = { at: 0, key: '', text: '' };
const CONTEXT_TTL_MS = 15_000;

function context({ compact = true, fresh = false } = {}) {
  const key = compact ? 'compact' : 'full';
  if (!fresh && contextCache.key === key && Date.now() - contextCache.at < CONTEXT_TTL_MS) {
    return contextCache.text;
  }
  const text = buildContext(compact);
  contextCache = { at: Date.now(), key, text };
  return text;
}

function buildContext(compact) {
  const dm = dataModel({ withColumns: !compact });
  const schemaLines = dm.tables.map((t) => (compact
    ? `${t.table}(${t.rows})`
    : `${t.table} (${t.rows} rows): ${t.columns.join(', ')}`));
  const counts = liveCounts();
  const flags = flagsSnapshot();
  return [
    PRODUCT,
    '',
    'Current state of this installation:',
    `- listings: ${counts.listings.total} total — ${counts.listings.pending} pending review, ${counts.listings.approved} live, ${counts.listings.rejected} rejected; ${counts.listings.claimed} claimed, ${counts.listings.featured} featured, ${counts.listings.sponsored} sponsored.`,
    `- people: ${counts.people.users} accounts (${counts.people.pro} Pro, ${counts.people.trialing} trialing, ${counts.people.suspended} suspended); ${counts.people.open_tickets} open tickets; ${counts.people.pending_claims} pending claims; ${counts.people.pending_removals} pending removals; ${counts.people.pending_deletions} pending account-deletion requests.`,
    `- commerce: ${counts.commerce.successful_payments} successful payments ($${(counts.commerce.revenue_usd_cents / 100).toFixed(2)} USD), ${counts.commerce.plan_offers} live plan offers, ${counts.commerce.active_promos} active promo codes, ${counts.commerce.ad_packages} ad packages.`,
    `- content: ${counts.content.blog_published} published posts, ${counts.content.careers_open} open careers roles, ${counts.listings.pending_news} news items awaiting moderation.`,
    `- operations: ${counts.operations.open_incidents} open incidents; maintenance ${flags.maintenance_on ? 'ON' : 'off'}; auto-approve ${flags.auto_approve ? 'ON' : 'off'}; AI moderation ${flags.ai_moderation_on ? 'ON' : 'off'}; indexing ${flags.indexing_enabled ? 'on' : 'off'}; Google Indexing API ${flags.google_indexing_enabled ? 'on' : 'off'}; ${counts.operations.google_submissions_24h}/200 of today's Google quota used; last backup ${flags.last_backup_at}.`,
    '',
    `Database tables (${dm.count}): ${schemaLines.join(', ')}`,
    '',
    DATA_MODEL_NOTES,
    '',
    ADMIN_CONSOLE,
    '',
    PUBLIC_SITE,
    '',
    BUSINESS_RULES,
  ].join('\n');
}

/** One-topic deep dive for the site_overview tool. */
function topic(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!TOPICS.includes(key)) {
    return {
      topic: 'index',
      topics: TOPICS,
      note: 'Ask for one of: product, rules, admin, public, data, schema, live, settings, tools.',
    };
  }
  if (key === 'tools') {
    /* Required lazily: aitools requires this module. */
    const tools = require('./aitools');
    return {
      topic: 'tools',
      groups: tools.GROUPS,
      tools: tools.catalog().map((t) => ({
        name: t.name, group: t.group, label: t.label, mutating: t.mutating,
        sensitive: Boolean(t.sensitive), auto: t.auto, description: t.description,
      })),
    };
  }
  return { topic: key, text: topicText(key) };
}

module.exports = {
  PRODUCT, BUSINESS_RULES, ADMIN_CONSOLE, PUBLIC_SITE, DATA_MODEL_NOTES,
  TOPICS, dataModel, liveCounts, settingsInventory, flagsSnapshot,
  context, topic, topicText,
};
