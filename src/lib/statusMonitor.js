/**
 * FirmLedger status monitor — powers the public /status page.
 *
 * Runs live health checks on the components that matter (Web Application, API,
 * Database, Email), records the outcome into component_status_history, and
 * derives the headline "All Systems Normal / Degraded / Partial Outage / Major
 * Outage" from the component states. Admin can also open incidents against a
 * component; an unresolved incident keeps that component out of the "operational"
 * state even after the monitor's next green check.
 *
 * The monitor is self-healing: a single flaky probe only downgrades to degraded;
 * two consecutive failures escalate to major_outage. It never *upgrades* a
 * component that still has an open incident.
 */
const { db, getSetting, setSetting } = require('../db');
const { siteUrl } = require('./util');

const STATUS = {
  operational: 'operational',
  degraded: 'degraded',
  partial_outage: 'partial_outage',
  major_outage: 'major_outage',
};

const STATUS_LABELS = {
  operational: 'Operational',
  degraded: 'Degraded Performance',
  partial_outage: 'Partial Outage',
  major_outage: 'Major Outage',
};

const OVERALL_LABELS = {
  operational: 'All Systems Normal',
  degraded: 'Degraded Performance',
  partial_outage: 'Partial Outage',
  major_outage: 'Major Outage',
};

const INCIDENT_STATUS = ['investigating', 'identified', 'monitoring', 'resolved'];
const SEVERITIES = ['minor', 'major', 'critical'];

/* Default components, seeded on first boot / first check. */
const DEFAULT_COMPONENTS = [
  { name: 'Web Application', slug: 'web', description: 'The FirmLedger site and directory pages.', display_order: 1 },
  { name: 'API', slug: 'api', description: 'The /api/v1 REST endpoints (directory, listings, keys).', display_order: 2 },
  { name: 'Database', slug: 'database', description: 'The SQLite record store backing all listings.', display_order: 3 },
  { name: 'Email', slug: 'email', description: 'SMTP delivery for account, billing and notification mail.', display_order: 4 },
];

/* In-process consecutive-failure counters so a single flaky probe doesn't
   fling a component straight to major_outage. */
const consecutiveFails = new Map();
let monitorTimer = null;

/* ---------------- Components ---------------- */
function ensureComponents() {
  const count = db.prepare('SELECT COUNT(*) c FROM status_components').get().c;
  if (count === 0) {
    const ins = db.prepare(
      'INSERT INTO status_components (name, slug, description, status, display_order) VALUES (?,?,?,?,?)'
    );
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const hist = db.prepare(
      'INSERT INTO component_status_history (component_id, status, checked_at) VALUES (?,?,?)'
    );
    for (const c of DEFAULT_COMPONENTS) {
      const info = ins.run(c.name, c.slug, c.description, STATUS.operational, c.display_order);
      hist.run(info.lastInsertRowid, STATUS.operational, now);
    }
  }
}

function components() {
  return db.prepare('SELECT * FROM status_components ORDER BY display_order ASC, id ASC').all();
}
function componentBySlug(slug) {
  return db.prepare('SELECT * FROM status_components WHERE slug=?').get(String(slug || '').slice(0, 60)) || null;
}
function componentById(id) {
  return db.prepare('SELECT * FROM status_components WHERE id=?').get(Number(id) || 0) || null;
}

/* Degrade/upgrade is committed only after a probe. `manual` callers (admin
   incident forms) bypass the cooldown so an incident can force a state. */
function setComponentStatus(id, status, { viaProbe = false } = {}) {
  const comp = componentById(id);
  if (!comp) return null;
  const next = STATUS[status] ? STATUS[status] : STATUS.operational;
  db.prepare("UPDATE status_components SET status=?, updated_at=datetime('now') WHERE id=?").run(next, id);
  // Log every status *change* to history (same-state probes are noise).
  const isNew = comp.status !== next;
  if (isNew) {
    db.prepare("INSERT INTO component_status_history (component_id, status, checked_at) VALUES (?,?,datetime('now'))")
      .run(id, next);
  }
  if (viaProbe && next === STATUS.operational) consecutiveFails.delete(id);
  return componentById(id);
}

