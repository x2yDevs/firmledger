/**
 * Technology-radar maintenance — the engine behind the admin console's
 * "refresh tech" controls.
 *
 * Every profile carries a technology snapshot (`listings.tech` +
 * `listings.tech_checked_at`) detected from the company's own public homepage.
 * Detection lives in lib/enrich.js; this module is only about *when* it runs
 * and how the console drives it:
 *
 *   refreshOne(id)   refresh a single listing now (row button, edit page)
 *   start(ids)       refresh many listings in the background (selection,
 *                    the whole filtered view, everything stale, or the
 *                    entire directory) with a small concurrency pool
 *   jobState()       live progress, polled by the listings page
 *   cancel()         stop a run that is still in flight
 *
 * Only one run is ever in flight — the same contract as the Google Indexing
 * batch runner, so the console never stacks two crawlers on the network.
 */
const { db, getSetting, setSetting } = require('../db');
const { detectTech } = require('./enrich');
const listingEvents = require('./listingevents');
const notify = require('./notify');
const newsletter = require('./newsletter');
const { escHtml } = require('./util');

/** A snapshot older than this is offered up as "stale" in the console. */
const STALE_DAYS = 90;
/** How many homepages are fetched at the same time during a bulk run. */
const CONCURRENCY = 4;
/** Errors kept on the job object for the progress panel. */
const MAX_ERRORS = 5;
/** Safety cap for a single "refresh everything" run. */
const MAX_QUEUE = 2000;

const SUMMARY_KEY = 'tech_refresh_last_summary';

