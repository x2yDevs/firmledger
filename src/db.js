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

/* Original submitter is preserved when a listing is claimed — owner_user_id
   moves to the verified claimant, submitter_user_id stays put. */
try { db.exec('ALTER TABLE listings ADD COLUMN submitter_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL'); } catch { /* column exists */ }
try {
  db.prepare(
    'UPDATE listings SET submitter_user_id = owner_user_id WHERE submitter_user_id IS NULL AND owner_user_id IS NOT NULL'
  ).run();
} catch { /* ignore */ }

db.exec(`
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  audience TEXT NOT NULL DEFAULT 'user',
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'info',
  read_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(audience, user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notif_admin ON notifications(audience, created_at DESC);

CREATE TABLE IF NOT EXISTS deletion_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT '',
  improve TEXT NOT NULL DEFAULT '',
  confirm_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_delreq_user ON deletion_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_delreq_status ON deletion_requests(status);

CREATE TABLE IF NOT EXISTS pro_transfer_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  to_listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_protx_user ON pro_transfer_requests(user_id);
`);

/* ---- Notification archiving (trash with an expiry) ----
   archived_at         when the user/admin moved it to trash
   deleted_at          when it left the active inbox (same moment as archived_at)
   archive_expires_at  when purgeExpired() hard-deletes it
   Mirrors migrations/2026-09-01-notifications-archive.sql. */
try { db.exec('ALTER TABLE notifications ADD COLUMN archived_at DATETIME'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE notifications ADD COLUMN deleted_at DATETIME'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE notifications ADD COLUMN archive_expires_at DATETIME'); } catch { /* column exists */ }
db.exec(`
CREATE INDEX IF NOT EXISTS idx_notif_trash ON notifications(deleted_at);
CREATE INDEX IF NOT EXISTS idx_notif_expiry ON notifications(archive_expires_at);
`);

/* ---- Free trials (automatic on upgrade + admin-granted) ----
   Mirrors migrations/2026-09-01-user-trials.sql. */
