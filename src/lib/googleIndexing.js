/**
 * Google Indexing API — automatic submission of business listings.
 *
 * What this module does, in one breath: every time a business profile is
 * approved or updated, `pingGoogleNewListing(url)` fires the canonical listing
 * URL at Google's Indexing API (`indexing.urlNotifications.publish`) with
 * `{ url, type: 'URL_UPDATED' }` — asynchronously, in the background, so no
 * request ever waits on Google.
 *
 * Credentials (a Google Cloud service-account key) are resolved in this order:
 *
 *   1. process.env.GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON — the stringified JSON
 *      payload. This is the production path: set it in the host's environment
 *      (Render/Heroku/Vault…) and nothing sensitive ever touches the repo.
 *   2. data/service-account.json — the file an admin uploads in
 *      Admin → Settings → Google Indexing API. Saved permanently next to the
 *      database (data/ is git-ignored, so it survives deploys but never Git).
 *   3. ./service-account.json — the local development fallback. Drop the key
 *      at the repo root while hacking; it is git-ignored too.
 *
 * Quota: Google allows 200 `URL_UPDATED` notifications per day by default, so
 * the manual "submit first 200 listings" run is capped at whatever is left in
 * the rolling 24-hour window. Every URL that Google accepts is recorded in
 * `google_indexing_submissions` — a URL that has been pinged is never pinged
 * again, and the backlog queue therefore only ever contains un-submitted URLs.
 *
 * Every attempt — success or failure — is written to the indexing log with a
 * console.log / console.error line, so the outcome is visible in production
 * server logs and in Admin → Settings → Indexing log.
 */
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db, getSetting, setSetting } = require('../db');
const { siteUrl } = require('./util');
const log = require('./indexlog');

const SCOPES = ['https://www.googleapis.com/auth/indexing'];
/** Google's default daily quota for URL_UPDATED notifications. */
const DAILY_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 15000;
/** Breathing room between batch submissions — be a good API citizen. */
const BATCH_DELAY_MS = 120;

/* ------------------------------------------------------------------ paths */

function dataDir() {
  return process.env.FIRMLEDGER_DATA_DIR
    ? path.resolve(process.env.FIRMLEDGER_DATA_DIR)
    : path.join(__dirname, '..', '..', 'data');
}

/** Where an admin-uploaded key is stored permanently (inside git-ignored data/). */
function storedPath() {
  return path.join(dataDir(), 'service-account.json');
}

/** Development fallback at the repository root (git-ignored). */
function localPath() {
  return path.join(__dirname, '..', '..', 'service-account.json');
}

/* -------------------------------------------------------------- validation */

function validateCredentials(creds) {
  if (!creds || typeof creds !== 'object' || Array.isArray(creds)) {
    return { ok: false, error: 'The key is not a JSON object.' };
  }
  if (creds.type && creds.type !== 'service_account') {
    return { ok: false, error: 'That is not a service-account key (expected "type": "service_account").' };
  }
  if (!creds.client_email || !/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/i.test(String(creds.client_email))) {
    return { ok: false, error: 'The key has no valid "client_email" (expected *.iam.gserviceaccount.com).' };
  }
  if (!creds.private_key || !String(creds.private_key).includes('BEGIN PRIVATE KEY')) {
    return { ok: false, error: 'The key has no valid "private_key" (expected a PEM RSA private key).' };
  }
  return { ok: true };
}

function parseCredentials(raw, source) {
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    return { ok: false, error: `The ${source} is not valid JSON.` };
  }
  const v = validateCredentials(creds);
  if (!v.ok) return { ok: false, error: `${source}: ${v.error}` };
  return { ok: true, creds, source };
}

/**
 * Resolve the service-account credentials. Never throws, never logs secrets —
 * returns null (with a console.error) when nothing usable is configured.
 */
function loadCredentials() {
  const envRaw = String(process.env.GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON || '').trim();
  if (envRaw) {
    const r = parseCredentials(envRaw, 'GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON environment variable');
    if (r.ok) return { creds: r.creds, source: 'environment' };
    console.error('[google-indexing]', r.error, '— falling back to the saved file, if any.');
  }

  const stored = storedPath();
  if (fs.existsSync(stored)) {
    const r = parseCredentials(fs.readFileSync(stored, 'utf8'), 'saved service-account.json');
    if (r.ok) return { creds: r.creds, source: 'uploaded' };
    console.error('[google-indexing]', r.error);
  }

  const local = localPath();
  if (fs.existsSync(local)) {
    const r = parseCredentials(fs.readFileSync(local, 'utf8'), 'service-account.json');
    if (r.ok) return { creds: r.creds, source: 'file' };
    console.error('[google-indexing]', r.error);
  }

  return null;
}

