## 2026-09-12 (leads inbox) — both pages take the screen they are given, and nothing is stranded on the left

**Both pages are now on the wide container.** The list and the conversation were the
last two dashboard pages still on the 1200px `.container` (1340px on very wide
screens), so on a 1920 monitor the inbox was a strip down the left-hand side with
a band of empty paper beside it. They now carry `container container-wide`, and the
ceiling is restated where the pages are named — `max-width:
min(var(--wide-max, 1560px), 100%)` on `.leads-head / .leads-inbox-page /
.leads-thread-page` — because `.container` raises its own `max-width` later in the
sheet, at a specificity a plain `--wide-max` could not beat. 1560px rather than the
1760px the directory uses: an inbox of sentences wants a readable measure more than
it wants every pixel of a 27-inch screen, and the gutters stay symmetric either way
(226px each side at 1920, 546px each side at 2560). Nothing about that is pinned to
a breakpoint — a narrow window simply uses the window.

**The width is spent, not just given.** At ≥1200px an inbox row becomes three
columns — who it is and where it stands, what they asked for, where it came from
and when it last moved — instead of three lines stacked at the left edge with the
right two-thirds of the row blank; the base two-column row is what every narrower
screen reads. The conversation keeps a measure and grows it (1040px, 1180px at
≥1500px), centred, because a reply bubble stretched to 1468px is unreadable; the
strip under the composer, which used to bunch `Status · Update · Archive` at the
left and `Delete permanently` at the right edge of a 720px card, now spreads across
the card it is in. The free-plan invitation was the worst of it — a
`max-width: 720px` welded inline to the markup, sitting flush left under a centred
page. It is a card of its own now (`.lead-lock-card`: 1100px, `margin-inline: auto`,
its copy on the left, `Upgrade to Pro` and `See pricing` kept on the right of it),
so a Pro refusal reads as the page's one statement rather than a note in the
margin.

**The frame is measured instead of guessed.** Both pages cut one height — the list
frame on the inbox, the conversation card on its page — out of `--pane-h`, which
until now was `min(1060px, max(calc(100vh - 100px), 640px))`: a guess at 100px of
chrome above it. The chrome is 190-320px in practice, so a tall window was handed a
short list with a band of dead paper under it and a short window got clipped at the
fold. `views/partials/leads-fit.ejs` now runs on both pages: it measures the room
between the top of the shell and the bottom of the window, less the section's own
bottom air, and writes it to the shell as `--lead-fit-h`, which every `--pane-h`
reads from (with the shipped arithmetic as the no-script fallback). Re-measured on
resize, orientation change, load and when the webfonts land, because the head
reflows and the shell moves with it. Two floors, because the two pages hold
different things: 240px for a frame of inquiries (two rows and a scroll) and 400px
for a conversation (its foot is 345px of composer, counter and status line, which
must not be cut). With no script at all, nothing changes.

**One bug was holding the card open.** `.lead-detail .lead-thread` had
`flex: 1 1 0%` — and a percentage basis in a container whose height is `auto`
resolves against an indefinite main size, so it falls back to the item's content.
The bubbles therefore decided how tall the card was: 520px of thread made an 868px
card whatever the window said, and the composer sat 340px below the fold. `0%` →
`0px` is the whole fix; the clamp on the thread's `min-height` had been fighting it
silently for two rounds. `leads-pane-resize` now asserts the basis is `0px` and
forbids `0%`, because the difference is invisible in the file and decides whether
the page fits at all. The card is not given a height by script — nothing to
re-measure, nothing to keep in sync.

**Short windows reclaim chrome rather than clipping.** At `max-height: 780px` the
head's padding, the lede and the tab row tighten up, and on a conversation the
lede goes entirely (`display: none` on `.leads-thread-lede`) — the card repeats what
it says in its own meta line, and 18px is a bubble. Under 640px the head and the
filter pills compact, so the list starts at 474px instead of 517px and a phone
shows three inquiries above its fold instead of two. The thread opens on its newest
message — and now opens on it *after* the measurement, since the box the bubbles
live in is decided by the fit script; it re-sticks when the frame changes and leaves
a reader who scrolled back up alone.

Tests: `leads-thread-page` is 68 checks — the two pages on the wide container, the
lock card centred, the three-column row, and the fit script itself extracted from
the served page and driven over 10 windows × 5 shell tops × 2 pages (the frame ends
on the fold, never past it, never below its floor; a window too short to hold a
frame leaves the stylesheet in charge) plus the settle check. `leads-pane-resize`
64, `leads-reply-fit` 35, `leads-blog-fit` 43, `leads-messaging` 113,
`leads-contact` 143, `leads-inbox-e2e` 25, `leads-housekeeping` 33,
`leads-digest` 36, `focus-hygiene` 13. Full `npm test` is unchanged at 31 suites
passing, the only failure being the pre-existing production-db-upgrade assertion
that needs the real better-sqlite3 binding. Measured in a real browser at nine
viewports from 360×800 to 1920×1440: every desktop and tablet window ends its page
at the fold with the composer visible, no viewport scrolls sideways, and tabs,
counts, the listing filter, the pager, the seam drag and its double-click restore,
the status form and the reply counter all still do what they did before.

## 2026-09-12 (leads inbox) — the inbox is the list of inquiries, and an inquiry opens as a full page of its own

**The inbox page is inquiries only — one row per inquiry, edge to edge, one
below the last.** `/dashboard/leads` renders the list and nothing else: no pane
beside it, no thread, no composer, no grip. A row is a full-width card built for
the width it now has — who it is and where it stands on the first line (name and
status pill), what they are asking for on the second (two lines, then clamped,
instead of one ellipsised line), where it came from and when it last moved on
the third, and a chevron at the right edge that says the row opens. The frame is
cut to the window (`--pane-h` scoped by `.leads-inbox-page`), so the page does
not scroll to read the list — the list scrolls inside its own frame, as it
always did. Tabs, counts, the waiting line, the listing filter, the pager and
the empty states are untouched.

**Pressing an inquiry opens a page: `/dashboard/leads/<id>`.** It is the whole
screen, not a pane: a slim head naming the conversation (`Dashboard › Leads
inbox › Amina Njeri`), then one card that fits the window — the thread taking
every remaining pixel, the composer pinned beneath it, and the conversation's
whole housekeeping in one strip under that: the status select (saving on change,
with Update for keyboards), Archive/Restore, Delete permanently, `Email instead`
and `Call`. The trail's “Leads inbox”, the “← Back to inbox” button and Close all
carry the box, the status filter, the listing and the page the conversation was
opened from, so coming back lands on the same list with the same pills and
counts. Both roles get the same page: the business sees the inquirer's email and
phone and owns the status; the member sees the thread with the business email
still private and gets their own delete. Everything else came with it unchanged
— day separators, bubbles, the seam grip and its persisted height, the dock, the
inline refusal with its draft kept, the status pill stated where it is set.

**No link was left behind.** `/dashboard/leads?open=<id>` — the deep link in
every notification and reply email already sent, and the listing page's “Follow
the conversation” — now answers with a redirect to `/dashboard/leads/<id>`,
carrying the same view with it; a link to a lead that is gone renders the list
instead of bouncing. The POST round trips changed with it: a reply, a status
change and a refused send return to the conversation page (`/dashboard/leads/<id>?status=new&ok=…`), while archive and delete — which take the lead out of the
conversation — close it and return to the list, exactly as before.

Tests: `npm run test:leads-thread` is rewritten for the new shape (51 checks) —
the list page shipping no conversation at all, rows that read across the page
and link to the page, both pages cut to the window, the conversation page
carrying every feature, the trail and its filtered way back, the old `?open=`
links redirecting to it, and every round trip landing back on the conversation
for both roles. `tests/leads-pane-resize.test.js`, `tests/leads-reply-fit.test.js`,
`tests/leads-blog-fit.test.js`, `tests/leads-contact.test.js`,
`tests/leads-messaging.test.js`, `tests/leads-inbox-e2e.test.js`,
`tests/leads-housekeeping.test.js` and `tests/user-area.test.js` follow the
conversation to its new URL. `npm test` is green at 32 suites, including
`test:leads-thread` (51), `test:leads-pane` (64), `test:leads-reply` (35),
`test:leads-fit` (43), `test:leads-chat` (113), `test:leads-contact` (143),
`test:leads-inbox` (25), `test:leads-housekeeping` (33), `test:pro-growth` (79),
`test:leads-digest` (36) and `test:user-area`.

