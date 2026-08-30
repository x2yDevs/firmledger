/**
 * FirmLedger API service layer — listings CRUD.
 * Single code path used by the REST routes (/api/v1) and the dashboard
 * playground, so what you test is exactly what the API does.
 */
const { db } = require('../db');
const { TYPES, SIZES } = require('./taxonomy');
const catLib = require('./categories');
const { SOCIAL_KEYS } = require('./socialicons');
const { slugify, normalizeUrl, parseComma, isEmail, domainOf, siteUrl } = require('./util');

class ApiServiceError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}

const LIMITS = { name: 60, tagline: [20, 90], description: [100, 1200] };

function fail(status, code, message, details) { throw new ApiServiceError(status, code, message, details); }

/* ---------- field parsing / validation (writes) ---------- */
function parseFields(body, { partial = false, existing = {} } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail(400, 'invalid_body', 'Send a JSON object, e.g. {"name":"Acme Ltd", ...}');
  }
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (partial) {
    const unknown = Object.keys(body).filter((k) => !FIELD_KEYS.includes(k));
    if (unknown.length) fail(422, 'unknown_fields', 'These fields are not writable: ' + unknown.join(', ') + '. Writable: ' + FIELD_KEYS.join(', ') + '.');
    if (!Object.keys(body).length && Object.keys(existing).length) fail(422, 'empty_update', 'Provide at least one writable field to update.');
  }
  const f = {};
  const errors = [];

  const name = has('name') ? String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, LIMITS.name) : (partial ? existing.name : '');
  const tagline = has('tagline') ? String(body.tagline || '').trim().replace(/\s+/g, ' ') : (partial ? existing.tagline : '');
  const description = has('description') ? String(body.description || '').trim() : (partial ? existing.description : '');
  const website = has('website') ? normalizeUrl(String(body.website || '')) : (partial ? existing.website : '');
  const country = has('country') ? String(body.country || '').trim().slice(0, 60) : (partial ? existing.country : '');

  if (!partial || has('name') || has('tagline') || has('description') || has('website') || has('country')) {
    if (!name || name.length < 2) errors.push({ field: 'name', message: 'Required, 2–60 characters.' });
    if (tagline.length < LIMITS.tagline[0] || tagline.length > LIMITS.tagline[1]) errors.push({ field: 'tagline', message: `Required, ${LIMITS.tagline[0]}–${LIMITS.tagline[1]} characters — a proper one-liner.` });
    if (description.length < LIMITS.description[0] || description.length > LIMITS.description[1]) errors.push({ field: 'description', message: `Required, ${LIMITS.description[0]}–${LIMITS.description[1]} characters — real substance, not a slogan.` });
    if (!website) errors.push({ field: 'website', message: 'Required — a full URL, e.g. https://acme.com. It powers verification.' });
    if (!country) errors.push({ field: 'country', message: 'Required, e.g. Kenya.' });
  }

  if (has('type')) {
    if (TYPES.some((t) => t.value === body.type)) f.type = body.type;
    else errors.push({ field: 'type', message: 'Must be one of: ' + TYPES.map((t) => t.value).join(', ') + '.' });
  }
  if (has('size')) {
    if (body.size === '' || SIZES.includes(body.size)) f.size = body.size;
    else errors.push({ field: 'size', message: 'Must be one of: ' + ['', ...SIZES].join(', ') + '.' });
  }
  if (has('founded')) {
    const v = String(body.founded || '').trim().slice(0, 12);
    if (v && !/^\d{4}(-\d{2})?$/.test(v)) errors.push({ field: 'founded', message: 'A year, e.g. 2021, or year-month like 2021-07.' });
    else f.founded = v;
  }
  if (has('email')) {
    const v = String(body.email || '').trim();
    if (v && !isEmail(v)) errors.push({ field: 'email', message: 'Must be a valid email address (or empty).' });
    else f.email = v;
  }
  if (has('category')) {
    const v = String(body.category || '').trim();
    if (!v) errors.push({ field: 'category', message: 'Provide an existing category name.' });
    else f.category = v;
  }
  if (has('logo_url')) f.logo_url = normalizeUrl(String(body.logo_url || ''));
  if (has('phone')) f.phone = String(body.phone || '').trim().slice(0, 40);
  if (has('city')) f.city = String(body.city || '').trim().slice(0, 80);
  if (has('region')) f.region = String(body.region || '').trim().slice(0, 80);
  if (has('address')) f.address = String(body.address || '').trim().slice(0, 160);
  if (has('tags')) {
    f.tags = Array.isArray(body.tags)
      ? body.tags.map((t) => String(t).trim()).filter(Boolean).join(', ').slice(0, 160)
      : parseComma(String(body.tags || '')).slice(0, 160);
  }
  if (has('socials')) {
    const socials = {};
    if (body.socials && typeof body.socials === 'object' && !Array.isArray(body.socials)) {
      for (const k of SOCIAL_KEYS) {
        const v = String(body.socials[k] || '').trim();
        if (v) socials[k] = normalizeUrl(v);
      }
      const unknownSocial = Object.keys(body.socials).filter((k) => !SOCIAL_KEYS.includes(k));
      if (unknownSocial.length) errors.push({ field: 'socials', message: 'Unknown social keys: ' + unknownSocial.join(', ') + '. Allowed: ' + SOCIAL_KEYS.join(', ') + '.' });
    } else if (body.socials !== undefined && body.socials !== '' && !(body.socials && typeof body.socials === 'object')) {
      errors.push({ field: 'socials', message: 'Send an object, e.g. {"website":"","x":"https://x.com/acme"}.' });
    }
    f.socials = JSON.stringify(socials);
  }

  // Core fields that survived validation are taken over.
  f.name = name; f.tagline = tagline; f.description = description; f.website = website; f.country = country;
  if (errors.length) fail(422, 'validation_failed', 'Some fields need attention.', { errors });

  // Category: resolve through the shared taxonomy (must exist in the site tree).
  if (has('category') || !partial) {
    const catName = f.category !== undefined ? f.category : (partial ? existing.category : 'Other');
    const cat = catLib.ensure(catName || 'Other');
    f.category = cat.name;
  }
  return f;
}

