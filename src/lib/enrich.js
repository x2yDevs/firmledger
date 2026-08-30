/**
 * Enrichment — Wikipedia-first ("all real data") provider.
 *
 * Every field returned is sourced from a real, public Wikipedia article and
 * its linked Wikidata entity. Nothing is guessed:
 *   name        → article title
 *   description → article summary extract (REST API)
 *   logo_url    → Wikidata P154 (logo image) or article lead image
 *   website     → Wikidata P856 (official website)
 *   founded     → Wikidata P571 (inception year)
 *   city/country→ Wikidata P159 (HQ) / P17 (country)
 *   socials     → Wikidata identifiers (X P2002, FB P2013, IG P2003,
 *                 LinkedIn P4264, YouTube P2397)
 *   source      → the canonical Wikipedia article URL (recorded as provenance)
 */
const { truncate } = require('./util');

const UA = 'FirmLedgerBot/1.0 (+https://firmledger.co.ke/enrichment)';
const API = 'https://en.wikipedia.org/w/api.php';

async function apiGet(params) {
  const u = new URL(API);
  u.searchParams.set('format', 'json');
  u.searchParams.set('origin', '*');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(u, { signal: controller.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

function stripQuery(raw) {
  let q = String(raw || '').trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')          // drop path if a URL was pasted
    .trim();
  // domain input (example.com / safaricom.co.ke) → search the brand part
  if (/^[^\s]+\.[a-z]{2,}$/i.test(q)) q = q.split('.').slice(0, -1).join(' ');
  return q.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const BUSINESS_RX = /compan|corporation|platform|service|startup|brand|organization|operator|bank|publisher|magazine|website|retailer|studio|agency|manufactur|airline|telecom|software|network|chain/i;

/**
 * Title-intent search first (avoids full-text noise), then plain search.
 * Disambiguation pages are skipped; business-sounding articles are preferred.
 */
async function searchTitles(query) {
  const j = await apiGet({ action: 'query', list: 'search', srsearch: `intitle:"${query}"`, srlimit: 5 });
  const hits = (j && j.query && j.query.search) || [];
  if (hits.length) return { titles: hits.map((h) => h.title), titleMatch: true };
  // full-text fallback — only trustworthy if the page title still names the query
  const j2 = await apiGet({ action: 'query', list: 'search', srsearch: query, srlimit: 5 });
  const hits2 = (j2 && j2.query && j2.query.search) || [];
  return { titles: hits2.map((h) => h.title), titleMatch: false };
}

async function pickArticle(query) {
  const { titles, titleMatch } = await searchTitles(query);
  const qToken = query.toLowerCase().split(' ')[0];
  let best = null;
  for (const title of titles) {
    if (!titleMatch && !title.toLowerCase().includes(qToken)) continue; // unrelated full-text mentions are never real matches
    const sum = await summaryFor(title);
    if (!sum || !sum.extract) continue;
    if (sum.type === 'disambiguation' || /may refer to:/i.test(sum.extract.slice(0, 100))) {
      if (titleMatch) continue;
      break;
    }
    const hay = `${sum.description || ''} ${sum.extract.slice(0, 200)}`;
    const score = (BUSINESS_RX.test(hay) ? 3 : 0)
      + (title.toLowerCase().includes(qToken) ? 1 : 0);
    if (!best || score > best.score) best = { title, sum, score };
    if (best.score >= 4) break;
  }
  return best;
}

async function summaryFor(title) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
      signal: controller.signal, headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

async function qidFor(title) {
  const j = await apiGet({ action: 'query', prop: 'pageprops', titles: title });
  const pages = (j && j.query && j.query.pages) || {};
  const page = Object.values(pages)[0];
  return (page && page.pageprops && page.pageprops.wikibase_item) || null;
}

async function entityData(qid) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`, {
      signal: controller.signal, headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!res.ok) return null;
    const j = await res.json();
    return (j.entities && j.entities[qid]) || null;
  } catch { return null; } finally { clearTimeout(timer); }
}

async function labelOf(qid) {
  const e = await entityData(qid);
  return (e && e.labels && e.labels.en && e.labels.en.value) || '';
}

const claimsOf = (entity, prop) => (entity && entity.claims && entity.claims[prop]) || [];
const firstString = (claims) => {
  const c = claims[0];
  return c && c.mainsnak && c.mainsnak.datavalue ? String(c.mainsnak.datavalue.value) : '';
};
const firstItemQid = (claims) => {
  const c = claims[0];
  return c && c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value
    ? c.mainsnak.datavalue.value.id : null;
};
const inceptionYear = (claims) => {
  const c = claims[0];
  const t = c && c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value && c.mainsnak.datavalue.value.time;
  const m = t && t.match(/^\+(\d{4})-/);
  return m ? m[1] : '';
};

/**
 * Fetch real business details from Wikipedia/Wikidata.
 * Accepts a company name or a website domain. Never fabricates fields.
 */
async function fetchSiteDetails(rawInput) {
  const query = stripQuery(rawInput);
  if (!query) return { ok: false, error: 'Enter a business name or website first.' };

  const picked = await pickArticle(query);
  if (!picked) {
    return { ok: false, error: `“${query}” has no real Wikipedia article — fill the record in manually (we never guess data).` };
  }
  const { title, sum } = picked;

  const details = {
    name: truncate((sum.title || title).replace(/\s*\([^)]+\)\s*$/, ''), 60),
    description: truncate(sum.extract, 1200),
    logo_url: '',
    website: '',
    founded: '',
    city: '',
    country: '',
    email: '',
    keywords: '',
    socials: {},
    category_hint: sum.description || '',
    source: (sum.content_urls && sum.content_urls.desktop && sum.content_urls.desktop.page)
      || `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
  };

  if (!details.logo_url && sum.thumbnail && sum.thumbnail.source) details.logo_url = sum.thumbnail.source;

  // Wikidata structured facts
  const qid = await qidFor(title);
  if (qid) {
    const entity = await entityData(qid);
    if (entity) {
      const website = firstString(claimsOf(entity, 'P856'));
      if (website) details.website = website.replace(/\/+$/, '');
      const inc = inceptionYear(claimsOf(entity, 'P571'));
      if (inc) details.founded = inc;
      const logoFile = firstString(claimsOf(entity, 'P154'));
      if (logoFile) details.logo_url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(logoFile.replace(/ /g, '_'))}?width=256`;
      else if (!details.logo_url) {
        const img = firstString(claimsOf(entity, 'P18'));
        if (img) details.logo_url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(img.replace(/ /g, '_'))}?width=256`;
      }
      const hqQid = firstItemQid(claimsOf(entity, 'P159'));
      const countryQid = firstItemQid(claimsOf(entity, 'P17'));
      if (hqQid) {
        const hq = await labelOf(hqQid);
        if (hq) {
          if (/,/.test(hq)) {
            const parts = hq.split(',').map((s) => s.trim()).filter(Boolean);
            details.city = parts.slice(0, -1).join(', ') || parts[0] || '';
            if (!details.country) details.country = parts[parts.length - 1] || '';
          } else details.city = hq;
        }
      }
      if (countryQid && !details.country) details.country = await labelOf(countryQid);

      const soc = entity.claims || {};
      const x = firstString(soc.P2002 || []);
      const fb = firstString(soc.P2013 || []);
      const ig = firstString(soc.P2003 || []);
      const li = firstString(soc.P4264 || []);
      const yt = firstString(soc.P2397 || []);
      if (x) details.socials.x = `https://x.com/${x}`;
      if (fb) details.socials.facebook = `https://facebook.com/${fb}`;
      if (ig) details.socials.instagram = `https://instagram.com/${ig}`;
      if (li) details.socials.linkedin = `https://linkedin.com/company/${li}`;
      if (yt) details.socials.youtube = `https://youtube.com/channel/${yt}`;
    }
  }

  const found = ['name', 'description', 'logo_url', 'website', 'founded'].filter((k) => details[k]).length
    + Object.keys(details.socials).length;
  if (!found) return { ok: false, error: 'Wikipedia returned nothing usable for that entry.' };
  return { ok: true, details };
}

