/**
 * FirmLedger — admin console page smoke test.
 *
 *   node tests/admin-pages.test.js
 *
 * Boots the real server against a throwaway database, seeds enough records for
 * every queue to have rows, signs in with a directly-minted admin session, then
 * fetches every admin page and asserts:
 *   • it renders (HTTP 200, no error page), and
 *   • the long list on that page sits inside a scroll region, so the console
 *     never turns into an extra-tall page.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-pages-'));
const PORT = 3999 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;

const env = {
  ...process.env,
  FIRMLEDGER_DATA_DIR: dataDir,
  PORT: String(PORT),
  BASE_URL: `http://127.0.0.1:${PORT}`,
  ADMIN_SECRET: 'smoke-test-secret',
  SMTP_URL: 'smtp://user:pass@smtp.example.test:587',
  STATUS_UPDATE_INTERVAL: '3600',
};

/* ----------------------------------------------------------- seed + session */
const token = 'smoke' + crypto.randomBytes(16).toString('hex');
const csrf = crypto.randomBytes(12).toString('hex');

const seed = `
process.env.FIRMLEDGER_DATA_DIR = ${JSON.stringify(dataDir)};
const { db, setSetting } = require(${JSON.stringify(path.join(ROOT, 'src/db.js'))});
const run = (sql, ...p) => db.prepare(sql).run(...p);

const uid = run("INSERT INTO users (email,password_hash,name,plan,plan_expires_at) VALUES ('smoke@example.com','$2a$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','Smoke User','free','')").lastInsertRowid;
run("UPDATE users SET trial_expires_at = datetime('now','+7 days') WHERE id=?", uid);
const lid = run(\`INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,status,owner_user_id,sponsored)
  VALUES ('smoke-co','Smoke Co','Smoke tagline','Smoke Co is a seeded listing for the admin page smoke test suite.','company','Technology','https://smoke.example','hi@smoke.example','Kenya','pending',?,1)\`, uid).lastInsertRowid;
const lid2 = run(\`INSERT INTO listings (slug,name,tagline,description,type,category,website,email,country,status,sponsored,sponsored_expires_at)
  VALUES ('smoke-sponsored','Smoke Sponsored','Sponsored tagline','A seeded approved + sponsored listing so the advertising queue has rows.','company','Technology','https://sponsored.example','ads@smoke.example','Kenya','approved',1,'')\`).lastInsertRowid;
run("INSERT INTO claims (listing_id,user_id,method,domain,token,status) VALUES (?,?,'dns','smoke.example','tok','pending')", lid, uid);
run("INSERT INTO removal_requests (listing_id,name,email,reason,status) VALUES (?,'Smoke','legal@smoke.example','Closed','pending')", lid);
const tid = run("INSERT INTO tickets (user_id,ref,subject,category,status) VALUES (?,'FL-SMOKE','Need help','account','open')", uid).lastInsertRowid;
run("INSERT INTO ticket_messages (ticket_id,sender,body) VALUES (?,'user','Hello there')", tid);
run("INSERT INTO promo_codes (code,percent,max_uses,active) VALUES ('SMOKE',10,5,1)");
run("INSERT INTO careers (title,role_type,location,description,requirements,apply_email,status) VALUES ('Smoke Role','Full-time','Nairobi','A description long enough for the seed.','Some requirements.','careers@firmledger.co.ke','open')");
run("INSERT INTO blog_posts (slug,title,excerpt,body,status) VALUES ('smoke-post','Smoke Post','Excerpt','Body','published')");
run("INSERT INTO spam_ip (value,kind,note) VALUES ('203.0.113.5','block','seed')");
run("INSERT INTO spam_domain (value,kind,note) VALUES ('smoke-spam.example','block','seed')");
run("INSERT INTO admin_mail_log (to_email,subject,body,delivered) VALUES ('smoke@example.com','Seeded send','Body',1)");
run("INSERT INTO payments (listing_id,user_id,plan_id,duration_days,order_id,reference,amount,currency,status,channel,email) VALUES (NULL,?,1,30,'ORD-1','REF-SMOKE-1',1500,'USD','success','paypal','smoke@example.com')", uid);
run("INSERT INTO deletion_requests (user_id,reason,status) VALUES (?,'Leaving','pending')", uid);
run("INSERT INTO pro_transfer_requests (user_id,from_listing_id,to_listing_id,status) VALUES (?,?,?,'pending')", uid, lid, lid);
run("INSERT INTO notifications (audience,user_id,kind,title,body,url) VALUES ('admin',NULL,'system','Seeded','Body','/')");
try { run("INSERT INTO incidents (title,description,status,severity) VALUES ('Seeded incident','Something happened','investigating','minor')"); } catch (e) {}
try { run("INSERT INTO incident_updates (incident_id,status,message) VALUES (1,'investigating','Looking into it')"); } catch (e) {}
try { run("INSERT INTO ad_packages (name,blurb,price_cents,duration_days,active,sort) VALUES ('Smoke Package','Seeded',9900,30,1,1)"); } catch (e) {}
setSetting('paypal_client_id','seed');

run("INSERT INTO sessions (token,user_id,csrf,kind,expires_at) VALUES (?,NULL,?, 'admin', datetime('now','+1 day'))", ${JSON.stringify(token)}, ${JSON.stringify(csrf)});
console.log('seeded');
`;

