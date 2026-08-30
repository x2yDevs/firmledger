const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, getSetting } = require('../db');
const { requireUser, validCsrf } = require('../lib/session');
const { TYPES, SIZES, COUNTRIES } = require('../lib/taxonomy');
const catLib = require('../lib/categories');
const graphLib = require('../lib/graph');
const { SOCIAL_KEYS } = require('../lib/socialicons');
const { fetchSiteDetails } = require('../lib/enrich');
const { deleteLogo } = require('../lib/upload');
const {
  slugify, normalizeUrl, parseComma, confidenceScore, isEmail, domainOf, siteUrl, escHtml,
} = require('../lib/util');
const { sendBranded } = require('../lib/mailer');
const user2fa = require('../lib/user2fa');
const support = require('../lib/support');
const { detectTech } = require('../lib/enrich');
const { firmledgerScore } = require('../lib/score');
const passwords = require('../lib/passwords');
const { submitForIndexing } = require('../lib/indexing');
const { isProUser, perksActive, allPlans } = require('../lib/plans');
const nl = require('../lib/newsletter');
const paypal = require('../lib/paypal');

const router = express.Router();
router.use('/dashboard', requireUser);

const LIMITS = {
  name: 60, tagline: [20, 90], description: [100, 1200],
};

function formLocals(req, extra = {}) {
  return {
    l: {}, errors: [], TYPES, SIZES, COUNTRIES,
    allCats: catLib.all(),
    REL_TYPES: graphLib.REL_TYPES,
    LIMITS,
    ...extra,
  };
}

function collectListingFields(body) {
  const socials = {};
  for (const k of SOCIAL_KEYS) {
    const v = (body[`social_${k}`] || '').trim();
    if (v) socials[k] = normalizeUrl(v);
  }
  const category = catLib.ensure(body.category);
  return {
    name: (body.name || '').trim().replace(/\s+/g, ' ').slice(0, LIMITS.name),
    tagline: (body.tagline || '').trim().replace(/\s+/g, ' '),
    description: (body.description || '').trim(),
    type: TYPES.some((t) => t.value === body.type) ? body.type : 'company',
    category: category.name,
    categoryCreated: category.created,
    website: normalizeUrl(body.website || ''),
    email: isEmail(body.email) ? body.email.trim() : '',
    phone: (body.phone || '').trim().slice(0, 40),
    country: (body.country || '').trim().slice(0, 60),
    city: (body.city || '').trim().slice(0, 80),
    region: (body.region || '').trim().slice(0, 80),
    address: (body.address || '').trim().slice(0, 160),
    logo_url: normalizeUrl(body.logo_url || ''),
    remove_logo: body.remove_logo === '1',
    founded: (body.founded || '').trim().slice(0, 12),
    size: SIZES.includes(body.size) ? body.size : '',
    tags: parseComma(body.tags || '').slice(0, 160),
    socials: JSON.stringify(socials),
  };
}

function validate(f, excludeId = null) {
  const errors = [];
  if (f.name.length < 2) errors.push('Listing name is required (minimum 2 characters).');
  if (f.tagline.length < LIMITS.tagline[0]) errors.push(`Tagline must be at least ${LIMITS.tagline[0]} characters — a proper one-liner.`);
  if (f.tagline.length > LIMITS.tagline[1]) errors.push(`Tagline is limited to ${LIMITS.tagline[1]} characters for a uniform directory.`);
  if (f.description.length < LIMITS.description[0]) errors.push(`Description must be at least ${LIMITS.description[0]} characters — real substance, not a slogan.`);
  if (f.description.length > LIMITS.description[1]) errors.push(`Description is limited to ${LIMITS.description[1]} characters.`);
  if (!f.website) errors.push('Website is required — it powers verification and auto-fill.');
  if (!f.country) errors.push('Country is required.');
  if (f.founded && !/^\d{4}(-\d{2})?$/.test(f.founded)) errors.push('Founded must be a year, e.g. 2021.');
  return errors;
}

/**
 * Duplicate guard — same name OR same website domain, regardless of whether
 * the record was fetched from Wikipedia or typed in by hand. The duplicate is
 * never created twice; the submitter is sent to claim the existing record.
 */
function findDuplicate(f, excludeId = null) {
  const byName = f.name
    ? db.prepare('SELECT id, slug, name FROM listings WHERE name = ? COLLATE NOCASE').get(f.name)
    : null;
  if (byName && byName.id !== excludeId) return { ...byName, how: 'name' };
  const dom = domainOf(f.website);
  if (dom) {
    const bySite = db.prepare(
      'SELECT id, slug, name FROM listings WHERE lower(website) LIKE ?'
    ).get(`%${dom}%`);
    if (bySite && bySite.id !== excludeId) return { ...bySite, how: 'website' };
  }
  return null;
}

/* ---------------- Auto-fill from website ---------------- */
router.post('/dashboard/fetch-details', async (req, res) => {
  const result = await fetchSiteDetails(req.body.website || '');
  res.json(result);
});

/* ---------------- Dashboard home ---------------- */
router.get('/dashboard', (req, res) => {
  const listings = db.prepare('SELECT * FROM listings WHERE owner_user_id = ? ORDER BY created_at DESC').all(req.user.id);
  const claims = db.prepare(
    `SELECT c.*, l.name AS listing_name, l.slug AS listing_slug
     FROM claims c JOIN listings l ON l.id = c.listing_id
     WHERE c.user_id = ? ORDER BY c.created_at DESC`
  ).all(req.user.id);
  const claimable = db.prepare(
    "SELECT slug, name FROM listings WHERE status='approved' AND claimed=0 ORDER BY name LIMIT 200"
  ).all();
  // real per-listing health scores
  const socialsOf = (l) => { try { return JSON.parse(l.socials || '{}'); } catch { return {}; } };
  const scores = {};
  for (const l of listings) {
    const sc = firmledgerScore(l, {
      sources: (() => { try { return JSON.parse(l.sources || '[]'); } catch { return []; } })(),
      events: db.prepare('SELECT id FROM listing_events WHERE listing_id=?').all(l.id),
      relations: db.prepare('SELECT id FROM relationships WHERE listing_id=?').all(l.id),
      tech: (() => { try { return JSON.parse(l.tech || '[]'); } catch { return []; } })(),
      socials: socialsOf(l),
    });
    scores[l.id] = { score: sc.score, missing: MISSING_HINTS.find(([k]) => !l[k] && !(k === 'socials' && Object.keys(socialsOf(l)).length)) };
  }
  const plans = {};
  for (const l of listings) plans[l.id] = { perks: perksActive(l) };
  res.render('dashboard/index', {
    meta: { title: 'Dashboard — FirmLedger', description: '', robots: 'noindex' },
    listings, claims, claimable, scores, plans,
    accountPro: isProUser(req.user),
    accountExpires: req.user.plan_expires_at || '',
    paypalReady: paypal.configured(),
    fa2On: user2fa.enabled(req.user.id),
    ok: req.query.ok || req.query.okmsg || '', err: req.query.err || '',
  });
});

