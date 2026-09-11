/**
 * Weekly leads & conversion digest.
 *
 * sendWeeklyLeadDigests() runs from the hourly process timer (server.js) and
 * is a no-op until 6.5 days have elapsed since the last run. Every owner of
 * at least one listing gets the automatic weekly report — UNLESS they opted
 * out (Notification settings → Weekly leads report: both / email /
 * notification / none) or the week was completely quiet (no impressions,
 * views or leads: silence, not a “0 leads” email).
 *
 * Pro owners get the full funnel; Free owners get a teaser that never leaks
 * exact analytics (counts of waiting inquiries are already visible on their
 * dashboard, so those are safe to mention) plus the upgrade prompt.
 */
const { db, getSetting, setSetting } = require('../db');
const analytics = require('./analytics');
const leads = require('./leads');
const { sendBranded, mailConfigured } = require('./mailer');
const { notifyUser } = require('./notify');
const { siteUrl } = require('./util');
const { hasProAccess } = require('./plans');

const DUE_MS = 6.5 * 24 * 3600 * 1000;
const PREFS = ['both', 'email', 'notification', 'none'];

function prefOf(u) {
  const p = String(u.leads_digest || 'both').trim();
  return PREFS.includes(p) ? p : 'both';
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

/* Top listing by leads in the window, for the “star performer” line. */
function topListing(ids, days) {
  if (!ids.length) return null;
  try {
    const marks = ids.map(() => '?').join(',');
    return db.prepare(
      `SELECT g.name, g.slug, COUNT(*) AS c FROM leads l
       JOIN listings g ON g.id = l.listing_id
       WHERE l.listing_id IN (${marks}) AND l.created_at >= datetime('now', ?)
       GROUP BY l.listing_id ORDER BY c DESC LIMIT 1`
    ).get(...ids, `-${days} days`) || null;
  } catch {
    return null;
  }
}

async function sendProDigest(u, ids, week, month, pref, mailOk) {
  const headline = analytics.funnelHeadline(month, ids.length);
  const star = topListing(ids, 30);
  const weekLine = `Last 7 days: ${plural(week.impressions, 'impression', 'impressions')} → `
    + `${plural(week.views, 'profile view', 'profile views')} → `
    + `${plural(week.leads, 'lead', 'leads')}.`;
  const out = { email: false, notification: false };

  if (pref === 'both' || pref === 'email') {
    if (mailOk && u.email) {
      const paragraphs = [
        headline,
        `${weekLine} Your view-to-inquiry rate is `
          + `${week.contactRate === null ? '—' : `${week.contactRate}%`} this week.`,
      ];
      if (star) {
        paragraphs.push(`Strongest performer: <b>${star.name}</b> — `
          + `${plural(star.c, 'inquiry', 'inquiries')} in the last 30 days. `
          + `<a href="${siteUrl(`/listing/${star.slug}`)}" style="color:#1D4ED8;">View the profile</a> · `
          + `<a href="${siteUrl('/dashboard/leads')}" style="color:#1D4ED8;">work the inbox</a>`);
      } else if (month.leads === 0 && month.views > 0) {
        paragraphs.push('Views are arriving but no inquiries yet — check the profile presents a clear reason to enquire: '
          + 'a sharp tagline, a complete description and a claimed (verified-owner) badge all lift conversion.');
      }
      await sendBranded(u.email, `Your weekly leads report — ${plural(week.leads, 'new lead', 'new leads')}`, {
        alias: 'hello',
        kicker: 'Weekly leads report',
        title: headline,
        preheader: weekLine,
        alert: `<b>Exposure (7d):</b> ${week.impressions} &nbsp;·&nbsp; <b>Views:</b> ${week.views} `
          + `&nbsp;·&nbsp; <b>Leads:</b> ${week.leads} &nbsp;·&nbsp; <b>Qualified:</b> ${week.byStatus.qualified} `
          + `&nbsp;·&nbsp; <b>Won:</b> ${week.byStatus.won}`,
        alertTone: week.leads > 0 ? 'ok' : 'info',
        paragraphs,
        cta: { label: 'Open Audience Analytics', url: siteUrl('/dashboard/analytics') },
        note: `You're receiving this because you own listings on FirmLedger. Quiet weeks never email. `
          + `Change this anytime: <a href="${siteUrl('/dashboard/settings')}" style="color:#1D4ED8;">Notification settings</a>`,
      }).catch(() => {});
      out.email = true;
    }
  }
  if (pref === 'both' || pref === 'notification') {
    notifyUser(u.id, {
      kind: 'lead_digest',
      title: `Weekly leads report — ${plural(week.leads, 'new lead', 'new leads')}`,
      body: `${headline} ${weekLine}`,
      url: '/dashboard/analytics',
    });
    out.notification = true;
  }
  return out;
}

async function sendTeaserDigest(u, ids, week, pref, mailOk) {
  const waiting = leads.newCount(u.id);
  const title = waiting > 0
    ? `You have ${plural(waiting, 'new inquiry', 'new inquiries')} waiting`
    : 'Your listings had visitors this week';
  const body = waiting > 0
    ? `${plural(waiting, 'New inquiry is', 'New inquiries are')} waiting in your Leads inbox. `
      + 'Upgrade to FirmLedger Pro to read and manage them — plus full Audience Analytics.'
    : 'Your listings had activity this week. Upgrade to FirmLedger Pro to see who is viewing them '
      + 'and to unlock your Leads inbox.';
  const out = { email: false, notification: false };
  if ((pref === 'both' || pref === 'email') && mailOk && u.email) {
    await sendBranded(u.email, `FirmLedger weekly: ${title.toLowerCase()}`, {
      alias: 'hello',
      kicker: 'Weekly leads report',
      title,
      preheader: 'Upgrade to Pro to read your inquiries and see your audience.',
      alert: `${body}`,
      alertTone: 'info',
      paragraphs: [
        'Inquiries keep arriving while you are on Free — upgrading unlocks the backlog: '
          + 'read every inquiry, work the New → Contacted → Qualified → Won pipeline, '
          + 'and see views, top locations and conversion rates in Audience Analytics.',
      ],
      cta: { label: 'Upgrade to FirmLedger Pro', url: siteUrl('/dashboard/upgrade') },
      note: `You're receiving this because you own listings on FirmLedger. Quiet weeks never email. `
        + `Change this anytime: <a href="${siteUrl('/dashboard/settings')}" style="color:#1D4ED8;">Notification settings</a>`,
    }).catch(() => {});
    out.email = true;
  }
  if (pref === 'both' || pref === 'notification') {
    notifyUser(u.id, {
      kind: 'lead_digest',
      title: `Weekly leads report — ${title.toLowerCase()}`,
      body,
      url: '/dashboard/upgrade',
    });
    out.notification = true;
  }
  return out;
}

async function sendWeeklyLeadDigests(force = false) {
  const last = Date.parse(getSetting('leads_digest_last_sent', '')) || 0;
  if (!force && Date.now() - last < DUE_MS) return { sent: 0, reason: 'not_due' };
  const owners = db.prepare(
    `SELECT u.* FROM users u
     WHERE (u.suspended IS NULL OR u.suspended = 0)
       AND EXISTS (SELECT 1 FROM listings l WHERE l.owner_user_id = u.id)`
  ).all();
  if (!owners.length) return { sent: 0, reason: 'no_owners' };
  const mailOk = mailConfigured();
  const counts = { sent: 0, email: 0, notification: 0, quiet: 0, off: 0, pro: 0, teaser: 0 };
  for (const u of owners) {
    try {
      const pref = prefOf(u);
      if (pref === 'none') { counts.off++; continue; }
      const ids = db.prepare('SELECT id FROM listings WHERE owner_user_id=?').all(u.id).map((r) => r.id);
      if (!ids.length) { counts.off++; continue; }
      if (!analytics.hasActivity(ids, 7)) { counts.quiet++; continue; }
      const pro = hasProAccess(u);
      const week = analytics.funnel(ids, 7);
      const out = pro
        ? await sendProDigest(u, ids, week, analytics.funnel(ids, 30), pref, mailOk)
        : await sendTeaserDigest(u, ids, week, pref, mailOk);
      if (out.email) counts.email++;
      if (out.notification) counts.notification++;
      if (out.email || out.notification) {
        counts.sent++;
        if (pro) counts.pro++; else counts.teaser++;
      }
    } catch (e) {
      console.error('[leads-digest] owner failed:', u && u.id, e && e.message);
    }
  }
  /* The sweep completed — stamp it so the hourly tick doesn't re-run for a
     week, even if every owner was quiet or opted out. */
  setSetting('leads_digest_last_sent', new Date().toISOString());
  return counts;
}

module.exports = { sendWeeklyLeadDigests, PREFS, DUE_MS };
