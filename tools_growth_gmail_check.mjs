/* growth-gmail.js, without a browser or a network.
   Run:  node tools_growth_gmail_check.mjs          (~1s)

   The browser suite drives the Growth Inbox and reads what is on screen. It cannot see
   the three things that actually decide whether this screen is right or quietly wrong,
   because all three happen inside the function:

     1. THE SAME MESSAGE, TWICE. growth@reachgiant.com is connected to two accounts, so
        `emails` holds every message once per account -- 4,060 rows for 3,392 messages
        on the day this was written. Without a dedupe the Inbox shows every reply twice,
        which looks like a Gmail problem rather than ours, and the upsert fights itself
        over one external_id inside a single request.

     2. WHICH WAY A MESSAGE WENT. Direction has to be decided by the DEAL -- did the
        person on the deal send it -- and not by the mailbox. Decide it by asking "is
        this from growth@" and a colleague forwarding something in becomes an inbound
        reply from the client, which puts a deal in Needs your reply that nobody has
        written to us.

     3. WHAT THE PREVIEW SAYS. A reply carries the whole thread quoted underneath it.
        Left in, the newest message previews as the oldest one, and a draft written from
        it answers a question settled a week ago.

   fetch is replaced with a script: each call is matched by URL and answered from a
   plan, so no request leaves the machine. Every assertion here was watched to fail with
   the behaviour inverted -- the sabotage lines are in the commit message. */

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); };

const SUPA = 'https://example.supabase.co';
const realFetch = globalThis.fetch;

/* Anything unplanned throws rather than returning a plausible empty object: a stub that
   quietly answers a question the code should not have asked is how a check passes while
   measuring nothing. */
function stubFetch(plan) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts: opts || {}, body: (() => {
      try { return JSON.parse((opts || {}).body || 'null'); } catch (e) { return null; }
    })() });
    for (const [frag, reply] of plan) {
      if (u.includes(frag)) {
        const r = typeof reply === 'function' ? reply(u, opts || {}) : reply;
        return {
          ok: r.ok !== false,
          status: r.status || (r.ok === false ? 400 : 200),
          json: async () => r.body,
          text: async () => JSON.stringify(r.body === undefined ? null : r.body)
        };
      }
    }
    throw new Error('unplanned fetch: ' + u);
  };
  return calls;
}

process.env.SUPABASE_URL = SUPA;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-not-real';

const mod = await import('./netlify/functions/growth-gmail.js');
const G = mod.default || mod;
const { runMessageSync, stripQuoted, htmlToText, bodyOf, addrsIn } = G;

const DEAL = 'michael@northviewdoorsystems.com';
const OTHER = 'cesar@example.com';
const US = 'growth@reachgiant.com';

const TOKENS = [{ profile_id: 'p-luke' }, { profile_id: 'p-nish' }];
const DEALS = [
  { id: 'd-michael', email: DEAL },
  { id: 'd-cesar', email: OTHER },
  { id: 'd-nobody', email: '' }          // a deal with no address must not match everything
];

/* to_emails is the To HEADER as written -- a text column, not an array, and often
   "Name <addr>" with several recipients in one string. Writing these fixtures as
   arrays is what hid the bug that the first dry run against the real database threw:
   the filter used array overlap and Postgres answered "operator does not exist:
   text && unknown". The fixtures match the real column now. */
const mail = (o) => Object.assign({
  gmail_id: 'g1', thread_id: 't1', from_email: DEAL, to_emails: US,
  subject: 'Re: the plan', snippet: 'hi', body_text: 'Sounds good.',
  body_html: '', received_at: '2026-11-04T10:00:00Z'
}, o);

/* A plan that answers the two address queries separately, the way PostgREST would. */
const plan = (inbound, outbound, opts = {}) => ([
  ['gmail_tokens', { body: opts.tokens !== undefined ? opts.tokens : TOKENS }],
  ['growth_clients', { body: opts.deals !== undefined ? opts.deals : DEALS }],
  ['from_email=in', { body: inbound }],
  ['&or=', { body: outbound }],
  ['growth_messages', (u, o) => ({ body: JSON.parse(o.body) })]
]);

