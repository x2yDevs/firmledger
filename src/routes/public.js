const express = require('express');
const { db } = require('../db');
const { TYPES, COUNTRIES, typeLabel } = require('../lib/taxonomy');
const catLib = require('../lib/categories');
const graphLib = require('../lib/graph');
const { ICONS } = require('../lib/socialicons');
const {
  truncate, escXml, siteUrl, isEmail, slugify, fmtDate, isPublicBaseUrl,
} = require('../lib/util');
const { getIndexNowKey } = require('../lib/indexing');
const nl = require('../lib/newsletter');
const { allPlans, perksActive, canViewFull, PRO_USER_SQL, PRO_LISTING_SQL } = require('../lib/plans');
const paypal = require('../lib/paypal');
const compare = require('../lib/compare');
const ad = require('../lib/advertising');
const careers = require('../lib/careers');

const spam = require('../lib/spam');
const newsLib = require('../lib/news');
const leadsLib = require('../lib/leads');
const { requireUser } = require('../lib/session');

const router = express.Router();
const PER_PAGE = 12;

/* A listing earns Pro perks either through its own admin boost or its owner's
   active Pro subscription. */

function parseJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function listingLocation(l) {
  return [l.city, l.region, l.country].filter(Boolean).join(', ');
}

/* Featured records — eligibility, not entitlement. Pro listings are ELIGIBLE
   for Featured placement; the system rotates a fair subset onto the page on
   every visit. Admin-pinned records (l.featured=1) always lead; the remaining
   slots are drawn at random from the other eligible Pro listings, so every
   eligible listing has the same probability of appearing. The count shown to
   visitors is the eligible pool, not the cards on screen. */
function featuredEligibleWhere() {
  return `FROM listings l
     LEFT JOIN users u ON u.id = l.owner_user_id
     WHERE l.status='approved'
       AND (l.featured=1 OR ${PRO_LISTING_SQL} OR ${PRO_USER_SQL})`;
}
function featuredRotation(limit = 8) {
  const eligibleWhere = featuredEligibleWhere();
  const pinned = db.prepare(
    `SELECT l.*, u.plan AS owner_plan, u.plan_expires_at AS owner_plan_expires ${eligibleWhere}
       AND l.featured=1 ORDER BY l.updated_at DESC LIMIT ?`
  ).all(limit);
  let featured = pinned;
  if (pinned.length < limit) {
    const pinnedIds = pinned.map((l) => l.id);
    const notPinned = pinnedIds.length ? `AND l.id NOT IN (${pinnedIds.map(() => '?').join(',')})` : '';
    const rotation = db.prepare(
      `SELECT l.*, u.plan AS owner_plan, u.plan_expires_at AS owner_plan_expires ${eligibleWhere}
         ${notPinned} ORDER BY RANDOM() LIMIT ?`
    ).all(...pinnedIds, limit - pinned.length);
    featured = pinned.concat(rotation);
  }
  return featured;
}

/* ---------------- Home ---------------- */
router.get('/', (req, res) => {
  const stats = {
    listings: db.prepare("SELECT COUNT(*) c FROM listings WHERE status='approved'").get().c,
    verified: db.prepare("SELECT COUNT(*) c FROM listings WHERE status='approved' AND claimed=1").get().c,
    countries: db.prepare("SELECT COUNT(DISTINCT country) c FROM listings WHERE status='approved' AND country<>''").get().c,
  };
  const FEATURED_SHOW = 8;
  const featuredCount = db.prepare(`SELECT COUNT(*) c ${featuredEligibleWhere()}`).get().c;
  const featured = featuredRotation(FEATURED_SHOW);
  const featuredOverflow = featuredCount > featured.length;
  /* Longer strip ⇒ longer loop, so the scroll speed stays constant. */
  const featuredDur = Math.min(300, Math.max(28, Math.round(featured.length * 5.5)));
  const latest = db.prepare(
    "SELECT * FROM listings WHERE status='approved' ORDER BY created_at DESC LIMIT 8"
  ).all();
  const byType = TYPES.map((t) => ({
    ...t,
    count: db.prepare("SELECT COUNT(*) c FROM listings WHERE status='approved' AND type=?").get(t.value).c,
  }));
  const rows = db.prepare("SELECT confidence FROM listings WHERE status='approved' ORDER BY confidence").all();
  const medianConf = rows.length
    ? (rows.length % 2 ? rows[(rows.length - 1) / 2].confidence
      : Math.round((rows[rows.length / 2 - 1].confidence + rows[rows.length / 2].confidence) / 2))
    : null;
  const recentVerifications = db.prepare(
    "SELECT * FROM listings WHERE status='approved' AND last_verified_at IS NOT NULL ORDER BY last_verified_at DESC LIMIT 5"
  ).all();
  const tickerItems = db.prepare(
    "SELECT name, slug, confidence FROM listings WHERE status='approved' ORDER BY updated_at DESC LIMIT 12"
  ).all();
  /* Sponsored strip — a fair random draw, re-drawn every visit. With thousands of
     active sponsors the homepage can only show a few cards, so each visit shows
     a random subset and every sponsor has the same probability of appearing. */
  const SPONSORED_SHOW = 12;
  const sponsored = ad.sponsoredStrip(SPONSORED_SHOW);
  const sponsoredCount = ad.countActive();
  const hasActiveSponsors = sponsored.length > 0;
  /* Conversion funnel: record what this human was actually shown. Batched,
     one INSERT per strip; bots, admins and owners are skipped inside. */
  try {
    const ana = require('../lib/analytics');
    ana.recordImpressions(sponsored, 'sponsored_impression', req);
    ana.recordImpressions(featured, 'featured_impression', req);
  } catch { /* never break the page */ }

  res.render('home', {
    meta: {
      title: 'FirmLedger — Verified Company Intelligence & Business Directory',
      description: 'FirmLedger is the business record layer for modern discovery: verified listings for companies, startups, agencies, organizations, products, services and publishers — with source transparency, confidence scoring and a unified intelligence API.',
      canonical: siteUrl('/'),
      jsonld: {
        '@context': 'https://schema.org',
        '@graph': [{
          '@type': 'Organization',
          '@id': siteUrl('/#org'),
          name: 'FirmLedger',
          url: siteUrl('/'),
          logo: { '@type': 'ImageObject', url: siteUrl('/assets/logo-mark.png') },
          sameAs: [
            'https://x.com/firmledger',
            'https://linkedin.com/company/firmledger',
            'https://facebook.com/firmledger',
            'https://instagram.com/firmledger',
            'https://youtube.com/@firmledger',
          ],
          email: 'hello@firmledger.co.ke',
          address: { '@type': 'PostalAddress', addressLocality: 'Nairobi', addressCountry: 'KE' },
        }, {
          '@type': 'WebSite',
          name: 'FirmLedger',
          url: siteUrl('/'),
          publisher: { '@id': siteUrl('/#org') },
          potentialAction: {
            '@type': 'SearchAction',
            target: { '@type': 'EntryPoint', urlTemplate: siteUrl('/directory?q={search_term_string}') },
            'query-input': 'required name=search_term_string',
          },
        }],
      },
    },
    stats, featured, latest, byType, medianConf, recentVerifications, tickerItems,
    sponsored, hasActiveSponsors, sponsoredCount,
    featuredCount, featuredOverflow, featuredDur,
  });
});

