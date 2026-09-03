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

/* ---------------- Home ---------------- */
router.get('/', (req, res) => {
  const stats = {
    listings: db.prepare("SELECT COUNT(*) c FROM listings WHERE status='approved'").get().c,
    verified: db.prepare("SELECT COUNT(*) c FROM listings WHERE status='approved' AND claimed=1").get().c,
    countries: db.prepare("SELECT COUNT(DISTINCT country) c FROM listings WHERE status='approved' AND country<>''").get().c,
  };
  /* Homepage featured records: admin-pinned records first, then listings carrying
     Pro perks — either admin-boosted or owned by an account with an active
     subscription. Up to 8 render as the normal grid; when there are more than 8
     the whole set rides the same horizontal marquee as the promoted (sponsored)
     strip, so nothing is ever dropped from the homepage. */
  const FEATURED_GRID_MAX = 8;
  const FEATURED_RAIL_MAX = 24;
  const featuredWhere = `FROM listings l
     LEFT JOIN users u ON u.id = l.owner_user_id
     WHERE l.status='approved'
       AND (l.featured=1 OR ${PRO_LISTING_SQL} OR ${PRO_USER_SQL})`;
  const featuredCount = db.prepare(`SELECT COUNT(*) c ${featuredWhere}`).get().c;
  const featuredOverflow = featuredCount > FEATURED_GRID_MAX;
  const featured = db.prepare(
    `SELECT l.*, u.plan AS owner_plan, u.plan_expires_at AS owner_plan_expires ${featuredWhere}
     ORDER BY l.featured DESC, l.updated_at DESC LIMIT ?`
  ).all(featuredOverflow ? FEATURED_RAIL_MAX : FEATURED_GRID_MAX);
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
  /* Every active sponsor is rendered: the homepage strip is a marquee that scrolls
     the whole set through a fixed-width row instead of dropping all but the first four. */
  const sponsored = ad.sponsoredStrip();
  const hasActiveSponsors = sponsored.length > 0;

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
    sponsored, hasActiveSponsors,
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
  const listings = db.prepare(
    `SELECT l.*, u.plan AS owner_plan, u.plan_expires_at AS owner_plan_expires
     FROM listings l LEFT JOIN users u ON u.id = l.owner_user_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${order} LIMIT ? OFFSET ?`
  ).all(...params, PER_PAGE, (page - 1) * PER_PAGE);

  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const bits = [q && `“${q}”`, type && typeLabel(type), category, country].filter(Boolean);
  const title = bits.length ? `${bits.join(' · ')} — Directory | FirmLedger` : 'Business Directory | FirmLedger';

  res.render('directory', {
    meta: {
      title,
      description: truncate(
        `Browse ${total} verified business listings${category ? ` in ${category}` : ''}${country ? ` based in ${country}` : ''} on FirmLedger — structured, source-backed company records.`, 158),
      canonical: siteUrl('/directory' + (q ? `?q=${encodeURIComponent(q)}` : '')),
    },
    listings, total, page, pages,
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

  const count = listings.length;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pages = Math.max(1, Math.ceil(count / 24));
  const visible = listings.slice((page - 1) * 24, page * 24);

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
  });
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
      description: 'Listings are always free to add with full details. FirmLedger Pro unlocks viewing all listing details site-wide, plus the blue verified tick, homepage Featured placement and premium company badge for listings you own.',
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
  if (q) {
    const needle = `%${q.replace(/[%_]/g, '')}%`;
    out.listings = db.prepare(
      `SELECT l.*, u.plan AS owner_plan, u.plan_expires_at AS owner_plan_expires
       FROM listings l LEFT JOIN users u ON u.id = l.owner_user_id
       WHERE l.status='approved'
         AND (l.name LIKE ? OR l.tagline LIKE ? OR l.category LIKE ? OR l.city LIKE ?)
       ORDER BY l.featured DESC, l.confidence DESC LIMIT 5`
    ).all(needle, needle, needle, needle);
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
      a: 'The moment PayPal confirms your payment. Our server verifies the order, flags your listing as sponsored for the purchased duration, and it appears in the homepage Sponsored Content strip immediately. You also receive an in-app notification and a receipt email.',
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
  const today = new Date().toISOString().slice(0, 10);
  const maps = [
    { loc: '/sitemaps/static.xml', lastmod: today },
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
  for (const c of db.prepare("SELECT id, updated_at FROM careers WHERE status='open'").all()) {
    urls.push({
      loc: siteUrl(`/careers#role-${c.id}`),
      lastmod: new Date(c.updated_at).toISOString().slice(0, 10),
      changefreq: 'weekly', priority: '0.4',
    });
  }
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
