/**
 * FirmLedger admin assistant — the rule-based "brain".
 *
 * No model, no API, nothing leaves the server. A message goes through:
 *
 *   normalise → synonyms/stemming → slot extraction (ids, emails, refs, slugs,
 *   quoted names, statuses, days, on/off…) → intent rules → entity resolution
 *   against the real database → ask a question when something is missing →
 *   plan of console actions (the same registry every other admin surface uses)
 *
 * The caller (src/lib/ai.js) executes the plan: lookups run at once, writes
 * confirm first unless auto-allowed, sensitive writes always confirm. This
 * module never touches the database for writes — it only reads to resolve
 * "which listing / which member did you mean".
 *
 * Context memory lives in the browser tab (the page posts it back with every
 * turn) so the server stays stateless: last listing, last member, last ticket,
 * the open question, the pending confirmation.
 */
const { db, getSetting } = require('../db');
const tools = require('./aitools');
const mailer = require('./mailer');

/* Where “email admin” goes — the admin's notification inbox. The setting
   (Admin → Settings → admin_email) wins, then ADMIN_NOTIFY_EMAIL, then the
   shipped default. Mirrors adminNotifyEmail() in src/lib/ai.js so the
   assistant and the moderation emails always land in the same place. */
function adminEmail() {
  return getSetting('admin_email', '') || process.env.ADMIN_NOTIFY_EMAIL || 'hello@firmledger.co.ke';
}

/* ------------------------------------------------------------------ */
/* 1. Vocabulary                                                       */
/* ------------------------------------------------------------------ */

/* Multi-word phrases first (longest match wins), mapped to one canonical token. */
const PHRASES = [
  /* queue / review questions */
  ['anything waiting', 'count pending'], ['anything pending', 'count pending'], ['anything to review', 'count pending'], ['anything new', 'count pending'],
  ['whats pending', 'count pending'], ['what is pending', 'count pending'], ['what needs my attention', 'briefing'], ['what needs attention', 'briefing'], ['what needs doing', 'briefing'],
  ['what should i do', 'briefing'], ['where do i start', 'briefing'], ['morning briefing', 'briefing'], ['daily briefing', 'briefing'], ['catch me up', 'briefing'], ['whats new', 'briefing'], ['what is new', 'briefing'], ['todo', 'briefing'], ['to do', 'briefing'], ['my queue', 'briefing'],
  ['is everything up', 'statuspage'], ['is everything ok', 'statuspage'], ['is everything okay', 'statuspage'], ['is the site up', 'statuspage'], ['is the site down', 'statuspage'], ['are we up', 'statuspage'], ['are we down', 'statuspage'],
  ['how is the site', 'overview'], ['how are we doing', 'stats'], ['how are things', 'stats'], ['site summary', 'stats'],
  ['audit log', 'auditlog'], ['audit trail', 'auditlog'], ['what did you do', 'auditlog'], ['what have you done', 'auditlog'], ['what did i just do', 'auditlog'], ['what did i do', 'auditlog'], ['recent actions', 'auditlog'], ['action history', 'auditlog'], ['command log', 'auditlog'],
  ['moderation log', 'modlog'], ['moderation history', 'modlog'], ['moderation decisions', 'modlog'], ['auto moderation log', 'modlog'], ['screening log', 'modlog'],
  ['moderation rules', 'modrules'], ['screening rules', 'modrules'], ['block list', 'modrules'], ['blocked terms', 'modrules'], ['blocked words', 'modrules'], ['flagged terms', 'modrules'],
  ['approve threshold', 'approveat'], ['approval threshold', 'approveat'], ['approve at', 'approveat'], ['auto approve threshold', 'approveat'], ['reject threshold', 'rejectat'], ['rejection threshold', 'rejectat'], ['reject at', 'rejectat'],
  ['blocked ips', 'show iprule'], ['blocked ip', 'show iprule'], ['ip blocks', 'show iprule'], ['ip rules', 'show iprule'], ['blocked domains', 'show domainrule'], ['domain rules', 'show domainrule'], ['spam rules', 'show iprule domainrule'], ['protection rules', 'show iprule domainrule'], ['allow list', 'show iprule domainrule'],
  ['keep alive', 'keepalive'], ['keep-alive', 'keepalive'], ['keepalive', 'keepalive'], ['indexnow key', 'indexnowkey'], ['index now key', 'indexnowkey'], ['regenerate key', 'rotate indexnowkey'], ['rotate the key', 'rotate indexnowkey'], ['rotate key', 'rotate indexnowkey'],
  ['cancel the tech', 'cancel tech'], ['stop the tech', 'cancel tech'], ['stop tech', 'cancel tech'], ['cancel the news', 'cancel news'], ['stop the news', 'cancel news'], ['stop news', 'cancel news'], ['stop the sweep', 'cancel sweep'], ['cancel the sweep', 'cancel sweep'],
  ['api keys', 'apikey'], ['api key', 'apikey'], ['developer keys', 'apikey'], ['developer key', 'apikey'],
  ['mail accounts', 'mailaccount'], ['smtp accounts', 'mailaccount'], ['smtp settings', 'mailaccount'], ['email settings', 'mailaccount'], ['mail settings', 'mailaccount'], ['mail setup', 'mailaccount'], ['sent from', 'mailaccount'], ['from address', 'mailaccount'],
  ['restore backup', 'restorebackup'], ['restore a backup', 'restorebackup'], ['import backup', 'restorebackup'], ['restore from backup', 'restorebackup'],
  ['log everyone out', 'logoutall'], ['log out everyone', 'logoutall'], ['sign everyone out', 'logoutall'], ['invalidate sessions', 'logoutall'],
  ['for review', 'pending'], ['to review', 'pending'], ['review queue', 'pending'], ['needs review', 'pending'], ['under review', 'pending'], ['in review', 'pending'], ['awaiting review', 'pending'], ['waiting review', 'pending'], ['pending review', 'pending'], ['review pending', 'show pending'], ['review the pending', 'show pending'], ['review the queue', 'show pending'], ['reviewed listings', 'approved listing'],
  ['score it', 'score it'], ['moderate it', 'moderate it'], ['review it', 'moderate it'], ['run moderation on', 'moderate'], ['run the moderator on', 'moderate'], ['review listing', 'moderate listing'], ['review now', 'moderate'], ['review this', 'moderate it'], ['review that', 'moderate it'],
  ['top 3', 'newest 3'], ['top 5', 'newest 5'], ['top 10', 'newest 10'], ['top ten', 'newest 10'], ['top five', 'newest 5'], ['top three', 'newest 3'], ['last 5', 'newest 5'], ['last 10', 'newest 10'], ['last 3', 'newest 3'], ['latest 5', 'newest 5'], ['latest 10', 'newest 10'],
  ['this month', 'thismonth'], ['this week', 'thisweek'], ['last week', 'thisweek'], ['past week', 'thisweek'], ['last month', 'thismonth'], ['past month', 'thismonth'], ['last 7 days', 'thisweek'], ['last 30 days', 'thismonth'],
  ['made money', 'payment'], ['make money', 'payment'], ['did we make', 'payment'], ['did we earn', 'payment'], ['cash in', 'payment'], ['how much did we', 'count payment'],
  ['its fine', ''], ['it is fine', ''], ['ok fine', ''], ['fine', ''], ['sure', ''], ['alright', ''], ['go ahead and', ''], ['just', ''],
  ['who is on trial', 'show trial user'], ['on trial', 'trial'], ['trialing', 'trial'], ['trialling', 'trial'],
  ['notifications read', 'markread'], ['notifications as read', 'markread'], ['everything read', 'markread'],
  ['never mind', 'cancel'], ['nevermind', 'cancel'], ['forget it', 'cancel'], ['forget that', 'cancel'], ['scratch that', 'cancel'], ['cancel that', 'cancel'], ['drop it', 'cancel'], ['stop that', 'cancel'],
  ['start over', 'reset'], ['start again', 'reset'], ['clear context', 'reset'], ['new conversation', 'reset'], ['forget everything', 'reset'],
  ['ping google', 'googleindex ping'], ['submit to google', 'googleindex ping'], ['resubmit to google', 'googleindex ping'], ['send to google', 'googleindex ping'], ['reindex', 'googleindex ping'], ['re index', 'googleindex ping'],
  ['who owns', 'show owner of'], ['owner of', 'show owner of'], ['whose listing is', 'show owner of'],
  ['what plan is', 'show'], ['which plan is', 'show'], ['when did', 'show'], ['is', 'show'],
  ['close all solved', 'closeallsolved'], ['close solved tickets', 'closeallsolved'], ['close all resolved', 'closeallsolved'], ['archive solved tickets', 'closeallsolved'],
  ['expire promo', 'promo off'], ['deactivate promo', 'promo off'], ['kill promo', 'promo off'], ['activate promo', 'promo on'], ['reactivate promo', 'promo on'],
  ['post a job', 'create career'], ['post a role', 'create career'], ['new job', 'create career'], ['new role', 'create career'], ['new vacancy', 'create career'], ['hire for', 'create career'],
  ['write a post', 'create post'], ['draft a post', 'create post'], ['new post', 'create post'], ['new article', 'create post'], ['new blog', 'create post'],
  ['new plan', 'create planoffer'], ['new offer', 'create planoffer'], ['new tier', 'create planoffer'], ['new promo', 'create promo'], ['new coupon', 'create promo'], ['new category', 'create category'], ['new package', 'create adpackage'], ['new listing', 'create listing'], ['new company', 'create listing'], ['add a company', 'create listing'], ['add a listing', 'create listing'],
  ['maintenance message', 'maintenance on message'], ['maintenance banner', 'maintenance on message'], ['put up maintenance', 'maintenance on'], ['maintenance mode', 'maintenance'],
  ['how many', 'count'], ['number of', 'count'], ['how much', 'count'],
  ['what are the', 'show'], ['what is the', 'show'], ['whats the', 'show'], ['what is', 'show'], ['what are', 'show'],
  ['tell me', 'show'], ['give me', 'show'], ['show me', 'show'], ['let me see', 'show'], ['pull up', 'show'],
  ['look up', 'show'], ['lookup', 'show'], ['looking for', 'show'], ['bring up', 'show'], ['check on', 'show'],
  ['whats up with', 'show'], ['what happened with', 'show'],
  ['get rid of', 'delete'], ['take down listing', 'delete listing'], ['take off', 'delete'],
  ['make it live', 'approve it'], ['make live', 'approve'], ['live now', 'approve'], ['set it live', 'approve it'], ['go live', 'approve'], ['put live', 'approve'], ['set live', 'approve'],
  ['push live', 'approve'], ['sign off', 'approve'], ['green light', 'approve'], ['greenlight', 'approve'],
  ['turn down', 'reject'], ['knock back', 'reject'], ['send back', 'reject'],
  ['lock out', 'suspend'], ['lock them out', 'suspend them'], ['shut out', 'suspend'], ['boot out', 'suspend'],
  ['let back in', 'unsuspend'], ['let them back in', 'unsuspend them'], ['un suspend', 'unsuspend'], ['un ban', 'unban'],
  ['take away', 'revoke'], ['take back', 'revoke'], ['strip of', 'revoke'], ['remove pro', 'revoke pro'], ['drop pro', 'revoke pro'],
  ['take the site down', 'maintenance on'], ['take site down', 'maintenance on'], ['take us offline', 'maintenance on'],
  ['go offline', 'maintenance on'], ['bring the site back', 'maintenance off'], ['bring it back up', 'maintenance off'],
  ['bring us back', 'maintenance off'], ['back online', 'maintenance off'], ['go online', 'maintenance off'],
  ['turn on', 'on'], ['switch on', 'on'], ['turn off', 'off'], ['switch off', 'off'],
  ['un feature', 'unfeature'], ['remove from featured', 'unfeature'], ['remove featured', 'unfeature'], ['stop featuring', 'unfeature'],
  ['remove sponsorship', 'unsponsor'], ['remove sponsor', 'unsponsor'], ['end sponsorship', 'unsponsor'], ['stop sponsoring', 'unsponsor'], ['un sponsor', 'unsponsor'],
  ['status check', 'statuspage run'], ['check the status page', 'statuspage run'], ['status page', 'statuspage'], ['status report', 'statusreport'], ['weekly report', 'statusreport'],
  ['rate limit', 'ratelimit'], ['rate limits', 'ratelimit'],
  ['two factor', '2fa'], ['two-factor', '2fa'], ['one time code', '2fa'], ['otp inbox', '2fa'], ['otp email', '2fa'],
  ['blog post', 'post'], ['news story', 'story'], ['news stories', 'story'], ['job role', 'career'], ['careers role', 'career'],
  ['promo code', 'promo'], ['discount code', 'promo'], ['coupon code', 'promo'], ['plan offer', 'planoffer'], ['pricing offer', 'planoffer'],
  ['ad package', 'adpackage'], ['advert package', 'adpackage'], ['advertising package', 'adpackage'], ['sponsored content', 'adpackage'],
  ['removal request', 'removal'], ['takedown request', 'removal'], ['pro transfer', 'transfer'],
  ['tech radar', 'tech'], ['technology radar', 'tech'], ['tech stack', 'tech'], ['technology stack', 'tech'],
  ['password reset', 'passwordreset'], ['reset password', 'passwordreset'], ['reset link', 'passwordreset'], ['reset their password', 'passwordreset'],
  ['mark as read', 'markread'], ['mark read', 'markread'], ['mark all read', 'markread'], ['inbox read', 'markread'], ['mark inbox read', 'markread'], ['mark notifications read', 'markread'], ['clear inbox', 'markread'], ['clear the inbox', 'markread'],
  ['mark solved', 'solved'], ['mark as solved', 'solved'], ['mark resolved', 'solved'], ['mark as resolved', 'solved'], ['mark closed', 'closed'], ['mark as closed', 'closed'],
  ['re open', 'reopen'], ['re-open', 'reopen'], ['open again', 'reopen'], ['open back up', 'reopen'],
  ['send test', 'testmail'], ['test email', 'testmail'], ['test mail', 'testmail'], ['test the smtp', 'testmail'], ['test smtp', 'testmail'],
  ['index now', 'indexnow'], ['google indexing', 'googleindex'], ['indexing api', 'googleindex'], ['search console', 'googleindex'],
  ['free trial', 'trial'], ['what can you do', 'help'], ['what do you do', 'help'], ['how do i', 'help'], ['how does this work', 'help'],
  ['site overview', 'overview'], ['what is firmledger', 'overview'], ['about the site', 'overview'], ['site map', 'overview'],
  ['this week', 'thisweek'], ['past week', 'thisweek'], ['last week', 'thisweek'], ['last 7 days', 'thisweek'], ['past 7 days', 'thisweek'],
  ['today', 'today'], ['this month', 'thismonth'], ['last 30 days', 'thismonth'], ['past 30 days', 'thismonth'],
  ['all of them', 'all'], ['every one', 'all'], ['everyone', 'all'], ['everybody', 'all'],
  ['its fine', ''], ['it is fine', ''], ['ok fine', ''], ['fine', ''], ['sure', ''], ['alright', ''], ['go ahead and', ''], ['just', ''],
  ['who is on trial', 'show trial user'], ['on trial', 'trial'], ['trialing', 'trial'], ['trialling', 'trial'],
  ['notifications read', 'markread'], ['notifications as read', 'markread'], ['everything read', 'markread'],
  ['never mind', 'cancel'], ['nevermind', 'cancel'], ['forget it', 'cancel'], ['scratch that', 'cancel'],
  ['go ahead', 'yes'], ['do it', 'yes'], ['run it', 'yes'], ['proceed', 'yes'], ['confirm', 'yes'], ['confirmed', 'yes'],
  ['start over', 'reset'], ['new chat', 'reset'], ['clear chat', 'reset'],
  ['open incidents', 'show incident'], ['any incidents', 'show incident'], ['open tickets', 'show ticket open'],
  ['new signups', 'show user newest'], ['new sign ups', 'show user newest'], ['recent signups', 'show user newest'], ['new users', 'show user newest'], ['new members', 'show user newest'], ['new accounts', 'show user newest'], ['who signed up', 'show user newest'], ['who joined', 'show user newest'],
];

/* word → canonical token. Looked up after light stemming. */
const WORDS = {
  /* reading */
  show: 'show', list: 'show', display: 'show', see: 'show', view: 'show', find: 'show', fetch: 'show', search: 'show',
  check: 'show', open: 'open', browse: 'show', read: 'show', inspect: 'show', describe: 'show', detail: 'show', details: 'show', info: 'show', about: '',
  who: 'show', where: 'show', which: 'show', any: 'show', got: 'show', have: 'show', has: 'show', is: 'show', are: 'show', do: 'show', does: 'show',
  count: 'count', total: 'count', totals: 'count', many: 'count',
  summary: 'stats', summarise: 'stats', summarize: 'stats', overview: 'overview', stats: 'stats', statistics: 'stats', numbers: 'stats', dashboard: 'stats', metrics: 'stats', figures: 'stats', kpis: 'stats',
  /* writing verbs */
  approve: 'approve', approved: 'approve', approval: 'approve', approvals: 'approve', accept: 'approve', accepted: 'approve', acceptance: 'approve', publish: 'approve', pass: 'approve', okay: 'approve', ok: 'approve', allow: 'allow', verify: 'verify', live: 'live', clear: 'clear',
  auto: 'auto', automatic: 'auto', automatically: 'auto', safely: 'safe', safe: 'safe', assess: 'moderate', assesss: 'moderate', evaluate: 'moderate', decide: 'moderate', decision: 'moderate', verdict: 'moderate', why: 'why', should: 'should', can: 'can',

  reject: 'reject', rejected: 'reject', decline: 'reject', declined: 'reject', refuse: 'reject', deny: 'reject', denied: 'reject', unpublish: 'unpublish', hide: 'hide',
  delete: 'delete', remove: 'delete', kill: 'delete', drop: 'delete', wipe: 'delete', erase: 'delete', destroy: 'delete', nuke: 'delete', purge: 'delete', trash: 'delete', scrap: 'delete', discard: 'delete',
  feature: 'feature', featured: 'feature', spotlight: 'feature', highlight: 'feature', showcase: 'feature', star: 'feature', pin: 'feature',
  unfeature: 'unfeature', unspotlight: 'unfeature', unhighlight: 'unfeature', unstar: 'unfeature', unpin: 'unfeature',
  sponsor: 'sponsor', sponsored: 'sponsor', sponsorship: 'sponsor', unsponsor: 'unsponsor',
  suspend: 'suspend', suspended: 'suspend', ban: 'suspend', banned: 'suspend', kick: 'suspend', freeze: 'suspend', frozen: 'suspend', disable: 'off', deactivate: 'off',
  unsuspend: 'unsuspend', unban: 'unsuspend', unfreeze: 'unsuspend', reinstate: 'unsuspend', reactivate: 'on', unblock: 'unblock', unlock: 'unsuspend',
  grant: 'grant', give: 'grant', award: 'grant', gift: 'grant', upgrade: 'grant', extend: 'grant', boost: 'grant',
  revoke: 'revoke', downgrade: 'revoke', strip: 'revoke', cancel: 'cancel', end: 'revoke', stop: 'stop', abort: 'cancel', halt: 'stop',
  make: 'make', set: 'set', change: 'set', update: 'set', edit: 'set', modify: 'set', rename: 'rename', move: 'move', assign: 'assign', transfer: 'transfer', attach: 'assign', unclaim: 'unclaim',
  create: 'create', add: 'create', new: 'create', post: 'post', write: 'create', draft: 'draft', compose: 'create', register: 'create', insert: 'create',
  send: 'send', email: 'email', mail: 'email', notify: 'email', message: 'email', announce: 'email', broadcast: 'email', blast: 'email',
  reply: 'reply', respond: 'reply', answer: 'reply',
  resolve: 'solved', solve: 'solved', solved: 'solved', fix: 'solved', fixed: 'solved', done: 'solved', finish: 'closed', close: 'closed', closed: 'closed', complete: 'solved', reopen: 'reopen',
  enable: 'on', enabled: 'on', activate: 'on', on: 'on', start: 'start', begin: 'start', launch: 'launch', run: 'run', trigger: 'run', execute: 'run', kick_off: 'run', refresh: 'refresh', rescan: 'refresh', scan: 'refresh', rerun: 'refresh', recheck: 'refresh', sync: 'refresh',
  off: 'off', disabled: 'off', pause: 'off',
  block: 'block', blacklist: 'block', whitelist: 'allow', allowlist: 'allow', blocklist: 'block',
  /* nouns */
  listing: 'listing', listings: 'listing', company: 'listing', companies: 'listing', business: 'listing', businesses: 'listing', record: 'listing', records: 'listing', entry: 'listing', entries: 'listing', profile: 'listing', firm: 'listing', firms: 'listing', organisation: 'listing', organization: 'listing', startup: 'listing', startups: 'listing', directory: 'listing', submission: 'listing', submissions: 'listing',
  user: 'user', users: 'user', member: 'user', members: 'user', account: 'user', accounts: 'user', customer: 'user', customers: 'user', person: 'user', people: 'user', client: 'user', clients: 'user', signup: 'user', signups: 'user', them: 'them', him: 'them', her: 'them', they: 'them', guy: 'user',
  ticket: 'ticket', tickets: 'ticket', issue: 'ticket', issues: 'ticket', case: 'ticket', cases: 'ticket', complaint: 'ticket', complaints: 'ticket', enquiry: 'ticket', inquiry: 'ticket', support: 'ticket',
  claim: 'claim', claims: 'claim', removal: 'removal', removals: 'removal', takedown: 'removal', takedowns: 'removal',
  pending: 'pending', awaiting: 'pending', queue: 'pending', queued: 'pending', waiting: 'pending', unreviewed: 'pending', review: 'moderate', backlog: 'pending',
  active: 'approved', public: 'approved', published: 'published', drafts: 'draft',
  post: 'post', posts: 'post', article: 'post', articles: 'post', blog: 'post',
  career: 'career', careers: 'career', job: 'career', jobs: 'career', vacancy: 'career', vacancies: 'career', role: 'career', roles: 'career', position: 'career', opening: 'career', openings: 'career',
  promo: 'promo', promos: 'promo', coupon: 'promo', coupons: 'promo', voucher: 'promo', discount: 'promo',
  plan: 'planoffer', plans: 'planoffer', offer: 'planoffer', offers: 'planoffer', pricing: 'planoffer', tier: 'planoffer',
  ad: 'adpackage', ads: 'adpackage', advert: 'adpackage', adverts: 'adpackage', advertising: 'adpackage', package: 'adpackage', packages: 'adpackage',
  category: 'category', categories: 'category', cat: 'category',
  incident: 'incident', incidents: 'incident', outage: 'incident', outages: 'incident', component: 'component', components: 'component', monitor: 'monitor', probe: 'monitor',
  newsletter: 'newsletter', digest: 'newsletter', subscriber: 'subscriber', subscribers: 'subscriber', cadence: 'cadence', daily: 'daily', weekly: 'weekly', monthly: 'monthly',
  maintenance: 'maintenance', offline: 'maintenance', downtime: 'maintenance',
  indexing: 'indexing', indexnow: 'indexnow', index: 'indexing', seo: 'indexing', sitemap: 'indexing', crawl: 'indexing', ping: 'ping', bing: 'indexing', google: 'google', googleindex: 'googleindex', credentials: 'credentials', credential: 'credentials',
  tech: 'tech', technology: 'tech', technologies: 'tech', stack: 'tech', radar: 'tech',
  news: 'news', story: 'story', stories: 'story', upkeep: 'upkeep', sweep: 'sweep',
  backup: 'backup', export: 'backup', snapshot: 'backup',
  inbox: 'inbox', notification: 'inbox', notifications: 'inbox', bell: 'inbox', alerts: 'inbox', note: 'note', reminder: 'note',
  health: 'health', uptime: 'health', memory: 'health', disk: 'health', server: 'health', cpu: 'health', load: 'health',
  setting: 'settings', settings: 'settings', config: 'settings', configuration: 'settings', setup: 'settings', flags: 'settings',
  payment: 'payment', payments: 'payment', revenue: 'payment', money: 'payment', income: 'payment', sales: 'payment', earnings: 'payment', invoice: 'payment', invoices: 'payment', transactions: 'payment', billing: 'payment', paypal: 'paypal',
  ip: 'ip', ips: 'ip', address: 'ip', domain: 'domain', domains: 'domain', protection: 'protection', spam: 'protection', abuse: 'protection', ratelimit: 'ratelimit', throttle: 'ratelimit', limit: 'limit', limits: 'limit',
  password: 'password', passwordreset: 'passwordreset', owner: 'owner', ownership: 'owner', relation: 'relation', relationship: 'relation', relationships: 'relation', parent: 'parent', subsidiary: 'subsidiary', brand: 'brand', competitor: 'competitor', partner: 'partner',
  event: 'event', events: 'event', timeline: 'event', milestone: 'milestone', funding: 'funding', acquisition: 'milestone',
  smtp: 'smtp', hop: 'smtp', hops: 'smtp', provider: 'smtp', from: 'from', sender: 'from', testmail: 'testmail', '2fa': '2fa',
  pro: 'pro', premium: 'pro', paid: 'pro', plus: 'pro', trial: 'trial', trials: 'trial', lifetime: 'lifetime', forever: 'lifetime', permanent: 'lifetime', permanently: 'lifetime', perpetual: 'lifetime',
  all: 'all', every: 'all', everything: 'all',
  trust: 'trust', flag: 'flag', keepalive: 'keepalive', indexnowkey: 'indexnowkey', rotate: 'rotate', regenerate: 'rotate', regen: 'rotate', restore: 'restore', unarchive: 'restore', auditlog: 'auditlog', modlog: 'modlog', modrules: 'modrules', approveat: 'approveat', rejectat: 'rejectat', threshold: 'threshold', thresholds: 'threshold', score: 'score', scored: 'score', moderate: 'moderate', moderator: 'moderate', screen: 'moderate',
  iprule: 'iprule', domainrule: 'domainrule', apikey: 'apikey', mailaccount: 'mailaccount', restorebackup: 'restorebackup', logoutall: 'logoutall', closeallsolved: 'closeallsolved', expire: 'off', expired: 'off', deactivate: 'off', unread: 'unread',
  exist: 'show', exists: 'show', available: 'show', configured: 'show', recent: 'newest', recently: 'newest', latest: 'newest', newest: 'newest', oldest: 'oldest', term: 'term', word: 'term', phrase: 'term', rule: 'rule', rules: 'rule',
  thismonth: 'thismonth', thisweek: 'thisweek', today: 'today', yesterday: 'today', briefing: 'briefing',
  it: 'it', that: 'it', this: 'it', these: 'it', those: 'it', same: 'it', one: 'one', first: 'first', second: 'second', third: 'third', last: 'last',
  help: 'help', commands: 'help', capabilities: 'help', examples: 'help', assistant: 'assistant', playground: 'assistant', ai: 'assistant', bot: 'assistant',
  statuspage: 'statuspage', statusreport: 'statusreport', status: 'status', state: 'status', markread: 'markread',
  yes: 'yes', yep: 'yes', yeah: 'yes', yup: 'yes', sure: 'yes', y: 'yes', affirmative: 'yes', absolutely: 'yes', please: '', kindly: '',
  no: 'no', nope: 'no', nah: 'no', n: 'no', negative: 'no', dont: 'no',
  hello: 'hello', hi: 'hello', hey: 'hello', morning: 'hello', afternoon: 'hello', evening: 'hello', thanks: 'thanks', thank: 'thanks', cheers: 'thanks', ta: 'thanks',
  urgent: 'urgent', asap: 'urgent', immediately: 'urgent', now: 'now', newest: 'newest', latest: 'newest', recent: 'newest', oldest: 'oldest', top: 'newest',
  minor: 'minor', major: 'major', critical: 'critical', investigating: 'investigating', identified: 'identified', monitoring: 'monitoring', resolved: 'solved',
  archive: 'archive', restore: 'restore', undo: 'undo', reset: 'reset',
  thisweek: 'thisweek', today: 'today', thismonth: 'thismonth',
  transfer: 'transfer', transfers: 'transfer', hiring: 'hiring', logo: 'logo', website: 'website', tagline: 'tagline', description: 'description', phone: 'phone', city: 'city', country: 'country', tags: 'tags', founded: 'founded', size: 'size', name: 'name', type: 'type', region: 'region', slug: 'slug',
};