/* ---------------- Directory / search ---------------- */
router.get('/directory', (req, res) => {
  const { q = '', type = '', category = '', country = '', verified = '', sort = 'relevance' } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const allCats = catLib.all();

  const where = ["l.status = 'approved'"];
  const params = [];
  if (q.trim()) {
    where.push('(l.name LIKE ? OR l.tagline LIKE ? OR l.description LIKE ? OR l.tags LIKE ? OR l.city LIKE ?)');
    const like = `%${q.trim()}%`;
    params.push(like, like, like, like, like);
  }
  if (type && TYPES.some((t) => t.value === type)) { where.push('l.type = ?'); params.push(type); }
  if (category && allCats.some((c) => c.name === category)) { where.push('l.category = ?'); params.push(category); }
  if (country && COUNTRIES.includes(country)) { where.push('l.country = ?'); params.push(country); }
  if (verified === '1') where.push('l.claimed = 1');

  let order = 'l.featured DESC, l.confidence DESC, l.name ASC';
  if (sort === 'newest') order = 'l.created_at DESC';
  if (sort === 'name') order = 'l.name ASC';

  const total = db.prepare(`SELECT COUNT(*) c FROM listings l WHERE ${where.join(' AND ')}`).get(...params).c;
  /* Sponsored matches lead the results — but never all of them. Up to three
     ACTIVE sponsors matching the same filters are drawn at random (equal
     probability for every matching sponsor) and shown first with a clear
     “Sponsored” label, on page 1 only. The organic results below exclude the
     drawn cards so nothing appears twice. */
  const SPONSORED_INLINE = 3;
  const sponsoredInline = page === 1
    ? ad.sponsoredSample({ q, type, category, country }, SPONSORED_INLINE)
    : [];
  try { require('../lib/analytics').recordImpressions(sponsoredInline, 'sponsored_impression', req); } catch { /* ignore */ }
  const inlineIds = sponsoredInline.map((l) => l.id);
  const organicWhere = inlineIds.length
    ? `${where.join(' AND ')} AND l.id NOT IN (${inlineIds.map(() => '?').join(',')})`
    : where.join(' AND ');
  const organicParams = inlineIds.length ? [...params, ...inlineIds] : params;
  const listings = db.prepare(
    `SELECT l.*, u.plan AS owner_plan, u.plan_expires_at AS owner_plan_expires
     FROM listings l LEFT JOIN users u ON u.id = l.owner_user_id
     WHERE ${organicWhere}
     ORDER BY ${order} LIMIT ? OFFSET ?`
  ).all(...organicParams, PER_PAGE, (page - 1) * PER_PAGE);

  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const bits = [q && `“${q}”`, type && typeLabel(type), category, country].filter(Boolean);
  const title = bits.length ? `${bits.join(' · ')} — Directory | FirmLedger` : 'Business Directory | FirmLedger';

  /* Featured records — the same fair rotation as the homepage, re-drawn every
     visit. When there are many eligible records the strip marquees exactly like
     the sponsored placements. Page 1 only, so pagination never re-draws it. */
  const featured = page === 1 ? featuredRotation(8) : [];
  const featuredCount = page === 1 ? db.prepare(`SELECT COUNT(*) c ${featuredEligibleWhere()}`).get().c : 0;
  const featuredOverflow = featuredCount > featured.length;
  const featuredDur = Math.min(300, Math.max(28, Math.round(featured.length * 5.5)));
  if (featured.length) {
    try { require('../lib/analytics').recordImpressions(featured, 'featured_impression', req); } catch { /* ignore */ }
  }

  res.render('directory', {
    meta: {
      title,
      description: truncate(
        `Browse ${total} verified business listings${category ? ` in ${category}` : ''}${country ? ` based in ${country}` : ''} on FirmLedger — structured, source-backed company records.`, 158),
      canonical: siteUrl('/directory' + (q ? `?q=${encodeURIComponent(q)}` : '')),
    },
    listings, total, page, pages,
    sponsoredInline,
    featured, featuredCount, featuredOverflow, featuredDur,
    filters: { q, type, category, country, verified, sort },
    view: req.query.view === 'list' ? 'list' : 'grid',
    TYPES, COUNTRIES, allCats,
    topCategories: catLib.withCounts().filter((c) => c.cnt > 0).slice(0, 8),
  });
});

/* ---------------- SEO category + location landing pages ---------------- */
function categoryPage(req, res, next, catSlug, locSlug) {
  const cat = catLib.bySlug(catSlug);
  if (!cat) return next();

  const all = db.prepare(
    `SELECT l.*, u.plan AS owner_plan, u.plan_expires_at AS owner_plan_expires
     FROM listings l LEFT JOIN users u ON u.id = l.owner_user_id
     WHERE l.status='approved' AND l.category = ?
     ORDER BY l.featured DESC, l.confidence DESC, l.name ASC`
  ).all(cat.name);
  let listings = all;
  let placeName = '';
  if (locSlug) {
    listings = all.filter((l) =>
      (l.country && slugify(l.country) === locSlug) ||
      (l.city && slugify(l.city) === locSlug) ||
      (l.region && slugify(l.region) === locSlug));
    const sample = listings[0];
    if (sample) {
      placeName = [sample.region, sample.city, sample.country].find((v) => v && slugify(v) === locSlug)
        || [sample.city, sample.country].filter(Boolean).join(', ');
    } else {
      placeName = locSlug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    }
  }

  /* Sponsored leads, fairly: up to three ACTIVE sponsors from this slice, drawn
     at random (equal probability), shown first with a “Sponsored” label on
     page 1 only. The organic grid below excludes the drawn cards. */
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const today = new Date().toISOString().slice(0, 10);
  const sponsoredPool = listings.filter((l) =>
    l.sponsored && (l.sponsored_expires_at === '' || (l.sponsored_expires_at || '') >= today));
  let sponsoredInline = [];
  if (page === 1 && sponsoredPool.length) {
    const shuffled = [...sponsoredPool];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    sponsoredInline = shuffled.slice(0, 3);
  }
  try { require('../lib/analytics').recordImpressions(sponsoredInline, 'sponsored_impression', req); } catch { /* ignore */ }
  const inlineIds = new Set(sponsoredInline.map((l) => l.id));
  const organic = listings.filter((l) => !inlineIds.has(l.id));
  const count = listings.length;
  const pages = Math.max(1, Math.ceil(organic.length / 24));
  const visible = organic.slice((page - 1) * 24, page * 24);

  const whereStr = placeName ? ` in ${placeName}` : '';
  const path = `/directory/c/${catSlug}${locSlug ? `-in-${locSlug}` : ''}`;
  const title = `${cat.name}${placeName ? ` in ${placeName}` : ''} — Directory | FirmLedger`;
  const description = `Explore ${count} verified ${cat.name.toLowerCase()} record${count === 1 ? '' : 's'}${whereStr} on FirmLedger — source-backed profiles with confidence scores, timelines and ownership verification.`;

  res.render('category', {
    meta: {
      title,
      description: truncate(description, 158),
      canonical: siteUrl(path),
      robots: count ? 'index,follow,max-image-preview:large' : 'noindex,follow',
      jsonld: {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: title,
        description,
        url: siteUrl(path),
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: count,
          itemListElement: visible.slice(0, 20).map((l, i) => ({
            '@type': 'ListItem', position: i + 1 + (page - 1) * 24,
            name: l.name, url: siteUrl(`/listing/${l.slug}`),
          })),
        },
      },
      breadcrumbs: [
        { name: 'Home', url: siteUrl('/') },
        { name: 'Directory', url: siteUrl('/directory') },
        { name: cat.name, url: siteUrl(`/directory/c/${cat.slug}`) },
        ...(placeName ? [{ name: placeName, url: siteUrl(path) }] : []),
      ],
    },
    cat, placeName, listings: visible, total: count, page, pages, path,
    sponsoredInline,
    siblings: (() => {
      const places = new Map();
      for (const l of all) {
        for (const v of [l.city, l.country]) {
          if (v) places.set(slugify(v), v);
        }
      }
      return [...places.entries()].slice(0, 10).map(([slug, name]) => ({ slug, name }));
    })(),
  });
}

router.get('/directory/c/:rest([a-z0-9-]+)', (req, res, next) => {
  const rest = req.params.rest;
  const idx = rest.lastIndexOf('-in-');
  if (idx > 0) {
    return categoryPage(req, res, next, rest.slice(0, idx), rest.slice(idx + 4));
  }
  return categoryPage(req, res, next, rest, null);
});

/* ---------------- Search suggest (names API) ---------------- */
router.get('/suggest.json', spam.gate('search'), (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ suggestions: [] });
  const rows = db.prepare(
    "SELECT name, slug, category FROM listings WHERE status='approved' AND name LIKE ? ORDER BY featured DESC LIMIT 8"
  ).all(`%${q}%`);
  res.json({ suggestions: rows });
});

