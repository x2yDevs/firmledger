/** User workspace HTTP + optional real-browser regression audit.
 * npm run test:user-area
 * npx playwright install --with-deps chromium && npm run test:user-area:browser
 * Optional CHROMIUM_EXECUTABLE_PATH for an existing Chromium installation.
 * All writes target a disposable local DB; no production credentials/services.
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-user-area-'));
process.env.FIRMLEDGER_DATA_DIR = dataDir;
const { db } = require('../src/db');
const s = require('./helpers/user-area-seed')();
const port = 4300 + process.pid % 500;
const base = `http://127.0.0.1:${port}`;
const routes = ['', '/watchlist', '/advertise', '/settings', '/notifications', '/notifications/trash',
  '/security', '/support', '/support/new', `/support/${s.tid}`, '/listings/new',
  `/listings/${s.lid}/edit`, `/listings/${s.lid}/jobs`, '/api', '/api/playground',
  '/upgrade', '/analytics', `/leads/${s.lead}`, '/delete-account'];
const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: String(port), BASE_URL: base },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '', browser;
server.stderr.on('data', d => { log += d; });
async function request(route, who = 'owner', form) {
  const res = await fetch(base + route, {
    redirect: 'manual', method: form ? 'POST' : 'GET',
    headers: { cookie: `fl_session=${s[who].token}` },
    body: form ? new URLSearchParams({ _csrf: s[who].csrf, ...form }) : undefined,
  });
  assert.equal(res.status, form ? 302 : 200, `${route}: ${res.status}`);
  return res;
}
(async () => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + log)), 20000);
    server.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited: ' + code + log)); });
    server.stdout.on('data', d => {
      log += d;
      if (log.includes('FirmLedger running')) { clearTimeout(timer); resolve(); }
    });
  });
  // Populated owner screens plus Free-user/empty states.
  for (const who of ['owner', 'buyer']) for (const route of routes) {
    if (who === 'buyer' && /\/listings\/\d|\/support\/\d/.test(route)) continue;
    const res = await request('/dashboard' + route, who);
    const html = await res.text();
    assert.ok(html.includes('class="user-area"'), route);
    assert.ok(!html.includes('Internal Server Error'), route);
  }
  // Persisted digest preferences and notification lifecycle, through real CSRF-protected routes.
  for (const value of ['both', 'email', 'notification', 'none']) {
    await request('/dashboard/settings/leads-digest', 'owner', { leads_digest: value });
    assert.equal(db.prepare('SELECT leads_digest FROM users WHERE id=1').get().leads_digest, value);
  }
  await request('/dashboard/settings/digest', 'owner', { digest: '1' });
  assert.match(await (await request('/dashboard/settings')).text(), /Turn off/);
  await request('/dashboard/settings/digest', 'owner', { digest: '0' });
  assert.match(await (await request('/dashboard/settings')).text(), /Turn on/);
  await request('/dashboard/notifications/1/archive', 'buyer', { duration: '1week' });
  assert.ok(!db.prepare('SELECT archived_at FROM notifications WHERE id=1').get().archived_at);
  await request('/dashboard/notifications/1/archive', 'owner', { duration: '1week' });
  assert.ok(db.prepare('SELECT archived_at FROM notifications WHERE id=1').get().archived_at);
  await request('/dashboard/notifications/1/restore', 'owner', {});
  assert.ok(!db.prepare('SELECT archived_at FROM notifications WHERE id=1').get().archived_at);
  await request('/dashboard/notifications/read-all', 'owner', {});
  assert.ok(db.prepare('SELECT read_at FROM notifications WHERE id=1').get().read_at);
  await request('/dashboard/notifications/2/delete', 'buyer', {});
  assert.ok(db.prepare('SELECT id FROM notifications WHERE id=2').get());
  await request('/dashboard/notifications/2/delete', 'owner', {});
  assert.ok(!db.prepare('SELECT id FROM notifications WHERE id=2').get());
  for (const expected of [0, 1]) {
    await request('/dashboard/watchlist/toggle', 'owner', { listing_id: s.lid });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM favorites WHERE user_id=1').get().n, expected);
  }
  // Without payment credentials, checkout fails safely rather than creating a payment.
  const checkout = await request('/dashboard/advertise/checkout', 'owner', { listing_id: s.lid, package_id: 1 });
  assert.ok(checkout.headers.get('location').includes('err='));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 0);
  // Two users send messages over HTTP, and both rendered inboxes show the replies.
  for (const who of ['owner', 'buyer']) {
    await request(`/dashboard/leads/${s.lead}/reply`, who, { body: `Browser audit reply from ${who}` });
  }
  for (const who of ['owner', 'buyer']) {
    const html = await (await request(`/dashboard/leads/${s.lead}?box=${who === 'buyer' ? 'sent' : 'received'}`, who)).text();
    assert.match(html, /Browser audit reply from owner/);
    assert.match(html, /Browser audit reply from buyer/);
  }
  console.log('PASS: user routes, digest preferences, notification ownership/lifecycle and two-user replies');
  if (process.argv.includes('--browser')) {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const errors = [];
    const loginContext = await browser.newContext();
    const loginPage = await loginContext.newPage();
    await loginPage.goto(base + '/login');
    await loginPage.fill('input[name=email]', 'owner@preview.example');
    await loginPage.fill('input[name=password]', 'PreviewOnly!2026');
    await Promise.all([loginPage.waitForURL('**/dashboard'), loginPage.locator('form[action="/login"] button[type=submit]').click()]);
    await loginContext.close();
    for (const width of [320, 390, 768, 1440]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      await ctx.addCookies([{ name: 'fl_session', value: s.owner.token, url: base }]);
      const page = await ctx.newPage();
      page.on('pageerror', e => errors.push(e.message));
      for (const route of routes) {
        const res = await page.goto(base + '/dashboard' + route);
        assert.equal(res.status(), 200, route);
        await page.evaluate(() => document.fonts.ready);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${route} overflows at ${width}px`);
        if (route === '/notifications' || route === '/notifications/trash') {
          assert.ok(await page.locator('.notif-scroll').evaluate(e => e.scrollWidth <= e.clientWidth + 1), `notification content clipped at ${width}px`);
        }
        if (route === '/advertise') {
          const select = page.locator('select[name=package_id]').first();
          await select.focus();
          const style = await select.evaluate(e => ({outline: getComputedStyle(e).outlineStyle, shadow: getComputedStyle(e).boxShadow}));
          assert.equal(style.outline, 'none'); assert.equal(style.shadow, 'none');
          if (width <= 720) assert.ok(await select.evaluate(e => e.getBoundingClientRect().right <= innerWidth), 'checkout dropdown clipped');
        }
      }
      // Real form controls, persistence after navigation, and keyboard focus.
      await page.goto(base + '/dashboard/settings');
      await page.check('input[name=leads_digest][value=notification]');
      await Promise.all([page.waitForURL(/ok=/), page.locator('.pref-chan button').click()]);
      assert.ok(await page.isChecked('input[name=leads_digest][value=notification]'));
      await ctx.close();
    }
    assert.deepEqual(errors, [], 'browser JavaScript errors');
    console.log('PASS: 19 screens × 4 viewport widths; no page overflow, clipped notifications or JS errors; dropdown focus and digest form interactions');
  }
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  server.kill(); db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
