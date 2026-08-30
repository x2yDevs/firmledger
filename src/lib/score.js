/** FirmLedger Score — profile health & completeness, computed from real data only. */
function firmledgerScore(l, opts = {}) {
  const sources = opts.sources || [];
  const events = opts.events || [];
  const relations = opts.relations || [];
  const tech = opts.tech || [];
  const socials = opts.socials || {};

  const fields = [
    ['Name', l.name], ['Tagline', l.tagline], ['Description', l.description],
    ['Category', l.category], ['Website', l.website], ['Public email', l.email],
    ['Phone', l.phone], ['Country', l.country], ['City', l.city],
    ['Founded', l.founded], ['Team size', l.size], ['Logo', l.logo_url],
    ['Tags', l.tags], ['Social profiles', Object.values(socials).filter(Boolean)[0]],
  ];
  const filled = fields.filter(([, v]) => v && String(v).trim()).length;
  const parts = [];
  const add = (label, have, max) => parts.push({ label, have: Math.min(have, max), max });

  add('Field completeness', Math.round((filled / fields.length) * 48), 48);
  add('Independent sources', Math.min(sources.length, 3) * 4, 12);
  add('Verified ownership', l.claimed ? 10 : 0, 10);
  add('Ownership verification date', l.last_verified_at ? 6 : 0, 6);
  const daysOld = Math.max(0, Math.floor((Date.now() - new Date(l.updated_at).getTime()) / 864e5));
  add('Freshness', daysOld <= 30 ? 8 : daysOld <= 90 ? 4 : 0, 8);
  add('Timeline events', events.length ? 4 : 0, 4);
  add('Relationship graph', relations.length ? 4 : 0, 4);
  add('Technology snapshot', tech.length ? 4 : 0, 4);
  add('Social proof', Object.values(socials).filter(Boolean).length >= 2 ? 4 : 0, 4);

  const score = parts.reduce((s, p) => s + p.have, 0);
  return { score, parts, filledCount: filled, totalFields: fields.length };
}

module.exports = { firmledgerScore };
