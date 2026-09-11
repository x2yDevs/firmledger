/**
 * Leads contact flow — the “Contact this business” journey, end to end.
 * npm run test:leads-contact
 *
 * Every check below is a regression guard for a defect that was reproduced
 * against the running app before it was fixed. All of it drives the REAL
 * server over HTTP with signed-in sessions, CSRF and redirects, exactly like a
 * browser:
 *
 *   1. Reachability — a “Contact this business” button exists only where a
 *      live owner account can actually read the inquiry. An unclaimed listing,
 *      an owner-less listing and a SUSPENDED owner show an honest notice
 *      instead of a form that posts into nothing.
 *   2. Nothing typed is ever lost — over-long messages are refused with the
 *      real numbers (never silently truncated), and every bounce hands the
 *      member's name/phone/subject/message back to the form.
 *   3. Identity — the account email is always used, a typed name is honoured
 *      (so a one-letter profile name is not a permanent dead end), and a
 *      spoofed body email neither reaches the business nor slips past the
 *      domain blocklist.
 *   4. Double-submit — the same inquiry twice reuses one thread and sends the
 *      business exactly one email and one notification.
 *   5. Unread state — both sides get an honest badge, cleared by reading, and
 *      a reply to an archived thread pulls it back into the owner's inbox.
 *   6. Flood control — repeated and burst replies are refused per thread.
 *   7. Dead ends — after the member deletes their copy the business is told,
 *      loses the reply box, and any stored note reports itself undelivered.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-leads-contact-'));
process.env.FIRMLEDGER_DATA_DIR = dataDir;
const { db } = require('../src/db');
const bcrypt = require('bcryptjs');

/* The mailer appends to <repo>/data/outbox.log when no SMTP is configured.
   The file is shared across suites, so counts are deltas from this run's start. */
const OUTBOX = path.join(__dirname, '..', 'data', 'outbox.log');
const outboxRaw = (email) => {
  try {
    return fs.readFileSync(OUTBOX, 'utf8').split('\n').filter((l) => l.includes(` TO=${email}`)).length;
  } catch { return 0; }
};
const outboxBase = {};
/* Start (or restart) counting this address from now — each section measures its
   own delta, so mail sent by an earlier section never leaks into the next. */
function rebase(email) { outboxBase[email] = outboxRaw(email); }
function outboxCount(email) {
  if (!(email in outboxBase)) rebase(email);
  return outboxRaw(email) - outboxBase[email];
}
function settle(ms = 400) { return new Promise((r) => setTimeout(r, ms)); }
/* Mail is sent fire-and-forget; give it a moment to land before asserting. */
function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (fn()) return resolve(true);
      if (Date.now() - t0 > ms) return resolve(fn());
      setTimeout(tick, 100);
    };
    tick();
  });
}

/* ---------- seed ---------- */
db.prepare("INSERT INTO settings(key,value) VALUES('upkeep_on','0') ON CONFLICT(key) DO NOTHING").run();
const mkUser = (email, name, plan) => Number(db.prepare(
  `INSERT INTO users(email,password_hash,name,plan,plan_expires_at,trial_expires_at,leads_digest)
   VALUES(?,?,?,?,?,'','none')`
).run(email, bcrypt.hashSync('ContactOnly!2026', 10), name, plan || 'free', plan === 'pro' ? '2099-01-01' : '').lastInsertRowid);

const owner = mkUser('owner@contact.example', 'Sunrise Cleaners', 'pro');
const buyer = mkUser('buyer@contact.example', 'Jane Wanjiku', 'free');
/* A member whose profile name is a single letter — the old code took the
   account name unconditionally and locked this person out for good. */
const shortName = mkUser('short@contact.example', 'J', 'free');
const suspendedOwner = mkUser('suspended@contact.example', 'Suspended Co', 'pro');

const mkListing = (slug, name, opts = {}) => Number(db.prepare(
  `INSERT INTO listings(slug,name,description,category,country,city,website,status,claimed,owner_user_id)
   VALUES(?,?,?,'Cleaning Services','Kenya','Nairobi','https://x.example',?,?,?)`
).run(slug, name, 'A verified company record used by the contact-flow suite.',
  opts.status || 'approved', opts.claimed === undefined ? 1 : opts.claimed, opts.owner || null).lastInsertRowid);