/* ---------------- Listing profile ---------------- */
router.get('/listing/:slug', (req, res, next) => {
  const l = db.prepare('SELECT * FROM listings WHERE slug = ?').get(req.params.slug);
  if (!l) return next();
  const isOwner = req.user && l.owner_user_id === req.user.id;
  if (l.status !== 'approved' && !isOwner && !req.admin) return next();

  const events = db.prepare('SELECT * FROM listing_events WHERE listing_id = ? ORDER BY event_date ASC').all(l.id);
  const related = db.prepare(
    "SELECT * FROM listings WHERE status='approved' AND category = ? AND id <> ? ORDER BY featured DESC, confidence DESC LIMIT 10"
  ).all(l.category, l.id);
  const competitors = db.prepare(
    "SELECT slug, name, tagline, logo_url, confidence, claimed, city, country, type FROM listings WHERE status='approved' AND category = ? AND type = ? AND id <> ? ORDER BY confidence DESC LIMIT 6"
  ).all(l.category, l.type, l.id);
  const ownerName = l.owner_user_id
    ? (db.prepare('SELECT name, email FROM users WHERE id = ?').get(l.owner_user_id) || {}).name
    : null;

  const socials = parseJson(l.socials, {});
  const sources = parseJson(l.sources, []);
  const sameAs = Object.values(socials).filter(Boolean);
  const place = listingLocation(l);
  const graph = graphLib.buildGraph(l);
  const catRow = catLib.all().find((c) => c.name === l.category);
  const catSlug = catRow ? catRow.slug : slugify(l.category);
  const daysOld = Math.max(0, Math.floor((Date.now() - new Date(l.updated_at).getTime()) / 864e5));
  const freshness = daysOld <= 30 ? 'Fresh · <30d' : daysOld <= 90 ? 'Reviewed · <90d' : 'Review due';
  const freshnessCls = daysOld <= 30 ? 'live' : 'pending';

  /* ---- FirmLedger score (real, computed) ---- */
  const tech = parseJson(l.tech, []);
  const score = require('../lib/score').firmledgerScore(l, {
    sources, events, relations: graph.items, tech, socials,
  });

  /* ---- Key people: founder-type relations, enriched with real profile data when linked ---- */
  const people = graph.items
    .filter((it) => it.rel === 'founder')
    .slice(0, 8)
    .map((it) => {
      const row = it.slug
        ? db.prepare("SELECT socials, claimed, type FROM listings WHERE slug = ? AND status='approved'").get(it.slug)
        : null;
      return {
        name: it.name, slug: it.slug || '', note: it.note || it.relLabel,
        socials: row ? parseJson(row.socials, {}) : {},
        inbound: it.direction === 'in',
      };
    });

  /* ---- Ecosystem groups ---- */
  const eco = {
    capital: graph.items.filter((it) => ['investor', 'parent_company', 'subsidiary'].includes(it.rel)).slice(0, 8),
    offer: graph.items.filter((it) => ['product', 'service', 'partner'].includes(it.rel)).slice(0, 10),
  };

  /* ---- FAQs built from the record's real fields ---- */
  const faqs = [];
  const whatLine = l.tagline || (l.description ? l.description.split('. ')[0] : '');
  if (whatLine) faqs.push({
    q: `What does ${l.name} do?`,
    a: `${l.name} is ${/[aeiou]/i.test(typeLabel(l.type)[0]) ? 'an' : 'a'} ${typeLabel(l.type).toLowerCase()} in the ${l.category} space${place ? `, based in ${place}` : ''}. ${whatLine}${/[.!?]$/.test(whatLine.trim()) ? '' : '.'}`,
  });
  if (place) faqs.push({ q: `Where is ${l.name} located?`, a: `${l.name} is located in ${place}${l.address ? `, at ${l.address}` : ''}.` });
  if (l.founded) faqs.push({ q: `When was ${l.name} founded?`, a: `${l.name} was founded in ${l.founded}${l.size ? ` and today has a team of around ${l.size} people` : ''}.` });
  faqs.push({
    q: `Is ${l.name} verified on FirmLedger?`,
    a: l.claimed
      ? `Yes. The ownership of this record is cryptographically verified — ${l.name} proved control of its official domain and the profile is managed by the verified owner${l.last_verified_at ? ` since ${fmtDate(l.last_verified_at)}` : ''}.`
      : `Not yet. This record contains only public, source-cited data. If you represent ${l.name}, you can claim the profile through domain verification (DNS record, meta tag, or site badge) to take control of it.`,
  });
  const srcLine = sources.length
    ? `This profile is backed by ${sources.length + (l.website ? 1 : 0)} cited source${sources.length || l.website ? 's' : ''}, including ${l.website ? 'the official website' : sources[0].replace(/^https?:\/\//, '')}${sources.length ? ` and ${sources.length} additional reference${sources.length > 1 ? 's' : ''}` : ''}.`
    : `This profile cites ${l.name}'s official website as its primary source.`;
  faqs.push({ q: `Where does FirmLedger's data on ${l.name} come from?`, a: `${srcLine} Every field carries field-level provenance inside the ledger, and the public trail is shown on this page under “Sources & provenance”.` });
  faqs.push({
    q: `How do I update or remove ${l.name}'s listing?`,
    a: `If you represent ${l.name}, claim the profile to edit it directly — verification takes minutes using DNS, a meta tag, or the FirmLedger badge. Anyone can also request a review or removal using the “Request removal” link on this page, and our moderation team will act on it.`,
  });

  /* Audience analytics (Pro): count this human view. Bots, the owner and
     admins are skipped inside recordView — the numbers describe the audience. */
  try { require('../lib/analytics').recordView(l, req); } catch { /* never break the page */ }

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: l.name,
    url: l.website || undefined,
    logo: l.logo_url ? (l.logo_url.startsWith('http') ? l.logo_url : siteUrl(l.logo_url)) : undefined,
    description: truncate(l.description || l.tagline, 300),
    foundingDate: l.founded || undefined,
    email: l.email || undefined,
    telephone: l.phone || undefined,
    sameAs: sameAs.length ? sameAs : undefined,
    address: (l.city || l.country || l.region)
      ? {
        '@type': 'PostalAddress',
        addressLocality: l.city || undefined,
        addressRegion: l.region || undefined,
        addressCountry: l.country || undefined,
      }
      : undefined,
  };

  res.render('listing', {
    meta: {
      title: `${l.name}${place ? ` — ${place}` : ''} | FirmLedger`,
      description: truncate(l.tagline || l.description || `${l.name} — ${typeLabel(l.type)} listing on FirmLedger.`, 158),
      canonical: siteUrl(`/listing/${l.slug}`),
      ogType: 'profile',
      image: l.logo_url ? (l.logo_url.startsWith('http') ? l.logo_url : siteUrl(l.logo_url)) : null,
      jsonld: [jsonld, {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: faqs.slice(0, 6).map((f) => ({
          '@type': 'Question', name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      }],
      breadcrumbs: [
        { name: 'Home', url: siteUrl('/') },
        { name: l.category, url: siteUrl(`/directory/c/${catSlug}`) },
        { name: l.name, url: siteUrl(`/listing/${l.slug}`) },
      ],
    },
    l, events, related, socials, sources, isOwner, ownerName, graph, catSlug, ICONS,
    watching: req.user ? nl.isWatched(req.user.id, l.id) : false,
    comparing: compare.includes(req, l.id),
    watchJobs: nl.jobsForListing(l.id),
    canJobPost: isOwner && perksActive(l),
    perksPro: perksActive(l),
    viewFull: canViewFull({ user: req.user, admin: req.admin, listing: l }),
    place, typeLabel: typeLabel(l.type), freshness, freshnessCls,
    sourceDate: l.updated_at,
    tags: l.tags ? l.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    score, people, eco, faqs, competitors, tech,
    hiringUrl: l.hiring_url || '',
    techCheckedAt: l.tech_checked_at || '',
    news: newsLib.approvedFor(l.id, 6),
    /* Leads: “Contact this business” lives on claimed profiles only, and only
       while a live owner account can actually read what is sent (leadsLib
       .canReceive) — a button that posts into a void is worse than no button.
       The form posts to /listing/:slug/leads; flash state rides the query
       string, and whatever the member typed is handed back on `leadOld` so a
       validation error never costs them their message. */
    leadCanReceive: leadsLib.canReceive(l).ok,
    leadLimits: {
      name: leadsLib.NAME_MAX,
      phone: leadsLib.PHONE_MAX,
      subject: leadsLib.SUBJECT_MAX,
      message: leadsLib.MESSAGE_MAX,
    },
    leadOld: {
      name: String(req.query.lead_name || '').slice(0, leadsLib.NAME_MAX),
      phone: String(req.query.lead_phone || '').slice(0, leadsLib.PHONE_MAX),
      subject: String(req.query.lead_subject || '').slice(0, leadsLib.SUBJECT_MAX),
      message: String(req.query.lead_message || '').slice(0, leadsLib.MESSAGE_MAX),
    },
    leadOk: req.query.lead_ok || '',
    leadErr: req.query.lead_err || '',
    leadSent: req.query.lead_sent === '1',
  });
});

/* ---------------- Leads — “Contact this business” (claimed listings) --------
 * Only signed-in FirmLedger members can contact a claimed business. The lead
 * uses the member's FirmLedger account email automatically and lands in the
 * VERIFIED OWNER's inbox (Dashboard → Leads) + email. Both sides can keep
 * talking in the Leads thread. The owner's email is never exposed.
 * Rate-limited, honeypot-guarded and domain-checked like every other form.
 *
 * The spam gate checks the SIGNED-IN ACCOUNT's email, not req.body.email: the
 * body address is cosmetic (the form renders it read-only and this handler
 * ignores it), so domain-blocking it would have blocked nothing while letting
 * a blocked account through by simply typing a different address.
 */
const leadEmailGate = (req, res, next) => {
  if (req.user && req.user.email) req.spamEmail = req.user.email;
  return spam.gate('lead', { checkEmail: true })(req, res, next);
};
router.post('/listing/:slug/leads', leadEmailGate, (req, res, next) => {
  const l = db.prepare('SELECT * FROM listings WHERE slug = ?').get(req.params.slug);
  if (!l) return next();
  /* Hand the member's own words back on any bounce so a validation error never
     costs them a long, carefully written brief. */
  const typed = {
    lead_name: String(req.body.name || '').slice(0, leadsLib.NAME_MAX),
    lead_phone: String(req.body.phone || '').slice(0, leadsLib.PHONE_MAX),
    lead_subject: String(req.body.subject || req.body.looking_for || '').slice(0, leadsLib.SUBJECT_MAX),
    lead_message: String(req.body.message || '').slice(0, leadsLib.MESSAGE_MAX),
  };
  /* Percent-encoding (not URLSearchParams, which writes "+" for spaces) so the
     redirect matches every other flash URL on the site and decodes cleanly. */
  const back = (params) => {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    return res.redirect(`/listing/${l.slug}${qs ? `?${qs}` : ''}#contact-business`);
  };
  const bounce = (message) => back({ lead_err: message, ...typed });
  if (String(req.body.company_site || '').trim()) return back({}); // honeypot
  if (!req.user) {
    return res.redirect('/login?next=' + encodeURIComponent(`/listing/${l.slug}#contact-business`));
  }
  if (l.owner_user_id === req.user.id) {
    return bounce('This is your own listing — inquiries from visitors land in your Leads inbox.');
  }
  /* One question, asked the same way here and on the page that drew the form:
     can a live owner account actually read this? */
  const gate = leadsLib.canReceive(l);
  if (!gate.ok) return bounce(gate.error);

  const leads = leadsLib;
  const analytics = require('../lib/analytics');
  const loc = analytics.locate(req);
  /* Email always comes from the FirmLedger account — never freehand input.
     The NAME prefers what the member typed for this business (they may sign as
     "Jane Wanjiku, Facilities" or fix a one-letter profile name) and falls back
     to the account name. Before, the account name always won, which left any
     member whose profile name was too short permanently unable to send. */
  const r = leads.create({
    listing: l,
    fields: {
      name: req.body.name || req.user.name,
      email: req.user.email,
      phone: req.body.phone,
      looking_for: req.body.subject || req.body.looking_for,
      message: req.body.message,
    },
    city: loc.city, country: loc.country,
    inquirerUserId: req.user.id,
  });
  if (!r.ok) {
    return bounce(r.errors ? r.errors.join(' ') : (r.error || 'That inquiry could not be sent.'));
  }
  /* A double-submit (button double-clicked, POST refreshed) reuses the thread
     that already exists — confirm it without emailing or notifying twice. */
  if (r.duplicate) {
    return back({
      lead_sent: '1',
      lead_ok: `Your inquiry is already with ${l.name} — we didn't send it twice. Follow the conversation in Dashboard → Leads → Sent.`,
    });
  }
  /* Owner inbox + email. The inquirer never sees the owner's address. */
  const notify = require('../lib/notify');
  notify.notifyUser(l.owner_user_id, {
    kind: 'lead',
    title: `New inquiry for ${l.name} — ${r.fields.name}`,
    body: `${r.fields.looking_for ? `${r.fields.looking_for} · ` : ''}${r.fields.message.slice(0, 140)}`,
    url: `/dashboard/leads?open=${r.id}`,
  });
  const owner = gate.owner;
  if (owner && owner.email) {
    const util2 = require('../lib/util');
    const { sendBranded } = require('../lib/mailer');
    const esc = util2.escHtml;
    /* The opening inquiry is the owner's ONE email for this conversation —
       every later reply reaches them as an in-app notification instead. */
    leads.markEmailed(r.id, 'owner');
    sendBranded(owner.email, `New inquiry for ${l.name} — ${r.fields.name}`, {
      alias: 'support',
      replyTo: `${r.fields.name} <${r.fields.email}>`,
      kicker: 'New lead',
      title: `${esc(r.fields.name)} wants to hear from ${esc(l.name)}`,
      preheader: `A FirmLedger member sent an inquiry to ${l.name}.`,
      alert: `<b>From:</b> ${esc(r.fields.name)} &lt;${esc(r.fields.email)}&gt;${r.fields.phone ? ` &nbsp;·&nbsp; <b>Phone:</b> ${esc(r.fields.phone)}` : ''}${r.fields.looking_for ? `<br><b>Looking for:</b> ${esc(r.fields.looking_for)}` : ''}`,
      alertTone: 'ok',
      paragraphs: [
        esc(r.fields.message).replace(/\n/g, '<br>'),
        `Reply in your <b>Leads inbox</b> — both of you can keep talking there. Your email address was not shown to the inquirer.`,
      ],
      cta: { label: 'Open conversation', url: util2.siteUrl(`/dashboard/leads?open=${r.id}`) },
      note: `Listing: <b>${esc(l.name)}</b> · received ${new Date().toISOString().slice(0, 10)}. You can also reply by email to <a href="mailto:${esc(r.fields.email)}" style="color:#1D4ED8;">${esc(r.fields.email)}</a>.`,
    }).catch(() => {});
  }
  return back({
    lead_sent: '1',
    lead_ok: `Your inquiry was sent to ${l.name}. Follow the conversation in Dashboard → Leads → Sent.`,
  });
});

/* ---------------- Analytics beacon — outbound website click ----------------
 * Fired by JS when a human clicks through to the business website. Bots and
 * owner/admin views are skipped, exactly like page views. */
router.post('/listing/:slug/track-website', (req, res, next) => {
  const l = db.prepare('SELECT * FROM listings WHERE slug = ?').get(req.params.slug);
  if (!l) return res.status(404).json({ ok: false });
  try { require('../lib/analytics').recordWebsiteClick(l, req); } catch { /* ignore */ }
  res.json({ ok: true });
});

/* ---------------- Listing news ----------------
 * Anyone signed in can hand us a story about a company. It never appears
 * straight away — it waits in the moderation queue until the console
 * approves it, which is what keeps this panel trustworthy.
 */
router.get('/listing/:slug/news', requireUser, (req, res, next) => {
  const l = db.prepare('SELECT * FROM listings WHERE slug = ?').get(req.params.slug);
  if (!l) return next();
  const isOwner = req.user && l.owner_user_id === req.user.id;
  if (l.status !== 'approved' && !isOwner && !req.admin) return next();
  const items = newsLib.allFor(l.id);
  res.render('news-submit', {
    meta: {
      title: `Submit news — ${l.name} | FirmLedger`,
      description: `Submit a news story about ${l.name} for review by the FirmLedger moderation team.`,
      canonical: siteUrl(`/listing/${l.slug}/news`),
      robots: 'noindex,nofollow',
    },
    l,
    published: items.filter((n) => n.status === 'approved').slice(0, 8),
    mine: items.filter((n) => n.submitted_by === req.user.id),
    today: new Date().toISOString().slice(0, 10),
    ok: req.query.ok || '', err: req.query.err || '',
  });
});

router.post('/listing/:slug/news', spam.gate('listing'), (req, res, next) => {
  const l = db.prepare('SELECT * FROM listings WHERE slug = ?').get(req.params.slug);
  if (!l) return next();
  if (!req.user) {
    return res.redirect('/login?next=' + encodeURIComponent(`/listing/${l.slug}/news`));
  }
  const r = newsLib.submit({
    listing: l, user: req.user,
    title: req.body.title, url: req.body.url, source: req.body.source,
    published_at: req.body.published_at, summary: req.body.summary, note: req.body.note,
  });
  if (!r.ok) return res.redirect(`/listing/${l.slug}/news?err=` + encodeURIComponent(r.error));
  res.redirect(`/listing/${l.slug}/news?ok=` + encodeURIComponent(
    'Thank you — the story is queued for moderation and appears on the profile once it is approved.'));
});

/* ---------------- Verification badge (dynamic SVG) ---------------- */
/* ---------------- FirmLedger trust badge (SVG, light/dark themes) ---------------- */
const fs = require('fs');
let badgeLogoB64 = '';
try {
  badgeLogoB64 = fs.readFileSync(require('path').join(__dirname, '..', '..', 'public', 'assets', 'logo-mark-96.png')).toString('base64');
} catch { badgeLogoB64 = ''; }

router.get('/badge/:slug.svg', (req, res) => {
  const l = db.prepare(
    `SELECT l.name, l.claimed, l.owner_user_id, l.plan, l.plan_expires_at,
            u.plan AS owner_plan, u.plan_expires_at AS owner_plan_expires
     FROM listings l LEFT JOIN users u ON u.id = l.owner_user_id
     WHERE l.slug = ? AND l.status='approved'`
  ).get(req.params.slug);
  const dark = req.query.theme !== 'light';
  const pro = l && perksActive({ ...l, plan: l.plan, plan_expires_at: l.plan_expires_at, owner_user_id: l.owner_user_id });
  // Premium company badge: Pro subscribers get a gold "PREMIUM MEMBER" variant
  const status = l ? (pro ? 'PREMIUM MEMBER' : l.claimed ? 'VERIFIED BUSINESS' : 'LISTED PROFILE') : 'NOT LISTED';
  const gold = dark ? '#E3B94F' : '#B58C2E';
  const stateColor = l ? (pro ? gold : l.claimed ? (dark ? '#2FBF7A' : '#0E7B4F') : (dark ? '#7FB4FF' : '#0E3AA8')) : '#64748B';
  const th = dark
    ? { bg: '#0A1628', border: pro ? '#5A4A1E' : '#22344F', ink: '#FFFFFF', accent: '#7FB4FF', sub: '#8FA6C4', tile: '#FBF7EC', tileStroke: pro ? '#5A4A1E' : '#22344F' }
    : { bg: pro ? '#FFFDF5' : '#FFFFFF', border: pro ? '#E3D6A8' : '#E7E4DC', ink: '#0A1628', accent: '#1D4ED8', sub: '#64748B', tile: '#FBF7EC', tileStroke: pro ? '#E3D6A8' : '#E7E4DC' };
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=3600');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="56" viewBox="0 0 200 56" role="img" aria-label="FirmLedger — ${status.toLowerCase()}">
  <rect x="0.5" y="0.5" width="199" height="55" rx="11" fill="${th.bg}" stroke="${th.border}"/>
  <g transform="translate(9,9)">
    <rect width="38" height="38" rx="9" fill="${th.tile}" stroke="${th.tileStroke}"/>
    ${badgeLogoB64 ? `<image x="4.5" y="4.5" width="29" height="29" xlink:href="data:image/png;base64,${badgeLogoB64}" href="data:image/png;base64,${badgeLogoB64}"/>` : ''}
  </g>
  <text x="58" y="25.5" font-family="'Segoe UI', Arial, Helvetica, sans-serif" font-size="14.5" font-weight="700" letter-spacing="0.1">
    <tspan fill="${th.ink}">Firm</tspan><tspan fill="${th.accent}">Ledger</tspan>
  </text>
  <g transform="translate(57,31)">
    ${pro
      ? `<path d="M4 2.2l1.5 2.9 3 .4-2.3 2.1.6 3-2.8-1.6-2.8 1.6.6-3-2.3-2.1 3-.4z" fill="${stateColor}"/>`
      : `<circle cx="4" cy="7.5" r="4" fill="${stateColor}"/>
    <path d="M2.4 7.6l1.2 1.2 2.1-2.4" stroke="#FFFFFF" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`}
    <text x="12" y="10.5" font-family="'JetBrains Mono', Consolas, monospace" font-size="7.6" font-weight="600" letter-spacing="1.1" fill="${pro ? stateColor : th.sub}">${esc(status)}</text>
  </g>
  <text x="183" y="29" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="${th.sub}">↗</text>
</svg>`);
});

/* ---------------- Pricing ---------------- */
router.get('/pricing', (req, res) => {
  const plansLib = require('../lib/plans');
  const freshUser = req.user ? db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id) : null;
  res.render('pricing', {
    meta: {
      title: 'Pricing — FirmLedger Pro unlocks everything',
      description: 'Listings are always free to add with full details. FirmLedger Pro unlocks viewing all listing details site-wide, plus the blue verified tick, eligibility for Featured placement and the premium company badge for listings you own.',
      canonical: siteUrl('/pricing'),
    },
    offers: allPlans(true),
    paypalReady: paypal.configured(),
    paypalMode: paypal.mode(),
    trial: {
      days: plansLib.TRIAL_SIGNUP_DAYS,
      eligible: Boolean(freshUser) && plansLib.trialEligible(freshUser),
      active: Boolean(freshUser) && plansLib.trialActive(freshUser),
      daysLeft: freshUser ? plansLib.trialDaysRemaining(freshUser) : 0,
      expiresAt: freshUser && freshUser.trial_expires_at ? String(freshUser.trial_expires_at).slice(0, 10) : '',
      used: Boolean(freshUser && freshUser.trial_started_at) && !(freshUser && plansLib.trialActive(freshUser)),
      isPaidPro: Boolean(freshUser) && plansLib.isProUser(freshUser),
    },
    trialOk: req.query.trial_ok || '',
    trialErr: req.query.trial_err || '',
  });
});

/* ---------------- API — live for FirmLedger Pro ---------------- */
router.get('/api', (req, res) => {
  res.render('api', {
    meta: {
      title: 'FirmLedger API — REST access, included with Pro',
      description: 'Create, read, update and delete the records you own over clean REST endpoints — API-key authentication, rate limits, docs and a live playground. Included with FirmLedger Pro.',
      canonical: siteUrl('/api'),
    },
  });
});

router.get('/api/docs', (req, res) => {
  const lim = require('../lib/apilimit');
  const apikeys = require('../lib/apikeys');
  const { TYPES, SIZES } = require('../lib/taxonomy');
  const { SOCIAL_KEYS } = require('../lib/socialicons');
  res.render('api-docs', {
    meta: {
      title: 'API documentation — FirmLedger API v1',
      description: 'Authentication, rate limits, error catalogue and endpoint reference for the FirmLedger REST API — available with FirmLedger Pro.',
      canonical: siteUrl('/api/docs'),
      breadcrumbs: [{ name: 'Home', url: siteUrl('/') }, { name: 'API', url: siteUrl('/api') }, { name: 'Documentation', url: siteUrl('/api/docs') }],
      jsonld: {
        '@context': 'https://schema.org',
        '@type': 'TechArticle',
        headline: 'FirmLedger REST API v1 — documentation',
        description: 'Authentication, rate limits, error catalogue and endpoint reference for the FirmLedger REST API.',
        url: siteUrl('/api/docs'),
        proficiencyLevel: 'Intermediate',
        dependencies: 'An HTTPS-capable client and a FirmLedger Pro API key.',
        isPartOf: { '@type': 'WebSite', name: 'FirmLedger', url: siteUrl('/') },
      },
    },
    limits: {
      READ_RPM: lim.READ_RPM, WRITE_RPM: lim.WRITE_RPM, GLOBAL_WRITE_RPM: lim.GLOBAL_WRITE_RPM,
      MAX_INFLIGHT: lim.MAX_INFLIGHT, BRUTE_MAX_FAILS: lim.BRUTE_MAX_FAILS, BRUTE_LOCK_MIN: lim.BRUTE_LOCK_MIN,
      MAX_KEYS: apikeys.MAX_ACTIVE_KEYS,
      TYPES: TYPES.map((t) => t.value).join(' · '),
      SIZES: SIZES.join(' · '),
      SOCIALS: SOCIAL_KEYS.join(', '),
    },
  });
});

/* ---------------- About ---------------- */
router.get('/about', (req, res) => {
  res.render('about', {
    meta: {
      title: 'About FirmLedger — The Business Record Layer',
      description: 'FirmLedger is building the trusted record layer for business discovery: verified listings, source transparency and structured intelligence.',
      canonical: siteUrl('/about'),
    },
  });
});

/* ---------------- Legal ---------------- */
router.get('/privacy', (req, res) => {
  res.render('privacy', {
    meta: {
      title: 'Privacy Policy — FirmLedger',
      description: 'How FirmLedger collects, uses, stores and protects personal and business data across the directory, claim verification and accounts.',
      canonical: siteUrl('/privacy'),
      breadcrumbs: [{ name: 'Home', url: siteUrl('/') }, { name: 'Privacy Policy', url: siteUrl('/privacy') }],
    },
  });
});

router.get('/terms', (req, res) => {
  res.render('terms', {
    meta: {
      title: 'Terms of Use — FirmLedger',
      description: 'The terms governing use of the FirmLedger directory, listing submissions, ownership verification and related services.',
      canonical: siteUrl('/terms'),
      breadcrumbs: [{ name: 'Home', url: siteUrl('/') }, { name: 'Terms of Use', url: siteUrl('/terms') }],
    },
  });
});

/* ---------------- Documentation ---------------- */
router.get('/docs', (req, res) => {
  const docs = require('../lib/docs');
  res.render('docs', {
    meta: {
      title: 'Documentation — FirmLedger',
      description: 'How to use FirmLedger: adding listings, Wikipedia enrichment, ownership verification, confidence scoring, the relationship graph and the live developer API.',
      canonical: siteUrl('/docs'),
    },
    sections: docs.SECTIONS,
  });
});

/* ---------------- News / Blog ---------------- */
function postUrl(p) { return `/blog/${p.slug}`; }
router.get('/blog', (req, res) => {
  const posts = db.prepare(
    "SELECT slug, title, excerpt, published_at FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 50"
  ).all();
  res.render('blog/index', {
    meta: {
      title: 'News — FirmLedger',
      description: 'Announcements, methodology notes and guides from the FirmLedger team.',
      canonical: siteUrl('/blog'),
    },
    posts, postUrl,
  });
});

router.get('/blog/:slug', (req, res, next) => {
  const p = db.prepare("SELECT * FROM blog_posts WHERE slug = ? AND status='published'").get(req.params.slug);
  if (!p) return next();
  res.render('blog/post', {
    meta: {
      title: `${p.title} — FirmLedger News`,
      description: truncate(p.excerpt || p.body.replace(/<[^>]+>/g, ' '), 158),
      canonical: siteUrl(postUrl(p)),
      jsonld: {
        '@context': 'https://schema.org', '@type': 'Article',
        headline: p.title, datePublished: p.published_at,
        author: { '@type': 'Organization', name: 'FirmLedger' },
        publisher: { '@type': 'Organization', name: 'FirmLedger', logo: { '@type': 'ImageObject', url: siteUrl('/assets/logo-mark.png') } },
        mainEntityOfPage: siteUrl(postUrl(p)),
      },
    },
    post: p,
  });
});

/* ---------------- Global search ---------------- */
router.get('/search', spam.gate('search'), (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  const out = { listings: [], posts: [], docs: [] };
  let sponsoredHits = [];
  if (q) {
    const needle = `%${q.replace(/[%_]/g, '')}%`;
    /* Sponsored matches lead — a fair random draw of up to two matching
       sponsors, clearly labelled, never the whole set. */
    sponsoredHits = ad.sponsoredSample({ q }, 2);
    try { require('../lib/analytics').recordImpressions(sponsoredHits, 'sponsored_impression', req); } catch { /* ignore */ }
    const hitIds = sponsoredHits.map((l) => l.id);
    const notHits = hitIds.length ? `AND l.id NOT IN (${hitIds.map(() => '?').join(',')})` : '';
    out.listings = db.prepare(
      `SELECT l.*, u.plan AS owner_plan, u.plan_expires_at AS owner_plan_expires
       FROM listings l LEFT JOIN users u ON u.id = l.owner_user_id
       WHERE l.status='approved' ${notHits}
         AND (l.name LIKE ? OR l.tagline LIKE ? OR l.category LIKE ? OR l.city LIKE ?)
       ORDER BY l.featured DESC, l.confidence DESC LIMIT 5`
    ).all(...hitIds, needle, needle, needle, needle);
    out.posts = db.prepare(
      "SELECT slug, title, excerpt, published_at FROM blog_posts WHERE status='published' AND (title LIKE ? OR body LIKE ? OR excerpt LIKE ?) ORDER BY published_at DESC LIMIT 5"
    ).all(needle, needle, needle);
    const docs = require('../lib/docs');
    const ql = q.toLowerCase();
    out.docs = docs.SECTIONS.filter((s) =>
      s.title.toLowerCase().includes(ql) || s.lede.toLowerCase().includes(ql)
       || s.body.some((b) => b.toLowerCase().includes(ql))
    ).slice(0, 5);
  }
  const total = out.listings.length + out.posts.length + out.docs.length;
  /* Search is crawlable *and* indexable. A query that actually returned
     something gets a self-referencing canonical (/search?q=fintech points at
     itself, so it can be indexed on its own merits); the bare page and any
     query with no results consolidate to /search, which keeps empty shells out
     of the index without ever emitting noindex. */
  const canonical = q && total
    ? siteUrl(`/search?q=${encodeURIComponent(q)}`)
    : siteUrl('/search');
  res.render('search', {
    meta: {
      title: q ? `“${q}” — Search | FirmLedger` : 'Search — FirmLedger',
      description: q && total
        ? truncate(`${total} result${total === 1 ? '' : 's'} for “${q}” on FirmLedger — verified business profiles, news and documentation.`, 158)
        : 'Search the entire FirmLedger site: verified listings, news, documentation and guides.',
      canonical,
      robots: 'index, follow',
    },
    q,
    providers: out.listings,
    sponsoredHits,
    posts: out.posts,
    docs: out.docs,
    total,
  });
});

/* ---------------- Listing removal requests (public) ---------------- */
router.get('/removal/:slug', (req, res, next) => {
  const l = db.prepare("SELECT * FROM listings WHERE slug = ? AND status='approved'").get(req.params.slug);
  if (!l) return next();
  res.render('removal', {
    meta: { title: `Request removal of ${l.name} — FirmLedger`, description: 'Ask FirmLedger to review and remove a public business record.', canonical: siteUrl(`/removal/${l.slug}`), noindex: true },
    l, errors: [], mode: 'form', form: {},
  });
});

router.post('/removal/:slug', (req, res, next) => {
  const l = db.prepare("SELECT * FROM listings WHERE slug = ? AND status='approved'").get(req.params.slug);
  if (!l) return next();
  if (String(req.body.homepage || '').trim()) return res.redirect(`/listing/${l.slug}`); // honeypot
  const name = String(req.body.name || '').trim().slice(0, 120);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 254);
  const reason = String(req.body.reason || '').trim().slice(0, 2000);
  const errors = [];
  if (!name) errors.push('Tell us your name.');
  if (!isEmail(email)) errors.push('A valid email is required so we can follow up.');
  if (reason.length < 20) errors.push('Please give a reason (at least 20 characters) — e.g. the business closed, details are wrong, or you act for the owner.');
  if (errors.length) {
    return res.status(422).render('removal', {
      meta: { title: `Request removal of ${l.name} — FirmLedger`, description: '', canonical: siteUrl(`/removal/${l.slug}`), noindex: true },
      l, errors, mode: 'form', form: { name, email, reason },
    });
  }
  db.prepare('INSERT INTO removal_requests (listing_id, name, email, reason) VALUES (?,?,?,?)')
    .run(l.id, name, email, reason);
  res.render('removal', {
    meta: { title: `Request received — FirmLedger`, description: '', canonical: siteUrl(`/removal/${l.slug}`), noindex: true },
    l, errors: [], mode: 'done', form: {},
  });
});

/* ---------------- Newsletter ---------------- */
router.post('/newsletter/subscribe', spam.gate('newsletter', { checkEmail: true }), (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const r = nl.subscribe(email, req.user ? 'account' : 'footer');
  if (!r) return res.redirect('/?nl=' + encodeURIComponent('Enter a valid email address.') + '&nl_err=1');
  if (r.isNew) nl.sendSubscribeWelcome(r.row.email, r.row.token); // fire-and-forget
  const msg = r.isNew
    ? `You're on the list — a welcome email is on its way to ${r.row.email}. The weekly digest lands every week.`
    : `You're already subscribed with ${r.row.email} — the digest keeps landing every week.`;
  res.redirect('/?nl=' + encodeURIComponent(msg));
});

router.get('/newsletter/unsubscribe', (req, res) => {
  const ok = nl.unsubscribe(req.query.token);
  res.render('message', {
    meta: { title: ok ? 'Unsubscribed — FirmLedger' : 'Link expired — FirmLedger', description: '', robots: 'noindex' },
    heading: ok ? 'You have been unsubscribed' : 'That unsubscribe link is no longer valid',
    text: ok
      ? 'Confirmed — no more weekly digests will arrive. You can re-subscribe any time using the box in the site footer.'
      : 'The link may have been replaced by a newer digest email. Manage alerts from your dashboard if you hold an account, or contact support.',
    link: { href: '/', label: 'Back to FirmLedger' },
  });
});

/* ---------------- Jobs board (search + filters) ---------------- */
router.get('/jobs', (req, res) => {
  const filters = {
    q: String(req.query.q || '').trim().slice(0, 60),
    type: String(req.query.type || '').trim(),
    category: String(req.query.category || '').trim(),
    country: String(req.query.country || '').trim(),
    featured: req.query.featured === '1',
  };
  const jobs = nl.boardJobs(filters);
  const companies = new Set(jobs.map((j) => j.listing_id)).size;
  const facets = nl.boardFacets();
  const categories = [...new Set(facets.map((f) => f.category).filter(Boolean))].sort();
  const countries = [...new Set(facets.map((f) => f.country).filter(Boolean))].sort();
  const isFiltered = Boolean(filters.q || filters.type || filters.category || filters.country || filters.featured);
  res.render('jobs', {
    meta: {
      title: `Jobs at verified companies${jobs.length ? ` — ${jobs.length} open roles` : ''} | FirmLedger`,
      description: `Open positions at verified, source-backed businesses on FirmLedger. ${jobs.length} roles across ${companies} companies, refreshed live from the ledger.`,
      canonical: siteUrl('/jobs'),
      jsonld: {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: 'FirmLedger Jobs Board',
        url: siteUrl('/jobs'),
      },
    },
    jobs, companies, filters, categories, countries, isFiltered, JOB_TYPES: nl.JOB_TYPES,
  });
});

/* ---------------- Compare (save & compare companies side by side) ---------------- */
router.get('/compare', (req, res) => {
  const ids = compare.read(req);
  let rows = [];
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    rows = db.prepare(
      `SELECT l.*, u.plan AS owner_plan, u.plan_expires_at AS owner_plan_expires
       FROM listings l LEFT JOIN users u ON u.id = l.owner_user_id
       WHERE l.status='approved' AND l.id IN (${marks}) ORDER BY l.name ASC`
    ).all(...ids);
  }
  res.render('compare', {
    meta: {
      title: 'Compare companies side by side | FirmLedger',
      description: 'Compare verified FirmLedger listings side by side — category, location, founding year, team size, confidence, ownership and more.',
      canonical: siteUrl('/compare'),
    },
    rows, ids, max: compare.MAX,
    ok: req.query.ok || '', err: req.query.err || '',
  });
});

/* Add / remove a listing to the comparison set (cookie-backed, works for guests). */
router.post('/compare/toggle', (req, res) => {
  const id = Number(req.body.listing_id) || 0;
  const back = String(req.body.back || '').startsWith('/') ? String(req.body.back) : '/compare';
  const r = compare.includes(req, id) ? compare.remove(id, res, req) : compare.add(id, res, req);
  let msg;
  if (r.reason === 'full') msg = `Comparison is full — remove one before adding another (max ${compare.MAX}).`;
  else if (r.added) msg = 'Added to comparison — view it side by side.';
  else if (r.ok) msg = 'Removed from comparison.';
  else msg = 'That listing could not be added.';
  res.redirect(back + (back.includes('?') ? '&' : '?') + 'ok=' + encodeURIComponent(msg) + '#compare');
});

router.post('/compare/clear', (req, res) => {
  compare.clear(res, req);
  res.redirect('/compare?ok=' + encodeURIComponent('Comparison cleared.'));
});

/* ---------------- Advertise — Sponsored Content ---------------- */
router.get('/advertise', (req, res) => {
  const faqs = [
    {
      q: 'What exactly do I get when I advertise on FirmLedger?',
      a: 'Your listing appears in the clearly-labelled "Sponsored" strip on the FirmLedger homepage for the duration of the package you purchase. Each card links straight to your verified company profile, so visitors who are already browsing the directory can discover your business in one click.',
    },
    {
      q: 'How much does advertising cost?',
      a: 'Packages start at $15 for 7 days, $40 for 30 days and $95 for 90 days (prices shown in USD). Longer placements deliver the best value per day. The exact packages available are listed on this page, and they can be changed by the FirmLedger team at any time.',
    },
    {
      q: 'How do I pay, and is it secure?',
      a: 'Payment is handled entirely by PayPal — cards, bank accounts or PayPal balance. You are redirected to PayPal to authorise the order, then back to FirmLedger. No card details ever touch FirmLedger servers; we only receive PayPal\'s payment confirmation.',
    },
    {
      q: 'When does my sponsored placement go live?',
      a: 'The moment PayPal confirms your payment. Our server verifies the order, flags your listing as sponsored for the purchased duration, and it joins the homepage Sponsored Content rotation immediately. You also receive an in-app notification and a receipt email.',
    },
    {
      q: 'How is homepage visibility shared between sponsors?',
      a: 'Fairly and at random. The homepage can only show a few sponsored cards at once, so every visit draws a random subset of the active sponsors — each sponsor has exactly the same probability of appearing. The same rule applies inside filtered views: when someone searches or browses a category, up to three matching sponsors are drawn at random and shown first with a clear “Sponsored” label.',
    },
    {
      q: 'Do I need a Pro subscription or a verified listing to advertise?',
      a: 'You need a free FirmLedger account and at least one approved listing that you own. Advertising is separate from FirmLedger Pro — Pro unlocks viewing full profiles, while advertising buys a homepage placement. Claiming and verifying your listing is free.',
    },
    {
      q: 'Is sponsored content marked as an advertisement?',
      a: 'Yes, always. Every sponsored placement carries a clear "Sponsored" label — it never masquerades as an editorial pick, and we never sell rankings inside the organic directory results.',
    },
  ];
  res.render('advertise', {
    meta: {
      title: 'Advertise on FirmLedger — homepage Sponsored Content for your business',
      description: 'Promote your verified business listing on the FirmLedger homepage. Transparent Sponsored Content packages from $15, PayPal-secured checkout, and instant activation the moment payment is confirmed.',
      canonical: siteUrl('/advertise'),
      jsonld: {
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'Service',
            name: 'FirmLedger Sponsored Content — homepage advertising',
            serviceType: 'Sponsored Content advertising',
            description: 'Clearly-labelled homepage advertising placements for verified FirmLedger business listings, sold as time-based packages and paid through PayPal.',
            url: siteUrl('/advertise'),
            provider: { '@type': 'Organization', name: 'FirmLedger', url: siteUrl('/') },
            areaServed: 'Worldwide',
            offers: {
              '@type': 'AggregateOffer',
              priceCurrency: 'USD',
              lowPrice: '15',
              highPrice: '95',
              offerCount: ad.allPackages(true).length,
            },
          },
          {
            '@type': 'FAQPage',
            mainEntity: faqs.map((f) => ({
              '@type': 'Question', name: f.q,
              acceptedAnswer: { '@type': 'Answer', text: f.a },
            })),
          },
        ],
      },
      breadcrumbs: [
        { name: 'Home', url: siteUrl('/') },
        { name: 'Advertise', url: siteUrl('/advertise') },
      ],
    },
    packages: ad.allPackages(true),
    paypalReady: paypal.configured(),
    paypalMode: paypal.mode(),
    faqs,
    ok: req.query.ok || '',
    err: req.query.err || '',
  });
});