---

## 2026-09-12 (leads inbox) — one column: an open inquiry is a page of its own, and the list stretches across the screen

**Pressing an inquiry now opens the conversation as a page, not as a pane
beside the list.** The thread used to render in the right-hand column while the
220/300px list rail stayed pinned on the left, so the conversation — the thing
actually being read — got the leftover two-thirds of the screen, with the
composer and the housekeeping line squeezed into the same measure. The inbox is
one column now: `.lead-layout` is a single `minmax(0, 1fr)` grid holding either
the list or the conversation, never both, and the conversation column is centred
at `max-width: min(1040px, 100%)` — wide enough for a real chat, narrow enough
that a bubble is never read across a 1340px container. Everything the pane held
came with it unchanged: the thread and its day separators, the seam grip and the
persisted pane height (`fl.leadsPane.v2`), the dock, the pinned foot, the
composer with the server's own limits and its inline refusal, the status pill,
status/archive/delete, `mailto:`/`tel:` and the Close link. The trail above it
names the conversation (`Dashboard › Leads inbox › Amina Njeri`), and “Leads
inbox” there — like Close — carries the box, the status filter, the listing and
the page the thread was opened from, so going back lands on the same list.

**With nothing open, the list is the page — stretched, not railed.** The
220/300px column and the empty “Select an inquiry…” pane beside it are gone:
`.lead-list-col` takes the whole container, so a row's preview and its
“listing · date” line stop being ellipsised at 300px, while the frame keeps the
sticky top and the window-derived `--pane-h` it always had (rows, pager and the
empty state inside it are untouched). On stacked screens the capped 34vh rail
goes with it — the list runs the length of the page and the page does the
scrolling instead of a box inside it. `.lead-detail-empty` and its two rules are
retired along with the pane they belonged to.

**The contact facts at the top are lines now, not one crowded strip.** `Email`
first, `Phone` under it, and `Looking for` on a line of its own below those —
`.lead-facts` is a column (`flex-direction: column; flex-wrap: nowrap`, one fact
per row) instead of a wrapping row that ran the address and the subject together
and broke wherever the pane happened to end. The labels share an 84px column, so
the values start on the same line and the rows read as one small definition
list. Same labels, same order, same `mailto:`/`tel:` links, still no table; the
member's Sent view still shows only the subject line, with the business email
staying private.

**No link, route or redirect moved.** Notifications, reply emails and the
listing page's “Follow the conversation” all point at
`/dashboard/leads?open=<id>` (and `?box=sent&open=<id>`), which is that page
now; the `ctx_*` fields still carry the view through every POST, so a reply, a
status change, an archive or a refused send returns to the same conversation
with its message. Preview it without signing in:
`LEADS_INBOX_PREVIEW=1 node server.js` → `/dashboard/leads`, then press any
inquiry.

Tests: the new `npm run test:leads-thread` (42 checks) locks all of it — one
column either way, no rail on the thread page and no pane on the list page, the
centred measure and the stretched list, every feature still present, the two
fact lines and their links, the trail and its filtered way back, both roles,
the empty-filter state, and the round trips (reply, status, refused send,
archive, notification deep link). `tests/leads-pane-resize.test.js` and
`tests/leads-reply-fit.test.js` now assert that nothing open renders no pane at
all (and that the retired empty pane left no rules behind), and the optional
browser drag holds the pane's own width still instead of a list column that is
no longer there. `npm test` is green at 32 suites, including `test:leads-pane`
(64), `test:leads-reply` (35), `test:leads-fit` (43), `test:leads-chat` (113),
`test:leads-inbox` (25), `test:leads-contact` (143), `test:leads-housekeeping`
(33), `test:focus` and `test:user-area`.

---

## 2026-09-12 (leads inbox) — the reply box resizes by hand inside real bounds, and the card grows with it

**The reply textarea is a field a member resizes, so it now has bounds that
hold.** `.lead-reply-form .input` carries `min-height: 80px; max-height: 300px;
width: 100%; box-sizing: border-box; resize: vertical` — one floor and one
ceiling on every screen (the short-window 56px and stacked 76px overrides are
gone: three floors for one field was the confusion), vertical drags only, and a
width that is always exactly its column, so padding and border can never wedge
the card open. The sizing script reads those bounds back out of
`getComputedStyle` instead of carrying its own copy of them, and a height the
member dragged by hand now outranks the typed-text growth: the box holds the
size they chose (clamped to the same bounds) instead of snapping back to 160px
on the next keystroke, and the choice is kept for the tab under
`fl.leadReply.h.<thread>` so it survives the send that follows it. A drag that
leaves an inline width behind has that width dropped.

**The card is a flex column whose window height is a floor, not a ceiling.**
`.lead-detail` is `height: auto` with `min-height: var(--lead-user-h,
var(--pane-h, …))`, so at rest it is exactly as tall as the window allows — the
same pixels, the same sticky top, the same seam drag as before — and a reply box
dragged past what the window budgeted grows the card (the page scrolls) instead
of pushing `Send message` out of it. The thread keeps a zero flex basis on
desktop (`flex: 1 1 0%`) with its own scrollbar, so a long conversation never
stretches the card: only a grown composer does, and only by as much as it grew.
Stacked screens drop the floor (`min-height: 0`) and stay content-height; the
desktop `overflow-y: auto` escape hatch now serves the one capped case, a pane
the script has parked at the header stop.

**The contact facts read as two lines, in order.** How to reach them (email,
then the phone when there is one) is the first line; what they are looking for
is the line below it (`.lf-look`, a full-row flex basis), so a long ask wraps
under its own label instead of trailing the email address across the pane and
reading as the tail of it.

Tests: `tests/leads-messaging.test.js` runs the shipped composer script against
a stub whose box has an inline style and whose `getComputedStyle` answers with
the bounds read out of `app.css` — floor at rest, typed growth capped, a drag
held against the next keystroke and the send after it, drags past the ceiling
and below the floor clamped, a sideways drag dropped (8 checks);
`tests/leads-reply-fit.test.js` audits the card-growth budget in place of the
fixed-pane one (at rest the thread still keeps its full 220px floor on every
window from 640px up, and dragged to the 300px ceiling the card grows by no
more than the box gained); `tests/leads-pane-resize.test.js` locks the floor
model and the thread's zero basis; `tests/leads-blog-fit.test.js` locks the
two-line facts strip. All 31 suites pass.

---

## 2026-09-12 (leads inbox) — the chat area extends from the seam, the corner mark and the full-width toggle are gone

**The chat space is now extendable from the seam above the reply box.** The
small corner grip that sat below the “Delete permanently” button is removed,
and in its place the pinned foot starts with a full-width drag seam
(`.lead-thread-grip`, `role="separator"`, keyboard-focusable) resting directly
above the composer — the same spot the text box extends from. Dragging down
lengthens the conversation, dragging up shortens it: the thread is the pane’s
only flexible child, so every pixel the pane gains or loses goes to the chat,
with the composer, counter and status line following the seam. Arrow keys
fine-tune, double-click (or Ctrl/Cmd+Home) restores, and the size persists per
browser under `fl.leadsPane.v2` — clamped to 420px…min(1100, window−96), the
same contract the corner grip held for height. Short desktop windows
(≤880px of height) reclaim the seam’s line like the rest of the chrome — it
collapses to zero and the 4px bar straddles the thread/composer boundary — so
the reply-fit budget audit still holds at rest and with the box dragged to its
240px ceiling on every window from 640px up. Stacked screens and print ship no
grip at all.

**The “Full width / Back to list” toggle is removed.** The button, its script
(esc-handling, re-dock resync, `__flLeadsFocus` seam) and every `.is-max` /
`.lead-pane-focus` rule are gone — the pane header keeps only the Close link.
With the corner grip gone too, the width trade it carried goes with it:
`--lead-list-w` no longer exists and the list column is back to the shipped
220/300px measure. The dock (parking the pane at the header stop while the
section scrolls) and the pinned foot are unchanged.