require('child_process').execFileSync(process.execPath, ['-e', seed], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });

/* ----------------------------------------------------------- boot */
const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`).catch(() => fetch(BASE));
      if (res) return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return false;
}

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/* page → how many scroll regions its long lists must sit in */
const PAGES = [
  ['/admin3119Musa/dashboard', 0, 'Dashboard'],
  ['/admin3119Musa/listings', 1, 'Listings'],
  ['/admin3119Musa/claims', 1, 'Ownership claims'],
  ['/admin3119Musa/users', 1, 'Users'],
  ['/admin3119Musa/categories', 1, 'Categories'],
  ['/admin3119Musa/pricing', 1, 'Pricing — free trials'],
  ['/admin3119Musa/advertising', 2, 'Advertising — sponsored'],
  ['/admin3119Musa/careers', 1, 'Careers — roles'],
  ['/admin3119Musa/incidents', 1, 'Status — recent incidents'],
  ['/admin3119Musa/promos', 1, 'Promos — codes'],
  ['/admin3119Musa/protection', 2, 'Protection — IP + domain rules'],
  ['/admin3119Musa/health', 1, 'Health — mail hops'],
  ['/admin3119Musa/removals', 1, 'Removal requests'],
  ['/admin3119Musa/tickets', 1, 'Support tickets'],
  ['/admin3119Musa/email', 1, 'Email — recent sends'],
  ['/admin3119Musa/blog', 1, 'Blog posts'],
  ['/admin3119Musa/settings', 1, 'Settings — recent Pro payments'],
  ['/admin3119Musa/notifications', 0, 'Notifications'],
  ['/admin3119Musa/ai', 0, 'AI Playground'],
  ['/admin3119Musa/plans', 0, 'Plans'],
  ['/admin3119Musa/search?q=smoke', 0, 'Admin search'],
];

(async function main() {
  console.log('FirmLedger admin page smoke test\n');
  const up = await waitForServer();
  if (!up) {
    console.log('server did not start:\n' + serverLog.slice(-2000));
    server.kill('SIGKILL');
    process.exit(1);
  }

  for (const [url, regions, label] of PAGES) {
    let res; let html = '';
    try {
      res = await fetch(BASE + url, { headers: { cookie: `fl_admin=${token}` }, redirect: 'manual' });
      html = await res.text();
    } catch (e) {
      check(label, false, 'request failed: ' + e.message);
      continue;
    }
    const ok = res.status === 200 && !/<h1>Server error|<h1>Security check failed|<h1>Page not found/i.test(html);
    check(`${label} renders`, ok, `HTTP ${res.status}`);
    if (!ok) continue;
    if (regions > 0) {
      const found = (html.match(/class="(?:scroll-table|scroll-panel|notif-scroll)"/g) || []).length;
      check(`${label} list is scrollable`, found >= regions, `found ${found} scroll region(s), expected ${regions}`);
    }
  }

  /* the notifications inbox that everything else is modelled on */
  const notif = await (await fetch(BASE + '/admin3119Musa/notifications', { headers: { cookie: `fl_admin=${token}` } })).text();
  check('notifications inbox still uses its contained scroller', /notif-scroll/.test(notif));

  console.log(`\n${'='.repeat(64)}`);
  console.log(`checks passed: ${passed}   failed: ${failures.length}`);
  failures.forEach((f) => console.log('  • ' + f));
  if (failures.length) console.log('\nserver log tail:\n' + serverLog.slice(-1500));
  console.log('='.repeat(64));

  server.kill('SIGKILL');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
})();
