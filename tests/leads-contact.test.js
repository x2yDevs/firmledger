/**
 * Leads — “Contact this business”, the whole flow over real HTTP.
 * npm run test:leads-contact
 *
 * This is the gate on the conversion path itself: a signed-in FirmLedger member
 * reaching a verified business from its profile, and the conversation that
 * follows. Everything is driven against a real server with real sessions and
 * CSRF, then verified in the database and in the served HTML:
 *
 *   1. Availability — the contact panel is rendered exactly when an inquiry
 *      would be accepted (claimed + published + a live owner account) and never
 *      as a dead form: unclaimed, owner-deleted, pending-review and suspended
 *      records all refuse, with the reason on the page.
 *   2. The form — the account email is locked in and always wins over a posted
 *      one, the limits in the HTML are the server's limits, the honeypot is
 *      swallowed, and a rejected submission comes back FILLED IN (a typed
 *      message is never lost), once only.
 *   3. Sending — lead row, opening message on the shared thread, business
 *      notification and business email (with the member's address, never the
 *      business's own), geo captured, and a redirect that deep-links the member
 *      straight into the new conversation.
 *   4. Repeat contact — the profile lists the open conversation, a genuinely
 *      different request opens a second lead, and a double submit folds into
 *      the first instead of duplicating it.
 *   5. Length honesty — 4000 characters are stored whole; 4001 are refused with
 *      the limit named and nothing stored (never silently truncated).
 *   6. Signals — the Sent box marks the threads the business has answered and
 *      counts them; the business inbox counts what waits for its reply.
 *   7. Guards — the real rate limiters on both writes, double-clicked replies,
 *      empty/over-long replies, CSRF, strangers, and the business email never
 *      leaking to the member.
 *   8. Documentation — the shipped copy matches the shipped product.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmledger-leads-contact-'));
process.env.FIRMLEDGER_DATA_DIR = dataDir;
process.env.SMTP_URL = '';

const { db, setSetting } = require('../src/db');
const bcrypt = require('bcryptjs');
const leads = require('../src/lib/leads');
const spam = require('../src/lib/spam');

/* Shared mail outbox — every assertion is a delta from a mark taken just
   before the send it describes. */
const OUTBOX = path.join(ROOT, 'data', 'outbox.log');
const outboxAll = () => { try { return fs.readFileSync(OUTBOX, 'utf8'); } catch { return ''; } };
const outboxMark = () => Buffer.byteLength(outboxAll(), 'utf8');
const outboxSince = (mark) => Buffer.from(outboxAll(), 'utf8').slice(mark).toString('utf8');
const outboxTo = (slice, email) => slice.split('\n').filter((l) => l.includes(` TO=${email}`)).length;
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

/* ------------------------------------------------------------------ seed */
db.prepare("INSERT INTO settings(key,value) VALUES('upkeep_on','0') ON CONFLICT(key) DO NOTHING").run();
/* The flow itself must never trip the limiter; the abuse section below turns
   the ceilings right down to prove they are wired (limits are read live). */
setSetting('spam_rl_lead', '500');
setSetting('spam_rl_lead_reply', '500');

const PW = bcrypt.hashSync('ContactOnly!2026', 10);
const addUser = (email, name, plan = 'free') => db.prepare(
  `INSERT INTO users(email,password_hash,name,plan,plan_expires_at,trial_expires_at,leads_digest)
   VALUES (?,?,?,?,'2099-01-01','','both')`
).run(email, PW, name, plan).lastInsertRowid;

const bizId = addUser('biz@contact.example', 'Nakuru Metal Works', 'pro');
const memberId = addUser('member@contact.example', 'Jane Wanjiku');
const strangerId = addUser('stranger@contact.example', 'Total Stranger');
const goneId = addUser('gone@contact.example', 'Deleted Owner');
const suspendedId = addUser('suspended@contact.example', 'Suspended Owner');
db.prepare('UPDATE users SET suspended=1 WHERE id=?').run(suspendedId);
db.prepare("UPDATE users SET plan='free', plan_expires_at='' WHERE id=?").run(memberId);

const addListing = (slug, name, over = {}) => db.prepare(
  `INSERT INTO listings(slug,name,tagline,description,category,country,city,website,status,claimed,owner_user_id,confidence)
   VALUES (@slug,@name,'t','A verified trade business used by the leads contact test.','Metal & Fabrication','Kenya','Nakuru','https://contact.example',@status,@claimed,@owner,80)`
).run({ slug, name, status: 'approved', claimed: 1, owner: bizId, ...over }).lastInsertRowid;

