/**
 * Automated upkeep — the hourly sweep that keeps the ledger fresh with nobody
 * clicking anything.
 *
 * Two jobs, both opt-out, both capped per hour and both delegated to runners
 * that already exist (lib/techrefresh.js and lib/news.js):
 *
 *   technology   re-detect the stack of the listings whose snapshot is missing
 *                or older than the stale window
 *   news         search the public news index for the approved listings whose
 *                news has not been checked recently
 *
 * The sweep only *queues* those background runs and records what it queued.
 * Settings live in Admin → Settings → Automated upkeep; the console's own
 * "refresh now" buttons bypass the schedule entirely.
 */
const { getSetting, setSetting } = require('../db');
const techrefresh = require('./techrefresh');
const news = require('./news');

const DEFAULTS = {
  upkeep_on: '1',
  upkeep_tech_on: '1',
  upkeep_tech_limit: '25',
  upkeep_news_on: '1',
  upkeep_news_limit: '20',
  upkeep_news_max_age_days: '7',
};

function flag(key) {
  return getSetting(key, DEFAULTS[key]) === '1';
}

function num(key) {
  const n = parseInt(getSetting(key, DEFAULTS[key]), 10);
  return Number.isFinite(n) && n >= 0 ? n : Number(DEFAULTS[key]);
}

function settings() {
  return {
    on: flag('upkeep_on'),
    tech_on: flag('upkeep_tech_on'),
    tech_limit: num('upkeep_tech_limit'),
    news_on: flag('upkeep_news_on'),
    news_limit: num('upkeep_news_limit'),
    news_max_age_days: num('upkeep_news_max_age_days'),
    last_run: lastRun(),
  };
}

function clampInt(raw, min, max, fallback) {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function save(body = {}) {
  setSetting('upkeep_on', body.upkeep_on === '1' ? '1' : '0');
  setSetting('upkeep_tech_on', body.upkeep_tech_on === '1' ? '1' : '0');
  setSetting('upkeep_news_on', body.upkeep_news_on === '1' ? '1' : '0');
  setSetting('upkeep_tech_limit', String(clampInt(body.upkeep_tech_limit, 1, 500, Number(DEFAULTS.upkeep_tech_limit))));
  setSetting('upkeep_news_limit', String(clampInt(body.upkeep_news_limit, 1, 500, Number(DEFAULTS.upkeep_news_limit))));
  setSetting('upkeep_news_max_age_days', String(clampInt(body.upkeep_news_max_age_days, 1, 365, Number(DEFAULTS.upkeep_news_max_age_days))));
  return settings();
}

function lastRun() {
  const raw = getSetting('upkeep_last_run', '');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

let running = false;

/** True while a sweep is queuing work — the hourly ticker skips if so. */
function isRunning() {
  return running;
}

/**
 * Queue this hour's work. Never blocks on the network: the heavy lifting is
 * handed to the two background runners.
 */
async function runSweep({ force = false } = {}) {
  if (running) return { ok: false, skipped: 'already-running' };
  const s = settings();
  if (!s.on && !force) return { ok: false, skipped: 'disabled' };
  running = true;
  const out = { started_at: new Date().toISOString(), tech: null, news: null };
  try {
    if (s.tech_on || force) {
      const stale = techrefresh.staleIds(s.tech_limit);
      if (!stale.length) out.tech = { queued: 0, note: 'nothing stale' };
      else {
        const r = techrefresh.start(stale, 'auto');
        out.tech = r.ok ? { queued: stale.length } : { queued: 0, error: r.error };
      }
    }
    if (s.news_on || force) {
      const ids = news.staleListingIds({ limit: s.news_limit, maxAgeDays: s.news_max_age_days });
      if (!ids.length) out.news = { queued: 0, note: 'nothing due' };
      else {
        const r = news.start(ids, 'auto');
        out.news = r.ok ? { queued: ids.length } : { queued: 0, error: r.error };
      }
    }
  } catch (e) {
    out.error = e && e.message;
  } finally {
    running = false;
    out.finished_at = new Date().toISOString();
    setSetting('upkeep_last_run', JSON.stringify(out));
  }
  return { ok: true, ...out };
}

/** Tests and the console use this to wait for both runners to go quiet. */
async function waitForIdle({ timeoutMs = 120000, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const busy = techrefresh.jobState().running || news.jobState().running;
    if (!busy && !running) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

module.exports = { DEFAULTS, settings, save, lastRun, runSweep, isRunning, waitForIdle };
