/** Relationship graph data (founders, investors, parents, products…). */
const { db } = require('../db');
const { slugify } = require('./util');

const REL_TYPES = [
  { value: 'founder',        label: 'Founder' },
  { value: 'investor',       label: 'Investor' },
  { value: 'parent_company', label: 'Parent company' },
  { value: 'subsidiary',     label: 'Subsidiary' },
  { value: 'product',        label: 'Product' },
  { value: 'service',        label: 'Service' },
  { value: 'partner',        label: 'Partner' },
];

/** Label used on the receiving side of a relationship. */
const INVERSE_LABEL = {
  founder: 'Founded by them',
  investor: 'Portfolio of',
  parent_company: 'Subsidiary of',
  subsidiary: 'Parent of',
  product: 'Made by',
  service: 'Provided by',
  partner: 'Partner',
};

const relLabel = (v) => {
  const t = REL_TYPES.find((r) => r.value === v);
  return t ? t.label : INVERSE_LABEL[v] || v.replace(/_/g, ' ');
};

/** Resolve a free-text target to an approved listing when possible (dedupe). */
function resolveTarget(text) {
  const name = String(text || '').trim().slice(0, 120);
  if (!name) return { error: 'Enter a company, product or person name.' };
  const hit = db.prepare("SELECT * FROM listings WHERE name = ? COLLATE NOCASE AND status='approved'").get(name);
  if (hit) return { target_listing_id: hit.id, target_name: hit.name, slug: hit.slug };
  const slugHit = db.prepare("SELECT * FROM listings WHERE slug = ? AND status='approved'").get(slugify(name));
  if (slugHit) return { target_listing_id: slugHit.id, target_name: slugHit.name, slug: slugHit.slug };
  return { target_listing_id: null, target_name: name };
}

function addRelationship(listingId, relType, targetText, note = '') {
  if (!REL_TYPES.some((r) => r.value === relType)) return { error: 'Choose a valid relationship type.' };
  const t = resolveTarget(targetText);
  if (t.error) return t;
  if (t.target_listing_id === listingId) return { error: 'A listing cannot be related to itself.' };

  // dedupe: same listing + type + same target (by id or normalized name)
  const existing = db.prepare(
    `SELECT id FROM relationships WHERE listing_id = ? AND rel_type = ?
       AND (target_listing_id = ? OR lower(target_name) = lower(?))`
  ).get(listingId, relType, t.target_listing_id || -1, t.target_name);
  if (existing) return { error: 'That relationship already exists.' };

  db.prepare('INSERT INTO relationships (listing_id, rel_type, target_listing_id, target_name, note) VALUES (?,?,?,?,?)')
    .run(listingId, relType, t.target_listing_id, t.target_name, String(note || '').trim().slice(0, 200));
  return { ok: true };
}

function removeRelationship(relId, listingId = null) {
  if (listingId) {
    db.prepare('DELETE FROM relationships WHERE id = ? AND listing_id = ?').run(relId, listingId);
  } else {
    db.prepare('DELETE FROM relationships WHERE id = ?').run(relId);
  }
}

/** Graph payload for the profile page: center node + radial neighbors. */
function buildGraph(listing) {
  const out = db.prepare(
    `SELECT r.*, l.slug AS t_slug, l.name AS t_name, l.type AS t_type, l.claimed AS t_claimed
     FROM relationships r LEFT JOIN listings l ON l.id = r.target_listing_id
     WHERE r.listing_id = ?`
  ).all(listing.id);

  const incoming = db.prepare(
    `SELECT r.*, l.slug AS s_slug, l.name AS s_name, l.type AS s_type, l.claimed AS s_claimed
     FROM relationships r JOIN listings l ON l.id = r.listing_id
     WHERE r.target_listing_id = ? AND r.listing_id <> ?`
  ).all(listing.id, listing.id);

  const seen = new Set();
  const items = [];
  const pushItem = (key, item) => { if (!seen.has(key)) { seen.add(key); items.push(item); } };

  for (const r of out) {
    const name = r.t_slug ? r.t_name : r.target_name;
    pushItem(`${r.rel_type}|${name.toLowerCase()}`, {
      relId: r.id,
      name,
      slug: r.t_slug || null,
      type: r.t_type || null,
      claimed: Boolean(r.t_claimed),
      rel: r.rel_type,
      relLabel: relLabel(r.rel_type),
      direction: 'out',
      note: r.note,
    });
  }
  for (const r of incoming) {
    pushItem(`${r.rel_type}|${r.s_name.toLowerCase()}`, {
      relId: r.id,
      name: r.s_name,
      slug: r.s_slug,
      type: r.s_type,
      claimed: Boolean(r.s_claimed),
      rel: r.rel_type,
      relLabel: (r.rel_type === 'partner') ? 'Partner' : INVERSE_LABEL[r.rel_type] || relLabel(r.rel_type),
      direction: 'in',
      note: r.note,
    });
  }

  return {
    center: { name: listing.name, slug: listing.slug, type: listing.type, claimed: Boolean(listing.claimed) },
    items,
  };
}

module.exports = { REL_TYPES, relLabel, addRelationship, removeRelationship, buildGraph };