const MISSING_HINTS = [
  ['logo_url', 'Add a logo'], ['founded', 'Add the founding year'], ['city', 'Add the city'],
  ['email', 'Add a public email'], ['tags', 'Add tags'], ['size', 'Add the team size'],
  ['phone', 'Add a phone number'], ['socials', 'Add social profiles'], ['description', 'Complete the description'],
];

/* ---------------- Account settings ---------------- */
router.post('/dashboard/account', (req, res) => {
  if (!validCsrf(req)) return res.status(403).redirect('/dashboard');
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!name || !isEmail(email)) {
    return res.redirect('/dashboard?err=' + encodeURIComponent('Name and a valid email are required.'));
  }
  const clash = db.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').get(email, req.user.id);
  if (clash) return res.redirect('/dashboard?err=' + encodeURIComponent('That email is already used by another account.'));
  const oldEmail = req.user.email;
  db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name, email, req.user.id);
  if (user2fa.enabled(req.user.id)) {
    const v = user2fa.verifySensitive(req.user.id, req.body.fa_code);
    if (!v.ok) return res.redirect('/dashboard?err=' + encodeURIComponent(v.error + ' (Security settings)'));
  }
  if (email !== oldEmail) {
    // notify BOTH addresses — a confirmed email change is a security event
    const base = (t) => ({
      kicker: 'Security notice',
      title: 'Your account email was changed',
      preheader: 'The email address on your FirmLedger account was changed.',
      alert: `The email on your FirmLedger account was changed from <b>${escHtml(oldEmail)}</b> to <b>${escHtml(email)}</b>. All notifications now go to the new address.`,
      alertTone: 'info',
      paragraphs: t,
      cta: { label: 'Review your account', url: siteUrl('/dashboard') },
      note: 'If you did not make this change, contact <a href="mailto:support@firmledger.co.ke" style="color:#1D4ED8;">support@firmledger.co.ke</a> immediately.',
    });
    sendBranded(oldEmail, 'Your FirmLedger email address was changed',
      base([`You're receiving this at your previous address because it was just removed from your account. If you made this change, no action is needed — future mail goes to the new address.`])).catch(() => {});
    sendBranded(email, 'Your FirmLedger email address was changed',
      base(['This address is now attached to your FirmLedger account. Security events, receipts and product updates will arrive here from now on.'])).catch(() => {});
  }
  res.redirect('/dashboard?ok=' + encodeURIComponent('Account details updated.'));
});

router.post('/dashboard/password', (req, res) => {
  if (!validCsrf(req)) return res.status(403).redirect('/dashboard');
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!row || !passwords.verify(current, row.password_hash)) {
    return res.redirect('/dashboard?err=' + encodeURIComponent('Current password did not match.'));
  }
  if (next.length < 8) {
    return res.redirect('/dashboard?err=' + encodeURIComponent('New password must be at least 8 characters.'));
  }
  if (String(req.body.new_password_confirm || '') !== next) {
    return res.redirect('/dashboard?err=' + encodeURIComponent('The two passwords do not match. Retype them carefully.'));
  }
  if (user2fa.enabled(req.user.id)) {
    const v = user2fa.verifySensitive(req.user.id, req.body.fa_code);
    if (!v.ok) return res.redirect('/dashboard?err=' + encodeURIComponent(v.error + ' (Security settings)'));
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwords.hash(next), req.user.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'user' AND token <> ?").run(req.user.id, req.userSession.token);
  sendBranded(req.user.email, 'Your FirmLedger password was changed', {
    kicker: 'Security notice',
    title: 'Your password was changed',
    preheader: 'Your FirmLedger password was changed and other devices were signed out.',
    alert: 'The password for your account was just changed. Other signed-in devices were logged out automatically.',
    alertTone: 'info',
    paragraphs: [
      'You made this change from your dashboard. Your current session stays active; everything else was signed out for safety.',
    ],
    cta: { label: 'Review your account', url: siteUrl('/dashboard') },
    note: `If this wasn't you, contact <a href="mailto:support@firmledger.co.ke" style="color:#1D4ED8;">support@firmledger.co.ke</a> immediately.`,
  }).catch(() => {});
  res.redirect('/dashboard?ok=' + encodeURIComponent('Password changed. Other signed-in devices were logged out.'));
});

/* ---------------- New listing ---------------- */
router.get('/dashboard/listings/new', (req, res) => {
  res.render('dashboard/form', {
    meta: { title: 'Submit a listing — FirmLedger', description: '', robots: 'noindex' },
    action: '/dashboard/listings/new', editing: false, relations: [], events: [],
    
    ...formLocals(req),
  });
});