/* ------------------------------------------------------------------- state */

function isEnabled() {
  return getSetting('indexing_enabled', '1') === '1'
    && getSetting('google_indexing_enabled', '1') === '1';
}

const SOURCE_LABELS = {
  environment: 'environment variable',
  uploaded: 'uploaded in Admin → Settings',
  file: 'service-account.json (local file)',
};

/** Everything Admin → Settings needs to render the Google Indexing card. */
function status() {
  const loaded = loadCredentials();
  const clientEmail = getSetting('google_sa_client_email', '');
  const projectId = getSetting('google_sa_project_id', '');
  const uploadedAt = getSetting('google_sa_uploaded_at', '');
  return {
    enabled: isEnabled(),
    configured: Boolean(loaded),
    source: loaded ? loaded.source : '',
    source_label: loaded ? (SOURCE_LABELS[loaded.source] || loaded.source) : '',
    client_email: loaded ? loaded.creds.client_email : clientEmail,
    project_id: loaded ? (loaded.creds.project_id || projectId) : projectId,
    uploaded_at: uploadedAt,
    file_saved: fs.existsSync(storedPath()),
    env_set: Boolean(String(process.env.GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON || '').trim()),
    quota: quota(),
    pending: pendingCount(),
    submitted: submittedCount(),
    last_run: lastRunSummary(),
    job: jobState(),
  };
}

/* -------------------------------------------------------------- url helpers */

/** Accepts a full URL or a site path; always returns an absolute URL (or ''). */
function absoluteUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return siteUrl(raw);
  return '';
}

function listingUrl(slug) {
  return siteUrl(`/listing/${slug}`);
}

/* ------------------------------------------------------- submission ledger */

function isSubmitted(url) {
  return Boolean(db.prepare('SELECT id FROM google_indexing_submissions WHERE url=?').get(String(url)));
}

function markSubmitted(url, listingId = null, httpStatus = 0, response = '') {
  db.prepare(
    `INSERT INTO google_indexing_submissions (url, listing_id, http_status, response)
     VALUES (?,?,?,?)
     ON CONFLICT(url) DO UPDATE SET
       http_status = excluded.http_status,
       response = excluded.response,
       attempts = google_indexing_submissions.attempts + 1,
       updated_at = datetime('now')`
  ).run(String(url), listingId || null, Number(httpStatus) || 0, String(response || '').slice(0, 300));
}

function submittedCount() {
  return db.prepare('SELECT COUNT(*) c FROM google_indexing_submissions').get().c;
}

/** Google meters the 200/day quota on a rolling window, so count the last 24h. */
function usedLast24h() {
  return db.prepare(
    "SELECT COUNT(*) c FROM google_indexing_submissions WHERE created_at >= datetime('now','-24 hours')"
  ).get().c;
}

function quota() {
  const used = usedLast24h();
  return { limit: DAILY_LIMIT, used, remaining: Math.max(0, DAILY_LIMIT - used) };
}

function pendingCount() {
  const submitted = new Set(
    db.prepare('SELECT url FROM google_indexing_submissions').all().map((r) => r.url)
  );
  const rows = db.prepare("SELECT slug FROM listings WHERE status='approved'").all();
  return rows.filter((r) => !submitted.has(listingUrl(r.slug))).length;
}

/** Approved listings whose URL Google has never been sent, oldest first. */
function pendingListings(limit = DAILY_LIMIT) {
  const submitted = new Set(
    db.prepare('SELECT url FROM google_indexing_submissions').all().map((r) => r.url)
  );
  const rows = db.prepare(
    "SELECT id, slug, name FROM listings WHERE status='approved' ORDER BY featured DESC, id ASC"
  ).all();
  const out = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    const url = listingUrl(r.slug);
    if (submitted.has(url)) continue; // pinged once → never appears again
    out.push({ id: r.id, slug: r.slug, name: r.name, url });
  }
  return out;
}

/* ------------------------------------------------------------ error shapes */

function errStatus(e) {
  return Number(
    (e && (e.code || (e.response && e.response.status) || (e.status))) || 0
  ) || 0;
}

function errMessage(e) {
  if (!e) return 'unknown error';
  const parts = [];
  if (e.message) parts.push(String(e.message));
  try {
    const data = e.response && e.response.data;
    if (data && data.error && data.error.message) parts.push(String(data.error.message));
    else if (data && typeof data === 'string') parts.push(data.slice(0, 200));
  } catch { /* ignore */ }
  const msg = parts.filter(Boolean).join(' — ').slice(0, 300) || 'unknown error';
  if (errStatus(e) === 429) return `${msg} (Google daily quota reached — try again in 24h)`;
  return msg;
}

