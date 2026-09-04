/**
 * FirmLedger — API surface & discovery test.
 *
 *   node tests/api.test.js
 *
 * Guards the production API contract:
 *   • the non-functional `search` and `relationships` service functions have
 *     been removed from the API service layer (no dead endpoints in v1);
 *   • the API docs and landing page declare v1 production-ready and that every
 *     endpoint needs a key;
 *   • the dashboard playground renders its response inside a contained,
 *     scrollable region so a large JSON document never stretches the page;
 *   • a fresh database seeds the production API blog post.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

process.env.FIRMLEDGER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-api-'));
process.env.BASE_URL = 'http://localhost:3000';

/* 1. API service layer no longer ships dead search / relationships functions. */
const svc = require(path.join(ROOT, 'src/lib/apilistings.js'));
check('APIsvc no longer exports `search`', typeof svc.search === 'undefined');
check('APIsvc no longer exports `relationships`', typeof svc.relationships === 'undefined');
check('APIsvc still exports the live directory read', typeof svc.directory === 'function');
check('APIsvc still exports owner CRUD', typeof svc.createListing === 'function' && typeof svc.deleteListing === 'function');

/* 2. Docs + landing page declare production-ready and the key requirement. */
const apiDocs = fs.readFileSync(path.join(ROOT, 'views/api-docs.ejs'), 'utf8');
const apiLanding = fs.readFileSync(path.join(ROOT, 'views/api.ejs'), 'utf8');
check('API docs declare production readiness', /production-ready/i.test(apiDocs) && /Production ready/i.test(apiDocs));
check('API docs state every endpoint needs a key', /requires an API key/i.test(apiDocs) || /requires a key/i.test(apiDocs) || /key-authenticated/i.test(apiDocs));
check('API docs confirm v1 is the frozen contract', /v1/i.test(apiDocs) && apiDocs.includes('/api/v2'));
check('API landing page declares production readiness', /Production ready/i.test(apiLanding) && /production/i.test(apiLanding));
check('API landing page requires a key on every endpoint', /requires an API key/i.test(apiLanding) || /key-authenticated/i.test(apiLanding));

/* 3. Playground response is a contained, scrollable region. */
const playground = fs.readFileSync(path.join(ROOT, 'views/dashboard/api-playground.ejs'), 'utf8');
check('Playground response uses a contained scroll region', /playground-response/.test(playground));
check('Playground keeps the request form controls', /name="method"/.test(playground) && /Send request/.test(playground));
check('Playground keeps the preset loader', /id="pgPreset"/.test(playground));
check('Playground keeps the copy-body action', /data-copy="#pgResponseBodyText"/.test(playground));

/* 4. The CSS actually caps the response region. */
const css = fs.readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8');
check('CSS constrains the playground response height', /\.playground-response\s*\{[\s\S]*max-height/.test(css) && /\.playground-response[\s\S]*overflow-y\s*:\s*auto/.test(css));
check('CSS keeps the response body highlighted (no inline-code chrome on .code-block code)', /\.code-block code\s*\{[\s\S]*background\s*:\s*none/.test(css) && /\.code-block code[\s\S]*font\s*:\s*inherit/.test(css));

/* 5. A fresh DB seeds both API posts, with the newest one leading /blog.
      The hands-on tutorial is now the lead post; the production guide stays
      published behind it. */
const { db } = require(path.join(ROOT, 'src/db.js'));
const rows = db.prepare("SELECT slug, status FROM blog_posts WHERE status='published' ORDER BY published_at DESC").all();
const apiPost = rows.find((r) => r.slug === 'firmledger-api-production-guide');
check('New API blog post is seeded', Boolean(apiPost));
const tutorial = rows.find((r) => r.slug === 'firmledger-api-tutorial-first-integration');
check('API tutorial blog post is seeded', Boolean(tutorial));
check('The newest post is the API tutorial', rows.length > 0 && rows[0].slug === 'firmledger-api-tutorial-first-integration');

/* 6. The blog seed source explains the key requirement for its readers. */
const blogseed = fs.readFileSync(path.join(ROOT, 'src/lib/blogseed.js'), 'utf8');
check('Blog seed includes an API how-to post', /firmledger-api-production-guide/.test(blogseed));
check('Blog seed includes the hands-on API tutorial', /firmledger-api-tutorial-first-integration/.test(blogseed));
check('The tutorial states keys are a Pro feature', /keys are a (?:FirmLedger )?Pro feature/i.test(blogseed));
check('The blog seeder backfills new posts without clobbering edits', /if \(exists\.get\(p\.slug\)\) continue;/.test(blogseed));
check('Blog post explains the API-key requirement', /every endpoint requires an API key/i.test(blogseed) || /every endpoint needs a key/i.test(blogseed) || /requires an API key/i.test(blogseed));
check('Blog post explains how to use the API', /Step 1 — get a Pro key/i.test(blogseed) || /Step 2 — authenticate/i.test(blogseed) || /How to use the FirmLedger API/i.test(blogseed));

console.log(`\n${'='.repeat(64)}`);
console.log(`checks passed: ${passed}   failed: ${failures.length}`);
failures.forEach((f) => console.log('  • ' + f));
console.log('='.repeat(64));

try { fs.rmSync(process.env.FIRMLEDGER_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failures.length ? 1 : 0);