const STOP = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'at', 'by', 'with', 'and', 'or', 'as', 'me', 'my', 'our', 'we', 'i', 'you', 'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'just', 'so', 'then', 'also', 'up', 'out', 'into', 'onto', 'from', 'be', 'been', 'was', 'were', 'am', 'its', 'there', 'here', 'right', 'quick', 'quickly', 'again', 'still', 'if', 'want', 'need', 'like', 'pls', 'plz', 'ur', 'u', 'em', 'that', 'this', 'some', 'called', 'named', 'about', 'via', 'using', 'owned', 'belonging', 'owns', 'go', 'ahead', 'get', 'him', 'her', 'them', 'they', 'it', 'is', 'are', 'do', 'does', 'did', 'has', 'have', 'had', 'let', 'lets', 'us', 'ok', 'okay', 'all', 'one', 'those', 'these', 'their', 'his', 'hers', 'whose', 'who', 'what', 'which', 'where', 'when', 'how', 'why', 'much', 'many', 'ones', 'thing', 'things', 'stuff', 'now', 'today', 'listing', 'listings', 'user', 'users', 'member', 'members', 'account', 'company', 'business', 'record', 'ticket', 'claim', 'please', 'kindly']);

function stem(w) {
  if (WORDS[w] !== undefined) return w;
  if (w.length > 4 && /ies$/.test(w)) { const c = w.replace(/ies$/, 'y'); if (WORDS[c] !== undefined) return c; }
  if (w.length > 5 && /ing$/.test(w)) { const c = w.replace(/ing$/, ''); if (WORDS[c] !== undefined) return c; if (WORDS[c + 'e'] !== undefined) return c + 'e'; }
  if (w.length > 4 && /ed$/.test(w)) { const c = w.replace(/ed$/, ''); if (WORDS[c] !== undefined) return c; if (WORDS[c + 'e'] !== undefined) return c + 'e'; }
  if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) { const c = w.replace(/s$/, ''); if (WORDS[c] !== undefined) return c; }
  return w;
}