const claimedId = addListing('nakuru-metal', 'Nakuru Metal Works');
const gatesId = addListing('nakuru-gates', 'Nakuru Gate Makers');
addListing('open-record', 'Open Record Ltd', { claimed: 0, owner: null });
const orphanId = addListing('orphan-record', 'Orphan Record Ltd', { owner: goneId });
/* Deleting the owner account leaves claimed=1 with owner_user_id NULL (the FK
   is ON DELETE SET NULL) — the classic dead-form case. */
db.prepare('DELETE FROM users WHERE id=?').run(goneId);
addListing('pending-record', 'Pending Record Ltd', { status: 'pending' });
addListing('suspended-record', 'Suspended Record Ltd', { owner: suspendedId });

const { createSession } = require('../src/lib/session');
const s = {
  biz: createSession(bizId, 'user'),
  member: createSession(memberId, 'user'),
  stranger: createSession(strangerId, 'user'),
};

const port = 5900 + (process.pid % 90);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['--no-warnings', 'server.js'], {
  cwd: ROOT,
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
function section(t) { console.log(`\n${t}`); }

async function call(route, who = null, form = null, headers = {}) {
  const h = { ...headers };
  if (who) h.cookie = `fl_session=${s[who].token}`;
  if (form) h['content-type'] = 'application/x-www-form-urlencoded';
  return fetch(base + route, {
    redirect: 'manual',
    method: form ? 'POST' : 'GET',
    headers: h,
    body: form ? new URLSearchParams(form) : undefined,
  });
}
const text = (res) => res.text();
const loc = (res) => decodeURIComponent(res.headers.get('location') || '');
const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1] || '';
const leadIdFrom = (res) => Number((res.headers.get('location') || '').match(/lead_id=(\d+)/)?.[1] || 0);
const leadCount = (listingId) => db.prepare('SELECT COUNT(*) c FROM leads WHERE listing_id=?').get(listingId).c;
const msgCount = (leadId) => db.prepare('SELECT COUNT(*) c FROM lead_messages WHERE lead_id=?').get(leadId).c;
const totalLeads = () => db.prepare('SELECT COUNT(*) c FROM leads').get().c;

const LONG_MESSAGE = 'Hello, we need a steel gate fabricated for our Nakuru plot — 3.2 metres wide, sliding, with a lock. Could you quote it and give a lead time?';