function requireGoogleApis() {
  // Required lazily: the site must boot fine even if the package is absent.
  // eslint-disable-next-line global-require
  return require('googleapis');
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`request timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/* ------------------------------------------------------------- the pinger */

/**
 * Submit one URL to Google's Indexing API.
 *
 * Background by design: call it without `await` to fire-and-forget (the promise
 * never rejects), or await it when you need the result (the batch runner does).
 *
 * @param {string} url  absolute URL, or a site path such as /listing/acme-ltd
 * @returns {Promise<{ok: boolean, url: string, status?: number, error?: string, skipped?: boolean}>}
 */
async function pingGoogleNewListing(url) {
  const target = absoluteUrl(url);

  if (!target) {
    console.error(`[google-indexing] refused to submit an invalid target URL: ${JSON.stringify(url)}`);
    return { ok: false, url: String(url || ''), error: 'invalid url' };
  }

  if (!isEnabled()) {
    console.log(`[google-indexing] indexing is switched off — skipped ${target}`);
    return { ok: false, url: target, skipped: true, error: 'disabled' };
  }

  const loaded = loadCredentials();
  if (!loaded) {
    /* Not a failure as such — an installation that has never wired Google up is
       simply a no-op. Admin → Settings already shows "Not configured", so this
       is logged once per ping as info and kept out of the indexing log (which is
       reserved for real attempts and real errors). */
    const msg = 'no service-account key configured — set GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON or upload one in Admin → Settings';
    console.log(`[google-indexing] skipped ${target} — ${msg}`);
    return { ok: false, url: target, skipped: true, error: msg };
  }

  try {
    const { google } = requireGoogleApis();

    // Authenticate with the service account: env string (parsed) → uploaded
    // file → local service-account.json, resolved by loadCredentials() above.
    const auth = new google.auth.GoogleAuth({
      credentials: {
        type: 'service_account',
        client_email: loaded.creds.client_email,
        private_key: loaded.creds.private_key,
        project_id: loaded.creds.project_id || undefined,
        client_id: loaded.creds.client_id || undefined,
        private_key_id: loaded.creds.private_key_id || undefined,
        client_x509_cert_url: loaded.creds.client_x509_cert_url || undefined,
      },
      scopes: SCOPES,
    });

    const indexing = google.indexing({ version: 'v3', auth });

    const res = await withTimeout(
      indexing.urlNotifications.publish({
        requestBody: { url: target, type: 'URL_UPDATED' },
      }),
      REQUEST_TIMEOUT_MS
    );

    const status = Number((res && res.status) || 200);
    console.log(`[google-indexing] submitted ${target} — status ${status}`);
    log.add({ channel: 'google', url: target, ok: true, status, message: 'URL_UPDATED accepted' });
    markSubmitted(target, null, status, JSON.stringify(res && res.data ? res.data : {}).slice(0, 300));
    return { ok: true, url: target, status, data: res && res.data };
  } catch (e) {
    const status = errStatus(e);
    const msg = errMessage(e);
    console.error(`[google-indexing] FAILED to submit ${target} — ${msg}${status ? ` (status ${status})` : ''}`);
    log.add({ channel: 'google', url: target, ok: false, status, message: msg });
    return { ok: false, url: target, status, error: msg };
  }
}

/**
 * Fire-and-forget wrapper — the name controllers use when they must not wait:
 *   pingGoogleNewListingBackground(siteUrl('/listing/acme-ltd'));
 * Never throws and never rejects.
 */
function pingGoogleNewListingBackground(url) {
  try {
    const p = pingGoogleNewListing(url);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {
    console.error(`[google-indexing] background ping for ${url} failed to start:`, e && e.message);
  }
  return undefined;
}

/* --------------------------------------------------- batch: first 200 URLs */

let job = null;

function jobState() {
  if (!job) return { running: false };
  return {
    running: job.status === 'running',
    status: job.status,
    total: job.total,
    done: job.done,
    ok: job.ok,
    failed: job.failed,
    errors: job.errors.slice(0, 5),
    started_at: job.started_at,
    finished_at: job.finished_at,
  };
}

function lastRunSummary() {
  const raw = getSetting('google_submit_last_summary', '');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Submit the first `limit` listings Google has never seen (default 200 — the
 * daily quota). Runs in the background; poll jobState() for progress.
 */
function startBatch(limit = DAILY_LIMIT) {
  if (job && job.status === 'running') {
    return { ok: false, error: 'A submission run is already in progress.', job: jobState() };
  }
  const max = Math.max(1, Math.min(DAILY_LIMIT, Number(limit) || DAILY_LIMIT));
  job = {
    status: 'running',
    total: 0, done: 0, ok: 0, failed: 0,
    errors: [],
    started_at: new Date().toISOString(),
    finished_at: '',
  };
  runBatch(max).catch((e) => {
    console.error('[google-indexing] batch run crashed:', e && e.message);
    if (job) { job.status = 'error'; job.finished_at = new Date().toISOString(); }
  });
  return { ok: true, job: jobState() };
}

async function runBatch(max) {
  const q = quota();
  const budget = Math.min(max, q.remaining);
  const queue = budget > 0 ? pendingListings(budget) : [];

  job.total = queue.length;
  console.log(`[google-indexing] batch run started — ${queue.length} url(s), ${q.remaining} of ${q.limit} quota left in the last 24h`);

  if (!queue.length) {
    job.status = 'done';
    job.finished_at = new Date().toISOString();
    const summary = {
      ok: 0, failed: 0, attempted: 0, remaining: q.remaining,
      finished_at: job.finished_at,
      note: budget === 0 ? 'quota-exhausted' : 'nothing-pending',
    };
    setSetting('google_submit_last_summary', JSON.stringify(summary));
    return summary;
  }

  for (const item of queue) {
    const r = await pingGoogleNewListing(item.url);
    job.done += 1;
    if (r.ok) job.ok += 1;
    else {
      job.failed += 1;
      if (job.errors.length < 5) job.errors.push(`${item.url} — ${r.error || 'failed'}`);
      // 429 = Google's daily quota is gone; stop burning requests.
      if (r.status === 429) {
        job.errors.push('Stopped: Google returned 429 (daily quota reached).');
        break;
      }
    }
    if (job.done < queue.length) await sleep(BATCH_DELAY_MS);
  }

  job.status = 'done';
  job.finished_at = new Date().toISOString();
  const summary = {
    attempted: job.done, ok: job.ok, failed: job.failed,
    remaining: quota().remaining,
    finished_at: job.finished_at,
    errors: job.errors.slice(0, 5),
  };
  setSetting('google_submit_last_summary', JSON.stringify(summary));
  console.log(`[google-indexing] batch run finished — ${job.ok} submitted, ${job.failed} failed, ${summary.remaining} quota left`);
  return summary;
}

/* ------------------------------------------- service-account file handling */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1 },
});

/** Multer middleware that turns upload errors into `req.uploadError`. */
function serviceAccountField(field = 'service_account') {
  const single = upload.single(field);
  return (req, res, next) => {
    single(req, res, (err) => {
      if (err) {
        req.uploadError = err.code === 'LIMIT_FILE_SIZE'
          ? 'That file is too large — the service-account key must be under 1 MB.'
          : err.message;
      }
      next();
    });
  };
}

/**
 * Validate and permanently store an uploaded/pasted service-account key.
 * Only non-secret metadata (client email, project id) is kept in settings.
 */
function saveServiceAccount(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: 'Choose a service-account.json file or paste its contents.' };

  const r = parseCredentials(text, 'service-account key');
  if (!r.ok) return { ok: false, error: r.error };

  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(storedPath(), JSON.stringify(r.creds, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('[google-indexing] could not save the service-account file:', e && e.message);
    return { ok: false, error: `Could not save the key on the server: ${e && e.message}` };
  }

  setSetting('google_sa_client_email', r.creds.client_email);
  setSetting('google_sa_project_id', String(r.creds.project_id || ''));
  setSetting('google_sa_uploaded_at', new Date().toISOString());
  console.log(`[google-indexing] service account saved — ${r.creds.client_email}`);
  return { ok: true, client_email: r.creds.client_email, project_id: r.creds.project_id || '' };
}

/** Forget the saved key (the environment variable, if set, still wins). */
function removeServiceAccount() {
  try { fs.unlinkSync(storedPath()); } catch { /* already gone */ }
  setSetting('google_sa_client_email', '');
  setSetting('google_sa_project_id', '');
  setSetting('google_sa_uploaded_at', '');
  console.log('[google-indexing] saved service account removed');
  return { ok: true };
}

module.exports = {
  DAILY_LIMIT,
  SCOPES,
  isEnabled,
  status,
  loadCredentials,
  validateCredentials,
  absoluteUrl,
  listingUrl,
  pingGoogleNewListing,
  pingGoogleNewListingBackground,
  isSubmitted,
  markSubmitted,
  submittedCount,
  pendingCount,
  pendingListings,
  quota,
  usedLast24h,
  startBatch,
  jobState,
  lastRunSummary,
  saveServiceAccount,
  removeServiceAccount,
  serviceAccountField,
  storedPath,
  localPath,
};