const written = (calls) => {
  const post = calls.find(c => c.url.includes('growth_messages'));
  return post ? post.body : [];
};

/* ------------------------------------------------- the same message, twice */
let calls = stubFetch(plan(
  [mail({ gmail_id: 'dup' }), mail({ gmail_id: 'dup' })],   // once per connected account
  []));
let r = await runMessageSync();
let rows = written(calls);
check('a message held under two accounts is filed once, not twice',
  rows.length === 1 && r.matched === 1, rows.length + ' row(s)');

/* The same row can also come back from BOTH address queries when we are on each end. */
calls = stubFetch(plan([mail({ gmail_id: 'both' })], [mail({ gmail_id: 'both' })]));
r = await runMessageSync();
check('a message found by both queries is still filed once',
  written(calls).length === 1, String(written(calls).length));

/* ------------------------------------------------- which way it went */
calls = stubFetch(plan([mail({ gmail_id: 'i1', from_email: DEAL, to_emails: [US] })], []));
r = await runMessageSync();
rows = written(calls);
check('mail FROM the person on the deal is inbound',
  rows[0] && rows[0].direction === 'in' && rows[0].client_id === 'd-michael',
  rows[0] && rows[0].direction);

calls = stubFetch(plan([], [mail({ gmail_id: 'o1', from_email: US, to_emails: DEAL })]));
r = await runMessageSync();
rows = written(calls);
check('mail TO the person on the deal is outbound',
  rows[0] && rows[0].direction === 'out' && rows[0].client_id === 'd-michael',
  rows[0] && rows[0].direction);

/* The one the browser cannot see. A colleague forwards a client's note in: it arrives
   FROM a reachgiant address, TO growth@, and mentions the deal nowhere we would match.
   Decided by mailbox it reads as the client replying. Decided by deal it is dropped. */
calls = stubFetch(plan([], [mail({
  gmail_id: 'fwd', from_email: 'matthew@reachgiant.com', to_emails: US })]));
r = await runMessageSync();
check('a colleague’s forward is not filed as the client replying',
  written(calls).length === 0 && r.matched === 0, String(r.matched));

/* The shape that broke the first version. A real To header is a display name, angle
   brackets and often more than one recipient; treating it as a bare address matches
   nothing and the Inbox shows only half a thread. */
calls = stubFetch(plan([], [mail({ gmail_id: 'hdr', from_email: US,
  to_emails: 'Luke Griffin <' + US + '>, Michael Cash <' + DEAL + '>' })]));
r = await runMessageSync();
rows = written(calls);
check('an address inside a "Name <addr>" To header, among others, still matches',
  rows.length === 1 && rows[0].client_id === 'd-michael' && rows[0].direction === 'out',
  rows[0] && rows[0].client_id);
check('and the addresses are read out of that header, not the whole string',
  addrsIn('Luke Griffin <a@b.com>, "Cash, Michael" <c@d.com>').join(' ') === 'a@b.com c@d.com',
  addrsIn('Luke Griffin <a@b.com>, "Cash, Michael" <c@d.com>').join(' '));

/* ------------------------------------------------- nothing goes in unattached */
calls = stubFetch(plan([], [mail({ gmail_id: 'x', from_email: 'stranger@nowhere.com',
  to_emails: 'someone@else.com' })]));
r = await runMessageSync();
check('a message matching no deal is never written with a null client',
  !written(calls).some(x => !x.client_id) && written(calls).length === 0, String(r.matched));

/* A deal row with an empty address must not become a wildcard that swallows every
   message whose own address is also missing. */
calls = stubFetch(plan([mail({ gmail_id: 'blank', from_email: '', to_emails: '' })], []));
r = await runMessageSync();
check('a deal with no email address matches nothing',
  r.matched === 0, String(r.matched));

