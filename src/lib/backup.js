/**
 * FirmLedger user backup & export.
 *
 * .firmledger files are plain JSON (UTF-8), pretty-printed so the records line up
 * column wise and remain human-auditable. Two files share the one format:
 *   - "Export users"   → the core user rows (details + plan + status).
 *   - "Backup"         → a complete, restore-ready snapshot of the whole console:
 *                        every user, EVERY LISTING with all of its configuration
 *                        (plan/boost, sponsorship, featured + claim state, socials,
 *                        sources, tags, jobs, relationships, owner email) and every
 *                        admin configuration record — settings, categories, plans,
 *                        promos, advertising packages, careers, protection rules,
 *                        status components, blog posts and the rest of the ledger.
 * Password hashes are included — an account keeps working after an identity restore.
 * One-time credentials and sessions are excluded for safety.
 * Importing validates the format header, merges users by email, merges listings by
 * slug, and restores configuration table by table (upsert on each table's natural
 * key). Nothing is silently deleted.
 */
const multer = require('multer');
const { db } = require('../db');

const FORMAT = 'firmledger-backup@2';

/* Tables that make up the admin configuration and ledger. Transient credentials and
   one-time tokens are intentionally excluded; they are never needed to restore the
   application and should not travel in a downloadable file. */
const BACKUP_EXCLUDED_TABLES = new Set(['sessions', 'resets', 'reg_otps', 'user_totp']);
function databaseSnapshot() {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const snapshot = {};
  for (const table of tables) {
    if (BACKUP_EXCLUDED_TABLES.has(table.name)) continue;
    snapshot[table.name] = {
      schema: table.sql,
      rows: db.prepare(`SELECT * FROM "${table.name.replace(/"/g, '""')}"`).all(),
    };
  }
  return snapshot;
}

const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/** multipart field middleware — parses the single uploaded .firmledger file into req.file. */
function backupField(field = 'backup_file') {
  const single = memUpload.single(field);
  return (req, res, next) => {
    single(req, res, (err) => {
      if (err) {
        req.uploadError = err.code === 'LIMIT_FILE_SIZE'
          ? 'Backup file is too large — the limit is 25 MB.'
          : err.message;
      }
      next();
    });
  };
}

function userRows() {
  return db.prepare(
    'SELECT id, name, email, password_hash, plan, plan_expires_at, suspended, created_at FROM users ORDER BY id ASC'
  ).all();
}

function pad(v, w) { return String(v ?? '').padEnd(w, ' '); }

/** Aligned per-user block for the export file. */
function exportUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    password_hash: u.password_hash,
    plan: u.plan,
    plan_expires_at: u.plan_expires_at,
    suspended: u.suspended,
    created_at: u.created_at,
  };
}

/** "Export users" — core account details for every user. */
function buildExport() {
  const users = userRows().map(exportUser);
  return JSON.stringify({
    format: FORMAT,
    kind: 'user-export',
    generated_at: new Date().toISOString(),
    app: 'FirmLedger',
    count: users.length,
    users,
  }, null, 2);
}

/* ------------------------------------------------------------------ *
 * Listings + configuration sections
 * ------------------------------------------------------------------ */

function tableExists(name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function safeAll(sql, ...params) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}
function columnsOf(table) {
  try { return db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all(); } catch { return []; }
}

/**
 * Every listing with its complete configuration, spelled out in the file rather
 * than only living inside the raw table dump. The owner is carried by e-mail so
 * a restore can re-attach the listing even when user ids shift.
 */
function listingRecords() {
  const listings = safeAll('SELECT * FROM listings ORDER BY id ASC');
  const emailById = new Map(safeAll('SELECT id, email FROM users').map((u) => [u.id, u.email]));
  return listings.map((l) => ({
    ...l,
    owner_email: l.owner_user_id ? (emailById.get(l.owner_user_id) || null) : null,
    submitter_email: l.submitter_user_id ? (emailById.get(l.submitter_user_id) || null) : null,
    configuration: {
      status: l.status,
      category: l.category,
      type: l.type,
      featured: l.featured,
      claimed: l.claimed,
      sponsored: l.sponsored,
      sponsored_until: l.sponsored_until,
      plan: l.plan,
      plan_expires_at: l.plan_expires_at,
      verified_badge: l.verified_badge,
      last_verified_at: l.last_verified_at,
      socials: l.socials,
      sources: l.sources,
      tags: l.tags,
    },
    jobs: safeAll('SELECT * FROM jobs WHERE listing_id = ? ORDER BY id ASC', l.id),
    relationships: safeAll('SELECT * FROM relationships WHERE listing_id = ? ORDER BY id ASC', l.id),
  }));
}