(async () => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + log)), 20000);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error('Server exited: ' + code + log)); });
    server.stdout.on('data', (d) => {
      log += d;
      if (log.includes('FirmLedger running')) { clearTimeout(timer); resolve(); }
    });
  });

  section('Contact availability — the panel appears exactly when an inquiry would be accepted');
  {
    const memberPage = await text(await call('/listing/nakuru-metal', 'member'));
    check('member sees the contact panel on a verified profile', memberPage.includes('id="contact-business"') && memberPage.includes('Contact this business'));
    check('member sees the hero call to action', /href="#contact-business">Contact this business</.test(memberPage));
    check('the form posts to the profile’s leads route', memberPage.includes('action="/listing/nakuru-metal/leads"'));

    const anonPage = await text(await call('/listing/nakuru-metal', null));
    check('a signed-out visitor is invited to sign in, not shown the form', anonPage.includes('Sign in to contact') && !anonPage.includes('name="message"'));
    check('the sign-in link returns them to the contact panel', anonPage.includes(encodeURIComponent('/listing/nakuru-metal#contact-business')));

    const ownerPage = await text(await call('/listing/nakuru-metal', 'biz'));
    check('the business sees “your listing”, never a form to itself', ownerPage.includes('This is your listing') && !ownerPage.includes('name="message"'));

    const unclaimedPage = await text(await call('/listing/open-record', 'member'));
    check('an unclaimed record shows no dead contact form', !unclaimedPage.includes('id="contact-business"') && !unclaimedPage.includes('name="message"'));
    check('an unclaimed record still points at claiming', unclaimedPage.includes('Claim this listing'));

    const orphanRow = db.prepare('SELECT claimed, owner_user_id FROM listings WHERE id=?').get(orphanId);
    check('the orphaned record really is claimed with no owner', orphanRow.claimed === 1 && orphanRow.owner_user_id === null);
    const orphanPage = await text(await call('/listing/orphan-record', 'member'));
    check('a claimed record whose owner account is gone shows no form', !orphanPage.includes('name="message"'));

    const suspendedPage = await text(await call('/listing/suspended-record', 'member'));
    check('a suspended owner’s record shows no form', !suspendedPage.includes('name="message"'));
    check('a member cannot even view a record still in review', (await call('/listing/pending-record', 'member')).status === 404);

    for (const [slug, label] of [['open-record', 'unclaimed'], ['orphan-record', 'owner deleted'], ['suspended-record', 'suspended owner'], ['pending-record', 'in review']]) {
      const r = await call(`/listing/${slug}/leads`, 'member', {
        _csrf: s.member.csrf, name: 'Jane Wanjiku', subject: 'Quote',
        message: 'A message long enough to pass the validation rules.',
      });
      check(`a ${label} record refuses the POST`, r.status === 302 && loc(r).includes('cannot receive inquiries'), loc(r));
    }
    check('no refused POST stored a lead', totalLeads() === 0);
  }

  section('The form — the account email wins, and the limits agree with the server');
  {
    const html = await text(await call('/listing/nakuru-metal', 'member'));
    const emailInput = (html.match(/<input[^>]*name="email"[^>]*>/) || [''])[0];
    check('the account email is pre-filled and locked', emailInput.includes('value="member@contact.example"') && emailInput.includes('readonly'));
    check('the message limits in the HTML are the server limits',
      html.includes(`minlength="${leads.LIMITS.message.min}"`) && html.includes(`maxlength="${leads.LIMITS.message.max}"`));
    check('the subject limit in the HTML is the server limit', html.includes(`name="subject" maxlength="${leads.LIMITS.looking_for.max}"`));
    check('the honeypot field is in the form', html.includes('name="company_site"'));

    const forged = await call('/listing/nakuru-metal/leads', 'member', {
      _csrf: csrfOf(html), name: 'Jane Wanjiku', email: 'someone-else@example.com',
      subject: 'Forged sender', message: 'Trying to make the business reply to a different address entirely.',
    });
    check('an inquiry with a forged email still lands', forged.status === 302 && loc(forged).includes('lead_sent=1'));
    const forgedLead = db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 1').get();
    check('the stored email is the account email, not the posted one', forgedLead.email === 'member@contact.example', forgedLead.email);
    db.prepare('DELETE FROM leads WHERE id=?').run(forgedLead.id);

    const bot = await call('/listing/nakuru-metal/leads', 'member', {
      _csrf: csrfOf(html), company_site: 'https://spam.example', name: 'Bot', email: 'member@contact.example',
      subject: 'Spam', message: 'Buy my thing now, please click the link below.',
    });
    check('a honeypot submission is swallowed', bot.status === 302 && !loc(bot).includes('lead_sent=1'));
    check('the honeypot created no lead', totalLeads() === 0);
  }

  section('A rejected submission never loses what the member typed');
  {
    const page = await text(await call('/listing/nakuru-metal', 'member'));
    const r = await call('/listing/nakuru-metal/leads', 'member', {
      _csrf: csrfOf(page), name: 'Jane Wanjiku', phone: '+254 700 000 111',
      subject: 'Steel gate quote', message: 'short',
    });
    check('a too-short message bounces back to the profile', r.status === 302 && loc(r).includes('lead_err='));
    check('the bounce names the real rule', loc(r).includes(`at least ${leads.LIMITS.message.min} characters`));
    check('no lead was stored', totalLeads() === 0);
    check('the rejected form was stashed', db.prepare(
      'SELECT COUNT(*) c FROM lead_drafts WHERE user_id=? AND listing_id=?').get(memberId, claimedId).c === 1);

    const back = await text(await call(r.headers.get('location'), 'member'));
    check('the form comes back with the subject filled', /name="subject"[^>]*value="Steel gate quote"/.test(back));
    check('the form comes back with the message filled', /<textarea[^>]*name="message"[^>]*>short<\/textarea>/.test(back));
    check('the form comes back with the phone filled', /name="phone"[^>]*value="\+254 700 000 111"/.test(back));
    check('the error is shown above the form', back.includes(`at least ${leads.LIMITS.message.min} characters`));
    check('the stash is one-shot', db.prepare('SELECT COUNT(*) c FROM lead_drafts').get().c === 0);
    const again = await text(await call('/listing/nakuru-metal?lead_err=x', 'member'));
    check('a reload does not resurrect the draft', !/name="subject"[^>]*value="Steel gate quote"/.test(again));

    const badPhone = await call('/listing/nakuru-metal/leads', 'member', {
      _csrf: csrfOf(again), name: 'Jane Wanjiku', phone: 'call me maybe',
      subject: 'Steel gate quote', message: LONG_MESSAGE,
    });
    check('an undialable phone is refused', loc(badPhone).includes('phone number does not look right'), loc(badPhone));
    const badPhonePage = await text(await call(badPhone.headers.get('location'), 'member'));
    check('the long message survived the phone rejection', badPhonePage.includes('3.2 metres wide'));
    check('nothing was stored for the rejected phone', totalLeads() === 0);
    db.prepare('DELETE FROM lead_drafts').run();
  }

  let gateLeadId = 0;
  section('Sending a real inquiry');
  {
    const page = await text(await call('/listing/nakuru-metal', 'member'));
    const mark = outboxMark();
    const r = await call('/listing/nakuru-metal/leads', 'member', {
      _csrf: csrfOf(page), name: 'Jane Wanjiku', phone: '+254 700 000 111',
      subject: 'Steel gate quote', message: LONG_MESSAGE,
    }, { 'cf-ipcountry': 'ke', 'cf-ipcity': 'nakuru' });
    check('accepted with a success redirect', r.status === 302 && loc(r).includes('lead_sent=1'));
    gateLeadId = leadIdFrom(r);
    check('the redirect carries the new conversation id', gateLeadId > 0, r.headers.get('location'));

    const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(gateLeadId);
    check('the lead is stored against the business and the member', !!lead && lead.owner_user_id === bizId && lead.inquirer_user_id === memberId);
    check('the lead starts New and unarchived', lead.status === 'new' && lead.archived === 0);
    check('the location is captured from the proxy geo headers', lead.city === 'Nakuru' && lead.country === 'KE', `${lead.city}/${lead.country}`);
    check('the whole message is stored', lead.message === LONG_MESSAGE);
    check('the subject is stored as what they are looking for', lead.looking_for === 'Steel gate quote');
    const msgs = db.prepare('SELECT * FROM lead_messages WHERE lead_id=? ORDER BY id').all(gateLeadId);
    check('the opening message seeds the shared thread', msgs.length === 1 && msgs[0].sender === 'inquirer' && msgs[0].body === LONG_MESSAGE);
    const notif = db.prepare("SELECT * FROM notifications WHERE user_id=? AND kind='lead' ORDER BY id DESC").all(bizId)[0];
    check('the business is notified with a deep link into the thread', !!notif && notif.url === `/dashboard/leads?open=${gateLeadId}`);
    await waitFor(() => outboxTo(outboxSince(mark), 'biz@contact.example') === 1);
    const sent = outboxSince(mark);
    check('the business got exactly one email for the inquiry', outboxTo(sent, 'biz@contact.example') === 1);
    check('the email names the member and the business', sent.includes(`New inquiry for Nakuru Metal Works — Jane Wanjiku`));
    check('the email carries the member’s address so the business can reply', sent.includes('member@contact.example'));
    check('the email never carries the business’s own address to the member', outboxTo(sent, 'member@contact.example') === 0);
    check('the owner-email flag is set once', db.prepare('SELECT owner_emailed FROM leads WHERE id=?').get(gateLeadId).owner_emailed === 1);
    check('the stashed draft is gone after a successful send', db.prepare('SELECT COUNT(*) c FROM lead_drafts').get().c === 0);

    const done = await text(await call(r.headers.get('location'), 'member'));
    check('the profile confirms the inquiry was sent', done.includes('Your inquiry was sent to Nakuru Metal Works'));
    check('the confirmation keeps the “Follow the conversation” copy', /Follow the conversation/.test(done));
    check('the confirmation deep-links into the new thread',
      done.includes(`/dashboard/leads?box=sent&amp;open=${gateLeadId}`) || done.includes(`/dashboard/leads?box=sent&open=${gateLeadId}`));
    check('the member can still send a different request', done.includes('Send another inquiry'));

    const inbox = await text(await call('/dashboard/leads', 'biz'));
    check('the received inbox lists the member and the subject', inbox.includes('Jane Wanjiku') && inbox.includes('Steel gate quote'));
    check('the inbox reports what waits for a reply', /inquir(y|ies) waiting for your reply/.test(inbox));
    const thread = await text(await call(`/dashboard/leads?open=${gateLeadId}`, 'biz'));
    check('the business sees the member’s email and phone', thread.includes('member@contact.example') && thread.includes('+254 700 000 111'));
    check('the business sees the full message', thread.includes('3.2 metres wide'));
  }

  section('Repeat contact — the conversation stays findable and is never duplicated');
  {
    const revisit = await text(await call('/listing/nakuru-metal', 'member'));
    check('the profile lists the open conversation', revisit.includes('Your conversations with Nakuru Metal Works'));
    check('the conversation links into Sent', revisit.includes(`/dashboard/leads?box=sent&open=${gateLeadId}`));
    check('the conversation says the business has not answered yet', revisit.includes('waiting for Nakuru Metal Works'));
    check('the form is still there for a different request', revisit.includes('Send inquiry'));

    const dup = await call('/listing/nakuru-metal/leads', 'member', {
      _csrf: csrfOf(revisit), name: 'Jane Wanjiku', subject: 'Steel gate quote', message: LONG_MESSAGE,
    });
    check('a double submit is accepted without opening a second lead', dup.status === 302 && leadIdFrom(dup) === gateLeadId);
    check('the double submit says so honestly', loc(dup).includes('already sent that inquiry'));
    check('still exactly one lead on that profile', leadCount(claimedId) === 1);
    check('still exactly one opening message', msgCount(gateLeadId) === 1);

    const second = await call('/listing/nakuru-metal/leads', 'member', {
      _csrf: csrfOf(revisit), name: 'Jane Wanjiku', subject: 'Window grilles',
      message: 'Separate request — we also need window grilles for the same plot. Can you quote those too?',
    });
    const secondId = leadIdFrom(second);
    check('a genuinely different request opens a second conversation', second.status === 302 && secondId > 0 && secondId !== gateLeadId);
    check('both leads are on the profile', leadCount(claimedId) === 2);
    const revisit2 = await text(await call('/listing/nakuru-metal', 'member'));
    check('both conversations are listed on the profile', revisit2.includes('Steel gate quote') && revisit2.includes('Window grilles'));
    db.prepare('DELETE FROM leads WHERE id=?').run(secondId);
  }

  section('Length honesty — the cap is enforced, never applied silently');
  {
    const page = await text(await call('/listing/nakuru-gates', 'member'));
    const token = csrfOf(page);
    const okRes = await call('/listing/nakuru-gates/leads', 'member', {
      _csrf: token, name: 'Jane Wanjiku', subject: 'Full length', message: 'q'.repeat(leads.LIMITS.message.max),
    });
    check('a message exactly at the cap is accepted', okRes.status === 302 && loc(okRes).includes('lead_sent=1'));
    const okLead = db.prepare('SELECT * FROM leads WHERE id=?').get(leadIdFrom(okRes));
    check('all 4000 characters are stored', okLead.message.length === leads.LIMITS.message.max, String(okLead.message.length));

    const over = await call('/listing/nakuru-gates/leads', 'member', {
      _csrf: token, name: 'Jane Wanjiku', subject: 'Over length', message: 'q'.repeat(leads.LIMITS.message.max + 1),
    });
    check('a message over the cap is refused', loc(over).includes('limited to 4,000 characters'), loc(over));
    check('nothing was stored for the over-long message', leadCount(gatesId) === 1);
    const overPage = await text(await call(over.headers.get('location'), 'member'));
    check('the over-long text is kept so the member can trim it', overPage.includes('qqqqqq'));
    db.prepare('DELETE FROM leads WHERE listing_id=?').run(gatesId);
    db.prepare('DELETE FROM lead_drafts').run();
  }

  let repliedLeadId = 0;
  section('Thread signals — who is waiting for whom');
  {
    const page = await text(await call('/listing/nakuru-metal', 'member'));
    const r = await call('/listing/nakuru-metal/leads', 'member', {
      _csrf: csrfOf(page), name: 'Jane Wanjiku', subject: 'Repainting the gate',
      message: 'One more request — could you also repaint the existing gate this month?',
    });
    repliedLeadId = leadIdFrom(r);
    check('a third conversation opened', repliedLeadId > 0);

    const before = await text(await call('/dashboard/leads?box=sent', 'member'));
    check('the Sent tab keeps its count markup', />Sent <span class="lead-n">\d+<\/span>/.test(before));
    check('no “new reply” marker before the business answers', !before.includes('lead-wait">New reply'));

    const thread = await text(await call(`/dashboard/leads?open=${repliedLeadId}`, 'biz'));
    const mark = outboxMark();
    const reply = await call(`/dashboard/leads/${repliedLeadId}/reply`, 'biz', {
      _csrf: csrfOf(thread), body: 'Yes — repainting is KES 9,000 including primer. We can come on Friday.',
    });
    check('the business can reply', reply.status === 302 && loc(reply).includes('Message sent'));
    check('the reply flipped the lead to Contacted', db.prepare('SELECT status FROM leads WHERE id=?').get(repliedLeadId).status === 'contacted');
    check('the member was notified', db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND kind='lead'").get(memberId).c >= 1);
    check('the member got their one email for this conversation', await waitFor(() => outboxTo(outboxSince(mark), 'member@contact.example') === 1));

    const after = await text(await call('/dashboard/leads?box=sent', 'member'));
    check('Sent marks the answered thread', after.includes('lead-wait">New reply'));
    check('the Sent tab counts the replies waiting', /lead-wait">\d+ new repl/.test(after));
    check('the waiting line explains itself', /with a reply from the business waiting for you/.test(after));
    check('countsForInquirer agrees with the rendered list', leads.countsForInquirer(memberId).waiting === db.prepare(
      `SELECT COUNT(*) c FROM leads l JOIN listings g ON g.id = l.listing_id
        WHERE l.inquirer_user_id = ?
          AND (SELECT m.sender FROM lead_messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) = 'owner'`
    ).get(memberId).c);
    check('the Sent count still matches the rows listed', leads.countsForInquirer(memberId).total === leads.listForInquirer(memberId, { perPage: 100 }).total);

    const openThread = await text(await call(`/dashboard/leads?box=sent&open=${repliedLeadId}`, 'member'));
    check('the member reads the answer in the thread', openThread.includes('KES 9,000'));
    check('the business bubble is labelled with the company name', openThread.includes('lead-bubble-who">Nakuru Metal Works'));
    check('the business email is nowhere in the member’s view', !openThread.includes('biz@contact.example'));
    const profile = await text(await call('/listing/nakuru-metal', 'member'));
    check('the profile now says the business replied', profile.includes('Nakuru Metal Works replied'));
  }

  section('Guards on the conversation');
  {
    const page = await text(await call(`/dashboard/leads?open=${repliedLeadId}`, 'biz'));
    const bizToken = csrfOf(page);   /* each session has its own CSRF token */
    const before = msgCount(repliedLeadId);

    const again = await call(`/dashboard/leads/${repliedLeadId}/reply`, 'biz', {
      _csrf: bizToken, body: 'Yes — repainting is KES 9,000 including primer. We can come on Friday.',
    });
    check('a double-clicked identical reply is folded in', again.status === 302 && msgCount(repliedLeadId) === before);

    const huge = await call(`/dashboard/leads/${repliedLeadId}/reply`, 'biz', { _csrf: bizToken, body: 'x'.repeat(leads.LIMITS.reply.max + 500) });
    check('an over-long reply is refused, not truncated', loc(huge).includes('limited to 4,000 characters') && msgCount(repliedLeadId) === before);

    const empty = await call(`/dashboard/leads/${repliedLeadId}/reply`, 'biz', { _csrf: bizToken, body: '   ' });
    check('an empty reply is refused', loc(empty).includes('Write a message first'));

    check('a reply without CSRF is rejected', (await call(`/dashboard/leads/${repliedLeadId}/reply`, 'biz', { body: 'No token here.' })).status === 403);

    const strangerReply = await call(`/dashboard/leads/${repliedLeadId}/reply`, 'stranger', { _csrf: s.stranger.csrf, body: 'Let me into this conversation.' });
    check('a stranger cannot reply', loc(strangerReply).includes('not found'));
    check('the stranger added nothing', msgCount(repliedLeadId) === before);
    const strangerView = await text(await call(`/dashboard/leads?box=sent&open=${repliedLeadId}`, 'stranger'));
    check('a stranger cannot read the thread', !strangerView.includes('KES 9,000'));

    /* The ceilings are real: drop them through the admin setting (read live on
       every request) and the next post is a 429, then put them back. */
    setSetting('spam_rl_lead_reply', '1');
    await call(`/dashboard/leads/${repliedLeadId}/reply`, 'biz', { _csrf: bizToken, body: 'One more genuine line for the member.' });
    const limited = await call(`/dashboard/leads/${repliedLeadId}/reply`, 'biz', { _csrf: bizToken, body: 'And another line that must be rate limited.' });
    check('replies are rate limited', limited.status === 429 && Number(limited.headers.get('retry-after') || 0) > 0, String(limited.status));
    setSetting('spam_rl_lead_reply', '500');

    setSetting('spam_rl_lead', '1');
    await call('/listing/nakuru-gates/leads', 'member', { _csrf: s.member.csrf, name: 'Jane Wanjiku', subject: 'Rate limit probe', message: 'First inquiry inside the tightened window.' });
    const limitedLead = await call('/listing/nakuru-gates/leads', 'member', { _csrf: s.member.csrf, name: 'Jane Wanjiku', subject: 'Rate limit probe two', message: 'Second inquiry that must be rate limited.' });
    check('new inquiries are rate limited', limitedLead.status === 429, String(limitedLead.status));
    setSetting('spam_rl_lead', '500');
    db.prepare('DELETE FROM leads WHERE listing_id=?').run(gatesId);

    check('both buckets ship sensible defaults', spam.DEFAULTS.spam_rl_lead === 20 && spam.DEFAULTS.spam_rl_lead_reply === 60);
    check('the console setting overrides the default live', spam.limits().lead === 500 && spam.limits().lead_reply === 500);
  }

  section('Ownership changes — inquiries follow the business');
  {
    const otherBizId = addUser('newowner@contact.example', 'Nakuru Metal Works (new owner)', 'pro');
    const before = leads.listForOwner(bizId, {}).rows.map((r) => r.id);
    check('the business starts with conversations', before.length >= 1);
    const moved = leads.transferListing(claimedId, otherBizId);
    check('transferListing reports what moved', moved === before.length, String(moved));
    const nowOld = leads.listForOwner(bizId, {}).rows.map((r) => r.id);
    const nowNew = leads.listForOwner(otherBizId, {}).rows.map((r) => r.id);
    check('the previous owner no longer sees them', nowOld.length === 0);
    check('the new owner inherits every conversation', nowNew.length === before.length && before.every((id) => nowNew.includes(id)));
    const thread = leads.getAccessible(repliedLeadId, otherBizId);
    check('the new owner can open a transferred thread', !!thread && thread.role === 'owner');
    check('the thread kept its whole timeline', leads.messagesFor(repliedLeadId, otherBizId).length >= 2);
    check('the previous owner is locked out of the thread', leads.getAccessible(repliedLeadId, bizId) === null);
    check('the member’s Sent copy is untouched', leads.getAccessible(repliedLeadId, memberId).role === 'inquirer');
    check('the member can still reply into the transferred thread',
      leads.addMessage(repliedLeadId, memberId, 'Following up after the ownership change.').ok === true);
    /* An unclaimed record moves nothing: a lead needs an owner. */
    check('removing the owner moves no leads', leads.transferListing(claimedId, null) === 0
      && leads.listForOwner(otherBizId, {}).rows.length === before.length);
    /* Private notes travel with the conversation they describe. */
    leads.addNote(repliedLeadId, otherBizId, 'Inherited this conversation with the record.');
    check('the new owner can note on an inherited conversation', leads.notesFor(repliedLeadId, otherBizId).length === 1);
    check('notes stay private from the member', leads.notesFor(repliedLeadId, memberId).length === 0);
    /* The console assistant is a third ownership path — drive the real tool on a
       second record so the thread above stays with otherBizId untouched. */
    const aiBizId = addUser('console-transfer@contact.example', 'Console Transfer Holdings', 'pro');
    const aiTools = require('../src/lib/aitools');
    const gatesRow = db.prepare('SELECT * FROM listings WHERE id=?').get(gatesId);
    const gatesLead = leads.create({
      listing: gatesRow, inquirerUserId: memberId,
      fields: { name: 'Jane Wanjiku', email: 'member@contact.example', looking_for: 'Steel gates',
        message: 'Quoting two steel gates for the same site — the record is about to change hands.' },
    });
    check('the second record has a conversation to move', gatesLead.ok === true && leadCount(gatesId) === 1);
    const aiRes = await aiTools.execute('set_listing_owner', { id_or_slug: gatesRow.slug, user: 'console-transfer@contact.example' });
    check('the assistant’s ownership tool succeeds', aiRes && aiRes.ok === true, JSON.stringify(aiRes && aiRes.error));
    check('and reports the conversation it moved', aiRes.result.moved_leads === 1, String(aiRes.result.moved_leads));
    check('the assistant-transferred owner inherits the inbox',
      leads.listForOwner(aiBizId, {}).rows.length === 1
      && leads.listForOwner(bizId, {}).rows.length === 0
      && leads.listForOwner(otherBizId, {}).rows.length === before.length);
    check('the new owner is told the conversation is waiting',
      db.prepare("SELECT body FROM notifications WHERE user_id=? AND kind='listing' ORDER BY id DESC").get(aiBizId).body.includes('lead conversation moved with it'));
    const backRes = await aiTools.execute('set_listing_owner', { id_or_slug: gatesRow.slug, user: 'newowner@contact.example' });
    check('transferring again moves it on', backRes.ok === true && backRes.result.moved_leads === 1
      && leads.listForOwner(otherBizId, {}).rows.length === before.length + 1
      && leads.listForOwner(aiBizId, {}).rows.length === 0);
    check('unclaiming through the tool moves nothing', (await aiTools.execute('set_listing_owner', { id_or_slug: gatesRow.slug, user: '' })).ok === true
      && leads.listForOwner(otherBizId, {}).rows.length === before.length + 1);
    db.prepare('DELETE FROM users WHERE id=?').run(aiBizId);
    db.prepare('UPDATE listings SET owner_user_id=?, claimed=1 WHERE id=?').run(bizId, gatesId);

    /* Both ownership paths must actually call it. */
    const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    check('a verified claim moves the leads', /transferListing\(l\.id, newUser\.id\)/.test(read('src/lib/claimflow.js')));
    check('the console ownership transfer moves the leads', /transferListing\(l\.id, userId\)/.test(read('src/routes/admin.js')));
    check('the console assistant’s ownership tool moves the leads', /leads\.transferListing\(l\.id, u\.id\)/.test(read('src/lib/aitools.js')));
    /* Deliberate asymmetry, pinned here so it can never change silently:
       the BUSINESS owns the record (leads.owner_user_id is ON DELETE CASCADE),
       while a member deleting their account only drops the link
       (inquirer_user_id SET NULL) so the business keeps the inquiry it received.
       A business that closes its account takes its conversations with it —
       including the member's Sent copies, which then have nobody to answer. */
    const sentBefore = leads.countsForInquirer(memberId).total;
    check('the member has conversations before the business deletes its account', sentBefore >= 2, String(sentBefore));
    db.prepare('DELETE FROM users WHERE id=?').run(otherBizId);
    check('deleting an owner account clears their inbox', leads.listForOwner(otherBizId, {}).rows.length === 0);
    check('and the conversations go with the business', leadCount(claimedId) === 0 && msgCount(repliedLeadId) === 0);
    check('the member’s Sent box is honest about it', leads.countsForInquirer(memberId).total === 0
      && leads.countsForInquirer(memberId).total === leads.listForInquirer(memberId, { perPage: 100 }).total);
    check('the member’s own account is untouched', !!db.prepare('SELECT id FROM users WHERE id=?').get(memberId));
    check('the record itself kept its own owner, so contact stays open',
      (await text(await call('/listing/nakuru-metal', 'member'))).includes('name="message"'));

    /* Now the real owner closes their account: the record survives (listings
       owner_user_id is SET NULL) but it can no longer receive inquiries — the
       panel must disappear and the route must refuse, not offer a dead form. */
    db.prepare('DELETE FROM users WHERE id=?').run(bizId);
    check('the record is left claimed with no owner', (() => {
      const row = db.prepare('SELECT claimed, owner_user_id FROM listings WHERE id=?').get(claimedId);
      return row.claimed === 1 && row.owner_user_id === null;
    })());
    const gone = await text(await call('/listing/nakuru-metal', 'member'));
    check('the contact panel disappears with the owner account', !gone.includes('name="message"') && !gone.includes('id="contact-business"'));
    const refused = await call('/listing/nakuru-metal/leads', 'member', {
      _csrf: s.member.csrf, name: 'Jane Wanjiku', subject: 'Still there?',
      message: 'Trying to contact a business whose owner account was deleted.',
    });
    check('the route refuses the stale form post', refused.status === 302 && loc(refused).includes('cannot receive inquiries'));
    check('and stores nothing', leadCount(claimedId) === 0);
  }

  section('Shipped copy matches the shipped product');
  {
    const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const readme = read('README.md');
    const overview = read('README_OVERVIEW.md');
    const pricing = read('views/pricing.ejs');
    check('the README no longer promises guest inquiries', !/no account needed/i.test(readme));
    check('the README says signed-in members contact a business', /signed-in FirmLedger member/i.test(readme));
    check('the overview no longer promises guest inquiries', !/no\s+account needed/i.test(overview));
    check('the overview documents the member-side Sent threads', /Sent/.test(overview) && /inquirer/.test(overview));
    check('pricing describes member inquiries', /signed-in FirmLedger member/i.test(pricing) && !/Visitors send an inquiry/i.test(pricing));
    const protection = read('views/admin/protection.ejs');
    check('the console can tune both lead limits', protection.includes('name="spam_rl_lead"') && protection.includes('name="spam_rl_lead_reply"'));
  }

  console.log(`\nLeads contact flow: ${passed} checks${process.exitCode ? ' (FAILURES)' : ' all checks passed'}`);
  server.kill();
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('FATAL', e, log.slice(-1500));
  try { server.kill(); } catch { /* ignore */ }
  process.exit(1);
});