/* ---------------- Careers — FirmLedger is hiring ---------------- */
router.get('/careers', (req, res) => {
  const open = careers.listOpen();
  const all = careers.listAll();
  const activeAny = open.length > 0;
  const EMPLOYMENT_MAP = {
    'Full-time': 'FULL_TIME', 'Part-time': 'PART_TIME', 'Contract': 'CONTRACTOR',
    'Internship': 'INTERN', 'Remote': 'FULL_TIME', 'Freelance': 'CONTRACTOR',
  };
  const faqs = [
    {
      q: 'What does FirmLedger do?',
      a: 'FirmLedger is the business record layer for modern discovery: canonical, source-backed profiles for companies, startups, agencies, organizations, products, services and publishers — built with verification, provenance tracking and a unified intelligence API.',
    },
    {
      q: 'How do I apply for a role at FirmLedger?',
      a: 'If a role is listed above, hit the “Apply by email” button — it opens a pre-filled application addressed to careers@firmledger.co.ke with the role, your details and a short cover letter. If no role fits right now, you can still send a speculative application and we keep it on file.',
    },
    {
      q: 'Does FirmLedger hire remotely?',
      a: 'Each role states its location — many FirmLedger roles are remote-friendly. Where the listing says “Remote”, we welcome applicants from any timezone with a reliable connection; some roles are office-based in Nairobi and say so explicitly.',
    },
    {
      q: 'What does the interview process look like?',
      a: 'A short intro call to talk about the role and your background, a focused practical conversation (a real, small task in the area you are applying for — never a take-home marathon), then a final chat with the founders. We keep the whole process under two weeks wherever possible.',
    },
    {
      q: 'What is it like to work at FirmLedger?',
      a: 'A small, senior, high-trust team that ships to production every week. You own your area end-to-end, write to a public quality bar, and work directly with the people using what you build. We favour calm, focused weeks and honest communication over hours and heroics.',
    },
  ];
  res.render('careers', {
    meta: {
      title: activeAny ? 'Careers — open roles at FirmLedger' : 'Careers — build the business record layer at FirmLedger',
      description: activeAny
        ? `${open.length} open role${open.length === 1 ? '' : 's'} at FirmLedger, the business record layer. See what we build, how we work and apply by email in one click.`
        : 'Jobs at FirmLedger, the business record layer. See what we build, how we work, and apply by email — or send a speculative application for future roles.',
      canonical: siteUrl('/careers'),
      jsonld: activeAny ? open.map((c) => ({
        '@type': 'JobPosting',
        title: c.title,
        description: `${c.description}${c.requirements ? `\n\nRequirements:\n${c.requirements}` : ''}`.slice(0, 4000),
        datePosted: (c.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
        employmentType: EMPLOYMENT_MAP[c.role_type] || 'FULL_TIME',
        hiringOrganization: {
          '@type': 'Organization',
          name: 'FirmLedger',
          sameAs: siteUrl('/'),
          logo: siteUrl('/assets/logo-mark.png'),
        },
        jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: c.location || 'Remote', addressCountry: 'KE' } },
        url: siteUrl(`/careers#role-${c.id}`),
        applicantLocationRequirements: { '@type': 'Country', name: c.location || 'Worldwide' },
      })) : null,
      breadcrumbs: [
        { name: 'Home', url: siteUrl('/') },
        { name: 'Careers', url: siteUrl('/careers') },
      ],
    },
    open, all, activeAny, ROLE_TYPES: careers.ROLE_TYPES,
    applyMailto: careers.applyMailto,
    faqs,
    ok: req.query.ok || '',
  });
});

