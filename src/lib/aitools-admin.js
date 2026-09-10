/**
 * Admin assistant tool registry — part two: the rest of the console.
 *
 * `aitools.js` covers listings, members, moderation and the core operations.
 * This file adds the remaining admin surface so the assistant can genuinely do
 * anything the console can do: site-wide knowledge and settings, listing edits
 * and bulk actions, content (blog / news / careers / promos / advert packages),
 * search indexing and upkeep, the public status page, SMTP delivery accounts,
 * protection lists and rate limits, the admin inbox and backups.
 *
 * Same contract as part one — `{ name, group, label, description, parameters,
 * mutating, sensitive, summarize, run }` — and it is merged into TOOLS by
 * `aitools.js`. `sensitive: true` means the operator is always asked to confirm
 * before it runs, no matter what the auto-run settings say.
 */
const core = require('./aitools-core');
const { db, getSetting, setSetting } = core;
const { findListing, findUser, approveListingRow, rejectListingRow, queueMail } = core;
const { bool, str, int, num, rows, countOf } = core;

const plans = require('./plans');
const ad = require('./advertising');
const promos = require('./promos');
const careers = require('./careers');
const catLib = require('./categories');
const spam = require('./spam');
const mailer = require('./mailer');
const notify = require('./notify');
const notifications = require('./notifications');
const mon = require('./statusMonitor');
const nl = require('./newsletter');
const news = require('./news');
const techrefresh = require('./techrefresh');
const upkeep = require('./upkeep');
const indexlog = require('./indexlog');
const indexing = require('./indexing');
const googleIndexing = require('./googleIndexing');
const backup = require('./backup');
const { TYPES, SIZES } = require('./taxonomy');
const { siteUrl } = require('./util');
const fs = require('fs');
const path = require('path');

/* Secrets are never handed back to the model — only a shape hint. */
function mask(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  return `${s.slice(0, 3)}•••${s.slice(-3)}`;
}

function dataDir() {
  return process.env.FIRMLEDGER_DATA_DIR
    ? path.resolve(process.env.FIRMLEDGER_DATA_DIR)
    : path.join(path.resolve(__dirname, '..', '..'), 'data');
}

const SITE_KEYS = {
  auto_approve: { kind: 'bool', label: 'Simple auto-approve of new listings' },
  indexing_enabled: { kind: 'bool', label: 'IndexNow / search-engine pings' },
  google_indexing_enabled: { kind: 'bool', label: 'Google Indexing API pings' },
  maintenance_on: { kind: 'bool', label: 'Public maintenance page' },
  news_review_auto: { kind: 'bool', label: 'Detected news waits for moderation' },
  status_weekly_report: { kind: 'bool', label: 'Weekly status report emails' },
  newsletter_cadence: { kind: 'enum', values: ['daily', 'weekly', 'monthly'], label: 'Newsletter digest cadence' },
  smtp_from: { kind: 'text', max: 200, label: 'Global mail From address' },
};