const claimedId = mkListing('cf-cleaners', 'CF Cleaners', { owner });
mkListing('cf-unclaimed', 'CF Unclaimed', { claimed: 0 });
mkListing('cf-ownerless', 'CF Ownerless', { claimed: 1, owner: null });
mkListing('cf-suspended', 'CF Suspended', { owner: suspendedOwner });
db.prepare('UPDATE users SET suspended=1 WHERE id=?').run(suspendedOwner);

const { createSession } = require('../src/lib/session');
const s = {
  owner: createSession(owner, 'user'),
  buyer: createSession(buyer, 'user'),
  short: createSession(shortName, 'user'),
};

const port = 5600 + process.pid % 300;
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: String(port), BASE_URL: base },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stderr.on('data', (d) => { log += d; });

let passed = 0;
function check(label, ok, extra = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); return; }
  console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  process.exitCode = 1;
}

async function call(route, who = null, form = null) {
  const headers = {};
  if (who) headers.cookie = `fl_session=${s[who].token}`;
  return fetch(base + route, {
    redirect: 'manual',
    method: form ? 'POST' : 'GET',
    headers,
    body: form ? new URLSearchParams(form) : undefined,
  });
}
const loc = (res) => decodeURIComponent(res.headers.get('location') || '');
const text = async (route, who) => (await call(route, who)).text();
const lastLead = () => db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 1').get();
const leadCount = () => db.prepare('SELECT COUNT(*) c FROM leads').get().c;