/* ---------------- SEO endpoints ---------------- */
router.get('/robots.txt', (req, res) => {
  /* Dev/staging hosts (unset BASE_URL, localhost, .test, private IP) are never indexed.
     Override with FORCE_INDEXABLE=1. */
  if (!isPublicBaseUrl()) {
    res.type('text/plain').send(
      [
        'User-agent: *',
        'Disallow: /',
        '',
        `# This host is not configured as the public site yet (BASE_URL=${process.env.BASE_URL || 'unset'}).`,
        '# Set BASE_URL to your public https origin in .env and restart to open the site to crawlers.',
        '',
      ].join('\n')
    );
    return;
  }
  res.type('text/plain').send(robotsTxt());
});

/* Paths no crawler may index — repeated inside every allowed group so that a
   named search-engine group never loses them by overriding "User-agent: *". */
const ROBOTS_PRIVATE_PATHS = [
  '/dashboard',
  '/admin3119Musa',
  '/removal/',
  '/forgot',
];

/* Crawlers that train / ground generative models. Blocked outright — each one
   gets a Disallow: / that a later "User-agent: *" group can never undo. */
const ROBOTS_AI_BOTS = [
  'GPTBot',
  'Amazonbot',
  'Applebot-Extended',
  'Bytespider',
  'CCBot',
  'ClaudeBot',
  'CloudflareBrowserRenderingCrawler',
  'Google-Extended',
  'meta-externalagent',
];