/* ------------------------------------------------- the upsert itself */
calls = stubFetch(plan([mail({ gmail_id: 'u1' })], []));
await runMessageSync();
const post = calls.find(c => c.url.includes('growth_messages'));
check('the write is an upsert keyed on the Gmail id, so a second run rewrites',
  post && post.url.includes('on_conflict=external_id')
       && String(post.opts.headers.Prefer).includes('merge-duplicates'),
  post && post.opts.headers.Prefer);
check('and the Gmail id is what is stored as external_id',
  post && post.body[0].external_id === 'u1', post && post.body[0].external_id);
check('the thread id is carried over, so a reply lands in its own thread',
  post && post.body[0].thread_id === 't1', post && post.body[0].thread_id);

/* ------------------------------------------------- quoted history */
const REPLY = [
  'Yes, Tuesday works.',
  '',
  'On Mon, 3 Nov 2026 at 09:14, Luke Griffin <big@reachgiant.com> wrote:',
  '> Here is the plan for next month, let me know what you think',
  '> and we can get started whenever you are ready.'
].join('\n');
check('the quoted thread under a reply is cut off',
  stripQuoted(REPLY) === 'Yes, Tuesday works.', JSON.stringify(stripQuoted(REPLY)));
check('an Outlook quote block is cut off too',
  stripQuoted('Thanks!\n\n-----Original Message-----\nFrom: Luke') === 'Thanks!',
  JSON.stringify(stripQuoted('Thanks!\n\n-----Original Message-----\nFrom: Luke')));

/* The failure mode of cutting: a bare forward is ALL quote, and an empty body filed
   against a deal is worse than a messy one. */
const BARE = 'On Mon, 3 Nov 2026 at 09:14, Luke <big@reachgiant.com> wrote:\n> the plan';
check('a message that is nothing but quote keeps its text rather than going blank',
  stripQuoted(BARE).length > 0, JSON.stringify(stripQuoted(BARE).slice(0, 30)));

/* THE THREE ABOVE ASSERT THE HELPER, WHICH IS NOT THE SAME THING AS ASSERTING THE
   SCREEN. Taking stripQuoted back out of bodyOf left all three of them green, because
   none of them went through the code the Inbox actually runs. This one does: it reads
   the body on the row that would be written, so the trimming has to still be wired in
   for it to pass. */
calls = stubFetch(plan([mail({ gmail_id: 'q1', body_text: REPLY })], []));
await runMessageSync();
rows = written(calls);
check('the body FILED against the deal has the quoted thread trimmed off',
  rows[0] && rows[0].body === 'Yes, Tuesday works.',
  rows[0] && JSON.stringify(rows[0].body.slice(0, 40)));

/* ------------------------------------------------- bodies with no text part */
check('a mail with no plain-text part falls back to the HTML, as words',
  bodyOf({ body_text: '', body_html: '<p>Hello <b>there</b></p><div>Second line</div>' })
    === 'Hello there\nSecond line',
  JSON.stringify(bodyOf({ body_text: '', body_html: '<p>Hello <b>there</b></p><div>Second line</div>' })));
check('and style and script contents never reach the body',
  htmlToText('<style>p{color:red}</style><p>Hi</p><script>alert(1)</script>') === 'Hi',
  JSON.stringify(htmlToText('<style>p{color:red}</style><p>Hi</p><script>alert(1)</script>')));
check('with neither part, the snippet is better than an empty message',
  bodyOf({ body_text: '', body_html: '', snippet: 'Short preview' }) === 'Short preview',
  bodyOf({ body_text: '', body_html: '', snippet: 'Short preview' }));

/* ------------------------------------------------- honest when it cannot run */
calls = stubFetch(plan([], [], { tokens: [] }));
r = await runMessageSync();
check('an unconnected mailbox says so instead of reporting a clean run',
  r.ok === false && /not connected/i.test(r.note), r.note);
check('and nothing was written on the way to saying it',
  !calls.some(c => (c.opts.method || 'GET') === 'POST'), '');