router.post('/dashboard/listings/new', async (req, res) => {
  if (!validCsrf(req)) return res.status(403).redirect('/dashboard/listings/new');
  const f = collectListingFields(req.body);
  const errors = validate(f);
  const dup = findDuplicate(f);

  if (errors.length || dup) {
    if (dup) errors.push(`“${dup.name}” is already on the ledger (${dup.how === 'name' ? 'same name' : 'same website'}). One business, one canonical record — if it's yours, claim the existing record instead.`);
    return res.status(422).render('dashboard/form', {
      meta: { title: 'Submit a listing — FirmLedger', description: '', robots: 'noindex' },
      ...formLocals(req),
      l: f, errors, dupClaim: dup, action: '/dashboard/listings/new', editing: false, relations: [], events: [],
      
    });
  }

  // Logo: uploaded file wins over pasted URL


  let slug = slugify(f.name);
  let n = 2;
  while (db.prepare('SELECT id FROM listings WHERE slug = ?').get(slug)) slug = `${slugify(f.name)}-${n++}`;

  const autoApprove = getSetting('auto_approve', '0') === '1';
  const status = autoApprove ? 'approved' : 'pending';
  const confidence = confidenceScore({ ...f, claimed: 0 });

  // Record enrichment provenance (a real Wikipedia article) when the fetch button was used
  const enrichSource = String(req.body.enrich_source || '').trim();
  const sourcesJson = /^https:\/\/(\w+\.)?wikipedia\.org\/wiki\//.test(enrichSource)
    ? JSON.stringify([enrichSource]) : '[]';

  db.prepare(
    `INSERT INTO listings (slug, name, tagline, description, type, category, website, email, phone,
      country, city, region, address, logo_url, founded, size, tags, socials, sources, status, confidence, owner_user_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(slug, f.name, f.tagline, f.description, f.type, f.category, f.website, f.email, f.phone,
    f.country, f.city, f.region, f.address, f.logo_url, f.founded, f.size, f.tags, f.socials,
    sourcesJson, status, confidence, req.user.id);
  const newId = db.prepare('SELECT id FROM listings WHERE slug = ?').get(slug).id;

  // Technology radar — real signatures detected from the public website (best effort, capped)
  if (f.website) {
    try {
      const snap = await detectTech(f.website);
      db.prepare('UPDATE listings SET tech = ?, tech_checked_at = ?, hiring_url = ? WHERE id = ?')
        .run(JSON.stringify(snap.tech), new Date().toISOString().slice(0, 10), (snap.hiring && snap.hiring.url) || '', newId);
    } catch { /* detection is best-effort */ }
  }

  if (status === 'approved') {
    const catSlug = catLib.all().find((c) => c.name === f.category)?.slug;
    submitForIndexing([`/listing/${slug}`, catSlug ? `/directory/c/${catSlug}` : null].filter(Boolean));
  }
  res.redirect('/dashboard?ok=' + encodeURIComponent(
    status === 'approved'
      ? 'Your listing is live and has been submitted to search engines.'
      : 'Listing submitted — our team will review it shortly.'
  ));
});

/* ---------------- Edit listing ---------------- */
function ownListing(req, res, next) {
  if (req.params.id && req.params.id !== String(Number(req.params.id))) return next('route');
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
  if (!l || l.owner_user_id !== req.user.id) {
    return res.status(404).render('error', {
      meta: { title: 'Not found — FirmLedger', description: '', robots: 'noindex' },
      code: 404, heading: 'Listing not found', message: 'This listing does not exist or belongs to another account.',
    });
  }
  req.listing = l;
  next();
}

router.get('/dashboard/listings/:id/edit', ownListing, (req, res) => {
  const l = req.listing;
  let socials = {};
  try { socials = JSON.parse(l.socials); } catch {}
  res.render('dashboard/form', {
    meta: { title: `Edit ${l.name} — FirmLedger`, description: '', robots: 'noindex' },
    l: { ...l, ...Object.fromEntries(Object.entries(socials).map(([k, v]) => [`social_${k}`, v])) },
    errors: [], action: `/dashboard/listings/${l.id}/edit`, editing: true,
    relations: graphLib.buildGraph(l).items,
    events: db.prepare('SELECT * FROM listing_events WHERE listing_id=? ORDER BY event_date ASC').all(l.id),
    
    ...formLocals(req),
  });
});

router.post('/dashboard/listings/:id/edit', ownListing, async (req, res) => {
  if (!validCsrf(req)) return res.status(403).redirect(`/dashboard/listings/${req.listing.id}/edit`);
  const l = req.listing;
  const f = collectListingFields(req.body);
  const errors = validate(f, l.id);
  const dup = findDuplicate(f, l.id);

  if (errors.length || dup) {
    if (dup) errors.push(`“${dup.name}” is already on the ledger (${dup.how === 'name' ? 'same name' : 'same website'}). One business, one canonical record — if it's yours, claim the existing record instead.`);
    return res.status(422).render('dashboard/form', {
      meta: { title: `Edit ${l.name} — FirmLedger`, description: '', robots: 'noindex' },
      ...formLocals(req),
      l: { ...f, id: l.id, slug: l.slug, logo_url: l.logo_url }, errors, dupClaim: dup,
      action: `/dashboard/listings/${l.id}/edit`, editing: true,
      relations: graphLib.buildGraph(l).items,
      events: db.prepare('SELECT * FROM listing_events WHERE listing_id=? ORDER BY event_date ASC').all(l.id),
      
    });
  }

  // Logo handling: remove > pasted URL > keep existing
  if (f.remove_logo) {
    deleteLogo(l.logo_url);
    f.logo_url = '';
  } else if (!f.logo_url) {
    f.logo_url = l.logo_url;
  }

  const confidence = confidenceScore({
    ...f, claimed: l.claimed, last_verified_at: l.last_verified_at, sources: l.sources,
  });
  // Edits to a claimed and approved listing return to the review queue — the
  // owner can change existing details freely, but every change is re-moderated
  // before it goes back public.
  const needsReview = (l.claimed && l.status === 'approved') || l.status === 'rejected';
  db.prepare(
    `UPDATE listings SET name=?, tagline=?, description=?, type=?, category=?, website=?, email=?, phone=?,
      country=?, city=?, region=?, address=?, logo_url=?, founded=?, size=?, tags=?, socials=?, confidence=?,
      status = ?,
      updated_at = datetime('now')
     WHERE id = ?`
  ).run(f.name, f.tagline, f.description, f.type, f.category, f.website, f.email, f.phone,
    f.country, f.city, f.region, f.address, f.logo_url, f.founded, f.size, f.tags, f.socials, confidence,
    needsReview ? 'pending' : l.status, l.id);

  // refresh the technology snapshot whenever the website changed (or none exists yet)
  if (f.website && (f.website !== l.website || !l.tech_checked_at)) {
    try {
      const snap = await detectTech(f.website);
      db.prepare('UPDATE listings SET tech = ?, tech_checked_at = ?, hiring_url = ? WHERE id = ?')
        .run(JSON.stringify(snap.tech), new Date().toISOString().slice(0, 10), (snap.hiring && snap.hiring.url) || '', l.id);
    } catch { /* best-effort */ }
  }
  submitForIndexing([`/listing/${l.slug}`]);

  // watchlist digest — tell everyone starring this listing what changed
  const watchChanges = [];
  const techChanged = f.website !== l.website;
  if (f.size !== l.size && (f.size || l.size)) watchChanges.push(`Team size updated${l.size ? ` from ${escHtml(l.size)}` : ''} to <b>${escHtml(f.size || 'not listed')}</b>`);
  if (f.founded !== l.founded && (f.founded || l.founded)) watchChanges.push(`Founded year changed${l.founded ? ` from ${escHtml(l.founded)}` : ''} to <b>${escHtml(f.founded || 'not listed')}</b>`);
  if (f.city !== l.city || f.country !== l.country) watchChanges.push(`Location updated to <b>${escHtml([f.city, f.country].filter(Boolean).join(', ') || 'not listed')}</b>`);
  if (techChanged) watchChanges.push('Technology stack was re-checked from the website and refreshed');
  if (f.description !== l.description) watchChanges.push('Company description was rewritten');
  if (watchChanges.length) nl.notifyWatchers(l.id, watchChanges).catch(() => {});

  res.redirect(`/dashboard/listings/${l.id}/edit?ok=` + encodeURIComponent(
    needsReview
      ? 'Changes saved — this claimed listing is back in the review queue and republishes after moderation.'
      : 'Listing updated.'
  ));
});

