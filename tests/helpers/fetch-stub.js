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

globalThis.fetch = async function fetchStub(input) {
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  let host = '';
  try { host = new URL(url).hostname; } catch { host = String(url); }
  if (process.env.FETCH_STUB_LOG) {
    try { fs.appendFileSync(process.env.FETCH_STUB_LOG, `${url}\n`); } catch { /* ignore */ }
  }
  if (host === 'offline.example') return makeResponse('', { status: 500, url });
  if (host === 'slow.example') await new Promise((r) => setTimeout(r, delay));
  return makeResponse(PAGES[host] || PAGES['bare.example'], {
    status: 200,
    headers: HEADERS[host] || {},
    url,
  });
};

module.exports = { PAGES, makeResponse };