(async () => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + log)), 20000);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Server exited: ' + code + log)); });
    server.stdout.on('data', (d) => {
      log += d;
      if (log.includes('FirmLedger running')) { clearTimeout(timer); resolve(); }
    });
  });

  console.log('Contact flow — a listing only offers contact when someone can answer');
  {
    const live = await text('/listing/cf-cleaners', 'buyer');
    check('claimed listing with a live owner shows the form', live.includes('class="form lead-form"'));

    /* The header CTA is the anchor button, not the panel heading of the same name. */
    const ctaButton = /class="btn btn-primary" href="[^"]*contact-business"/;
    check('the reachable listing renders the header CTA button', ctaButton.test(live));
    for (const [slug, label] of [['cf-unclaimed', 'unclaimed'], ['cf-ownerless', 'owner-less'], ['cf-suspended', 'suspended-owner']]) {
      const html = await text(`/listing/${slug}`, 'buyer');
      check(`${label} listing shows no contact form`, !html.includes('class="form lead-form"'));
      check(`${label} listing shows no contact CTA button`, !ctaButton.test(html));
    }
    const susp = await text('/listing/cf-suspended', 'buyer');
    check('suspended-owner listing explains itself', susp.includes('not accepting inquiries'));

    /* The POST must refuse them too — the form is not the only way in. */
    const before = leadCount();
    for (const slug of ['cf-unclaimed', 'cf-ownerless', 'cf-suspended']) {
      const r = await call(`/listing/${slug}/leads`, 'buyer', {
        _csrf: s.buyer.csrf, subject: 'Quote', message: 'Please send me a quotation for weekly cleaning.',
      });
      check(`POST to ${slug} is refused`, r.status === 302 && /cannot receive inquiries|not accepting inquiries/.test(loc(r)));
    }
    check('no unreachable listing stored a lead', leadCount() === before);
    /* A suspended owner must never be reachable — that lead would be unread forever. */
    check('suspended owner has no leads at all',
      db.prepare('SELECT COUNT(*) c FROM leads WHERE owner_user_id=?').get(suspendedOwner).c === 0);
  }

  console.log('Contact flow — nothing the member types is lost');
  {
    const long = 'A very detailed brief sentence about the work required. '.repeat(80); // ~4.4k
    const r = await call('/listing/cf-cleaners/leads', 'buyer', {
      _csrf: s.buyer.csrf, subject: 'Long brief', message: long,
    });
    check('over-long message is REFUSED, not silently truncated',
      r.status === 302 && /shorten it to/.test(loc(r)));
    check('over-long message quotes the real length', /4,\d\d\d characters/.test(loc(r)));
    check('over-long message stored nothing', leadCount() === 0);

    const short = await call('/listing/cf-cleaners/leads', 'buyer', {
      _csrf: s.buyer.csrf, phone: '+254 700 111 222', subject: 'Office cleaning quote',
      message: 'hi',
    });
    check('too-short message bounces', short.status === 302 && /at least 10 characters/.test(loc(short)));
    const bounced = loc(short);
    check('bounce carries the subject back', bounced.includes('lead_subject=Office cleaning quote'));
    check('bounce carries the phone back', bounced.includes('lead_phone=+254 700 111 222'));
    check('bounce carries the message back', bounced.includes('lead_message=hi'));

    /* …and the page actually re-renders them into the form. */
    const refilled = await text(`/listing/cf-cleaners?${short.headers.get('location').split('?')[1].replace('#contact-business', '')}`, 'buyer');
    check('the form is re-rendered with the typed subject', refilled.includes('value="Office cleaning quote"'));
    check('the form is re-rendered with the typed phone', refilled.includes('value="+254 700 111 222"'));

    /* A message right on the ceiling is accepted whole. */
    const exact = 'x'.repeat(4000);
    const okRes = await call('/listing/cf-cleaners/leads', 'buyer', {
      _csrf: s.buyer.csrf, subject: 'Exactly at the limit', message: exact,
    });
    check('a message at exactly the limit is accepted', okRes.status === 302 && /lead_sent=1/.test(loc(okRes)));
    const stored = lastLead();
    check('and is stored in full, not cut to 2000', stored.message.length === 4000);
    check('the thread copy is complete too',
      db.prepare('SELECT body FROM lead_messages WHERE lead_id=? ORDER BY id').get(stored.id).body.length === 4000);
    db.prepare('DELETE FROM leads').run();
  }

  console.log('Contact flow — identity is the account, not the form');
  {
    const r = await call('/listing/cf-cleaners/leads', 'buyer', {
      _csrf: s.buyer.csrf,
      name: 'Jane Wanjiku, Facilities',
      email: 'spoofed@evil.example',
      phone: '+254 700 000 001',
      subject: 'Office cleaning quote',
      message: 'We need our 12-desk office cleaned twice a week. Could you send a quote?',
    });
    check('inquiry accepted', r.status === 302 && /lead_sent=1/.test(loc(r)));
    const lead = lastLead();
    check('the account email is used, never the typed one', lead.email === 'buyer@contact.example');
    check('the typed name is honoured', lead.name === 'Jane Wanjiku, Facilities');
    check('the lead starts unread for the business', lead.owner_unread === 1 && lead.inquirer_unread === 0);

    /* A one-letter profile name used to be an inescapable dead end. */
    const dead = await call('/listing/cf-cleaners/leads', 'short', {
      _csrf: s.short.csrf, subject: 'Quote', message: 'My profile name is a single letter — can I still write?',
    });
    check('a one-letter profile name alone is still refused', dead.status === 302 && /Tell the business your name/.test(loc(dead)));
    check('the refusal explains how to fix it', /name field|profile/.test(loc(dead)));
    const rescued = await call('/listing/cf-cleaners/leads', 'short', {
      _csrf: s.short.csrf, name: 'Joseph Kamau', subject: 'Quote',
      message: 'Typing my full name in the form must be enough to reach the business.',
    });
    check('typing a real name in the form gets through', rescued.status === 302 && /lead_sent=1/.test(loc(rescued)));
    check('the typed name is what the business sees', lastLead().name === 'Joseph Kamau');
  }

  console.log('Contact flow — the domain blocklist follows the real sender');
  {
    db.prepare("INSERT INTO spam_domain(value,kind,note) VALUES('contact.example','block','contact-flow suite')").run();
    const before = leadCount();
    const evade = await call('/listing/cf-cleaners/leads', 'buyer', {
      _csrf: s.buyer.csrf, email: 'clean@allowed.example',
      subject: 'Bypass attempt', message: 'My account domain is blocked but I typed a clean address.',
    });
    check('a blocked ACCOUNT domain is refused even with a clean typed email', evade.status === 403);
    check('the bypass stored nothing', leadCount() === before);
    db.prepare("DELETE FROM spam_domain WHERE value='contact.example'").run();
  }

  console.log('Contact flow — a double-submit is one conversation');
  {
    db.prepare('DELETE FROM leads').run();
    await settle();
    rebase('owner@contact.example');
    const notifBefore = db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND kind='lead'").get(owner).c;
    const body = {
      _csrf: s.buyer.csrf, subject: 'Double click',
      message: 'The send button was double-clicked, this must not open two threads.',
    };
    const first = await call('/listing/cf-cleaners/leads', 'buyer', body);
    const second = await call('/listing/cf-cleaners/leads', 'buyer', body);
    check('both submissions answer with success', first.status === 302 && second.status === 302);
    check('only ONE conversation exists', leadCount() === 1, `got ${leadCount()}`);
    check('the repeat says so plainly', /didn't send it twice/.test(loc(second)));
    check('the thread holds one opening message',
      db.prepare('SELECT COUNT(*) c FROM lead_messages WHERE lead_id=?').get(lastLead().id).c === 1);
    await waitFor(() => outboxCount('owner@contact.example') >= 1);
    await settle(600); // give a stray second email time to appear, if one is coming
    check('the business was emailed once', outboxCount('owner@contact.example') === 1,
      `got ${outboxCount('owner@contact.example')}`);
    check('the business was notified once',
      db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND kind='lead'").get(owner).c === notifBefore + 1);
  }

  console.log('Contact flow — unread badges tell the truth on both sides');
  {
    const lead = lastLead();
    const ownerInbox = await text('/dashboard/leads', 'owner');
    check('the business sees an unread badge', /pill-lead-unread/.test(ownerInbox));
    check('the Received tab counts it', /Received <span class="lead-n">1<\/span><span class="lead-unread"[^>]*>1 new/.test(ownerInbox));

    const opened = await text(`/dashboard/leads?open=${lead.id}`, 'owner');
    check('opening the thread marks where they left off', opened.includes('leadNewLine'));
    check('reading clears the stored counter',
      db.prepare('SELECT owner_unread FROM leads WHERE id=?').get(lead.id).owner_unread === 0);
    const afterRead = await text('/dashboard/leads', 'owner');
    check('and the badge is gone', !/pill-lead-unread/.test(afterRead));

    /* Business replies → the member's Sent box lights up. */
    db.prepare('UPDATE leads SET owner_unread=1 WHERE id=?').run(lead.id); // as if answering from the email alert
    await call(`/dashboard/leads/${lead.id}/reply`, 'owner', {
      _csrf: s.owner.csrf, body: 'Thanks — we cover Westlands. KES 28,000/month, quote tomorrow.',
    });
    check('answering a thread clears the answerer\'s own badge',
      db.prepare('SELECT owner_unread FROM leads WHERE id=?').get(lead.id).owner_unread === 0);
    check('the member now has an unread reply',
      db.prepare('SELECT inquirer_unread FROM leads WHERE id=?').get(lead.id).inquirer_unread === 1);
    const sent = await text('/dashboard/leads?box=sent', 'buyer');
    check('the Sent tab shows the unread badge', /Sent <span class="lead-n">1<\/span><span class="lead-unread"[^>]*>1 new/.test(sent));
    check('the Sent row is highlighted', /lead-row is-unread/.test(sent));
    await text(`/dashboard/leads?box=sent&open=${lead.id}`, 'buyer');
    check('reading the reply clears it',
      db.prepare('SELECT inquirer_unread FROM leads WHERE id=?').get(lead.id).inquirer_unread === 0);

    /* A second customer message must show up even though status is no longer 'new'. */
    await call(`/dashboard/leads/${lead.id}/reply`, 'buyer', {
      _csrf: s.buyer.csrf, body: 'That works — could you start on Monday and include windows?',
    });
    check('a follow-up on a CONTACTED lead still raises unread',
      db.prepare('SELECT owner_unread, status FROM leads WHERE id=?').get(lead.id).owner_unread === 1);
    const ownerAgain = await text('/dashboard/leads', 'owner');
    check('and the business sees it in the list', /pill-lead-unread/.test(ownerAgain));
  }

  console.log('Contact flow — archiving never swallows a live customer');
  {
    const lead = lastLead();
    await text(`/dashboard/leads?open=${lead.id}`, 'owner'); // clear unread
    await call(`/dashboard/leads/${lead.id}/archive`, 'owner', { _csrf: s.owner.csrf, archived: '1' });
    check('the conversation is archived', db.prepare('SELECT archived FROM leads WHERE id=?').get(lead.id).archived === 1);
    const gone = await text('/dashboard/leads', 'owner');
    check('and left the inbox', !gone.includes('Double click'));

    const followUp = await call(`/dashboard/leads/${lead.id}/reply`, 'buyer', {
      _csrf: s.buyer.csrf, body: 'Following up — are you still able to start on Monday?',
    });
    check('the member can still write to it', followUp.status === 302 && /Message sent/.test(loc(followUp)));
    check('a reply un-archives the conversation',
      db.prepare('SELECT archived FROM leads WHERE id=?').get(lead.id).archived === 0);
    const back = await text('/dashboard/leads', 'owner');
    check('it is back in the business inbox', back.includes('Double click'));
    check('flagged unread so it cannot be missed', /pill-lead-unread/.test(back));
  }

  console.log('Contact flow — per-thread flood control');
  {
    const lead = lastLead();
    const same = { _csrf: s.buyer.csrf, body: 'Are you there? Please respond to my request.' };
    const one = await call(`/dashboard/leads/${lead.id}/reply`, 'buyer', same);
    check('the first message is accepted', /Message sent/.test(loc(one)));
    const dup = await call(`/dashboard/leads/${lead.id}/reply`, 'buyer', same);
    check('an immediate repeat of the same message is refused', /just sent that message/.test(loc(dup)));

    let refusedAt = 0;
    for (let i = 0; i < 20; i++) {
      const r = await call(`/dashboard/leads/${lead.id}/reply`, 'buyer', {
        _csrf: s.buyer.csrf, body: `Burst message number ${i} on this conversation.`,
      });
      if (/wait for a reply/.test(loc(r))) { refusedAt = i; break; }
    }
    check('a burst of replies is capped', refusedAt > 0, 'never refused');
    const total = db.prepare('SELECT COUNT(*) c FROM lead_messages WHERE lead_id=? AND sender=?').get(lead.id, 'inquirer').c;
    check('the cap bounds what reaches the business', total <= 14, `${total} inquirer messages stored`);
    /* The business is never locked out of its own thread by the customer's flood. */
    const ownerReply = await call(`/dashboard/leads/${lead.id}/reply`, 'owner', {
      _csrf: s.owner.csrf, body: 'Yes — Monday 8am works, the team is booked.',
    });
    check('the business can still reply while the member is throttled', /Message sent/.test(loc(ownerReply)));
  }

  console.log('Contact flow — no talking into the void');
  {
    const lead = lastLead();
    await call(`/dashboard/leads/${lead.id}/delete`, 'buyer', { _csrf: s.buyer.csrf });
    check('the member deleted their copy',
      db.prepare('SELECT inquirer_user_id FROM leads WHERE id=?').get(lead.id).inquirer_user_id === null);

    const view = await text(`/dashboard/leads?open=${lead.id}`, 'owner');
    check('the business is told they left', /deleted this conversation/.test(view));
    check('the reply box is withdrawn', !view.includes(`action="/dashboard/leads/${lead.id}/reply"`));
    check('their direct email is offered instead', view.includes('buyer@contact.example'));

    /* The route must be honest too — the form is not the only entry point. */
    const shout = await call(`/dashboard/leads/${lead.id}/reply`, 'owner', {
      _csrf: s.owner.csrf, body: 'Hello? Are you still interested in Monday?',
    });
    check('a reply is stored but reported undelivered', /will not receive it/.test(loc(shout)));
    check('and it raised no phantom unread',
      db.prepare('SELECT inquirer_unread FROM leads WHERE id=?').get(lead.id).inquirer_unread === 0);
  }

  console.log('Contact flow — the rate limit is administrable');
  {
    const html = await (await fetch(`${base}/listing/cf-cleaners`)).text();
    check('a signed-out visitor is invited to sign in', html.includes('Sign in to contact'));
    check('and is sent back to the form afterwards', html.includes('next=%2Flisting%2Fcf-cleaners%23contact-business'));
    const spam = require('../src/lib/spam');
    check('the lead bucket is still 20/hour by default', spam.limits().lead === 20);
    const protection = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'protection.ejs'), 'utf8');
    check('Admin → Protection exposes the lead limit', protection.includes('name="spam_rl_lead"'));
  }
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  server.kill();
  try { require('../src/db').db.close(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
  const label = process.exitCode ? 'FAIL' : 'all checks passed';
  console.log(`\nLeads contact flow: ${passed} checks ${label}`);
});