/* ---------------- Refresh technology snapshot (owner) ---------------- */
router.post('/dashboard/listings/:id/refresh-tech', ownListing, async (req, res) => {  const _oldTech = req.listing.tech || '[]';

  const l = req.listing;
  if (!l.website) return res.redirect(`/dashboard/listings/${l.id}/edit?err=` + encodeURIComponent('Add a website first.'));
  const snap = await detectTech(l.website);
  db.prepare('UPDATE listings SET tech = ?, tech_checked_at = ?, hiring_url = ? WHERE id = ?')
    .run(JSON.stringify(snap.tech), new Date().toISOString().slice(0, 10), (snap.hiring && snap.hiring.url) || '', l.id);
  if (JSON.stringify(snap.tech) !== _oldTech && snap.tech.length) {
    nl.notifyWatchers(l.id, [`Technology stack refreshed — <b>${snap.tech.length}</b> technologies now detected (${snap.tech.slice(0, 6).map(escHtml).join(', ')}${snap.tech.length > 6 ? '…' : ''})`]).catch(() => {});
  }
  res.redirect(`/dashboard/listings/${l.id}/edit?ok=` + encodeURIComponent(
    snap.tech.length ? `Technology radar refreshed — ${snap.tech.length} technologies detected.` : 'Website scanned — no recognizable technologies detected yet.'
  ));
});

router.post('/dashboard/listings/:id/delete', ownListing, (req, res) => {
  deleteLogo(req.listing.logo_url);
  db.prepare('DELETE FROM listings WHERE id = ?').run(req.listing.id);
  res.redirect('/dashboard?ok=' + encodeURIComponent('Listing permanently removed.'));
});

/* ---------------- Relationships (owner) ---------------- */
router.post('/dashboard/listings/:id/relations', ownListing, (req, res) => {
  const r = graphLib.addRelationship(req.listing.id, req.body.rel_type, req.body.target, req.body.note);
  res.redirect(`/dashboard/listings/${req.listing.id}/edit?` + (r.error
    ? `err=${encodeURIComponent(r.error)}#relations`
    : `ok=${encodeURIComponent('Relationship added.')}#relations`));
});

router.post('/dashboard/relations/:rid/delete', (req, res) => {
  const rel = db.prepare('SELECT * FROM relationships WHERE id = ?').get(req.params.rid);
  if (!rel) return res.redirect('/dashboard');
  const owner = db.prepare('SELECT owner_user_id FROM listings WHERE id = ?').get(rel.listing_id);
  const isTargetOwner = rel.target_listing_id &&
    db.prepare('SELECT owner_user_id FROM listings WHERE id = ?').get(rel.target_listing_id)?.owner_user_id === req.user.id;
  if (!owner || (owner.owner_user_id !== req.user.id && !isTargetOwner)) {
    return res.redirect('/dashboard');
  }
  graphLib.removeRelationship(rel.id);
  res.redirect(`/dashboard/listings/${rel.listing_id}/edit#relations`);
});

/* ---------------- Timeline events (owner) ---------------- */
router.post('/dashboard/listings/:id/events', ownListing, (req, res) => {
  const title = (req.body.title || '').trim().slice(0, 200);
  const allowed = ['founded', 'funding', 'product', 'leadership', 'acquisition', 'milestone'];
  if (title) {
    db.prepare('INSERT INTO listing_events (listing_id, event_date, kind, title) VALUES (?,?,?,?)')
      .run(req.listing.id, (req.body.event_date || '').trim().slice(0, 12),
        allowed.includes(req.body.kind) ? req.body.kind : 'milestone', title);
  }
  res.redirect(`/dashboard/listings/${req.listing.id}/edit#timeline`);
});

router.post('/dashboard/events/:eid/delete', (req, res) => {
  const e = db.prepare('SELECT * FROM listing_events WHERE id = ?').get(req.params.eid);
  if (e) {
    const owner = db.prepare('SELECT owner_user_id FROM listings WHERE id = ?').get(e.listing_id);
    if (owner && owner.owner_user_id === req.user.id) {
      db.prepare('DELETE FROM listing_events WHERE id = ?').run(e.id);
    }
    return res.redirect(`/dashboard/listings/${e.listing_id}/edit#timeline`);
  }
  res.redirect('/dashboard');
});

/* ---------------- 2FA (two-factor authentication) on the account ---------------- */
router.get('/dashboard/security', requireUser, (req, res) => {
  res.render('dashboard/security', {
    meta: { title: 'Security — FirmLedger', description: '', robots: 'noindex' },
    twoFaOn: user2fa.enabled(req.user.id),
    recoveryLeft: user2fa.recoveryCount(req.user.id),
    pendingSecret: db.prepare('SELECT pending_secret FROM user_totp WHERE user_id = ?').get(req.user.id)
                     ? { secret: null } : null,
    newCodes: null, enroll: null,
  });
});

router.post('/dashboard/security/2fa/start', requireUser, async (req, res) => {
  if (!validCsrf(req)) return res.status(403).redirect('/dashboard/security');
  const secret = user2fa.startEnrollment(req.user.id);
  const uri = user2fa.otpAuthUrl(secret, req.user.email);
  let qr = '';
  try {
    const QRCode = require('qrcode');
    qr = await QRCode.toDataURL(uri, { margin: 1, width: 220, color: { dark: '#0A1628', light: '#FFFFFF' } });
  } catch {}
  res.render('dashboard/security', {
    meta: { title: 'Enable two-factor — FirmLedger', description: '', robots: 'noindex' },
    twoFaOn: user2fa.enabled(req.user.id),
    recoveryLeft: user2fa.recoveryCount(req.user.id),
    pendingSecret: null,
    newCodes: null,
    enroll: { secret, qr, uri },
  });
});