function parseTech(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function techCount(raw) {
  return parseTech(raw).length;
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

/** Listings whose snapshot is missing or older than STALE_DAYS — and reachable. */
function staleIds(limit = MAX_QUEUE) {
  const cutoff = isoDaysAgo(STALE_DAYS);
  return db.prepare(
    `SELECT id FROM listings
      WHERE website <> '' AND (tech_checked_at IS NULL OR tech_checked_at = '' OR tech_checked_at < ?)
      ORDER BY id LIMIT ?`
  ).all(cutoff, Math.max(1, Math.min(MAX_QUEUE, Number(limit) || MAX_QUEUE)))
    .map((r) => r.id);
}

function staleCount() {
  const cutoff = isoDaysAgo(STALE_DAYS);
  return db.prepare(
    `SELECT COUNT(*) c FROM listings
      WHERE website <> '' AND (tech_checked_at IS NULL OR tech_checked_at = '' OR tech_checked_at < ?)`
  ).get(cutoff).c;
}

/** Every listing with a website — a full-directory refresh. */
function allIds(limit = MAX_QUEUE) {
  return db.prepare(
    `SELECT id FROM listings WHERE website <> '' ORDER BY id LIMIT ?`
  ).all(Math.max(1, Math.min(MAX_QUEUE, Number(limit) || MAX_QUEUE))).map((r) => r.id);
}

function counts() {
  const total = db.prepare('SELECT COUNT(*) c FROM listings').get().c;
  const withWebsite = db.prepare("SELECT COUNT(*) c FROM listings WHERE website <> ''").get().c;
  const checked = db.prepare(
    "SELECT COUNT(*) c FROM listings WHERE website <> '' AND tech_checked_at IS NOT NULL AND tech_checked_at <> ''"
  ).get().c;
  return { total, withWebsite, checked, never: withWebsite - checked, stale: staleCount() };
}

/**
 * Refresh one listing's technology snapshot.
 * Returns { ok, skipped, name, count, before, after, changed, tech }.
 */
async function refreshOne(id, { notifyWatchers = true } = {}) {
  const l = db.prepare('SELECT * FROM listings WHERE id=?').get(Number(id));
  if (!l) return { ok: false, skipped: 'missing', id: Number(id), name: '' };
  if (!String(l.website || '').trim()) {
    return { ok: false, skipped: 'no-website', id: l.id, name: l.name };
  }

  const before = parseTech(l.tech);
  const snap = await detectTech(l.website);
  const after = Array.isArray(snap.tech) ? snap.tech : [];

  db.prepare('UPDATE listings SET tech = ?, tech_checked_at = ?, hiring_url = ? WHERE id = ?')
    .run(JSON.stringify(after), new Date().toISOString().slice(0, 10), (snap.hiring && snap.hiring.url) || '', l.id);

  const fresh = db.prepare('SELECT * FROM listings WHERE id=?').get(l.id);
  listingEvents.updated(fresh, { change: 'technology_snapshot', source: 'admin' });

  const beforeNames = before.map((t) => t && t.n).filter(Boolean);
  const afterNames = after.map((t) => t && t.n).filter(Boolean);
  const added = afterNames.filter((n) => !beforeNames.includes(n));
  const removed = beforeNames.filter((n) => !afterNames.includes(n));
  const changed = added.length > 0 || removed.length > 0;

  if (notifyWatchers && changed && after.length) {
    const bits = after.slice(0, 6).map((t) => escHtml(t.n)).join(', ');
    newsletter.notifyWatchers(l.id, [
      `Technology stack refreshed — <b>${after.length}</b> technolog${after.length === 1 ? 'y' : 'ies'} detected (${bits}${after.length > 6 ? '…' : ''})`,
    ]).catch(() => {});
  }

  return {
    ok: true, id: l.id, name: l.name, slug: l.slug,
    count: after.length, before: before.length, after: after.length,
    added, removed, changed, tech: after,
    hiring: (snap.hiring && snap.hiring.url) || '',
  };
}

/* ------------------------------------------------------- background runner */

let job = null;

function jobState() {
  if (!job) return { running: false };
  return {
    running: job.status === 'running',
    status: job.status,
    scope: job.scope,
    total: job.total,
    done: job.done,
    changed: job.changed,
    unchanged: job.unchanged,
    skipped: job.skipped,
    failed: job.failed,
    errors: job.errors.slice(0, MAX_ERRORS),
    started_at: job.started_at,
    finished_at: job.finished_at,
    current: job.current,
  };
}

function lastRun() {
  const raw = getSetting(SUMMARY_KEY, '');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Start a refresh run over `ids`. Runs in the background; poll jobState().
 * `scope` is only a label for the UI: selected | view | stale | all.
 */
function start(ids, scope = 'selected') {
  if (job && job.status === 'running') {
    return { ok: false, error: 'A technology refresh is already running.', job: jobState() };
  }
  const queue = [...new Set((ids || []).map((n) => Number(n)).filter((n) => n > 0))].slice(0, MAX_QUEUE);
  job = {
    status: 'running',
    scope,
    total: queue.length,
    done: 0, changed: 0, unchanged: 0, skipped: 0, failed: 0,
    errors: [],
    current: '',
    started_at: new Date().toISOString(),
    finished_at: '',
    cancel: false,
  };
  console.log(`[tech-refresh] run started — ${queue.length} listing(s), scope=${scope}`);
  run(queue).catch((e) => {
    console.error('[tech-refresh] run crashed:', e && e.message);
    if (job) { job.status = 'error'; job.finished_at = new Date().toISOString(); }
  });
  return { ok: true, job: jobState() };
}

/** Ask a running job to stop after the in-flight requests settle. */
function cancel() {
  if (job && job.status === 'running') { job.cancel = true; return true; }
  return false;
}

async function run(queue) {
  if (!queue.length) {
    job.status = 'done';
    job.finished_at = new Date().toISOString();
    finish(job);
    return;
  }
  let cursor = 0;
  async function worker() {
    for (;;) {
      if (job.cancel) return;
      const idx = cursor;
      cursor += 1;
      if (idx >= queue.length) return;
      const id = queue[idx];
      try {
        job.current = (db.prepare('SELECT name FROM listings WHERE id=?').get(id) || {}).name || `#${id}`;
        const r = await refreshOne(id);
        job.done += 1;
        if (!r.ok) {
          if (r.skipped === 'no-website') job.skipped += 1;
          else {
            job.failed += 1;
            if (job.errors.length < MAX_ERRORS) job.errors.push(`${r.name || id} — ${r.skipped || 'failed'}`);
          }
        } else if (r.changed) job.changed += 1;
        else job.unchanged += 1;
      } catch (e) {
        job.done += 1;
        job.failed += 1;
        if (job.errors.length < MAX_ERRORS) job.errors.push(`${id} — ${e && e.message}`);
      }
    }
  }
  const pool = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker);
  await Promise.all(pool);
  job.current = '';
  job.status = job.cancel ? 'cancelled' : 'done';
  job.finished_at = new Date().toISOString();
  finish(job);
}

function finish(j) {
  const summary = {
    scope: j.scope,
    attempted: j.done, total: j.total,
    changed: j.changed, unchanged: j.unchanged,
    skipped: j.skipped, failed: j.failed,
    started_at: j.started_at, finished_at: j.finished_at,
    status: j.status,
    errors: j.errors.slice(0, MAX_ERRORS),
  };
  setSetting(SUMMARY_KEY, JSON.stringify(summary));
  console.log(`[tech-refresh] run ${j.status} — ${j.changed} changed, ${j.unchanged} unchanged, ${j.skipped} without a website, ${j.failed} failed`);
  try {
    notify.notifyAdmin({
      kind: 'system',
      title: `Technology radar refresh ${j.status}`,
      body: `${j.done} of ${j.total} listing${j.total === 1 ? '' : 's'} scanned — ${j.changed} changed, ${j.unchanged} unchanged, ${j.skipped} had no website, ${j.failed} failed.`,
      url: '/admin3119Musa/listings',
    });
  } catch { /* admin notifications are best-effort */ }
}

module.exports = {
  STALE_DAYS,
  parseTech, techCount,
  refreshOne,
  start, cancel, jobState, lastRun,
  staleIds, staleCount, allIds, counts,
};