function lower(text) {
  return String(text || '')
    .replace(/[“”„]/g, '"').replace(/[‘’]/g, "'")
    .replace(/\b(what|who|where|how|that|there|it|here)'s\b/gi, '$1 is')
    .replace(/\bcan't\b/gi, 'cannot').replace(/\bwon't\b/gi, 'will not').replace(/\bn't\b/gi, ' not').replace(/\b(i|we|you|they)'(ll|d|ve|re|m)\b/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Canonical form used for intent matching (the raw text is kept for slots). */
function canon(text) {
  let s = lower(text).toLowerCase();
  /* keep emails / slugs / refs / urls intact: swap dots and hyphens inside them */
  s = s.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g, (m) => m.replace(/[.@+-]/g, '_'));
  s = s.replace(/https?:\/\/\S+/g, ' url ');
  s = s.replace(/\bfl-[a-z0-9]+\b/gi, ' ticketref ');
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, ' ipaddr ');
  s = s.replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/g, ' domainname ');
  s = s.replace(/[?!.,;:()[\]{}"']/g, ' ');
  for (const [phrase, tok] of PHRASES.slice().sort((a, b) => b[0].length - a[0].length)) {
    s = s.replace(new RegExp(`\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'g'), ` ${tok} `);
  }
  const out = [];
  for (const raw of s.split(/\s+/).filter(Boolean)) {
    const w = raw.replace(/^#/, '');
    if (/^\d+$/.test(w)) { out.push(w); continue; }
    const k = stem(w);
    if (WORDS[k] === '') continue;
    if (WORDS[k] !== undefined) { out.push(WORDS[k]); continue; }
    const fixed = nearestWord(k);
    out.push(fixed !== null ? fixed : w);
  }
  return ' ' + out.join(' ') + ' ';
}

/* Typo tolerance: an unknown word of 5+ letters that is one edit away from a
   known vocabulary word is treated as that word ("aprove", "suspnd", "delte"). */
const NEAR_CACHE = new Map();
function nearestWord(w) {
  if (w.length < 5 || !/^[a-z]+$/.test(w)) return null;
  if (NEAR_CACHE.has(w)) return NEAR_CACHE.get(w);
  let found = null;
  for (const key of Object.keys(WORDS)) {
    if (Math.abs(key.length - w.length) > 1 || key.length < 4 || key[0] !== w[0]) continue;
    if (WORDS[key] === '' || editDistance1(w, key)) { if (WORDS[key] !== '' && editDistance1(w, key)) { found = WORDS[key]; break; } }
  }
  NEAR_CACHE.set(w, found);
  return found;
}
function editDistance1(a, b) {
  if (a === b) return true;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) { /* maybe a transposition */
      return diff === 2 && a[i] === b[i - 1] && a[i - 1] === b[i] && a.slice(i + 1) === b.slice(i + 1);
    }
    return true;
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  let i = 0; let j = 0; let skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; } else if (skipped) return false; else { skipped = true; j++; }
  }
  return true;
}

const has = (c, re) => re.test(c);

/* ------------------------------------------------------------------ */
/* 2. Slots                                                            */
/* ------------------------------------------------------------------ */

const TYPED_ID = [
  ['listing', /\b(?:listing|company|business|record|entry|profile|firm)\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
  ['user', /\b(?:user|member|account|customer|person|client)\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
  ['ticket', /\b(?:ticket|issue|case|complaint)\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
  ['claim', /\bclaim\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
  ['removal', /\b(?:removal(?: request)?|takedown(?: request)?|request)\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
  ['post', /\b(?:post|article|blog)\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
  ['incident', /\b(?:incident|outage)\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
  ['promo', /\b(?:promo|coupon|voucher)\s*(?:code)?\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
  ['plan', /\b(?:plan|offer)\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
  ['package', /\b(?:package|advert|ad)\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
  ['career', /\b(?:career|job|role|vacancy|position)\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
  ['story', /\b(?:story|news)\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
  ['transfer', /\btransfer\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
  ['notification', /\b(?:notification|alert)\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
  ['event', /\bevent\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
  ['relation', /\brelation(?:ship)?\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
  ['rule', /\b(?:rule|entry)\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
  ['component', /\bcomponent\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
  ['account', /\b(?:smtp|mail)\s*(?:account|hop)\s*(?:#|id|no\.?|number)?\s*(\d{1,9})\b/i],
];

function extractSlots(raw) {
  const text = lower(raw);
  const low = text.toLowerCase();
  const s = { ids: {}, numbers: [], quoted: [], emails: [], slugs: [], paths: [], urls: [], ips: [], domains: [] };

  s.emails = (low.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []);
  /* Mail provider slot. It deliberately accepts both human wording
   * ("through Brevo", "using provider 2") and the names shown in Settings;
   * the mail tool resolves it against the live configured hops at execution. */
  const providerNames = (mailer.PROVIDERS || []).map((p) => p.id).filter(Boolean).join('|');
  const providerPhrase = low.match(/\b(?:via|through|using|with|from)\s+(?:the\s+)?(?:(?:mail|smtp)\s+)?(?:provider\s+)?([a-z][a-z0-9_-]*)\b/i);
  const providerNamed = providerPhrase && providerPhrase[1];
  const providerKnown = low.match(new RegExp(`\\b(${providerNames})\\b`, 'i'));
  if (providerNamed && !['email', 'mail', 'smtp', 'address', 'me', 'the'].includes(providerNamed)) s.provider = providerNamed;
  else if (providerKnown) s.provider = providerKnown[1].toLowerCase();
  s.urls = (text.match(/https?:\/\/[^\s"'<>]+/gi) || []);
  const ref = text.match(/\bFL-[A-Z0-9]{3,}\b/i);
  if (ref) s.ref = ref[0].toUpperCase();
  s.quoted = [...text.matchAll(/"([^"]{1,120})"|'([^']{2,120})'/g)].map((m) => (m[1] || m[2]).trim()).filter(Boolean);
  s.paths = (low.match(/(?:^|\s)(\/[a-z0-9][a-z0-9/_-]*)/g) || []).map((p) => p.trim());
  s.ips = (text.match(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g) || []).concat(text.match(/\b(?:[a-f0-9]{1,4}:){2,7}[a-f0-9]{1,4}\b/gi) || []);

  let rest = low
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g, ' ')
    .replace(/https?:\/\/[^\s"'<>]+/gi, ' ');
  s.domains = (rest.match(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|ke|uk|de|fr|za|ng|tz|ug|rw|ai|app|dev|info|biz|me|xyz|tech|africa|edu|gov|example|test|co\.ke|or\.ke|ac\.ke)\b/g) || [])
    .filter((d) => !s.ips.includes(d));
  s.slugs = (rest.match(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g) || []).filter((w) => !/^fl-/.test(w) && !/^\d+-\d+$/.test(w) && !/^(?:re-open|two-factor|sign-in|log-in|e-mail|auto-approve|non-|pre-|co-|self-)/.test(w) && !/^\d{4}-\d{2}(-\d{2})?$/.test(w));

  for (const [key, re] of TYPED_ID) {
    const m = text.match(re);
    if (m) s.ids[key] = Number(m[1]);
  }
  const hash = text.match(/#\s*(\d{1,9})\b/);
  if (hash) s.hashId = Number(hash[1]);

  const days = low.match(/\b(\d{1,4})\s*(?:-|\s)?\s*(?:days?|d)\b/) || low.match(/\bfor\s+(\d{1,4})\b(?!\s*%)/);
  if (days) s.days = Number(days[1]);
  const weeks = low.match(/\b(\d{1,3})\s*(?:weeks?|wks?)\b/);
  if (weeks && !s.days) s.days = Number(weeks[1]) * 7;
  const months = low.match(/\b(\d{1,3})\s*(?:months?|mo)\b/);
  if (months && !s.days) s.days = Number(months[1]) * 30;
  const years = low.match(/\b(\d{1,2})\s*(?:years?|yrs?)\b/);
  if (years && !s.days) s.days = Number(years[1]) * 365;
  if (/\b(?:a|one)\s+week\b/.test(low) && !s.days) s.days = 7;
  if (/\b(?:a|one)\s+month\b/.test(low) && !s.days) s.days = 30;
  if (/\b(?:a|one)\s+year\b/.test(low) && !s.days) s.days = 365;
  const pct = low.match(/\b(\d{1,3})\s*(?:%|percent\b|pct\b)/);
  if (pct) s.percent = Number(pct[1]);
  const usd = low.match(/(?:\$|usd\s*)(\d{1,6}(?:\.\d{1,2})?)|\b(\d{1,6}(?:\.\d{1,2})?)\s*(?:usd|dollars?|bucks)\b/);
  if (usd) s.usd = Number(usd[1] || usd[2]);
  const date = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (date) s.date = date[1];
  const uses = low.match(/\b(?:max|maximum|up to)?\s*(\d{1,6})\s*(?:uses|redemptions|times)\b/);
  if (uses) s.maxUses = Number(uses[1]);
  const limit = !uses && low.match(/\b(?:top|first|last|latest|newest|limit|max|up to|show)\s+(\d{1,3})\b/) || low.match(/\b(\d{1,3})\s+(?:newest|latest|most recent|recent|oldest|listings|users|members|rows|results|tickets|items)\b/);
  if (limit) s.limit = Number(limit[1]);

  /* Loose numbers: whatever is not already claimed by a typed slot. */
  const claimed = new Set([s.days, s.percent, s.usd, s.limit, s.maxUses, ...Object.values(s.ids)].filter((n) => n !== undefined).map(String));
  s.numbers = (rest.replace(/\d{4}-\d{2}-\d{2}/g, ' ').replace(/(?:\d{1,3}\.){3}\d{1,3}/g, ' ').match(/\b\d{1,9}\b/g) || [])
    .map(Number).filter((n) => !claimed.has(String(n)));

  if (/\b(lifetime|forever|permanent(?:ly)?|perpetual|for good|indefinitely)\b/.test(low)) s.lifetime = true;
  const st = low.match(/\b(pending|approved|rejected|open|solved|closed|draft|published|investigating|identified|monitoring|resolved|unpublished)\b/g);
  if (st) s.statuses = [...new Set(st)];
  if (/\b(enable|enabled|activate|switch on|turn on|start|resume)\b|\bon\b/.test(low) && !/\b(turn off|switch off|disable)\b/.test(low)) s.on = true;
  if (/\b(disable|disabled|deactivate|switch off|turn off|pause|stop)\b|\boff\b/.test(low)) s.on = false;
  if (/\b(daily|every day)\b/.test(low)) s.cadence = 'daily';
  if (/\b(weekly|every week)\b/.test(low)) s.cadence = 'weekly';
  if (/\b(monthly|every month)\b/.test(low)) s.cadence = 'monthly';
  const sev = low.match(/\b(minor|major|critical)\b/);
  if (sev) s.severity = sev[1];
  if (/\b(all|every|everyone|everybody|whole)\b/.test(low)) s.all = true;
  const aud = low.match(/\b(pro|free|newsletter|subscribers?)\b\s+(?:users|members|accounts|customers|people|list|subscribers)?/);
  if (/\b(everyone|everybody|all (?:users|members|accounts|customers|people))\b/.test(low)) s.audience = 'all';
  else if (aud && /\b(email|mail|send|notify|announce|message|blast|broadcast)\b/.test(low)) s.audience = aud[1].startsWith('subscriber') ? 'newsletter' : aud[1];
  const kind = low.match(/\b(parent|subsidiary|brand|competitor|partner)\b/);
  if (kind) s.relType = kind[1];
  const ekind = low.match(/\b(funding|launch|award|milestone)\b/);
  if (ekind) s.eventKind = ekind[1];
  const role = low.match(/\b(full[- ]time|part[- ]time|contract|internship|remote)\b/);
  if (role) s.roleType = role[1].replace(/\b\w/g, (c) => c.toUpperCase()).replace(/ Time/, '-time');
  if (/\b(it|that|this|them|him|her|they|the same|that one|this one)\b/.test(low)) s.pronoun = true;
  if (/\b(the owner|its owner|their owner|listing owner)\b/.test(low)) s.owner = true;
  if (/\b(their|his|her)\s+(listing|listings|companies|records)\b|\b(owned|listings?)\s+by\b/.test(low)) s.theirListings = true;
  const ordinal = low.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last)\b/);
  if (ordinal) s.ordinal = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, last: -1 }[ordinal[1]];
  if (/\b(this week|past week|last week|last 7 days|past 7 days)\b/.test(low)) s.sinceDays = 7;
  if (/\b(today|last 24 hours|past 24 hours)\b/.test(low)) s.sinceDays = 1;
  if (/\b(this month|last 30 days|past 30 days|last month)\b/.test(low)) s.sinceDays = 30;
  if (/\byesterday\b/.test(low)) s.sinceDays = 2;

  /* Free text after "saying / with message / : " — used for replies, notes, bodies. */
  const said = text.match(/(?:\bsaying\b|\bsay\b|\bmessage\b|\bbody\b|\btext\b|\bnote\b|\bthat says\b|\btelling (?:them|him|her)\b|\btell (?:them|him|her)\b)\s*[:\-–—]?\s*(.+)$/i);
  if (said && said[1].trim().length > 1) s.said = said[1].trim().replace(/^["']|["']$/g, '');
  const colon = text.match(/:\s*(.{2,})$/);
  if (!s.said && colon && !/^\d/.test(colon[1])) s.said = colon[1].trim().replace(/^["']|["']$/g, '');
  const subj = text.match(/\bsubject\s*[:=]?\s*"([^"]+)"|\bsubject\s*[:=]\s*([^,;]+?)(?:,|;|\bbody\b|\bmessage\b|$)/i);
  if (subj) s.subject = (subj[1] || subj[2]).trim();
  const titled = text.match(/\b(?:titled|title|called|named|headline)\s*[:=]?\s*"([^"]+)"|\b(?:titled|title|headline)\s*[:=]?\s*([^,;:"]+?)(?:,|;|:|\bbody\b|\bwith\b|\bstatus\b|$)/i);
  if (titled) s.title = (titled[1] || titled[2]).trim();
  const named = text.match(/\b(?:called|named|name)\s+(?:"([^"]+)"|([A-Za-z0-9][A-Za-z0-9 &.'-]{1,60}?))(?=\s*(?:,|;|:|$|\bto\b|\bwith\b|\bfor\b|\bas\b|\band\b|\bin\b|\bunder\b|\bat\b))/);
  if (named) s.named = (named[1] || named[2]).trim();
  const to = text.match(/\b(?:to|into|as|→|->)\s+"([^"]+)"|\b(?:to|into|as|→|->)\s+([A-Z][A-Za-z0-9 &.'-]{1,60}?)(?=\s*(?:,|;|:|$|\band\b))/);
  if (to) s.renameTo = (to[1] || to[2]).trim();
  const keyval = [...text.matchAll(/\b([A-Za-z_]{3,30})\s*(?:=|:|\bto\b)\s*("[^"]+"|[^\s,;]+)/g)]
    .map((m) => [m[1].toLowerCase(), m[2].replace(/^"|"$/g, '')])
    .filter(([k]) => !['subject', 'message', 'body', 'title', 'note', 'saying', 'reply', 'set', 'up', 'to', 'it', 'them', 'listing', 'user', 'ticket'].includes(k));
  if (keyval.length) s.keyval = Object.fromEntries(keyval);
  return s;
}

/**
 * What's left of the sentence once verbs, nouns, stop-words and captured
 * slots are removed — the best guess for "a name the operator typed".
 */
/* These words have operational meanings elsewhere, but are also common
 * entity names. Keep them in the target text so "approve PayPal listing" or
 * "show News listing" can resolve a real listing instead of dropping the
 * name during normalisation. */
const ENTITY_WORDS = new Set([
  'paypal', 'news', 'status', 'health', 'stripe', 'google', 'zoho', 'brevo',
  'resend', 'mailtrap', 'smtp2go', 'smtpfast', 'ahasend', 'forwardemail',
  'dnsexit', 'custom', 'acme', 'meta', 'apple', 'amazon', 'microsoft',
]);

function freeText(raw, slots) {
  let t = lower(raw).replace(/\s+(?:because|since|as|due to|reason:?|cos|coz)\s+.+$/i, '');
  for (const q of slots.quoted) t = t.replace(q, ' ');
  t = t.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, ' ').replace(/https?:\/\/\S+/gi, ' ').replace(/\bFL-[A-Z0-9]+\b/gi, ' ')
    .replace(/#\s*\d+/g, ' ').replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ').replace(/\b\d+\s*(?:days?|d|weeks?|months?|years?|%|percent|uses)\b/gi, ' ').replace(/\d+%/g, ' ').replace(/\b\d+\b/g, ' ');
  t = t.replace(/[?!.,;:()[\]{}"']/g, ' ');
  for (const [phrase] of PHRASES) t = t.replace(new RegExp(`\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'gi'), ' ');
  const keep = [];
  for (const w of t.split(/\s+/).filter(Boolean)) {
    const l = w.toLowerCase();
    if (STOP.has(l)) continue;
    const k = stem(l);
    if (WORDS[k] !== undefined && !/^[A-Z]/.test(w) && !ENTITY_WORDS.has(k)) continue; // known verb/noun (lower-case) → not a name
    keep.push(w);
  }
  return keep.join(' ').trim();
}

/* ------------------------------------------------------------------ */
/* 3. Database lookups for resolution                                  */
/* ------------------------------------------------------------------ */

const q = {
  listingById: (id) => db.prepare('SELECT id, slug, name, status, category, country, featured, sponsored, plan FROM listings WHERE id=?').get(id),
  listingBySlug: (slug) => db.prepare('SELECT id, slug, name, status, category, country, featured, sponsored, plan FROM listings WHERE slug=? COLLATE NOCASE').get(slug),
  listingsByName: (text, limit = 6) => {
    const like = `%${String(text).replace(/[%_]/g, '')}%`;
    const exact = db.prepare('SELECT id, slug, name, status, category, country, featured, sponsored, plan FROM listings WHERE name = ? COLLATE NOCASE LIMIT 2').all(text);
    if (exact.length === 1) return exact;
    return db.prepare('SELECT id, slug, name, status, category, country, featured, sponsored, plan FROM listings WHERE name LIKE ? OR slug LIKE ? OR website LIKE ? ORDER BY (name = ? COLLATE NOCASE) DESC, length(name) ASC LIMIT ?').all(like, like, like, text, limit);
  },
  listingByDomain: (domain) => db.prepare('SELECT id, slug, name, status, category, country, featured, sponsored, plan FROM listings WHERE lower(website) LIKE ? LIMIT 3').all(`%${domain.toLowerCase()}%`),
  userById: (id) => db.prepare('SELECT id, email, name, plan, suspended FROM users WHERE id=?').get(id),
  userByEmail: (e) => db.prepare('SELECT id, email, name, plan, suspended FROM users WHERE email=? COLLATE NOCASE').get(e),
  usersByName: (text, limit = 6) => {
    const like = `%${String(text).replace(/[%_]/g, '')}%`;
    const exact = db.prepare('SELECT id, email, name, plan, suspended FROM users WHERE name = ? COLLATE NOCASE LIMIT 2').all(text);
    if (exact.length === 1) return exact;
    return db.prepare('SELECT id, email, name, plan, suspended FROM users WHERE name LIKE ? OR email LIKE ? ORDER BY (name = ? COLLATE NOCASE) DESC, id DESC LIMIT ?').all(like, like, text, limit);
  },
  ticketById: (id) => db.prepare('SELECT t.id, t.ref, t.subject, t.status, u.email FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.id=?').get(id),
  ticketByRef: (ref) => db.prepare('SELECT t.id, t.ref, t.subject, t.status, u.email FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.ref=? COLLATE NOCASE').get(ref),
  ticketsByText: (text, limit = 6) => {
    const like = `%${String(text).replace(/[%_]/g, '')}%`;
    return db.prepare('SELECT t.id, t.ref, t.subject, t.status, u.email FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.subject LIKE ? OR u.email LIKE ? OR u.name LIKE ? ORDER BY t.updated_at DESC LIMIT ?').all(like, like, like, limit);
  },
  onlyPendingListing: () => db.prepare("SELECT id, slug, name, status FROM listings WHERE status='pending' ORDER BY created_at ASC LIMIT 2").all(),
  categoryByName: (name) => {
    const exact = db.prepare('SELECT id, name, slug FROM categories WHERE name = ? COLLATE NOCASE OR slug = ? COLLATE NOCASE').get(name, name);
    if (exact) return exact;
    /* partial: "technology" → "Software & SaaS"? no — but "fintech" → "Fintech", "retail" → "E-commerce & Retail" */
    const like = db.prepare('SELECT id, name, slug FROM categories WHERE name LIKE ? COLLATE NOCASE ORDER BY length(name) LIMIT 2').all(`%${String(name).replace(/[%_]/g, '')}%`);
    if (like.length === 1) return like[0];
    /* fall back to the listings table's own category values (listings may predate the categories table) */
    const used = db.prepare('SELECT DISTINCT category AS name FROM listings WHERE category = ? COLLATE NOCASE LIMIT 1').get(name);
    return used ? { id: 0, name: used.name, slug: '' } : null;
  },
  categoriesLike: (text) => db.prepare('SELECT id, name, slug FROM categories WHERE name LIKE ? LIMIT 6').all(`%${String(text).replace(/[%_]/g, '')}%`),
  postById: (id) => db.prepare('SELECT id, slug, title, status FROM blog_posts WHERE id=?').get(id),
  postsByText: (text) => db.prepare('SELECT id, slug, title, status FROM blog_posts WHERE title LIKE ? OR slug LIKE ? ORDER BY id DESC LIMIT 6').all(`%${String(text).replace(/[%_]/g, '')}%`, `%${String(text).replace(/[%_]/g, '')}%`),
  promoByCode: (code) => db.prepare('SELECT id, code, percent, active FROM promo_codes WHERE code = ? COLLATE NOCASE').get(code),
  incidentsOpen: () => { try { return db.prepare("SELECT id, title, status, severity FROM incidents WHERE status<>'resolved' ORDER BY id DESC LIMIT 6").all(); } catch { return []; } },
  careersLike: (text) => { try { return db.prepare('SELECT id, title, status FROM careers WHERE title LIKE ? ORDER BY id DESC LIMIT 6').all(`%${String(text).replace(/[%_]/g, '')}%`); } catch { return []; } },
  plansLike: (text) => { try { return db.prepare('SELECT id, name, active FROM plans WHERE name LIKE ? LIMIT 6').all(`%${String(text).replace(/[%_]/g, '')}%`); } catch { return []; } },
  adsLike: (text) => { try { return db.prepare('SELECT id, name, active FROM ad_packages WHERE name LIKE ? LIMIT 6').all(`%${String(text).replace(/[%_]/g, '')}%`); } catch { return []; } },
};

/* ------------------------------------------------------------------ */
/* 4. Entity resolution                                                */
/* ------------------------------------------------------------------ */

const listingLabel = (l) => `${l.name} (#${l.id}, ${l.status}${l.category ? ', ' + l.category : ''})`;
const userLabel = (u) => `${u.name || 'no name'} <${u.email}> (#${u.id}, ${u.plan || 'free'}${u.suspended ? ', suspended' : ''})`;
const ticketLabel = (t) => `${t.ref} — ${t.subject} (${t.status}, ${t.email})`;

/**
 * Each resolver returns { ok:true, value, row } or { ask, options? } or { none }.
 * `ctx` = tab memory. `text` = free text left after keywords.
 */
function resolveListing({ slots, ctx, text, c, allowContext = true }) {
  if (slots.ids.listing) { const l = q.listingById(slots.ids.listing); return l ? { ok: true, value: String(l.id), row: l } : { none: `There is no listing #${slots.ids.listing}.` }; }
  if (slots.hashId && !Object.keys(slots.ids).length) { const l = q.listingById(slots.hashId); if (l) return { ok: true, value: String(l.id), row: l }; }
  for (const slug of slots.slugs) { const l = q.listingBySlug(slug); if (l) return { ok: true, value: l.slug, row: l }; }
  for (const qd of slots.quoted) {
    const rows = q.listingsByName(qd);
    if (rows.length === 1) return { ok: true, value: String(rows[0].id), row: rows[0] };
    if (rows.length > 1) return { ask: `Which “${qd}” did you mean?`, options: rows.map((r) => ({ label: listingLabel(r), value: String(r.id), row: r })) };
  }
  for (const d of slots.domains) { const rows = q.listingByDomain(d); if (rows.length === 1) return { ok: true, value: String(rows[0].id), row: rows[0] }; }
  if (slots.named) { const rows = q.listingsByName(slots.named); if (rows.length === 1) return { ok: true, value: String(rows[0].id), row: rows[0] }; if (rows.length > 1) return { ask: `Which one did you mean?`, options: rows.map((r) => ({ label: listingLabel(r), value: String(r.id), row: r })) }; }
  if (slots.numbers.length === 1 && !slots.emails.length) { const l = q.listingById(slots.numbers[0]); if (l) return { ok: true, value: String(l.id), row: l }; }
  if (text && text.length >= 2) {
    const rows = q.listingsByName(text);
    if (rows.length === 1) return { ok: true, value: String(rows[0].id), row: rows[0] };
    if (rows.length > 1) return { ask: `I found ${rows.length} listings matching “${text}” — which one?`, options: rows.map((r) => ({ label: listingLabel(r), value: String(r.id), row: r })) };
    /* try progressively shorter phrases ("acme cold chain ltd nairobi" → "acme cold chain") */
    const words = text.split(' ');
    for (let n = words.length - 1; n >= 1 && words.length > 1; n--) {
      const part = words.slice(0, n).join(' ');
      if (part.length < 3) break;
      const r2 = q.listingsByName(part);
      if (r2.length === 1) return { ok: true, value: String(r2[0].id), row: r2[0] };
      if (r2.length > 1) return { ask: `Which of these did you mean?`, options: r2.map((r) => ({ label: listingLabel(r), value: String(r.id), row: r })) };
    }
  }
  if (allowContext && ctx.listing && (slots.pronoun || (!text && !slots.numbers.length && !slots.emails.length))) {
    const l = q.listingById(ctx.listing.id);
    if (l) return { ok: true, value: String(l.id), row: l, fromContext: true };
  }
  if (has(c, /\bpending\b/) && has(c, /\b(the|only|that)\b/)) {
    const p = q.onlyPendingListing();
    if (p.length === 1) return { ok: true, value: String(p[0].id), row: p[0] };
  }
  return { ask: 'Which listing? Give me its id, slug or name.' };
}

function resolveUser({ slots, ctx, text, allowContext = true }) {
  for (const e of slots.emails) { const u = q.userByEmail(e); if (u) return { ok: true, value: u.email, row: u }; return { none: `No member has the email ${e}.` }; }
  if (slots.ids.user) { const u = q.userById(slots.ids.user); return u ? { ok: true, value: String(u.id), row: u } : { none: `There is no member #${slots.ids.user}.` }; }
  if (slots.hashId && !Object.keys(slots.ids).length) { const u = q.userById(slots.hashId); if (u) return { ok: true, value: String(u.id), row: u }; }
  for (const qd of slots.quoted) {
    const rows = q.usersByName(qd);
    if (rows.length === 1) return { ok: true, value: rows[0].email, row: rows[0] };
    if (rows.length > 1) return { ask: `Which member “${qd}”?`, options: rows.map((r) => ({ label: userLabel(r), value: r.email, row: r })) };
  }
  if (slots.named) { const rows = q.usersByName(slots.named); if (rows.length === 1) return { ok: true, value: rows[0].email, row: rows[0] }; if (rows.length > 1) return { ask: 'Which member?', options: rows.map((r) => ({ label: userLabel(r), value: r.email, row: r })) }; }
  if (slots.numbers.length === 1) { const u = q.userById(slots.numbers[0]); if (u) return { ok: true, value: String(u.id), row: u }; }
  if (text && text.length >= 2) {
    const rows = q.usersByName(text);
    if (rows.length === 1) return { ok: true, value: rows[0].email, row: rows[0] };
    if (rows.length > 1) return { ask: `I found ${rows.length} members matching “${text}” — which one?`, options: rows.map((r) => ({ label: userLabel(r), value: r.email, row: r })) };
    const words = text.split(' ');
    for (let n = words.length - 1; n >= 1 && words.length > 1; n--) {
      const r2 = q.usersByName(words.slice(0, n).join(' '));
      if (r2.length === 1) return { ok: true, value: r2[0].email, row: r2[0] };
      if (r2.length > 1) return { ask: 'Which member did you mean?', options: r2.map((r) => ({ label: userLabel(r), value: r.email, row: r })) };
    }
  }
  if (allowContext && ctx.user && (slots.pronoun || (!text && !slots.numbers.length))) {
    const u = q.userById(ctx.user.id);
    if (u) return { ok: true, value: u.email, row: u, fromContext: true };
  }
  if (allowContext && ctx.listing && (slots.pronoun || /\bowner\b/.test(String(text || '')) || slots.owner)) {
    /* "email the owner" style: the listing's owner */
    const own = db.prepare('SELECT u.id, u.email, u.name, u.plan, u.suspended FROM listings l JOIN users u ON u.id=l.owner_user_id WHERE l.id=?').get(ctx.listing.id);
    if (own) return { ok: true, value: own.email, row: own, fromContext: true };
  }
  return { ask: 'Which member? Give me their email, name or id.' };
}

function resolveTicket({ slots, ctx, text, allowContext = true }) {
  if (slots.ref) { const t = q.ticketByRef(slots.ref); return t ? { ok: true, value: t.ref, row: t } : { none: `There is no ticket ${slots.ref}.` }; }
  if (slots.ids.ticket) { const t = q.ticketById(slots.ids.ticket); return t ? { ok: true, value: String(t.id), row: t } : { none: `There is no ticket #${slots.ids.ticket}.` }; }
  if (slots.hashId && !Object.keys(slots.ids).length) { const t = q.ticketById(slots.hashId); if (t) return { ok: true, value: String(t.id), row: t }; }
  if (slots.numbers.length === 1) { const t = q.ticketById(slots.numbers[0]); if (t) return { ok: true, value: String(t.id), row: t }; }
  for (const e of slots.emails) {
    const rows = q.ticketsByText(e);
    if (rows.length === 1) return { ok: true, value: rows[0].ref, row: rows[0] };
    if (rows.length > 1) return { ask: `${e} has ${rows.length} tickets — which one?`, options: rows.map((r) => ({ label: ticketLabel(r), value: r.ref, row: r })) };
  }
  if (text && text.length >= 3) {
    const rows = q.ticketsByText(text);
    if (rows.length === 1) return { ok: true, value: rows[0].ref, row: rows[0] };
    if (rows.length > 1) return { ask: `Which ticket?`, options: rows.map((r) => ({ label: ticketLabel(r), value: r.ref, row: r })) };
  }
  if (allowContext && ctx.ticket) {
    const t = q.ticketById(ctx.ticket.id);
    if (t) return { ok: true, value: t.ref, row: t, fromContext: true };
  }
  return { ask: 'Which ticket? Give me its reference (FL-…) or id.' };
}

function resolveTypedId(kind, { slots, ctx, label }) {
  if (slots.ids[kind]) return { ok: true, value: slots.ids[kind] };
  if (slots.hashId && !Object.keys(slots.ids).length) return { ok: true, value: slots.hashId };
  if (slots.numbers.length === 1) return { ok: true, value: slots.numbers[0] };
  if (ctx[kind] && (slots.pronoun || !slots.numbers.length)) return { ok: true, value: ctx[kind].id || ctx[kind], fromContext: true };
  return { ask: `Which ${label || kind}? Give me its id.` };
}

/* ------------------------------------------------------------------ */
/* 5. Intent rules                                                     */
/* ------------------------------------------------------------------ */

/**
 * A rule: { tool, test(c) → bool, build({slots, ctx, text, c, raw}) → {args} | {ask,…} | {none} }
 * Ordered most-specific first; the first rule whose test() passes and whose
 * build() does not return `skip` wins.
 */
const R = [];
const rule = (tool, test, build, opts = {}) => R.push({ tool, test, build: build || (() => ({ args: {} })), ...opts });

const askFor = (r, entity) => (r.ok ? null : (r.none ? { none: r.none } : { ask: r.ask, options: r.options, entity }));

/* ---- conversational / meta ---- */
rule('__help', (c) => has(c, /\bhelp\b/) || has(c, /^\s*(assistant|commands)\s*$/) || has(c, /\bwhat can (you|u|i) do\b/), ({ c, text }) => ({ args: { topic: text || (c.match(/\b(listing|user|ticket|claim|removal|post|career|promo|planoffer|adpackage|category|incident|newsletter|maintenance|indexing|tech|news|backup|inbox|health|settings|payment|ip|domain|smtp|email|moderation|modrules|modlog|auditlog|audit|protection|ratelimit|iprule|mailaccount|apikey|count)\b/) || [])[1] || '' } }));
rule('__hello', (c) => /^\s*(hello|thanks)(\s+(assistant|there|again))?\s*$/.test(c) || /^\s*hello\b/.test(c) && c.trim().split(' ').length <= 3);
rule('__thanks', (c) => /^\s*thanks\b/.test(c) && c.trim().split(' ').length <= 4);
rule('__reset', (c) => /^\s*reset\s*$/.test(c));
rule('__undo', (c) => has(c, /\bundo\b/));
rule('__whoami', (c) => has(c, /\b(who am i|whoami|am i admin|my role)\b/));
rule('__api_playground', (c) => has(c, /\b(api|developer)\b/) && has(c, /\b(playground|assistant|endpoints?|requests?|console)\b/) && !has(c, /\b(key|keys|revoke|usage)\b/), () => ({ args: {} }));

/* A bare area name is not an unknown command. It opens a safe, actionable
 * menu so an admin can discover the same operations that are available in the
 * console without guessing syntax. This is intentionally read-only: choosing
 * an action still goes through the normal resolver and confirmation policy. */
const BARE_TOPICS = new Set([
  'news', 'settings', 'paypal', 'mail', 'email', 'smtp', 'indexing', 'upkeep',
  'moderation', 'listing', 'listings', 'user', 'users', 'ticket', 'tickets',
  'claim', 'claims', 'removal', 'removals', 'status', 'inbox', 'backup',
  'protection', 'promo', 'promos', 'planoffer', 'adpackage', 'career', 'careers',
  'post', 'blog', 'category', 'categories', 'payment', 'tech',
]);
rule('__topic_menu', (c) => /^\s*paypal\s+(?:listing|listings|payment|payments|settings?)\s*$/.test(c), () => ({ args: { topic: 'paypal' } }));
rule('__topic_menu', (c) => BARE_TOPICS.has(c.trim()), ({ c }) => ({ args: { topic: c.trim() } }));

/* Keep the high-risk-looking phrase "auto accept/approve new listings" from
 * falling through to the listing-creation rule. It changes a site flag, not a
 * record, and remains a normal confirmed write. */
rule('set_auto_approve', (c) => has(c, /\b(auto|automatic)\b/) && has(c, /\b(approve|accept|approval)\b/) && !has(c, /\b(assistant|moderation|screener|screening)\b/), ({ slots }) => ({ args: { on: slots.on !== false } }));
/* PayPal is both a provider and a possible listing name. Provider verbs are
 * unambiguous and must win before entity resolution can turn "paypal" into a
 * listing id. */
rule('set_paypal_settings', (c) => has(c, /\bpaypal\b/) && has(c, /\b(set|live|sandbox|mode|credentials|switch|use)\b/), ({ slots, c }) => { const kv = slots.keyval || {}; const args = {}; if (kv.client_id) args.client_id = kv.client_id; if (kv.client_secret) args.client_secret = kv.client_secret; if (kv.mode) args.mode = kv.mode; else if (has(c, /\blive\b/)) args.mode = 'live'; else if (has(c, /\bsandbox\b/)) args.mode = 'sandbox'; return Object.keys(args).length ? { args } : { ask: 'Set PayPal to live or sandbox, or give client_id=… client_secret=…', entity: 'fields' }; });

/* ---- confirmations (only used when a pending action exists — see ai.js) ---- */

/* ---- reads: stats & health ---- */

/* ---- assistant-native extras ------------------------------------------ */
rule('get_listing_stats', (c) => has(c, /\bbriefing\b/), () => ({ args: {}, focus: 'briefing' }));
rule('get_listing_stats', (c) => /^\s*(pending\s*)+$/.test(c) || /^\s*(show\s+)?pending\s*$/.test(c), () => ({ args: {}, focus: 'pending' }));
rule('get_audit_log', (c) => has(c, /\bauditlog\b/) || (has(c, /\b(show|count)\b/) && has(c, /\baudit\b/)), ({ slots, text, c }) => {
  const args = { limit: slots.limit || 20 };
  if (has(c, /\btool\b|\baction\b/)) args.kind = 'tool';
  if (has(c, /\bmoderation\b/)) args.kind = 'moderation';
  if (text && !/^(recent|latest|newest|last|all|log|entries)$/.test(text)) args.q = text;
  return { args };
});
rule('get_moderation_log', (c) => has(c, /\bmodlog\b/) || (has(c, /\b(show|count)\b/) && has(c, /\bmoderation\b/) && has(c, /\b(log|decision|history)\b/)), ({ slots, c }) => ({ args: { limit: slots.limit || 20, ...(has(c, /\breject\b/) ? { decision: 'reject' } : has(c, /\bapprove\b/) ? { decision: 'approve' } : has(c, /\bpending\b/) ? { decision: 'pending' } : {}) } }));
rule('get_moderation_rules', (c) => has(c, /\bmodrules\b/) || (has(c, /\b(show|count)\b/) && has(c, /\bmoderation\b/) && has(c, /\b(rule|term|threshold|approveat|rejectat)\b/)) || (has(c, /\bshow\b/) && has(c, /\b(approveat|rejectat|threshold)\b/)));
rule('set_moderation_thresholds', (c) => has(c, /\b(approveat|rejectat|threshold)\b/) && (has(c, /\bset\b/) || /\b\d{1,3}\b/.test(c)) && !has(c, /\bshow\b/), ({ slots, c }) => {
  const args = {};
  const a = c.match(/\bapproveat\b[^0-9]*(\d{1,3})/) || c.match(/\bapprove\b[^0-9]*(\d{1,3})/);
  const r = c.match(/\brejectat\b[^0-9]*(\d{1,3})/) || c.match(/\breject\b[^0-9]*(\d{1,3})/);
  if (a) args.approve_at = Number(a[1]);
  if (r) args.reject_at = Number(r[1]);
  if (!a && !r && slots.numbers.length === 1) { if (has(c, /\breject/)) args.reject_at = Number(slots.numbers[0]); else args.approve_at = Number(slots.numbers[0]); }
  return Object.keys(args).length ? { args } : { ask: 'Which threshold and what value? e.g. “set approve threshold to 80” or “set reject threshold to 20”.', entity: 'fields' };
});
rule('edit_moderation_rules', (c) => (has(c, /\b(block|flag|allow|trust|delete|unblock)\b/) && has(c, /\b(term|word|phrase)\b/)) || (has(c, /\btrust\b/) && has(c, /\b(domain|domainname)\b/)) || (has(c, /\b(allow|block)\b/) && has(c, /\bdomain\b/) && has(c, /\b(moderation|modrules|screening)\b/)), ({ slots, text, c }) => {
  const kind = has(c, /\b(allow|trust)\b/) && has(c, /\bdomain\b/) ? 'allow-domain' : has(c, /\bflag\b/) ? 'flag' : 'block';
  const action = has(c, /\b(delete|unblock)\b/) || /\bdelete\b/.test(c) || /^\s*(delete|remove|drop|un)/.test(c) ? 'remove' : 'add';
  const term = slots.quoted[0] || (kind === 'allow-domain' ? slots.domains[0] : '') || (text || '').replace(/^(block|flag|allow|trust|unblock|delete|remove|add)\s+/i, '').replace(/\s+(term|word|phrase|domain)$/i, '').trim();
  if (!term) return { ask: `Which ${kind === 'allow-domain' ? 'domain' : 'term'}? e.g. “block term casino” or “flag term crypto”.`, entity: 'text', partial: { action, kind } };
  return { args: { action, kind, term } };
});
rule('review_listing_now', (c) => (has(c, /\b(moderate|score|assess|evaluate|decide|verdict)\b/) || (has(c, /\b(should|can|safe)\b/) && has(c, /\b(approve|accept|reject|decline)\b/))) && !has(c, /\b(on|off|set|show|log|rule|threshold|all|pending)\b/), (b) => {
  const t = listingTarget(b);
  if (!t.value) return t;
  if (t.fromContext && !b.slots.pronoun && !/^\s*(moderate|score)\s*(now)?\s*$/.test(b.c)) return { skip: true };
  return { args: { id_or_slug: t.value, dry_run: has(b.c, /\b(score|assess|evaluate|should|safe|decide|verdict)\b/) && !has(b.c, /\b(review|moderate)\b/) }, listing: t.row };
});
rule('list_protection_rules', (c) => has(c, /\b(iprule|domainrule)\b/) || (has(c, /\bshow\b/) && has(c, /\b(ip|domain|protection)\b/) && has(c, /\b(block|allow|rule|all|list)\b/)) || /^\s*(show\s+)?(protection|ratelimit)\s*$/.test(c), ({ c }) => ({ args: { list: has(c, /\bdomainrule\b/) && !has(c, /\biprule\b/) ? 'domain' : has(c, /\biprule\b/) && !has(c, /\bdomainrule\b/) ? 'ip' : 'all' } }));
rule('list_mail_accounts', (c) => has(c, /\bmailaccount\b/) || (has(c, /\bshow\b/) && has(c, /\b(smtp|from)\b/) && !has(c, /\bset\b/)));
rule('list_api_keys', (c) => has(c, /\bapikey\b/) && !has(c, /\b(revoke|delete|cancel|stop)\b/), ({ slots, c }) => ({ args: { ...(slots.emails[0] ? { user: slots.emails[0] } : {}), include_revoked: has(c, /\b(all|revoked)\b/) } }));
rule('revoke_api_key', (c) => has(c, /\bapikey\b/) && has(c, /\b(revoke|delete|cancel|stop)\b/), ({ slots, raw }) => {
  const pref = raw.match(/\b([a-z]{2,5}_[a-z0-9]{4,})\b/i);
  const id = slots.numbers[0] || (slots.quoted[0] || '').trim() || (pref && pref[1]);
  return id ? { args: { id_or_prefix: String(id) } } : { ask: 'Which key? Give me its id or prefix (see “show api keys”).', entity: 'text' };
});
rule('set_mail_keepalive', (c) => has(c, /\bkeepalive\b/) && !has(c, /\bshow\b/), ({ slots, c }) => {
  if (has(c, /\b(run|now|start|send)\b/)) return { args: { run: true } };
  const args = {};
  if (slots.on !== undefined) args.on = slots.on;
  if (slots.days) args.days = slots.days;
  else { const m = c.match(/\bevery\s+(\d{1,2})\b/); if (m) args.days = Number(m[1]); }
  if (slots.emails[0]) args.to = slots.emails[0];
  return Object.keys(args).length ? { args } : { ask: 'Keep-alive on or off, every how many days, and to which address? e.g. “keep alive on every 14 days to ops@x.com” — or “run keep alive now”.', entity: 'fields' };
});
rule('regenerate_indexnow_key', (c) => has(c, /\bindexnowkey\b/) && has(c, /\b(rotate|create|reset|set)\b/));
rule('run_tech_refresh', (c) => has(c, /\bcancel\b/) && has(c, /\btech\b/), () => ({ args: { action: 'cancel' } }));
rule('run_news_refresh', (c) => has(c, /\bcancel\b/) && has(c, /\b(news|sweep)\b/) && !has(c, /\btech\b/), () => ({ args: { action: 'cancel' } }));
rule('__cancelword', (c) => /^\s*cancel\s*$/.test(c) || /^\s*(no|nope|nah)\s*$/.test(c));
rule('__none_trialdays', (c) => has(c, /\btrial\b/) && has(c, /\b(set|day)\b/) && !has(c, /[a-z0-9_]+_[a-z0-9_]+_[a-z]{2,}\b|\bthem\b|\buser\b/) && /\bset\b.*\btrial\b|\btrial\b.*\bdefault\b|\btrial day\b/.test(c), () => ({ none: 'The default trial length is fixed in code (plans.TRIAL_DEFAULT_DAYS). I can start a trial of any length for a specific member though: “start a 21 day trial for bob@x.com”.' }));
rule('__none_restore', (c) => has(c, /\brestorebackup\b/), () => ({ none: 'Restoring a backup is a console-only step (Admin → Backups → Restore) because it replaces the whole database — I can take a fresh backup for you though: say “backup now”.' }));
rule('__none_logout', (c) => has(c, /\blogoutall\b/), () => ({ none: 'Signing every member out is not exposed as a console action. You can suspend a specific member (“suspend bob@x.com”) or rotate the admin session by signing out yourself.' }));
rule('__none_2fa', (c) => has(c, /\b2fa\b/) && has(c, /\b(on|off|start|enroll|setup|regenerate|codes)\b/) && !has(c, /\bemail\b/), () => ({ none: 'Two-factor enrollment and recovery codes stay in Admin → Settings → Security — the secrets must never pass through a chat. I can change the OTP inbox: “set 2fa email to admin@x.com”.' }));
rule('set_ticket_status', (c) => has(c, /\bcloseallsolved\b/), () => ({ none: 'Tickets are closed one at a time so nothing slips — say “show solved tickets” and then “close FL-XXXX”, or “close it” after opening one.' }));
rule('get_health', (c) => has(c, /\bhealth\b/) && !has(c, /\b(indexing|statuspage|component)\b/));
rule('get_payments_summary', (c) => has(c, /\bpayment\b/) && !has(c, /\b(show|count)\b.*\bpayment\b.*\b(pending|failed|list)\b/) && !has(c, /\bpaypal\b/));
rule('get_site_overview', (c, b) => (has(c, /\boverview\b/) || has(c, /\b(show|help)\b.*\b(pages|console|sections|site)\b/) || /^\s*show (site|firmledger)\s*$/.test(c)) && !/\b(search|find|locate|lookup|look\s+up|where\s+is|where\s+are)\b/i.test(String(b && b.raw || '')));
rule('get_settings', (c, b) => ((has(c, /\b(show|count)?\s*settings\b/) || (has(c, /\b(show|display|view|read)\b/) && has(c, /\bpaypal\b/) && !has(c, /\blisting\b/))) && !has(c, /\b(set|on|off|save)\b.*\bsettings\b/) && !has(c, /\bassistant\b/) && !has(c, /\b(upkeep|news|smtp|ratelimit)\b/)) && !/\b(search|find|locate|lookup|look\s+up|where\s+is|where\s+are)\b/i.test(String(b && b.raw || '')));
rule('get_ai_playground', (c) => has(c, /\bassistant\b/) && has(c, /\b(show|status|settings|state|config)\b/));
rule('get_indexing_status', (c) => has(c, /\b(indexing|indexnow|googleindex|upkeep|sweep)\b/) && has(c, /\b(show|status|count|health|progress|quota|running)\b/) && !has(c, /\b(on|off|run|start|cancel|stop|ping|delete)\b/));
rule('get_status_page', (c) => has(c, /\bstatuspage\b/) && !has(c, /\b(statusreport|reset|run|refresh|delete|create|open|update|solved)\b/) || (has(c, /\b(show|count)\b/) && has(c, /\bcomponent\b/)) || (has(c, /\b(site|platform|service)\b/) && has(c, /\bstatus\b/) && !has(c, /\b(ticket|listing|incident|user)\b/)));
rule('get_admin_inbox', (c) => !has(c, /\bmarkread\b/) && !(has(c, /\bmark\b/) && /\b\d+\b/.test(c)) && (has(c, /\binbox\b/) && !has(c, /\b(archive|restore|delete|create|note)\b/) || has(c, /\b(show|count|any)\b.*\binbox\b/)));
rule('get_listing_stats', (c) => has(c, /\bstats\b/) || (has(c, /\bcount\b/) && !has(c, /\b(user|ticket|claim|removal|post|career|promo|planoffer|adpackage|category|incident|subscriber|payment|news|story|listing|pending|approved|rejected|featured|sponsor|inbox|component)\b/)) || /^\s*(show|count)\s*$/.test(c));
rule('get_listing_stats', (c) => has(c, /\bcount\b/) && has(c, /\b(pending|approved|rejected|featured|sponsor|listing|user|ticket|claim|removal|incident|subscriber)\b/) && !has(c, /\b(post|career|promo|planoffer|adpackage|category|payment|news|story)\b/), ({ c, slots }) => ({ args: {}, focus: focusOf(c, slots) }));

/* ---- reads: listing queues & lookups ---- */
function focusOf(c, slots) {
  const st = (slots.statuses || []).find((s) => ['pending', 'approved', 'rejected'].includes(s)) || (has(c, /\bpending\b/) ? 'pending' : has(c, /\bapproved\b/) ? 'approved' : has(c, /\brejected\b/) ? 'rejected' : '');
  if (has(c, /\buser\b/)) return has(c, /\bsuspend\b/) ? 'suspended_users' : 'users';
  if (has(c, /\bticket\b/)) return 'open_tickets';
  if (has(c, /\bclaim\b/)) return 'pending_claims';
  if (has(c, /\bremoval\b/)) return 'pending_removals';
  if (has(c, /\bincident\b/)) return 'open_incidents';
  if (has(c, /\bsubscriber\b/)) return 'newsletter_subs';
  if (has(c, /\bfeature\b/)) return 'featured';
  if (has(c, /\bsponsor\b/)) return 'sponsored';
  return st || 'total_listings';
}
rule('list_listings', (c) => (has(c, /\b(show|open)\b/) || has(c, /\blisting (owned|owner|belonging|by|of|in|from)\b/) || /^\s*(?:all\s+)?(pending|approve|reject|newest|oldest|feature|sponsor|claimed|unclaim|unclaimed)(\s+\d+)?\s+listing\s*$/.test(c) || /^\s*(?:all\s+)?listing\s+(pending|approve|reject|feature|sponsor|claimed|unclaimed)\s*$/.test(c) || /^\s*newest \d+ (newest )?listing\s*$/.test(c)) && has(c, /\b(pending|approve|reject|newest|oldest|feature|sponsor|claimed|unclaim|unclaimed|listing|their)\b/) && !has(c, /\b(user|ticket|claim|removal|post|career|promo|planoffer|adpackage|category|incident|subscriber|payment|news|story|inbox|settings|health|stats|relation|event)\b/) && !(has(c, /\btech\b/) && !has(c, /\blisting in tech\b/)) && !(has(c, /\b(approve|reject)\b/) && !has(c, /\b(show|open)\b/) && !/^\s*(?:all\s+)?(approve|reject)\s+listing\s*$/.test(c)) && !has(c, /\b(delete|suspend|grant|revoke|set|create|email|reply)\b/),
  ({ c, slots, text, ctx }) => {
    if (slots.emails.length && has(c, /\b(owned|owner|by|belonging)\b/)) slots.theirListings = true;
    if (text && text.length >= 2 && !slots.theirListings && !has(c, /\b(pending|approve|reject|newest|oldest|feature|sponsor|claimed|unclaim|unclaimed)\b/) && !has(c, /\blisting (in|from)\b/)) return { skip: true };
    if (slots.ids.listing || slots.hashId || slots.slugs.length || slots.quoted.length || (slots.numbers.length && !slots.limit)) return { skip: true };
    const status = (slots.statuses || []).find((s) => ['pending', 'approved', 'rejected'].includes(s)) || (has(c, /\bpending\b/) ? 'pending' : has(c, /\bapprove\b/) && !has(c, /\bunclaim/) ? 'approved' : has(c, /\breject\b/) ? 'rejected' : '');
    const args = { limit: slots.limit || 20 };
    if (status) args.status = status;
    if (has(c, /\bfeature\b/)) args.featured = true;
    if (has(c, /\bsponsor\b/)) args.sponsored = true;
    if (has(c, /\b(unclaimed|unclaim)\b/)) args.claimed = false; else if (has(c, /\bclaimed\b/)) args.claimed = true;
    if (has(c, /\boldest\b/)) args.order = 'oldest';
    if (slots.sinceDays) args.since_days = slots.sinceDays;
    if (slots.theirListings || slots.emails.length) { const u = resolveUser({ slots, ctx, text: '', allowContext: true }); if (u.ok) args.owner = String(u.row.id); }
    for (const w of ['country', 'category']) if (slots.keyval && slots.keyval[w]) args[w] = slots.keyval[w];
    if (text && has(c, /\b(in|from)\b/) && !args.country && !args.category) { const cat = q.categoryByName(text); if (cat && !has(c, /\bfrom\b/)) args.category = cat.name; else args.country = text.replace(/\b\w/g, (m) => m.toUpperCase()); }
    return { args };
  });
rule('get_listing', (c, b) => ((has(c, /\b(show|open)\b/) && has(c, /\blisting\b/)) || (has(c, /\b(show|open)\b/) && !has(c, /\b(user|ticket|claim|removal|post|career|promo|planoffer|adpackage|category|incident|subscriber|payment|news|story|inbox|settings|health|stats|indexing|statuspage|smtp|ratelimit|ip|domain|backup|protection)\b/))) && !/\b(search|find|locate|lookup|look\s+up|where\s+is|where\s+are)\b/i.test(String(b && b.raw || '')),
  ({ slots, ctx, text, c }) => {
    if (slots.emails.length && !slots.ids.listing) return { skip: true };
    if (has(c, /\bthem\b/) && !has(c, /\blisting\b/)) return { skip: true };
    if (!text && !slots.ids.listing && !slots.slugs.length && !slots.quoted.length && !slots.numbers.length && !slots.hashId && !slots.pronoun && !slots.domains.length) return { skip: true };
    const r = resolveListing({ slots, ctx, text, c });
    if (!r.ok) {
      if (r.none) return { none: r.none };
      if (r.options) return { ask: r.ask, options: r.options, entity: 'listing' };
      return { skip: true };
    }
    return { args: { id_or_slug: r.value }, listing: r.row };
  });
rule('search_admin', (c, b) => {
  const raw = String(b && b.raw || '');
  const global = has(c, /\b(show|search|find|locate)\b/) && (has(c, /\b(everywhere|everything|anywhere|across|all)\b/) || /\bglobal(?:ly)?\s+search\b/i.test(raw));
  const explicit = /\b(search|find|locate|lookup|look\s+up|where\s+is|where\s+are)\b/i.test(raw)
    && !has(c, /\b(listings?|users?|members?|tickets?|claims?|removals?)\b/);
  return global || explicit;
}, ({ text, raw, slots }) => {
  const source = String(text || raw || '');
  const scoped = source.match(/\b(?:for|about|named|called|containing|matching)\s+(.+)$/i);
  const qq = (scoped ? scoped[1] : source)
    .replace(/^\s*(?:show|search|find|locate|lookup|look\s+up|where\s+is|where\s+are)\b\s*/i, '')
    .replace(/\b(everywhere|everything|anywhere|across|all|the|whole|site|console|admin)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  const cleanQ = [...new Set(qq.split(/\s+/).filter(Boolean))].join(' ') || slots.quoted[0] || slots.emails[0] || slots.domains[0];
  return cleanQ ? { args: { q: cleanQ } } : { ask: 'Search the entire site for what?', entity: 'text' };
});
rule('search_listings', (c) => has(c, /\b(show|search)\b/) && has(c, /\blisting\b/), ({ slots, text, c }) => {
  const term = slots.quoted[0] || slots.domains[0] || text;
  if (!term || term.length < 2) return { skip: true };
  const args = { q: term };
  const st = (slots.statuses || []).find((s) => ['pending', 'approved', 'rejected'].includes(s));
  if (st) args.status = st;
  return { args };
});

/* ---- reads: users ---- */
rule('list_users', (c) => has(c, /\buser\b/) && (has(c, /\b(show|open|count)\b/) || has(c, /\b(thisweek|today|thismonth|newest)\b/)) && (has(c, /\b(suspend|pro|free|trial|newest|thisweek|today|thismonth|all)\b/) || !has(c, /\b(user)\b.*\S/)) && !has(c, /\b(email|send|grant|revoke|delete)\b/),
  ({ slots, c, text }) => {
    if (text && text.length >= 2 && !slots.sinceDays && !has(c, /\b(suspend|pro|free|trial|newest)\b/)) return { skip: true };
    const args = { limit: slots.limit || 20 };
    if (has(c, /\bsuspend\b/)) args.suspended = true;
    if (has(c, /\bpro\b/)) args.plan = 'pro';
    else if (has(c, /\bfree\b/)) args.plan = 'free';
    if (has(c, /\btrial\b/)) args.trial = true;
    if (slots.sinceDays) args.since_days = slots.sinceDays;
    return { args };
  });
rule('get_user', (c) => has(c, /\b(show|open)\b/) && (has(c, /\buser\b/) || has(c, /\bthem\b/) || has(c, /[a-z0-9_]+_[a-z0-9_]+_[a-z]{2,}/)) && !has(c, /\b(email|send|reply|suspend|grant|revoke|listing)\b/), ({ slots, ctx, text }) => {
  const r = resolveUser({ slots, ctx, text });
  if (!r.ok) { if (r.none) return { none: r.none }; if (r.options) return { ask: r.ask, options: r.options, entity: 'user' }; return { skip: true }; }
  return { args: { user: r.value }, user: r.row };
});
rule('search_users', (c) => has(c, /\b(show|search)\b/) && has(c, /\buser\b/), ({ slots, text }) => {
  const term = slots.quoted[0] || slots.emails[0] || text;
  if (!term || term.length < 2) return { skip: true };
  return { args: { q: term } };
});
rule('list_users', (c) => has(c, /\b(show|open)\b/) && has(c, /\buser\b/), ({ slots }) => ({ args: { limit: slots.limit || 20 } }));

/* ---- reads: tickets / claims / removals / news / content ---- */
rule('get_ticket', (c) => has(c, /\bticket\b/) && (has(c, /\bticketref\b/) || has(c, /\b(show|open|read)\b/)) && !has(c, /\b(reply|solved|closed|reopen|set)\b/), ({ slots, ctx, text, c }) => {
  if (!slots.ref && !slots.ids.ticket && !slots.numbers.length && !slots.hashId && !slots.emails.length && !slots.pronoun && !(text && text.length >= 3)) return { skip: true };
  if (has(c, /\b(open|pending|all|newest|closed|solved)\b/) && !slots.ref && !slots.ids.ticket && !slots.numbers.length && !slots.hashId && !slots.pronoun) return { skip: true };
  const r = resolveTicket({ slots, ctx, text });
  if (!r.ok) { if (r.none) return { none: r.none }; if (r.options) return { ask: r.ask, options: r.options, entity: 'ticket' }; return { skip: true }; }
  return { args: { id_or_ref: r.value }, ticket: r.row };
});
rule('list_tickets', (c) => has(c, /\bticket\b/) && (has(c, /\b(show|count|open|closed|solved|all|newest|any)\b/) || /^\s*ticket\s*$/.test(c)) && !has(c, /\b(reply|reopen|set|email|send|it|ticketref)\b/) && !has(c, /\b(solved|closed)\b.*\b\d+\b|\b\d+\b.*\b(solved|closed)\b/), ({ slots, c }) => {
  const st = (slots.statuses || []).find((s) => ['open', 'solved', 'closed'].includes(s)) || (has(c, /\ball\b/) ? '' : 'open');
  return { args: { status: st, limit: slots.limit || 30 } };
});
rule('list_pending_claims', (c) => has(c, /\bclaim\b/) && !has(c, /\b(reject|refresh|verify|approve)\b/));
rule('list_pending_removals', (c) => has(c, /\bremoval\b/) && !has(c, /\b(reject|dismiss|delete|approve|solved|fulfil)\b/));
rule('list_news_queue', (c) => has(c, /\b(news|story)\b/) && has(c, /\b(show|pending|count|approved|rejected|any|open)\b/) && !has(c, /\b(approve|reject|delete|create|refresh|run|set|on|off)\b/), ({ slots, ctx, text, c }) => {
  const args = {};
  const st = (slots.statuses || []).find((s) => ['pending', 'approved', 'rejected'].includes(s));
  if (st) args.status = st;
  if (text || slots.ids.listing || slots.slugs.length) { const r = resolveListing({ slots, ctx, text, c, allowContext: false }); if (r.ok) args.listing = r.value; }
  return { args };
});
const CONTENT = [['post', 'blog'], ['career', 'careers'], ['promo', 'promos'], ['adpackage', 'ads'], ['planoffer', 'plans'], ['category', 'categories'], ['incident', 'incidents'], ['subscriber', 'subscribers']];
for (const [tok, what] of CONTENT) {
  rule('list_content', (c) => has(c, new RegExp(`\\b${tok}\\b`)) && (has(c, /\b(show|count|open|any|newest|all)\b/) || new RegExp(`^\\s*${tok}\\s*$`).test(c)) && !has(c, /\b(create|delete|set|rename|approve|reject|hide|unpublish|publish|toggle|solved|update|on|off|title|open incident)\b/) && !(tok === 'incident' && has(c, /\bopen\b/) && has(c, /\b X \b|\bmajor\b|\bminor\b|\bcritical\b/)),
    ({ slots }) => {
      const args = { what };
      const st = (slots.statuses || [])[0];
      if (st) args.status = st === 'solved' ? 'resolved' : st;
      return { args };
    });
}
rule('list_content', (c) => has(c, /\b(category|promo|planoffer|adpackage|career|post|incident|subscriber)\b/) && has(c, /\bshow\b/) && !has(c, /\b(create|delete|set|rename|on|off|approve|reject|hide|toggle|pause|resume|close|reopen|edit|draft|publish|unpublish|\d)\b/) && !has(c, /\b(listing|user|ticket)\b/), ({ c, slots }) => { const what = has(c, /\bcategory\b/) ? 'categories' : has(c, /\bpromo\b/) ? 'promos' : has(c, /\bplanoffer\b/) ? 'plans' : has(c, /\badpackage\b/) ? 'ads' : has(c, /\bcareer\b/) ? 'careers' : has(c, /\bpost\b/) ? 'blog' : has(c, /\bincident\b/) ? 'incidents' : 'subscribers'; return { args: { what, ...(slots.statuses && slots.statuses[0] ? { status: slots.statuses[0] } : {}) } }; });
rule('list_content', (c) => has(c, /\bpayment\b/) && has(c, /\b(show|open)\b/) && has(c, /\b(pending|failed|list|newest)\b/), ({ slots }) => ({ args: { what: 'payments', status: (slots.statuses || [])[0] || '' } }));

/* ---- writes: listings ---- */
const listingTarget = (b) => {
  const r = resolveListing(b);
  if (!r.ok) return askFor(r, 'listing') || { ask: r.ask, options: r.options, entity: 'listing' };
  return { value: r.value, row: r.row };
};
rule('accept_all_pending_listings', (c) => has(c, /\bapprove\b/) && has(c, /\ball\b/) && (has(c, /\b(pending|listing)\b/) || /^\s*approve all\s*$/.test(c)) && !has(c, /\b(news|story|claim|feature|sponsor|delete|reject)\b/));
rule('bulk_listing_action', (c) => has(c, /\b(approve|reject|delete|feature|unfeature|sponsor|unsponsor)\b/) && ((has(c, /\ball\b/) && has(c, /\b(listing|pending|approved|rejected)\b/)) || /\b\d+\b(?:\s+(?:and\s+)?\d+\b){1,}/.test(c)) && !has(c, /\b(news|story|claim|user|ticket|post|career|promo|incident|category|planoffer|adpackage|day|month|year|percent|uses)\b/),
  ({ c, slots, text }) => {
    const action = has(c, /\bunfeature\b/) ? 'unfeature' : has(c, /\bunsponsor\b/) ? 'unsponsor' : has(c, /\bfeature\b/) ? 'feature' : has(c, /\bsponsor\b/) ? 'sponsor' : has(c, /\bdelete\b/) ? 'delete' : has(c, /\breject\b/) ? 'reject' : 'approve';
    const args = { action };
    if (!has(c, /\ball\b/) && slots.numbers.length > 1) { args.ids = slots.numbers.map(Number); return { args }; }
    const st = (slots.statuses || []).find((s) => ['pending', 'approved', 'rejected'].includes(s));
    if (st) args.status = st;
    if (slots.days && action === 'sponsor') args.days = slots.days;
    if (text) { const cat = q.categoryByName(text) || q.categoriesLike(text)[0]; if (cat) args.category = cat.name; else if (has(c, /\b(in|from)\b/)) args.country = text.replace(/\b\w/g, (m) => m.toUpperCase()); }
    return { args };
  });
rule('approve_listing', (c) => (has(c, /\bapprove\b/) || (has(c, /\b(make|set)\b/) && has(c, /\blive\b/))) && !has(c, /\b(news|story|claim|transfer|post|user|ticket|auto|moderation)\b/), (b) => { const t = listingTarget(b); return t.value ? { args: { id_or_slug: t.value }, listing: t.row } : t; });
rule('reject_listing', (c) => has(c, /\breject\b/) && !has(c, /\b(news|story|claim|transfer|removal)\b/), (b) => { const t = listingTarget(b); return t.value ? { args: { id_or_slug: t.value }, listing: t.row } : t; });
rule('unfeature_listing', (c) => has(c, /\bunfeature\b/) || (has(c, /\b(delete|revoke|off|stop)\b/) && has(c, /\bfeature\b/)), (b) => { const t = listingTarget(b); return t.value ? { tool: 'feature_listing', args: { id_or_slug: t.value, featured: false }, listing: t.row } : t; });
rule('feature_listing', (c) => has(c, /\bfeature\b/) && !has(c, /\b(show|count|which)\b/), (b) => { const t = listingTarget(b); return t.value ? { args: { id_or_slug: t.value, featured: true }, listing: t.row } : t; });
rule('unsponsor_listing', (c) => has(c, /\bunsponsor\b/) || (has(c, /\b(delete|revoke|off|stop|cancel)\b/) && has(c, /\bsponsor\b/)), (b) => { const t = listingTarget(b); return t.value ? { args: { id_or_slug: t.value }, listing: t.row } : t; });
rule('sponsor_listing', (c) => has(c, /\bsponsor\b/) && !has(c, /\b(show|count|which|adpackage)\b/), (b) => { const t = listingTarget(b); if (!t.value) return t; const args = { id_or_slug: t.value }; if (b.slots.lifetime) args.lifetime = true; else args.days = b.slots.days || 30; return { args, listing: t.row }; });
rule('revoke_listing_pro', (c) => has(c, /\b(revoke|cancel|delete)\b/) && has(c, /\bpro\b/) && has(c, /\blisting\b/) && !has(c, /\buser\b/), (b) => { const t = listingTarget(b); return t.value ? { args: { id_or_slug: t.value }, listing: t.row } : t; });
rule('grant_listing_pro', (c) => has(c, /\b(grant|make|set)\b/) && has(c, /\bpro\b/) && has(c, /\blisting\b/) && !has(c, /\buser\b/), (b) => { const t = listingTarget(b); if (!t.value) return t; const args = { id_or_slug: t.value }; if (b.slots.lifetime) args.lifetime = true; else args.days = b.slots.days || 30; return { args, listing: t.row }; });
rule('refresh_listing_tech', (c) => has(c, /\btech\b/) && has(c, /\b(refresh|run|scan|start|set)\b/) && !has(c, /\b(all|stale|sweep|cancel|stop)\b/), (b) => { const t = listingTarget(b); return t.value ? { args: { id_or_slug: t.value }, listing: t.row } : t; });
rule('run_tech_refresh', (c) => has(c, /\btech\b/) && (has(c, /\b(all|stale|sweep|cancel|stop)\b/) || has(c, /\b(refresh|run|start)\b/)), ({ c }) => ({ args: has(c, /\b(cancel|stop)\b/) ? { action: 'cancel' } : { action: 'start', scope: has(c, /\ball\b/) ? 'all' : 'stale' } }));
rule('set_listing_owner', (c) => has(c, /\b(owner|assign|unclaim)\b|\btransfer\b.*\bto\b/) && !has(c, /\b(show|email|send)\b/) && !has(c, /\btransfer\b.*\b(approve|reject)\b/),
  ({ slots, ctx, text, c }) => {
    const l = resolveListing({ slots, ctx, text: '', c });
    if (!l.ok) {
      /* name may be in the free text: "make bob owner of Acme" */
      const l2 = resolveListing({ slots: { ...slots, emails: [] }, ctx, text, c });
      if (!l2.ok) return askFor(l2, 'listing') || { ask: l2.ask, options: l2.options, entity: 'listing' };
      l.value = l2.value; l.row = l2.row; l.ok = true;
    }
    if (has(c, /\bunclaim\b/) || (has(c, /\b(delete|revoke)\b/) && has(c, /\bowner\b/))) {
      const l3 = text ? resolveListing({ slots, ctx, text, c, allowContext: false }) : l;
      const tgt = l3.ok ? l3 : l;
      return { args: { id_or_slug: tgt.value, user: '' }, listing: tgt.row };
    }
    const u = resolveUser({ slots, ctx, text: '', allowContext: false });
    if (!u.ok) return { ask: 'Which member should own it? Give me their email or id.', entity: 'user', partial: { id_or_slug: l.value } };
    return { args: { id_or_slug: l.value, user: u.value }, listing: l.row, user: u.row };
  });
rule('delete_listing', (c) => has(c, /\bdelete\b/) && !has(c, /\b(user|category|post|career|promo|planoffer|adpackage|incident|story|news|relation|event|inbox|note|ip|domain|rule|credentials|log|smtp|owner|feature|sponsor|pro|trial)\b/), (b) => { const t = listingTarget(b); return t.value ? { args: { id_or_slug: t.value }, listing: t.row } : t; });
rule('update_listing', (c) => has(c, /\b(set|rename|make)\b/) && has(c, /\b(listing|it)\b|\b(website|tagline|description|phone|city|country|tags|founded|size|name|type|category|region|logo|email)\b/) && !has(c, /\b(owner|pro|feature|sponsor|relation|event|maintenance|user|ticket|planoffer|adpackage|2fa|smtp|paypal|from|ratelimit|limit|upkeep|newsletter|cadence|incident|component|post|career|promo|category\s+\S+\s+to)\b/),
  ({ slots, ctx, text, c, raw }) => {
    const fields = {};
    const kv = slots.keyval || {};
    for (const k of ['name', 'tagline', 'description', 'type', 'category', 'website', 'email', 'phone', 'country', 'city', 'region', 'address', 'founded', 'size', 'tags', 'logo_url', 'status']) if (kv[k]) fields[k] = kv[k];
    if (kv.logo) fields.logo_url = kv.logo;
    const m = raw.match(/\b(website|tagline|description|phone|city|country|tags|founded|size|name|type|category|region|address|email)\b\s+(?:of\s+(.+?)\s+)?(?:to|=|:)\s+(.+)$/i);
    if (m && !fields[m[1].toLowerCase()]) fields[m[1].toLowerCase()] = m[3].trim().replace(/^["']|["']$/g, '');
    if (slots.urls.length && !fields.website && has(c, /\bwebsite\b/)) fields.website = slots.urls[0];
    if (!Object.keys(fields).length) return { skip: true };
    const targetText = m && m[2] ? m[2] : text;
    const r = resolveListing({ slots: { ...slots, urls: [], quoted: slots.quoted.filter((x) => !Object.values(fields).includes(x)) }, ctx, text: targetText, c });
    if (!r.ok) return askFor(r, 'listing') || { ask: r.ask, options: r.options, entity: 'listing', partial: fields };
    return { args: { id_or_slug: r.value, ...fields }, listing: r.row };
  });
rule('set_listing_relation', (c) => has(c, /\b(relation|parent|subsidiary|brand|competitor|partner)\b/) && has(c, /\b(create|set|delete|make|link|mark)\b|\bof\b/),
  ({ slots, ctx, text, c, raw }) => {
    if (has(c, /\bdelete\b/) && (slots.ids.relation || slots.numbers.length === 1)) {
      const l = resolveListing({ slots: { ...slots, numbers: [] }, ctx, text, c });
      if (!l.ok) return askFor(l, 'listing') || { ask: l.ask, options: l.options, entity: 'listing' };
      return { args: { action: 'remove', id_or_slug: l.value, relation_id: slots.ids.relation || slots.numbers[0] }, listing: l.row };
    }
    const m = raw.match(/\b(?:mark|set|make|add|link)\s+(.+?)\s+as\s+(?:a\s+|the\s+)?(parent|subsidiary|brand|competitor|partner)\s+of\s+(.+)$/i)
      || raw.match(/\b(parent|subsidiary|brand|competitor|partner)\s+of\s+(.+?)\s+(?:is|=|:)\s+(.+)$/i);
    const m2 = !m && raw.match(/\b(?:link|connect|relate|set|add)\s+(.+?)\s+(?:to|with|and)\s+(.+?)\s+as\s+(?:a\s+|the\s+)?(parent|subsidiary|brand|competitor|partner)s?\s*$/i);
    let subject; let target; let relType = slots.relType;
    if (m && m.length === 4 && /parent|subsidiary|brand|competitor|partner/i.test(m[2])) { target = m[1]; relType = m[2].toLowerCase(); subject = m[3]; }
    else if (m) { relType = m[1].toLowerCase(); subject = m[2]; target = m[3]; }
    else if (m2) { subject = m2[1]; target = m2[2]; relType = m2[3].toLowerCase(); }
    if (!subject) {
      const l = resolveListing({ slots, ctx, text: '', c });
      if (!l.ok) return { ask: 'Which listing gets the relationship, and to which target? e.g. “mark Beta Ltd as a subsidiary of Acme”.', entity: 'listing' };
      subject = l.value; target = text;
    }
    const l = resolveListing({ slots: { ...slots, quoted: [] }, ctx, text: subject.replace(/^["']|["']$/g, ''), c, allowContext: true });
    if (!l.ok) return askFor(l, 'listing') || { ask: l.ask, options: l.options, entity: 'listing' };
    if (!relType) return { ask: 'What kind of relationship — parent, subsidiary, brand, competitor or partner?', entity: 'relType', partial: { id_or_slug: l.value, target } };
    const tgt = target ? resolveListing({ slots: { ...slots, quoted: [], numbers: [], ids: {} }, ctx: {}, text: target.replace(/^["']|["']$/g, ''), c, allowContext: false }) : { ok: false };
    return { args: { action: 'add', id_or_slug: l.value, rel_type: relType, target: tgt.ok ? tgt.value : String(target || '').trim() }, listing: l.row };
  });
rule('manage_listing_event', (c) => has(c, /\b(event|milestone|funding|launch|award)\b/) && has(c, /\b(create|delete|set|log|record)\b/) && !has(c, /\bincident\b/),
  ({ slots, ctx, text, c }) => {
    const l = resolveListing({ slots: { ...slots, quoted: slots.quoted.slice(1) }, ctx, text, c });
    if (has(c, /\bdelete\b/)) {
      if (!l.ok) return askFor(l, 'listing') || { ask: l.ask, options: l.options, entity: 'listing' };
      const id = slots.ids.event || slots.numbers[0];
      if (!id) return { ask: 'Which event id should I delete?', entity: 'event', partial: { action: 'delete', id_or_slug: l.value } };
      return { args: { action: 'delete', id_or_slug: l.value, event_id: id }, listing: l.row };
    }
    if (!l.ok) return askFor(l, 'listing') || { ask: l.ask, options: l.options, entity: 'listing' };
    const title = slots.title || slots.quoted[0] || slots.said;
    if (!title) return { ask: 'What is the event title? (e.g. “Series A funding”)', entity: 'title', partial: { action: 'add', id_or_slug: l.value, kind: slots.eventKind || 'milestone', event_date: slots.date } };
    return { args: { action: 'add', id_or_slug: l.value, title, kind: slots.eventKind || 'milestone', event_date: slots.date || new Date().toISOString().slice(0, 10) }, listing: l.row };
  });
rule('create_listing', (c) => has(c, /\bcreate\b/) && has(c, /\blisting\b/), ({ slots }) => {
  const kv = slots.keyval || {};
  const need = ['name', 'tagline', 'description', 'website', 'category', 'type', 'country'].filter((k) => !kv[k] && !(k === 'name' && (slots.named || slots.quoted[0])) && !(k === 'website' && slots.urls[0]));
  const args = { ...kv };
  if (!args.name) args.name = slots.named || slots.quoted[0];
  if (!args.website && slots.urls[0]) args.website = slots.urls[0];
  if (need.length) return { ask: `To create a listing I need: ${need.join(', ')}. Send them as key=value pairs, e.g. name="Acme Ltd" website=https://acme.co.ke category=Technology type=company country=Kenya tagline="…" description="…"`, entity: 'fields', partial: args };
  return { args };
});

/* ---- categories ---- */
rule('rename_category', (c) => has(c, /\bcategory\b/) && has(c, /\b(rename|move|set)\b/), ({ slots, text, raw }) => {
  const m = raw.match(/\b(?:rename|move|change)\s+(?:the\s+)?(?:category\s+)?["']?(.+?)["']?\s+(?:to|into|→|->)\s+["']?(.+?)["']?\s*$/i);
  const from = slots.quoted[0] || (m && m[1]) || text;
  const to = slots.quoted[1] || (m && m[2]) || slots.renameTo;
  if (!from || !to) return { ask: 'Rename which category to what? e.g. “rename category Fintech to Financial Services”.', entity: 'fields' };
  return { args: { from: from.replace(/^category\s+/i, ''), to } };
});
rule('delete_category', (c) => has(c, /\bcategory\b/) && has(c, /\bdelete\b/), ({ slots, text }) => { const name = slots.quoted[0] || slots.named || text; return name ? { args: { name } } : { ask: 'Delete which category?', entity: 'name' }; });
rule('create_category', (c) => has(c, /\bcategory\b/) && has(c, /\bcreate\b/), ({ slots, text }) => { const name = slots.quoted[0] || slots.named || text; return name ? { args: { name } } : { ask: 'What should the new category be called?', entity: 'name' }; });

/* ---- users & billing ---- */
const userTarget = (b) => { const r = resolveUser(b); if (!r.ok) return askFor(r, 'user') || { ask: r.ask, options: r.options, entity: 'user' }; return { value: r.value, row: r.row }; };
rule('delete_user', (c) => has(c, /\bdelete\b/) && has(c, /\b(user|them)\b/), (b) => { const t = userTarget(b); return t.value ? { args: { user: t.value }, user: t.row } : t; });
rule('unsuspend_user', (c) => has(c, /\bunsuspend\b/) || (has(c, /\bunblock\b/) && !has(c, /\b(ip|domain)\b/)), (b) => { const t = userTarget(b); return t.value ? { args: { user: t.value }, user: t.row } : t; });
rule('suspend_user', (c) => has(c, /\bsuspend\b/) && !has(c, /\b(show|count|which)\b.*\bsuspend\b/) || (has(c, /\b(block|stop|off)\b/) && has(c, /\b(user|them)\b/) && !has(c, /\b(ip|domain)\b/)), (b) => { const t = userTarget(b); return t.value ? { args: { user: t.value }, user: t.row } : t; });
rule('send_password_reset', (c) => has(c, /\bpasswordreset\b/) || (has(c, /\bpassword\b/) && has(c, /\b(reset|send|email)\b/)), (b) => { const t = userTarget(b); return t.value ? { args: { user: t.value }, user: t.row } : t; });
rule('revoke_trial', (c) => has(c, /\btrial\b/) && has(c, /\b(revoke|cancel|stop|delete|off)\b/), (b) => { const t = userTarget(b); return t.value ? { args: { user: t.value }, user: t.row } : t; });
rule('grant_trial', (c) => has(c, /\btrial\b/) && has(c, /\b(grant|start|create|make|set|on)\b/), (b) => { const t = userTarget(b); return t.value ? { args: { user: t.value, days: b.slots.days || 14 }, user: t.row } : t; });
rule('revoke_user_pro', (c) => has(c, /\bpro\b/) && has(c, /\b(revoke|cancel|delete|stop)\b/), (b) => {
  const t = userTarget(b);
  if (!t.value) { const l = resolveListing({ ...b, allowContext: false }); if (l.ok) return { tool: 'revoke_listing_pro', args: { id_or_slug: l.value }, listing: l.row }; return t; }
  return { args: { user: t.value }, user: t.row };
});
rule('grant_user_pro', (c) => has(c, /\bpro\b/) && has(c, /\b(grant|make|set|on|lifetime)\b/), (b) => {
  const t = userTarget(b);
  if (!t.value) {
    /* "give acme pro" — the target may be a listing */
    const l = resolveListing({ ...b, allowContext: false });
    if (l.ok) { const args = { id_or_slug: l.value }; if (b.slots.lifetime) args.lifetime = true; else args.days = b.slots.days || 30; return { tool: 'grant_listing_pro', args, listing: l.row }; }
    return t;
  }
  const args = { user: t.value }; if (b.slots.lifetime) args.lifetime = true; else args.days = b.slots.days || 30; return { args, user: t.row };
});
rule('approve_pro_transfer', (c) => has(c, /\btransfer\b/) && has(c, /\bapprove\b/), (b) => { const r = resolveTypedId('transfer', { ...b, label: 'transfer request' }); return r.ok ? { args: { id: r.value } } : { ask: r.ask, entity: 'transfer' }; });
rule('reject_pro_transfer', (c) => has(c, /\btransfer\b/) && has(c, /\breject\b/), (b) => { const r = resolveTypedId('transfer', { ...b, label: 'transfer request' }); return r.ok ? { args: { id: r.value } } : { ask: r.ask, entity: 'transfer' }; });
rule('delete_plan_offer', (c) => has(c, /\bplanoffer\b/) && has(c, /\bdelete\b/), (b) => { const r = resolveTypedId('plan', { ...b, label: 'plan offer' }); if (r.ok) return { args: { id: r.value } }; const rows = q.plansLike(b.text); if (rows.length === 1) return { args: { id: rows[0].id } }; return { ask: r.ask, entity: 'plan', options: rows.map((p) => ({ label: `${p.name} (#${p.id})`, value: p.id })) }; });
rule('toggle_plan_offer', (c) => has(c, /\bplanoffer\b/) && has(c, /\b(hide|on|off|toggle|show|unpublish|approve|disable|enable)\b/) && !has(c, /\b(show|count)\b\s*(all\s*)?planoffer\s*$/), (b) => { const r = resolveTypedId('plan', { ...b, label: 'plan offer' }); if (r.ok) return { args: { id: r.value } }; const rows = q.plansLike(b.text); if (rows.length === 1) return { args: { id: rows[0].id } }; return { ask: r.ask, entity: 'plan', options: rows.map((p) => ({ label: `${p.name} (#${p.id})`, value: p.id })) }; });
rule('create_plan_offer', (c) => has(c, /\bplanoffer\b/) && has(c, /\bcreate\b/) && !has(c, /\b(post|career|promo)\b/), ({ slots, text }) => {
  const kv = slots.keyval || {};
  const name = kv.name || slots.quoted[0] || slots.named || text;
  const price = slots.usd !== undefined ? slots.usd : (kv.price ? Number(kv.price) : undefined);
  const days = slots.days || (kv.days ? Number(kv.days) : undefined);
  if (!name || price === undefined || !days) return { ask: 'Give me the offer name, price in USD and duration in days — e.g. “create plan offer "Pro Quarter" $39 for 90 days”.', entity: 'fields', partial: { name, price_usd: price, duration_days: days } };
  return { args: { name, price_usd: price, duration_days: days, blurb: kv.blurb || '' } };
});

/* ---- claims / tickets / removals ---- */
rule('recheck_claim', (c) => has(c, /\bclaim\b/) && has(c, /\b(refresh|verify|approve|run|retry)\b/), (b) => { const r = resolveTypedId('claim', b); return r.ok ? { args: { id: r.value } } : { ask: r.ask, entity: 'claim' }; });
rule('reject_claim', (c) => has(c, /\bclaim\b/) && has(c, /\breject\b/), (b) => { const r = resolveTypedId('claim', b); return r.ok ? { args: { id: r.value } } : { ask: r.ask, entity: 'claim' }; });
rule('fulfill_removal', (c) => has(c, /\bremoval\b/) && has(c, /\b(approve|delete|solved|fulfil|honour|honor|grant)\b/), (b) => { const r = resolveTypedId('removal', { ...b, label: 'removal request' }); return r.ok ? { args: { id: r.value } } : { ask: r.ask, entity: 'removal' }; });
rule('dismiss_removal', (c) => has(c, /\bremoval\b/) && has(c, /\b(reject|dismiss|closed|ignore|deny)\b/), (b) => { const r = resolveTypedId('removal', { ...b, label: 'removal request' }); return r.ok ? { args: { id: r.value } } : { ask: r.ask, entity: 'removal' }; });
rule('reply_ticket', (c) => has(c, /\breply\b/) || (has(c, /\bticket\b/) && has(c, /\b(email|send)\b/)), ({ slots, ctx, text, raw }) => {
  const r = resolveTicket({ slots, ctx, text: '' });
  if (!r.ok) {
    const r2 = resolveTicket({ slots, ctx, text: text.split(' ').slice(0, 4).join(' ') });
    if (!r2.ok) return askFor(r2, 'ticket') || { ask: r2.ask, options: r2.options, entity: 'ticket' };
    r.value = r2.value; r.row = r2.row; r.ok = true;
  }
  let message = slots.said || slots.quoted[0];
  if (!message) {
    const m = raw.match(/\b(?:reply|respond|answer)\s+(?:to\s+)?(?:ticket\s+)?(?:#?\d+|FL-[A-Z0-9]+|it|that|this)\s*[:,-]?\s+(.{4,})$/i);
    if (m) message = m[1].trim();
  }
  if (!message || message.length < 2) return { ask: `What should the reply on ${r.row.ref} say?`, entity: 'message', partial: { id_or_ref: r.value } };
  return { args: { id_or_ref: r.value, message }, ticket: r.row };
});
rule('set_ticket_status', (c) => has(c, /\bticket\b|\bticketref\b/) && has(c, /\b(solved|closed|reopen|open|set)\b/) || (has(c, /\b(solved|closed|reopen)\b/) && has(c, /\b(it|ticketref)\b/)), ({ slots, ctx, text, c }) => {
  const r = resolveTicket({ slots, ctx, text });
  if (!r.ok) return askFor(r, 'ticket') || { ask: r.ask, options: r.options, entity: 'ticket' };
  const status = has(c, /\bsolved\b/) ? 'solved' : has(c, /\bclosed\b/) ? 'closed' : (has(c, /\b(reopen|open)\b/) ? 'open' : (slots.statuses || []).find((s) => ['open', 'solved', 'closed'].includes(s)));
  if (!status) return { ask: `Set ${r.row.ref} to open, solved or closed?`, entity: 'status', partial: { id_or_ref: r.value } };
  return { args: { id_or_ref: r.value, status }, ticket: r.row };
});

/* ---- news ---- */
rule('approve_news', (c) => has(c, /\b(news|story)\b/) && has(c, /\bapprove\b/), (b) => { const r = resolveTypedId('story', { ...b, label: 'news story' }); return r.ok ? { args: { id: String(r.value) } } : { ask: r.ask, entity: 'story' }; });
rule('reject_news', (c) => has(c, /\b(news|story)\b/) && has(c, /\breject\b/), (b) => { const r = resolveTypedId('story', { ...b, label: 'news story' }); return r.ok ? { args: { id: String(r.value) } } : { ask: r.ask, entity: 'story' }; });
rule('delete_news_story', (c) => has(c, /\b(news|story)\b/) && has(c, /\bdelete\b/), (b) => { const r = resolveTypedId('story', { ...b, label: 'news story' }); return r.ok ? { args: { id: r.value } } : { ask: r.ask, entity: 'story' }; });
rule('set_news_settings', (c) => has(c, /\bnews\b/) && has(c, /\b(pending|moderation|review)\b/) && has(c, /\b(on|off|set)\b/), ({ slots }) => ({ args: { review_auto: slots.on !== false } }));
rule('run_news_refresh', (c) => has(c, /\b(news|story)\b/) && has(c, /\b(refresh|run|start|cancel|stop|scan|search)\b/), ({ slots, ctx, text, c }) => {
  if (has(c, /\b(cancel|stop)\b/)) return { args: { action: 'cancel' } };
  const listingText = String(text || '').replace(/\b(news|story|refresh|scan|search)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (has(c, /\b(all|stale)\b/) || (!listingText && !slots.pronoun && !slots.ids.listing && !slots.slugs.length)) return { args: { action: 'start', limit: slots.limit || 20 } };
  const l = resolveListing({ slots, ctx, text: listingText, c });
  if (!l.ok) return askFor(l, 'listing') || { ask: l.ask, options: l.options, entity: 'listing' };
  return { args: { action: 'one', id_or_slug: l.value }, listing: l.row };
});
rule('create_news_story', (c) => has(c, /\b(news|story)\b/) && has(c, /\b(create|post)\b/), ({ slots, ctx, text, c }) => {
  const title = slots.title || slots.quoted[0];
  const l = resolveListing({ slots: { ...slots, quoted: slots.quoted.filter((x) => x !== title) }, ctx, text, c });
  if (!l.ok) return askFor(l, 'listing') || { ask: l.ask, options: l.options, entity: 'listing' };
  if (!title) return { ask: `What is the headline for the ${l.row.name} story?`, entity: 'title', partial: { id_or_slug: l.value, url: slots.urls[0] || '', published_at: slots.date || '' } };
  return { args: { id_or_slug: l.value, title, url: slots.urls[0] || '', published_at: slots.date || '' }, listing: l.row };
});

/* ---- blog ---- */
rule('delete_blog_post', (c) => has(c, /\bpost\b/) && has(c, /\bdelete\b/), ({ slots, text }) => { if (slots.ids.post || slots.numbers.length === 1) return { args: { id_or_slug: String(slots.ids.post || slots.numbers[0]) } }; if (slots.slugs[0]) return { args: { id_or_slug: slots.slugs[0] } }; const rows = q.postsByText(slots.quoted[0] || text); if (rows.length === 1) return { args: { id_or_slug: String(rows[0].id) } }; return { ask: 'Which post? Give me its id, slug or title.', entity: 'post', options: rows.map((p) => ({ label: `${p.title} (#${p.id}, ${p.status})`, value: String(p.id) })) }; });
rule('edit_blog_post', (c) => has(c, /\bpost\b/) && has(c, /\b(set|rename)\b/) && !has(c, /\b(publish|approve|unpublish|hide|draft)\b/), ({ slots, text }) => {
  const kv = slots.keyval || {};
  const fields = {};
  for (const k of ['title', 'excerpt', 'body', 'slug', 'status']) if (kv[k]) fields[k] = kv[k];
  if (slots.title && !fields.title) fields.title = slots.title;
  const id = slots.ids.post || slots.numbers[0];
  if (!id) { const rows = q.postsByText(text); if (rows.length === 1) return Object.keys(fields).length ? { args: { id: rows[0].id, ...fields } } : { ask: 'What should change on that post? e.g. title="New title"', entity: 'fields', partial: { id: rows[0].id } }; return { ask: 'Which post (id)?', entity: 'post' }; }
  if (!Object.keys(fields).length) return { ask: 'What should change? e.g. title="…", excerpt="…", slug=…', entity: 'fields', partial: { id } };
  return { args: { id, ...fields } };
});
rule('toggle_blog_post', (c) => has(c, /\bpost\b/) && has(c, /\b(approve|publish|unpublish|hide|draft|toggle|published)\b/), ({ slots, text }) => { if (slots.ids.post || slots.numbers.length === 1) return { args: { id_or_slug: String(slots.ids.post || slots.numbers[0]) } }; if (slots.slugs[0]) return { args: { id_or_slug: slots.slugs[0] } }; const rows = q.postsByText(slots.quoted[0] || text); if (rows.length === 1) return { args: { id_or_slug: String(rows[0].id) } }; return { ask: 'Which post? Give me its id, slug or title.', entity: 'post', options: rows.map((p) => ({ label: `${p.title} (#${p.id}, ${p.status})`, value: String(p.id) })) }; });
rule('create_blog_post', (c) => has(c, /\bpost\b/) && has(c, /\b(create|draft)\b/), ({ slots, c }) => {
  const kv = slots.keyval || {};
  const title = kv.title || slots.title || slots.quoted[0];
  const body = kv.body || slots.said || slots.quoted[1];
  if (!title || !body) return { ask: 'I need a title and a body — e.g. create blog post title="Why verify" body="…"', entity: 'fields', partial: { title, body, status: has(c, /\bpublish\b/) ? 'published' : 'draft' } };
  return { args: { title, body, excerpt: kv.excerpt || '', status: has(c, /\bpublished\b|\bpublish\b/) && !has(c, /\bdraft\b/) ? 'published' : 'draft' } };
});

/* ---- careers ---- */
rule('delete_career', (c) => has(c, /\bcareer\b/) && has(c, /\bdelete\b/), ({ slots, text }) => { const id = slots.ids.career || slots.numbers[0]; if (id) return { args: { id } }; const rows = q.careersLike(slots.quoted[0] || text); if (rows.length === 1) return { args: { id: rows[0].id } }; return { ask: 'Which role (id or title)?', entity: 'career', options: rows.map((r) => ({ label: `${r.title} (#${r.id}, ${r.status})`, value: r.id })) }; });
rule('toggle_career', (c) => has(c, /\bcareer\b/) && has(c, /\b(closed|open|toggle|on|off|reopen|hide)\b/) && !has(c, /\b(show|count)\b/), ({ slots, text }) => { const id = slots.ids.career || slots.numbers[0]; if (id) return { args: { id } }; const rows = q.careersLike(slots.quoted[0] || text); if (rows.length === 1) return { args: { id: rows[0].id } }; return { ask: 'Which role (id or title)?', entity: 'career', options: rows.map((r) => ({ label: `${r.title} (#${r.id}, ${r.status})`, value: r.id })) }; });
rule('edit_career', (c) => has(c, /\bcareer\b/) && has(c, /\b(set|rename)\b/), ({ slots }) => { const kv = slots.keyval || {}; const id = slots.ids.career || slots.numbers[0]; const fields = {}; for (const k of ['title', 'role_type', 'location', 'description', 'requirements', 'apply_email', 'status']) if (kv[k]) fields[k] = kv[k]; if (slots.title) fields.title = slots.title; if (!id) return { ask: 'Which role (id)?', entity: 'career' }; if (!Object.keys(fields).length) return { ask: 'What should change? e.g. location=Nairobi title="…"', entity: 'fields', partial: { id } }; return { args: { id, ...fields } }; });
rule('create_career', (c) => has(c, /\bcareer\b/) && has(c, /\b(create|post|hiring)\b/), ({ slots }) => {
  const kv = slots.keyval || {};
  const args = { title: kv.title || slots.title || slots.quoted[0], location: kv.location, description: kv.description, requirements: kv.requirements, role_type: kv.role_type || slots.roleType || 'Full-time', apply_email: kv.apply_email || slots.emails[0] || '' };
  const missing = ['title', 'location', 'description', 'requirements'].filter((k) => !args[k]);
  if (missing.length) return { ask: `To post a role I still need: ${missing.join(', ')}. Send them as key=value pairs (quote values with spaces).`, entity: 'fields', partial: args };
  return { args };
});

/* ---- promos / ads ---- */
rule('delete_promo', (c) => has(c, /\bpromo\b/) && has(c, /\bdelete\b/), ({ slots, text }) => { const id = slots.ids.promo || slots.numbers[0]; if (id) return { args: { id } }; const code = slots.quoted[0] || (text || '').split(' ').find((w) => /^[A-Z0-9-]{3,}$/i.test(w)); const p = code && q.promoByCode(code); if (p) return { args: { id: p.id } }; return { ask: 'Which promo (code or id)?', entity: 'promo' }; });
rule('toggle_promo', (c) => has(c, /\bpromo\b/) && has(c, /\b(on|off|toggle|pause|resume|approve|hide|disable|enable)\b/) && !has(c, /\bcreate\b/), ({ slots, text }) => { const code = slots.quoted[0] || String(slots.ids.promo || slots.numbers[0] || '') || (text || '').split(' ').find((w) => /^[A-Z0-9-]{3,}$/i.test(w)); if (!code) return { ask: 'Which promo code?', entity: 'promo' }; const args = { code_or_id: code }; if (slots.on !== undefined) args.on = slots.on; return { args }; });
rule('create_promo', (c) => has(c, /\bpromo\b/) && has(c, /\bcreate\b/), ({ slots, text }) => { const code = (slots.keyval && slots.keyval.code) || slots.quoted[0] || (text || '').split(' ').find((w) => /^[A-Z0-9-]{3,}$/.test(w)) || (text || '').split(' ').find((w) => /^[a-z0-9-]{4,}$/i.test(w) && !/^(percent|off|uses|until|expires)$/i.test(w)); const percent = slots.percent || (slots.keyval && Number(slots.keyval.percent)); if (!code || !percent) return { ask: 'Give me a code and a percentage — e.g. “create promo LAUNCH25 25% off, max 100 uses, expires 2026-12-31”.', entity: 'fields', partial: { code, percent } }; const args = { code: code.toUpperCase(), percent }; if (slots.maxUses) args.max_uses = slots.maxUses; if (slots.date) args.expires_at = slots.date; return { args }; });
rule('set_ad_package', (c) => has(c, /\badpackage\b/) && has(c, /\b(create|delete|hide|on|off|toggle|show|approve|disable|enable)\b/) && !has(c, /\b(show|count)\b\s*(all\s*)?adpackage\s*$/), ({ slots, text, c }) => {
  const action = has(c, /\bcreate\b/) ? 'create' : has(c, /\bdelete\b/) ? 'delete' : 'toggle';
  if (action === 'create') {
    const kv = slots.keyval || {};
    const name = kv.name || slots.quoted[0] || slots.named;
    const price = slots.usd !== undefined ? slots.usd : (kv.price ? Number(kv.price) : undefined);
    const days = slots.days || (kv.days ? Number(kv.days) : undefined);
    if (!name || price === undefined || !days) return { ask: 'Give me the package name, USD price and duration — e.g. “create ad package "Homepage Spotlight" $99 for 30 days”.', entity: 'fields', partial: { action, name, price_usd: price, duration_days: days } };
    return { args: { action, name, price_usd: price, duration_days: days, blurb: kv.blurb || '' } };
  }
  const id = slots.ids.package || slots.numbers[0];
  if (id) return { args: { action, id } };
  const rows = q.adsLike(slots.quoted[0] || text);
  if (rows.length === 1) return { args: { action, id: rows[0].id } };
  return { ask: 'Which package (id or name)?', entity: 'package', options: rows.map((r) => ({ label: `${r.name} (#${r.id})`, value: r.id })) };
});

/* ---- email ---- */
rule('email_all_users', (c) => has(c, /\b(email|send)\b/) && has(c, /\ball\b/) && has(c, /\b(user|all)\b/) && !has(c, /\b(newsletter|pro|free|ticket|testmail|passwordreset)\b/), ({ slots, raw }) => {
  const { subject, message } = mailParts(slots, raw);
  if (!subject || !message) return { ask: 'What is the subject and the message? e.g. subject: "Maintenance tonight" message: "We will be offline…"', entity: 'mail', partial: { subject, message, audience: 'all' } };
  return { args: { subject, message } };
});
rule('email_users', (c) => has(c, /\b(email|send)\b/) && !has(c, /\b(ticket|testmail|passwordreset|reply|newsletter digest|2fa|smtp|from|backup|invoice)\b/) && !has(c, /\bnewsletter\b/), ({ slots, ctx, text, raw, c }) => {
  const { subject, message } = mailParts(slots, raw);
  let audience = slots.audience;
  if (!audience) {
    if (slots.emails.length) audience = slots.emails[0];
    else if (has(c, /\b(admin|me|myself)\b/)) audience = adminEmail();
    else if (has(c, /\bnewsletter\b|\bsubscriber\b/)) audience = 'newsletter';
    else if (has(c, /\bpro\b/)) audience = 'pro';
    else if (has(c, /\bfree\b/)) audience = 'free';
    else {
      const u = resolveUser({ slots, ctx, text: text.split(' ').slice(0, 3).join(' '), allowContext: true });
      if (u.ok) audience = u.value;
    }
  }
  if (!audience) return { ask: `Who should get it — a member (email), the admin, or the pro / free / newsletter / all audience?`, entity: 'audience', partial: { subject, message } };
  if (!subject || !message) return { ask: `What is the subject and the message for ${audience}? e.g. subject: "Hello" message: "…"`, entity: 'mail', partial: { audience, subject, message } };
  return { args: { audience, subject, message } };
});
function mailParts(slots, raw) {
  const kv = slots.keyval || {};
  let subject = slots.subject || kv.subject;
  let message = kv.message || kv.body || slots.said;
  if (!subject && slots.quoted.length >= 2) { subject = slots.quoted[0]; message = message || slots.quoted[1]; }
  else if (!subject && slots.quoted.length === 1 && message && message !== slots.quoted[0]) subject = slots.quoted[0];
  else if (!message && slots.quoted.length === 1 && subject && subject !== slots.quoted[0]) message = slots.quoted[0];
  const about = raw.match(/\babout\s+"([^"]+)"|\babout\s+([^,;:]+?)(?:\s+saying|\s+message|:|$)/i);
  if (!subject && about) subject = (about[1] || about[2]).trim();
  return { subject, message };
}

/* ---- site ops ---- */
rule('set_maintenance_mode', (c) => has(c, /\bmaintenance\b/) && !has(c, /\b(show|count)\b/) && (has(c, /\bmaintenance (on|off)\b/) || !has(c, /\bmaintenance\s*$/)), ({ slots, c }) => ({ args: { on: has(c, /\bmaintenance on\b/) ? true : has(c, /\bmaintenance off\b/) ? false : slots.on !== false, ...(slots.said ? { message: slots.said } : {}), ...(slots.title ? { title: slots.title } : {}) } }));
rule('set_auto_approve', (c) => has(c, /\bauto\b/) && has(c, /\bapprove\b/) && !has(c, /\bassistant\b|\bmoderation\b/), ({ slots }) => ({ args: { on: slots.on !== false } }));
rule('set_ai_moderation', (c) => has(c, /\b(moderation|screener|screening)\b/) && has(c, /\b(on|off|set)\b/) && !has(c, /\bnews\b/), ({ slots }) => ({ args: { on: slots.on !== false } }));
rule('set_google_indexing', (c) => has(c, /\bgoogleindex\b/) && has(c, /\b(on|off)\b/) && !has(c, /\b(run|start|delete|credentials)\b/), ({ slots }) => ({ args: { on: slots.on !== false } }));
rule('remove_google_credentials', (c) => has(c, /\b(google|googleindex)\b/) && has(c, /\bcredentials\b/) && has(c, /\bdelete\b/));
rule('run_google_indexing_batch', (c) => has(c, /\bgoogleindex\b/) && has(c, /\b(run|start|submit|ping)\b/), ({ slots }) => ({ args: { limit: slots.limit || 200 } }));
rule('set_indexing', (c) => has(c, /\b(indexing|indexnow)\b/) && has(c, /\b(on|off)\b/) && !has(c, /\bgoogle/), ({ slots }) => ({ args: { on: slots.on !== false } }));
rule('ping_indexnow', (c) => has(c, /\b(ping|indexnow|indexing)\b/) && (has(c, /\bping\b/) || has(c, /\bsubmit\b/)) && !has(c, /\bgoogle/), ({ slots, ctx, text, c }) => {
  const paths = slots.paths.slice();
  if (!paths.length) { const l = resolveListing({ slots, ctx, text, c }); if (l.ok) paths.push(`/listing/${l.row.slug}`); }
  if (!paths.length) return { ask: 'Which paths should I submit? e.g. /listing/acme or /directory/c/technology', entity: 'paths' };
  return { args: { paths } };
});
rule('clear_indexing_logs', (c) => has(c, /\bindexing\b/) && has(c, /\b(log|logs)\b/) && has(c, /\b(delete|clear|purge|empty)\b/), ({ slots }) => ({ args: slots.numbers.length ? { id: slots.numbers[0] } : { all: true } }));
rule('set_upkeep_settings', (c) => has(c, /\bupkeep\b/) && has(c, /\b(on|off|set|limit|interval|every|hour|hours|day|age|max)\b/) && !has(c, /\b(run|start|now)\b/), ({ slots, c }) => {
  const kv0 = slots.keyval || {};
  if (has(c, /\b(interval|every|hour|hours)\b/) && !has(c, /\b(on|off|limit|age)\b/)) return { none: 'The upkeep sweep runs hourly on a fixed schedule — you can switch it on/off, or set tech_limit / news_limit / news_max_age_days per sweep.' };
  const age = c.match(/\b(?:news )?(?:max )?age\s+(\d{1,4})\s*(?:day|days)?\b/);
  if (age) kv0.news_max_age_days = age[1];
  slots.keyval = kv0;
  const args = {};
  if (has(c, /\btech\b/)) args.tech_on = slots.on !== false;
  else if (has(c, /\bnews\b/)) args.news_on = slots.on !== false;
  else if (slots.on !== undefined) args.on = slots.on;
  const kv = slots.keyval || {};
  for (const k of ['tech_limit', 'news_limit', 'news_max_age_days']) if (kv[k]) args[k] = Number(kv[k]);
  return Object.keys(args).length ? { args } : { ask: 'Upkeep on or off? You can also set tech_limit=…, news_limit=…', entity: 'fields' };
});
rule('run_upkeep_sweep', (c) => has(c, /\bupkeep\b/) && has(c, /\b(run|start|now|sweep|refresh)\b/), ({ c }) => ({ args: { force: has(c, /\b(force|anyway|even)\b/) } }));
rule('send_newsletter_digest', (c) => has(c, /\bnewsletter\b/) && has(c, /\b(send|run|now|start)\b/) && !has(c, /\bcadence\b/));
rule('set_newsletter_cadence', (c) => has(c, /\bnewsletter\b|\bcadence\b/) && (has(c, /\b(daily|weekly|monthly|cadence)\b/) || has(c, /\bset\b/)), ({ slots }) => slots.cadence ? { args: { cadence: slots.cadence } } : { ask: 'Daily, weekly or monthly?', entity: 'cadence' });
rule('block_ip', (c) => has(c, /\b(ip|ipaddr)\b/) && has(c, /\b(block|allow|create|suspend|ban)\b/) && !has(c, /\bdelete\b/), ({ slots, c }) => slots.ips.length ? { args: { ip: slots.ips[0], kind: has(c, /\ballow\b/) ? 'allow' : 'block', note: slots.said || '' } } : { ask: 'Which IP address?', entity: 'ip', partial: { kind: has(c, /\ballow\b/) ? 'allow' : 'block' } });
rule('block_domain', (c) => has(c, /\b(domain|domainname)\b/) && has(c, /\b(block|allow|suspend|ban)\b|\bcreate domain\b/) && !has(c, /\b(delete|term|moderation|modrules|trust|smtp|host|mailaccount|listing|url)\b/), ({ slots, c }) => slots.domains.length ? { args: { domain: slots.domains[0], kind: has(c, /\ballow\b/) ? 'allow' : 'block', note: slots.said || '' } } : { ask: 'Which email domain?', entity: 'domain', partial: { kind: has(c, /\ballow\b/) ? 'allow' : 'block' } });
rule('delete_spam_rule', (c) => has(c, /\b(ip|ipaddr|domain|domainname|protection|rule)\b/) && has(c, /\b(delete|unblock)\b/) && !has(c, /\b(create|block)\b/), ({ slots, c }) => {
  const list = has(c, /\bdomain\b/) ? 'domain' : 'ip';
  const id = slots.ids.rule || slots.numbers[0];
  if (id) return { args: { list, id } };
  /* by value: find the rule id */
  const val = list === 'ip' ? slots.ips[0] : slots.domains[0];
  if (val) { const row = db.prepare(`SELECT id FROM spam_${list} WHERE value=?`).get(val); if (row) return { args: { list, id: row.id } }; return { none: `There is no ${list} rule for ${val}.` }; }
  return { ask: `Which ${list} rule? Give me the value or the rule id (see settings).`, entity: 'rule', partial: { list } };
});
rule('set_rate_limits', (c) => has(c, /\bratelimit\b|\blimit\b/) && has(c, /\b(set|ratelimit)\b/) && !has(c, /\bupkeep\b/), ({ slots }) => {
  const kv = slots.keyval || {};
  const args = {};
  for (const k of ['login', 'register', 'listing', 'claim', 'newsletter', 'status', 'search', 'scrape', 'api_read_rpm', 'api_write_rpm']) if (kv[k]) args[k] = Number(kv[k]);
  return Object.keys(args).length ? { args } : { ask: 'Which limit? e.g. set rate limit login=10 register=5 api_read_rpm=120', entity: 'fields' };
});
rule('create_incident', (c) => has(c, /\bincident\b/) && has(c, /\b(create|open|start|report|raise|declare)\b/) && !has(c, /\b(show|count)\b/), ({ slots, c }) => {
  const title = slots.title || slots.quoted[0] || slots.said;
  if (!title) return { ask: 'What is the incident title?', entity: 'title', partial: { severity: slots.severity || 'minor', status: 'investigating' } };
  return { args: { title, severity: slots.severity || 'minor', status: (slots.statuses || []).find((s) => ['investigating', 'identified', 'monitoring'].includes(s)) || 'investigating', description: slots.said && slots.said !== title ? slots.said : '' } };
});
rule('resolve_incident', (c) => has(c, /\bincident\b/) && has(c, /\b(solved|closed)\b/) && !has(c, /\bupdate\b/), ({ slots, ctx }) => {
  const id = slots.ids.incident || slots.numbers[0] || (ctx.incident && ctx.incident.id);
  if (id) return { args: { id } };
  const open = q.incidentsOpen();
  if (open.length === 1) return { args: { id: open[0].id } };
  return { ask: 'Which incident?', entity: 'incident', options: open.map((i) => ({ label: `${i.title} (#${i.id}, ${i.status})`, value: i.id })) };
});
rule('delete_incident', (c) => has(c, /\bincident\b/) && has(c, /\bdelete\b/), (b) => { const r = resolveTypedId('incident', b); return r.ok ? { args: { id: r.value } } : { ask: r.ask, entity: 'incident' }; });
rule('update_incident', (c) => has(c, /\bincident\b/) && has(c, /\b(set|post|reply|note|identified|monitoring|investigating)\b/), ({ slots, ctx }) => {
  const id = slots.ids.incident || slots.numbers[0] || (ctx.incident && ctx.incident.id) || ((q.incidentsOpen().length === 1) ? q.incidentsOpen()[0].id : null);
  if (!id) return { ask: 'Which incident?', entity: 'incident', options: q.incidentsOpen().map((i) => ({ label: `${i.title} (#${i.id})`, value: i.id })) };
  const message = slots.said || slots.quoted[0];
  const status = (slots.statuses || []).find((s) => ['investigating', 'identified', 'monitoring', 'resolved'].includes(s));
  if (!message) return { ask: `What is the update on incident #${id}?`, entity: 'message', partial: { id, status } };
  return { args: { id, message, ...(status ? { status } : {}) } };
});
rule('run_status_check', (c) => has(c, /\b(statuspage|monitor|component)\b/) && has(c, /\b(run|refresh|check|probe|now)\b/) && !has(c, /\breset\b/));
rule('reset_status_component', (c) => has(c, /\bcomponent\b/) && has(c, /\b(reset|approve|solved|operational)\b/), ({ slots, text }) => { const id = slots.ids.component || slots.numbers[0]; if (id) return { args: { id } }; const slug = slots.slugs[0] || (text || '').split(' ')[0]; if (slug) return { args: { slug } }; return { ask: 'Which component (slug or id)?', entity: 'component' }; });
rule('set_weekly_status_report', (c) => has(c, /\bstatusreport\b/), ({ slots }) => ({ args: { on: slots.on !== false } }));
rule('set_site_setting', (c) => has(c, /\bset\b/) && has(c, /\b(settings|flag|option)\b/) && !!(c.match(/\b(auto_approve|indexing_enabled|google_indexing_enabled|maintenance_on|news_review_auto|status_weekly_report|newsletter_cadence|smtp_from)\b/)), ({ slots, c }) => { const key = c.match(/\b(auto_approve|indexing_enabled|google_indexing_enabled|maintenance_on|news_review_auto|status_weekly_report|newsletter_cadence|smtp_from)\b/)[1]; const kv = slots.keyval || {}; const value = kv[key] !== undefined ? kv[key] : (slots.on !== undefined ? (slots.on ? '1' : '0') : slots.cadence || slots.quoted[0]); if (value === undefined) return { ask: `Set ${key} to what?`, entity: 'value', partial: { key } }; return { args: { key, value: String(value) } }; });
rule('mark_admin_notifications_read', (c) => has(c, /\bmarkread\b/) || (has(c, /\binbox\b/) && has(c, /\b(read|clear)\b/) && has(c, /\ball\b/)));
rule('manage_notification', (c) => has(c, /\binbox\b/) && has(c, /\b(archive|restore|delete|read|markread|mark)\b/) && !has(c, /\ball\b/) && /\b\d+\b/.test(c), ({ slots, c }) => { const id = slots.ids.notification || slots.numbers[0]; const action = has(c, /\barchive\b/) ? 'archive' : has(c, /\brestore\b/) ? 'restore' : has(c, /\bdelete\b/) ? 'delete' : 'read'; if (!id) return { ask: `Which notification id should I ${action}?`, entity: 'notification', partial: { action } }; const args = { action, id }; if (action === 'archive') args.duration = has(c, /\bmonth\b/) ? 'month' : 'week'; return { args }; });
rule('notify_admin_inbox', (c) => has(c, /\b(note|inbox)\b/) && has(c, /\b(create|leave|remind|drop|write|send)\b/) && !has(c, /\b(email|user)\b/), ({ slots, raw }) => { const title = slots.title || slots.quoted[0] || slots.said || raw.replace(/^.*?\b(?:note|reminder|remind me|inbox)\b\s*(?:that|to|:)?\s*/i, '').trim(); if (!title) return { ask: 'What should the note say?', entity: 'title' }; return { args: { title: title.slice(0, 120), body: title.length > 120 ? title : '', kind: 'info' } }; });
rule('export_backup', (c) => has(c, /\bbackup\b/) && !has(c, /\b(show|restore|import)\b/));
rule('set_admin_2fa_email', (c) => has(c, /\b2fa\b/) && has(c, /\b(set|email|send|move|use)\b/), ({ slots }) => slots.emails.length ? { args: { email: slots.emails[0] } } : { ask: 'Which address should receive the admin sign-in codes?', entity: 'email' });
function configuredMailChoices() {
  try { return mailer.providerChoices(); } catch { return []; }
}
rule('send_test_mail', (c) => has(c, /\btestmail\b/) || (has(c, /\bsmtp\b/) && has(c, /\btest\b/)), ({ slots, raw }) => {
  const args = slots.emails.length ? { to: slots.emails[0] } : {};
  if (slots.provider) args.provider = slots.provider;
  /* If failover has more than one live hop, do not silently pick a relay:
   * ask the admin which one to prove. With zero/one hops, automatic (or the
   * only available hop) is unambiguous and remains one turn. */
  if (!args.provider && configuredMailChoices().length > 1) {
    return {
      ask: 'Which configured mail provider should receive the test? Choosing one tests that provider directly; “automatic failover” tests the normal chain.',
      entity: 'mail_provider',
      partial: args,
      options: configuredMailChoices().map((p) => ({ label: p.label, value: p.key })),
    };
  }
  return { args };
});
rule('set_mail_from', (c) => has(c, /\bfrom\b/) && has(c, /\b(email|smtp|set)\b/) && has(c, /\b(set|address|use)\b/) && !has(c, /\b(user|listing|ticket)\b/), ({ slots, quotedRaw }) => { const from = slots.quoted[0] || (slots.emails[0] ? slots.emails[0] : null); return from ? { args: { from } } : { ask: 'What should the From address be? e.g. "FirmLedger <no-reply@firmledger.co.ke>"', entity: 'from' }; });
rule('set_mail_account', (c) => has(c, /\bsmtp\b/) && has(c, /\b(create|delete|on|off|toggle|pause|disable|enable)\b/) && !has(c, /\b(primary|host)\b.*\bset\b/), ({ slots, c }) => {
  const action = has(c, /\bcreate\b/) ? 'add' : has(c, /\bdelete\b/) ? 'delete' : 'toggle';
  if (action !== 'add') { const id = slots.ids.account || slots.numbers[0]; return id ? { args: { action, id } } : { ask: `Which SMTP account id should I ${action}? (get_settings lists them)`, entity: 'account', partial: { action } }; }
  const kv = slots.keyval || {};
  const args = { action, provider: kv.provider || 'custom', label: kv.label || slots.quoted[0] || '', host: kv.host || slots.domains[0] || '', port: kv.port ? Number(kv.port) : 587, username: kv.username || kv.user || '', password: kv.password || kv.pass || '', daily_limit: kv.daily_limit ? Number(kv.daily_limit) : 0 };
  if (!args.host || !args.username || !args.password) return { ask: 'Give me host=… username=… password=… (plus optional provider=, port=, label=, daily_limit=).', entity: 'fields', partial: args };
  return { args };
});
rule('set_smtp_settings', (c) => has(c, /\bsmtp\b/) && has(c, /\b(set|primary|host)\b/), ({ slots }) => { const kv = slots.keyval || {}; if (!kv.host) return { ask: 'Give me host=… port=… username=… password=… secure=true|false', entity: 'fields' }; return { args: { host: kv.host, port: kv.port ? Number(kv.port) : 587, username: kv.username || kv.user || '', password: kv.password || kv.pass || '', secure: /^(1|true|yes)$/i.test(String(kv.secure || '')), from: kv.from || '' } }; });
rule('set_paypal_settings', (c) => has(c, /\bpaypal\b/) && has(c, /\b(set|live|sandbox|mode|credentials|switch|use)\b/), ({ slots, c }) => { const kv = slots.keyval || {}; const args = {}; if (kv.client_id) args.client_id = kv.client_id; if (kv.client_secret) args.client_secret = kv.client_secret; if (kv.mode) args.mode = kv.mode; else if (has(c, /\blive\b/)) args.mode = 'live'; else if (has(c, /\bsandbox\b/)) args.mode = 'sandbox'; return Object.keys(args).length ? { args } : { ask: 'Set PayPal to live or sandbox, or give client_id=… client_secret=…', entity: 'fields' }; });

/* ---- catch-all guesses ---- */
rule('get_listing', (c) => true, ({ slots, ctx, text, c }) => {
  /* marked as a guess so an open question is not abandoned for it */
  /* A bare name / id / slug with no verb: look it up. */
  if (slots.emails.length) { const u = resolveUser({ slots, ctx, text: '' , allowContext: false }); if (u.ok) return { tool: 'get_user', args: { user: u.value }, user: u.row }; return { none: `No member has the email ${slots.emails[0]}.` }; }
  if (slots.ref) { const t = resolveTicket({ slots, ctx, text: '', allowContext: false }); if (t.ok) return { tool: 'get_ticket', args: { id_or_ref: t.value }, ticket: t.row }; return { none: `There is no ticket ${slots.ref}.` }; }
  if (!text && !slots.slugs.length && !slots.numbers.length && !slots.quoted.length && !slots.hashId) return { skip: true };
  const l = resolveListing({ slots, ctx, text, c, allowContext: false });
  if (l.ok) return { args: { id_or_slug: l.value }, listing: l.row };
  if (l.options) return { ask: l.ask, options: l.options, entity: 'listing' };
  const u = resolveUser({ slots, ctx, text, allowContext: false });
  if (u.ok) return { tool: 'get_user', args: { user: u.value }, user: u.row };
  if (u.options) return { ask: u.ask, options: u.options, entity: 'user' };
  return { skip: true };
}, { guess: true });

/* Last-resort recovery: an unfamiliar phrase is still a safe, read-only
 * site-wide search. This means “where did that email/name/word go?” never
 * dead-ends, while the guess flag and the no-match response make it explicit
 * that nothing was silently treated as a write command. */
rule('search_admin', (c, b) => {
  const text = String(b && b.text || '').trim();
  return text.length >= 2 && !/^\s*(yes|no|cancel|help|hello|thanks|ok|okay)\s*$/i.test(text);
}, ({ text, slots }) => {
  const query = String(text || '').trim() || slots.quoted[0] || slots.emails[0] || slots.domains[0];
  return query ? { args: { q: query } } : { skip: true };
}, { guess: true });

/* ------------------------------------------------------------------ */
/* 6. Parse one command                                                */
/* ------------------------------------------------------------------ */

/**
 * Split "approve 12 and feature it, then email the owner" into commands.
 * A segment only counts as a separate command when it starts with a verb.
 */
const VERB_START = /^\s*(show|count|approve|reject|delete|feature|unfeature|sponsor|unsponsor|suspend|unsuspend|grant|revoke|set|rename|create|send|email|reply|solved|closed|reopen|on|off|start|run|refresh|block|allow|make|assign|transfer|unclaim|markread|maintenance|open|post|draft|cancel|stop|help|reset|backup|ping|archive|restore|hide|unpublish|verify|dismiss|resolve|passwordreset|testmail)\b/;
function splitCommands(raw) {
  /* never split inside quotes or after a payload marker (saying: / message: / body:) */
  const str = String(raw);
  const guard = [];
  let masked = str.replace(/"[^"]*"|'[^']*'|“[^”]*”/g, (m) => { guard.push(m); return `\u0000${guard.length - 1}\u0000`; });
  const payload = masked.match(/\b(?:saying|says|message|body|description|reason|note|text)\s*:\s*/i);
  let tail = '';
  if (payload) { tail = masked.slice(payload.index); masked = masked.slice(0, payload.index); }
  const unmask = (x) => x.replace(/\u0000(\d+)\u0000/g, (_, i) => guard[Number(i)]);
  const out0 = splitPlain(masked).map(unmask);
  if (tail) { if (out0.length) out0[out0.length - 1] += ' ' + unmask(tail); else out0.push(unmask(tail)); }
  return out0;
}
function splitPlain(raw) {
  const parts = String(raw).split(/\s*(?:;|\n|\bthen\b|\band then\b|\bafter that\b|\bafterwards\b|\bnext\b(?=\s+\w+)|\band also\b|\balso\b)\s*/i).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    /* try a further split on " and " when the right side begins with a verb */
    const bits = p.split(/\s+and\s+/i);
    if (bits.length > 1) {
      let acc = bits[0];
      for (let i = 1; i < bits.length; i++) {
        const cand = canon(bits[i]);
        if (VERB_START.test(cand) && !/^\s*(on|off)\b/.test(cand)) { out.push(acc); acc = bits[i]; }
        else acc += ' and ' + bits[i];
      }
      out.push(acc);
    } else out.push(p);
  }
  return out.length ? out : [String(raw)];
}

/** Parse one command into a candidate. Never throws. */
/** The part of the sentence that carries the command (quoted strings and
 *  free-text payloads such as “saying: …” removed so their words cannot be
 *  mistaken for verbs). */
function commandPart(raw, slots) {
  let t = lower(raw);
  for (const qd of slots.quoted) t = t.replace(qd, ' X ');
  if (slots.said && slots.said.length > 3) t = t.replace(slots.said, ' ');
  /* trailing justification ("… because it is a duplicate") is kept as the
     reason slot, not parsed as part of the command */
  const why = t.match(/\s+(?:because|since|due to|reason:?|cos|coz)\s+(.+)$/i);
  if (why) { slots.reason = why[1].trim(); t = t.slice(0, why.index); }
  return t;
}

function parseCommand(raw, ctx = {}) {
  const slots = extractSlots(raw);
  const c = canon(commandPart(raw, slots));
  const text = freeText(raw, slots);
  const b = { raw: lower(raw), c, slots, text, ctx };
  for (const r of R) {
    let ok = false;
    try { ok = r.test(c, b); } catch { ok = false; }
    if (!ok) continue;
    let out;
    try { out = r.build(b); } catch (e) { out = { none: `I could not work that out: ${e.message}` }; }
    if (!out || out.skip) continue;
    const tool = out.tool || r.tool;
    if (out.ask) return { type: 'ask', tool, ask: out.ask, options: out.options || [], entity: out.entity || '', partial: out.partial || {}, c, slots, text };
    if (out.none) return { type: 'none', tool, text: out.none, c, slots };
    return { type: 'plan', tool, args: out.args || {}, focus: out.focus, listing: out.listing, user: out.user, ticket: out.ticket, guess: Boolean(r.guess), c, slots, text };
  }
  return { type: 'unknown', c, slots, text };
}

/* ------------------------------------------------------------------ */
/* 7. Answering follow-ups (questions we asked)                        */
/* ------------------------------------------------------------------ */

const ORDINALS = { first: 1, '1st': 1, one: 1, second: 2, '2nd': 2, two: 2, third: 3, '3rd': 3, three: 3, fourth: 4, '4th': 4, four: 4, fifth: 5, '5th': 5, five: 5, last: -1 };

/**
 * ctx.ask = { tool, entity, partial, options:[{label,value}], slotKey }
 * Returns { resolved: {tool,args} } | { ask: {...} } | null when the message is
 * clearly a fresh command instead of an answer.
 */
function answerAsk(raw, ask, ctx) {
  const low = lower(raw).toLowerCase();
  const slots = extractSlots(raw);
  const c = canon(raw);
  if (/^\s*(no|cancel|stop|skip|forget it|never mind|nevermind)\s*[.!]?\s*$/i.test(low)) return { cancelled: true };
  /* a fresh command with its own verb + entity beats the pending question */
  if (VERB_START.test(c) && c.trim().split(' ').length > 2 && ask.entity !== 'message' && ask.entity !== 'mail' && ask.entity !== 'fields' && ask.entity !== 'title') return null;
  if (ask.entity === 'fields' && VERB_START.test(c) && !slots.keyval && slots.usd === undefined && !slots.days && !slots.percent && !slots.quoted.length && c.trim().split(' ').length > 2) return null;

  const t = tools.getTool(ask.tool);
  const params = (t && t.parameters && t.parameters.properties) || {};
  const pick = (value, row) => {
    const args = { ...(ask.partial || {}) };
    const key = ask.slotKey || slotKeyFor(ask.tool, ask.entity, params);
    if (key) args[key] = value;
    return { resolved: { tool: ask.tool, args, row, entity: ask.entity } };
  };

  if (ask.options && ask.options.length) {
    const n = low.match(/^\s*#?(\d{1,2})\s*[.)]?\s*$/);
    const ordWord = low.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\b/) || low.match(/^\s*(?:the\s+)?(one|two|three|four|five)\s*$/);
    let idx = n ? Number(n[1]) : (ordWord ? ORDINALS[ordWord[1]] : 0);
    if (idx === -1) idx = ask.options.length;
    if (idx >= 1 && idx <= ask.options.length) return pick(ask.options[idx - 1].value, ask.options[idx - 1].row);
    /* by id or by label text */
    const byId = ask.options.find((o) => String(o.value) === String(slots.hashId || slots.numbers[0]) || (o.row && String(o.row.id) === String(slots.hashId || slots.numbers[0])));
    if (byId) return pick(byId.value, byId.row);
    const byText = ask.options.filter((o) => o.label.toLowerCase().includes(low.replace(/^the\s+/, '').trim()));
    if (byText.length === 1) return pick(byText[0].value, byText[0].row);
    if (slots.emails[0]) { const byMail = ask.options.find((o) => o.label.toLowerCase().includes(slots.emails[0])); if (byMail) return pick(byMail.value, byMail.row); }
    return { ask: { ...ask, ask: `Pick one by number (1–${ask.options.length}) or id:\n${ask.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n')}` } };
  }

  switch (ask.entity) {
    case 'listing': { const r = resolveListing({ slots, ctx, text: freeText(raw, slots) || low, c, allowContext: false }); if (r.ok) return pick(r.value, r.row); if (r.options) return { ask: { ...ask, ask: r.ask, options: r.options } }; return { ask: { ...ask, ask: r.none || 'I still could not find that listing — try its id or slug.' } }; }
    case 'user': { const r = resolveUser({ slots, ctx, text: freeText(raw, slots) || low, allowContext: false }); if (r.ok) return pick(r.value, r.row); if (r.options) return { ask: { ...ask, ask: r.ask, options: r.options } }; return { ask: { ...ask, ask: r.none || 'I still could not find that member — try their email.' } }; }
    case 'ticket': { const r = resolveTicket({ slots, ctx, text: freeText(raw, slots) || low, allowContext: false }); if (r.ok) return pick(r.value, r.row); if (r.options) return { ask: { ...ask, ask: r.ask, options: r.options } }; return { ask: { ...ask, ask: r.none || 'I still could not find that ticket — try its FL- reference.' } }; }
    case 'mail_provider': {
      const value = (slots.provider || lower(raw).replace(/^["']|["']$/g, '')).trim();
      if (!value || (!mailer.resolveProviderKey(value) && !/^automatic|failover|any$/i.test(value))) {
        const options = mailer.providerChoices();
        return { ask: { ...ask, options: options.map((o) => ({ label: o.label, value: o.key })), ask: options.length ? 'Pick one of the currently configured providers, or say “automatic failover”.' : 'No configured mail providers are available yet — add one in Settings first.' } };
      }
      return pick(/^automatic|failover|any$/i.test(value) ? '' : mailer.resolveProviderKey(value));
    }
    case 'message': case 'title': case 'name': case 'value': case 'from': case 'paths': case 'email': case 'ip': case 'domain': {
      let v = lower(raw).replace(/^["']|["']$/g, '');
      if (ask.entity === 'email') { if (!slots.emails[0]) return { ask: { ...ask, ask: 'That is not an email address — try again.' } }; v = slots.emails[0]; }
      if (ask.entity === 'ip') { if (!slots.ips[0]) return { ask: { ...ask, ask: 'That does not look like an IP — try again.' } }; v = slots.ips[0]; }
      if (ask.entity === 'domain') { if (!slots.domains[0]) return { ask: { ...ask, ask: 'That does not look like a domain — try again.' } }; v = slots.domains[0]; }
      if (ask.entity === 'paths') v = slots.paths.length ? slots.paths : [v];
      return pick(v);
    }
    case 'status': { const s = (slots.statuses || [])[0] || (c.match(/\b(open|solved|closed)\b/) || [])[1]; return s ? pick(s) : { ask: { ...ask, ask: 'open, solved or closed?' } }; }
    case 'cadence': return slots.cadence ? pick(slots.cadence) : { ask: { ...ask, ask: 'daily, weekly or monthly?' } };
    case 'relType': return slots.relType ? pick(slots.relType) : { ask: { ...ask, ask: 'parent, subsidiary, brand, competitor or partner?' } };
    case 'audience': {
      let a = slots.emails[0];
      if (!a && /\b(all|everyone|everybody|every member|every user|all users|all members)\b/.test(low)) a = 'all';
      if (!a && /\b(admin|me|myself)\b/.test(low)) a = adminEmail();
      if (!a) {
        const m = low.match(/\b(pro|free|newsletter|subscribers?)\b/);
        if (m) a = m[1].startsWith('subscriber') ? 'newsletter' : m[1];
      }
      if (!a) {
        const example = adminEmail();
        return { ask: { ...ask, ask: `I need a recipient — an email address (e.g. ${example}), or say “admin” to email ${example}, or pro / free / newsletter / all.` } };
      }
      const args = { ...(ask.partial || {}), audience: a };
      if (!args.subject || !args.message) return { ask: { tool: ask.tool, entity: 'mail', partial: args, ask: 'What is the subject and message? e.g. subject: "Hello" message: "…"' } };
      return { resolved: { tool: ask.tool, args } };
    }
    case 'mail': {
      const { subject, message } = mailParts(slots, lower(raw));
      const args = { ...(ask.partial || {}) };
      if (subject) args.subject = subject;
      if (message) args.message = message;
      else if (!subject) { if (!args.subject) args.subject = lower(raw).slice(0, 80); else args.message = lower(raw); }
      if (!args.subject) return { ask: { ...ask, partial: args, ask: 'And the subject line?' } };
      if (!args.message) return { ask: { ...ask, partial: args, ask: 'And the message body?' } };
      if (ask.tool === 'email_all_users') delete args.audience;
      return { resolved: { tool: ask.tool, args } };
    }
    case 'fields': {
      const kv = slots.keyval || {};
      const args = { ...(ask.partial || {}) };
      for (const [k, v] of Object.entries(kv)) if (params[k]) args[k] = params[k].type === 'integer' || params[k].type === 'number' ? Number(v) : v;
      for (const qd of slots.quoted) { /* quoted values may be used for key="…" pairs already handled; nothing else */ void qd; }
      if (slots.usd !== undefined && params.price_usd) args.price_usd = slots.usd;
      if (slots.days && params.duration_days) args.duration_days = slots.days;
      if (slots.percent && params.percent) args.percent = slots.percent;
      if (slots.named && params.name && !args.name) args.name = slots.named;
      if (!Object.keys(kv).length && !slots.usd && !slots.days && !slots.percent && !slots.named) {
        /* single missing field: take the whole message */
        const req = ((t && t.parameters && t.parameters.required) || []).filter((k) => args[k] === undefined || args[k] === '');
        if (req.length === 1) args[req[0]] = lower(raw);
        else if (req.length > 1) return { ask: { ...ask, partial: args, ask: `Still missing: ${req.join(', ')}. Send them as key=value pairs.` } };
      }
      const req = ((t && t.parameters && t.parameters.required) || []).filter((k) => args[k] === undefined || args[k] === '' || Number.isNaN(args[k]));
      if (req.length) return { ask: { ...ask, partial: args, ask: `Still missing: ${req.join(', ')}.` } };
      return { resolved: { tool: ask.tool, args } };
    }
    default: {
      const id = slots.hashId || slots.numbers[0];
      if (id) return pick(id);
      return { ask: { ...ask, ask: `I need the ${ask.entity || 'id'} to continue — or say “cancel”.` } };
    }
  }
}

function slotKeyFor(tool, entity, params) {
  const map = {
    listing: ['id_or_slug'], user: ['user', 'owner_email'], ticket: ['id_or_ref'], claim: ['id'], removal: ['id'], story: ['id'], post: ['id_or_slug', 'id'],
    incident: ['id'], promo: ['code_or_id', 'id'], plan: ['id'], package: ['id'], career: ['id'], transfer: ['id'], notification: ['id'], event: ['event_id'],
    relation: ['relation_id'], rule: ['id'], component: ['id'], account: ['id'], message: ['message'], title: ['title'], name: ['name', 'to'], value: ['value'], from: ['from'],
    paths: ['paths'], email: ['email'], mail_provider: ['provider'], ip: ['ip'], domain: ['domain'], status: ['status'], cadence: ['cadence'], relType: ['rel_type'],
  };
  for (const k of map[entity] || []) if (params[k]) return k;
  return null;
}

/* ------------------------------------------------------------------ */
/* 8. Rendering results & phrasing                                     */
/* ------------------------------------------------------------------ */

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const SAY = {
  ran: ['Done.', 'All set.', 'Sorted.', 'Finished.', 'That is done.', 'Done — logged in the audit trail.', 'Applied.', 'Consider it handled.'],
  lookedUp: ['Here is what I found.', 'Got it — here you go.', 'Here you go.', 'Found it.', 'Pulled that up for you.', 'Right, here it is.'],
  nothing: ['Nothing there.', 'Empty — nothing to show.', 'No results.', 'All clear — nothing matches.', 'That list is empty right now.'],
  confirm: ['Before I run it, please confirm:', 'This one changes data, so confirm first:', 'Ready when you are — confirm to run:', 'Just checking — shall I go ahead with:', 'One tap to confirm:'],
  confirmSensitive: ['This is a sensitive action and cannot be undone — please confirm:', 'Careful, this one is permanent. Confirm to run:', 'Double-checking, because this is irreversible:'],
  hello: ['Hello! What would you like to do in the console?', 'Hi — ask me for counts, queues, or actions like “approve acme”.', 'Hey. Listings, members, tickets, billing, settings — what do you need?', 'Morning! Try “briefing” for what needs attention, or just tell me what to do.'],
  thanks: ['Any time.', 'You are welcome.', 'Glad to help — anything else?', 'No problem. Shout if you need more.'],
  cancelled: ['Okay — dropped that. Nothing changed.', 'Cancelled. Nothing was touched.', 'Fine, forget it — nothing happened.'],
  unknown: ['I am not sure what to do with that.', 'That one did not land — let me guess what you meant.', 'Hmm, I did not catch an action in that.'],
  partial: ['Nearly there — I just need one more thing.', 'Almost. One detail missing:', 'Got most of it. Still need:'],
  emptyQueue: ['Queue is clear — nothing pending. 🎉', 'Nothing waiting on you right now.', 'All caught up.'],
};

function fmtDate(v) { return String(v || '').replace('T', ' ').slice(0, 16); }
function money(n, cur = 'USD') { return `${cur} ${(Number(n || 0) / 100).toFixed(2)}`; }
function list(items, fn, max = 15) {
  const out = items.slice(0, max).map((x) => `• ${fn(x)}`);
  if (items.length > max) out.push(`… and ${items.length - max} more`);
  return out.join('\n');
}

const FORMAT = {
  get_listing_stats(r, plan) {
    const f = plan && plan.focus;
    const label = {
      pending: 'listings pending review', approved: 'approved (live) listings', rejected: 'rejected listings', total_listings: 'listings in total', users: 'members', suspended_users: 'suspended members',
      open_tickets: 'open tickets', pending_claims: 'pending claims', pending_removals: 'pending removal requests', open_incidents: 'open incidents', newsletter_subs: 'active newsletter subscribers', featured: 'featured listings', sponsored: 'sponsored listings', claimed: 'claimed listings',
    };
    if (f === 'briefing') {
      const items = [];
      if (r.pending) items.push(`**${r.pending}** listing${r.pending === 1 ? '' : 's'} waiting for review`);
      if (r.open_tickets) items.push(`**${r.open_tickets}** open ticket${r.open_tickets === 1 ? '' : 's'}`);
      if (r.pending_claims) items.push(`**${r.pending_claims}** claim${r.pending_claims === 1 ? '' : 's'} to verify`);
      if (r.pending_removals) items.push(`**${r.pending_removals}** removal request${r.pending_removals === 1 ? '' : 's'}`);
      if (r.open_incidents) items.push(`**${r.open_incidents}** open incident${r.open_incidents === 1 ? '' : 's'}`);
      if (r.maintenance_on) items.push('maintenance mode is **ON**');
      if (!items.length) return `${pick(SAY.emptyQueue)} ${r.total_listings} listings live-ish, ${r.users} members, ${r.newsletter_subs} subscribers.`;
      return `Here is what needs you:\n${items.map((x) => `• ${x}`).join('\n')}\nTell me where to start — e.g. “show pending listings”.`;
    }
    if (f && r[f] !== undefined) return `**${r[f]}** ${label[f] || f}.` + (f === 'pending' && r.pending ? ' Say “show pending listings” to see them, or “approve all pending” to clear the queue.' : '');
    return [
      `**Listings:** ${r.total_listings} total — ${r.pending} pending · ${r.approved} approved · ${r.rejected} rejected · ${r.featured} featured · ${r.sponsored} sponsored · ${r.claimed} claimed`,
      `**Members:** ${r.users} (${r.suspended_users} suspended)`,
      `**Queues:** ${r.open_tickets} open tickets · ${r.pending_claims} pending claims · ${r.pending_removals} removal requests · ${r.open_incidents} open incidents`,
      `**Newsletter:** ${r.newsletter_subs} active subscribers`,
      `**Flags:** maintenance ${r.maintenance_on ? 'ON' : 'off'} · auto-approve ${r.auto_approve ? 'on' : 'off'} · auto-moderation ${r.ai_moderation_on ? 'on' : 'off'}`,
    ].join('\n');
  },
  get_health(r) {
    if (!r || r.error) return `Health check failed: ${r && r.error}`;
    const m = r.memory || {}; const d = r.disk || {}; const db_ = r.db || {}; const mail = r.mail || {};
    const warn = [];
    if (d.usedPct >= 90) warn.push('disk almost full');
    if (m.rss > 900 * 1024 * 1024) warn.push('high memory');
    if (!mail.configured) warn.push('mail not configured');
    if (!r.lastBackupAgo) warn.push('no backup yet');
    return [
      `**Server:** up ${r.uptime || '—'} · Node ${r.node || ''} on ${r.platform || ''} (${r.hostname || 'host'})`,
      `**Memory:** ${m.rssLabel || '—'} RSS · heap ${m.heapLabel || '—'} · system free ${m.systemLabel || '—'}`,
      `**Disk:** ${d.freeLabel || '—'} free of ${d.totalLabel || '—'} (${d.usedPct ?? '?'}% used) · database ${db_.label || '—'}`,
      `**Mail:** ${mail.configured ? 'configured' : 'NOT configured'} · from ${mail.from || '—'} · ${(mail.hops || []).length} hop(s)`,
      `**Last backup:** ${r.lastBackupAgo || 'never'}`,
      warn.length ? `⚠ ${warn.join(' · ')}` : '✓ Nothing looks wrong.',
    ].join('\n');
  },
  search_admin(r) {
    const areas = Array.isArray(r.areas) ? r.areas : [];
    if (!areas.length) return `I am not sure which area that refers to, so I searched everywhere but found no match for **${r.query || 'that search'}**.\nI searched ${r.searched_tables || 'all'} functional areas. Try a broader name, email, id, slug, status or phrase.\n**Try a functional area:** show pending listings · show users · show open tickets · show settings · help`;
    const rowText = (row) => {
      const preferred = ['name', 'title', 'subject', 'email', 'label', 'ref', 'slug', 'key', 'domain', 'url', 'status', 'provider', 'action'];
      const entries = preferred.filter((k) => row[k] !== undefined && row[k] !== null && String(row[k]) !== '').map((k) => `${k}=${String(row[k]).replace(/\s+/g, ' ').slice(0, 110)}`);
      const extra = Object.entries(row).filter(([k, v]) => !preferred.includes(k) && v !== undefined && v !== null && String(v) !== '').slice(0, 3).map(([k, v]) => `${k}=${String(v).replace(/\s+/g, ' ').slice(0, 80)}`);
      return (entries.concat(extra).join(' · ') || 'matching record').replace(/\n/g, ' ');
    };
    const parts = [`**Site-wide search: “${r.query || ''}”**`, `Found **${r.total_matches || 0}** match${r.total_matches === 1 ? '' : 'es'} across ${areas.length} area${areas.length === 1 ? '' : 's'}.`];
    for (const area of areas) {
      parts.push(`**${area.label || area.area}** · ${area.count} match${area.count === 1 ? '' : 'es'}\n${list(area.rows || [], rowText, 8)}\n**Commands for this area:** ${(area.commands || []).join(' · ')}`);
    }
    parts.push('These are live admin commands. Reads run now; changes still ask for confirmation, and destructive/bulk actions always confirm.');
    return parts.join('\n\n');
  },
  get_audit_log(r) {
    if (!(r.entries || []).length) return 'The audit log is empty for that filter.';
    return `Last ${r.count} of ${r.total} entries:\n` + list(r.entries, (e) => `${fmtDate(e.created_at)} · ${e.kind}/${e.action}${e.listing_id ? ` (listing #${e.listing_id})` : ''} — ${e.ok ? 'ok' : 'failed'}${e.payload && e.payload !== '{}' ? ` · ${e.payload.slice(0, 80)}` : ''}`, 20);
  },
  get_moderation_log(r) {
    if (!(r.entries || []).length) return 'No moderation decisions yet.';
    return list(r.entries, (e) => `${fmtDate(e.created_at)} · **${e.decision}** ${e.score !== undefined && e.score !== null ? `(${e.score})` : ''} — ${e.listing_name || `listing #${e.listing_id}`}${e.reason ? ` · ${String(e.reason).slice(0, 90)}` : ''}`, 20);
  },
  get_moderation_rules(r) {
    return [`Auto-moderation is **${r.on ? 'on' : 'off'}** · approve at ≥ **${r.approve_at}** · reject at ≤ **${r.reject_at}** · listings in between wait for you.`, (r.rules || []).length ? '**Rules:**\n' + list(r.rules, (x) => `\`${x}\``, 40) : 'No custom rules — add one with “block term casino”, “flag term crypto” or “trust domain example.co.ke”.'].join('\n');
  },
  set_moderation_thresholds(r) { return `Thresholds now: approve ≥ **${r.approve_at}**, reject ≤ **${r.reject_at}**.`; },
  edit_moderation_rules(r) { return `${r.count} rule(s) in force${(r.rules || []).length ? ': ' + r.rules.map((x) => `\`${x}\``).join(', ') : ''}.`; },
  review_listing_now(r) {
    if (r.error) return r.error;
    const head = r.dry_run ? `Score for **${r.listing.name}** (#${r.listing.id}): **${r.score}/100** → would ${r.decision === 'pending' ? 'hold for review' : r.decision}.` : `Reviewed **${r.listing.name}** (#${r.listing.id}): score **${r.score ?? '?'}** → **${r.decision || r.listing.status}**${r.listing.status ? ` (now ${r.listing.status})` : ''}.`;
    return head + ((r.reasons || []).length ? '\n' + list(r.reasons, (x) => x, 8) : '');
  },
  list_protection_rules(r) {
    const out = [];
    if (r.ips) out.push(`**IP rules (${r.ips.length}):**` + (r.ips.length ? '\n' + list(r.ips, (x) => `#${x.id} ${x.kind} ${x.value}${x.note ? ` — ${x.note}` : ''}`, 25) : ' none'));
    if (r.domains) out.push(`**Domain rules (${r.domains.length}):**` + (r.domains.length ? '\n' + list(r.domains, (x) => `#${x.id} ${x.kind} ${x.value}${x.note ? ` — ${x.note}` : ''}`, 25) : ' none'));
    if (r.limits) out.push(`**Rate limits:** ${Object.entries(r.limits).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
    return out.join('\n');
  },
  list_mail_accounts(r) {
    return [`**From:** ${r.from || 'default'}${r.env_smtp ? ' · SMTP_URL set in the environment' : ''}`, (r.accounts || []).length ? list(r.accounts, (a) => `#${a.id} ${a.label || a.provider} — ${a.host}:${a.port}${a.secure ? ' (TLS)' : ''} as ${a.username || '—'} · ${a.sent_today}${a.daily_limit ? `/${a.daily_limit}` : ''} today · ${a.active ? 'active' : 'paused'}`) : 'No SMTP accounts saved — add one with “add smtp host=… username=… password=…”.'].join('\n');
  },
  list_api_keys(r) {
    if (!(r.keys || []).length) return 'No API keys match.';
    return list(r.keys, (k) => `#${k.id} \`${k.prefix}…\` ${k.label ? `“${k.label}” ` : ''}— ${k.owner} · ${k.total_requests} req (${k.write_requests} writes) · last used ${k.last_used_at ? fmtDate(k.last_used_at) : 'never'}${k.revoked_at ? ' · **revoked**' : ''}`, 25);
  },
  revoke_api_key(r) { return `Key \`${r.prefix}…\` (#${r.id}) is revoked — the member will need a new one.`; },
  list_listings(r) { if (!r.count) return pick(SAY.nothing) + ' No listings match.'; return `${r.count} listing${r.count === 1 ? '' : 's'}${r.filters ? ` (${r.filters})` : ''}:\n` + list(r.listings, (l) => `#${l.id} **${l.name}** — ${l.status}${l.category ? ' · ' + l.category : ''}${l.country ? ' · ' + l.country : ''}${l.featured ? ' · featured' : ''}${l.sponsored ? ' · sponsored' : ''} · \`${l.slug}\``, 20); },
  search_listings(r) { if (!r.count) return 'No listings match that.'; return `${r.count} match${r.count === 1 ? '' : 'es'}:\n` + list(r.listings, (l) => `#${l.id} **${l.name}** — ${l.status} · ${l.category || ''} · \`${l.slug}\``); },
  get_listing(r) {
    const l = r.listing; const o = r.owner;
    return [
      `**${l.name}** (#${l.id}) — ${l.status}${l.featured ? ' · featured' : ''}${l.sponsored ? ' · sponsored' : ''}${l.plan && l.plan !== 'free' ? ' · ' + l.plan : ''}`,
      `${l.type || ''} · ${l.category || ''} · ${[l.city, l.country].filter(Boolean).join(', ')}${l.founded ? ' · founded ' + l.founded : ''}${l.size ? ' · ' + l.size : ''}`,
      l.tagline ? `_${l.tagline}_` : '',
      `Website: ${l.website || '—'}${l.email ? ' · ' + l.email : ''}${l.phone ? ' · ' + l.phone : ''}`,
      `Owner: ${o ? `${o.name || ''} <${o.email}> (${o.plan || 'free'})` : 'unclaimed'} · confidence ${l.confidence ?? '—'} · slug \`${l.slug}\``,
      r.technologies && r.technologies.length ? `Tech: ${r.technologies.map((t) => t.name || t).slice(0, 10).join(', ')}` : '',
      r.relationships && r.relationships.length ? `Relations: ${r.relationships.map((x) => `${x.rel_type} → ${x.target_name || '#' + x.target_listing_id} (id ${x.id})`).join('; ')}` : '',
      r.events && r.events.length ? `Timeline: ${r.events.slice(0, 5).map((e) => `${e.event_date} ${e.title} (id ${e.id})`).join('; ')}` : '',
      r.claims && r.claims.length ? `Claims: ${r.claims.map((x) => `#${x.id} ${x.status}`).join(', ')}` : '',
      r.news && r.news.length ? `News: ${r.news.length} stor${r.news.length === 1 ? 'y' : 'ies'} (${r.news.filter((n) => n.status === 'pending').length} pending)` : '',
      `Created ${fmtDate(l.created_at)} · updated ${fmtDate(l.updated_at)} · ${l.url}`,
    ].filter(Boolean).join('\n');
  },
  list_users(r) { if (!r.count) return 'No members match.'; return `${r.count} member${r.count === 1 ? '' : 's'}${r.filters ? ` (${r.filters})` : ''}:\n` + list(r.users, (u) => `#${u.id} **${u.name || '—'}** <${u.email}> — ${u.plan || 'free'}${u.suspended ? ' · SUSPENDED' : ''}${u.trial_expires_at ? ' · trial → ' + u.trial_expires_at.slice(0, 10) : ''} · ${u.listings} listing${u.listings === 1 ? '' : 's'} · joined ${fmtDate(u.created_at).slice(0, 10)}`, 20); },
  search_users(r) { if (!r.count) return 'No members match that.'; return `${r.count} member${r.count === 1 ? '' : 's'}:\n` + list(r.users, (u) => `#${u.id} **${u.name || '—'}** <${u.email}> — ${u.plan || 'free'}${u.suspended ? ' · SUSPENDED' : ''} · ${u.listings} listing${u.listings === 1 ? '' : 's'}`); },
  get_user(r) {
    const u = r.user;
    return [
      `**${u.name || '—'}** <${u.email}> (#${u.id}) — ${u.plan || 'free'}${u.plan_expires_at ? ' until ' + u.plan_expires_at.slice(0, 10) : ''}${u.suspended ? ' · **SUSPENDED**' : ''}`,
      `Signed up ${fmtDate(u.created_at)} via ${u.provider || 'password'} · 2FA ${u.two_factor ? 'on' : 'off'}${u.trial_expires_at ? ' · trial until ' + u.trial_expires_at.slice(0, 10) : (u.trial_used ? ' · trial used' : '')}`,
      r.listings.length ? `Listings (${r.listings.length}): ${r.listings.map((l) => `#${l.id} ${l.name} (${l.status})`).slice(0, 8).join(', ')}` : 'No listings.',
      r.tickets.length ? `Tickets: ${r.tickets.map((t) => `${t.ref} ${t.status}`).slice(0, 6).join(', ')}` : '',
      r.payments.length ? `Payments: ${r.payments.slice(0, 5).map((p) => `${p.status} ${money(p.amount, p.currency)} (${fmtDate(p.created_at).slice(0, 10)})`).join(', ')}` : 'No payments.',
      r.claims.length ? `Claims: ${r.claims.map((c) => `#${c.id} ${c.status} (${c.listing || c.domain})`).join(', ')}` : '',
      r.api_keys && r.api_keys.length ? `API keys: ${r.api_keys.length}` : '',
    ].filter(Boolean).join('\n');
  },
  list_tickets(r) { if (!r.count) return `No ${r.status || ''} tickets.`.replace('  ', ' '); return `${r.count} ${r.status || ''} ticket${r.count === 1 ? '' : 's'}:\n` + list(r.tickets, (t) => `**${t.ref}** — ${t.subject} · ${t.user_email} · ${t.status} · ${fmtDate(t.updated_at)}`, 20); },
  list_open_tickets(r) { return FORMAT.list_tickets({ ...r, status: 'open' }); },
  get_ticket(r) {
    const t = r.ticket;
    const thread = (r.messages || []).slice(-6).map((m) => `— **${m.sender}** (${fmtDate(m.created_at)}): ${String(m.body || '').slice(0, 300)}`).join('\n');
    return [`**${t.ref}** — ${t.subject}`, `${t.status} · ${t.category} · ${t.user_email}${t.user_name ? ' (' + t.user_name + ')' : ''} · opened ${fmtDate(t.created_at)} · updated ${fmtDate(t.updated_at)}`, thread].filter(Boolean).join('\n');
  },
  list_pending_claims(r) { if (!r.count) return 'No pending claims.'; return `${r.count} pending claim${r.count === 1 ? '' : 's'}:\n` + list(r.claims, (c) => `#${c.id} **${c.listing_name}** via ${c.method} (${c.domain}) by ${c.user_email} · ${fmtDate(c.created_at)}`); },
  list_pending_removals(r) { if (!r.count) return 'No pending removal requests.'; return `${r.count} removal request${r.count === 1 ? '' : 's'}:\n` + list(r.removals, (x) => `#${x.id} **${x.listing_name || '(listing gone)'}** — ${x.reason} · from ${x.name} <${x.email}> · ${fmtDate(x.created_at)}`); },
  list_news_queue(r) { if (!r.count) return `No ${r.status} news stories.`; return `${r.count} ${r.status} stor${r.count === 1 ? 'y' : 'ies'} (queue: ${Object.entries(r.counts || {}).map(([k, v]) => `${v} ${k}`).join(', ')}):\n` + list(r.stories, (s) => `#${s.id} **${s.title}**${s.listing ? ' — ' + s.listing : ''} · ${s.source || s.origin} · ${s.published_at || ''}`); },
  list_content(r) {
    if (r.posts) return r.count ? `${r.count} blog post${r.count === 1 ? '' : 's'}:\n` + list(r.posts, (p) => `#${p.id} **${p.title}** — ${p.status} · \`${p.slug}\``) : 'No blog posts.';
    if (r.roles) return r.count ? `${r.count} role${r.count === 1 ? '' : 's'}:\n` + list(r.roles, (x) => `#${x.id} **${x.title}** — ${x.role_type || ''} · ${x.location || ''} · ${x.status}`) : 'No career roles.';
    if (r.promos) return r.count ? `${r.count} promo code${r.count === 1 ? '' : 's'}:\n` + list(r.promos, (p) => `#${p.id} **${p.code}** — ${p.percent}% off · ${p.active ? 'active' : 'off'}${p.max_uses ? ` · ${p.used_count || 0}/${p.max_uses} uses` : ''}${p.expires_at ? ' · expires ' + p.expires_at : ''}`) : 'No promo codes.';
    if (r.packages) return r.count ? `${r.count} advert package${r.count === 1 ? '' : 's'}:\n` + list(r.packages, (p) => `#${p.id} **${p.name}** — ${money(p.price_cents)} / ${p.duration_days} days · ${p.active ? 'shown' : 'hidden'}`) : 'No advert packages.';
    if (r.offers) return r.count ? `${r.count} plan offer${r.count === 1 ? '' : 's'}:\n` + list(r.offers, (p) => `#${p.id} **${p.name}** — ${money(p.price_cents)} / ${p.duration_days} days · ${p.active ? 'shown' : 'hidden'}`) : 'No plan offers.';
    if (r.categories) return `${r.count} categories:\n` + list(r.categories, (c) => `**${c.name}** — ${c.count ?? c.listings ?? 0} listing${(c.count ?? c.listings) === 1 ? '' : 's'}`, 40);
    if (r.incidents) return r.count ? `${r.count} incident${r.count === 1 ? '' : 's'}:\n` + list(r.incidents, (i) => `#${i.id} **${i.title}** — ${i.status} · ${i.severity} · ${fmtDate(i.created_at)}`) : 'No incidents on record.';
    if (r.subscribers) return `${r.active_total} active subscriber${r.active_total === 1 ? '' : 's'}. Newest:\n` + list(r.subscribers, (s) => `${s.email}${s.active ? '' : ' (unsubscribed)'} · ${fmtDate(s.created_at).slice(0, 10)}`, 10);
    if (r.payments) return r.count ? `${r.count} payment${r.count === 1 ? '' : 's'}:\n` + list(r.payments, (p) => `#${p.id} ${money(p.amount, p.currency)} — ${p.status} · ${p.channel} · user #${p.user_id} · ${fmtDate(p.created_at)}`) : 'No payments.';
    return generic(r);
  },
  get_admin_inbox(r) { return `**${r.unread}** unread${r.trash_count !== undefined ? ` · ${r.trash_count} in trash` : ''}.\n` + list(r.notifications || [], (n) => `#${n.id} ${n.read_at ? '' : '● '}**${n.title}** — ${n.body || ''} · ${fmtDate(n.created_at)}`, 12); },
  get_payments_summary(r) { return [`Captured: **USD ${(Number(r.captured_usd || 0) / 100).toFixed(2)}**`, `Active Pro: ${r.pro_users} members · ${r.pro_listings} listings`, `By status: ${(r.totals || []).map((t) => `${t.status} ${t.n} (${money(t.amount, t.currency)})`).join(' · ') || 'none'}`, r.promo_redemptions !== undefined ? `Promo redemptions: ${r.promo_redemptions}` : '', (r.recent || []).length ? 'Recent:\n' + list(r.recent, (p) => `#${p.id} ${money(p.amount, p.currency)} ${p.status} · ${p.channel} · ${fmtDate(p.created_at)}`, 8) : ''].filter(Boolean).join('\n'); },
  get_indexing_status(r) { return [`IndexNow: ${r.indexnow && r.indexnow.enabled ? 'on' : 'off'} · ${r.indexnow ? r.indexnow.log_rows : 0} log rows`, r.google ? `Google Indexing API: ${r.google.enabled ? 'on' : 'off'} · ${r.google.configured ? 'credentials set' : 'no credentials'} · quota ${JSON.stringify(r.google.quota)} · pending ${r.google.pending}` : '', r.upkeep ? `Upkeep: ${r.upkeep.on ? 'on' : 'off'} (tech ${r.upkeep.tech_on ? 'on' : 'off'}, news ${r.upkeep.news_on ? 'on' : 'off'})` : '', r.tech_refresh ? `Tech sweep: ${JSON.stringify(r.tech_refresh)}` : '', r.news_refresh ? `News sweep: ${JSON.stringify(r.news_refresh)}` : ''].filter(Boolean).join('\n'); },
  get_status_page(r) { return [`Overall: **${r.overall && (r.overall.label || r.overall)}** · uptime ${r.uptime || '—'} · ${r.subscribers ?? 0} subscribers`, list(r.components || [], (c) => `${c.name} — ${c.status_label || c.status}${c.slug ? ' (`' + c.slug + '`)' : ''}`), (r.open_incidents || []).length ? 'Open incidents:\n' + list(r.open_incidents, (i) => `#${i.id} ${i.title} — ${i.status} · ${i.severity}`) : 'No open incidents.'].join('\n'); },
  get_settings(r) {
    const site = r.site || {}; const protection = r.protection || {}; const mail = r.mail || {};
    const payments = r.payments || {}; const indexing = r.indexing || {}; const google = indexing.google || {};
    const limits = protection.limits || {};
    const hops = (mail.hops || []).map((h) => `${h.label || h.provider || 'provider'} (${h.host}:${h.port}${h.last_error ? ', error' : ''})`).join(' · ') || 'none configured';
    return [
      '**Site settings**',
      `auto-approve: **${site.auto_approve ? 'ON' : 'off'}** · AI moderation: **${r.assistant && r.assistant.moderation_on ? 'ON' : 'off'}** · maintenance: **${site.maintenance_on ? 'ON' : 'off'}**`,
      `indexing: ${site.indexing_enabled ? 'on' : 'off'} · Google indexing: ${site.google_indexing_enabled ? 'on' : 'off'} · news review: ${site.news_review_auto ? 'on' : 'off'} · weekly status report: ${site.status_weekly_report ? 'on' : 'off'}`,
      `newsletter: ${site.newsletter_cadence || 'weekly'} · trial: ${site.trial_days || 0} days · admin 2FA inbox: ${site.admin_2fa_email || '—'}`,
      '',
      '**Payments**',
      `PayPal mode: **${payments.mode || 'sandbox'}** · client id: ${payments.client_id || 'unset'} · secret: ${payments.client_secret_set ? 'set' : 'missing'} · source: ${payments.source || 'settings'}`,
      '',
      '**Mail providers**',
      `${mail.configured ? 'configured' : 'NOT configured'} · From: ${mail.from || '—'} · ${hops}`,
      '',
      '**Protection**',
      `${Object.entries(limits).map(([k, v]) => `${k}=${v}`).join(' · ') || 'default limits'} · ${protection.ip_rules || 0} IP rules · ${protection.domain_rules || 0} domain rules`,
      '',
      '**Indexing & upkeep**',
      `IndexNow key: ${indexing.indexnow_key || 'none'} · Google: ${google.enabled ? 'on' : 'off'} / ${google.configured ? 'configured' : 'no credentials'} · ${indexing.log_rows || 0} log rows`,
      `Upkeep: ${JSON.stringify(r.upkeep || {})}`,
      r.security ? `**Security** · console ${r.security.console_auth || 'session + CSRF'} · API ${r.security.api_auth || 'key + scopes'} · admin 2FA inbox: ${r.security.admin_2fa_email || '—'} · secrets ${r.security.secrets || 'masked'}` : '',
      r.assistant ? `**Assistant** · auto-moderation ${r.assistant.moderation_on ? 'on' : 'off'} · auto-run: ${(r.assistant.auto_run_tools || []).join(', ') || 'none'}` : '',
    ].filter(Boolean).join('\n');
  },
  get_site_overview(r) { return [`**${r.product.name}** — ${r.product.what} (${r.product.base_url})`, `Volumes: ${r.volumes.listings} listings · ${r.volumes.users} members · ${r.volumes.blog_posts} posts`, `Flags: ${Object.entries(r.feature_flags).map(([k, v]) => `${k}=${v ? 'on' : 'off'}`).join(' · ')}`, `Admin console: ${r.admin_console.map((p) => p.page.split(' — ')[0].split(':')[0]).join(' · ')}`, `Public pages: ${r.public_pages.length} · dashboard areas: ${r.member_dashboard.length}`].join('\n'); },
  get_ai_playground(r) { return [`Assistant: **rule engine, no model** · ${r.tools} console actions · auto-run: ${(r.auto_run_tools || []).join(', ') || 'none'}`, `Auto-moderation: ${r.moderation.on ? 'on' : 'off'} · email when unsure ${r.moderation.email_admin ? 'on' : 'off'} · ${r.moderation.blocklist_terms} blocked terms · approve at ≥${r.moderation.approve_at} · reject at ≤${r.moderation.reject_at}`, `Pending confirmations: ${r.pending_confirmations}`, (r.recent_audit || []).length ? 'Recent audit:\n' + list(r.recent_audit, (a) => `${fmtDate(a.created_at)} ${a.kind}/${a.action} — ${String(a.result || '').slice(0, 80)}`, 8) : ''].filter(Boolean).join('\n'); },
  export_backup(r) { return `Backup written: \`${r.path || r.file}\` (${r.size_human || r.size || '?'}) — download it from Admin → Health.`; },
  run_status_check(r) { return 'Probe finished:\n' + list(r.results || r.components || [], (x) => `${x.name || x.slug} — ${x.status_label || x.status}${x.latency_ms ? ` (${x.latency_ms} ms)` : ''}${x.error ? ' · ' + x.error : ''}`); },
  refresh_listing_tech(r) { return `Technology radar refreshed for **${r.name || r.slug || r.id}**: ${(r.technologies || r.tech || []).map((t) => t.name || t).join(', ') || 'nothing detected'}${r.hiring_url ? ` · hiring link ${r.hiring_url}` : ''}.`; },
  run_news_refresh(r) { return r.found !== undefined ? `News scan finished — ${r.found} new stor${r.found === 1 ? 'y' : 'ies'}${r.pending ? ` (${r.pending} awaiting moderation)` : ''}.` : generic(r); },
  send_test_mail(r) { return r.delivered ? `Test email sent to ${r.to}${r.via ? ' via ' + r.via : ''}.` : `Test email queued for ${r.to} — ${r.note || 'no SMTP configured, so it landed in the outbox log.'}`; },
  email_users(r) { return r.note || `Queued ${r.queued} email${r.queued === 1 ? '' : 's'}.`; },
  email_all_users(r) { return r.note || `Queued ${r.queued} email${r.queued === 1 ? '' : 's'}.`; },
};

function generic(r, depth = 0) {
  if (r === null || r === undefined) return '';
  if (typeof r !== 'object') return String(r);
  if (Array.isArray(r)) return list(r, (x) => (typeof x === 'object' ? Object.entries(x).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') : String(x)));
  return Object.entries(r).filter(([k]) => k !== 'ok').map(([k, v]) => {
    if (Array.isArray(v)) return `**${k}** (${v.length}):\n${generic(v, depth + 1)}`;
    if (v && typeof v === 'object') return depth < 1 ? `**${k}:** ${Object.entries(v).map(([a, b]) => `${a}=${typeof b === 'object' ? JSON.stringify(b) : b}`).join(' · ')}` : `**${k}:** ${JSON.stringify(v)}`;
    return `**${k}:** ${v}`;
  }).join('\n');
}

function hasFormatter(tool) { return Boolean(FORMAT[tool]); }

function formatResult(tool, result, plan) {
  try {
    if (FORMAT[tool]) return FORMAT[tool](result || {}, plan);
  } catch { /* fall through */ }
  if (result && typeof result === 'object' && result.ok === true && Object.keys(result).length <= 3) return '';
  return generic(result);
}

/** Verbal receipt for a write, using the tool's own summariser. */
function receiptFor(tool, args, ok, error) {
  const what = tools.describeCall(tool, args).replace(/\.$/, '');
  return ok ? `${pick(SAY.ran)} ${what}.` : `Could not ${what.charAt(0).toLowerCase()}${what.slice(1)}: ${error || 'unknown error'}.`;
}

/* ------------------------------------------------------------------ */
/* 9. Suggestions & help                                               */
/* ------------------------------------------------------------------ */

function suggestionsFor(tool, plan, result, ctx) {
  const s = [];
  const l = ctx.listing; const u = ctx.user; const t = ctx.ticket;
  switch (tool) {
    case 'get_listing_stats': if (result && result.pending) s.push('show pending listings'); if (result && result.open_tickets) s.push('show open tickets'); if (result && result.pending_claims) s.push('show pending claims'); s.push('show revenue'); break;
    case 'list_listings': case 'search_listings': if (result && result.listings && result.listings.length) { const f = result.listings[0]; s.push(`show listing ${f.id}`); if (f.status === 'pending') s.push(`approve ${f.id}`, `reject ${f.id}`); if ((result.listings || []).some((x) => x.status === 'pending')) s.push('approve all pending'); } break;
    case 'get_listing': if (l) { const row = result && result.listing; if (row && row.status === 'pending') s.push('approve it', 'reject it'); else if (row) s.push(row.featured ? 'unfeature it' : 'feature it', row.sponsored ? 'unsponsor it' : 'sponsor it 30 days'); s.push('refresh its tech', 'delete it'); } break;
    case 'list_users': case 'search_users': if (result && result.users && result.users.length) s.push(`show user ${result.users[0].email}`); break;
    case 'get_user': if (u) { const row = result && result.user; s.push(row && row.suspended ? 'unsuspend them' : 'suspend them', row && row.plan === 'pro' ? 'revoke their pro' : 'give them pro 30 days', 'send a password reset', 'email them subject: "…" message: "…"'); } break;
    case 'list_tickets': case 'list_open_tickets': if (result && result.tickets && result.tickets.length) s.push(`open ticket ${result.tickets[0].ref}`); break;
    case 'get_ticket': if (t) s.push(`reply to ${t.ref} saying: …`, `mark ${t.ref} solved`, `close ${t.ref}`); break;
    case 'list_pending_claims': if (result && result.count) s.push(`recheck claim ${result.claims[0].id}`, `reject claim ${result.claims[0].id}`); break;
    case 'list_pending_removals': if (result && result.count) s.push(`fulfil removal ${result.removals[0].id}`, `dismiss removal ${result.removals[0].id}`); break;
    case 'list_news_queue': if (result && result.count) s.push(`approve story ${result.stories[0].id}`, `reject story ${result.stories[0].id}`); break;
    case 'approve_listing': case 'reject_listing': s.push('show pending listings', 'how many pending'); if (l) s.push(l.status === 'approved' || tool === 'approve_listing' ? 'feature it' : 'show it'); break;
    case 'suspend_user': s.push('unsuspend them', 'show their listings'); break;
    case 'get_status_page': if (result && result.open_incidents && result.open_incidents.length) s.push(`resolve incident ${result.open_incidents[0].id}`); else s.push('open an incident titled "…"', 'run the status check'); break;
    case 'get_admin_inbox': if (result && result.unread) s.push('mark inbox read'); break;
    case 'search_admin': {
      const areas = result && Array.isArray(result.areas) ? result.areas : [];
      if (areas[0] && Array.isArray(areas[0].commands)) s.push(...areas[0].commands.slice(0, 3));
      s.push('search the entire site for <term>', 'show settings');
      break;
    }
    case 'get_settings': s.push('show paypal settings', 'email settings', 'indexing status', 'send a test email'); break;
    default: {
      const t = tools.getTool(tool);
      if (t && t.mutating) {
        if (l && /listing|sponsor|feature|tech|relation|event/.test(tool)) s.push('show it', 'how many pending');
        else if (u && /user|pro|trial|password/.test(tool)) s.push('show them', 'show their listings');
        else if (t && /ticket/.test(tool)) s.push('show open tickets');
        else if (/incident|status/.test(tool)) s.push('status page');
        else if (/promo|plan|ad_package|career|blog|category|news/.test(tool)) s.push(`show ${/promo/.test(tool) ? 'promos' : /plan/.test(tool) ? 'plans' : /ad_/.test(tool) ? 'ad packages' : /career/.test(tool) ? 'roles' : /blog/.test(tool) ? 'blog posts' : /category/.test(tool) ? 'categories' : 'pending news'}`);
        else s.push('show settings');
      }
      break;
    }
  }
  return [...new Set(s)].slice(0, 4);
}

const HELP_TOPICS = {
  listing: ['show pending listings', 'show listing acme-ltd', 'approve 42 / reject 42', 'approve all pending', 'feature acme / unfeature it', 'sponsor acme 60 days', 'grant listing pro to acme for 90 days', 'set website of acme to https://acme.co.ke', 'make bob@x.com owner of acme', 'refresh tech for acme', 'delete listing 42', 'mark Beta as a subsidiary of Acme', 'add event to acme titled "Series A" funding 2026-05-01', 'create listing name="…" website=… category=… type=company country=Kenya tagline="…" description="…"'],
  user: ['show user bob@x.com', 'show suspended users / new signups this week', 'suspend bob@x.com / unsuspend them', 'give bob pro for 30 days / lifetime pro', 'revoke their pro', 'start a 14 day trial for bob', 'send bob a password reset', 'delete user bob@x.com (always confirms)', 'approve transfer 3'],
  ticket: ['show open tickets', 'open ticket FL-1A2B', 'reply to FL-1A2B saying: We are on it', 'mark FL-1A2B solved / close it / reopen it'],
  claim: ['show pending claims', 'recheck claim 5', 'reject claim 5'],
  removal: ['show removal requests', 'fulfil removal 2 (deletes the listing)', 'dismiss removal 2'],
  post: ['show blog posts', 'create blog post title="…" body="…"', 'publish post 3 / unpublish post 3', 'edit post 3 title="…"', 'delete post 3'],
  news: ['show pending news', 'approve story 9 / reject story 9', 'scan news for acme', 'run the news sweep', 'add story to acme titled "…" url=…', 'news moderation on/off'],
  career: ['show roles', 'post role title="…" location=Nairobi description="…" requirements="…"', 'close role 2 / reopen role 2', 'delete role 2'],
  promo: ['show promos', 'create promo LAUNCH25 25% off max 100 uses expires 2026-12-31', 'pause promo LAUNCH25 / resume it', 'delete promo 4'],
  planoffer: ['show plans', 'create plan offer "Pro Quarter" $39 for 90 days', 'hide plan 2 / show plan 2', 'delete plan 2'],
  adpackage: ['show ad packages', 'create ad package "Homepage Spotlight" $99 for 30 days', 'hide package 1', 'delete package 1'],
  category: ['show categories', 'create category Agritech', 'rename category Fintech to Financial Services', 'delete category Misc'],
  incident: ['status page', 'open incident titled "API latency" major', 'update incident 3 saying: fix deployed, monitoring', 'resolve incident 3', 'run the status check', 'reset component api'],
  email: ['email bob@x.com subject: "Hello" message: "…"', 'email admin subject: "…" message: "…"', 'email pro members about "New feature" saying: …', 'email everyone subject: "…" message: "…" (always confirms)', 'send newsletter digest now', 'set newsletter weekly', 'send a test email', 'set mail from "FirmLedger <no-reply@firmledger.co.ke>"'],
  maintenance: ['take the site down / maintenance on', 'bring the site back / maintenance off', 'auto approve on/off', 'auto moderation on/off'],
  indexing: ['indexing status', 'indexing on/off', 'ping /listing/acme', 'google indexing on', 'run google indexing batch', 'clear indexing logs', 'refresh tech for all stale', 'run upkeep now', 'upkeep off'],
  ip: ['block ip 1.2.3.4', 'allow ip 1.2.3.4', 'block domain spam.example', 'unblock ip 1.2.3.4', 'set rate limit login=10 register=5'],
  inbox: ['show inbox', 'mark inbox read', 'archive notification 12', 'leave a note: check acme tomorrow'],
  settings: ['show settings', 'set 2fa email to admin@x.com', 'set paypal live', 'add smtp host=… username=… password=…', 'backup now', 'health'],
  payment: ['show revenue', 'show pending payments', 'how much did we make this month', 'show api keys / revoke api key 3'],
  moderation: ['moderation rules', 'moderation log', 'score acme (no changes) / review acme now', 'set approve threshold to 80', 'set reject threshold to 20', 'block term casino / flag term crypto / trust domain example.co.ke', 'auto moderation on/off'],
  audit: ['show audit log', 'audit log for approve_listing', 'what did I just do', 'moderation log'],
  protection: ['show blocked ips', 'show spam rules', 'block ip 1.2.3.4 / whitelist 8.8.8.8', 'block domain spam.example', 'unblock ip 1.2.3.4', 'set rate limit login=10 register=5'],
  mail: ['smtp settings', 'add smtp host=… username=… password=…', 'set mail from to noreply@x.com', 'send a test email to me@x.com', 'email pro members about "…" saying: …'],
  backup: ['backup now', 'health', 'show settings'],
  briefing: ['briefing / what needs attention', 'how many pending', 'show open tickets', 'show pending claims', 'status page', 'show inbox'],
};

function helpText(topic) {
  const key = Object.keys(HELP_TOPICS).find((k) => k === topic) || (/(moderat|screen|score|threshold)/.test(topic) ? 'moderation' : '') || (/(audit|log|history)/.test(topic) ? 'audit' : '') || (/(protect|spam|ip|block|rate)/.test(topic) ? 'protection' : '') || (/(mail|smtp)/.test(topic) ? 'mail' : '') || (/(backup|health)/.test(topic) ? 'backup' : '') || (/(brief|start|morning)/.test(topic) ? 'briefing' : '') || (topic === 'user' ? 'user' : '') || (/(tickets?|support)/.test(topic) ? 'ticket' : '') || (/(blog|post)/.test(topic) ? 'post' : '') || (/mail/.test(topic) ? 'email' : '') || (/(status|incident)/.test(topic) ? 'incident' : '') || (/(domain|protection|spam|rate)/.test(topic) ? 'ip' : '') || (/(smtp|paypal|backup|2fa)/.test(topic) ? 'settings' : '') || (/(promo|coupon)/.test(topic) ? 'promo' : '') || (/(plan|offer)/.test(topic) ? 'planoffer' : '') || (/(ad|advert|package)/.test(topic) ? 'adpackage' : '') || (/(index|seo|upkeep|tech)/.test(topic) ? 'indexing' : '') || (/(revenue|money|payment)/.test(topic) ? 'payment' : '');
  if (key) return `**${key === 'planoffer' ? 'Plan offers' : key === 'adpackage' ? 'Advert packages' : key.charAt(0).toUpperCase() + key.slice(1)}** — try:\n` + HELP_TOPICS[key].map((x) => `• ${x}`).join('\n') + '\n\nLookups run at once; changes ask you to confirm (unless you auto-allow them in Settings); deletions and bulk actions always confirm.';
  return [
    'I run the admin console from plain language — no model, no API, everything happens here on the server.',
    '',
    '**Ask me things:** how many pending · show pending listings · show user bob@x.com · open tickets · pending claims · removal requests · revenue · status page · inbox · settings · health',
    '**Tell me to act:** approve acme · reject 42 · approve all pending · feature it · sponsor acme 30 days · suspend bob@x.com · give bob pro for 90 days · reply to FL-1A2B saying: … · mark it solved · email pro members about "…" saying: … · take the site down · block ip 1.2.3.4 · open incident titled "…" · backup now',
    '**Follow-ups work:** after “show acme” you can say “approve it”, “feature it”, “email the owner”. After a list, “the first one” or “#42” picks an item.',
    '',
    `Say “help listings”, “help users”, “help tickets”, “help email”, “help incidents”, “help indexing” … for that area. ${tools.TOOLS.length} console actions are wired in.`,
  ].join('\n');
}

module.exports = {
  canon, extractSlots, freeText, splitCommands, parseCommand, answerAsk,
  formatResult, hasFormatter, receiptFor, suggestionsFor, helpText, SAY, pick,
  resolveListing, resolveUser, resolveTicket,
};