/* A component with an open (unresolved) incident must stay non-operational
   until the incident is resolved, no matter what the probe found. */
function hasOpenIncident(componentId) {
  return Boolean(componentId && db.prepare(
    "SELECT id FROM incidents WHERE component_id=? AND status != 'resolved' LIMIT 1"
  ).get(componentId));
}

function decideProbeStatus(id, ok) {
  if (ok) {
    consecutiveFails.delete(id);
    return STATUS.operational;
  }
  const n = (consecutiveFails.get(id) || 0) + 1;
  consecutiveFails.set(id, n);
  return n >= 2 ? STATUS.major_outage : STATUS.degraded;
}

/* ---------------- Health checks ---------------- */
async function httpStatus(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET', redirect: 'follow', signal: controller.signal,
      headers: { 'user-agent': 'FirmLedgerStatusMonitor/1.0', accept: 'application/json,text/html' },
    });
    const ms = Date.now() - start;
    clearTimeout(timer);
    if (res.status >= 200 && res.status < 400) return { ok: true, latency_ms: ms, note: `HTTP ${res.status}` };
    return { ok: false, latency_ms: ms, note: `HTTP ${res.status}` };
  } catch (e) {
    clearTimeout(timer);
    const msg = e && e.name === 'AbortError' ? 'timed out'
      : String((e && (e.cause && e.cause.code)) || (e && e.message) || e || '').slice(0, 90);
    return { ok: false, latency_ms: Date.now() - start, note: msg };
  }
}

function dbCheck() {
  const start = Date.now();
  try {
    const row = db.prepare('SELECT 1 AS ok').get();
    return { ok: row && row.ok === 1, latency_ms: Date.now() - start, note: row && row.ok === 1 ? 'connection healthy' : 'query failed' };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - start, note: String((e && e.message) || e || '').slice(0, 90) };
  }
}

async function emailCheck() {
  const mailer = require('./mailer');
  if (!mailer.mailConfigured()) {
    // No SMTP configured — mail is queued to data/outbox.log. That is not an outage.
    return { ok: true, latency_ms: 0, note: 'SMTP not configured (outbox fallback)', configured: false };
  }
  const hops = mailer.hops().slice(0, 3);
  if (!hops.length) return { ok: true, latency_ms: 0, note: 'no SMTP hops configured', configured: true };
  const start = Date.now();
  let lastErr = null;
  for (const hop of hops) {
    try {
      const nodemailer = require('nodemailer');
      const t = nodemailer.createTransport({
        host: hop.host, port: hop.port, secure: Boolean(hop.secure),
        auth: hop.user ? { user: hop.user, pass: hop.pass } : undefined,
        connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 8000,
      });
      await t.verify();
      if (t.close) try { t.close(); } catch { /* ignore */ }
      return { ok: true, latency_ms: Date.now() - start, note: `SMTP reachable via ${hop.host}`, configured: true };
    } catch (e) {
      lastErr = e;
    }
  }
  return { ok: false, latency_ms: Date.now() - start, note: String((lastErr && (lastErr.message || lastErr)) || 'SMTP unreachable').slice(0, 90), configured: true };
}

/* Check a single component and persist its outcome. */
async function checkComponent(comp) {
  let result;
  switch (comp.slug) {
    case 'web': result = await httpStatus(siteUrl('/')); break;
    case 'api': result = await httpStatus(siteUrl('/api/v1/health')); break;
    case 'database': result = dbCheck(); break;
    case 'email': result = await emailCheck(); break;
    default: result = { ok: true, latency_ms: 0, note: 'no check defined' }; break;
  }
  // Respect an open incident even on a green probe.
  if (hasOpenIncident(comp.id)) {
    if (result.ok) db.prepare('INSERT INTO component_status_history (component_id, status, checked_at) VALUES (?,?,datetime(\'now\'))')
      .run(comp.id, comp.status);
    return { component: comp, ok: result.ok, note: result.note, latency_ms: result.latency_ms, status: comp.status };
  }
  const nextStatus = decideProbeStatus(comp.id, result.ok);
  const updated = setComponentStatus(comp.id, nextStatus, { viaProbe: true });
  return { component: updated, ok: result.ok, note: result.note, latency_ms: result.latency_ms, status: updated.status };
}