router.post('/dashboard/security/2fa/verify', requireUser, async (req, res) => {
  if (!validCsrf(req)) return res.status(403).redirect('/dashboard/security');
  const code = String(req.body.code || '').replace(/\D/g, '');
  const done = user2fa.completeEnrollment(req.user.id, code);
  if (!done.ok) {
    const secret = db.prepare('SELECT pending_secret FROM user_totp WHERE user_id = ?').get(req.user.id)?.pending_secret || '';
    const uri = user2fa.otpAuthUrl(secret, req.user.email);
    let qr = '';
    try {
      const QRCode = require('qrcode');
      qr = await QRCode.toDataURL(uri, { margin: 1, width: 220, color: { dark: '#0A1628', light: '#FFFFFF' } });
    } catch {}
    return res.render('dashboard/security', {
      meta: { title: 'Enable two-factor — FirmLedger', description: '', robots: 'noindex' },
      twoFaOn: false, recoveryLeft: 0, pendingSecret: null, newCodes: null,
      enroll: { secret, qr, uri, error: done.error },
    });
  }
  sendBranded(req.user.email, 'Two-factor authentication is now ON for your FirmLedger account', {
    kicker: 'Security upgrade',
    title: 'Your account now requires two-factor',
    preheader: 'Two-factor authentication was just enabled on your FirmLedger account.',
    alert: '2FA is now <b>ON</b>. Password and email changes, and security sign-ins, now require your authenticator. Save your recovery codes somewhere safe — they were generated just now.',
    alertTone: 'ok',
    paragraphs: [
      `You have 10 one-time recovery codes, each usable once if the authenticator app is unavailable. They're downloadable from your security page right now and nowhere else — save them offline.`,
    ],
    cta: { label: 'Review security settings', url: siteUrl('/dashboard/security') },
    note: `If this wasn't you, change your password immediately and contact support@firmledger.co.ke.`,
  }).catch(() => {});
  res.render('dashboard/security', {
    meta: { title: 'Recovery codes — FirmLedger', description: '', robots: 'noindex' },
    twoFaOn: true, recoveryLeft: user2fa.recoveryCount(req.user.id), pendingSecret: null, newCodes: done.codes, enroll: null,
  });
});

router.post('/dashboard/security/recovery-codes.txt', requireUser, (req, res) => {
  if (!validCsrf(req)) return res.status(403).redirect('/dashboard/security');
  const codes = String(req.body.codes || '').split(',').map((c) => c.trim()).filter(Boolean);
  if (!codes.length) return res.status(404).send('No recovery codes on this account.');
  const lines = [
    'FirmLedger Recovery Codes',
    '=========================',
    `Account: ${req.user.email}`,
    `Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`,
    '',
    'These one-time codes replace your authenticator app if it is ever unreachable.',
    'Each code works exactly once. Store this file offline — never in your email inbox.',
    '',
    ...codes.map((c, i) => `${String(i + 1).padStart(2, '0')}. ${c}`),
    '',
    '— FirmLedger · https://firmledger.co.ke',
  ];
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="firmledger-recovery-codes.txt"');
  res.send(lines.join('\n'));
});

router.post('/dashboard/security/2fa/disable', requireUser, async (req, res) => {
  if (!validCsrf(req)) return res.status(403).redirect('/dashboard/security');
  const v = user2fa.verifySensitive(req.user.id, req.body.code);
  if (!v.ok) {
    return res.render('dashboard/security', {
      meta: { title: 'Security — FirmLedger', description: '', robots: 'noindex' },
      twoFaOn: true, recoveryLeft: user2fa.recoveryCount(req.user.id), pendingSecret: null, newCodes: null, enroll: null,
      disableErr: v.error,
    });
  }
  user2fa.disable(req.user.id);
  sendBranded(req.user.email, 'Two-factor authentication was turned OFF', {
    kicker: 'Security notice',
    title: '2FA disabled on your account',
    preheader: 'Two-factor authentication has been turned off on your FirmLedger account.',
    alert: `Your account no longer asks for a second factor on sensitive changes. If this wasn't you, secure your account immediately.`,
    alertTone: 'warn',
    paragraphs: [
      'Disabling 2FA lowers your account security. You can turn it back on from your security settings at any time.',
    ],
    cta: { label: 'Review security settings', url: siteUrl('/dashboard/security') },
    note: 'Recovery codes remaining on your account were invalidated at the same time.',
  }).catch(() => {});
  res.redirect('/dashboard/security?ok=' + encodeURIComponent('Two-factor authentication disabled.'));
});

/* ---------------- Support tickets ---------------- */
router.get('/dashboard/support', requireUser, (req, res) => {
  const tickets = db.prepare(
    'SELECT * FROM tickets WHERE user_id = ? ORDER BY updated_at DESC'
  ).all(req.user.id);
  res.render('dashboard/support', {
    meta: { title: 'Support — FirmLedger', description: '', robots: 'noindex' },
    tickets,
    flashMsg: req.query.ok || '',
    openTicketId: null, currentMessages: null, currentTicket: null,
    categories: [...support.CATEGORIES],
  });
});

router.get('/dashboard/support/new', requireUser, (req, res) => {
  res.render('dashboard/support-new', {
    meta: { title: 'New support ticket — FirmLedger', description: '', robots: 'noindex' },
    errors: [], old: {}, categories: [...support.CATEGORIES],
  });
});