calls = stubFetch(plan([], [], { deals: [] }));
r = await runMessageSync();
check('no deals is reported as no deals, not as success with zero',
  r.ok === true && r.matched === 0 && /no deal/i.test(r.note), r.note);

calls = stubFetch(plan([], []));
r = await runMessageSync();
check('mail that matches nothing is reported honestly',
  r.ok === true && r.matched === 0 && /matches a deal/i.test(r.note), r.note);

/* ------------------------------------------------- the count the Automations screen shows */
calls = stubFetch(plan(
  [mail({ gmail_id: 'a', from_email: DEAL }), mail({ gmail_id: 'b', from_email: OTHER })],
  [mail({ gmail_id: 'c', from_email: US, to_emails: DEAL })]));
r = await runMessageSync();
check('the run reports what it did, split by direction and by deal',
  r.matched === 3 && r.inbound === 2 && r.outbound === 1 && r.deals === 2,
  JSON.stringify({ m: r.matched, i: r.inbound, o: r.outbound, d: r.deals }));


/* ------------------------------ a deal on our own domain matches the whole mailbox

   Every message in growth@ has somebody from here on one end of it -- that is what
   makes it our mailbox. So a deal carrying a reachgiant.com address matches most of the
   inbox and files it under that one client, in both directions. A test deal on
   big@reachgiant.com had 1,632 messages under it, 989 of them marked as sent by us, and
   it grew by 440 in the four hours between it being noticed and this being written. A
   second on dev@ took 557 more.

   No screen could show this as wrong: the Emails tab was faithfully drawing the rows it
   had been given. The Calendly sync has refused our own domain since it was written --
   somebody here booking the link is a test, not a lead -- and this is that rule applied
   to mail. */
const OURS = [{ id: 'd-us', email: 'big@reachgiant.com' },
              { id: 'd-michael', email: DEAL }];

calls = stubFetch(plan([mail({ gmail_id: 'ours1' })], [], { deals: OURS }));
r = await runMessageSync();
check('a deal on our own domain is refused rather than matched',
  Array.isArray(r.ignored) && r.ignored.includes('big@reachgiant.com'),
  JSON.stringify(r.ignored));

/* THE QUERY, not the result. Filtering the matches afterwards would leave the mailbox
   still being searched for our own address, and a later change could drop the filter
   while every other check here stayed green. The address must never be asked for. */
const asked = calls.filter(c => /from_email=in|&or=/.test(c.url)).map(c => c.url).join(' ');
check('and its address is never used to search the mailbox',
  asked.length > 0 && !/big(%40|@)reachgiant\.com/i.test(asked),
  asked ? 'searched for: ' + decodeURIComponent(asked).slice(0, 110) : 'no address query was made');

/* The real client on the same list has to keep working, or the cure is worse. */
check('while a real client address on the same list still matches',
  written(calls).length === 1 && written(calls)[0].client_id === 'd-michael',
  JSON.stringify(written(calls).map(x => x.client_id)));

/* When it is the ONLY deal there is nothing left to search for, and saying so beats
   returning a cheerful zero that reads like an empty mailbox. */
calls = stubFetch(plan([], [], { deals: [{ id: 'd-us', email: 'big@reachgiant.com' }] }));
r = await runMessageSync();
check('and a pipeline of nothing but our own addresses matches nothing at all',
  r.matched === 0 && Array.isArray(r.ignored) && r.ignored.length === 1
    && /own domain/.test(String(r.note)),
  JSON.stringify({ matched: r.matched, ignored: r.ignored, note: r.note }));

globalThis.fetch = realFetch;
for (const x of results) console.log((x.pass ? 'PASS  ' : 'FAIL  ') + x.name + (x.detail ? '   ' + x.detail : ''));
const bad = results.filter(x => !x.pass);
console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' checks passed');
console.log(bad.length ? 'RESULT: ' + bad.length + ' FAILED' : 'RESULT: clean');
process.exit(bad.length ? 1 : 0);