/* Run every component check; returns a fresh snapshot. */
async function checkAll() {
  ensureComponents();
  const comps = components();
  const results = [];
  for (const c of comps) {
    try { results.push(await checkComponent(c)); }
    catch (e) { results.push({ component: c, ok: false, note: String((e && e.message) || e || '').slice(0, 90), latency_ms: 0 }); }
  }
  pruneHistory();
  return results;
}

/* Keep only the last 90 days of history. */
function pruneHistory() {
  try { db.prepare('DELETE FROM component_status_history WHERE checked_at < datetime(\'now\', \'-90 days\')').run(); } catch { /* ignore */ }
}

/* ---------------- Aggregate status ---------------- */
function overallStatus() {
  const comps = components();
  if (comps.some((c) => c.status === STATUS.major_outage)) return STATUS.major_outage;
  if (comps.some((c) => c.status === STATUS.partial_outage)) return STATUS.partial_outage;
  if (comps.some((c) => c.status === STATUS.degraded)) return STATUS.degraded;
  // An active incident (even one not tied to a single component) means the
  // platform is not fully healthy — surface it as degraded at minimum.
  if (activeIncidents().length) return STATUS.degraded;
  return STATUS.operational;
}

/* Uptime % for a component within a window (days). No history → 100 (no failures). */
function uptimePercent(componentId, days = 30) {
  const row = db.prepare(
    `SELECT COUNT(*) total, SUM(CASE WHEN status='operational' THEN 1 ELSE 0 END) ok
       FROM component_status_history
      WHERE component_id=? AND checked_at >= datetime('now', ?)`
  ).get(Number(componentId) || 0, '-' + Number(days) + ' days');
  const total = row ? (row.total || 0) : 0;
  if (!total) return 100;
  return Math.round(((row.ok || 0) / total) * 100);
}

function overallUptime(days = 30) {
  const comps = components();
  if (!comps.length) return 100;
  // Worst-case across components (min) is the standard status-page signal.
  return Math.min(...comps.map((c) => uptimePercent(c.id, days)));
}

function uptimeSummary(componentId) {
  return {
    '24h': uptimePercent(componentId, 1),
    '7d': uptimePercent(componentId, 7),
    '30d': uptimePercent(componentId, 30),
    '90d': uptimePercent(componentId, 90),
  };
}

/* ---------------- Incidents ---------------- */
function incidentUpdates(incidentId) {
  try {
    return db.prepare('SELECT * FROM incident_updates WHERE incident_id=? ORDER BY id ASC').all(Number(incidentId) || 0);
  } catch { return []; }
}

function incidentsSince(days = 30) {
  const rows = db.prepare(
    `SELECT i.*, c.name AS component_name, c.slug AS component_slug
       FROM incidents i LEFT JOIN status_components c ON c.id = i.component_id
      WHERE i.created_at >= datetime('now', ?) OR i.updated_at >= datetime('now', ?)
      ORDER BY i.created_at DESC`
  ).all('-' + Number(days) + ' days', '-' + Number(days) + ' days');
  // Attach each incident's timeline updates in one pass.
  const out = rows.map((r) => ({ ...r, updates: incidentUpdates(r.id) }));
  return out;
}

/* Every incident, newest first (admin console). */
function allIncidents() {
  const rows = db.prepare(
    `SELECT i.*, c.name AS component_name, c.slug AS component_slug
       FROM incidents i LEFT JOIN status_components c ON c.id = i.component_id
      ORDER BY i.created_at DESC`
  ).all();
  return rows.map((r) => ({ ...r, updates: incidentUpdates(r.id) }));
}