/* ============================================================
 * Technology radar + hiring signal detection.
 * Everything reported is detected from the company's own public
 * homepage (HTML signatures, generator meta, HTTP headers).
 * ============================================================ */
const TECH_SIGNATURES = [
  ['Next.js', 'Framework', /__NEXT_DATA__|\/_next\//i],
  ['Nuxt', 'Framework', /__NUXT__|\/_nuxt\//i],
  ['React', 'Framework', /data-reactroot|__react|react[\-.]?(?:production|development)?[\-.]?(?:min\.)?js|react-dom/i],
  ['Vue.js', 'Framework', /vue(?:-runtime)?(?:[\-.]min|\.min)?\.js|data-v-[a-f0-9]{6,}/i],
  ['Angular', 'Framework', /ng-version|angular(?:[\-.]min)?\.js/i],
  ['Svelte', 'Framework', /svelte[\-.]/i],
  ['WordPress', 'CMS', /wp-content|wp-includes/i],
  ['Drupal', 'CMS', /\/sites\/default\/files|drupal\.js/i],
  ['Shopify', 'Commerce', /cdn\.shopify\.com|Shopify\.theme/i],
  ['WooCommerce', 'Commerce', /woocommerce/i],
  ['Wix', 'CMS', /wix\.com|_wixCssImports/i],
  ['Squarespace', 'CMS', /static1\.squarespace\.com|sqs-/i],
  ['Webflow', 'CMS', /webflow\.js|\.webflow\.io|data-wf-/i],
  ['jQuery', 'Library', /jquery[\-.]/i],
  ['Bootstrap', 'UI', /bootstrap([\-.]min)?\.(css|js)/i],
  ['Tailwind CSS', 'UI', /tailwind([\-.]min)?\.css|tailwindcss/i],
  ['Stripe', 'Payments', /js\.stripe\.com|stripe\.com\/v3/i],
  ['PayPal', 'Payments', /paypal(?:objects)?\.com|paypal\.sdk/i],
  ['Google Analytics', 'Analytics', /google-analytics\.com|gtag\(|ga\(['"]create/i],
  ['Google Tag Manager', 'Analytics', /googletagmanager\.com/i],
  ['Intercom', 'Support', /intercomcdn|widget\.intercom\.io/i],
  ['HubSpot', 'Marketing', /js\.hs-scripts\.com|hs-analytics|hubspot/i],
  ['Hotjar', 'Analytics', /static\.hotjar\.com/i],
  ['Cloudflare', 'CDN', /cloudflare/i],
];

const HIRING_RX = /careers?|\/jobs|workable\.com|boards\.greenhouse\.io|jobs\.lever\.co|ashbyhq\.com|breezy\.hr|applytojob\.com/i;
const HIRING_PROVIDER = [
  ['Greenhouse', /boards\.greenhouse\.io/i],
  ['Lever', /jobs\.lever\.co/i],
  ['Workable', /workable\.com/i],
  ['Ashby', /ashbyhq\.com/i],
  ['Breezy', /breezy\.hr/i],
];

/**
 * Detect technology used on a public website + hiring/careers signal.
 * Returns { tech: [{n, c}], hiring: {url, provider} | null } — only real findings.
 */
async function detectTech(rawUrl) {
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal, redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html' },
    });
    if (!res.ok) return { tech: [], hiring: null };
    const body = (await res.text()).slice(0, 1_000_000);
    const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
    const hay = `${headers}\n${body}`;

    const tech = [];
    for (const [name, cat, rx] of TECH_SIGNATURES) {
      if (rx.test(hay)) tech.push({ n: name, c: cat });
    }
    const gen = body.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i)
      || body.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']generator["']/i);
    if (gen) {
      const g = gen[1].trim().replace(/[<>]/g, '').slice(0, 60);
      if (g && !tech.some((t) => g.toLowerCase().includes(t.n.toLowerCase()))) tech.push({ n: g, c: 'Platform' });
    }
    if (res.headers.get('cf-ray') && !tech.some((t) => t.n === 'Cloudflare')) tech.push({ n: 'Cloudflare', c: 'CDN' });
    if ((res.headers.get('server') || '').toLowerCase().includes('vercel') && !tech.some((t) => t.n === 'Vercel')) tech.push({ n: 'Vercel', c: 'Hosting' });

    let hiring = null;
    const aRx = /<a\s[^>]*href=["']([^"']+)["'][^>]*>/gi;
    let m;
    while (!hiring && (m = aRx.exec(body))) {
      if (HIRING_RX.test(m[1])) {
        try {
          const abs = new URL(m[1], res.url || url).toString();
          const prov = HIRING_PROVIDER.find(([, rx]) => rx.test(abs));
          hiring = { url: abs, provider: prov ? prov[0] : '' };
        } catch { /* bad href */ }
      }
    }
    return { tech: tech.slice(0, 14), hiring };
  } catch {
    return { tech: [], hiring: null };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchSiteDetails, detectTech };
