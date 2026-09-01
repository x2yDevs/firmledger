/**
 * FirmLedger careers — the company's own open roles.
 *
 * Admin manages openings from Admin → Careers. The public /careers page lists
 * them cleanly; when there are none it says "we are not hiring" and still
 * offers a mailto to careers@firmledger.co.ke. Every opening feeds the RSS
 * feed and the sitemap.
 */
const { db } = require('../db');
const { siteUrl, escHtml } = require('./util');

const ROLE_TYPES = ['Full-time', 'Part-time', 'Contract', 'Internship', 'Remote'];

function listOpen() {
  return db.prepare(
    "SELECT * FROM careers WHERE status='open' ORDER BY created_at DESC"
  ).all();
}
function listAll() {
  return db.prepare('SELECT * FROM careers ORDER BY created_at DESC').all();
}
function get(id) {
  return db.prepare('SELECT * FROM careers WHERE id=?').get(Number(id) || 0) || null;
}

/** Validate + insert a role. Returns { ok, errors?, id? }. */
function create(fields) {
  const t = String(fields.title || '').trim().slice(0, 140);
  const type = ROLE_TYPES.includes(fields.role_type) ? fields.role_type : 'Full-time';
  const loc = String(fields.location || '').trim().slice(0, 120);
  const desc = String(fields.description || '').trim().slice(0, 4000);
  const reqs = String(fields.requirements || '').trim().slice(0, 4000);
  const email = (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(fields.apply_email || '')))
    ? String(fields.apply_email).trim().slice(0, 200) : 'careers@firmledger.co.ke';
  if (t.length < 3) return { ok: false, errors: ['Give the role a proper title (3+ characters).'] };
  if (!loc) return { ok: false, errors: ['Location is required — a city or “Remote”.'] };
  if (desc.length < 20) return { ok: false, errors: ['Add at least 20 characters describing the role.'] };
  if (reqs.length < 10) return { ok: false, errors: ['List the key requirements (at least 10 characters).'] };
  const info = db.prepare(
    'INSERT INTO careers (title, role_type, location, description, requirements, apply_email, status) VALUES (?,?,?,?,?,?,?)'
  ).run(t, type, loc, desc, reqs, email, fields.status === 'closed' ? 'closed' : 'open');
  return { ok: true, id: info.lastInsertRowid, errors: [] };
}

/** Update an existing role. */
function update(id, fields) {
  const cur = get(id);
  if (!cur) return { ok: false, errors: ['That role no longer exists.'] };
  const t = fields.title !== undefined ? String(fields.title).trim().slice(0, 140) : cur.title;
  const type = fields.role_type !== undefined ? (ROLE_TYPES.includes(fields.role_type) ? fields.role_type : cur.role_type) : cur.role_type;
  const loc = fields.location !== undefined ? String(fields.location).trim().slice(0, 120) : cur.location;
  const desc = fields.description !== undefined ? String(fields.description).trim().slice(0, 4000) : cur.description;
  const reqs = fields.requirements !== undefined ? String(fields.requirements).trim().slice(0, 4000) : cur.requirements;
  const email = fields.apply_email !== undefined
    ? (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(fields.apply_email || '')) ? String(fields.apply_email).trim().slice(0, 200) : cur.apply_email)
    : cur.apply_email;
  if (t.length < 3) return { ok: false, errors: ['Give the role a proper title (3+ characters).'] };
  if (!loc) return { ok: false, errors: ['Location is required.'] };
  if (desc.length < 20) return { ok: false, errors: ['Add at least 20 characters describing the role.'] };
  if (reqs.length < 10) return { ok: false, errors: ['List the key requirements.'] };
  db.prepare(
    "UPDATE careers SET title=?, role_type=?, location=?, description=?, requirements=?, apply_email=?, status=?, updated_at=datetime('now') WHERE id=?"
  ).run(t, type, loc, desc, reqs, email, fields.status === 'closed' ? 'closed' : 'open', cur.id);
  return { ok: true, id: cur.id, errors: [] };
}

function toggleStatus(id) {
  const cur = get(id);
  if (!cur) return null;
  db.prepare("UPDATE careers SET status = CASE status WHEN 'open' THEN 'closed' ELSE 'open' END, updated_at=datetime('now') WHERE id=?")
    .run(cur.id);
  return get(id);
}

function remove(id) {
  return db.prepare('DELETE FROM careers WHERE id=?').run(Number(id) || 0).changes > 0;
}

/** A pre-filled mailto: draft to careers@firmledger.co.ke for a role. */
function applyMailto(role) {
  const r = role || {};
  const subject = `Application — ${r.title || 'Open role'} at FirmLedger`;
  const lines = [
    `Hi FirmLedger careers team,`,
    ``,
    `I'd like to apply for the ${r.title || 'open role'}${r.location ? ` (${r.location})` : ''}.`,
    ``,
    `My name is: `,
    `My email is: `,
    `My LinkedIn / portfolio: `,
    ``,
    `A short note on why I'm a good fit:`,
    ``,
    `Thanks,`,
    `— `,
  ];
  return `mailto:${r.apply_email || 'careers@firmledger.co.ke'}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
}

/* RSS: roles appended to the main /feed.xml channel. */
function feedItems() {
  try {
    return listOpen().map((c) => ({
      title: `Hiring: ${c.title} (${c.location})`,
      link: siteUrl('/careers#role-' + c.id),
      date: new Date(c.updated_at || c.created_at),
      desc: escHtml((c.description || '').replace(/<[^>]+>/g, ' ').slice(0, 200)),
      cat: 'Careers',
    }));
  } catch { return []; }
}

module.exports = {
  ROLE_TYPES, listOpen, listAll, get, create, update, toggleStatus, remove, applyMailto, feedItems,
};