const TOOLS = [
  /* ==================== Site knowledge ==================== */
  {
    name: 'get_site_overview', group: 'read', label: 'Site & console map', mutating: false,
    description: 'Full orientation on FirmLedger: every public page, dashboard area and admin console section, the current feature flags, taxonomy, plans and advert packages.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Read the FirmLedger site and console map.'; },
    run() {
      return {
        product: {
          name: 'FirmLedger',
          what: 'Verified company intelligence and business listings directory.',
          base_url: siteUrl('/'),
        },
        public_pages: [
          { path: '/', page: 'Homepage — featured rail, newest listings, sponsored strip' },
          { path: '/directory', page: 'Directory with category and location filters' },
          { path: '/directory/c/:slug', page: 'One category' },
          { path: '/listing/:slug', page: 'Listing profile — verified details, technology radar, timeline, news' },
          { path: '/listing/:slug/news', page: 'News for one listing' },
          { path: '/search', page: 'Site search (+ /suggest.json typeahead)' },
          { path: '/compare', page: 'Compare shortlisted listings' },
          { path: '/blog', page: 'Blog index' }, { path: '/blog/:slug', page: 'One post' },
          { path: '/careers', page: 'FirmLedger job board' }, { path: '/jobs', page: 'Member jobs feed' },
          { path: '/pricing', page: 'Pricing + Pro offers' }, { path: '/advertise', page: 'Sponsored content packages' },
          { path: '/api', page: 'API overview' }, { path: '/api/docs', page: 'API documentation' },
          { path: '/status', page: 'Public status page' }, { path: '/about', page: 'About' },
          { path: '/privacy', page: 'Privacy policy' }, { path: '/terms', page: 'Terms' },
          { path: '/removal/:slug', page: 'Listing removal request' },
          { path: '/feed.xml', page: 'RSS feed' }, { path: '/sitemap.xml', page: 'Sitemap index' },
        ],
        member_dashboard: ['/dashboard (overview)', '/dashboard/listings (add / edit / claim / Pro)', '/dashboard/api (keys, usage, webhooks)', '/dashboard/billing (payments, invoices)', '/dashboard/notifications', '/dashboard/settings (profile, 2FA)'],
        admin_console: [
          { path: '/admin3119Musa', page: 'Dashboard — counts and queues' },
          { path: '/admin3119Musa/listings', page: 'Listings: review, edit, feature, sponsor, Pro, tech refresh, bulk actions' },
          { path: '/admin3119Musa/users', page: 'Members: plan, suspend, delete, password reset, import/export' },
          { path: '/admin3119Musa/categories', page: 'Category taxonomy' },
          { path: '/admin3119Musa/claims', page: 'Ownership claims' },
          { path: '/admin3119Musa/tickets', page: 'Support tickets' },
          { path: '/admin3119Musa/removals', page: 'Removal requests' },
          { path: '/admin3119Musa/news', page: 'Listing news moderation' },
          { path: '/admin3119Musa/blog', page: 'Blog posts' },
          { path: '/admin3119Musa/careers', page: 'Job roles' },
          { path: '/admin3119Musa/plans', page: 'Pro plan offers' },
          { path: '/admin3119Musa/pricing', page: 'Free-trial settings' },
          { path: '/admin3119Musa/advertising', page: 'Sponsored advert packages' },
          { path: '/admin3119Musa/promos', page: 'Promo codes' },
          { path: '/admin3119Musa/protection', page: 'IP / domain lists and rate limits' },
          { path: '/admin3119Musa/incidents', page: 'Status incidents' },
          { path: '/admin3119Musa/health', page: 'Server health and backup download' },
          { path: '/admin3119Musa/notifications', page: 'Admin inbox' },
          { path: '/admin3119Musa/email', page: 'Send mail to members' },
          { path: '/admin3119Musa/settings', page: 'Site, SMTP, payments, indexing, upkeep, 2FA' },
          { path: '/admin3119Musa/ai', page: 'AI Playground — rule-based assistant, auto-moderation, audit logs' },
        ],
        taxonomy: {
          types: TYPES, sizes: SIZES,
          categories: countOf('SELECT COUNT(*) c FROM categories'),
        },
        feature_flags: {
          auto_approve: getSetting('auto_approve', '0') === '1',
          ai_moderation_on: getSetting('ai_moderation_on', '0') === '1',
          indexing_enabled: getSetting('indexing_enabled', '1') === '1',
          google_indexing_enabled: getSetting('google_indexing_enabled', '0') === '1',
          maintenance_on: getSetting('maintenance_on', '0') === '1',
          news_review_auto: getSetting('news_review_auto', '0') === '1',
          upkeep_on: getSetting('upkeep_on', '1') === '1',
        },
        commerce: {
          plan_offers: plans.allPlans(false).map((p) => ({ id: p.id, name: p.name, price_usd: p.price_cents / 100, days: p.duration_days, active: !!p.active })),
          ad_packages: ad.allPackages(false).map((p) => ({ id: p.id, name: p.name, price_usd: p.price_cents / 100, days: p.duration_days, active: !!p.active })),
          paypal_mode: getSetting('paypal_mode', process.env.PAYPAL_MODE || 'sandbox'),
          paypal_configured: Boolean(process.env.PAYPAL_CLIENT_ID || getSetting('paypal_client_id', '')),
        },
        assistant: { engine: 'rule-based (no model, no API)', moderation_on: getSetting('ai_moderation_on', '0') === '1' },
        volumes: {
          listings: countOf('SELECT COUNT(*) c FROM listings'),
          users: countOf('SELECT COUNT(*) c FROM users'),
          blog_posts: countOf('SELECT COUNT(*) c FROM blog_posts'),
          news_stories: countOf('SELECT COUNT(*) c FROM listing_news'),
          jobs: countOf('SELECT COUNT(*) c FROM jobs'),
          newsletter_subscribers: countOf('SELECT COUNT(*) c FROM newsletter_subscribers WHERE active=1'),
        },
        limits_of_this_assistant: 'Admin 2FA enrollment and recovery-code regeneration stay in the console UI (the codes must not pass through a chat transcript). Everything else in the console is reachable through these tools.',
      };
    },
  },
  {
    name: 'get_settings', group: 'read', label: 'Read all settings', mutating: false,
    description: 'Every configurable admin setting, grouped: site flags, protection rate limits, mail delivery, payments, indexing, upkeep and AI. Secrets come back masked — never the real value.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Read the admin settings.'; },
    run() {
      const mail = mailer.accountStatus();
      return {
        site: {
          auto_approve: getSetting('auto_approve', '0') === '1',
          indexing_enabled: getSetting('indexing_enabled', '1') === '1',
          google_indexing_enabled: getSetting('google_indexing_enabled', '0') === '1',
          maintenance_on: getSetting('maintenance_on', '0') === '1',
          maintenance_title: getSetting('maintenance_title', "We'll be back soon"),
          news_review_auto: getSetting('news_review_auto', '0') === '1',
          status_weekly_report: getSetting('status_weekly_report', '0') === '1',
          newsletter_cadence: getSetting('newsletter_cadence', 'weekly'),
          admin_2fa_email: getSetting('admin_2fa_email', 'admin@firmledger.co.ke'),
          trial_days: plans.TRIAL_DEFAULT_DAYS,
        },
        protection: { limits: spam.limits(), ip_rules: spam.listIp().length, domain_rules: spam.listDomain().length },
        mail: {
          configured: mail.configured,
          from: mail.from,
          hops: mail.hops.map((h) => ({ label: h.label, host: h.host, port: h.port, source: h.source, sent_today: h.sent_today, last_error: h.last_error })),
        },
        payments: {
          mode: getSetting('paypal_mode', process.env.PAYPAL_MODE || 'sandbox'),
          client_id: mask(process.env.PAYPAL_CLIENT_ID || getSetting('paypal_client_id', '')),
          client_secret_set: Boolean(process.env.PAYPAL_CLIENT_SECRET || getSetting('paypal_client_secret', '')),
          source: process.env.PAYPAL_CLIENT_ID ? 'env' : (getSetting('paypal_client_id', '') ? 'settings' : 'unset'),
        },
        indexing: {
          indexnow_key: mask(indexing.getIndexNowKey()),
          google: { enabled: googleIndexing.isEnabled(), configured: googleIndexing.status().configured, quota: googleIndexing.status().quota, pending: googleIndexing.status().pending },
          log_rows: indexlog.count(),
        },
        upkeep: upkeep.settings(),
        assistant: {
          engine: 'rule-based (no model, no API)',
          moderation_on: getSetting('ai_moderation_on', '0') === '1',
          auto_run_tools: [...require('./aitools').autoSet()],
        },
      };
    },
  },
  {
    name: 'get_listing', group: 'read', label: 'Full listing detail', mutating: false,
    description: 'Everything the console shows for one listing: all fields, owner, plan, sponsorship, relationships, timeline events, technology radar, news and claims. Look things up here before editing.',
    parameters: {
      type: 'object',
      properties: { id_or_slug: { type: 'string', description: 'Listing id, slug or exact name.' } },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `Read listing ${a.id_or_slug}.`; },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id, slug or name.' };
      const owner = l.owner_user_id ? db.prepare('SELECT id, email, name, plan FROM users WHERE id=?').get(l.owner_user_id) : null;
      let socials = {}; let sources = [];
      try { socials = JSON.parse(l.socials || '{}'); } catch { socials = {}; }
      try { sources = JSON.parse(l.sources || '[]'); } catch { sources = []; }
      return {
        listing: {
          id: l.id, slug: l.slug, name: l.name, tagline: l.tagline, description: l.description,
          type: l.type, category: l.category, website: l.website, email: l.email, phone: l.phone,
          country: l.country, city: l.city, region: l.region, address: l.address, founded: l.founded,
          size: l.size, tags: l.tags, socials, sources, status: l.status, featured: !!l.featured,
          claimed: !!l.claimed, confidence: l.confidence, sponsored: !!l.sponsored,
          sponsored_expires_at: l.sponsored_expires_at, ad_reference: l.ad_reference,
          plan: l.plan || 'free', plan_expires_at: l.plan_expires_at || '',
          logo_url: l.logo_url, last_verified_at: l.last_verified_at,
          created_at: l.created_at, updated_at: l.updated_at,
          hiring_url: l.hiring_url || '', tech_checked_at: l.tech_checked_at || '', news_checked_at: l.news_checked_at || '',
          url: siteUrl(`/listing/${l.slug}`),
        },
        owner,
        technologies: (() => {
          try { return JSON.parse(l.tech || '[]'); } catch { return []; }
        })(),
        relationships: rows('SELECT id, rel_type, target_listing_id, target_name, note FROM relationships WHERE listing_id=? OR target_listing_id=?', l.id, l.id),
        events: rows('SELECT id, event_date, kind, title FROM listing_events WHERE listing_id=? ORDER BY event_date DESC', l.id),
        news: rows('SELECT id, title, url, source, status, origin, published_at FROM listing_news WHERE listing_id=? ORDER BY id DESC LIMIT 12', l.id),
        claims: rows('SELECT id, method, domain, status, created_at FROM claims WHERE listing_id=?', l.id),
        jobs: rows('SELECT id, title, role_type, status FROM jobs WHERE listing_id=?', l.id),
      };
    },
  },
  {
    name: 'get_user', group: 'read', label: 'Full member detail', mutating: false,
    description: 'Everything the console shows for one member: profile, plan, trial, listings, tickets, claims, payments, API keys and notifications.',
    parameters: {
      type: 'object',
      properties: { user: { type: 'string', description: 'Email, name or numeric id.' } },
      required: ['user'], additionalProperties: false,
    },
    summarize(a) { return `Read member ${a.user}.`; },
    run(args) {
      const u = findUser(args.user);
      if (!u) return { error: 'No member matches that email, name or id.' };
      return {
        user: {
          id: u.id, email: u.email, name: u.name, plan: u.plan, plan_expires_at: u.plan_expires_at,
          trial_used: !!u.trial_used, trial_expires_at: u.trial_expires_at || '',
          suspended: !!u.suspended, created_at: u.created_at,
          provider: u.provider || 'password',
          two_factor: Boolean((db.prepare('SELECT enabled FROM user_totp WHERE user_id=?').get(u.id) || {}).enabled),
        },
        listings: rows('SELECT id, slug, name, status, plan, plan_expires_at, featured, claimed FROM listings WHERE owner_user_id=? ORDER BY id DESC', u.id),
        payments: rows('SELECT id, plan_id, duration_days, amount, currency, status, channel, created_at FROM payments WHERE user_id=? ORDER BY id DESC LIMIT 20', u.id),
        tickets: rows('SELECT id, ref, subject, status, updated_at FROM tickets WHERE user_id=? ORDER BY id DESC LIMIT 10', u.id),
        claims: rows('SELECT c.id, c.domain, c.status, l.name AS listing FROM claims c LEFT JOIN listings l ON l.id=c.listing_id WHERE c.user_id=?', u.id),
        api_keys: rows("SELECT id, label, prefix, created_at, last_used_at, total_requests, revoked_at FROM api_keys WHERE user_id=? ORDER BY id DESC"),
        notifications: rows("SELECT id, title, read_at, created_at FROM notifications WHERE user_id=? AND audience='user' ORDER BY id DESC LIMIT 10", u.id),
      };
    },
  },
  {
    name: 'list_content', group: 'read', label: 'List content & commerce', mutating: false,
    description: 'List one of: blog, careers, promos, ads (sponsored packages), plans, categories, incidents, subscribers. Returns the newest first with ids you can act on.',
    parameters: {
      type: 'object',
      properties: {
        what: { type: 'string', enum: ['blog', 'careers', 'promos', 'ads', 'plans', 'categories', 'incidents', 'subscribers', 'payments'] },
        status: { type: 'string', description: 'Optional filter, e.g. draft/published for blog, open/closed for careers, pending for payments.' },
      },
      required: ['what'], additionalProperties: false,
    },
    summarize(a) { return `List ${a.what}${a.status ? ` (${a.status})` : ''}.`; },
    run(args) {
      const what = String(args.what || '').trim();
      const status = String(args.status || '').trim();
      switch (what) {
        case 'blog': {
          const sql = status ? 'SELECT id, slug, title, status, created_at, published_at FROM blog_posts WHERE status=? ORDER BY id DESC LIMIT 40'
            : 'SELECT id, slug, title, status, created_at, published_at FROM blog_posts ORDER BY id DESC LIMIT 40';
          const list = status ? rows(sql, status) : rows(sql);
          return { count: list.length, posts: list };
        }
        case 'careers': {
          const list = status
            ? rows('SELECT id, title, role_type, location, status, created_at FROM careers WHERE status=? ORDER BY id DESC LIMIT 40', status)
            : careers.listAll();
          return { count: list.length, roles: list };
        }
        case 'promos': return { count: promos.all().length, promos: promos.all() };
        case 'ads': return { count: ad.allPackages(false).length, packages: ad.allPackages(false) };
        case 'plans': return { count: plans.allPlans(false).length, offers: plans.allPlans(false) };
        case 'categories': {
          const list = catLib.withCounts();
          return { count: list.length, categories: list.slice(0, 200) };
        }
        case 'incidents': { const list = mon.allIncidents().slice(0, 40); return { count: list.length, incidents: list }; }
        case 'subscribers': {
          const list = rows('SELECT email, active, created_at FROM newsletter_subscribers ORDER BY id DESC LIMIT 50');
          return { count: list.length, active_total: countOf('SELECT COUNT(*) c FROM newsletter_subscribers WHERE active=1'), subscribers: list };
        }
        case 'payments': {
          const list = status
            ? rows('SELECT id, user_id, plan_id, amount, currency, status, channel, created_at FROM payments WHERE status=? ORDER BY id DESC LIMIT 40', status)
            : rows('SELECT id, user_id, plan_id, amount, currency, status, channel, created_at FROM payments ORDER BY id DESC LIMIT 40');
          return { count: list.length, payments: list };
        }
        default:
          return { error: 'Pick one of: blog, careers, promos, ads, plans, categories, incidents, subscribers, payments.' };
      }
    },
  },
  {
    name: 'list_news_queue', group: 'read', label: 'Listing news queue', mutating: false,
    description: 'Listing news: the moderation queue (pending), what is published, or everything for one listing.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'approved', 'rejected'], description: 'Which queue to list. Defaults to pending when omitted.' },
        listing: { type: 'string', description: 'Optional listing id or slug to scope the list.' },
      },
      additionalProperties: false,
    },
    summarize(a) { return `List ${a.status || 'pending'} listing news${a.listing ? ` for ${a.listing}` : ''}.`; },
    run(args) {
      const status = ['pending', 'approved', 'rejected'].includes(String(args.status || '')) ? String(args.status) : 'pending';
      if (args.listing) {
        const l = findListing(args.listing);
        if (!l) return { error: 'No listing matches that id or slug.' };
        const list = rows('SELECT id, title, url, source, status, origin, published_at FROM listing_news WHERE listing_id=? ORDER BY id DESC LIMIT 40', l.id);
        return { count: list.length, listing: l.name, stories: list };
      }
      const list = news.recent(status, 60).map((n) => ({
        id: n.id, title: n.title, url: n.url, source: n.source, status: n.status, origin: n.origin,
        listing: n.listing_name || '', listing_slug: n.listing_slug || '', published_at: n.published_at,
      }));
      return { count: list.length, status, counts: news.counts(), stories: list };
    },
  },
  {
    name: 'get_admin_inbox', group: 'read', label: 'Admin inbox', mutating: false,
    description: 'The admin console notification inbox: unread count, the newest notifications, and what is sitting in trash.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max rows (default 25).' } },
      additionalProperties: false,
    },
    summarize() { return 'Read the admin inbox.'; },
    run(args) {
      const limit = Math.max(1, Math.min(100, int(args.limit, 25)));
      return {
        unread: notify.unreadAdmin(),
        notifications: rows("SELECT id, kind, title, body, url, read_at, created_at FROM notifications WHERE audience='admin' AND deleted_at IS NULL ORDER BY id DESC LIMIT ?", limit),
        trash: notifications.getTrash(null, 25).map((n) => ({ id: n.id, title: n.title, deleted_at: n.deleted_at })),
      };
    },
  },
  {
    name: 'get_payments_summary', group: 'read', label: 'Revenue summary', mutating: false,
    description: 'Money: totals and counts of payments by status, revenue captured, active Pro accounts and listings, promo redemptions and recent transactions.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Read the revenue summary.'; },
    run() {
      const today = new Date().toISOString().slice(0, 10);
      const proSql = "(plan='pro' AND (plan_expires_at IS NULL OR plan_expires_at='' OR plan_expires_at >= ?))";
      return {
        totals: rows('SELECT status, COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount, currency FROM payments GROUP BY status, currency'),
        captured_usd: (db.prepare("SELECT COALESCE(SUM(amount),0) AS a FROM payments WHERE status='completed' AND currency='USD'").get() || {}).a || 0,
        pro_users: countOf(`SELECT COUNT(*) c FROM users WHERE ${proSql}`, today),
        pro_listings: countOf(`SELECT COUNT(*) c FROM listings WHERE ${proSql}`, today),
        sponsored: countOf('SELECT COUNT(*) c FROM listings WHERE sponsored=1'),
        trials_active: countOf("SELECT COUNT(*) c FROM users WHERE trial_expires_at IS NOT NULL AND trial_expires_at <> '' AND trial_expires_at >= ?", today),
        promo_redemptions: countOf('SELECT COUNT(*) c FROM promo_redemptions'),
        recent: rows('SELECT id, user_id, amount, currency, status, channel, created_at FROM payments ORDER BY id DESC LIMIT 15'),
      };
    },
  },
  {
    name: 'get_indexing_status', group: 'read', label: 'Indexing & upkeep', mutating: false,
    description: 'Search-indexing health: IndexNow log tail, Google Indexing API credentials/quota/queue, the upkeep schedule and the state of any running tech or news sweep.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Read indexing and upkeep status.'; },
    run() {
      const g = googleIndexing.status();
      return {
        indexnow: { enabled: indexing.enabled(), log_rows: indexlog.count(), recent: indexlog.recent(15) },
        google: {
          enabled: g.enabled, configured: g.configured, source_label: g.source_label, client_email: g.client_email,
          quota: g.quota, pending: g.pending, submitted: g.submitted, job: g.job, last_run: g.last_run,
        },
        upkeep: upkeep.settings(),
        tech_job: techrefresh.jobState(),
        tech_stale: techrefresh.staleCount(),
        news_job: news.jobState(),
        news_counts: news.counts(),
      };
    },
  },
  {
    name: 'get_status_page', group: 'read', label: 'Status page state', mutating: false,
    description: 'The public status page: monitored components, current overall headline, uptime, open incidents and subscriber count.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Read the status page state.'; },
    run() {
      mon.ensureComponents();
      return {
        overall: mon.overallStatus(),
        overall_label: mon.OVERALL_LABELS[mon.overallStatus()] || '',
        components: mon.components().map((c) => ({ id: c.id, slug: c.slug, name: c.name, status: c.status, status_label: mon.STATUS_LABELS[c.status] || c.status })),
        uptime_90d: mon.overallUptime(90),
        incidents: mon.allIncidents().slice(0, 15),
        subscribers: mon.subscriberCount(),
        weekly_report_on: getSetting('status_weekly_report', '0') === '1',
        url: siteUrl('/status'),
      };
    },
  },
  {
    name: 'get_ai_playground', group: 'read', label: 'Assistant state', mutating: false,
    description: 'The AI Playground: assistant engine (rule-based, no model), auto-moderation settings, auto-run allow-list, pending confirmations and the latest audit entries.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Read the assistant state.'; },
    run() {
      const aitools = require('./aitools');
      return {
        engine: 'rule-based',
        tools: aitools.TOOLS.length,
        auto_run_tools: [...aitools.autoSet()],
        moderation: {
          on: getSetting('ai_moderation_on', '0') === '1',
          email_admin: getSetting('ai_moderation_email', '1') === '1',
          approve_at: Number(getSetting('ai_moderation_approve_at', '75') || 75),
          reject_at: Number(getSetting('ai_moderation_reject_at', '25') || 25),
          blocklist_terms: String(getSetting('ai_moderation_blocklist', '') || '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean).length,
        },
        pending_confirmations: countOf('SELECT COUNT(*) c FROM ai_pending_actions'),
        recent_audit: rows('SELECT id, kind, action, result, created_at FROM ai_audit_log ORDER BY id DESC LIMIT 15'),
      };
    },
  },
  {
    name: 'list_listings', group: 'read', label: 'List listings', mutating: false,
    description: 'List listings filtered by status, featured, sponsored, claimed, category, country or recency. Newest first unless order=oldest.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
        featured: { type: 'boolean' }, sponsored: { type: 'boolean' }, claimed: { type: 'boolean' },
        category: { type: 'string' }, country: { type: 'string' }, owner: { type: 'string', description: 'Owner user id or email' },
        since_days: { type: 'integer' }, order: { type: 'string', enum: ['newest', 'oldest'] }, limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    summarize(a) { return `List ${a.status || ''} listings${a.category ? ' in ' + a.category : ''}${a.country ? ' from ' + a.country : ''}.`; },
    run(args) {
      const where = []; const p = [];
      if (['pending', 'approved', 'rejected'].includes(String(args.status || ''))) { where.push('status=?'); p.push(args.status); }
      if (args.featured === true) where.push('featured=1');
      if (args.sponsored === true) where.push('sponsored=1');
      if (args.claimed === true) where.push('claimed=1'); else if (args.claimed === false) where.push('claimed=0');
      if (args.category) { where.push('category = ? COLLATE NOCASE'); p.push(String(args.category)); }
      if (args.country) { where.push('country LIKE ?'); p.push(`%${String(args.country)}%`); }
      if (args.owner) { const u = findUser(String(args.owner)); if (!u) return { error: 'No member matches that owner.' }; where.push('owner_user_id=?'); p.push(u.id); }
      const since = Math.min(3650, Math.max(0, Number(args.since_days || 0)));
      if (since) { where.push("created_at >= datetime('now', ?)"); p.push(`-${since} days`); }
      const limit = Math.min(100, Math.max(1, Number(args.limit || 20)));
      const order = args.order === 'oldest' ? 'ASC' : 'DESC';
      const sql = `SELECT id, slug, name, status, category, country, featured, sponsored, claimed, plan, created_at FROM listings${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at ${order}, id ${order} LIMIT ${limit}`;
      const listings = rows(sql, ...p);
      const total = countOf(`SELECT COUNT(*) c FROM listings${where.length ? ' WHERE ' + where.join(' AND ') : ''}`, ...p);
      const filters = [args.status, args.featured && 'featured', args.sponsored && 'sponsored', args.claimed === true && 'claimed', args.claimed === false && 'unclaimed', args.category, args.country, args.owner && `owned by ${args.owner}`, since && `last ${since} days`].filter(Boolean).join(', ');
      return { count: listings.length, total, filters, listings: listings.map((l) => ({ ...l, featured: !!l.featured, sponsored: !!l.sponsored, claimed: !!l.claimed })) };
    },
  },
  {
    name: 'list_users', group: 'read', label: 'List members', mutating: false,
    description: 'List members, optionally only suspended, by plan (pro/free), on trial, or signed up in the last N days.',
    parameters: {
      type: 'object',
      properties: {
        suspended: { type: 'boolean' }, plan: { type: 'string', enum: ['pro', 'free'] }, trial: { type: 'boolean' },
        since_days: { type: 'integer' }, limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
    summarize(a) { return `List ${a.suspended ? 'suspended ' : ''}${a.plan || ''} members.`; },
    run(args) {
      const where = []; const p = [];
      if (args.suspended === true) where.push('u.suspended=1');
      if (args.plan === 'pro') where.push("u.plan='pro'"); else if (args.plan === 'free') where.push("(u.plan IS NULL OR u.plan='' OR u.plan='free')");
      if (args.trial === true) where.push("u.trial_expires_at > datetime('now')");
      const since = Math.min(3650, Math.max(0, Number(args.since_days || 0)));
      if (since) { where.push("u.created_at >= datetime('now', ?)"); p.push(`-${since} days`); }
      const limit = Math.min(100, Math.max(1, Number(args.limit || 20)));
      const users = rows(`SELECT u.id, u.email, u.name, u.plan, u.suspended, u.trial_expires_at, u.created_at, (SELECT COUNT(*) FROM listings l WHERE l.owner_user_id=u.id) AS listings FROM users u${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY u.id DESC LIMIT ${limit}`, ...p);
      const total = countOf(`SELECT COUNT(*) c FROM users u${where.length ? ' WHERE ' + where.join(' AND ') : ''}`, ...p);
      const filters = [args.suspended && 'suspended', args.plan, args.trial && 'on trial', since && `joined in the last ${since} days`].filter(Boolean).join(', ');
      return { count: users.length, total, filters, users: users.map((u) => ({ ...u, suspended: !!u.suspended })) };
    },
  },
  {
    name: 'list_tickets', group: 'read', label: 'List tickets', mutating: false,
    description: 'List support tickets by status (open, solved, closed) or all.',
    parameters: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'solved', 'closed', ''] }, limit: { type: 'integer' } }, additionalProperties: false },
    summarize(a) { return `List ${a.status || 'all'} tickets.`; },
    run(args) {
      const st = ['open', 'solved', 'closed'].includes(String(args.status || '')) ? String(args.status) : '';
      const limit = Math.min(100, Math.max(1, Number(args.limit || 30)));
      const tickets = rows(`SELECT t.id, t.ref, t.subject, t.category, t.status, t.created_at, t.updated_at, u.email AS user_email FROM tickets t JOIN users u ON u.id=t.user_id${st ? ' WHERE t.status=?' : ''} ORDER BY t.updated_at DESC LIMIT ${limit}`, ...(st ? [st] : []));
      return { count: tickets.length, status: st, tickets };
    },
  },
  {
    name: 'get_ticket', group: 'read', label: 'Ticket detail', mutating: false,
    description: 'One support ticket with its message thread (id or FL- reference).',
    parameters: { type: 'object', properties: { id_or_ref: { type: 'string' } }, required: ['id_or_ref'], additionalProperties: false },
    summarize(a) { return `Read ticket ${a.id_or_ref}.`; },
    run(args) {
      const raw = String(args.id_or_ref || '').trim();
      const t = /^\d+$/.test(raw)
        ? db.prepare('SELECT t.*, u.email AS user_email, u.name AS user_name FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.id=?').get(Number(raw))
        : db.prepare('SELECT t.*, u.email AS user_email, u.name AS user_name FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.ref=? COLLATE NOCASE').get(raw);
      if (!t) return { error: 'Ticket not found.' };
      const messages = rows('SELECT id, sender, body, attachment_name, created_at FROM ticket_messages WHERE ticket_id=? ORDER BY id ASC', t.id);
      return { ticket: { id: t.id, ref: t.ref, subject: t.subject, category: t.category, status: t.status, user_id: t.user_id, user_email: t.user_email, user_name: t.user_name, created_at: t.created_at, updated_at: t.updated_at, closed_at: t.closed_at }, messages };
    },
  },

  /* ==================== Listings ==================== */
  {
    name: 'create_listing', group: 'listings', label: 'Create listing', mutating: true,
    description: 'Create a listing directly in the directory (same fields as Admin → Listings → New). Saved as pending unless status=approved is given.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' }, tagline: { type: 'string' }, description: { type: 'string' },
        website: { type: 'string' }, category: { type: 'string' }, type: { type: 'string', description: 'company | startup | agency | organisation | product | service | publisher' },
        country: { type: 'string' }, city: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' },
        founded: { type: 'string' }, size: { type: 'string' }, tags: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'approved'] },
        owner_email: { type: 'string', description: 'Optional member email to attach as owner.' },
      },
      required: ['name', 'tagline', 'description', 'website', 'category', 'type', 'country'], additionalProperties: false,
    },
    summarize(a) { return `Create listing “${a.name}” as ${a.status || 'pending'}.`; },
    run(args) {
      const { slugify, normalizeUrl } = require('./util');
      const name = str(args.name, 60);
      const tagline = str(args.tagline, 90);
      const description = str(args.description, 4000);
      const website = str(args.website, 200);
      if (name.length < 2) return { error: 'Name needs at least 2 characters.' };
      if (tagline.length < 5) return { error: 'Tagline needs at least 5 characters.' };
      if (description.length < 40) return { error: 'Description needs at least 40 characters.' };
      if (!/^https?:\/\//i.test(website)) return { error: 'Website must start with http:// or https://.' };
      const cat = str(args.category, 40) || 'Other';
      catLib.ensure(cat);
      let slug = slugify(name);
      let n = 2;
      while (db.prepare('SELECT id FROM listings WHERE slug=?').get(slug)) slug = `${slugify(name)}-${n++}`;
      const owner = args.owner_email ? findUser(args.owner_email) : null;
      if (args.owner_email && !owner) return { error: `No member matches “${args.owner_email}”.` };
      const status = args.status === 'approved' ? 'approved' : 'pending';
      const info = db.prepare(
        `INSERT INTO listings (slug, name, tagline, description, type, category, website, email, phone, country, city, founded, size, tags, status, owner_user_id, submitter_user_id, last_verified_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        slug, name, tagline, description, str(args.type, 20) || 'company', cat, normalizeUrl(website),
        str(args.email, 190), str(args.phone, 40), str(args.country, 60), str(args.city, 80),
        str(args.founded, 12), str(args.size, 20), str(args.tags, 160), status,
        owner ? owner.id : null, owner ? owner.id : null,
        status === 'approved' ? new Date().toISOString() : null,
      );
      const created = db.prepare('SELECT * FROM listings WHERE id=?').get(info.lastInsertRowid);
      if (status === 'approved') approveListingRow(created);
      return { ok: true, id: created.id, slug: created.slug, name: created.name, status: created.status, url: siteUrl(`/listing/${created.slug}`) };
    },
  },
  {
    name: 'update_listing', group: 'listings', label: 'Edit listing fields', mutating: true,
    description: 'Edit any field of a listing (same form as Admin → Listings → Edit): name, tagline, description, type, category, website, email, phone, country, city, region, address, founded, size, tags, status, logo_url. Only the fields you send are changed.',
    parameters: {
      type: 'object',
      properties: {
        id_or_slug: { type: 'string' },
        name: { type: 'string' }, tagline: { type: 'string' }, description: { type: 'string' },
        type: { type: 'string' }, category: { type: 'string' }, website: { type: 'string' },
        email: { type: 'string' }, phone: { type: 'string' }, country: { type: 'string' },
        city: { type: 'string' }, region: { type: 'string' }, address: { type: 'string' },
        founded: { type: 'string' }, size: { type: 'string' }, tags: { type: 'string' },
        logo_url: { type: 'string' }, status: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
      },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `Edit listing ${a.id_or_slug}.`; },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      const FIELDS = {
        name: 60, tagline: 90, description: 4000, type: 20, category: 40, website: 200, email: 190,
        phone: 40, country: 60, city: 80, region: 80, address: 200, founded: 12, size: 20, tags: 160, logo_url: 300,
      };
      const sets = []; const params = []; const changed = [];
      for (const [key, max] of Object.entries(FIELDS)) {
        if (args[key] === undefined || args[key] === null) continue;
        const v = str(args[key], max);
        sets.push(`${key}=?`); params.push(v); changed.push(key);
      }
      if (['pending', 'approved', 'rejected'].includes(String(args.status || ''))) {
        sets.push('status=?'); params.push(String(args.status)); changed.push('status');
      }
      if (!changed.length) return { error: 'Nothing to change — send at least one field.' };
      if (args.website !== undefined && args.website && !/^https?:\/\//i.test(String(args.website))) return { error: 'Website must start with http:// or https://.' };
      if (args.category !== undefined) catLib.ensure(str(args.category, 40));
      sets.push("updated_at=datetime('now')");
      params.push(l.id);
      db.prepare(`UPDATE listings SET ${sets.join(', ')} WHERE id=?`).run(...params);
      const fresh = db.prepare('SELECT * FROM listings WHERE id=?').get(l.id);
      if (args.status === 'approved' && l.status !== 'approved') approveListingRow(fresh);
      if (args.status === 'rejected' && l.status !== 'rejected') rejectListingRow(fresh);
      return { ok: true, id: fresh.id, slug: fresh.slug, name: fresh.name, changed, status: fresh.status };
    },
  },
  {
    name: 'bulk_listing_action', group: 'listings', label: 'Bulk listing action', mutating: true, sensitive: true,
    description: 'Apply one action to many listings at once: approve, reject, delete, feature, unfeature, sponsor or unsponsor. Scope by status, category, country or an explicit list of ids. Always confirm the count first with search_listings or get_listing_stats.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['approve', 'reject', 'delete', 'feature', 'unfeature', 'sponsor', 'unsponsor'] },
        ids: { type: 'array', items: { type: 'integer' }, description: 'Explicit listing ids (preferred).' },
        status: { type: 'string', enum: ['pending', 'approved', 'rejected'], description: 'Filter when ids is empty. Omit to not filter by status.' },
        category: { type: 'string' }, country: { type: 'string' },
        days: { type: 'integer', description: 'Sponsorship length in days (sponsor only).' },
      },
      required: ['action'], additionalProperties: false,
    },
    summarize(a) { return `${String(a.action).toUpperCase()} ${(a.ids || []).length ? (a.ids || []).length + ' selected listing(s)' : `listings${a.status ? ` with status ${a.status}` : ' (ALL listings)'}`}.`; },
    run(args) {
      const action = String(args.action || '').trim();
      const acts = ['approve', 'reject', 'delete', 'feature', 'unfeature', 'sponsor', 'unsponsor'];
      if (!acts.includes(action)) return { error: `Action must be one of: ${acts.join(', ')}.` };
      let targets = [];
      const ids = Array.isArray(args.ids) ? args.ids.map((n) => Number(n)).filter((n) => n > 0) : [];
      if (ids.length) {
        targets = db.prepare(`SELECT * FROM listings WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      } else {
        const where = []; const params = [];
        if (['pending', 'approved', 'rejected'].includes(String(args.status || ''))) { where.push('status=?'); params.push(String(args.status)); }
        if (args.category) { where.push('category=?'); params.push(str(args.category, 40)); }
        if (args.country) { where.push('country=?'); params.push(str(args.country, 60)); }
        if (!where.length) return { error: 'Refuse to touch the whole directory: give ids, or at least a status filter.' };
        targets = db.prepare(`SELECT * FROM listings WHERE ${where.join(' AND ')} LIMIT 500`).all(...params);
      }
      if (!targets.length) return { error: 'No listings matched that selection.' };
      const days = Math.max(1, Math.min(365, int(args.days, 7)));
      const done = [];
      for (const l of targets) {
        if (action === 'approve') { approveListingRow(l); done.push(l.id); } else if (action === 'reject') { rejectListingRow(l); done.push(l.id); } else if (action === 'delete') {
          db.prepare('DELETE FROM listings WHERE id=?').run(l.id); done.push(l.id);
        } else if (action === 'feature' || action === 'unfeature') {
          db.prepare('UPDATE listings SET featured=?, updated_at=datetime(\'now\') WHERE id=?').run(action === 'feature' ? 1 : 0, l.id); done.push(l.id);
        } else if (action === 'sponsor') {
          const until = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
          db.prepare("UPDATE listings SET sponsored=1, sponsored_expires_at=?, updated_at=datetime('now') WHERE id=?").run(until, l.id); done.push(l.id);
        } else {
          db.prepare("UPDATE listings SET sponsored=0, sponsored_expires_at='', updated_at=datetime('now') WHERE id=?").run(l.id); done.push(l.id);
        }
      }
      return { ok: true, action, affected: done.length, ids: done.slice(0, 50), truncated: done.length > 50 };
    },
  },
  {
    name: 'set_listing_relation', group: 'listings', label: 'Listing relationships', mutating: true,
    description: 'Add or remove a relationship on a listing (parent, subsidiary, brand, competitor, partner…). Target can be another listing id or a free-text name.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove'] },
        id_or_slug: { type: 'string' },
        rel_type: { type: 'string', description: 'parent | subsidiary | brand | competitor | partner' },
        target: { type: 'string', description: 'Target listing id, slug or free-text name (for add).' },
        note: { type: 'string' },
        relation_id: { type: 'integer', description: 'Relationship row id (for remove).' },
      },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `${a.action === 'remove' ? 'Remove' : 'Add'} a relationship on ${a.id_or_slug}.`; },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      if (String(args.action || 'add') === 'remove') {
        const id = int(args.relation_id, 0);
        if (!id) return { error: 'Give the relation_id to remove (read it with get_listing).' };
        const info = db.prepare('DELETE FROM relationships WHERE id=? AND (listing_id=? OR target_listing_id=?)').run(id, l.id, l.id);
        if (!info.changes) return { error: 'That relationship is not on this listing.' };
        return { ok: true, removed: id };
      }
      const relType = str(args.rel_type, 30) || 'partner';
      const target = str(args.target, 120);
      if (!target) return { error: 'Give a target listing id, slug or name.' };
      const t = findListing(target);
      if (t && t.id === l.id) return { error: 'A listing cannot be related to itself.' };
      db.prepare('INSERT INTO relationships (listing_id, rel_type, target_listing_id, target_name, note) VALUES (?,?,?,?,?)')
        .run(l.id, relType, t ? t.id : null, t ? t.name : target, str(args.note, 200));
      return { ok: true, listing: l.name, rel_type: relType, target: t ? t.name : target, target_id: t ? t.id : null };
    },
  },
  {
    name: 'manage_listing_event', group: 'listings', label: 'Listing timeline event', mutating: true,
    description: 'Add or delete an entry on a listing\'s events timeline (funding, launch, award, milestone).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'delete'] },
        id_or_slug: { type: 'string' },
        title: { type: 'string' },
        event_date: { type: 'string', description: 'YYYY-MM-DD' },
        kind: { type: 'string', description: 'milestone | funding | launch | award' },
        event_id: { type: 'integer', description: 'Event row id (for delete).' },
      },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return `${a.action === 'delete' ? 'Delete' : 'Add'} a timeline event on ${a.id_or_slug}.`; },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      if (String(args.action || 'add') === 'delete') {
        const id = int(args.event_id, 0);
        const info = db.prepare('DELETE FROM listing_events WHERE id=? AND listing_id=?').run(id, l.id);
        if (!info.changes) return { error: 'No such event on this listing.' };
        return { ok: true, deleted: id };
      }
      const title = str(args.title, 160);
      if (title.length < 3) return { error: 'Give the event a title.' };
      const date = /^\d{4}-\d{2}-\d{2}$/.test(str(args.event_date, 10)) ? str(args.event_date, 10) : new Date().toISOString().slice(0, 10);
      const info = db.prepare('INSERT INTO listing_events (listing_id, event_date, kind, title) VALUES (?,?,?,?)')
        .run(l.id, date, str(args.kind, 20) || 'milestone', title);
      return { ok: true, id: info.lastInsertRowid, listing: l.name, title, event_date: date };
    },
  },

  /* ==================== Content ==================== */
  {
    name: 'edit_blog_post', group: 'content', label: 'Edit blog post', mutating: true,
    description: 'Edit an existing blog post by id: title, excerpt, body, slug or status.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer' }, title: { type: 'string' }, excerpt: { type: 'string' },
        body: { type: 'string' }, slug: { type: 'string' }, status: { type: 'string', enum: ['draft', 'published'] },
      },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Edit blog post #${a.id}.`; },
    run(args) {
      const { slugify } = require('./util');
      const p = db.prepare('SELECT * FROM blog_posts WHERE id=?').get(int(args.id, 0));
      if (!p) return { error: 'No blog post with that id.' };
      const sets = []; const params = []; const changed = [];
      if (args.title !== undefined) { sets.push('title=?'); params.push(str(args.title, 160)); changed.push('title'); }
      if (args.excerpt !== undefined) { sets.push('excerpt=?'); params.push(str(args.excerpt, 400)); changed.push('excerpt'); }
      if (args.body !== undefined) { sets.push('body=?'); params.push(str(args.body, 40000)); changed.push('body'); }
      if (args.slug !== undefined) {
        const s = slugify(args.slug) || p.slug;
        const clash = db.prepare('SELECT id FROM blog_posts WHERE slug=? AND id<>?').get(s, p.id);
        if (clash) return { error: `Slug “${s}” is already used by post #${clash.id}.` };
        sets.push('slug=?'); params.push(s); changed.push('slug');
      }
      if (args.status !== undefined) {
        sets.push('status=?'); params.push(args.status === 'published' ? 'published' : 'draft'); changed.push('status');
        if (args.status === 'published' && !p.published_at) sets.push("published_at=datetime('now')");
      }
      if (!changed.length) return { error: 'Nothing to change.' };
      sets.push("updated_at=datetime('now')");
      params.push(p.id);
      db.prepare(`UPDATE blog_posts SET ${sets.join(', ')} WHERE id=?`).run(...params);
      return { ok: true, id: p.id, changed, url: siteUrl(`/blog/${p.slug}`) };
    },
  },
  {
    name: 'create_news_story', group: 'content', label: 'Add news story', mutating: true,
    description: 'Add a hand-written news story to a listing (publishes straight away, same as Admin → News → Add story).',
    parameters: {
      type: 'object',
      properties: {
        id_or_slug: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' },
        source: { type: 'string' }, published_at: { type: 'string', description: 'YYYY-MM-DD' }, summary: { type: 'string' },
      },
      required: ['id_or_slug', 'title'], additionalProperties: false,
    },
    summarize(a) { return `Add news story “${String(a.title).slice(0, 60)}” to ${a.id_or_slug}.`; },
    run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No listing matches that id or slug.' };
      const r = news.addManual({
        listing: l, title: args.title, url: args.url, source: args.source,
        published_at: args.published_at, summary: args.summary,
      });
      if (!r.ok) return { error: r.error };
      return { ok: true, id: r.id, listing: l.name, title: str(args.title, 220), status: 'approved' };
    },
  },
  {
    name: 'delete_news_story', group: 'content', label: 'Delete news story', mutating: true, sensitive: true,
    description: 'Permanently delete a listing news story by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Delete news story #${a.id}.`; },
    run(args) {
      const n = db.prepare('SELECT * FROM listing_news WHERE id=?').get(int(args.id, 0));
      if (!n) return { error: 'No news story with that id.' };
      news.remove(n.id);
      return { ok: true, deleted: n.id, title: n.title };
    },
  },
  {
    name: 'set_news_settings', group: 'content', label: 'News moderation setting', mutating: true,
    description: 'Decide whether auto-detected listing news waits for moderation before it appears.',
    parameters: {
      type: 'object',
      properties: { review_auto: { type: 'boolean' } },
      required: ['review_auto'], additionalProperties: false,
    },
    summarize(a) { return a.review_auto ? 'Hold detected news for moderation.' : 'Publish detected news automatically.'; },
    run(args) {
      setSetting('news_review_auto', bool(args.review_auto) ? '1' : '0');
      return { ok: true, news_review_auto: getSetting('news_review_auto', '0') === '1' };
    },
  },
  {
    name: 'run_news_refresh', group: 'content', label: 'News sweep', mutating: true,
    description: 'Search for news about listings. action=one scans a single listing now; action=start queues a background sweep (ids or stale); action=cancel stops a running sweep.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['one', 'start', 'cancel'] },
        id_or_slug: { type: 'string', description: 'Listing for action=one.' },
        ids: { type: 'array', items: { type: 'integer' }, description: 'Listing ids for action=start.' },
        limit: { type: 'integer', description: 'How many stale listings to queue (default 20).' },
      },
      required: ['action'], additionalProperties: false,
    },
    summarize(a) { return `News sweep: ${a.action}.`; },
    async run(args) {
      if (args.action === 'cancel') {
        const r = news.cancel();
        return { ok: true, cancelled: Boolean(r && r.ok !== false), job: news.jobState() };
      }
      if (args.action === 'one') {
        const l = findListing(args.id_or_slug);
        if (!l) return { error: 'No listing matches that id or slug.' };
        const r = await news.fetchFor(l);
        if (!r.ok) return { error: r.error || `Skipped (${r.skipped || 'no match'}).`, scanned: r.scanned };
        return { ok: true, listing: l.name, scanned: r.scanned, matched: r.matched, added: r.added };
      }
      const ids = Array.isArray(args.ids) && args.ids.length
        ? args.ids.map((n) => Number(n)).filter((n) => n > 0)
        : news.staleListingIds({ limit: Math.max(1, Math.min(500, int(args.limit, 20))) });
      if (!ids.length) return { error: 'Nothing is due a news refresh right now.' };
      const r = news.start(ids, 'assistant');
      if (!r.ok) return { error: r.error };
      return { ok: true, queued: ids.length, job: r.job };
    },
  },
  {
    name: 'edit_career', group: 'content', label: 'Edit job role', mutating: true,
    description: 'Edit a FirmLedger careers role: title, role_type, location, description, requirements, apply_email, status.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer' }, title: { type: 'string' }, role_type: { type: 'string' },
        location: { type: 'string' }, description: { type: 'string' }, requirements: { type: 'string' },
        apply_email: { type: 'string' }, status: { type: 'string', enum: ['open', 'closed'] },
      },
      required: ['id'], additionalProperties: false,
    },
    summarize(a) { return `Edit job role #${a.id}.`; },
    run(args) {
      const r = careers.update(int(args.id, 0), args);
      if (!r.ok) return { error: (r.errors || ['That role could not be updated.']).join(' ') };
      return { ok: true, id: r.id };
    },
  },
  {
    name: 'delete_career', group: 'content', label: 'Delete job role', mutating: true, sensitive: true,
    description: 'Permanently delete a careers role by id.',
    parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
    summarize(a) { return `Delete job role #${a.id}.`; },
    run(args) {
      const ok = careers.remove(args.id);
      if (!ok) return { error: 'No role with that id.' };
      return { ok: true, deleted: int(args.id, 0) };
    },
  },
  {
    name: 'delete_promo', group: 'content', label: 'Delete promo code', mutating: true, sensitive: true,
    description: 'Delete a promo code. Codes with payments attached are deactivated instead so history survives.',
    parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
    summarize(a) { return `Delete promo code #${a.id}.`; },
    run(args) {
      const r = promos.remove(int(args.id, 0));
      if (!r.ok) return { error: 'No promo code with that id.' };
      return { ok: true, id: int(args.id, 0), deactivated: Boolean(r.deactivated) };
    },
  },
  {
    name: 'delete_plan_offer', group: 'content', label: 'Delete plan offer', mutating: true, sensitive: true,
    description: 'Delete a pricing offer. Offers with payments attached are deactivated instead so history survives.',
    parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
    summarize(a) { return `Delete plan offer #${a.id}.`; },
    run(args) {
      const p = plans.getPlan(args.id);
      if (!p) return { error: 'No offer with that id.' };
      const refs = countOf('SELECT COUNT(*) c FROM payments WHERE plan_id=?', p.id);
      if (refs > 0) {
        db.prepare('UPDATE plans SET active=0 WHERE id=?').run(p.id);
        return { ok: true, id: p.id, name: p.name, deactivated: true, note: `${refs} payment(s) reference it — deactivated, not deleted.` };
      }
      db.prepare('DELETE FROM plans WHERE id=?').run(p.id);
      return { ok: true, id: p.id, name: p.name, deleted: true };
    },
  },
  {
    name: 'set_ad_package', group: 'content', label: 'Sponsored advert package', mutating: true,
    description: 'Create, show/hide or delete a Sponsored Content advert package (Admin → Advertising).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'toggle', 'delete'] },
        id: { type: 'integer', description: 'Package id (toggle/delete).' },
        name: { type: 'string' }, blurb: { type: 'string' },
        price_usd: { type: 'number' }, duration_days: { type: 'integer' },
      },
      required: ['action'], additionalProperties: false,
    },
    summarize(a) { return `${a.action} advert package${a.id ? ` #${a.id}` : (a.name ? ` “${a.name}”` : '')}.`; },
    run(args) {
      const action = String(args.action || '');
      if (action === 'create') {
        const name = str(args.name, 60);
        const price = num(args.price_usd, 0);
        const days = int(args.duration_days, 0);
        if (!name) return { error: 'The package needs a name.' };
        if (!(price > 0)) return { error: 'Enter a price above 0.' };
        if (days < 1 || days > 3650) return { error: 'Duration must be 1–3650 days.' };
        const info = ad.createPackage({ name, blurb: str(args.blurb, 240), priceCents: Math.round(price * 100), currency: 'USD', durationDays: days });
        return { ok: true, id: info.lastInsertRowid, name, price_usd: price, duration_days: days };
      }
      if (action === 'toggle') {
        const p = ad.togglePackage(int(args.id, 0));
        if (!p) return { error: 'No package with that id.' };
        return { ok: true, id: p.id, name: p.name, active: !!p.active };
      }
      const before = ad.getPackage(int(args.id, 0));
      if (!before) return { error: 'No package with that id.' };
      ad.deletePackage(before.id);
      return { ok: true, deleted: before.id, name: before.name };
    },
  },

  /* ==================== Indexing & upkeep ==================== */
  {
    name: 'run_tech_refresh', group: 'indexing', label: 'Technology radar sweep', mutating: true,
    description: 'Start or cancel the background technology-radar sweep (Admin → Listings → Refresh tech). Pass ids for a selection, or scope=stale / scope=all.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'cancel'] },
        scope: { type: 'string', enum: ['stale', 'all', 'selected'] },
        ids: { type: 'array', items: { type: 'integer' } },
      },
      required: ['action'], additionalProperties: false,
    },
    summarize(a) { return `Technology sweep: ${a.action}${a.scope ? ` (${a.scope})` : ''}.`; },
    run(args) {
      if (args.action === 'cancel') {
        const r = techrefresh.cancel();
        return { ok: true, cancelled: Boolean(r && r.ok !== false), job: techrefresh.jobState() };
      }
      let ids = Array.isArray(args.ids) ? args.ids.map((n) => Number(n)).filter((n) => n > 0) : [];
      let scope = String(args.scope || 'selected');
      if (!ids.length && scope === 'stale') ids = techrefresh.staleIds(200);
      if (!ids.length && scope === 'all') ids = techrefresh.allIds();
      if (!ids.length) return { error: 'Nothing to refresh — pass ids, or scope=stale / scope=all.' };
      const r = techrefresh.start(ids, scope);
      if (!r.ok) return { error: r.error };
      return { ok: true, queued: ids.length, scope, job: r.job };
    },
  },
  {
    name: 'run_upkeep_sweep', group: 'indexing', label: 'Run upkeep now', mutating: true,
    description: 'Run the scheduled upkeep sweep immediately (technology refresh + news for whatever is due).',
    parameters: {
      type: 'object',
      properties: { force: { type: 'boolean', description: 'Run even when upkeep is switched off.' } },
      additionalProperties: false,
    },
    summarize(a) { return `Run the upkeep sweep${a.force ? ' (forced)' : ''}.`; },
    async run(args) {
      const r = await upkeep.runSweep({ force: bool(args.force) });
      if (!r.ok) return { error: r.skipped === 'already-running' ? 'A sweep is already running.' : `Skipped (${r.skipped}).` };
      return { ok: true, tech: r.tech, news: r.news };
    },
  },
  {
    name: 'set_upkeep_settings', group: 'indexing', label: 'Upkeep schedule', mutating: true,
    description: 'Configure the automatic upkeep: master switch, technology refresh, news refresh and their per-run limits.',
    parameters: {
      type: 'object',
      properties: {
        on: { type: 'boolean' }, tech_on: { type: 'boolean' }, news_on: { type: 'boolean' },
        tech_limit: { type: 'integer' }, news_limit: { type: 'integer' }, news_max_age_days: { type: 'integer' },
      },
      additionalProperties: false,
    },
    summarize(a) { return 'Update the upkeep schedule.'; },
    run(args) {
      const cur = upkeep.settings();
      const body = {
        upkeep_on: args.on === undefined ? (cur.on ? '1' : '0') : (bool(args.on) ? '1' : '0'),
        upkeep_tech_on: args.tech_on === undefined ? (cur.tech_on ? '1' : '0') : (bool(args.tech_on) ? '1' : '0'),
        upkeep_news_on: args.news_on === undefined ? (cur.news_on ? '1' : '0') : (bool(args.news_on) ? '1' : '0'),
        upkeep_tech_limit: args.tech_limit === undefined ? String(cur.tech_limit) : String(int(args.tech_limit, cur.tech_limit)),
        upkeep_news_limit: args.news_limit === undefined ? String(cur.news_limit) : String(int(args.news_limit, cur.news_limit)),
        upkeep_news_max_age_days: args.news_max_age_days === undefined ? String(cur.news_max_age_days) : String(int(args.news_max_age_days, cur.news_max_age_days)),
      };
      return { ok: true, ...upkeep.save(body) };
    },
  },
  {
    name: 'set_google_indexing', group: 'indexing', label: 'Google Indexing API switch', mutating: true,
    description: 'Turn the Google Indexing API pings on or off (the service-account credentials are separate).',
    parameters: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'], additionalProperties: false },
    summarize(a) { return a.on ? 'Enable Google Indexing API pings.' : 'Disable Google Indexing API pings.'; },
    run(args) {
      setSetting('google_indexing_enabled', bool(args.on) ? '1' : '0');
      return { ok: true, google_indexing_enabled: googleIndexing.isEnabled() };
    },
  },
  {
    name: 'run_google_indexing_batch', group: 'indexing', label: 'Submit URLs to Google', mutating: true, sensitive: true,
    description: 'Start a Google Indexing API submission run for up to 200 un-pinged listings (Google allows 200 per day).',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Up to 200 (default 200).' } },
      additionalProperties: false,
    },
    summarize(a) { return `Submit up to ${Math.min(200, int(a.limit, 200))} listings to the Google Indexing API.`; },
    run(args) {
      const q = googleIndexing.quota();
      if (q.remaining <= 0) return { error: `Google's 200/day quota is used — ${q.used} submitted in the last 24 hours.` };
      const r = googleIndexing.startBatch(Math.min(200, Math.max(1, int(args.limit, 200))));
      if (!r.ok) return { error: r.error };
      notify.notifyAdmin({
        kind: 'system', title: 'Google submission run started',
        body: 'Submitting un-pinged listings to the Google Indexing API (started from the AI assistant).',
        url: '/admin3119Musa/settings',
      });
      return { ok: true, queued: true, quota: q, job: r.job };
    },
  },
  {
    name: 'remove_google_credentials', group: 'indexing', label: 'Remove Google service account', mutating: true, sensitive: true,
    description: 'Delete the stored Google Indexing service-account JSON from this server. Pings stop until a new key is uploaded.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Remove the stored Google Indexing service-account key.'; },
    run() {
      const before = googleIndexing.status();
      if (!before.configured) return { error: 'No service-account key is stored on this server.' };
      googleIndexing.removeServiceAccount();
      for (const key of ['google_sa_client_email', 'google_sa_project_id', 'google_sa_uploaded_at']) setSetting(key, '');
      return { ok: true, removed: true, was: before.client_email || before.project_id };
    },
  },
  {
    name: 'ping_indexnow', group: 'indexing', label: 'Ping IndexNow', mutating: true,
    description: 'Submit paths to IndexNow right now (e.g. /listing/acme or /directory/c/technology). Absolute URLs are built from the site origin.',
    parameters: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Site paths, e.g. /listing/acme.' } },
      required: ['paths'], additionalProperties: false,
    },
    summarize(a) { return `Ping IndexNow for ${(a.paths || []).length} URL(s).`; },
    async run(args) {
      const paths = (Array.isArray(args.paths) ? args.paths : []).map((p) => String(p).trim()).filter(Boolean).slice(0, 50);
      if (!paths.length) return { error: 'Give at least one path.' };
      const r = await indexing.pingIndexNow(paths);
      if (r.skipped) return { error: 'Indexing is switched off — enable it first (set_indexing).' };
      if (!r.ok) return { error: r.error || `IndexNow answered ${r.status}.` };
      return { ok: true, submitted: paths.length, status: r.status };
    },
  },
  {
    name: 'clear_indexing_logs', group: 'indexing', label: 'Clear indexing log', mutating: true, sensitive: true,
    description: 'Delete indexing log rows — one by id, or the whole log.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' }, all: { type: 'boolean' } },
      additionalProperties: false,
    },
    summarize(a) { return a.all ? 'Clear the ENTIRE indexing log.' : `Delete indexing log row #${a.id}.`; },
    run(args) {
      if (bool(args.all)) {
        const n = indexlog.clearAll();
        return { ok: true, deleted: n, remaining: indexlog.count() };
      }
      const n = indexlog.remove(int(args.id, 0));
      if (!n) return { error: 'No log row with that id.' };
      return { ok: true, deleted: int(args.id, 0), remaining: indexlog.count() };
    },
  },

  /* ==================== Status page ==================== */
  {
    name: 'reset_status_component', group: 'ops', label: 'Reset component status', mutating: true,
    description: 'Clear a monitored component back to Operational on the public status page. Refuses while that component has an open incident.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' }, slug: { type: 'string' } },
      additionalProperties: false,
    },
    summarize(a) { return `Reset status component ${a.slug || `#${a.id}`}.`; },
    run(args) {
      const comp = args.slug ? mon.componentBySlug(String(args.slug)) : mon.componentById(int(args.id, 0));
      if (!comp) return { error: 'No component with that id or slug.' };
      const r = mon.resetComponentStatus(comp.id);
      if (!r.ok) return { error: r.error };
      return { ok: true, id: r.id, name: r.name, changed: r.changed, message: r.message };
    },
  },
  {
    name: 'run_status_check', group: 'ops', label: 'Probe components now', mutating: true,
    description: 'Run the status monitor probe against every component right now and report the results.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Probe every monitored component.'; },
    async run() {
      const results = await mon.checkAll();
      return {
        ok: true,
        overall: mon.overallStatus(),
        overall_label: mon.OVERALL_LABELS[mon.overallStatus()] || '',
        components: results.map((r) => ({
          name: (r.component && r.component.name) || '', ok: Boolean(r.ok),
          latency_ms: r.latency_ms || 0, note: r.note || '',
        })),
      };
    },
  },
  {
    name: 'delete_incident', group: 'ops', label: 'Delete incident', mutating: true, sensitive: true,
    description: 'Delete an incident and its whole timeline from the public status page.',
    parameters: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
    summarize(a) { return `Delete incident #${a.id}.`; },
    run(args) {
      const r = mon.deleteIncident(int(args.id, 0));
      if (!r.ok) return { error: r.error };
      return { ok: true, deleted: r.id, title: r.title };
    },
  },
  {
    name: 'set_weekly_status_report', group: 'ops', label: 'Weekly status report', mutating: true,
    description: 'Turn the weekly status email to subscribers on or off.',
    parameters: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'], additionalProperties: false },
    summarize(a) { return a.on ? 'Enable the weekly status report.' : 'Disable the weekly status report.'; },
    run(args) {
      setSetting('status_weekly_report', bool(args.on) ? '1' : '0');
      return { ok: true, status_weekly_report: getSetting('status_weekly_report', '0') === '1' };
    },
  },

  /* ==================== Site settings & ops ==================== */
  {
    name: 'set_site_setting', group: 'ops', label: 'Change a site setting', mutating: true,
    description: 'Change one allow-listed site setting: auto_approve, indexing_enabled, google_indexing_enabled, maintenance_on, news_review_auto, status_weekly_report, newsletter_cadence (daily|weekly|monthly), smtp_from.',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' }, value: { type: 'string' } },
      required: ['key', 'value'], additionalProperties: false,
    },
    summarize(a) { return `Set ${a.key} = ${a.value}.`; },
    run(args) {
      const key = String(args.key || '').trim();
      const spec = SITE_KEYS[key];
      if (!spec) return { error: `“${key}” is not a setting this tool can change. Allowed: ${Object.keys(SITE_KEYS).join(', ')}.` };
      const raw = String(args.value == null ? '' : args.value).trim();
      if (spec.kind === 'bool') {
        const on = bool(raw);
        setSetting(key, on ? '1' : '0');
        return { ok: true, key, value: getSetting(key, '') === '1', label: spec.label };
      }
      if (spec.kind === 'enum' && !spec.values.includes(raw)) {
        return { error: `${key} must be one of: ${spec.values.join(', ')}.` };
      }
      const v = raw.slice(0, spec.max || 200);
      if (key === 'smtp_from' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.split('<').pop().replace('>', '').trim())) {
        return { error: 'That does not look like an email address.' };
      }
      setSetting(key, v);
      return { ok: true, key, value: getSetting(key, ''), label: spec.label };
    },
  },
  {
    name: 'notify_admin_inbox', group: 'ops', label: 'Post to admin inbox', mutating: true,
    description: 'Write a notification into the admin console inbox (the bell). Useful to leave yourself a note about something the assistant changed.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' }, body: { type: 'string' },
        url: { type: 'string' }, kind: { type: 'string', description: 'system | listing | billing | security | info' },
      },
      required: ['title'], additionalProperties: false,
    },
    summarize(a) { return `Post “${String(a.title).slice(0, 60)}” to the admin inbox.`; },
    run(args) {
      const title = str(args.title, 140);
      if (!title) return { error: 'Give the notification a title.' };
      notify.notifyAdmin({
        kind: str(args.kind, 20) || 'system',
        title,
        body: str(args.body, 500),
        url: str(args.url, 200) || '/admin3119Musa',
      });
      return { ok: true, title, unread: notify.unreadAdmin() };
    },
  },
  {
    name: 'manage_notification', group: 'ops', label: 'Manage a notification', mutating: true,
    description: 'Mark read, archive (trash for a week or a month), restore from trash, or permanently delete a console notification by id.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'archive', 'restore', 'delete'] },
        id: { type: 'integer' },
        duration: { type: 'string', enum: ['week', 'month'], description: 'How long to keep an archived item.' },
      },
      required: ['action', 'id'], additionalProperties: false,
    },
    summarize(a) { return `${a.action} notification #${a.id}.`; },
    run(args) {
      const id = int(args.id, 0);
      if (!id) return { error: 'Which notification id?' };
      const action = String(args.action || '');
      if (action === 'read') {
        notify.markRead(id, { admin: true });
        return { ok: true, id, read: true };
      }
      if (action === 'archive') {
        const r = notifications.archive(id, null, args.duration || 'week');
        if (!r.ok) return { error: r.error };
        return { ok: true, id, days: r.days, expires_at: r.expiresAt };
      }
      if (action === 'restore') {
        const r = notifications.restore(id, null);
        if (!r.ok) return { error: r.error };
        return { ok: true, id, restored: true };
      }
      const r = notifications.adminDeleteAny(id);
      if (!r.ok) return { error: r.error || 'Only notifications already in trash can be deleted for good.' };
      return { ok: true, id, deleted: true };
    },
  },
  {
    name: 'export_backup', group: 'ops', label: 'Write a backup file', mutating: true,
    description: 'Build a full .firmledger backup (users, listings, configuration) and write it to the server data directory. Returns the file path and size — the file itself is downloaded from Admin → Health.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Write a full backup file to the data directory.'; },
    run() {
      try {
        const payload = backup.buildBackup();
        const dir = dataDir();
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const file = path.join(dir, `backup-${stamp}.firmledger`);
        fs.writeFileSync(file, payload, 'utf8');
        return { ok: true, path: file, bytes: Buffer.byteLength(payload), generated_at: stamp };
      } catch (e) {
        return { error: `Backup failed: ${e.message}` };
      }
    },
  },
  {
    name: 'set_admin_2fa_email', group: 'ops', label: 'Admin OTP inbox', mutating: true, sensitive: true,
    description: 'Change the email address that receives the admin sign-in one-time codes. Applies from the next sign-in.',
    parameters: {
      type: 'object',
      properties: { email: { type: 'string' } },
      required: ['email'], additionalProperties: false,
    },
    summarize(a) { return `Send admin sign-in OTPs to ${a.email}.`; },
    run(args) {
      const email = str(args.email, 120);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'That is not a valid email address.' };
      setSetting('admin_2fa_email', email);
      return { ok: true, admin_2fa_email: getSetting('admin_2fa_email', 'admin@firmledger.co.ke') };
    },
  },

  /* ==================== Email delivery ==================== */
  {
    name: 'set_mail_account', group: 'mail', label: 'SMTP provider account', mutating: true,
    description: 'Add, enable/disable or delete an SMTP failover account (Admin → Settings → Email). Providers: zoho, zoho_pro, brevo, mailtrap, smtp2go, resend, ahasend, smtpfast, forwardemail, dnsexit, custom.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'toggle', 'delete'] },
        id: { type: 'integer', description: 'Account id (toggle/delete).' },
        provider: { type: 'string' }, label: { type: 'string' }, host: { type: 'string' },
        port: { type: 'integer' }, username: { type: 'string' }, password: { type: 'string' },
        daily_limit: { type: 'integer' },
      },
      required: ['action'], additionalProperties: false,
    },
    summarize(a) { return `${a.action} SMTP account${a.id ? ` #${a.id}` : (a.provider ? ` (${a.provider})` : '')}.`; },
    run(args) {
      const action = String(args.action || '');
      if (action === 'add') {
        const r = mailer.addAccount({
          provider: str(args.provider, 30) || 'custom', label: str(args.label, 80),
          host: str(args.host, 200), port: args.port, username: str(args.username, 200),
          password: str(args.password, 500), daily_limit: int(args.daily_limit, 0),
        });
        if (!r.ok) return { error: r.error };
        return { ok: true, added: true, providers: mailer.PROVIDERS.map((p) => p.id) };
      }
      const id = int(args.id, 0);
      const row = db.prepare('SELECT id, label, host, active FROM smtp_accounts WHERE id=?').get(id);
      if (!row) return { error: 'No SMTP account with that id.' };
      if (action === 'toggle') {
        mailer.toggleAccount(id);
        const fresh = db.prepare('SELECT active FROM smtp_accounts WHERE id=?').get(id);
        return { ok: true, id, label: row.label, active: !!fresh.active };
      }
      mailer.deleteAccount(id);
      return { ok: true, deleted: id, label: row.label };
    },
  },
  {
    name: 'set_mail_from', group: 'mail', label: 'Mail From address', mutating: true,
    description: 'Set the global From address used on every outbound email.',
    parameters: { type: 'object', properties: { from: { type: 'string' } }, required: ['from'], additionalProperties: false },
    summarize(a) { return `Set the mail From address to ${a.from}.`; },
    run(args) {
      const from = str(args.from, 200);
      const bare = from.split('<').pop().replace('>', '').trim();
      if (!from || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bare)) return { error: 'Enter a valid From address, e.g. FirmLedger <no-reply@firmledger.co.ke>.' };
      mailer.saveGlobalFrom(from);
      return { ok: true, from: getSetting('smtp_from', '') };
    },
  },
  {
    name: 'send_test_mail', group: 'mail', label: 'Send test email', mutating: true,
    description: 'Send the branded configuration-check email through the live SMTP failover chain.',
    parameters: {
      type: 'object',
      properties: { to: { type: 'string', description: 'Destination address (default: the admin OTP inbox).' } },
      additionalProperties: false,
    },
    summarize(a) { return `Send a test email to ${a.to || 'the admin inbox'}.`; },
    async run(args) {
      const to = str(args.to, 190) || getSetting('admin_2fa_email', 'admin@firmledger.co.ke');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { error: 'That is not a valid email address.' };
      const r = await mailer.sendTest(to);
      if (!r.ok) return { error: r.error };
      return { ok: true, to, via: r.via };
    },
  },

  /* ==================== Protection ==================== */
  {
    name: 'delete_spam_rule', group: 'ops', label: 'Delete IP/domain rule', mutating: true,
    description: 'Remove a protection list entry by id. list=ip or domain. Read the ids with get_settings.',
    parameters: {
      type: 'object',
      properties: {
        list: { type: 'string', enum: ['ip', 'domain'] },
        id: { type: 'integer' },
      },
      required: ['list', 'id'], additionalProperties: false,
    },
    summarize(a) { return `Delete ${a.list} rule #${a.id}.`; },
    run(args) {
      const id = int(args.id, 0);
      if (args.list === 'ip') {
        const row = db.prepare('SELECT * FROM spam_ip WHERE id=?').get(id);
        if (!row) return { error: 'No IP rule with that id.' };
        spam.removeIp(id);
        return { ok: true, deleted: id, value: row.value, kind: row.kind };
      }
      const row = db.prepare('SELECT * FROM spam_domain WHERE id=?').get(id);
      if (!row) return { error: 'No domain rule with that id.' };
      spam.removeDomain(id);
      return { ok: true, deleted: id, value: row.value, kind: row.kind };
    },
  },
  {
    name: 'set_rate_limits', group: 'ops', label: 'Rate limits', mutating: true,
    description: 'Change abuse rate limits. Keys: login, register, listing, claim, newsletter, status, search, scrape, api_read_rpm, api_write_rpm. Only the keys you send change.',
    parameters: {
      type: 'object',
      properties: {
        login: { type: 'integer' }, register: { type: 'integer' }, listing: { type: 'integer' },
        claim: { type: 'integer' }, newsletter: { type: 'integer' }, status: { type: 'integer' },
        search: { type: 'integer' }, scrape: { type: 'integer' },
        api_read_rpm: { type: 'integer' }, api_write_rpm: { type: 'integer' },
      },
      additionalProperties: false,
    },
    summarize(a) { return 'Update abuse rate limits.'; },
    run(args) {
      /* `spam.limits()` speaks short names (login, scrape…) while `saveLimits`
         wants the settings keys (spam_rl_login…). Translate between them. */
      const settingFor = {};
      for (const short of Object.keys(spam.limits())) {
        settingFor[short] = Object.prototype.hasOwnProperty.call(spam.DEFAULTS, `spam_rl_${short}`)
          ? `spam_rl_${short}` : short;
      }
      const keys = Object.keys(settingFor);
      const body = {}; const changed = [];
      for (const k of keys) {
        if (args[k] === undefined || args[k] === null || args[k] === '') continue;
        const n = int(args[k], -1);
        if (n < 0 || n > 100000) return { error: `${k} must be between 0 and 100000.` };
        body[settingFor[k]] = String(n); changed.push(k);
      }
      if (!changed.length) return { error: `Nothing to change. Keys: ${keys.join(', ')}.` };
      spam.saveLimits(body);
      return { ok: true, changed, limits: spam.limits() };
    },
  },

  /* ==================== Payments & SMTP credentials ==================== */
  {
    name: 'set_smtp_settings', group: 'mail', label: 'Primary SMTP settings', mutating: true, sensitive: true,
    description: 'Set the primary SMTP connection (host, port, username, password, secure) used before any failover account. Environment SMTP_URL always wins over this.',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string' }, port: { type: 'integer' }, username: { type: 'string' },
        password: { type: 'string' }, secure: { type: 'boolean' }, from: { type: 'string' },
      },
      required: ['host'], additionalProperties: false,
    },
    summarize(a) { return `Set the primary SMTP host to ${a.host}.`; },
    run(args) {
      if (process.env.SMTP_URL || process.env.MAIL_HOST) {
        return { error: 'SMTP_URL / MAIL_HOST is set in the environment — that wins. Change it there instead.' };
      }
      const host = str(args.host, 200);
      if (!host) return { error: 'Host is required.' };
      setSetting('smtp_host', host);
      setSetting('smtp_port', String(int(args.port, 587)));
      setSetting('smtp_user', str(args.username, 200));
      if (args.password !== undefined && String(args.password).trim()) setSetting('smtp_pass', str(args.password, 500));
      setSetting('smtp_secure', bool(args.secure) ? '1' : '0');
      if (args.from !== undefined) mailer.saveGlobalFrom(str(args.from, 200));
      return { ok: true, host, port: int(args.port, 587), user: str(args.username, 200), configured: mailer.mailConfigured() };
    },
  },
  {
    name: 'set_paypal_settings', group: 'ops', label: 'PayPal credentials', mutating: true, sensitive: true,
    description: 'Set the PayPal REST app credentials and mode used for FirmLedger Pro and sponsored placements. Environment variables always win over saved values.',
    parameters: {
      type: 'object',
      properties: {
        client_id: { type: 'string' }, client_secret: { type: 'string' },
        mode: { type: 'string', enum: ['sandbox', 'live'] },
      },
      additionalProperties: false,
    },
    summarize(a) { return `Update PayPal credentials${a.mode ? ` (mode ${a.mode})` : ''}.`; },
    run(args) {
      if (process.env.PAYPAL_CLIENT_ID) {
        return { error: 'PAYPAL_CLIENT_ID is set in the environment — that wins. Change it there instead.' };
      }
      if (args.client_id !== undefined && String(args.client_id).trim()) setSetting('paypal_client_id', str(args.client_id, 200));
      if (args.client_secret !== undefined && String(args.client_secret).trim()) setSetting('paypal_client_secret', str(args.client_secret, 300));
      if (args.mode !== undefined) {
        const m = String(args.mode).toLowerCase();
        if (!['sandbox', 'live'].includes(m)) return { error: 'Mode must be sandbox or live.' };
        setSetting('paypal_mode', m);
      }
      return {
        ok: true,
        mode: getSetting('paypal_mode', 'sandbox'),
        client_id_set: Boolean(getSetting('paypal_client_id', '')),
        client_secret_set: Boolean(getSetting('paypal_client_secret', '')),
      };
    },
  },
  /* ------------------------------------------------------------------ */
  /* Assistant-native extras: moderation control, logs, protection, mail */
  /* ------------------------------------------------------------------ */
  {
    name: 'review_listing_now', group: 'listings', label: 'Rule-based review', mutating: true,
    description: 'Run the rule-based auto-moderation on one pending listing right now (approve / hold / reject by score), or just score it without acting when dry_run=true.',
    parameters: {
      type: 'object',
      properties: { id_or_slug: { type: 'string' }, dry_run: { type: 'boolean', description: 'Score only, change nothing.' } },
      required: ['id_or_slug'], additionalProperties: false,
    },
    summarize(a) { return a.dry_run ? `Score listing ${a.id_or_slug} (no changes).` : `Review listing ${a.id_or_slug} with the moderation rules.`; },
    async run(args) {
      const l = findListing(args.id_or_slug);
      if (!l) return { error: 'No such listing.' };
      const ai = require('./ai');
      if (args.dry_run) return { listing: { id: l.id, name: l.name, status: l.status }, ...ai.scoreListing(l), dry_run: true };
      if (l.status !== 'pending') return { error: `Listing #${l.id} is ${l.status}, only pending listings are reviewed.` };
      const r = await ai.moderateListing(l.id);
      const fresh = findListing(String(l.id));
      return { listing: { id: l.id, name: l.name, status: fresh ? fresh.status : l.status }, ...r };
    },
  },
  {
    name: 'set_moderation_thresholds', group: 'ops', label: 'Moderation thresholds', mutating: true,
    description: 'Set the auto-moderation score thresholds: approve_at (50–100) and/or reject_at (0–49).',
    parameters: {
      type: 'object',
      properties: { approve_at: { type: 'integer' }, reject_at: { type: 'integer' } },
      additionalProperties: false,
    },
    summarize(a) { return `Set moderation thresholds${a.approve_at !== undefined ? ` approve ≥ ${a.approve_at}` : ''}${a.reject_at !== undefined ? ` reject ≤ ${a.reject_at}` : ''}.`; },
    run(args) {
      if (args.approve_at === undefined && args.reject_at === undefined) return { error: 'Give approve_at and/or reject_at.' };
      if (args.approve_at !== undefined) { const n = int(args.approve_at, 75); if (n < 50 || n > 100) return { error: 'approve_at must be 50–100.' }; setSetting('ai_moderation_approve_at', String(n)); }
      if (args.reject_at !== undefined) { const n = int(args.reject_at, 25); if (n < 0 || n > 49) return { error: 'reject_at must be 0–49.' }; setSetting('ai_moderation_reject_at', String(n)); }
      return { approve_at: Number(getSetting('ai_moderation_approve_at', '75')), reject_at: Number(getSetting('ai_moderation_reject_at', '25')) };
    },
  },
  {
    name: 'edit_moderation_rules', group: 'ops', label: 'Moderation rules', mutating: true,
    description: 'Add or remove a rule line for auto-moderation: block: <term> (auto-reject), flag: <term> (hold for a human) or allow-domain: <host> (trust boost).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove'] },
        kind: { type: 'string', enum: ['block', 'flag', 'allow-domain'] },
        term: { type: 'string' },
      },
      required: ['action', 'kind', 'term'], additionalProperties: false,
    },
    summarize(a) { return `${a.action === 'remove' ? 'Remove' : 'Add'} moderation rule “${a.kind}: ${a.term}”.`; },
    run(args) {
      const term = str(args.term, 120).toLowerCase().trim();
      if (!term) return { error: 'Term is empty.' };
      const line = `${args.kind}: ${term}`;
      const lines = getSetting('ai_moderation_rules', '').split('\n').map((x) => x.trim()).filter(Boolean);
      const idx = lines.findIndex((x) => x.toLowerCase() === line);
      if (args.action === 'remove') { if (idx === -1) return { error: `There is no rule “${line}”.` }; lines.splice(idx, 1); }
      else if (idx === -1) lines.push(line);
      setSetting('ai_moderation_rules', lines.join('\n'));
      return { rules: lines, count: lines.length };
    },
  },
  {
    name: 'get_moderation_rules', group: 'read', label: 'Moderation rules', mutating: false,
    description: 'Show the auto-moderation rule lines and thresholds.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Read the moderation rules.'; },
    run() {
      const lines = getSetting('ai_moderation_rules', '').split('\n').map((x) => x.trim()).filter(Boolean);
      return { on: getSetting('ai_moderation_on', '0') === '1', approve_at: Number(getSetting('ai_moderation_approve_at', '75')), reject_at: Number(getSetting('ai_moderation_reject_at', '25')), rules: lines };
    },
  },
  {
    name: 'get_audit_log', group: 'read', label: 'Assistant audit log', mutating: false,
    description: 'Recent assistant audit entries (chat turns, tool runs, moderation decisions). Filter by kind (tool|chat|moderation) or a search term.',
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string' }, q: { type: 'string' }, limit: { type: 'integer' } },
      additionalProperties: false,
    },
    summarize() { return 'Read the audit log.'; },
    run(args) {
      const where = []; const p = [];
      if (args.kind) { where.push('kind=?'); p.push(String(args.kind)); }
      if (args.q) { where.push('(action LIKE ? OR payload LIKE ? OR result LIKE ?)'); const like = `%${String(args.q)}%`; p.push(like, like, like); }
      const limit = Math.max(1, Math.min(100, int(args.limit, 20)));
      const entries = rows(`SELECT id, kind, action, listing_id, ok, created_at, substr(payload,1,160) AS payload, substr(result,1,160) AS result FROM ai_audit_log${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`, ...p);
      return { count: entries.length, total: countOf(`SELECT COUNT(*) c FROM ai_audit_log${where.length ? ' WHERE ' + where.join(' AND ') : ''}`, ...p), entries };
    },
  },
  {
    name: 'get_moderation_log', group: 'read', label: 'Moderation log', mutating: false,
    description: 'Recent auto-moderation decisions (approve / reject / pending) with scores and reasons.',
    parameters: { type: 'object', properties: { decision: { type: 'string' }, limit: { type: 'integer' } }, additionalProperties: false },
    summarize() { return 'Read the moderation log.'; },
    run(args) {
      const limit = Math.max(1, Math.min(100, int(args.limit, 20)));
      const where = args.decision ? ' WHERE m.decision=?' : '';
      const entries = rows(`SELECT m.*, l.name AS listing_name FROM ai_moderation_log m LEFT JOIN listings l ON l.id=m.listing_id${where} ORDER BY m.id DESC LIMIT ${limit}`, ...(args.decision ? [String(args.decision)] : []));
      return { count: entries.length, entries };
    },
  },
  {
    name: 'list_protection_rules', group: 'read', label: 'Blocked IPs & domains', mutating: false,
    description: 'List the IP and domain block/allow rules and the rate limits (Admin → Protection).',
    parameters: { type: 'object', properties: { list: { type: 'string', enum: ['ip', 'domain', 'all'] } }, additionalProperties: false },
    summarize() { return 'Read the protection rules.'; },
    run(args) {
      const which = args.list || 'all';
      const out = {};
      if (which !== 'domain') out.ips = rows('SELECT id, value, kind, note, created_at FROM spam_ip ORDER BY id DESC LIMIT 100');
      if (which !== 'ip') out.domains = rows('SELECT id, value, kind, note, created_at FROM spam_domain ORDER BY id DESC LIMIT 100');
      out.limits = spam.limits ? spam.limits() : undefined;
      return out;
    },
  },
  {
    name: 'list_mail_accounts', group: 'read', label: 'Mail accounts', mutating: false,
    description: 'List configured SMTP/mail accounts (no passwords), the global From address and today\'s send counts.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    summarize() { return 'Read the mail accounts.'; },
    run() {
      return {
        from: getSetting('smtp_from', ''),
        env_smtp: Boolean(process.env.SMTP_URL),
        accounts: rows('SELECT id, provider, label, host, port, secure, username, daily_limit, sent_today, active FROM smtp_accounts ORDER BY id'),
      };
    },
  },
  {
    name: 'list_api_keys', group: 'read', label: 'Developer API keys', mutating: false,
    description: 'List developer API keys (prefix only, never the secret) with owner, usage and revocation state. Optionally filter by member.',
    parameters: { type: 'object', properties: { user: { type: 'string' }, include_revoked: { type: 'boolean' } }, additionalProperties: false },
    summarize() { return 'Read the API keys.'; },
    run(args) {
      const where = []; const p = [];
      if (args.user) { const u = findUser(String(args.user)); if (!u) return { error: 'No such member.' }; where.push('k.user_id=?'); p.push(u.id); }
      if (!args.include_revoked) where.push('k.revoked_at IS NULL');
      const keys = rows(`SELECT k.id, k.label, k.prefix, k.created_at, k.last_used_at, k.revoked_at, k.total_requests, k.write_requests, u.email AS owner FROM api_keys k JOIN users u ON u.id=k.user_id${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY k.id DESC LIMIT 100`, ...p);
      return { count: keys.length, keys };
    },
  },
  {
    name: 'revoke_api_key', group: 'users', label: 'Revoke API key', mutating: true, sensitive: true,
    description: 'Revoke one developer API key by id or prefix. Cannot be undone; the member must create a new key.',
    parameters: { type: 'object', properties: { id_or_prefix: { type: 'string' } }, required: ['id_or_prefix'], additionalProperties: false },
    summarize(a) { return `Revoke API key ${a.id_or_prefix}.`; },
    run(args) {
      const v = String(args.id_or_prefix);
      const k = /^\d+$/.test(v) ? db.prepare('SELECT * FROM api_keys WHERE id=?').get(Number(v)) : db.prepare('SELECT * FROM api_keys WHERE prefix=?').get(v);
      if (!k) return { error: 'No such API key.' };
      if (k.revoked_at) return { error: 'That key is already revoked.' };
      db.prepare("UPDATE api_keys SET revoked_at=datetime('now') WHERE id=?").run(k.id);
      return { ok: true, id: k.id, prefix: k.prefix };
    },
  },
];

module.exports = TOOLS;