**Preview without signing in.** `LEADS_INBOX_PREVIEW=1` lets an unsigned-in
browser open `GET /dashboard/leads` as the seeded demo owner
(`demo@firmledger.test`), so the fixed inbox can be viewed directly; a real
session always wins, and with the flag off the `/dashboard` login wall is
untouched (verified: 302 → `/login`). `scripts/seed-leads-preview.js`
idempotently seeds the demo owner (Pro), two claimed listings and three
inquiries — new/contacted/won with a two-day thread — printing the
`/dashboard/leads?open=` URL to open.

Tests: `tests/leads-pane-resize.test.js` re-locks the seam grip (markup order
foot → grip → composer → bar, the pure clamp/dock geometry, a vertical drag
through the stubbed handlers, keyboard restore, dock behaviour, and the
browser drag — pane resizes, list untouched, persists across reload);
`tests/leads-reply-fit.test.js` now audits the seam in the chrome budget and
asserts the focus mode left no button, label, script or rule behind. Both
suites plus `leads-inbox-e2e`, `leads-messaging`, `leads-contact`,
`leads-housekeeping`, `focus-hygiene` and `user-area` pass.

---

## 2026-09-12 (leads inbox) — the reply box holds the floor, the conversation extends, the page ends clean

**The composer is now the pane's floor in fact, not only in flow.** Its textarea
was bounded only by the script that sizes it (`autoSize`, 160px); dragging the
native handle could still outgrow the pane and shove Send out of it. The box
carries `max-height: 240px` now — the same ceiling is enforced in CSS and in
script — and short desktop windows reclaim the *thread* floor (`min-height: 96px`
under 880px of height) instead of letting the pane grow a second scrollbar over
the pinned foot. The budget is auditable and audited: at rest the chat keeps its
full 220px floor on every window from 640px up, and even with the box dragged to
240px the conversation still stands and the foot is still inside the pane.

**The chat area above it extends.** One button in the pane header — `⤢ Full
width`, `Esc` (or the button again) to release — hands the conversation the whole
window: the list column steps aside, the grid becomes one column, the pane
measures `max(480px, 100dvh − 96px)` from the header stop to 12px above the
bottom, the Send row stops wrapping, and the corner grip stands down because
there is nothing left to trade. It is a view, not a setting: nothing is stored,
so the next page load is the two-column inbox with the list in hand again, and a
pane with no conversation open ships no button and runs no handler. Stacked
screens never offer it; print and a resize through 900px hand the list back. The
same thread, composer, status line and pinned foot are underneath — no new form,
no new route, no changed markup order.

**Two loose ends in the same area.** An unopened inbox no longer renders a
window-tall empty panel beside a short list (`min-height: 208px`, content height
otherwise); and the site's weekly-digest band — logo mark, copy, subscribe form
— is not rendered on this route at all (`hideNews` in `src/routes/dashboard.js`,
the escape hatch the maintenance page already uses), with the section's bottom
padding tightened to match, so scrolling past the conversation lands on the
footer instead of on a logo. Every other page keeps the band.

Covered by the new `npm run test:leads-reply` (54 checks, plus `npm test` at 31
suites green, including the shipped
focus script run against a stub DOM and a height budget read back out of
`app.css`), and by `test:leads-pane` (64), `test:leads-fit` (42),
`test:leads-chat` (105), `test:leads-inbox`, `test:leads-contact`,
`test:leads-housekeeping`, `test:user-area` and `test:focus` — all unchanged and
all green.

## 2026-09-11 (leads inbox) — a refused reply says why, and the thread owns the pane

