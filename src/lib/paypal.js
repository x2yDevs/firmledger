/* PayPal integration — Orders v2 REST API.
   https://developer.paypal.com/api/rest/ | https://developer.paypal.com/docs/api/orders/v2/

   Credentials come from env (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET) or admin
   Settings (paypal_client_id / paypal_client_secret); env wins. Sandbox mode
   (PAYPAL_MODE=sandbox, the default) uses api-m.sandbox.paypal.com with zero
   real money; set mode=live with live credentials to go into production. */

const { getSetting } = require('../db');

function clientId() {
  return process.env.PAYPAL_CLIENT_ID || getSetting('paypal_client_id', '');
}
function clientSecret() {
  return process.env.PAYPAL_CLIENT_SECRET || getSetting('paypal_client_secret', '');
}
function mode() {
  const m = (process.env.PAYPAL_MODE || getSetting('paypal_mode', 'sandbox') || 'sandbox').toLowerCase();
  return m === 'live' ? 'live' : 'sandbox';
}
function configured() {
  return Boolean(clientId() && clientSecret());
}
function base() {
  return mode() === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

async function http(path, opts = {}) {
  const res = await fetch(base() + path, {
    ...opts,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data, http: res.status };
}

/* OAuth2 client-credential token (cached briefly per process). */
let _token = { value: '', expiresAt: 0 };
async function accessToken() {
  if (_token.value && Date.now() < _token.expiresAt - 30000) return _token.value;
  const res = await fetch(base() + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const e = new Error(data.error_description || data.error || `PayPal auth failed (HTTP ${res.status})`);
    e.statusCode = res.status;
    throw e;
  }
  _token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 300) * 1000 };
  return _token.value;
}

async function authed(path, opts = {}) {
  const token = await accessToken();
  return http(path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

/* Format cents → PayPal's decimal string for a currency (2dp majors). */
function decimal(cents) {
  return (Number(cents) / 100).toFixed(2);
}

/* Create an order for one Pro plan. Returns { ok, id, approveUrl, error }. */
async function createOrder({ reference, plan, returnUrl, cancelUrl, payerEmail = '' }) {
  const r = await authed('/v2/checkout/orders', {
    method: 'POST',
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: reference,
        custom_id: reference,
        amount: { currency_code: plan.currency, value: decimal(plan.price_cents) },
        description: `${plan.name} — FirmLedger subscription (${plan.duration_days} days)`.slice(0, 127),
      }],
      payer: payerEmail ? { email_address: payerEmail } : undefined,
      application_context: {
        brand_name: 'FirmLedger',
        user_action: 'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    }),
  });
  if (!r.ok || !r.data || !r.data.id) {
    return { ok: false, id: '', approveUrl: '', error: (r.data && (r.data.message || r.data.name)) || `HTTP ${r.http}` };
  }
  const approveUrl = (r.data.links || []).filter((l) => l.rel === 'approve').map((l) => l.href)[0] || '';
  return { ok: true, id: r.data.id, approveUrl, error: '' };
}

/* Capture an approved order, then verify the money server-side
   (status COMPLETED + exact amount + currency + our reference). */
async function captureOrder(orderId, { reference, plan }) {
  const r = await authed(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  const d = r.data || {};
  if (!r.ok) {
    return { ok: false, reason: d.message || d.name || `HTTP ${r.http}`, channel: 'paypal', payer: {} };
  }
  const unit = (d.purchase_units || [])[0] || {};
  const capture = ((unit.payments || {}).captures || [])[0] || {};
  const amountOk = d.status === 'COMPLETED' && capture.status === 'COMPLETED'
    && capture.amount
    && decimal(plan.price_cents) === capture.amount.value
    && (capture.amount.currency_code || '').toUpperCase() === plan.currency.toUpperCase();
  const refOk = !reference || capture.custom_id === reference || unit.reference_id === reference;
  const passed = amountOk && refOk;
  return {
    ok: passed,
    reason: passed ? '' : `status=${d.status}/${capture.status} amount=${capture.amount && capture.amount.value} ${capture.amount && capture.amount.currency_code} ref-match=${refOk}`,
    channel: 'paypal',
    paidAt: capture.create_time || d.create_time || null,
    payer: {
      email: (d.payer && d.payer.email_address) || '',
      name: d.payer && d.payer.name ? [d.payer.name.given_name, d.payer.name.surname].filter(Boolean).join(' ') : '',
      payerId: (d.payer && d.payer.payer_id) || '',
    },
  };
}

/* Look up an existing order (status, no money moved) — admin diagnostics. */
async function getOrder(orderId) {
  return authed(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}

module.exports = { clientId, mode, configured, decimal, createOrder, captureOrder, getOrder };
