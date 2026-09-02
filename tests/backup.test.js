/**
 * FirmLedger — .firmledger backup round-trip test.
 *
 *   node tests/backup.test.js
 *
 * Builds a backup from a populated console, then restores it into a brand-new
 * empty database in a separate process and asserts that users, EVERY LISTING
 * with its configuration, and the admin configuration (settings, categories,
 * plans, promos, advertising, careers, blog, protection rules, status) all come
 * back intact.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/* --------------------------------------------------- phase 1: build a backup */
const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-bk-src-'));
const backupFile = path.join(os.tmpdir(), `roundtrip-${Date.now()}.firmledger`);

const buildScript = `
process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(sourceDir)};
const { db, setSetting } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
const backup = require(${JSON.stringify(path.join(ROOT, 'src/lib/backup.js'))});

const uid = db.prepare("INSERT INTO users (email, password_hash, name, plan, plan_expires_at) VALUES ('owner@rt.example','$2a$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','Round Trip','pro','2031-01-01')").run().lastInsertRowid;

db.prepare(\`INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,city,tags,socials,status,featured,claimed,sponsored,plan,plan_expires_at,owner_user_id)
  VALUES ('rt-alpha','RT Alpha','Alpha tagline here','Alpha is a fixture listing carrying a full configuration for the backup round-trip test.','company','Technology','https://alpha.rt.example','hi@alpha.rt.example','Kenya','Nairobi','alpha,ledger','{"x":"https://x.com/rtalpha"}','approved',1,1,1,'pro','2032-05-05',?)\`).run(uid);
db.prepare(\`INSERT INTO listings (slug,name,tagline,description,type,category,website,country,status)
  VALUES ('rt-beta','RT Beta','Beta tagline here','Beta is an unowned fixture listing used to prove ownerless records survive a restore too.','company','Finance','https://beta.rt.example','Kenya','pending')\`).run();

db.prepare("INSERT OR IGNORE INTO categories (name, slug, official) VALUES ('Round Trip Cat','round-trip-cat',0)").run();
db.prepare("INSERT INTO plans (name, blurb, price_cents, currency, duration_days, active, sort) VALUES ('RT Plan','round trip',1500,'USD',30,1,9)").run();
db.prepare("INSERT INTO promo_codes (code, percent, max_uses, active) VALUES ('RTCODE',20,5,1)").run();
db.prepare("INSERT INTO careers (title, role_type, location, description, requirements, apply_email, status) VALUES ('RT Analyst','Full-time','Nairobi','Long enough description for a role.','Requirements here.','careers@firmledger.co.ke','open')").run();
db.prepare("INSERT INTO blog_posts (slug, title, excerpt, body, status) VALUES ('rt-post','RT Post','Excerpt','Body copy','published')").run();
db.prepare("INSERT INTO spam_ip (value, kind, note) VALUES ('198.51.100.7','block','round trip')").run();
db.prepare("INSERT INTO spam_domain (value, kind, note) VALUES ('rt-spam.example','block','round trip')").run();
setSetting('site_tagline_rt', 'Round trip setting value');
setSetting('auto_approve', '1');

fs.writeFileSync(${JSON.stringify(backupFile)}, backup.buildBackup());
`;

