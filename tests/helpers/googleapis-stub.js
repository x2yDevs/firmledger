/**
 * Test helper — a stand-in for the `googleapis` package.
 *
 * Preload it (`node -r ./tests/helpers/googleapis-stub.js server.js`) or require
 * it before the first ping and every `require('googleapis')` resolves to this
 * stub, so the Google Indexing API integration can be exercised offline.
 *
 * Every operation is appended to `process.env.GOOGLE_STUB_LOG` (JSON lines) so
 * the test process can assert on what the app actually sent.
 *
 *   GOOGLE_STUB_LOG   file to append {kind:'auth'|'publish', …} records to
 *   GOOGLE_STUB_FAIL  substring; a URL containing it fails with HTTP 429
 */
const fs = require('fs');
const Module = require('module');

const LOG = String(process.env.GOOGLE_STUB_LOG || '').trim();
/* Read lazily so a test can flip failures on and off between calls. */
const failSubstring = () => String(process.env.GOOGLE_STUB_FAIL || '').trim();

function record(entry) {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, JSON.stringify(entry) + '\n'); } catch { /* ignore */ }
}

class GoogleAuth {
  constructor(opts) {
    this.opts = opts || {};
    record({
      kind: 'auth',
      client_email: (this.opts.credentials && this.opts.credentials.client_email) || '',
      scopes: this.opts.scopes || [],
    });
  }
}

function indexing(opts) {
  record({ kind: 'client', version: opts && opts.version, authed: Boolean(opts && opts.auth) });
  return {
    urlNotifications: {
      async publish(params) {
        const body = (params && params.requestBody) || {};
        record({ kind: 'publish', url: body.url, type: body.type });
        const fail = failSubstring();
        if (fail && String(body.url || '').includes(fail)) {
          const e = new Error('Quota exceeded for quota metric (stub: forced failure)');
          e.code = 429;
          throw e;
        }
        return {
          status: 200,
          data: {
            urlNotificationMetadata: {
              url: body.url,
              latestUpdate: { type: body.type, notifyTime: new Date().toISOString() },
            },
          },
        };
      },
    },
  };
}

const google = { auth: { GoogleAuth }, indexing, options() {} };

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'googleapis') return { google, default: { google } };
  return originalLoad.apply(this, arguments);
};

module.exports = { google };