function activeIncidents() {
  return db.prepare(
    `SELECT i.*, c.name AS component_name, c.slug AS component_slug
       FROM incidents i LEFT JOIN status_components c ON c.id = i.component_id
      WHERE i.status != 'resolved'
      ORDER BY i.created_at DESC`
  ).all();
}

function incidentById(id) {
  return db.prepare('SELECT * FROM incidents WHERE id=?').get(Number(id) || 0) || null;
}

function severityToStatus(severity) {
  if (severity === 'critical') return STATUS.major_outage;
  if (severity === 'major') return STATUS.partial_outage;
  return STATUS.degraded;
}

/** Create an incident and open its first timeline entry. */
function createIncident({ title, description = '', status = 'investigating', severity = 'minor', component_id = null, setComponent = true }) {
  const t = String(title || '').trim().slice(0, 200);
  if (t.length < 3) return { ok: false, error: 'Give the incident a proper title (3+ characters).' };
  const sev = SEVERITIES.includes(severity) ? severity : 'minor';
  const st = INCIDENT_STATUS.includes(status) ? status : 'investigating';
  const compId = component_id ? (componentById(component_id) ? Number(component_id) : null) : null;
  const info = db.prepare(
    'INSERT INTO incidents (title, description, status, severity, component_id) VALUES (?,?,?,?,?)'
  ).run(t, String(description || '').slice(0, 2000), st, sev, compId);
  const id = info.lastInsertRowid;
  db.prepare('INSERT INTO incident_updates (incident_id, status, message) VALUES (?,?,?)')
    .run(id, st, t);
  if (setComponent && compId && st !== 'resolved') {
    // Reflect the severity on the affected component so the headline updates.
    setComponentStatus(compId, severityToStatus(sev));
  }
  return { ok: true, id };
}

/** Append a timeline update and (optionally) move the incident to `status`. */
function addIncidentUpdate(id, { status, message }) {
  const inc = incidentById(id);
  if (!inc) return { ok: false, error: 'Incident not found.' };
  const st = INCIDENT_STATUS.includes(status) ? status : inc.status;
  const msg = String(message || '').trim().slice(0, 2000) || `${inc.title} — ${STATUS_LABELS[st] || st}.`;
  const ins = db.prepare("INSERT INTO incident_updates (incident_id, status, message) VALUES (?,?,?)").run(inc.id, st, msg);
  const resolvedAt = st === 'resolved' ? "datetime('now')" : 'NULL';
  db.prepare(`UPDATE incidents SET status=?, updated_at=datetime('now'), resolved_at=${resolvedAt} WHERE id=?`).run(st, inc.id);
  // When resolved, heal the affected component (latest wins).
  if (st === 'resolved' && inc.component_id) {
    if (!hasOpenIncident(inc.component_id)) setComponentStatus(inc.component_id, STATUS.operational);
  }
  const updated = incidentById(inc.id);
  return { ok: true, incident: updated, newUpdate: db.prepare('SELECT * FROM incident_updates WHERE id=?').get(ins.lastInsertRowid) };
}

function resolveIncident(id) {
  return addIncidentUpdate(id, { status: 'resolved', message: 'This incident has been resolved.' });
}

/**
 * Permanently delete an incident (Admin → Status → Delete).
 *
 * The row and its whole timeline go — `incident_updates` cascades on the foreign
 * key — so the incident disappears from the public /status page, from the 30-day
 * history and from the admin console for good. When the deleted incident was the
 * only thing holding its component down (an incident forces a component out of
 * "operational" until it is resolved), that component is healed straight back to
 * operational; anything else on the page keeps its own state untouched.
 */