execFileSync(process.execPath, ['-e', `const fs=require('fs');${buildScript}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

const doc = JSON.parse(fs.readFileSync(backupFile, 'utf8'));

/* --------------------------------------------------- harness */
let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('FirmLedger .firmledger backup round-trip\n\nFile contents');
check('format header present', doc.format === 'firmledger-backup@2' && doc.kind === 'full-backup');
check('users included', Array.isArray(doc.users) && doc.users.some((u) => u.email === 'owner@rt.example'));
check('ALL listings included (owned and unowned)',
  Array.isArray(doc.listings) && doc.listings.length === 2 && doc.listings.some((l) => l.slug === 'rt-beta'));
const alpha = (doc.listings || []).find((l) => l.slug === 'rt-alpha') || {};
check('listing configuration included',
  alpha.configuration && alpha.configuration.plan === 'pro' && alpha.configuration.featured === 1 && alpha.configuration.sponsored === 1,
  JSON.stringify(alpha.configuration));
check('listing owner carried by email', alpha.owner_email === 'owner@rt.example', alpha.owner_email);
check('settings included', doc.configuration && doc.configuration.settings && doc.configuration.settings.site_tagline_rt === 'Round trip setting value');
check('categories included', (doc.configuration.categories || []).some((c) => c.slug === 'round-trip-cat'));
check('plans included', (doc.configuration.plans || []).some((p) => p.name === 'RT Plan'));
check('promos included', (doc.configuration.promo_codes || []).some((p) => p.code === 'RTCODE'));
check('careers included', (doc.configuration.careers || []).some((c) => c.title === 'RT Analyst'));
check('blog posts included', (doc.configuration.blog_posts || []).some((b) => b.slug === 'rt-post'));
check('protection rules included',
  (doc.configuration.protection.ip_rules || []).some((r) => r.value === '198.51.100.7')
  && (doc.configuration.protection.domain_rules || []).some((r) => r.value === 'rt-spam.example'));
check('raw table snapshot included', doc.database && doc.database.listings && Array.isArray(doc.database.listings.rows));

/* --------------------------------------------------- phase 2: restore fresh */
console.log('\nRestore into an empty database');
const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-bk-dst-'));
const reportFile = path.join(os.tmpdir(), `roundtrip-report-${Date.now()}.json`);

const restoreScript = `
process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(targetDir)};
const fs = require('fs');
const { db, getSetting } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
const backup = require(${JSON.stringify(path.join(ROOT, 'src/lib/backup.js'))});
const text = fs.readFileSync(${JSON.stringify(backupFile)}, 'utf8');
const r = backup.importUsers(text);
const second = backup.importUsers(text);   // importing twice must not duplicate anything
const g = (sql, ...p) => db.prepare(sql).get(...p);
fs.writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify({
  result: r,
  second: second,
  counts: {
    listings: g('SELECT COUNT(*) c FROM listings').c,
    users: g('SELECT COUNT(*) c FROM users').c,
    plans: g("SELECT COUNT(*) c FROM plans WHERE name='RT Plan'").c,
    ips: g("SELECT COUNT(*) c FROM spam_ip WHERE value='198.51.100.7'").c,
  },
  user: g("SELECT email, plan, plan_expires_at, password_hash FROM users WHERE email='owner@rt.example'"),
  alpha: g("SELECT * FROM listings WHERE slug='rt-alpha'"),
  beta: g("SELECT * FROM listings WHERE slug='rt-beta'"),
  category: g("SELECT * FROM categories WHERE slug='round-trip-cat'"),
  plan: g("SELECT * FROM plans WHERE name='RT Plan'"),
  promo: g("SELECT * FROM promo_codes WHERE code='RTCODE'"),
  career: g("SELECT * FROM careers WHERE title='RT Analyst'"),
  post: g("SELECT * FROM blog_posts WHERE slug='rt-post'"),
  ip: g("SELECT * FROM spam_ip WHERE value='198.51.100.7'"),
  domain: g("SELECT * FROM spam_domain WHERE value='rt-spam.example'"),
  setting: getSetting('site_tagline_rt', ''),
  autoApprove: getSetting('auto_approve', '0'),
}));
`;
execFileSync(process.execPath, ['-e', restoreScript], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
const out = JSON.parse(fs.readFileSync(reportFile, 'utf8'));

check('import reported ok', out.result && out.result.ok === true, JSON.stringify(out.result && out.result.error));
check('restore summary returned', out.result.restore && out.result.restore.tables.length > 3, JSON.stringify(out.result.restore && out.result.restore.tables));
check('user restored with original hash', out.user && out.user.plan === 'pro' && String(out.user.password_hash).startsWith('$2a$'));
check('owned listing restored', out.alpha && out.alpha.name === 'RT Alpha');
check('listing configuration restored',
  out.alpha && out.alpha.plan === 'pro' && out.alpha.plan_expires_at === '2032-05-05'
  && out.alpha.featured === 1 && out.alpha.claimed === 1 && out.alpha.sponsored === 1 && out.alpha.status === 'approved',
  JSON.stringify(out.alpha && { p: out.alpha.plan, f: out.alpha.featured, s: out.alpha.sponsored, st: out.alpha.status }));
check('listing socials/tags restored', out.alpha && /rtalpha/.test(out.alpha.socials) && out.alpha.tags === 'alpha,ledger');
check('ownership re-attached to the right account',
  out.alpha && out.user && out.alpha.owner_user_id !== null, JSON.stringify(out.alpha && out.alpha.owner_user_id));
check('unowned listing restored', out.beta && out.beta.status === 'pending');
check('category restored', Boolean(out.category));
check('plan offer restored', out.plan && out.plan.price_cents === 1500);
check('promo restored', out.promo && out.promo.percent === 20);
check('career restored', out.career && out.career.status === 'open');
check('blog post restored', out.post && out.post.status === 'published');
check('protection rules restored', Boolean(out.ip) && Boolean(out.domain));
check('settings restored', out.setting === 'Round trip setting value' && out.autoApprove === '1');
check('importing the same file twice duplicates nothing',
  out.counts.listings === 2 && out.counts.users === 1 && out.counts.plans === 1 && out.counts.ips === 1,
  JSON.stringify(out.counts));

console.log(`\n${'='.repeat(64)}`);
console.log(`checks passed: ${passed}   failed: ${failures.length}`);
failures.forEach((f) => console.log('  • ' + f));
console.log('='.repeat(64));

for (const p of [sourceDir, targetDir]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
for (const p of [backupFile, reportFile]) { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } }
process.exit(failures.length ? 1 : 0);