/** Human-readable configuration section: what the console is set to right now. */
function configurationSection() {
  const settings = {};
  for (const row of safeAll('SELECT key, value FROM settings ORDER BY key ASC')) settings[row.key] = row.value;
  return {
    settings,
    categories: safeAll('SELECT * FROM categories ORDER BY name ASC'),
    plans: safeAll('SELECT * FROM plans ORDER BY sort ASC, id ASC'),
    promo_codes: safeAll('SELECT * FROM promo_codes ORDER BY id ASC'),
    ad_packages: safeAll('SELECT * FROM ad_packages ORDER BY id ASC'),
    careers: safeAll('SELECT * FROM careers ORDER BY id ASC'),
    blog_posts: safeAll('SELECT * FROM blog_posts ORDER BY id ASC'),
    protection: {
      ip_rules: safeAll('SELECT * FROM spam_ip ORDER BY id ASC'),
      domain_rules: safeAll('SELECT * FROM spam_domain ORDER BY id ASC'),
    },
    status: {
      components: safeAll('SELECT * FROM status_components ORDER BY id ASC'),
      incidents: safeAll('SELECT * FROM incidents ORDER BY id ASC'),
    },
    newsletter_subscribers: safeAll('SELECT * FROM newsletter_subscribers ORDER BY id ASC'),
  };
}

/** "Backup" — everything about every user, restore-ready. */
function buildBackup() {
  const users = userRows().map((u) => {
    const listings = db.prepare(
      'SELECT * FROM listings WHERE owner_user_id = ? ORDER BY id ASC'
    ).all(u.id);
    const claims = db.prepare(
      'SELECT id, listing_id, method, domain, status, created_at FROM claims WHERE user_id = ? ORDER BY id ASC'
    ).all(u.id);
    const tickets = db.prepare(
      'SELECT id, ref, subject, category, status, created_at, updated_at FROM tickets WHERE user_id = ? ORDER BY id ASC'
    ).all(u.id);
    const payments = db.prepare(
      'SELECT id, listing_id, plan_id, duration_days, order_id, reference, amount, currency, status, channel, email, created_at, paid_at FROM payments WHERE user_id = ? ORDER BY id ASC'
    ).all(u.id);
    const totp = db.prepare('SELECT enabled, enabled_at FROM user_totp WHERE user_id = ?').get(u.id);
    return { ...exportUser(u), twofa: totp ? { enabled: totp.enabled, enabled_at: totp.enabled_at } : null, listings, claims, tickets, payments };
  });
  return JSON.stringify({
    format: FORMAT,
    kind: 'full-backup',
    generated_at: new Date().toISOString(),
    app: 'FirmLedger',
    count: users.length,
    counts: {
      users: users.length,
      listings: db.prepare('SELECT COUNT(*) c FROM listings').get().c,
      categories: db.prepare('SELECT COUNT(*) c FROM categories').get().c,
      settings: db.prepare('SELECT COUNT(*) c FROM settings').get().c,
    },
    users,
    /* Every listing in the ledger with its full configuration — not only the
       listings that happen to belong to a registered user. */
    listings: listingRecords(),
    /* The console's configuration, readable without parsing the raw dump. */
    configuration: configurationSection(),
    /* Complete ledger/config snapshot, table by table: the authoritative copy
       used by Import to rebuild the console after a loss. */
    database: databaseSnapshot(),
  }, null, 2);
}

/* ------------------------------------------------------------------ *
 * Restore engine — listings + configuration
 * ------------------------------------------------------------------ */

/* Never restored from a file: identities are merged separately by e-mail, and
   credentials/sessions are not in the file to begin with. */
const RESTORE_SKIP_TABLES = new Set([
  'users', 'sessions', 'resets', 'reg_otps', 'user_totp',
  'ai_pending_actions', 'sqlite_sequence',
]);

/* Restored first so that rows referencing them resolve. */
const RESTORE_ORDER = ['settings', 'categories', 'plans', 'listings'];

/** The single-column natural key of a table (slug, email, code, key…), if any. */
function naturalKey(table) {
  const cols = columnsOf(table);
  const pk = cols.filter((c) => c.pk);
  if (pk.length === 1 && pk[0].name !== 'id') return pk[0].name;
  let indexes = [];
  try { indexes = db.prepare(`PRAGMA index_list("${table.replace(/"/g, '""')}")`).all(); } catch { indexes = []; }
  for (const idx of indexes) {
    if (!idx.unique) continue;
    let info = [];
    try { info = db.prepare(`PRAGMA index_info("${String(idx.name).replace(/"/g, '""')}")`).all(); } catch { info = []; }
    if (info.length === 1 && info[0].name && info[0].name !== 'id') return info[0].name;
  }
  return null;
}

