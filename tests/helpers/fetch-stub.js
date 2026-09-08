/**
 * Offline stand-in for `fetch`, preloaded into a test process with `node -r`.
 *
 * The technology radar scans a company's public homepage; tests can never hit
 * the real network, so every hostname maps to a canned page whose signatures
 * lib/enrich.js is expected to recognise:
 *
 *   next.example    Next.js + Stripe + a careers link (Greenhouse)
 *   wp.example      WordPress + jQuery + a generator meta tag
 *   bare.example    a plain page — nothing detectable
 *   offline.example answers 500, so the scan has to come back empty and honest
 *   slow.example    answers after FETCH_STUB_DELAY_MS (default 400ms), so a run
 *                   stays in flight long enough to test progress and cancel
 *
 * Anything not listed answers like bare.example. Every URL requested is
 * appended to FETCH_STUB_LOG when that env var is set.
 */
const fs = require('fs');

const PAGES = {
  'next.example': `<!doctype html><html><head>
      <script src="/_next/static/chunks/main.js"></script>
      <script src="https://js.stripe.com/v3/"></script>
    </head><body><div id="__NEXT_DATA__">{}</div>
      <a href="https://boards.greenhouse.io/nextco">Careers</a>
    </body></html>`,
  'wp.example': `<!doctype html><html><head>
      <meta name="generator" content="WordPress 6.5">
      <link rel="stylesheet" href="/wp-content/themes/seed/style.css">
    </head><body><script src="/wp-includes/js/jquery/jquery.min.js"></script></body></html>`,
  'bare.example': '<!doctype html><html><head><title>Bare</title></head><body><p>Just a page.</p></body></html>',
  'slow.example': '<!doctype html><html><head><script src="/_next/static/x.js"></script></head><body><div id="__NEXT_DATA__"></div></body></html>',
};

const HEADERS = {
  'next.example': { server: 'Vercel' },
  'wp.example': { 'cf-ray': 'abc-LOS' },
};

function makeResponse(body, { status = 200, headers = {}, url }) {
  const map = new Map(
    Object.entries({ 'content-type': 'text/html; charset=utf-8', ...headers })
      .map(([k, v]) => [String(k).toLowerCase(), String(v)])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get: (k) => (map.has(String(k).toLowerCase()) ? map.get(String(k).toLowerCase()) : null),
      entries: () => [...map.entries()],
    },
    text: async () => body,
  };
}

const delay = Number(process.env.FETCH_STUB_DELAY_MS || 400);

/**
 * Canned news-search feed. `q` carries the quoted company name, so the items
 * can be built around it:
 *   1. the company's name in the headline          → name match
 *   2. no name, but the story sits on its domain   → domain match
 *   3. only part of the name ("Safari" for
 *      "Safari Fintech")                           → must NOT match
 *   4. nothing to do with the company              → must NOT match
 */
function newsFeed(query) {
  const name = String(query || '').replace(/["']/g, '').trim() || 'Unknown Co';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
  const first = name.split(/\s+/)[0];
  const items = [
    { title: `${name} raises Sh200m to expand across East Africa`, link: `https://newsroom.example/${slug}/raise`,
      source: 'Business Daily', desc: `${name} has closed a Sh200m round led by regional investors.` },
    { title: 'Expansion plan revealed for the coast', link: `https://${slug}.example/press/expansion`,
      source: `${name} Newsroom`, desc: 'The company confirmed three new branches this year.' },
    { title: `${first} launches a new long-distance service`, link: 'https://finance.example/markets/launch',
      source: 'Finance Weekly', desc: `The ${first} brand is expanding into new routes.` },
    { title: 'Kenya shilling firms against the dollar', link: 'https://finance.example/markets/shilling',
      source: 'Finance Weekly', desc: 'Currency markets steadied on improved inflows.' },
  ];
  /* Mirror Google News RSS: the description is entity-encoded HTML wrapping a
     long rss/articles URL. Profiles must never dump that markup as copy. */
  const gNews = 'https://news.google.com/rss/articles/CBMitgFBVV95cUxORWwyb2VYS01UaXdLZWdVWl9ZTGx4TmZaNWpxRjMxSTYzUDVEbjV5Y2huY3k2bGVNV3lUMUJpVDZtZU9NMHdLV0VKZzRkR1pxU';
  const xml = items.map((it) => `    <item>
      <title>${it.title}</title>
      <link>${it.link}</link>
      <guid isPermaLink="false">${it.link}</guid>
      <pubDate>Mon, 03 Aug 2026 06:00:00 GMT</pubDate>
      <source url="https://${it.source.toLowerCase().replace(/\s+/g, '')}.example">${it.source}</source>
      <description>&lt;a href="${gNews}" target="_blank"&gt;${it.desc}&lt;/a&gt;&nbsp;&nbsp;&lt;font color="#6f6f6f"&gt;${it.source}&lt;/font&gt;</description>
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
    <title>${name} — news search</title>
${xml}
  </channel></rss>`;
}

globalThis.fetch = async function fetchStub(input) {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  let host = '';
  let parsed = null;
  try { parsed = new URL(url); host = parsed.hostname; } catch { host = String(url); }
  if (process.env.FETCH_STUB_LOG) {
    try { fs.appendFileSync(process.env.FETCH_STUB_LOG, `${url}\n`); } catch { /* ignore */ }
  }
  if (host === 'offline.example') return makeResponse('', { status: 500, url });
  if (host === 'news.google.com' || /\/rss\/search/.test(url)) {
    const q = parsed ? (parsed.searchParams.get('q') || '') : '';
    return makeResponse(newsFeed(q), { status: 200, headers: { 'content-type': 'application/rss+xml' }, url });
  }
  if (host === 'slow.example') await new Promise((r) => setTimeout(r, delay));
  return makeResponse(PAGES[host] || PAGES['bare.example'], {
    status: 200,
    headers: HEADERS[host] || {},
    url,
  });
};

module.exports = { PAGES, makeResponse, newsFeed };
