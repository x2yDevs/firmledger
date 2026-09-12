/**
 * FirmLedger — seed a no-login preview of the Leads inbox.
 *
 *   node scripts/seed-leads-preview.js
 *
 * Creates (idempotently — re-running resets the preview rows only):
 *   • demo@firmledger.test — a Pro owner whose inbox is shown in the preview;
 *   • visitor@firmledger.test — a member who sent one of the inquiries;
 *   • two claimed listings and three inquiries with a two-day thread, so the
 *     inbox has counts, a status mix and day separators to look at.
 *
 * Then start the server with the preview flag and open the inbox:
 *
 *   LEADS_INBOX_PREVIEW=1 node server.js        →  /dashboard/leads, then press
 *                                                  an inquiry to open its page
 *
 * The flag is the only gate (src/routes/dashboard.js): unsigned-in browsers
 * are shown the page as the demo owner, signed-in browsers always win.
 *
 * Only the demo/visitor rows are touched — nothing else in the database is.
 */
const { db } = require('../src/db');
const bcrypt = require('bcryptjs');

const PREVIEW_EMAILS = ['demo@firmledger.test', 'visitor@firmledger.test'];
const SLUGS = ['demo-cleaners', 'demo-print'];

/* ── reset any previous preview data, innermost first ─────────────────────── */
const previewLeadIds = db.prepare(
  `SELECT l.id FROM leads l
   JOIN users u ON u.id = l.owner_user_id
   WHERE u.email IN ('demo@firmledger.test', 'visitor@firmledger.test')`
).all().map((r) => r.id);
if (previewLeadIds.length) {
  const q = db.prepare('DELETE FROM lead_messages WHERE lead_id = ?');
  for (const id of previewLeadIds) q.run(id);
}
db.prepare(`DELETE FROM leads WHERE owner_user_id IN
  (SELECT id FROM users WHERE email IN ('demo@firmledger.test','visitor@firmledger.test'))`).run();
db.prepare(`DELETE FROM listings WHERE owner_user_id IN
  (SELECT id FROM users WHERE email IN ('demo@firmledger.test','visitor@firmledger.test'))`).run();
db.prepare(`DELETE FROM lead_drafts WHERE user_id IN
  (SELECT id FROM users WHERE email IN ('demo@firmledger.test','visitor@firmledger.test'))`).run();
db.prepare('DELETE FROM users WHERE email = ? OR email = ?').run(PREVIEW_EMAILS[0], PREVIEW_EMAILS[1]);

/* ── people ───────────────────────────────────────────────────────────────── */
const owner = db.prepare(
  "INSERT INTO users(email, password_hash, name, plan, plan_expires_at, leads_digest) VALUES (?,?,?,'pro','2099-01-01','both')"
).run('demo@firmledger.test', bcrypt.hashSync('DemoOwner!2026', 10), 'Demo Owner').lastInsertRowid;
const visitor = db.prepare(
  "INSERT INTO users(email, password_hash, name, leads_digest) VALUES (?,?,?,'both')"
).run('visitor@firmledger.test', bcrypt.hashSync('DemoVisitor!2026', 10), 'Amina Njeri').lastInsertRowid;

/* ── claimed listings ─────────────────────────────────────────────────────── */
const cleaners = db.prepare(
  "INSERT INTO listings(slug, name, tagline, description, category, country, city, website, email, status, claimed, owner_user_id) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)"
).run(
  'demo-cleaners', 'Demo Cleaners',
  'Offices that look after themselves.',
  'A verified Nairobi cleaning company for offices, apartments and handovers. Monthly plans, deep cleans and everything in between — quote within a day.',
  'Cleaning Services', 'Kenya', 'Nairobi', 'https://demo.example', 'hello@demo.example', 'approved', owner
).lastInsertRowid;
const print = db.prepare(
  "INSERT INTO listings(slug, name, tagline, description, category, country, city, website, email, status, claimed, owner_user_id) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)"
).run(
  'demo-print', 'Demo Print Co',
  'Print that walks in ahead of you.',
  'Flyers, business cards, banners and large-format work. Same-week turnaround for most orders, free quote before you commit.',
  'Printing & Design', 'Kenya', 'Nairobi', 'https://demo-print.example', 'print@demo.example', 'approved', owner
).lastInsertRowid;