router.post('/dashboard/support/new', requireUser, async (req, res) => {
  if (!validCsrf(req)) return res.status(403).redirect('/dashboard/support/new');
  const subject = String(req.body.subject || '').trim().slice(0, 200);
  const category = String(req.body.category || '').trim().toLowerCase();
  const body = String(req.body.body || '').trim();
  const errors = [];
  if (subject.length < 4) errors.push('Give your ticket a subject (a short phrase).');
  if (!support.CATEGORIES.has(category)) errors.push('Pick a category for your ticket.');
  if (body.length < 20) errors.push('Describe your issue in a few sentences (20+ characters).');
  if (errors.length) {
    return res.status(422).render('dashboard/support-new', {
      meta: { title: 'New support ticket — FirmLedger', description: '', robots: 'noindex' },
      errors, old: { subject, category, body }, categories: [...support.CATEGORIES],
    });
  }
  const { id, ref } = support.openTicket(req.user.id, subject, category, body, '', '');
  // branded acknowledgement to the member
  sendBranded(req.user.email, `Ticket ${ref} opened — we've got this`, {
    kicker: 'Support ticket',
    title: `We received <b>${escHtml(subject)}</b>`,
    preheader: `Your support ticket ${ref} is open and in our queue.`,
    alert: `Ticket <b>${ref}</b> is open. Your first reply is with us — moderation team usually answers within a few business hours.`,
    alertTone: 'ok',
    paragraphs: [
      `Follow the live conversation and track status from your support area. You'll get an email the moment someone replies.`,
    ],
    cta: { label: 'Open your ticket', url: siteUrl(`/dashboard/support/${id}`) },
    note: 'Tip: quote the exact error text — it makes resolutions faster.',
  }).catch(() => {});
  // notify the admin team that a ticket was raised
  const adminTo = getSetting('admin_email', '') || process.env.ADMIN_NOTIFY_EMAIL || 'hello@firmledger.co.ke';
  sendBranded(adminTo, `New support ticket ${ref} — ${subject}`, {
    kicker: 'New support ticket',
    title: `<b>${escHtml(req.user.name || 'A member')}</b> opened ticket ${ref}`,
    preheader: `${category} · ${subject}`,
    paragraphs: [
      `<b>From:</b> ${escHtml(req.user.name || '')} &lt;${escHtml(req.user.email)}&gt;<br><b>Category:</b> ${escHtml(category)}<br><b>Subject:</b> ${escHtml(subject)}`,
      body.length > 400 ? body.slice(0, 400) + '…' : body,
    ],
    cta: { label: 'Open in admin console', url: siteUrl(`/admin3119Musa/tickets/${id}`) },
    note: 'Replies posted in the console are emailed to the member automatically.',
    text: `New support ticket ${ref}\n\nFrom: ${req.user.name || ''} <${req.user.email}>\nCategory: ${category}\nSubject: ${subject}\n\n${body}\n\nOpen in admin console: ${siteUrl(`/admin3119Musa/tickets/${id}`)}`,
  }).catch(() => {});
  res.redirect(`/dashboard/support/${id}?ok=` + encodeURIComponent(`Ticket ${ref} opened — our team will reply shortly.`));
});

function loadMyTicket(req, res, next) {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!t || t.user_id !== req.user.id) return res.status(404).redirect('/dashboard/support');
  req.ticket = t;
  next();
}

router.get('/dashboard/support/:id', requireUser, loadMyTicket, (req, res) => {
  const messages = db.prepare(
    'SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id ASC'
  ).all(req.ticket.id);
  res.render('dashboard/support-thread', {
    meta: { title: `${req.ticket.subject} — Support — FirmLedger`, description: '', robots: 'noindex' },
    t: req.ticket, messages, categories: [...support.CATEGORIES],
    flashMsg: req.query.ok || '', errors: [],
  });
});

router.post('/dashboard/support/:id/reply', requireUser, loadMyTicket, (req, res) => {
  if (!validCsrf(req)) return res.status(403).redirect(`/dashboard/support/${req.ticket.id}`);
  if (req.ticket.status === 'closed') return res.redirect(`/dashboard/support/${req.ticket.id}`);
  const body = String(req.body.body || '').trim();
  const errors = [];
  if (body.length < 2) errors.push('Write a message first.');
  if (errors.length) {
    const messages = db.prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id ASC').all(req.ticket.id);
    return res.status(422).render('dashboard/support-thread', {
      meta: { title: `${req.ticket.subject} — Support — FirmLedger`, description: '', robots: 'noindex' },
      t: req.ticket, messages, categories: [...support.CATEGORIES], flashMsg: '', errors,
    });
  }
  support.reply(req.ticket.id, 'user', body, '', '');
  res.redirect(`/dashboard/support/${req.ticket.id}?ok=` + encodeURIComponent('Message sent — our team sees it live.'));
});

/* JSON poll for live chat refresh (both sides) */
router.get('/dashboard/support/:id/poll', requireUser, loadMyTicket, (req, res) => {
  res.json({
    status: req.ticket.status,
    adminSeenAt: req.ticket.admin_seen_at,
    updatedAt: req.ticket.updated_at,
  });
});

/* ================= User settings — email preferences ================= */
router.get('/dashboard/settings', (req, res) => {
  const sub = db.prepare('SELECT * FROM newsletter_subscribers WHERE email = ?').get(req.user.email);
  res.render('dashboard/settings', {
    meta: { title: 'Notification settings — FirmLedger', description: '', robots: 'noindex' },
    sub, active: Boolean(sub && sub.active),
    ok: req.query.ok || '', err: req.query.err || '',
  });
});

router.post('/dashboard/settings/digest', (req, res) => {
  const want = req.body.digest === '1';
  const sub = db.prepare('SELECT * FROM newsletter_subscribers WHERE email = ?').get(req.user.email);
  if (want) {
    const r = nl.subscribe(req.user.email, 'account');
    if (r && r.isNew) nl.sendSubscribeWelcome(r.row.email, r.row.token); // fire-and-forget
    return res.redirect('/dashboard/settings?ok=' + encodeURIComponent('Weekly digest turned ON — welcome email is on its way.'));
  }
  if (sub && sub.active) {
    db.prepare('UPDATE newsletter_subscribers SET active=0 WHERE email = ?').run(req.user.email);
    return res.redirect('/dashboard/settings?ok=' + encodeURIComponent('Weekly digest turned OFF — no more weekly emails. You can switch it back on anytime.'));
  }
  res.redirect('/dashboard/settings?ok=' + encodeURIComponent('Weekly digest is already off.'));
});

/* ================= Watchlist (favorites) ================= */
router.get('/dashboard/watchlist', requireUser, (req, res) => {
  const rows = db.prepare(
    `SELECT l.*, f.created_at AS watched_at FROM favorites f
       JOIN listings l ON l.id = f.listing_id
      WHERE f.user_id = ?
      ORDER BY f.created_at DESC`
  ).all(req.user.id);
  res.render('dashboard/watchlist', {
    meta: { title: 'Your watchlist — FirmLedger', description: '', robots: 'noindex' },
    rows,
    accountPro: isProUser(req.user),
    ok: req.query.ok || '', err: req.query.err || '',
  });
});

router.post('/dashboard/watchlist/toggle', requireUser, (req, res) => {
  const listingId = Number(req.body.listing_id) || 0;
  const back = String(req.body.back || '').startsWith('/') ? String(req.body.back) : '/dashboard/watchlist';
  const l = db.prepare("SELECT id FROM listings WHERE id=? AND status='approved'").get(listingId);
  if (!l) return res.redirect('/dashboard/watchlist?err=' + encodeURIComponent('That listing could not be found.'));
  const r = nl.toggleFavorite(req.user.id, listingId);
  res.redirect(back + (back.includes('?') ? '&' : '?') + (r.watching ? 'wl=added' : 'wl=removed'));
});