function deleteIncident(id) {
  const inc = incidentById(id);
  if (!inc) return { ok: false, error: 'Incident not found.' };
  db.prepare('DELETE FROM incidents WHERE id=?').run(inc.id);      // timeline cascades
  db.prepare('DELETE FROM incident_updates WHERE incident_id=?').run(inc.id); // belt & braces
  if (inc.component_id && !hasOpenIncident(inc.component_id)) {
    const comp = componentById(inc.component_id);
    if (comp && comp.status !== STATUS.operational) setComponentStatus(comp.id, STATUS.operational);
  }
  return { ok: true, id: inc.id, title: inc.title };
}

const SEVERITY_LABELS = { minor: 'Minor', major: 'Major', critical: 'Critical' };
const INCIDENT_STATUS_LABELS = {
  investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved',
};

/* ---------------- Subscribers + notifications ---------------- */
function subscriberByToken(token) {
  return db.prepare('SELECT * FROM status_subscribers WHERE verification_token=?').get(String(token || '').slice(0, 80)) || null;
}

function addSubscriber(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return { ok: false, error: 'Please enter an email address.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { ok: false, error: 'That email address does not look valid.' };
  const existing = db.prepare('SELECT * FROM status_subscribers WHERE email=?').get(e);
  if (existing && existing.verified) return { ok: true, already: true, row: existing };
  const token = require('./util').randomToken(32);
  const info = db.prepare(
    `INSERT INTO status_subscribers (email, verified, verification_token) VALUES (?,0,?)
     ON CONFLICT(email) DO UPDATE SET verification_token=excluded.verification_token, verified=0`
  ).run(e, token);
  const row = db.prepare('SELECT * FROM status_subscribers WHERE email=?').get(e);
  return { ok: true, row, token };
}

function verifySubscriber(token) {
  const row = subscriberByToken(token);
  if (!row) return { ok: false, error: 'That verification link is not valid.' };
  db.prepare('UPDATE status_subscribers SET verified=1, verification_token=\'\' WHERE id=?').run(row.id);
  return { ok: true, email: row.email };
}

function unsubscribeSubscriber(token) {
  const row = subscriberByToken(token);
  if (!row) return { ok: false };
  db.prepare('DELETE FROM status_subscribers WHERE id=?').run(row.id);
  return { ok: true };
}

function verifiedSubscribers() {
  return db.prepare("SELECT email FROM status_subscribers WHERE verified=1 ORDER BY subscribed_at DESC").all();
}

function subscriberCount() {
  return db.prepare("SELECT COUNT(*) c FROM status_subscribers WHERE verified=1").get().c;
}

/* Email everyone who is subscribed to status updates. Returns the number sent. */
async function notifySubscribers(subject, opts = {}) {
  const list = verifiedSubscribers();
  if (!list.length || !require('./mailer').mailConfigured()) return 0;
  const { sendBranded } = require('./mailer');
  const from = process.env.STATUS_EMAIL_FROM || undefined;
  let sent = 0;
  for (const s of list) {
    try {
      await sendBranded(s.email, subject, { ...opts, from: opts.from || from });
      sent++;
    } catch { /* drop silently — one bad address must not block the rest */ }
  }
  return sent;
}

/* ---------------- Snapshot for /status and /status/api ---------------- */
function snapshot() {
  ensureComponents();
  const comps = components().map((c) => ({
    id: c.id, name: c.name, slug: c.slug, description: c.description,
    status: c.status, status_label: STATUS_LABELS[c.status] || c.status,
    display_order: c.display_order, updated_at: c.updated_at,
    uptime: uptimeSummary(c.id),
  }));
  const overall = overallStatus();
  const active = activeIncidents();
  const recent = incidentsSince(30);
  const nowIso = new Date().toISOString();
  const lastChecked = comps.length
    ? comps.map((c) => c.updated_at).filter(Boolean).sort().pop()
    : '';
  return {
    status: overall,
    status_label: OVERALL_LABELS[overall] || overall,
    timestamp: nowIso,
    generated_at: nowIso,
    last_checked: lastChecked,
    components: comps,
    active_incidents: active,
    incidents_30d: recent,
    uptime: {
      '24h': overallUptime(1), '7d': overallUptime(7), '30d': overallUptime(30), '90d': overallUptime(90),
    },
    total_subscribers: subscriberCount(),
    monitor: {
      interval_sec: Math.max(15, parseInt(process.env.STATUS_UPDATE_INTERVAL || '60', 10) || 60),
      env_from: process.env.STATUS_EMAIL_FROM || '',
    },
  };
}

/* ---------------- Weekly digest (optional) ---------------- */
async function sendWeeklyStatusDigest(force = false) {
  if (getSetting('status_weekly_report', '0') !== '1' && !force) return { sent: 0, done: true };
  const last = getSetting('status_weekly_last_sent', '');
  if (!force && last && Date.now() - Date.parse(last) < 6.5 * 24 * 3600 * 1000) return { sent: 0, done: true };
  const mailer = require('./mailer');
  const list = verifiedSubscribers();
  if (!list.length || !mailer.mailConfigured()) return { sent: 0, done: true };
  const weekUptime = overallUptime(7);
  const incidents = incidentsSince(7).filter((i) => i.status !== 'resolved');
  const resolved = incidentsSince(7).filter((i) => i.status === 'resolved');
  const { sendBranded } = mailer;
  const from = process.env.STATUS_EMAIL_FROM || undefined;
  let sent = 0;
  for (const s of list) {
    try {
      await sendBranded(s.email, 'FirmLedger weekly status report', {
        from,
        kicker: 'Weekly status',
        title: 'FirmLedger — last 7 days',
        preheader: `Platform uptime was ${weekUptime}% this week.`,
        alert: `<b>Uptime (7d):</b> ${weekUptime}% &nbsp;·&nbsp; <b>Open incidents:</b> ${incidents.length} &nbsp;·&nbsp; <b>Resolved:</b> ${resolved.length}`,
        alertTone: incidents.length ? 'warn' : 'ok',
        paragraphs: incidents.length
          ? ['One or more incidents affected FirmLedger this week. See the status page for timelines and resolution notes.']
          : ['FirmLedger ran smoothly over the last 7 days. No incidents were recorded.'],
        cta: { label: 'View status', url: siteUrl('/status') },
        note: 'You received this because you subscribed to FirmLedger status updates. Unsubscribe any time from the status page.',
      });
      sent++;
    } catch { /* skip broken addresses */ }
  }
  if (sent) setSetting('status_weekly_last_sent', new Date().toISOString());
  return { sent, done: true };
}

/* ---------------- Start / stop ---------------- */
function startMonitoring() {
  ensureComponents();
  checkAll().catch((e) => console.error('[status-monitor] initial check failed:', e && e.message));
  const sec = Math.max(15, parseInt(process.env.STATUS_UPDATE_INTERVAL || '60', 10) || 60);
  monitorTimer = setInterval(() => checkAll().catch((e) => console.error('[status-monitor] check failed:', e && e.message)), sec * 1000);
  if (monitorTimer.unref) monitorTimer.unref();
  console.log(`[status-monitor] monitoring started (every ${sec}s)`);
  return monitorTimer;
}

function stopMonitoring() {
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
}

module.exports = {
  STATUS, STATUS_LABELS, OVERALL_LABELS, INCIDENT_STATUS, SEVERITIES,
  SEVERITY_LABELS, INCIDENT_STATUS_LABELS,
  ensureComponents, components, componentBySlug, componentById, setComponentStatus,
  checkComponent, checkAll, pruneHistory, hasOpenIncident,
  overallStatus, uptimePercent, overallUptime, uptimeSummary,
  incidentUpdates, incidentsSince, allIncidents, activeIncidents, incidentById,
  createIncident, addIncidentUpdate, resolveIncident, deleteIncident,
  subscriberByToken, addSubscriber, verifySubscriber, unsubscribeSubscriber,
  verifiedSubscribers, subscriberCount, notifySubscribers,
  sendWeeklyStatusDigest,
  snapshot, startMonitoring, stopMonitoring,
};