/* ── inquiries + threads (mirrors what leads.create() writes) ─────────────── */
function makeLead(listingId, inquirerUserId, lead, at) {
  const r = db.prepare(
    `INSERT INTO leads (listing_id, owner_user_id, inquirer_user_id, name, email, phone, looking_for, message, city, country, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    listingId, owner, inquirerUserId, lead.name, lead.email, lead.phone,
    lead.looking_for, lead.message, 'Nairobi', 'Kenya', lead.status, at.created, at.updated
  );
  const id = Number(r.lastInsertRowid);
  const msg = db.prepare('INSERT INTO lead_messages (lead_id, sender, body, created_at) VALUES (?,?,?,?)');
  for (const m of lead.messages) msg.run(id, m.sender, m.body, m.at);
  return id;
}

/* New inquiry with a two-day thread — the one the preview opens on. */
const openLead = makeLead(cleaners, visitor, {
  name: 'Amina Njeri', email: 'amina@example.com', phone: '+254 700 123 456',
  looking_for: 'Monthly office cleaning', status: 'new',
  message: 'Hello! We need a monthly office clean for a 12-desk floor in Westlands — could you quote?',
  messages: [
    { sender: 'inquirer', at: '2026-09-10 09:12:00', body: 'Hello! We need a monthly office clean for a 12-desk floor in Westlands — could you quote?' },
    { sender: 'owner', at: '2026-09-10 10:05:00', body: 'Happy to — a twelve-desk clean is KES 24,000/month, materials included.' },
    { sender: 'inquirer', at: '2026-09-11 08:15:00', body: 'Great.\nCan we start on Monday?' },
    { sender: 'owner', at: '2026-09-11 08:50:00', body: 'Monday works fine & we bring everything. See you then!' },
  ],
}, { created: '2026-09-10 09:12:00', updated: '2026-09-11 08:50:00' });

/* Contacted inquiry on the second listing. */
makeLead(print, null, {
  name: 'Daniel Otieno', email: 'daniel@example.com', phone: '',
  looking_for: '500 flyers, A5 full colour', status: 'contacted',
  message: 'We want to print 500 flyers, A5, full colour. What would that cost and how long?',
  messages: [
    { sender: 'inquirer', at: '2026-09-09 14:02:00', body: 'We want to print 500 flyers, A5, full colour. What would that cost and how long?' },
    { sender: 'owner', at: '2026-09-09 15:30:00', body: 'KES 6,500 for 500 A5 flyers — three working days, free proof first.' },
  ],
}, { created: '2026-09-09 14:02:00', updated: '2026-09-09 15:30:00' });

/* Won deep-clean inquiry. */
makeLead(cleaners, null, {
  name: 'Grace Wanjiru', email: 'grace@example.com', phone: '+254 711 987 654',
  looking_for: 'Deep clean before handover', status: 'won',
  message: 'Our office needs a full deep clean before the handover next week — can you handle it?',
  messages: [
    { sender: 'inquirer', at: '2026-09-08 11:20:00', body: 'Our office needs a full deep clean before the handover next week — can you handle it?' },
    { sender: 'owner', at: '2026-09-08 12:00:00', body: 'Yes — KES 18,000 for the full floor, done in a day. Shall I book you in?' },
    { sender: 'inquirer', at: '2026-09-08 12:30:00', body: 'Booked. Thursday morning works best.' },
  ],
}, { created: '2026-09-08 11:20:00', updated: '2026-09-08 12:30:00' });

console.log('Leads inbox preview seeded:');
console.log('  owner    demo@firmledger.test (Pro)');
console.log('  listings Demo Cleaners, Demo Print Co');
console.log('  leads    1 new (open thread), 1 contacted, 1 won');
console.log('');
console.log('Start it and open the inbox without signing in:');
console.log('  LEADS_INBOX_PREVIEW=1 node server.js');
console.log('  → /dashboard/leads   (press an inquiry to open /dashboard/leads/' + openLead + ')');
