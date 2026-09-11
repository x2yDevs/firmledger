/**
 * FirmLedger — production database upgrade test.
 *
 *   node tests/db-upgrade.test.js
 *
 * Boots the CURRENT schema code against a simulated OLD production database
 * (tables as an earlier release created them, with real rows) and asserts the
 * boot migrates everything forward without throwing and without losing data.
 *
 * Regression: PR #55 put `CREATE INDEX idx_leads_inquirer` (on the new
 * inquirer_user_id column) in an unguarded db.exec that runs BEFORE the ALTER
 * adding the column. Fresh databases booted fine, but every existing
 * production database crashed at require time with
 * `SqliteError: no such column: inquirer_user_id` — the process crash-looped
 * and the site answered 502 on every path. IF NOT EXISTS only guards the
 * index name, never the columns. Any future index on a migrated column must
 * be created after its ALTER (or inside try/catch) — this suite boots an old
 * database on purpose so that ordering mistake fails loudly here instead of
 * in production.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/* An old production database: pre-trials users, pre-region listings, leads
   WITHOUT inquirer_user_id, old NOT NULL payments/removal FKs, and none of
   the newer tables (lead_messages, status_*, indexing_*, ai_*). */
const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-upgrade-'));
const reportFile = path.join(os.tmpdir(), `upgrade-${Date.now()}.json`);

const bootScript = `
process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(oldDir)};
const Database = require(${JSON.stringify(path.join(ROOT, 'node_modules/better-sqlite3'))});
const old = new Database(require('path').join(${JSON.stringify(oldDir)}, 'firmledger.db'));
old.exec(\`
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE listings (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'company',
  category TEXT NOT NULL DEFAULT 'Other', website TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '', logo_url TEXT NOT NULL DEFAULT '', founded TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', socials TEXT NOT NULL DEFAULT '{}',
  sources TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', featured INTEGER NOT NULL DEFAULT 0,
  claimed INTEGER NOT NULL DEFAULT 0, confidence INTEGER NOT NULL DEFAULT 0,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, last_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE leads (id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
  looking_for TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new', archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
\`);
old.prepare("INSERT INTO users (email, password_hash, name) VALUES (?,?,?)").run('owner@up.example', 'x', 'Up Owner');
old.prepare("INSERT INTO listings (slug, name, status, owner_user_id, claimed) VALUES (?,?,?,?,?)").run('up-acme', 'Up Acme', 'approved', 1, 1);
old.prepare("INSERT INTO leads (listing_id, owner_user_id, name, email, message) VALUES (?,?,?,?,?)").run(1, 1, 'Up Inquirer', 'inq@up.example', 'Hello, please send a quote.');
old.close();

/* Boot the CURRENT code against that old database — this require() is what
   crashed production (it must not throw). */
const { db } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
const cols = (t) => db.prepare('PRAGMA table_info(' + t + ')').all().map((c) => c.name);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
const fs2 = require('fs');
fs2.writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify({
  userCols: cols('users'), listingCols: cols('listings'), leadCols: cols('leads'),
  paymentCols: cols('payments'),
  hasLeadMessages: tables.includes('lead_messages'),
  hasStatus: tables.includes('status_components') && tables.includes('incidents'),
  hasIndexing: tables.includes('indexing_log') && tables.includes('google_indexing_submissions'),
  hasInquirerIndex: Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_leads_inquirer'").get()),
  counts: {
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    listings: db.prepare('SELECT COUNT(*) c FROM listings').get().c,
    leads: db.prepare('SELECT COUNT(*) c FROM leads').get().c,
    categories: db.prepare('SELECT COUNT(*) c FROM categories').get().c,
    plans: db.prepare('SELECT COUNT(*) c FROM plans').get().c,
  },
  lead: db.prepare('SELECT name, email, message, inquirer_user_id FROM leads').get(),
  submitter: db.prepare('SELECT submitter_user_id FROM listings').get().submitter_user_id,
}));
`;

console.log('FirmLedger production database upgrade\n\nOld-database boot');
let booted = false;
let bootError = '';
try {
  execFileSync(process.execPath, ['-e', bootScript], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  booted = true;
} catch (e) {
  bootError = String((e.stderr || e.message || e)).split('\n').slice(0, 4).join(' ');
}
check('current code boots against an old production database', booted, bootError);

if (booted) {
  const out = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  console.log('\nSchema migrations');
  check('users gained plan/trial/provider/digest columns',
    ['plan', 'trial_expires_at', 'provider_id', 'leads_digest', 'trial_reminders_sent'].every((c) => out.userCols.includes(c)));
  check('listings gained region/tech/plan/sponsored/submitter columns',
    ['region', 'tech', 'plan', 'sponsored', 'submitter_user_id'].every((c) => out.listingCols.includes(c)));
  check('leads gained inquirer_user_id', out.leadCols.includes('inquirer_user_id'));
  check('payments gained plan/kind/promo columns',
    ['plan_id', 'kind', 'promo_id'].every((c) => out.paymentCols.includes(c)));
  check('new tables created (lead_messages, status, indexing)',
    out.hasLeadMessages && out.hasStatus && out.hasIndexing);
  check('idx_leads_inquirer index exists after migration', out.hasInquirerIndex === true);
  console.log('\nData preservation');
  check('all old rows survived', out.counts.users === 1 && out.counts.listings === 1 && out.counts.leads === 1,
    JSON.stringify(out.counts));
  check('lead content intact', out.lead && out.lead.name === 'Up Inquirer' && out.lead.email === 'inq@up.example' && /quote/.test(out.lead.message));
  check('listing submitter backfilled from owner', out.submitter === 1);
  check('categories/plans seeded on old database', out.counts.categories >= 20 && out.counts.plans >= 2);
}

console.log(`\n${'='.repeat(64)}`);
console.log(`checks passed: ${passed}   failed: ${failures.length}`);
failures.forEach((f) => console.log('  • ' + f));
console.log('='.repeat(64));

try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(reportFile, { force: true }); } catch { /* ignore */ }
process.exit(failures.length ? 1 : 0);