function quote(id) { return `"${String(id).replace(/"/g, '""')}"`; }

/**
 * Restore one table's rows.
 *  - a table with a natural key (slug / code / email / key) is upserted on it;
 *  - a keyless ledger table is matched on the whole row, so a record is inserted
 *    only when an identical one is not already there. Repeating an import can
 *    therefore never duplicate history or the seeded defaults.
 * `remap` rewrites foreign keys (user ids, listing ids) onto this database.
 */
function restoreTable(table, rows, remap, stats) {
  if (!Array.isArray(rows) || !rows.length) return;
  if (!tableExists(table)) { stats.skippedTables.push(table); return; }
  const liveCols = columnsOf(table);
  const liveNames = new Set(liveCols.map((c) => c.name));
  const notNull = new Set(liveCols.filter((c) => c.notnull && c.dflt_value === null && c.name !== 'id').map((c) => c.name));
  const key = naturalKey(table);
  const idMap = new Map();

  const find = key ? db.prepare(`SELECT * FROM ${quote(table)} WHERE ${quote(key)} = ?`) : null;

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = {};
    let drop = false;
    for (const [col, val] of Object.entries(raw)) {
      if (!liveNames.has(col) || col === 'id') continue;
      let v = val;
      if (/(^|_)user_id$/.test(col)) {
        v = v == null ? null : (remap.users.get(Number(v)) ?? null);
        if (v == null && notNull.has(col)) { drop = true; break; }
      } else if (/(^|_)listing_id$/.test(col)) {
        v = v == null ? null : (remap.listings.get(Number(v)) ?? null);
        if (v == null && notNull.has(col)) { drop = true; break; }
      } else if (v !== null && typeof v === 'object') {
        v = JSON.stringify(v);
      } else if (typeof v === 'boolean') {
        v = v ? 1 : 0;
      }
      row[col] = v;
    }
    if (drop || !Object.keys(row).length) { stats.skippedRows++; continue; }

    let existing = null;
    if (key && row[key] !== undefined) {
      existing = find.get(row[key]);
    } else {
      /* Keyless table: an identical row already present counts as restored. */
      const cols = Object.keys(row);
      const where = cols.map((c) => (row[c] === null ? `${quote(c)} IS NULL` : `${quote(c)} = ?`)).join(' AND ');
      const params = cols.filter((c) => row[c] !== null).map((c) => row[c]);
      try { existing = db.prepare(`SELECT * FROM ${quote(table)} WHERE ${where} LIMIT 1`).get(...params) || null; }
      catch { existing = null; }
      if (existing) {
        if (raw.id !== undefined && existing.id !== undefined) idMap.set(Number(raw.id), Number(existing.id));
        stats.unchanged++;
        continue;
      }
    }

    if (existing) {
      const sets = Object.keys(row).filter((c) => c !== key);
      if (sets.length) {
        db.prepare(`UPDATE ${quote(table)} SET ${sets.map((c) => `${quote(c)} = ?`).join(', ')} WHERE ${quote(key)} = ?`)
          .run(...sets.map((c) => row[c]), row[key]);
      }
      if (raw.id !== undefined && existing.id !== undefined) idMap.set(Number(raw.id), Number(existing.id));
      stats.updated++;
    } else {
      const cols = Object.keys(row);
      const info = db.prepare(
        `INSERT INTO ${quote(table)} (${cols.map(quote).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      ).run(...cols.map((c) => row[c]));
      if (raw.id !== undefined) idMap.set(Number(raw.id), Number(info.lastInsertRowid));
      stats.created++;
    }
  }
  stats.tables.push(table);
  if (table === 'listings') for (const [k, v] of idMap) remap.listings.set(k, v);
}

/**
 * Rebuild listings + configuration from a full backup file.
 * `remap.users` is the email-derived old-id → new-id map produced while the
 * user rows were merged, so ownership survives a restore into a fresh database.
 */
function restoreSnapshot(doc, remap) {
  const stats = { created: 0, updated: 0, unchanged: 0, skippedRows: 0, tables: [], skippedTables: [] };
  const snapshot = (doc && doc.database && typeof doc.database === 'object') ? doc.database : null;

  /* Build the table → rows map, preferring the authoritative raw snapshot and
     falling back to the readable sections for hand-edited files. */
  const byTable = new Map();
  if (snapshot) {
    for (const [table, payload] of Object.entries(snapshot)) {
      const rows = payload && Array.isArray(payload.rows) ? payload.rows : (Array.isArray(payload) ? payload : null);
      if (rows) byTable.set(table, rows);
    }
  }
  if (!byTable.has('listings') && Array.isArray(doc.listings)) {
    byTable.set('listings', doc.listings.map((l) => {
      const { configuration, jobs, relationships, owner_email: ownerEmail, submitter_email: subEmail, ...rest } = l;
      return { ...rest, ...(configuration || {}) };
    }));
  }
  const cfg = doc && doc.configuration;
  if (cfg && typeof cfg === 'object') {
    if (!byTable.has('settings') && cfg.settings && typeof cfg.settings === 'object') {
      byTable.set('settings', Object.entries(cfg.settings).map(([key, value]) => ({ key, value: String(value) })));
    }
    const fallbacks = {
      categories: cfg.categories, plans: cfg.plans, promo_codes: cfg.promo_codes,
      ad_packages: cfg.ad_packages, careers: cfg.careers, blog_posts: cfg.blog_posts,
      newsletter_subscribers: cfg.newsletter_subscribers,
      spam_ip: cfg.protection && cfg.protection.ip_rules,
      spam_domain: cfg.protection && cfg.protection.domain_rules,
      status_components: cfg.status && cfg.status.components,
      incidents: cfg.status && cfg.status.incidents,
    };
    for (const [table, rows] of Object.entries(fallbacks)) {
      if (!byTable.has(table) && Array.isArray(rows) && rows.length) byTable.set(table, rows);
    }
  }
  if (!byTable.size) return null; // users-only export — nothing else to restore

  /* Owner e-mails let a listing find its user even when the raw ids changed. */
  const listingRows = byTable.get('listings');
  if (Array.isArray(listingRows) && Array.isArray(doc.listings)) {
    const ownerBySlug = new Map(doc.listings.map((l) => [l.slug, l]));
    for (const row of listingRows) {
      const rich = ownerBySlug.get(row.slug);
      if (!rich) continue;
      if (rich.owner_email) {
        const id = db.prepare('SELECT id FROM users WHERE email = ?').get(String(rich.owner_email).toLowerCase());
        if (id) remap.users.set(Number(row.owner_user_id), id.id);
      }
      if (rich.submitter_email) {
        const id = db.prepare('SELECT id FROM users WHERE email = ?').get(String(rich.submitter_email).toLowerCase());
        if (id && row.submitter_user_id != null) remap.users.set(Number(row.submitter_user_id), id.id);
      }
    }
  }

  const ordered = [
    ...RESTORE_ORDER.filter((t) => byTable.has(t)),
    ...[...byTable.keys()].filter((t) => !RESTORE_ORDER.includes(t)).sort(),
  ];

  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    for (const table of ordered) {
      if (RESTORE_SKIP_TABLES.has(table)) continue;
      restoreTable(table, byTable.get(table), remap, stats);
    }
  });
  try { tx(); } finally { db.pragma('foreign_keys = ON'); }
  return stats;
}

/**
 * Import a .firmledger file. Merges by email:
 * existing accounts get their details updated (password_hash kept unless the file
 * carries one), new accounts are inserted with the file's password hash so their
 * original login keeps working.
 *
 * When the file is a full backup it ALSO restores the ledger and the console
 * configuration: every listing (merged by slug, ownership re-attached by owner
 * e-mail), categories, plans, promos, advertising packages, careers, blog posts,
 * protection rules, status components and every saved setting. Nothing is deleted
 * — existing records are updated in place and missing ones are recreated.
 */
function importUsers(text) {
  let doc;
  try { doc = JSON.parse(text); }
  catch { return { ok: false, error: 'That file is not valid JSON — upload the .firmledger file that the export produced.' }; }
  if (!doc || doc.format !== FORMAT || !Array.isArray(doc.users)) {
    return { ok: false, error: 'That file is not a FirmLedger export/backup — the format header did not match. Re-download the file from the admin console.' };
  }
  let created = 0; let updated = 0; let skipped = 0;
  const userMap = new Map();
  const find = db.prepare('SELECT id, password_hash FROM users WHERE email = ?');
  const ins = db.prepare('INSERT INTO users (email, password_hash, name, plan, plan_expires_at, suspended, created_at) VALUES (?,?,?,?,?,?,?)');
  const upd = db.prepare('UPDATE users SET name = ?, password_hash = ?, plan = ?, plan_expires_at = ?, suspended = ? WHERE email = ?');
  const tx = db.transaction((rows) => {
    for (const u of rows) {
      const email = String(u.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { skipped++; continue; }
      const name = String(u.name || '').trim().slice(0, 80) || email.split('@')[0];
      const plan = u.plan === 'pro' ? 'pro' : 'free';
      const planExp = String(u.plan_expires_at || '').slice(0, 40);
      const suspended = u.suspended ? 1 : 0;
      const existing = find.get(email);
      const hash = typeof u.password_hash === 'string' && u.password_hash.length > 10 ? u.password_hash : null;
      if (existing) {
        upd.run(name, hash || existing.password_hash, plan, planExp, suspended, email);
        if (u.id !== undefined) userMap.set(Number(u.id), existing.id);
        updated++;
      } else {
        if (!hash) { skipped++; continue; } // cannot invent a credential — skip accounts with no hash
        const info = ins.run(email, hash, name, plan, planExp, suspended, String(u.created_at || '').slice(0, 40) || new Date().toISOString());
        if (u.id !== undefined) userMap.set(Number(u.id), Number(info.lastInsertRowid));
        created++;
      }
    }
  });
  try { tx(doc.users); }
  catch (e) { return { ok: false, error: 'Import failed mid-flight: ' + e.message + ' — the database was left unchanged.' }; }

  /* Second pass: the ledger and the console configuration. */
  let restore = null;
  try {
    restore = restoreSnapshot(doc, { users: userMap, listings: new Map() });
  } catch (e) {
    return {
      ok: true, created, updated, skipped, total: doc.users.length,
      kind: doc.kind || 'user-export', generatedAt: doc.generated_at || '',
      restore: null,
      restoreError: 'Accounts were restored, but the listings/configuration restore stopped: ' + e.message,
    };
  }

  return {
    ok: true, created, updated, skipped, total: doc.users.length,
    kind: doc.kind || 'user-export', generatedAt: doc.generated_at || '',
    restore,
  };
}

/** Permanently delete a user and everything personally attributable to their account. */
function deleteUserCascade(userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) return { ok: false, error: 'User not found.' };
  const tx = db.transaction(() => {
    // Their listings come off their name — the business record stays in the ledger
    db.prepare('UPDATE listings SET owner_user_id = NULL, claimed = 0 WHERE owner_user_id = ?').run(userId);
    db.prepare('UPDATE listings SET submitter_user_id = NULL WHERE submitter_user_id = ?').run(userId);
    // Personal data, gone for good
    db.prepare('DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE user_id = ?)').run(userId);
    db.prepare('DELETE FROM tickets WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM resets WHERE email = ?').run(u.email);
    db.prepare('DELETE FROM reg_otps WHERE email = ?').run(u.email);
    db.prepare('DELETE FROM user_totp WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM claims WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM payments WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM deletion_requests WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM pro_transfer_requests WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM favorites WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });
  try { tx(); }
  catch (e) { return { ok: false, error: 'Delete failed: ' + e.message + ' — the account was left intact.' }; }
  return { ok: true, email: u.email, name: u.name };
}

/* ------- admin recovery codes (same model as user 2FA) ------- */
const crypto = require('crypto');
function genAdminRecoveryCodes(n = 10) {
  const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const mk = () => {
    const raw = Array.from(crypto.randomBytes(15)).map((b) => alpha[b % 32]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  };
  return Array.from({ length: n }, mk);
}
function hashAdminCode(code) {
  return crypto.createHash('sha256').update(String(code).toUpperCase().replace(/\s/g, '')).digest('hex');
}
/** verify() → { ok, remaining } — chews the matching unused code. */
function verifyAdminRecovery(code) {
  const raw = String(code || '').trim();
  if (!/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(raw)) return { ok: false };
  let list = [];
  try { list = JSON.parse(require('../db').getSetting('admin_recovery_codes', '[]')); } catch {}
  const h = hashAdminCode(raw);
  const idx = list.findIndex((c) => c.h === h && !c.used);
  if (idx < 0) return { ok: false };
  list[idx].used = 1;
  require('../db').setSetting('admin_recovery_codes', JSON.stringify(list));
  return { ok: true, remaining: list.filter((c) => !c.used).length };
}

module.exports = {
  FORMAT, backupField, buildExport, buildBackup, importUsers, deleteUserCascade,
  listingRecords, configurationSection, restoreSnapshot,
  genAdminRecoveryCodes, hashAdminCode, verifyAdminRecovery,
};
