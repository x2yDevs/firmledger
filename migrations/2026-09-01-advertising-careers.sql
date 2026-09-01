-- Advertising (Sponsored Content) + FirmLedger careers.
-- Mirrors the CREATE/ALTER statements in src/db.js so existing deployments
-- can run this file against a live database without a full re-seed.

-- Sponsored-advert packages that users buy to place a listing on the homepage
-- Sponsored Content strip. Admin → Advertising manages these.
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

-- Careers: FirmLedger's own open roles (admin-managed). Public /careers page.
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

-- Listing sponsorship columns.
ALTER TABLE listings ADD COLUMN sponsored INTEGER NOT NULL DEFAULT 0;
ALTER TABLE listings ADD COLUMN sponsored_expires_at TEXT NOT NULL DEFAULT '';
ALTER TABLE listings ADD COLUMN ad_reference TEXT NOT NULL DEFAULT '';

-- A payment can buy account Pro (kind='pro') OR spot advertising (kind='ad').
ALTER TABLE payments ADD COLUMN kind TEXT NOT NULL DEFAULT 'pro';