/* Legitimate search crawlers — indexing is welcome, private paths are not.
   Applebot (search) is listed here; Applebot-Extended (AI training) is blocked. */
const ROBOTS_SEARCH_BOTS = [
  'Googlebot',
  'Googlebot-Image',
  'Googlebot-News',
  'Bingbot',
  'Slurp',
  'DuckDuckBot',
  'YandexBot',
  'Baiduspider',
  'Applebot',
];

/**
 * robots.txt for the public site.
 *
 * Group order matters: the AI blocks come first and each has its own
 * User-agent section, so nothing they match is re-opened by the catch-all.
 * Every User-agent token appears exactly once in the file.
 */
function robotsTxt() {
  const disallows = ROBOTS_PRIVATE_PATHS.map((p) => `Disallow: ${p}`);
  return [
    '# FirmLedger — https://firmledger.co.ke',
    '# Content signals: search indexing yes, AI training no, reference use only.',
    '',
    '# ---- AI scrapers / model trainers: blocked site-wide ----',
    ...ROBOTS_AI_BOTS.flatMap((ua) => [`User-agent: ${ua}`, 'Disallow: /', '']),
    '# ---- Search engines: full crawl minus private paths ----',
    ...ROBOTS_SEARCH_BOTS.map((ua) => `User-agent: ${ua}`),
    'Allow: /',
    ...disallows,
    '',
    '# ---- Everyone else ----',
    'User-agent: *',
    'Content-Signal: search=yes, ai-train=no, use=reference',
    'Allow: /',
    ...disallows,
    '',
    `Sitemap: ${siteUrl('/sitemap.xml')}\n`,
  ].join('\n');
}