/* Pro users export their watchlist as CSV for their own CRM */
router.get('/dashboard/watchlist.csv', requireUser, (req, res) => {
  if (!isProUser(req.user)) {
    return res.status(402).redirect('/dashboard/watchlist?err=' + encodeURIComponent('CSV export is a Pro feature — upgrade to download your watchlist.'));
  }
  const rows = db.prepare(
    `SELECT l.name, l.category, l.type, l.country, l.city, l.region, l.website, l.email, l.phone,
            l.tech, l.claimed, l.status, l.confidence, f.created_at AS watched_at
       FROM favorites f JOIN listings l ON l.id = f.listing_id
      WHERE f.user_id = ? ORDER BY l.name ASC`
  ).all(req.user.id);
  const escCsv = (v) => {
    const s = String(v == null ? '' : v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const techOf = (raw) => { try { return JSON.parse(raw || '[]').join('; '); } catch { return ''; } };
  const header = ['Name', 'Category', 'Type', 'Country', 'City', 'Region', 'Website', 'Email', 'Phone', 'Tech stack', 'Verified owner', 'Confidence', 'Watched since'];
  const lines = [header.map(escCsv).join(',')];
  for (const r of rows) {
    lines.push([
      r.name, r.category, r.type, r.country, r.city, r.region, r.website, r.email, r.phone,
      techOf(r.tech), r.claimed ? 'yes' : 'no', r.confidence, (r.watched_at || '').slice(0, 10),
    ].map(escCsv).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="firmledger-watchlist-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(lines.join('\r\n') + '\r\n');
});

/* ================= Jobs (Pro owners) ================= */
router.get('/dashboard/listings/:id/jobs', ownListing, (req, res) => {
  const l = req.listing;
  const jobs = db.prepare('SELECT * FROM jobs WHERE listing_id=? ORDER BY created_at DESC').all(l.id);
  res.render('dashboard/listing-jobs', {
    meta: { title: `Jobs at ${l.name} — FirmLedger`, description: '', robots: 'noindex' },
    l, jobs, pro: perksActive(l), JOB_TYPES: nl.JOB_TYPES,
    errors: [], old: {},
    flashMsg: req.query.ok || '', errMsg: req.query.err || '',
  });
});

router.post('/dashboard/listings/:id/jobs', ownListing, (req, res) => {
  const l = req.listing;
  if (!perksActive(l)) {
    return res.status(402).redirect(`/dashboard/listings/${l.id}/jobs?err=` + encodeURIComponent('Posting jobs is a Pro feature — upgrade to publish openings on your listing and the jobs board.'));
  }
  const r = nl.createJob(l, req.user.id, req.body);
  if (r.errors.length) {
    const jobs = db.prepare('SELECT * FROM jobs WHERE listing_id=? ORDER BY created_at DESC').all(l.id);
    return res.status(422).render('dashboard/listing-jobs', {
      meta: { title: `Jobs at ${l.name} — FirmLedger`, description: '', robots: 'noindex' },
      l, jobs, pro: perksActive(l), JOB_TYPES: nl.JOB_TYPES,
      errors: r.errors, old: req.body, flashMsg: '', errMsg: '',
    });
  }
  res.redirect(`/dashboard/listings/${l.id}/jobs?ok=` + encodeURIComponent('Job published — live on your listing page and the /jobs board.'));
});

router.post('/dashboard/listings/:id/jobs/:jobId/close', ownListing, (req, res) => {
  nl.closeJob(Number(req.params.jobId), req.user.id);
  res.redirect(`/dashboard/listings/${req.listing.id}/jobs?ok=` + encodeURIComponent('Position closed.'));
});

/* ================= Developer API (FirmLedger Pro) ================= */
const apikeys = require('../lib/apikeys');
const apilim = require('../lib/apilimit');
const apisvc = require('../lib/apilistings');

/* One-time key reveal: raw keys are shown exactly once, right after creation. */
const pendingReveals = new Map(); // nonce -> { userId, raw, exp }
function stashReveal(userId, raw) {
  const nonce = require('crypto').randomBytes(16).toString('hex');
  pendingReveals.set(nonce, { userId, raw, exp: Date.now() + 10 * 60_000 });
  return nonce;
}
function takeReveal(nonce, userId) {
  const r = pendingReveals.get(nonce);
  if (!r || r.userId !== userId || r.exp < Date.now()) return null;
  pendingReveals.delete(nonce);
  return r.raw;
}
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of pendingReveals) if (v.exp < t) pendingReveals.delete(k);
}, 60_000).unref();

function renderApiConsole(req, res, extra = {}) {
  const pro = isProUser(req.user);
  const keys = apikeys.listKeys(req.user.id);
  res.render('dashboard/api', {
    meta: { title: 'Developer API — FirmLedger', description: 'Manage FirmLedger API keys, limits and usage.', robots: 'noindex' },
    pro, keys, usage: apikeys.usageSummary(req.user.id),
    limits: apilim,
    maxKeys: apikeys.MAX_ACTIVE_KEYS,
    ...extra,
  });
}

router.get('/dashboard/api', (req, res) => {
  const reveal = req.query.reveal ? takeReveal(String(req.query.reveal), req.user.id) : null;
  renderApiConsole(req, res, { reveal, ok: req.query.ok || '', err: req.query.err || '' });
});

router.post('/dashboard/api/keys', (req, res) => {
  if (!isProUser(req.user)) return res.redirect('/dashboard/api?err=' + encodeURIComponent('API keys are a FirmLedger Pro feature — upgrade to create one.'));
  try {
    const { raw } = apikeys.createKey(req.user.id, req.body.label);
    const nonce = stashReveal(req.user.id, raw);
    res.redirect('/dashboard/api?reveal=' + encodeURIComponent(nonce) + '&ok=' + encodeURIComponent('API key created — copy it now, it is shown only once.'));
  } catch (e) {
    res.redirect('/dashboard/api?err=' + encodeURIComponent(e.message || 'Could not create the key.'));
  }
});

router.post('/dashboard/api/keys/:id/revoke', (req, res) => {
  const done = apikeys.revokeKey(Number(req.params.id), req.user.id);
  res.redirect('/dashboard/api?' + (done
    ? 'ok=' + encodeURIComponent('Key revoked — API calls with it now return 401 immediately.')
    : 'err=' + encodeURIComponent('That key was already revoked.')));
});

/* --- Playground: calls run through the same service layer as /api/v1 --- */
const PLAYGROUND_ENDPOINTS = [
  { m: 'GET', path: '/api/v1/me', body: '' },
  { m: 'GET', path: '/api/v1/listings', body: '' },
  { m: 'POST', path: '/api/v1/listings', body: '{\n  "name": "Acme Logistics Ltd",\n  "tagline": "Cold-chain freight for East African exporters end to end",\n  "description": "Acme Logistics Ltd runs refrigerated trucking and bonded warehousing between Mombasa, Nairobi and Kampala, giving horticulture and pharma exporters a single audited cold chain from packhouse to airport.",\n  "website": "https://acme-logistics.example",\n  "country": "Kenya",\n  "type": "company",\n  "founded": "2019",\n  "city": "Nairobi",\n  "tags": ["logistics", "cold-chain", "freight"]\n}' },
  { m: 'GET', path: '/api/v1/listings/1', body: '' },
  { m: 'PUT', path: '/api/v1/listings/1', body: '{\n  "tagline": "Cold-chain freight and bonded warehousing, Mombasa to Kampala",\n  "city": "Mombasa"\n}' },
  { m: 'DELETE', path: '/api/v1/listings/1', body: '' },
];

function runPlaygroundCall(user, method, path, rawBody) {
  const m = method.toUpperCase();
  const parts = path.replace(/^\/+/, '').split('/');
  // normalise: accept paths with or without the /api/v1 prefix
  const segs = parts[0] === 'api' ? parts.slice(2) : (parts[0] === 'v1' ? parts.slice(1) : parts[0] === '' ? parts.slice(1) : parts);
  let body = null;
  if (['POST', 'PUT', 'PATCH'].includes(m)) {
    try { body = rawBody && rawBody.trim() ? JSON.parse(rawBody) : {}; }
    catch { return { status: 400, json: { error: { code: 'invalid_json', message: 'The playground body is not valid JSON — fix it and re-run.' } } }; }
  }
  if (segs[0] === 'me' && segs.length === 1 && m === 'GET') {
    return { status: 200, json: { data: { id: user.id, email: user.email, name: user.name, plan: 'pro', plan_expires_at: user.plan_expires_at || null } } };
  }
  if (segs[0] === 'listings' && segs.length === 1 && m === 'GET') return { status: 200, json: apisvc.listMine(user, {}) };
  if (segs[0] === 'listings' && segs.length === 1 && m === 'POST') { const r = apisvc.createListing(user, body); return { status: r.status, json: r.body }; }
  if (segs[0] === 'listings' && segs.length === 2 && m === 'GET') return { status: 200, json: { data: apisvc.serialize(apisvc.getOwned(user, segs[1])) } };
  if (segs[0] === 'listings' && segs.length === 2 && m === 'PUT') { const r = apisvc.updateListing(user, segs[1], body); return { status: r.status, json: r.body }; }
  if (segs[0] === 'listings' && segs.length === 2 && m === 'DELETE') return apisvc.deleteListing(user, segs[1]);
  return { status: 404, json: { error: { code: 'unknown_endpoint', message: 'The playground covers the documented v1 endpoints: GET /api/v1/me, GET+POST /api/v1/listings, GET+PUT+DELETE /api/v1/listings/:id.' } } };
}

router.get('/dashboard/api/playground', (req, res) => {
  const newest = db.prepare('SELECT id FROM listings WHERE owner_user_id=? ORDER BY id DESC LIMIT 1').get(req.user.id);
  res.render('dashboard/api-playground', {
    meta: { title: 'API Playground — FirmLedger', description: 'Try the FirmLedger API live against your own data.', robots: 'noindex' },
    pro: isProUser(req.user),
    endpoints: PLAYGROUND_ENDPOINTS,
    limits: apilim,
    sampleId: newest ? newest.id : null,
    result: null, ok: req.query.ok || '', err: req.query.err || '',
    form: { method: 'GET', path: '/api/v1/listings', body: '' },
  });
});

router.post('/dashboard/api/playground', (req, res) => {
  const pro = isProUser(req.user);
  const method = String(req.body.method || 'GET').toUpperCase();
  const path = String(req.body.path || '/api/v1/listings').trim().slice(0, 120);
  const body = String(req.body.body || '').slice(0, 40_000);
  const form = { method, path, body };
  const render = (extra) => {
    const newestPost = db.prepare('SELECT id FROM listings WHERE owner_user_id=? ORDER BY id DESC LIMIT 1').get(req.user.id);
    return res.render('dashboard/api-playground', {
      meta: { title: 'API Playground — FirmLedger', description: 'Try the FirmLedger API live against your own data.', robots: 'noindex' },
      pro, endpoints: PLAYGROUND_ENDPOINTS, limits: apilim, sampleId: newestPost ? newestPost.id : null, form, ok: '', err: '', ...extra,
    });
  };
  if (!pro) return render({ result: null, err: 'The playground is a FirmLedger Pro feature — upgrade to run live calls.' });
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return render({ result: null, err: 'Pick a method: GET, POST, PUT or DELETE.' });

  // Same protection posture as the wire: per-account minute windows + write gate.
  const isWrite = method !== 'GET';
  const c = apilim.charge('pg' + req.user.id, isWrite);
  const headers = {
    'x-ratelimit-limit': String(c.limit),
    'x-ratelimit-remaining': String(c.remaining),
    'x-ratelimit-reset': String(c.resetInSec),
    'x-ratelimit-scope': isWrite ? 'write' : 'read',
  };
  if (!c.ok) {
    return render({ result: { status: 429, headers: { ...headers, 'retry-after': String(c.resetInSec) }, json: { error: { code: 'rate_limited', message: `${isWrite ? 'Write' : 'Read'} window full — same ${c.limit}/minute per-account rule as API keys. Wait ${c.resetInSec}s.` } }, ms: 0 } });
  }
  if (isWrite && !apilim.chargeGlobalWrite({ commit: false }).ok) {
    return render({ result: { status: 429, headers, json: { error: { code: 'global_write_limit', message: 'Unusual write volume across the API right now — retry shortly.' } }, ms: 0 } });
  }
  if (isWrite) apilim.chargeGlobalWrite();

  const t0 = process.hrtime.bigint();
  let outcome;
  try {
    outcome = runPlaygroundCall(req.user, method, path, body);
  } catch (e) {
    if (e instanceof apisvc.ApiServiceError) {
      outcome = { status: e.status, json: { error: { code: e.code, message: e.message, details: e.details } } };
    } else throw e;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return render({ result: { status: outcome.status, headers, json: outcome.json, ms: Math.round(ms * 10) / 10 } });
});

module.exports = router;