const FIELD_KEYS = ['name', 'tagline', 'description', 'type', 'category', 'website', 'email', 'phone', 'country', 'city', 'region', 'address', 'logo_url', 'founded', 'size', 'tags', 'socials'];

function uniqueSlug(base) {
  let slug = slugify(base).slice(0, 70) || 'record';
  let n = 1, candidate = slug;
  while (db.prepare('SELECT 1 FROM listings WHERE slug=?').get(candidate)) {
    n += 1;
    candidate = `${slug}-${n}`;
  }
  return candidate;
}

function duplicateGuard({ name, website }, excludeId = null) {
  const domain = domainOf(website);
  const params = [];
  let sql = 'SELECT id, slug, name, website FROM listings WHERE (lower(name) = lower(?)';
  params.push(name);
  if (domain) { sql += ' OR website LIKE ?'; params.push('%' + domain + '%'); }
  sql += ')';
  if (excludeId) { sql += ' AND id != ?'; params.push(excludeId); }
  sql += ' LIMIT 1';
  const dup = db.prepare(sql).get(...params);
  if (dup) {
    fail(409, 'duplicate_listing', `A record for this name or domain already exists (slug "${dup.slug}"). Update it with PUT /api/v1/listings/${dup.id} if you own it.`, { existing: { id: dup.id, slug: dup.slug } });
  }
}