try { db.exec('ALTER TABLE users ADD COLUMN trial_started_at DATETIME'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN trial_expires_at DATETIME'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN trial_days INTEGER'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN subscription_status TEXT'); } catch { /* column exists */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_users_trial ON users(trial_expires_at)');

/* ---- OAuth identities (Google / LinkedIn) ----
   Mirrors migrations/2026-09-01-oauth-providers.sql. */
try { db.exec('ALTER TABLE users ADD COLUMN provider TEXT'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN provider_id TEXT'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT'); } catch { /* column exists */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id)');

require('./lib/blogseed').seedBlog(db);

/* ---- Advertising (Sponsored Content) + FirmLedger careers ---- */
db.exec(`
CREATE TABLE IF NOT EXISTS ad_packages (
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

CREATE TABLE IF NOT EXISTS careers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  role_type TEXT NOT NULL DEFAULT 'Full-time',
  location TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  requirements TEXT NOT NULL DEFAULT '',
  apply_email TEXT NOT NULL DEFAULT 'careers@firmledger.co.ke',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_careers_status ON careers(status);
`);

/* Listing sponsorship (advertised / sponsored content) columns. */
try { db.exec("ALTER TABLE listings ADD COLUMN sponsored INTEGER NOT NULL DEFAULT 0"); } catch { /* column exists */ }
try { db.exec("ALTER TABLE listings ADD COLUMN sponsored_expires_at TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
try { db.exec("ALTER TABLE listings ADD COLUMN ad_reference TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
/* A payment can buy account Pro (kind='pro') OR spot advertising (kind='ad'). */
try { db.exec("ALTER TABLE payments ADD COLUMN kind TEXT NOT NULL DEFAULT 'pro'"); } catch { /* column exists */ }

/* Seed the default sponsored-advert packages on a fresh boot (admin can edit/add more). */
if (!db.prepare('SELECT id FROM ad_packages LIMIT 1').get()) {
  const ins = db.prepare('INSERT INTO ad_packages (name, blurb, price_cents, currency, duration_days, active, sort) VALUES (?,?,?,?,?,1,?)');
  ins.run('Featured Spotlight — 7 days', 'Your listing appears in the homepage Sponsored Content strip with a clear “Sponsored” label for one week.', 1500, 'USD', 7, 1);
  ins.run('Featured Spotlight — 30 days', 'A full month of homepage Sponsored Content placement — best value for launches and seasonal pushes.', 4000, 'USD', 30, 2);
  ins.run('Featured Spotlight — 90 days', 'A quarter of Sponsored Content placement across the homepage for brand awareness.', 9500, 'USD', 90, 3);
}

/* ---- Ops: spam lists, SMTP failover accounts, promo codes ---- */
db.exec(`
CREATE TABLE IF NOT EXISTS spam_ip (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  value TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'block',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(value, kind)
);
CREATE TABLE IF NOT EXISTS spam_domain (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  value TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'block',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(value, kind)
);
CREATE TABLE IF NOT EXISTS smtp_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'custom',
  label TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 587,
  secure INTEGER NOT NULL DEFAULT 0,
  username TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  daily_limit INTEGER NOT NULL DEFAULT 0,
  sent_today INTEGER NOT NULL DEFAULT 0,
  sent_on TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  last_error_at TEXT NOT NULL DEFAULT '',
  last_ok_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS promo_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  percent INTEGER NOT NULL DEFAULT 0,
  plan_id INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 0,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  promo_id INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(promo_id, user_id)
);
`);
try { db.exec('ALTER TABLE payments ADD COLUMN promo_id INTEGER NOT NULL DEFAULT 0'); } catch { /* column exists */ }
try { db.exec('ALTER TABLE payments ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0'); } catch { /* column exists */ }

/* ---- Public status page: monitored components, incidents, subscribers ----
   Mirrors migrations/2026-09-01-status-page.sql so existing deployments can
   apply the same DDL against a live database without a full re-seed. */
db.exec(`
CREATE TABLE IF NOT EXISTS status_components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'operational',
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS component_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  component_id INTEGER NOT NULL REFERENCES status_components(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_status_hist_component ON component_status_history(component_id, checked_at);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'investigating',
  severity TEXT NOT NULL DEFAULT 'minor',
  component_id INTEGER REFERENCES status_components(id) ON DELETE SET NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_component ON incidents(component_id);
CREATE INDEX IF NOT EXISTS idx_incidents_created ON incidents(created_at DESC);

CREATE TABLE IF NOT EXISTS incident_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_incident_updates_incident ON incident_updates(incident_id, id);

CREATE TABLE IF NOT EXISTS status_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  verified INTEGER NOT NULL DEFAULT 1,
  verification_token TEXT NOT NULL DEFAULT '',
  subscribed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/* Status monitor keeps history tidy — anything older than 90 days is noise. */
try { db.exec('DELETE FROM component_status_history WHERE checked_at < datetime(\'now\', \'-90 days\')'); } catch { /* ignore */ }

/* ---- AI Playground: audit, moderation decisions, pending tool calls ---- */
db.exec(`
CREATE TABLE IF NOT EXISTS ai_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  listing_id INTEGER,
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_audit_created ON ai_audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS ai_moderation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER,
  listing_name TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_mod_listing ON ai_moderation_log(listing_id);
CREATE INDEX IF NOT EXISTS idx_ai_mod_created ON ai_moderation_log(created_at DESC);

CREATE TABLE IF NOT EXISTS ai_pending_actions (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '{}',
  messages TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_chat_user ON ai_chat_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_chat_active ON ai_chat_sessions(is_active);
CREATE INDEX IF NOT EXISTS idx_ai_chat_archived ON ai_chat_sessions(archived, archived_at);

CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_chat_msgs_session ON ai_chat_messages(session_id, created_at DESC);
`);

/* AI Playground chat transcript columns — mirrors
   migrations/2026-09-01-ai-playground-chat.sql so existing deployments
   pick them up at boot. model/tool/ok let the assistant's action results
   be replayed in the transcript exactly as they happened. */
try { db.exec("ALTER TABLE ai_chat_messages ADD COLUMN model TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
try { db.exec("ALTER TABLE ai_chat_messages ADD COLUMN tool TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
try { db.exec("ALTER TABLE ai_chat_messages ADD COLUMN ok INTEGER NOT NULL DEFAULT 1"); } catch { /* column exists */ }
try { db.exec("ALTER TABLE ai_chat_sessions ADD COLUMN last_message_at TEXT NOT NULL DEFAULT ''"); } catch { /* column exists */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_owner ON ai_chat_sessions(user_id, archived, updated_at DESC)'); } catch { /* ignore */ }

/* AI Playground admin assistant no longer stores chat history. Purge legacy
   transcripts once so old conversations cannot reappear after this deploy. */
try {
  const done = db.prepare('SELECT value FROM settings WHERE key = ?').get('ai_chat_history_removed_v20260902');
  if (!done) {
    db.exec('DELETE FROM ai_chat_messages; DELETE FROM ai_chat_sessions;');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('ai_chat_history_removed_v20260902', new Date().toISOString());
  }
} catch (e) {
  console.error('[db] failed to purge legacy AI chat history:', e.message);
}

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