/* ---- Sitemap index (sitemapindex pattern, same way Crunchbase segments by content type) ---- */
function catSlugsInUse(listings) {
  const slugByName = new Map(catLib.all().map((c) => [c.name, c.slug]));
  const cats = new Set();
  for (const l of listings) {
    const cs = slugByName.get(l.category);
    if (cs) cats.add(cs);
  }
  return { slugByName, cats };
}
function urlset(urls) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>
    <loc>${escXml(u.loc)}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ''}
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;
}
function latestMod(rows) {
  return rows.length ? new Date(rows.map((r) => r.updated_at).sort().pop()).toISOString().slice(0, 10) : null;
}

router.get('/sitemap.xml', (req, res) => {
  const listings = db.prepare("SELECT updated_at FROM listings WHERE status='approved'").all();
  const lm = latestMod(listings);
  /* No fabricated lastmod on static.xml: stamping "today" on every fetch
     teaches crawlers the field is noise (Search Console: "invalid lastmod").
     Its real content dates (blog posts) live inside the file itself. */
  const maps = [
    { loc: '/sitemaps/static.xml' },
    { loc: '/sitemaps/listings.xml', lastmod: lm },
    { loc: '/sitemaps/categories.xml', lastmod: lm },
    { loc: '/sitemaps/locations.xml', lastmod: lm },
  ];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${maps.map((m) => `  <sitemap>\n    <loc>${escXml(siteUrl(m.loc))}</loc>${m.lastmod ? `\n    <lastmod>${m.lastmod}</lastmod>` : ''}\n  </sitemap>`).join('\n')}
</sitemapindex>`);
});

router.get('/sitemaps/static.xml', (req, res) => {
  const urls = [
    { loc: siteUrl('/'), changefreq: 'daily', priority: '1.0' },
    { loc: siteUrl('/directory'), changefreq: 'hourly', priority: '0.9' },
    { loc: siteUrl('/search'), changefreq: 'weekly', priority: '0.5' },
    { loc: siteUrl('/api'), changefreq: 'monthly', priority: '0.5' },
    { loc: siteUrl('/pricing'), changefreq: 'weekly', priority: '0.6' },
    { loc: siteUrl('/about'), changefreq: 'monthly', priority: '0.5' },
    { loc: siteUrl('/docs'), changefreq: 'monthly', priority: '0.5' },
    { loc: siteUrl('/careers'), changefreq: 'weekly', priority: '0.5' },
    { loc: siteUrl('/advertise'), changefreq: 'weekly', priority: '0.6' },
    { loc: siteUrl('/compare'), changefreq: 'weekly', priority: '0.5' },
    { loc: siteUrl('/status'), changefreq: 'hourly', priority: '0.7' },
    { loc: siteUrl('/privacy'), changefreq: 'yearly', priority: '0.2' },
    { loc: siteUrl('/terms'), changefreq: 'yearly', priority: '0.2' },
    { loc: siteUrl('/blog'), changefreq: 'weekly', priority: '0.6' },
    { loc: siteUrl('/jobs'), changefreq: 'daily', priority: '0.7' },
    { loc: siteUrl('/api/docs'), changefreq: 'monthly', priority: '0.6' },
  ];
  /* Per-role entries are gone on purpose: a sitemap <loc> must be a plain URL —
     fragments (#role-…) are invalid per the sitemap protocol and Search Console
     reports them as errors. The /careers page is already listed above, and the
     anchors are plain links on it, so crawlers still reach every role. */
  for (const p of db.prepare("SELECT slug, updated_at, published_at, status FROM blog_posts WHERE status='published'").all()) {
    urls.push({
      loc: siteUrl(`/blog/${p.slug}`),
      lastmod: new Date(p.updated_at || p.published_at).toISOString().slice(0, 10),
      changefreq: 'monthly', priority: '0.5',
    });
  }
  res.type('application/xml').send(urlset(urls));
});

router.get('/sitemaps/listings.xml', (req, res) => {
  const listings = db.prepare("SELECT slug, updated_at FROM listings WHERE status='approved' ORDER BY confidence DESC").all();
  res.type('application/xml').send(urlset(listings.map((l) => ({
    loc: siteUrl(`/listing/${l.slug}`),
    lastmod: new Date(l.updated_at).toISOString().slice(0, 10),
    changefreq: 'weekly',
    priority: '0.8',
  }))));
});

router.get('/sitemaps/categories.xml', (req, res) => {
  const listings = db.prepare("SELECT category FROM listings WHERE status='approved'").all();
  const { slugByName, cats } = catSlugsInUse(listings);
  const lastmod = latestMod(db.prepare("SELECT updated_at FROM listings WHERE status='approved'").all());
  void slugByName;
  res.type('application/xml').send(urlset([...cats].map((s) => ({
    loc: siteUrl(`/directory/c/${s}`), lastmod, changefreq: 'daily', priority: '0.7',
  }))));
});

router.get('/sitemaps/locations.xml', (req, res) => {
  const listings = db.prepare("SELECT category, country, city, region, updated_at FROM listings WHERE status='approved'").all();
  const { slugByName } = catSlugsInUse(listings);
  const combos = new Map();
  for (const l of listings) {
    const cs = slugByName.get(l.category);
    if (!cs) continue;
    const lm = new Date(l.updated_at).toISOString().slice(0, 10);
    for (const v of [l.country, l.city, l.region]) {
      if (!v) continue;
      const key = `${cs}-in-${slugify(v)}`;
      if (!combos.has(key) || combos.get(key) < lm) combos.set(key, lm);
    }
  }
  res.type('application/xml').send(urlset([...combos.entries()].map(([key, lastmod]) => ({
    loc: siteUrl(`/directory/c/${key}`), lastmod, changefreq: 'daily', priority: '0.6',
  }))));
});

router.get('/feed.xml', (req, res) => {
  const listings = db.prepare(
    "SELECT * FROM listings WHERE status='approved' ORDER BY created_at DESC LIMIT 30"
  ).all().map((l) => ({
    title: `New listing: ${l.name}`,
    link: siteUrl(`/listing/${l.slug}`),
    date: new Date(l.created_at),
    desc: truncate(l.tagline || l.description, 200),
    cat: l.category,
  }));
  const posts = (() => {
    try {
      return db.prepare(
        "SELECT * FROM blog_posts WHERE status='published' ORDER BY published_at DESC LIMIT 15"
      ).all().map((p) => ({
        title: p.title,
        link: siteUrl(`/blog/${p.slug}`),
        date: new Date(p.published_at || p.created_at),
        desc: truncate(p.excerpt || p.body.replace(/<[^>]+>/g, ' '), 200),
        cat: 'News',
      }));
    } catch { return []; }
  })();
  let careerItems = [];
  try { careerItems = careers.feedItems(); } catch { careerItems = []; }
  const items = [...listings, ...posts, ...careerItems]
    .sort((a, b) => b.date - a.date)
    .slice(0, 40)
    .map((i) => `    <item>
      <title>${escXml(i.title)}</title>
      <link>${escXml(i.link)}</link>
      <guid isPermaLink="true">${escXml(i.link)}</guid>
      <pubDate>${i.date.toUTCString()}</pubDate>
      <description>${escXml(i.desc)}</description>
      <category>${escXml(i.cat)}</category>
    </item>`).join('\n');
  res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>FirmLedger — Listings &amp; News</title>
    <link>${escXml(siteUrl('/'))}</link>
    <description>New verified business records and news from FirmLedger.</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`);
});

/* IndexNow key file — proves key ownership to search engines */
router.get('/:key([a-f0-9]{32}).txt', (req, res) => {
  if (req.params.key === getIndexNowKey()) return res.type('text/plain').send(req.params.key);
  res.status(404).send('not found');
});

module.exports = router;