/* ---------- serialization ---------- */
function serialize(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    type: row.type,
    category: row.category,
    website: row.website,
    email: row.email,
    phone: row.phone,
    country: row.country,
    city: row.city,
    region: row.region,
    address: row.address,
    logo_url: row.logo_url,
    founded: row.founded,
    size: row.size,
    tags: row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    socials: (() => { try { return JSON.parse(row.socials || '{}'); } catch { return {}; } })(),
    status: row.status,
    claimed: !!row.claimed,
    confidence: row.confidence,
    url: siteUrl('/listing/' + row.slug),
    last_verified_at: row.last_verified_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/* ---------- CRUD ---------- */
function listMine(user, { page = 1, per_page = 20, status = '' } = {}) {
  page = Math.max(1, parseInt(page, 10) || 1);
  per_page = Math.min(50, Math.max(1, parseInt(per_page, 10) || 20));
  const clauses = ['owner_user_id = ?'];
  const params = [user.id];
  if (status) {
    if (!['pending', 'approved', 'rejected'].includes(status)) fail(422, 'invalid_filter', 'status must be pending, approved or rejected.');
    clauses.push('status = ?'); params.push(status);
  }
  const where = 'WHERE ' + clauses.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM listings ${where}`).get(...params).c;
  const rows = db.prepare(`SELECT * FROM listings ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, per_page, (page - 1) * per_page);
  return {
    data: rows.map(serialize),
    meta: { page, per_page, total, total_pages: Math.max(1, Math.ceil(total / per_page)) },
  };
}

function getOwned(user, id) {
  id = parseInt(id, 10);
  if (!Number.isFinite(id) || id < 1) fail(404, 'not_found', 'No listing with that id on your account.');
  const row = db.prepare('SELECT * FROM listings WHERE id=?').get(id);
  if (!row || row.owner_user_id !== user.id) fail(404, 'not_found', 'No listing with that id on your account.');
  return row;
}

function createListing(user, body) {
  const f = parseFields(body, { partial: false });
  duplicateGuard(f);
  const slug = uniqueSlug(f.name);
  const info = db.prepare(`INSERT INTO listings
    (slug, name, tagline, description, type, category, website, email, phone, country, city, region, address, logo_url, founded, size, tags, socials, sources, status, featured, claimed, confidence, owner_user_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, '[]', 'pending', 0, 1, 0, ?)`)
    .run(slug, f.name, f.tagline, f.description, f.type || 'company', f.category, f.website, f.email || '', f.phone || '', f.country, f.city || '', f.region || '', f.address || '', f.logo_url || '', f.founded || '', f.size || '', f.tags || '', f.socials || '{}', user.id);
  const row = db.prepare('SELECT * FROM listings WHERE id=?').get(info.lastInsertRowid);
  return { status: 201, body: { data: serialize(row), meta: { note: 'Created with status "pending" — it goes live after the usual moderation pass, exactly like listings added from the dashboard.' } } };
}

function updateListing(user, id, body) {
  const row = getOwned(user, id);
  const f = parseFields(body, { partial: true, existing: row });
  duplicateGuard({ name: f.name ?? row.name, website: f.website ?? row.website }, row.id);
  const cols = FIELD_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(f, k));
  const setSql = cols.map((c) => `${c}=?`).join(', ');
  const vals = cols.map((c) => f[c]);
  db.prepare(`UPDATE listings SET ${setSql ? setSql + ',' : ''} updated_at=datetime('now') WHERE id=?`).run(...vals, row.id);
  const fresh = db.prepare('SELECT * FROM listings WHERE id=?').get(row.id);
  return { status: 200, body: { data: serialize(fresh), meta: { note: 'Updated. Metadata edits re-enter moderation review if the core record changed.' } } };
}

function deleteListing(user, id) {
  const row = getOwned(user, id);
  const tx = db.transaction(() => {
    for (const t of ['listing_events', 'jobs', 'favorites', 'removal_requests', 'payments']) {
      db.prepare(`DELETE FROM ${t} WHERE listing_id=?`).run(row.id);
    }
    db.prepare('DELETE FROM relationships WHERE listing_id=? OR target_listing_id=?').run(row.id, row.id);
    db.prepare('DELETE FROM listings WHERE id=?').run(row.id);
  });
  tx();
  return { status: 204, body: null };
}

module.exports = {
  ApiServiceError, LIMITS, FIELD_KEYS,
  parseFields, serialize, listMine, getOwned, createListing, updateListing, deleteListing,
};
