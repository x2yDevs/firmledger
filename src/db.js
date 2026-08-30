/**
 * FirmLedger — database layer (SQLite, production-ready schema)
 * Swap to PostgreSQL later by replacing this module only.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'firmledger.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'user',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'company',
  category TEXT NOT NULL DEFAULT 'Other',
  website TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  logo_url TEXT NOT NULL DEFAULT '',
  founded TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  socials TEXT NOT NULL DEFAULT '{}',
  sources TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  featured INTEGER NOT NULL DEFAULT 0,
  claimed INTEGER NOT NULL DEFAULT 0,
  confidence INTEGER NOT NULL DEFAULT 0,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_type ON listings(type);
CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category);
CREATE INDEX IF NOT EXISTS idx_listings_country ON listings(country);
CREATE INDEX IF NOT EXISTS idx_listings_owner ON listings(owner_user_id);

CREATE TABLE IF NOT EXISTS listing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  event_date TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'milestone',
  title TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_listing ON listing_events(listing_id);

CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  token TEXT NOT NULL,
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_listing ON claims(listing_id);
CREATE INDEX IF NOT EXISTS idx_claims_user ON claims(user_id);

CREATE TABLE IF NOT EXISTS resets (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT,
  total_requests INTEGER NOT NULL DEFAULT 0,
  write_requests INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS api_usage_daily (
  key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  writes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  official INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  rel_type TEXT NOT NULL,
  target_listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
  target_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rel_listing ON relationships(listing_id);
CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_listing_id);
CREATE TABLE IF NOT EXISTS blog_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS removal_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_removal_listing ON removal_requests(listing_id);

CREATE TABLE IF NOT EXISTS admin_mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_maillog_created ON admin_mail_log(created_at DESC);
`);

/* Migrate older databases forward */
try { db.exec("ALTER TABLE listings ADD COLUMN region TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
try { db.exec("ALTER TABLE listings ADD COLUMN tech TEXT NOT NULL DEFAULT '[]'"); } catch { /* column exists */ }
try { db.exec("ALTER TABLE listings ADD COLUMN tech_checked_at TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
try { db.exec("ALTER TABLE listings ADD COLUMN hiring_url TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0"); } catch { /* column exists */ }
/* Registration OTPs (15-minute expiry) — users only exist after the emailed
   code is confirmed, stopping account creation with someone else's email. */
db.exec(`
CREATE TABLE IF NOT EXISTS reg_otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reg_otps_email ON reg_otps(email);
`);

/* User two-factor: TOTP on the account + single-use recovery codes. */
db.exec(`
CREATE TABLE IF NOT EXISTS user_totp (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret TEXT NOT NULL DEFAULT '',
  pending_secret TEXT NOT NULL DEFAULT '',
  recovery_codes TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 0,
  enabled_at TEXT NOT NULL DEFAULT ''
);
`);

/* Support tickets + live chat messages. Statuses: open, solved, closed, unread flag tracks
   whether admin has read the latest user message. */
db.exec(`
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  status TEXT NOT NULL DEFAULT 'open',
  admin_seen_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  attachment TEXT NOT NULL DEFAULT '',
  attachment_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ticket_msgs ON ticket_messages(ticket_id, id);
`);
/* Pro plan: 'free' | 'pro'. Expiry ISO date; empty = no expiry (admin-granted).
   Pro is ACCOUNT-scoped (users.plan) — a Pro account sees full listing details
   everywhere and its listings get the perks. listings.plan stays as an admin
   per-listing override/boost (rendering perks without touching the account). */
try { db.exec("ALTER TABLE listings ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'"); } catch { /* column exists */ }
try { db.exec("ALTER TABLE listings ADD COLUMN plan_expires_at TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'"); } catch { /* column exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN plan_expires_at TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }

db.exec(`
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  blurb TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  duration_days INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/* Seed the default Pro offers on a fresh boot (admin can edit/add more). */
if (!db.prepare('SELECT id FROM plans LIMIT 1').get()) {
  const ins = db.prepare('INSERT INTO plans (name, blurb, price_cents, currency, duration_days, active, sort) VALUES (?,?,?,?,?,1,?)');
  ins.run('FirmLedger Pro — Monthly', '30 days of the enhanced verified profile: blue tick, homepage slot, premium badge, full contact details and the events timeline.', 3000, 'USD', 30, 1);
  ins.run('FirmLedger Pro — Yearly', 'A full year of Pro — two months free versus paying monthly.', 30000, 'USD', 365, 2);
}

db.exec(`
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL DEFAULT 0,
  duration_days INTEGER NOT NULL DEFAULT 30,
  order_id TEXT NOT NULL DEFAULT '',
  reference TEXT UNIQUE NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'initialized',
  channel TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_listing ON payments(listing_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
`);
try { db.exec("ALTER TABLE payments ADD COLUMN plan_id INTEGER NOT NULL DEFAULT 0"); } catch { /* column exists */ }
try { db.exec("ALTER TABLE payments ADD COLUMN duration_days INTEGER NOT NULL DEFAULT 30"); } catch { /* column exists */ }
try { db.exec("ALTER TABLE payments ADD COLUMN order_id TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }

/* Legacy payments tables declared listing_id NOT NULL REFERENCES listings(id),
   which rejects account-scoped payments (no listing). Rebuild with a nullable
   listing_id in place when detected — safer than crashing at checkout. */
(function migratePaymentsListingFk() {
  try {
    const col = db.prepare("PRAGMA table_info(payments)").all().find((c) => c.name === 'listing_id');
    if (!col || col.notnull !== 1) return;
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE payments__new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id INTEGER REFERENCES listings(id) ON DELETE SET NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_id INTEGER NOT NULL DEFAULT 0,
        duration_days INTEGER NOT NULL DEFAULT 30,
        order_id TEXT NOT NULL DEFAULT '',
        reference TEXT UNIQUE NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'initialized',
        channel TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        paid_at TEXT
      );
      INSERT INTO payments__new (id, listing_id, user_id, plan_id, duration_days, order_id, reference, amount, currency, status, channel, email, created_at, paid_at)
        SELECT id, CASE WHEN listing_id = 0 OR NOT EXISTS (SELECT 1 FROM listings WHERE listings.id = payments.listing_id) THEN NULL ELSE listing_id END,
               user_id, plan_id, duration_days, order_id, reference, amount, currency, status, channel, email, created_at, paid_at FROM payments;
      DROP TABLE payments;
      ALTER TABLE payments__new RENAME TO payments;
      CREATE INDEX IF NOT EXISTS idx_payments_listing ON payments(listing_id);
      CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
      COMMIT;
    `);
    db.pragma('foreign_keys = ON');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    db.pragma('foreign_keys = ON');
    console.error('[db] payments listing_id migration skipped:', e.message);
  }
})();

/* Newsletter / watchlist / jobs */
db.exec(`
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL DEFAULT 'footer',
  token TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, listing_id)
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  role_type TEXT NOT NULL DEFAULT 'Full-time',
  location TEXT NOT NULL DEFAULT '',
  apply_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  featured INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fav_user ON favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_listing ON jobs(listing_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
`);
try { db.exec("ALTER TABLE reg_otps ADD COLUMN newsletter INTEGER NOT NULL DEFAULT 0"); } catch { /* column exists */ }

require('./lib/blogseed').seedBlog(db);

/* Settings helpers */
function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

/* Seed official categories on first boot */
const catCount = db.prepare('SELECT COUNT(*) c FROM categories').get().c;
if (!catCount) {
  const { CATEGORIES } = require('./lib/taxonomy');
  const { slugify } = require('./lib/util');
  const ins = db.prepare('INSERT OR IGNORE INTO categories (name, slug, official) VALUES (?,?,1)');
  for (const name of CATEGORIES) ins.run(name, slugify(name));
  console.log(`[db] seeded ${CATEGORIES.length} official categories`);
}

module.exports = { db, getSetting, setSetting };
