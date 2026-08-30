/**
 * Categories live in the DB so users can create new ones — with strict
 * dedupe (slug/case-insensitive) so "Fintech", "fintech " and "FinTech"
 * can never branch into three categories.
 */
const { db } = require('../db');
const { slugify } = require('./util');

function all() {
  return db.prepare('SELECT * FROM categories ORDER BY official DESC, name ASC').all();
}

function bySlug(slug) {
  return db.prepare('SELECT * FROM categories WHERE slug = ?').get(slug);
}

function withCounts() {
  return db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM listings l WHERE l.category = c.name AND l.status='approved') AS cnt
     FROM categories c ORDER BY cnt DESC, c.name ASC`
  ).all();
}

/**
 * Resolve user input to a canonical category name.
 * Existing match (any case/spacing) → reuse. Novel name → create unofficial.
 */
function ensure(rawName) {
  const name = String(rawName || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) return { name: 'Other', created: false };

  const exact = db.prepare('SELECT * FROM categories WHERE name = ? COLLATE NOCASE').get(name);
  if (exact) return { name: exact.name, created: false };

  let slug = slugify(name);
  const clash = db.prepare('SELECT * FROM categories WHERE slug = ?').get(slug);
  if (clash) return { name: clash.name, created: false };

  let n = 2;
  const base = slug;
  while (db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug)) slug = `${base}-${n++}`;
  db.prepare('INSERT INTO categories (name, slug, official) VALUES (?,?,0)').run(name, slug);
  return { name, created: true };
}

function usageCount(name) {
  return db.prepare('SELECT COUNT(*) c FROM listings WHERE category = ?').get(name).c;
}

module.exports = { all, bySlug, withCounts, ensure, usageCount };
