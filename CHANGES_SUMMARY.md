# FirmLedger — change summary

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
| `tests/ai-tools.test.js` | all 60 assistant tools really change the database |
| `tests/ai-agent.test.js` | chaining, batched confirmation, cancellation, honest failures (Groq stubbed — no key needed) |
| `tests/backup.test.js` | backup carries users + all listings + configuration, restores into an empty database, and is idempotent |
| `tests/admin-pages.test.js` | boots the real server and checks every admin page renders with its list in a scroll region |

`FIRMLEDGER_DATA_DIR` was added to `src/db.js` so suites run against a temporary
database and never touch `data/`.

---

# AI Playground Admin Area - Changes Summary (2026-09-01)

See git history for the previous round: model registry refresh, stateless
assistant (chat history removed), audit/moderation log deletion.