**A reply that will not send states the reason in the box it was refused from.**
`leads.addMessage` now answers with a code and the numbers behind it — `empty`,
`too_short`, `too_long`, `not_found`, `store_failed`, each with `length`/`min`/
`max`/`over` — and `POST /dashboard/leads/:id/reply` passes that sentence back as
`cerr` so it renders inside the composer instead of as a banner above the tabs.
The box checks the same limits before the request is made (`data-min`/`data-max`
are the server's `LIMITS.reply`, nothing is duplicated), so the member reads
"Too long to send — your reply is 4,500 characters and the limit is 4,000. Trim
500 of them and it goes through." or "Too short to send — a reply needs at least
2 characters and yours is 1." the moment it applies; the counter turns amber near
the cap and red past it, and a Pro refusal is stated beside Send with an upgrade
link. `maxlength` was removed from the reply box: a long paste is explained,
never silently cut. Nothing is lost on the way back — the draft lives in
`sessionStorage` per thread, is restored after a refusal and dropped once the
message is stored. The floor moved from 1 to 2 characters, because a one-keystroke
reply is always a mis-click; `validateReply` is the single source of truth for
both sides.

**The private-notes block is retired, so the conversation is the whole pane.**
`POST /dashboard/leads/:id/note`, `leads.addNote`/`notesFor` and the
`.lead-notes*` styles are gone (the `lead_notes` table stays, so no saved note
is destroyed), the thread grows into the freed height (`min-height: 240px`, a
taller detail pane, a taller thread on phones), and every line of copy that
promised notes — the locked-inbox panel, the empty-selection hint, the delete
confirmation, the pricing answer and the Pro feature card — was corrected with
it. A "Won" is now confirmed where it was set: the current status rides in the
chat header, the select submits itself (the Update button stays for keyboards
and no-JS), and an unknown status is refused by name rather than ignored.

**Nothing in the inbox throws you out of the inbox.** Every inbox form posts its
own context (`ctx_box`, `ctx_status`, `ctx_listing`, `ctx_page`, each re-checked
against the same allow-lists the GET uses — never a URL to bounce to) and
redirects back into exactly that view with the thread still open, so the lead
whose status you just changed is still in front of you with its new pill, and
archiving from the Archived box lands you in the Archived box. When a status
change moves a lead out of the filter being worked through, the confirmation
says so and names the tab it went to. Covered by `npm run test:leads-chat`
(103 checks, including the composer script run against a stub DOM),
`test:leads-inbox`, `test:leads-contact`, `test:leads-housekeeping` and
`test:leads-fit`.

## 2026-09-11 — Leads: the member → business contact flow, made real end to end

**One rule decides whether a business can be contacted, and the page obeys it.**
`leads.contactState(listing)` is now the single source of truth for "can a
member reach this business right now" — claimed, published, owner account alive
and not suspended. The profile template renders the contact panel only when that
returns ok, and `POST /listing/:slug/leads` enforces the same call, so a member
is never shown a form that would bounce, and a stale form post (owner account
deleted between page load and submit) is refused with the real reason instead of
silently dropping the message. Every refusal names the honest cause and leaks
nothing private; the profile still points unclaimed records at "Claim this
listing".

**The inquiry itself is a conversation from the first message.** The member's
account name and email are attached automatically (never freehand input, so the
business always replies to a real FirmLedger account), the owner's address is
never exposed to either side, and the opening message is seeded into
`lead_messages` inside the same transaction as the lead — a stored inquiry can
no longer show an empty thread. The owner gets one email plus an in-app
notification deep-linking `Dashboard → Leads?open=<id>`; the member gets a
confirmation that links straight into their own copy under **Sent**, which is
free for everyone (unchanged product rule: receiving is free, reading and
managing the business inbox is Pro).

**Nothing a member types is lost.** A rejected submission is stashed as a
one-shot draft (new `lead_drafts` table, 60-minute TTL, older rows swept on every
write) and re-fills the form on the way back — subject, phone and message
included, account email excepted because it is read from the account. Drafts are
excluded from backups (`src/lib/backup.js`): transient, single-use personal text
that a restore must never resurrect.

**Double submits fold; real second inquiries do not.** An identical inquiry from
the same member inside ten minutes returns the conversation already open
(`{ ok: true, duplicate: true }`) and sends the member to it, so a refresh or a
double click never gives the business two copies of one question. An identical
*reply* inside sixty seconds folds the same way. A second, differently worded
inquiry still opens a second conversation — that semantic is deliberate and is
asserted by `tests/leads-messaging.test.js`, so it was preserved exactly.

**Limits are honest and shared.** `leads.LIMITS` drives both the form's
`minlength`/`maxlength` attributes and the validator, so the browser and the
server can never disagree: over-long input is refused with a message naming the
ceiling instead of being silently truncated, phone numbers are checked for
dialability (E.164 digit range) rather than accepted as free text, and the
character counters and double-submit guards ship in `public/js/main.js` for
every lead form (asset cache-buster bumped, `ASSET_V` → 58).

**Both sides can keep talking, safely.** The reply route got its own rate-limit
bucket — `spam_rl_lead_reply`, 60/hour by default, tunable in Admin → Protection
next to the inquiry bucket (20/hour) — so a runaway script cannot flood a
business or a member while a normal conversation stays untouched. Notification
and mail failures are now caught and logged rather than thrown: the message is
already stored, so a failed ping can never swallow the member's confirmation.
The Sent box tells the member which threads have an answer waiting ("New reply"
marker, waiting count on the tab, and a line saying how many conversations the
business has replied to), and the business inbox reports how many inquiries are
waiting for its reply.

**Inquiries follow the business when ownership changes.** New
`leads.transferListing(listingId, newOwnerId)` moves every conversation on a
record to whoever owns it now — messages and private notes travel with the lead.
It is wired into all three ownership paths: `finalizeVerifiedClaim` (a verified
claim displacing a previous owner), the console's listing-owner transfer, and the
console assistant's `set_listing_owner` tool — which also tells the new owner how
many conversations arrived with the record. Without
it, the previous owner could keep reading and answering inquiries for a business
that is no longer theirs while the new owner inherited a live conversation with
no history. Transfer is silent (no new notifications — the new owner simply sees
the threads in their inbox), removing an owner moves nothing (a lead requires an
owner, and the honest record is that the account which received it did so while
it owned the business), and the member's Sent copy is untouched either way.

**The cascade asymmetry is now documented instead of incidental.** The business
owns the record: deleting an owner account cascades its conversations away,
while a member deleting theirs only detaches the link (`inquirer_user_id`
SET NULL) so the business keeps the inquiry it received. `ERD.md` section 4 was
rewritten around the real schema (`leads` with `inquirer_user_id`,
`owner_emailed`, `inquirer_emailed`; `lead_messages`, `lead_notes`,
`lead_drafts`; counts corrected to 52 tables / 58 indexes), and `README.md`,
`README_OVERVIEW.md` §7 and the pricing FAQ were corrected wherever they still
promised guest inquiries — the shipped copy now describes the shipped product.

**New gate: `tests/leads-contact.test.js` (142 checks, in `npm test` /
`npm run test:leads-contact`).** Drives the real server over HTTP as five
different identities (member, owner, a second owner, signed-out visitor, admin):
panel gating and every refusal reason, draft re-fill, duplicate fold for
inquiries and replies, exactly one email per side, notification-failure
isolation, 429 + `Retry-After` with the console override applied live, privacy
(strangers, other businesses, the member's own Sent copy), ownership transfer
driven through the real assistant tool, owner-account deletion, and a closing block asserting that the
README, the overview, the pricing FAQ and the Protection console still match
what the code does. Full suite: 29/29 suites pass.

## 2026-09-11 (blog) — leads guide corrected, stale seeds refresh, new 2026 listing guide

**The leads guide now matches the shipped product.** `turning-your-listing-into-leads`
previously claimed "no account required — guests can inquire as easily as
members"; in reality only **signed-in FirmLedger members** can contact a
business, with the account name and email attached automatically. The guide is
rewritten: member-only inquiries, the one-email-per-conversation rule (first
message emailed, later replies are site notifications), the shared timeline
under Sent, and permanent delete in the Leads inbox.

**Sweep of the whole seed set.** The only other stale claim found was in
"how FirmLedger builds a trustworthy record": it said IndexNow pushes happen
"within about ten hours", while the code pings IndexNow the moment a record
goes live and re-pings 30 minutes later. Corrected, and every factual number
in the remaining posts re-checked against the code (API endpoints and scopes,
3 keys, 12 stored stories, 8 Featured cards, 7/30/90-day packages, 100-char
descriptions, DNS/meta/badge claim methods) — all accurate.

**Already-seeded databases get the fixes on next boot.** `seedBlog` stays
insert-if-absent for admin-authored content, but gains a stale-marker refresh:
a stored seed post is rewritten only while its body still contains a known
outdated sentence — an admin-reworded copy is left alone (both behaviours
covered by the new suite).

**New post: "Where to List Your Startup in 2026 for Instant Verification &
SEO".** Google Business Profile (local intent), Crunchbase (the investor
cross-check), Product Hunt (a launch, not a listing), review-led platforms
like G2, and FirmLedger — described factually as the verification-first
ledger: one canonical profile per company, live DNS/meta/badge ownership
checks and a public confidence score, plus the crawlable-SEO angle (canonical
URLs, structured data, sitemap index, search-engine pings). Deliberately
non-salesy; it links back with descriptive anchors — *"explore the business
intelligence data"* → `/directory` and *"claim your verified business
profile"* → `/claim`.

**New gate: `tests/blog-content.test.js` (20 checks, in `npm test` / `npm run
test:blog`).** Asserts over real HTTP that the leads guide no longer contains
the guest claim, the 2026 guide is published with every required platform and
both descriptive anchors, and — against the seed module itself — that a stale
old body is refreshed on boot while an admin-reworded body survives.

## 2026-09-11 — Leads housekeeping + status & notification-settings screen fit

**Status page fits the screen like every other page.** The public `/status`
page floated in its own 1040px column; it now uses the same container rhythm
as all other public pages (1200px, 1340px on very wide screens) so its cards
fill the frame instead of looking narrow beside siblings. A second, real bug
fixed while verifying in a headless browser: the auto-refresh script applied
the class `st-st-operational` (double prefix) on every snapshot, so after the
first refresh the hero lost its status colour and the pulse dot went grey —
it now keeps `st-<status>` and stays green/amber/red.

**Notification settings fits like the other dashboard pages.** The page was a
thin 820px column under the site header; it now uses the shared dashboard
`page-head` header plus the full container, with the preference card and the
"More settings" card side by side on wide screens and stacked on phones
(`.settings-grid`). A new "Leads conversation replies" preference row
documents the email policy below. Asset cache-buster bumped (`ASSET_V` 54→55)
so browsers pick the new CSS.

**One email per Leads conversation, then site notifications.** Each side of a
conversation is emailed exactly once — the owner for the opening inquiry, the
inquirer for the first reply — and every response after that lands as an
in-app notification only (`owner_emailed` / `inquirer_emailed` flags on
`leads`, guarded migrations for old databases). Long threads can no longer
flood anyone's inbox; the reply form and the notification settings page both
say so.

**Permanent delete under Leads.** A conversation can now be deleted for good,
not just archived: the business owner (Pro, like the other inbox tools) gets
"Delete permanently" which removes the lead, its messages and its notes for
both sides; the inquirer gets "Delete conversation" which removes the thread
from their own Sent box while the business keeps its record of the inquiry
(the inquirer link is dropped, so no further pings reach them). Both ask for
confirmation; strangers and free owners are refused.

**New gate: `tests/leads-housekeeping.test.js` (33 checks, in `npm test` /
`npm run test:leads-house`).** Drives the real server over HTTP: exactly one
email per side measured in the mail outbox with notifications counted per
reply, detach semantics, permanent delete cascading messages away, Pro
gating, stranger lock-out, and the settings/status pages rendering the new
layout.

## 2026-09-10 (production audit #3) — Maintenance holding page + animated error pages

**New gate: `tests/maintenance-page.test.js` (94 checks, in `npm test` / `npm run test:maintenance`).**
A real server is booted and both ways of flipping maintenance are driven end to
end — the admin **personally** (the real Protection form POST) and **via the AI
assistant** in plain language (chat → proposal → confirm) — each verified against
the database, the audit log and the served HTML.

**The maintenance holding page (`views/maintenance.ejs`, rewritten).** When
maintenance is on, every public page answers **503** with the admin's own copy —
custom title, message and ETA chip — on a standalone full-screen page in the
FirmLedger design language: dark navy `#0A1628` stage with a drifting ledger
grid, two aurora glows and a scan line; the white logo inside a rotating dashed
ring with a counter-rotating arc and a pulsing halo; a "Scheduled maintenance"
kicker with typing dots; an indeterminate gradient progress bar ("Applying the
update"); a "Live status →" link to `/status` (which stays up during the outage)
and a quiet note that listings, accounts and payments are untouched. The page
carries `noindex,nofollow`, honours `Retry-After: 3600`, and includes an
auto-reload poller — every 20s it re-fetches the page the visitor asked for and
reloads the tab the moment maintenance lifts (paused while the tab is hidden).
Everything respects `prefers-reduced-motion`.

**What stays reachable:** `/status`, `/robots.txt`, `/sitemap.xml`, static
assets, the public API (mounted before the gate) and the whole admin console
(signed-in admins pass straight through; signed-in *members* still see the
holding page).

**The AI can carry the whole custom message now.** `set_maintenance_mode`
accepts `title`, `message` and the new **`eta`** (the "back at…" chip), and the
rule engine pulls each out of plain language —
`maintenance on title "Search index rebuild" message "…" eta "tonight 21:00 EAT"`
separates the three without the ETA leaking into the message (also handles
`eta=…`, "back at/by/in …", "expected back by …"). Two long-standing
understanding collisions were fixed on the way: "maintenance on message: …"
used to be swallowed by the *email* rule (the word "message" canonizes to
"email"), and a maintenance message containing the word "search" was diverted
to admin search. Both now resolve to the maintenance command; every "send
email…"/"email …" phrasing still goes to email. The maintenance status read
shows exactly what visitors see (title, message excerpt, ETA), and the
execution receipt says so too.

**The 404/500 page (`views/error.ejs`, rewritten) is animated.** Per-digit
drop-in of the status code (the middle digit keeps floating), a red "Not found"
stamp that slams in (404 only), a mono ledger chip — `ENTRY #000404 — no match
in this ledger` / `ENTRY #000500 — this entry could not be read` — with a
blinking caret, drifting background shapes, and three CTAs (Back to FirmLedger /
Browse directory / Search instead). It keeps the full site chrome (header,
footer, nav) unlike the standalone holding page, and `prefers-reduced-motion`
settles it to a static layout.

**Design notes.** Both pages share the site's tokens (Fraunces / Inter / JetBrains
Mono, navy `#0A1628`, gold `#B58C2E`/`#E4B95B`, hairlines `#2C3E5C`) and live in
one new CSS section in `public/css/app.css` (`maint-*`, `err-*` + keyframes).

## 2026-09-10 (production audit #2) — Every console area, greetings that know the time

**New gate: `tests/ai-areas.test.js` (232 checks, in `npm test` / `npm run test:areas`).**
Every admin console area — Search, Inbox, Listings, News, Categories, Claims,
Users, Plan offers, Pricing, Advertising, Careers, Status, Promos, Protection,
Health, Removals, Tickets, Email, Blog, AI Playground, Settings and Maintenance —
is driven through the real chat pipeline (chatTurn → proposal → “yes, run it”)
and verified in the **database**, with an audit row required for every executed
action. Includes a safety sweep (dangerous phrasings across areas always propose
and park a confirmation; auto-run executes an opted-in write but a sensitive one
still asks; no orphaned proposals) and a guarantee that **every command suggested
by every area menu parses** (171 expanded lines).

**Conversational layer — greetings now know the real time of day.**
- “good morning / afternoon / evening / night”, “hello”, “hi”, “hey”, “greetings”,
  “goodnight” are answered with a greeting grounded in the server clock
  (morning 05–12, afternoon 12–17, evening 17–20, night otherwise) — and a
  gentle correction when the operator greets evening at breakfast.
- “what time is it?”, “what day is it?”, “what is the date today” answer from the
  clock; “how are you”, “who are you”, “are you a robot / chatgpt” get honest
  rule-engine answers; bare “thanks” is now thanked (it used to say “Hello!”).
- One clock implementation (`assistant.js`: `now/timeOfDay/clockText`, with a
  test-only pin `__setTestNow`) — the suites test all four day-parts and every
  boundary hour deterministically, plus the full flow over live HTTP.

**Area menus.** A bare area name (“pricing”, “plan offers”, “careers”,
“advertising”, “promos”, “protection”, “status”, “blog”, “inbox”, “ai playground”,
“maintenance” …) now opens a menu of real commands for that area instead of the
generic settings fallback — 23 menus, every line verified parseable.

**Bugs found and fixed by the new suite.**
- “maintenance status” / “show maintenance” proposed flipping maintenance **ON**
  (a status question must never mutate) — status/state/mode questions are now
  reads that report the real flag; only explicit on/off/take/bring wording writes.
- “resume promo CODE” failed with “Promo not found” — the verb “resume” was being
  swallowed as the promo code. (`resume` is now vocabulary → `on`.)
- “create blog post title=… body=… published” was hijacked by the
  publish/unpublish toggle rule and asked “Which post?”.
- “show plan 3” / “show package 4” listed everything instead of flipping that one
  record — the console’s Show/Hide semantics now win for the specific-id form
  (“show 5 plans” stays a list).

## 2026-09-10 (production audit) — Every admin action verified through chat

**Route audit.** Every admin route was compared against the assistant's tool list;
two genuine gaps were closed: `set_mail_keepalive` (Email → keep-alive on/off,
cadence, recipient, run now) and `regenerate_indexnow_key` (Indexing → rotate key).
129 tools total, all reachable from plain language.

**Understanding fixes.** Trailing reasons ("… because the domain is dead") are
captured as a slot instead of polluting the target; quoted text and message bodies
are never split on "and"/"then"; "link A with B as partner" works; API-key prefixes
are picked out of prose; "bulk/mass" no longer implies "all".

**Bugs found and fixed by the new suites.**
- `runPlans` crashed (TypeError) when a message mixed unparseable fragments with a
  clarifying question — e.g. SQL-looking garbage like `'; DROP TABLE listings; --`.
  Fragments are now filtered before running.
- Malformed JSON / oversized bodies on any route returned a 500 page that itself
  crashed (`error.ejs` rendered before session locals existed). Body-parser errors
  now answer 400/413 (JSON for API callers), and the 500 handler is
  render-failure-safe.

**Tests.** Two new suites in `npm test`: `ai-e2e` (147 checks — every mutating and
read tool driven through `chatTurn` in plain language and verified by DB rows) and
`ai-http` (38 checks — real server: session + CSRF, chat→execute→cancel contract,
hostile input never executes or 500s, audit rows, 50-turn latency budget, 20-way
concurrency, no leaked pending proposals). `ai-tools` 193, `ai-assistant` 55.

## 2026-09-10 (later) — Assistant covers the whole console; more templates

**10 new console tools** (127 at the time, all wired to the assistant): `review_listing_now`
(rule-based review or dry-run score of one listing), `set_moderation_thresholds`,
`edit_moderation_rules` (block/flag/allow-domain lines), `get_moderation_rules`,
`get_audit_log`, `get_moderation_log`, `list_protection_rules` (IP/domain rules +
rate limits), `list_mail_accounts`, `list_api_keys`, `revoke_api_key` (sensitive).

**Understanding.** ~120 new phrases ("what's pending", "briefing", "is everything
up", "what did I just do", "whitelist 8.8.8.8", "who owns…", "top 5…", "this
month", "never mind", "post a job", "make listing 2 live", "review it" …),
contractions expanded, bare plural queries ("pending listings", "listings in
Fintech", "listings from Kenya", "sponsored listings"), explicit id lists
("approve listings 1 2 3" → bulk), category lookup by partial name, domain / IP
protected as single tokens, `clear`/`live`/`review` no longer collide with
approve/pending. Honest "console-only" answers for restore-backup, 2FA
enrollment, sign-everyone-out and default trial length.

**Templates.** New formatters for health, global search, audit log, moderation
log/rules, protection rules, mail accounts, API keys and the review score; a
"briefing" template that lists what needs attention; more phrasing variants for
receipts, confirmations, cancellations and empty results; sensitive proposals
get their own wording plus a one-line impact note ("They are signed out and
cannot log in until unsuspended…"). Help topics added for moderation, audit,
protection, mail, backup and briefing. Extra starter chips in the chat pane.

**Tests.** `ai-tools` 191 checks (all 127 tools exercised), `ai-assistant` 50.

## 2026-09-10 — AI Playground: rule-based assistant, no models, no API keys

**Model/provider layer removed.** `src/lib/llm.js`, `src/lib/groq.js`, every
provider preset, API-key storage and the "Model providers" settings block are
gone. The `.env.example` provider section is replaced by a note. Nothing in the
admin area calls an external AI service any more, and there is no local model.

**Listing generator removed** from Admin → AI Playground (tab, route and
`generateListing`/`publishListing`).

**Email → "Rephrase with AI" removed** (`POST /admin3119Musa/email/rephrase`,
the button and its script).

**New admin assistant — `src/lib/assistant.js` (rule engine).** Replaces the
LLM agent behind the same chat UI and keeps the full 117-tool registry
(`aitools*.js`). Techniques: input normalisation + stemming + one-edit typo
repair, phrase/synonym expansion, ~150 ordered regex intents with resolvers,
slot extraction (ids, slugs, emails, ticket refs, IPs, domains, dates,
percentages, "N uses", quoted/`saying:` payloads, key=value pairs, ordinals,
recency phrases), name lookup with disambiguation ("which one? 1. … 2. …"),
multi-turn context carried in a hidden marker (pronouns "it/them/their" resolve
to the last listing/member/ticket), slot-filling questions with a state
machine that a fresh command can always escape, compound sentences
("approve 1 and then feature it"), confirmation for every write (typed
yes/no or buttons; sensitive writes always confirm), personalised receipts,
varied phrasing, proactive next-step quick replies, honest recovery with
"did you mean" suggestions, and audit rows for every turn and action.

**Auto-moderation is rule-based.** `scoreListing()` scores 0–100 from the
listing's own fields plus admin-editable rules (`block:`, `flag:`,
`allow-domain:`) and thresholds; approve / hold / reject with reasons in the
moderation log. Runs in the background on new submissions as before.

**Tools.** `list_listings` gained an `owner` filter; `list_users`,
`list_tickets`, `get_ticket` added; `get_ai_playground` reports the engine.

**Tests.** `tests/ai-agent.test.js`, `ai-playground.test.js` and
`ai-providers.test.js` replaced by `tests/ai-assistant.test.js` (38 checks);
`ai-tools` updated (178 checks). `npm run test:ai` runs both.

# FirmLedger — change summary

## 2026-09-09 — Trial countdown emails + in-app reminders, console scroll audit, email AI rephrase hardening

**Free-trial reminder ladder — every member gets told, in email AND in-app,
before and when their trial ends.** A new hourly sweep (`src/lib/trialreminders.js`,
running on the same server tick that expires finished trials) walks every active
trial and fires a milestone the moment it becomes due, each exactly once per
trial (`users.trial_reminders_sent` tracks the ladder, and a brand-new trial
clears it):

- **roughly halfway** (long trials only — 14 days → 7 to go, etc.),
- **a few days left** (fires when 2–3 whole days remain; subject carries the
  real count, so a sweep that misses a day is still accurate),
- **the final day**, and
- **trial ended** — sent once the account has genuinely dropped back to Free
  (within ~26h of expiry, so trials that ended before this feature existed are
  never re-mailed). Users who kept paid Pro are skipped, and the "ended" mail
  points at `/dashboard/upgrade`.

Each milestone is a real branded email through the normal mailer (outbox when
no SMTP is configured) **and** a bell notification on the member's dashboard.
The end-of-trial status flip already happened; now the member hears about it
too. Covered by a new suite (`tests/trial-reminders.test.js`, wired into
`npm test`) that places accounts at every stage — halfway, a few days left,
final day, just-expired Free, just-expired-but-paid — and asserts the exact
email subject, the in-app row, the one-time marker, and that a second sweep is
silent.

**Console scroll audit.** Every long surface in the admin area is contained, so
records piling up never stretch the page. The user detail page (their listings,
claims, tickets, paid invoices) now uses the console's standard `.scroll-table`
surfaces alongside the already-contained queues, and the admin page smoke suite
asserts the user detail page scrolls in place too.

**Email → Rephrase with AI hardened.** The button always resolves the exact
provider/key/model configured in **Admin → AI Playground → Settings → Model
providers** (with a fallback to that provider's default model when the saved
choice is no longer known), so it can never drift from what works in the
playground. The page now shows which provider/model will do the rewriting (or a
clear "no AI provider configured" hint), and failures come back as actionable
JSON (`ok:false, error, code`) — missing key, rejected key and empty-reply
cases each tell the operator exactly where to fix it instead of surfacing a
bare gateway error.

## 2026-09-09 — Admin: searchable pickers, AI Playground 502 fix, external email + AI rephrase

**Searchable pickers in the console.** Long `<select>` lists the admin has to
pick from now filter live: a small search box above the picker hides
non-matching options and shows "n of N matches". Implemented once in
`public/js/main.js` (`data-filter-for`) and used where it hurts most — the
**news "Add a story by hand"** listing picker (500 options) and the **listing
editor's ownership picker** (500 users). The news queue's filter box also
searches the submitter's email now, so a story can be found by who filed it.
No JS = no filtering, everything still works.

**AI Playground 502 errors fixed.** Every OpenAI-format call sent the legacy
`max_tokens` field. Groq deprecated that field in favour of
`max_completion_tokens` (their current API reference uses the new name for
every model), and OpenAI's reasoning families (o-series, GPT-5.x, GPT-OSS)
refuse `max_tokens` outright — so the default provider + model combination
400'd upstream, and the console surfaced it as a wall of 502s. The gateway
(`src/lib/llm.js`) now picks the token field per provider/model:
`max_completion_tokens` for Groq and for reasoning model ids, `max_tokens`
elsewhere. Groq's Qwen 3.6/3.8 additionally get `reasoning_format: hidden`
when tool calling or JSON mode is used (required by Groq for those models —
without it the request 400s). A transient upstream 5xx is retried once after
a short backoff before it reaches the console, so a provider blip no longer
surfaces as a hard error. New wire-format and retry assertions landed in
`tests/ai-providers.test.js`, and five stale Part-B assertions (the provider
grid became a picker + config card) were updated to match the current view.

**Email members: external recipients + AI rephrase.** Admin → Email now
accepts **external addresses** (comma-separated, anyone — no FirmLedger
account needed) on top of the existing audience groups and member search;
addresses are validated, de-duplicated and merged with the picked audience,
and the "To" picker is no longer the only way to send. The message box gained
a **Rephrase with AI** button that rewrites the draft — plain text in → plain
text out, HTML in → HTML out, `{{name}}` placeholders and links preserved —
using whatever provider/model is configured in the AI Playground
(`POST /admin3119Musa/email/rephrase`). The result lands back in the box for
review; the endpoint never sends mail.

## 2026-09-08 — Blog: how listing news works, plus a complete site overview README

**Blog post.** A new post ships in the seed (`src/lib/blogseed.js`), so every
install gets it at the top of `/blog`, in `/feed.xml` and in the sitemap:
*News on FirmLedger: what a profile is allowed to say about the news*. It follows
the existing post layout — `<p class="lead">` opener, `<h2>` sections, `<code>`
and lists — and explains the feature in the same voice as the rest of the blog:
what counts as a story here, the three doors it can arrive through, the accuracy
gate (full name as a phrase, or the company's own domain — everything else is
dropped), why member submissions wait for a moderator, the hourly upkeep that
keeps stories from going stale, and the list of things we deliberately don't do
(no machine-written summaries, no paid placement, no story without a citable link).

**New README.** `README_OVERVIEW.md` documents the whole site in one place: what
FirmLedger is, the eight-stage pipeline (ingest → normalize → resolve → score →
verify → moderate → enrich → publish), the anatomy of a listing profile with a
field-by-field provenance table, what visitors / members / owners / moderators can
each do, the three verification methods, what Pro unlocks and what stays free, a
map of every console area, the news layer and automated upkeep, the public API,
trust and safety, the indexing stack, email and notifications, the project layout,
the stack, how to run and test it, the six principles underneath, and a glossary.
`README.md` now points at it from the top instead of leaving a new reader to guess.

**Tests.** The news suite grew post-content checks (88 checks, up from 81) and the
API suite's blog ordering check now asserts the invariant that actually matters —
the production API guide sits above the announcement it supersedes — rather than
assuming it will forever be the newest post. All 12 suites pass.

## 2026-09-08 — Listing news: automatic detection, member submissions, moderation

Every profile can now carry what is being published about the company, and the
ledger keeps it honest in both directions.

**Detection.** A sweep searches a public news index (Google News RSS by default,
`NEWS_SEARCH_URL` to point it elsewhere) for each company. A story is stored
only if it clears the accuracy gate in `lib/news.js`: it carries the company's
**full name as a phrase** (legal suffixes stripped, so "Safari Fintech Ltd" and
"Safari Fintech Limited" are one company), or it sits on — or cites — the
company's **own domain** (the `<source url="…">` of wrapped feeds counts). A
partial name ("Safari" for "Safari Fintech"), a namesake, or unrelated coverage
is dropped: near-misses are never stored, and a failed scan records nothing
rather than guessing.

**Member submissions.** Anyone signed in can submit a story from
`/listing/:slug/news` (headline, link, publication, date, note). It lands in
`pending`, is invisible on the public profile, and notifies the console and the
owner. A moderator approves or rejects it in **Admin → News** — the submitter is
told either way, and the page shows them the status of their own submissions.
Duplicate links are refused, CSRF and the rate limiter apply, and guests are
sent to sign in first.

**The console.** Admin → **News** is one queue for all of it: pending
submissions to moderate, detected stories, stories written by hand (published
immediately, because a human wrote them), filters by status and origin, and the
sweep controls — *Check N due listings* / *Check all N listings* — with the same
background-runner contract as the technology radar (live progress, one run at a
time, stoppable, last run recorded). Each listing's edit page has its own News
panel: its stories, **Look for stories now**, and add-one-by-hand. Detected
stories can be held for moderation instead of publishing (`news_review_auto`).
The assistant gained `approve_news` / `reject_news` (63 tools).

**Automated upkeep** (the scheduled sweep that was still missing): an hourly
job, on by default, that refreshes stale technology snapshots and re-checks
news coverage — capped per hour, per-job switchable, and clamped when saved.
Admin → Settings → **Automated upkeep** carries the switches, the caps, the
last run and a **Run upkeep now** button. The console's own buttons are
unaffected by the schedule.

```
npm test                          # 12 suites
node tests/news-upkeep.test.js    # 81 checks, fully offline
```

---

## 2026-09-08 — Admin → Listings: refresh the technology radar (one, a selection, or all)

Keeping every profile's technology snapshot honest is now a first-class admin
maintenance job instead of something that only happens when a record is created
or an owner clicks refresh on their own listing.

**One place, five ways to run it** — every path lands on the same engine in
`src/lib/techrefresh.js`, which calls the existing detector in `lib/enrich.js`:

| Where | Action |
| --- | --- |
| Admin → Listings, row button **↻ Tech** | re-scans that one company |
| Admin → Listings → edit → **Technology radar** panel | shows the current chips + scan date, refreshes in place |
| Bulk action **Refresh technology radar** | any ticked rows — every row is tickable now, not only pending ones |
| **Refresh all N in this view** | exactly the rows the current filter renders |
| **Refresh N stale** / **Refresh entire directory (N)** | never-scanned or older than 90 days, or every listing with a website |

**It runs in the background.** A run takes a pool of four homepages at a time
(8s timeout each), never stacks a second run on top of a live one, can be
**Stop**ped mid-flight, and reports `done / changed / unchanged / without a
website / failed` live on `/admin3119Musa/listings/tech-job.json` — the page
polls it and reloads when the run lands. The last run's summary is kept on the
page, and the console gets an in-app notification when a run finishes.

**Nothing is invented.** A page that answers nothing gets `0 technologies`
recorded with today's scan date, a listing with no website is reported as
skipped (never "scanned successfully"), and a real change to a stack still
notifies the listing's watchers exactly as an owner-triggered refresh does.
The new **Tech** column and the **Any tech scan / Never scanned / Stale / Fresh**
filter make the backlog visible, and the admin dashboard carries the stale
count with a one-click shortcut.

The assistant can do it too: `refresh_listing_tech` (61 tools now) re-scans a
listing by id or slug from the AI Playground.

```
npm test                            # 11 suites
node tests/admin-tech-refresh.test.js   # 66 checks, fully offline
```

---

## 2026-09-07 — Admin sign-in chain: secret → emailed OTP → authenticator

The admin gate is now a strict three-step chain, everything else untouched:

1. **The admin secret code** (`ADMIN_SECRET`) — the gate screen, as always.
2. **A one-time 6-digit code emailed to the admin inbox** — a dedicated
   verification screen right after the secret. The OTP inbox is
   `admin@firmledger.co.ke` by default: attached to the account in Settings
   (Admin → Settings → Two-factor → “Sign-in OTP inbox”), overridable with
   `ADMIN_2FA_EMAIL`. Codes live 10 minutes, work once, a newer email retires
   the last instantly, resends are one per minute, and five wrong attempts
   discard the verification.
3. **The authenticator (or a recovery code), as it always was** — TOTP codes,
   the 10 one-time recovery codes, the 5-attempt throttle and the Settings
   reset/regenerate actions are unchanged. The emailed fallback that used to
   sit *alongside* this step has moved out (it IS step 2 now, and is burned
   once used).

**The authenticator key is attached to the account, not a device.** The TOTP
secret lives in the database (`admin_totp_secret`), so the QR is shown exactly
once — at first enrollment. Every later sign-in, from any device and across
restarts, asks only for the code; an interrupted enrollment reuses the same
pending key so a half-scanned QR is never invalidated either.

Mechanically: the pending session now has two stages (`admin-pending` after
the secret, `admin-pending2` after the emailed code is proven), the step-2
routes live at `/admin3119Musa/2fa-email` (+ `/resend`), and the mail is a
real send through the configured SMTP chain (outbox fallback in dev).

```
npm run test:2fa   # 35 checks: the whole chain, real mail, nothing stubbed
npm test           # 10 suites
```

---

## 2026-09-07 — Indexing health: crawler-proof URLs, hosts and rate limiting

Four fixes for things a search crawler met as errors (Search Console-speak:
"Duplicate without user-selected canonical", "Invalid URL / invalid lastmod",
"Page fetch failed"). Nothing else moved — same pages, same markup, same limits.

### 1. One URL per page — trailing-slash 301s (`server.js`)

Every route was always defined without a trailing slash, but `/about/`,
`/directory/`, `/listing/acme/`, `/blog/` answered **200 alongside** the
canonical URL — the same page indexable twice with split signals. A GET/HEAD
on any `/path/` now answers **301** onto `/path` (query string preserved,
root `/` untouched, POSTs never redirected).

### 2. One host per site — `www.` 301s to the apex (`server.js`)

The existing `firmledger.onrender.com → firmledger.co.ke` redirect is joined
by a general one: a request whose Host is `www.<BASE_URL host>` answers 301 to
the apex origin, so the site can never be indexed under two hosts.

### 3. Sitemap hygiene (`src/routes/public.js`)

* **No fragment URLs** — `/careers#role-…` entries are gone from
  `static.xml`: `<loc>` must be a plain URL per the sitemap protocol and
  Search Console reported the anchors as errors. The `/careers` page itself
  stays in the sitemap; the role anchors are plain links on it.
* **No fabricated `lastmod`** — the `static.xml` entry in the sitemap index no
  longer stamps "today" on every fetch (a lastmod that always says now is
  noise to crawlers). Real dates (listings, blog posts) are untouched.

### 4. Rate limiting never blocks indexing (`src/lib/spam.js`)

The scrape ceiling (default 180 page loads/min/IP) stays exactly as
configured — but two carve-outs were added:

* **SEO files are always reachable**: `/robots.txt`, `/sitemap.xml`,
  `/sitemaps/*`, `/feed.xml` and the IndexNow key file skip the limiter, so a
  mid-throttle crawler still reads the sitemap instead of meeting a 429.
* **Verified search bots skip the page ceiling**: a Googlebot/Bingbot/
  DuckDuckBot/Yandex/Baidu/Applebot User-agent earns nothing by itself — the
  IP must pass the two-step check (reverse DNS lands on a bot domain, forward
  DNS returns the same IP, results cached 24 h, failing resolvers fail
  closed). Verified bots crawl bursts without 429s; spoofed UAs fall back to
  the normal limits.

### Test

```
npm run test:health    # 33 checks: the crawl view above, regression-locked
npm test               # now 9 suites
```

`tests/indexing-health.test.js` boots the real server and asserts: the 301s
(slash + www + onrender, query strings riding along), sitemap hygiene (no
fragments, no fake lastmod, every `<loc>` absolute and every one of them
answering 200), robots.txt unchanged, and the limiter carve-outs — SEO files
200 mid-throttle, Retry-After on the 429 page, spoofed Googlebot still
throttled, real bot verification proven against a stubbed resolver.

---

## 2026-09-03 — Google Indexing API, featured-records marquee, permanent incident delete

### 1. Google Indexing API (`src/lib/googleIndexing.js`, new)

Approved and updated listings now ping Google directly, alongside the existing
IndexNow push to Bing/Yandex/DuckDuckGo.

| Piece | Where it lives |
| --- | --- |
| `pingGoogleNewListing(url)` — reusable background utility | `src/lib/googleIndexing.js` |
| Service-account key (upload or paste), saved permanently | Admin → Settings → Google Indexing API → `data/service-account.json` (0600) |
| Credentials in production | `GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON` (stringified JSON in the environment) |
| Back-fill button | Admin → Settings → **Submit first 200 listings** |
| Audit trail | Admin → Settings → **Indexing log** (scrollable, deletable) |

* **Credentials resolve in order:** `GOOGLE_INDEXING_SERVICE_ACCOUNT_JSON` → the
  uploaded `data/service-account.json` → a local `./service-account.json` for
  development. All three are git-ignored; `.gitignore` now names
  `service-account.json`, `*service-account*.json` and `*.pem` explicitly.
* **Auth + publish** use `google.auth.GoogleAuth` (scope
  `https://www.googleapis.com/auth/indexing`) and
  `indexing.urlNotifications.publish` with `{ url, type: 'URL_UPDATED' }`.
* **Logs** — success: `console.log` with the target URL and the API status code;
  failure: `console.error` with the target URL, status and message. Both are also
  written to the `indexing_log` table shown in the console, where entries can be
  deleted one by one or cleared.
* **Controller integration** — the helper fires in the background (never awaited)
  from admin approve / bulk-approve / create / edit, dashboard create / edit, the
  claim flow and the AI tools, each time a record ends up public.
* **200/day quota + never twice** — every accepted URL is recorded in
  `google_indexing_submissions`; the manual run only ever picks URLs missing from
  that table, stops on HTTP 429 and reports how much quota is left. Progress is
  polled live on the settings page.

### 2. Homepage featured records (`views/home.ejs`, `src/routes/public.js`)

Up to **8** featured records render exactly as before in the grid. Beyond 8 the
strip becomes the same seamless horizontal marquee as the promoted (sponsored)
listings — two identical passes of the cards, one pass of travel, hover/focus or
the Pause button freezes it, and `prefers-reduced-motion` turns it into a
swipeable row. Same `l-card` markup, same spacing, same typography.

### 3. Admin → Status: permanent incident delete

Each incident card now carries a **Delete** button next to Resolve. It removes
the row and its whole timeline (`incident_updates` cascades), so the incident
disappears from the public `/status` page, from the 30-day history and from the
console. If that incident was the only thing holding its component down, the
component is healed back to operational; everything else on the page is untouched.

### 4. Tests

```
npm test                # everything
npm run test:indexing   # Google Indexing API + featured rail
```

`tests/google-indexing.test.js` (62 checks) runs the real server and the real
library against a stubbed `googleapis` client (`tests/helpers/googleapis-stub.js`,
preloaded with `node -r`), so it needs no Google credentials and no network.

---

## 2026-09-02 — Backup completeness, production-ready AI assistant, contained admin queues

### 1. `.firmledger` backup now carries the whole console (`src/lib/backup.js`)

**Download (Admin → Users → Full backup, Admin → Health → Backup)**

The file is still one pretty-printed JSON document, now with three readable
sections on top of the raw table dump:

| Section | Contents |
| --- | --- |
| `users` | every account: name, email, password hash, plan, expiry, suspension, 2FA state, their listings/claims/tickets/payments |
| `listings` | **every listing in the ledger** (owned or not) with a spelled-out `configuration` block — status, category, type, featured, claimed, sponsorship + expiry, listing Pro plan + expiry, verified badge, socials, sources, tags — plus its jobs, relationships and the owner's e-mail |
| `configuration` | settings (all key/values), categories, plan offers, promo codes, advertising packages, careers, blog posts, protection IP/domain rules, status components + incidents, newsletter subscribers |
| `database` | authoritative table-by-table snapshot used by the restore |

Sessions, password-reset tokens, registration OTPs and TOTP secrets are still
excluded on purpose.

**Import (Admin → Users → Import from file)**

Import used to restore identities only. It now rebuilds the ledger and the
configuration as well:

* users merge by e-mail (unchanged behaviour, original password hashes kept);
* listings merge by slug, with ownership re-attached through the owner e-mail so
  a restore into a fresh database keeps the right owner even when ids shift;
* every other table is restored on its natural key (slug / code / value / key),
  and keyless tables are matched on the whole row — importing the same file
  twice creates no duplicates;
* nothing is deleted; the flash message reports accounts *and* records restored.

### 2. AI Playground — a real agent, tested action by action

Design and layout unchanged. The engine underneath is new (`src/lib/ai.js`):

* **Agent loop.** The assistant can look a record up and then act on it inside
  one turn: tool results are fed back to the model and it continues until the job
  is finished (6 model steps / 12 tool runs per turn, then it says what is left).
* **Multi-action turns are executed, not refused.** Previously two tool calls in
  one response were rejected outright. They are now parked as a single numbered
  confirmation and executed in order when the operator presses Run.
* **Honest reporting.** The summary is generated from actual tool return values;
  a failed tool is reported as failed and `executed` stays false.
* **Unknown tool names** no longer end the turn — the model is told and retries.
* Cancellation still executes nothing, and `delete_user` still always confirms.

**All 60 admin tools are tested for real effect**, not for a happy-looking
response: `tests/ai-tools.test.js` runs every tool against a throwaway database
and asserts the resulting database state (76 checks). One real bug was found and
fixed on the way: fulfilling a removal request deleted the request along with the
listing (FK cascade), so the "removed" outcome vanished from Admin → Removals.

* `migrations/2026-09-02-removal-requests-history.sql` (and the equivalent
  automatic migration in `src/db.js`) makes `removal_requests.listing_id`
  nullable `ON DELETE SET NULL`;
* both the AI tool and the admin route now resolve the request before deleting
  the listing, so the record survives.

### 3. Admin queues scroll inside their cards

Long lists no longer stretch the console into an extra-tall page. Two classes in
`public/css/app.css`, both modelled on the notifications inbox (contained, quiet
scrollbar, sticky table header, `overscroll-behavior: contain`):

* `.scroll-table` — wraps a `.table-wrap`;
* `.scroll-panel` — for card lists that are not tables.

Applied to: Listings, Ownership claims, Users, Categories, Pricing (free trials),
Advertising (currently sponsored + all listings), Careers (roles), Status (recent
incidents), Promos (codes), Protection (IP rules + domain rules), Health (mail
hops), Removal requests, Support tickets, Email (recent sends), Blog posts, and
Settings (recent Pro payments).

### 4. Tests

```
npm test            # everything
npm run test:ai     # AI tools + agent loop
npm run test:backup # .firmledger round trip
npm run test:pages  # every admin page renders and its list scrolls
```

| Suite | What it proves |
| --- | --- |
| `tests/ai-tools.test.js` | all 113 assistant tools really change the database, and sensitive ones can never be auto-run |
| `tests/ai-agent.test.js` | chaining, batched confirmation, cancellation, honest failures (model stubbed — no key needed) |
| `tests/ai-providers.test.js` | every provider dialect on the wire (OpenAI, Anthropic, Gemini, Cohere), key resolution, provider switching, fallback, rate limits + the Playground console UI |
| `tests/backup.test.js` | backup carries users + all listings + configuration, restores into an empty database, and is idempotent |
| `tests/admin-pages.test.js` | boots the real server and checks every admin page renders with its list in a scroll region |
| `tests/admin-tech-refresh.test.js` | technology-radar maintenance end to end, offline: one listing, a selection, a filtered view, stale and whole-directory runs, the single-run lock, cancellation, CSRF and the tech filter |
| `tests/news-upkeep.test.js` | the news accuracy gate (name, domain, near-miss and wrapped-link cases), detection, member submission → pending → approval, console moderation, background sweeps and the hourly upkeep schedule |

`FIRMLEDGER_DATA_DIR` was added to `src/db.js` so suites run against a temporary
database and never touch `data/`.

---

# AI Playground Admin Area - Changes Summary (2026-09-01)

See git history for the previous round: model registry refresh, stateless
assistant (chat history removed), audit/moderation log deletion.
