/* growth-calendly.js, without a browser or a network.
   Run:  node tools_growth_calendly_check.mjs          (~1s)

   WHAT THE BROWSER SUITE CANNOT SEE. A sync writes rows as the service role, so every
   decision that matters happens inside the function and leaves no trace on any screen
   until the next load. Two of those decisions are new and both are easy to get wrong in
   a way that looks fine:

     1. WHETHER A BOOKING OPENS A DEAL. Until now one never did, so every booking from
        somebody nobody was already tracking sat outside the pipeline with a null
        client_id -- twelve of twenty-one rows the day this was written -- and the Growth
        Inbox could not match their replies, because it looks a reply up by its deal.

     2. HOW MANY. Calendly hands back one event per BOOKING, and one person books more
        than once: three of the eleven unmatched bookings were the same man. One deal per
        booking would have the pipeline counting him three times, each worth whatever a
        lead is worth, and nothing on the screen would look wrong.

   fetch is replaced with a script: each call is matched by URL and answered from a plan,
   so no request leaves the machine. Every assertion was watched to fail with the
   behaviour inverted -- the sabotage lines are in the commit message. */

import assert from 'node:assert';

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); };

const SUPA = 'https://example.supabase.co';
const realFetch = globalThis.fetch;

function stubFetch(plan) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts: opts || {} });
    for (const [frag, reply] of plan) {
      if (u.includes(frag)) {
        const r = typeof reply === 'function' ? reply(u, opts || {}) : reply;
        return { ok: r.ok !== false, status: r.status || (r.ok === false ? 400 : 200),
                 json: async () => r.body,
                 text: async () => JSON.stringify(r.body === undefined ? null : r.body) };
      }
    }
    throw new Error('unplanned fetch: ' + u);
  };
  return calls;
}

process.env.SUPABASE_URL = SUPA;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-not-real';

const mod = await import('./netlify/functions/growth-calendly.js');
const { runSync, busiestOwner } = mod.default || mod;

const LUKE = 'p-luke', NISH = 'p-nish';
const ev = (uri, name, start) => ({ uri, name, start_time: start,
  end_time: new Date(new Date(start).getTime() + 45 * 60000).toISOString(),
  status: 'active', location: { join_url: 'https://us06web.zoom.us/j/1' } });

/* `bookings` is [event, inviteeName, inviteeEmail]; `deals` is what the pipeline holds. */
function plan(bookings, deals, profiles) {
  return [
    ['/users/me', { body: { resource: {
        uri: 'u1', current_organization: 'org1', email: 'growth@reachgiant.com' } } }],
    ['/invitees', (u) => {
      const b = bookings.find(b => u.startsWith(b[0].uri));
      return { body: { collection: b && b[2] !== null
        ? [Object.assign({ name: b[1], email: b[2] }, b[3] || {})] : [] } };
    }],
    ['/scheduled_events', { body: { collection: bookings.map(b => b[0]), pagination: {} } }],
    ['growth_clients', (u, o) => o.method === 'POST'
      ? { body: JSON.parse(o.body).map((d, i) => ({ ...d, id: 'new-' + i })) }
      : { body: deals }],
    ['profiles', { body: profiles || [{ id: LUKE, role: 'owner' }] }],
    ['growth_meetings', (u, o) => o.method === 'POST' ? { body: JSON.parse(o.body) } : { body: [] }]
  ];
}
const madeDeals = (calls) => {
  const w = calls.find(c => c.url.includes('growth_clients') && c.opts.method === 'POST');
  try { return w ? JSON.parse(w.opts.body) : []; } catch (e) { return []; }
};
const wroteMeetings = (calls) => {
  const w = calls.find(c => c.url.includes('growth_meetings') && c.opts.method === 'POST');
  try { return w ? JSON.parse(w.opts.body) : []; } catch (e) { return []; }
};

/* Nishchay's deal comes FIRST and Luke's are the many. If this list were the other way
   round, "the first owner we saw" and "the owner with the most" would be the same answer
   and nothing here could tell them apart -- which is exactly what happened: a sabotage
   that returned the first owner passed the whole suite. */
const HAVE = [{ id: 'd-k', email: 'k@example.com', owner_id: NISH },
              { id: 'd-pete', email: 'pete@finzanza.com', owner_id: LUKE },
              { id: 'd-amna', email: 'amna@example.com', owner_id: LUKE }];

/* ------------------------------------------------- a booking nobody is tracking */
let calls = stubFetch(plan(
  [[ev('https://cal/e1', 'Strategy', '2026-11-02T17:00:00Z'), 'Rob Sader', 'rob@asurion.com']], HAVE));
let res = await runSync('tok');
let fresh = madeDeals(calls);
check('a booking from somebody with no deal opens one',
  res.dealsCreated === 1 && fresh.length === 1, JSON.stringify(res));
check('named and addressed from the invitee, not the event',
  fresh[0] && fresh[0].name === 'Rob Sader' && fresh[0].email === 'rob@asurion.com',
  JSON.stringify(fresh[0] && { n: fresh[0].name, e: fresh[0].email }));
check('in the first stage, because they have booked and not yet been met',
  fresh[0] && fresh[0].stage === 'booked', fresh[0] && fresh[0].stage);
check('owned by whoever already runs Growth, not left null',
  fresh[0] && fresh[0].owner_id === LUKE, fresh[0] && fresh[0].owner_id);
/* The point of making it: the booking has to end up ATTACHED. A deal created and not
   joined to the call would leave the screen exactly as it was. */
check('and the booking is attached to it',
  wroteMeetings(calls)[0] && wroteMeetings(calls)[0].client_id === 'new-0',
  JSON.stringify(wroteMeetings(calls)[0] && wroteMeetings(calls)[0].client_id));

/* ------------------------------------------------- the same person, three times */
calls = stubFetch(plan([
  [ev('https://cal/e1', 'Strategy', '2026-10-26T17:00:00Z'), 'Thomas English', 'te@gmail.com'],
  [ev('https://cal/e2', 'Strategy', '2026-10-27T17:00:00Z'), 'Thomas English', 'te@gmail.com'],
  [ev('https://cal/e3', 'Strategy', '2026-11-02T17:00:00Z'), 'Thomas English', 'te@gmail.com']
], HAVE));
res = await runSync('tok');
fresh = madeDeals(calls);
check('three bookings from one person open ONE deal, not three',
  res.dealsCreated === 1 && fresh.length === 1, JSON.stringify(res));
check('and all three calls hang off it',
  wroteMeetings(calls).length === 3 &&
  wroteMeetings(calls).every(r => r.client_id === 'new-0'),
  JSON.stringify(wroteMeetings(calls).map(r => r.client_id)));

/* ------------------------------------------------- our own people */
calls = stubFetch(plan(
  [[ev('https://cal/e1', 'Strategy', '2026-10-26T17:00:00Z'), 'ReachGiant Test', 'seo@reachgiant.com']], HAVE));
res = await runSync('tok');
check('somebody here booking the link to try it does not become a lead',
  res.dealsCreated === 0 && madeDeals(calls).length === 0, JSON.stringify(res));
check('though the booking itself is still kept',
  wroteMeetings(calls).length === 1 && wroteMeetings(calls)[0].client_id === null,
  JSON.stringify(wroteMeetings(calls).map(r => r.client_id)));

/* ------------------------------------------------- somebody already in the pipeline */
calls = stubFetch(plan(
  [[ev('https://cal/e1', 'Strategy', '2026-11-02T17:00:00Z'), 'Pete Patrino', 'pete@finzanza.com']], HAVE));
res = await runSync('tok');
check('a booking from somebody already tracked opens nothing new',
  res.dealsCreated === 0 && madeDeals(calls).length === 0, JSON.stringify(res));
check('and attaches to the deal that already existed',
  wroteMeetings(calls)[0] && wroteMeetings(calls)[0].client_id === 'd-pete',
  JSON.stringify(wroteMeetings(calls)[0] && wroteMeetings(calls)[0].client_id));
/* Matching is case-insensitive on both sides, or the same person books twice under two
   spellings and gets a second deal. */
calls = stubFetch(plan(
  [[ev('https://cal/e1', 'Strategy', '2026-11-02T17:00:00Z'), 'Pete', 'PETE@Finzanza.com']], HAVE));
res = await runSync('tok');
check('however they typed their address',
  res.dealsCreated === 0 && wroteMeetings(calls)[0].client_id === 'd-pete',
  JSON.stringify(res));

/* ------------------------------------------------- nothing to go on */
calls = stubFetch(plan(
  [[ev('https://cal/e1', 'Strategy', '2026-11-02T17:00:00Z'), 'No Email', null]], HAVE));
res = await runSync('tok');
check('a booking with no readable invitee opens no deal rather than a blank one',
  res.dealsCreated === 0 && madeDeals(calls).length === 0, JSON.stringify(res));

/* ------------------------------------------------- who it belongs to */
check('the owner is the one holding the most deals, not the first one seen',
  busiestOwner(HAVE) === LUKE && HAVE[0].owner_id !== LUKE,
  busiestOwner(HAVE) + ' (first in the list is ' + HAVE[0].owner_id + ')');
check('and is nobody at all when the pipeline is empty, so the fallback is reached',
  busiestOwner([]) === null, JSON.stringify(busiestOwner([])));

calls = stubFetch(plan(
  [[ev('https://cal/e1', 'Strategy', '2026-11-02T17:00:00Z'), 'First Ever', 'first@example.com']],
  [], [{ id: 'p-mgr', role: 'manager' }, { id: 'p-own', role: 'owner' }]));
res = await runSync('tok');
fresh = madeDeals(calls);
check('on the very first sync it falls back to the owner, preferring them over a manager',
  res.dealsCreated === 1 && fresh[0] && fresh[0].owner_id === 'p-own',
  JSON.stringify(fresh[0] && fresh[0].owner_id));

/* ------------------------------------------- what they told the booking form

   Ten questions are asked at booking -- budget, readiness, revenue -- and every answer
   used to be dropped: the invitee was read only to find an email to match a deal by. The
   panel can only show what the sync stored, and nothing on any screen can tell you the
   sync stored it wrongly, so it is measured here. */

const RICH = {
  text_reminder_number: '+447922116098',
  timezone: 'Europe/Berlin',
  created_at: '2026-10-28T18:02:38.688540Z',
  // Deliberately out of order, to prove `position` is what orders them and not the array.
  questions_and_answers: [
    { position: 2, question: 'What is your monthly budget?', answer: '$1,500 - $10,000' },
    { position: 0, question: 'Tell us about your company', answer: 'Soul Sanctuary' },
    { position: 1, question: 'Which strategies?', answer: 'Google Ads\nSEO' },
    { position: 3, question: 'Skipped on the form', answer: '' }
  ],
  // None of this should be kept: it is noise that would age badly in a row kept forever.
  payment: { amount: 100 },
  tracking: { utm_source: 'fiverr' },
  routing_form_submission: 'https://api.calendly.com/routing_form_submissions/x'
};

calls = stubFetch(plan(
  [[ev('https://cal/e1', 'Strategy', '2026-11-02T17:00:00Z'), 'Umra Hayat', 'umra@outlook.com', RICH]],
  HAVE));
res = await runSync('tok');
let row = wroteMeetings(calls)[0];
let iv = row && row.invitee;

check('the booking form answers are stored with the call',
  !!iv && Array.isArray(iv.qa) && iv.qa.length === 3,
  JSON.stringify(iv && iv.qa && iv.qa.length));
check('in the order Calendly asked them, not the order it returned them',
  !!iv && iv.qa.map(x => x.q).join(' | ') ===
    'Tell us about your company | Which strategies? | What is your monthly budget?',
  JSON.stringify(iv && iv.qa.map(x => x.q)));
/* A question the person skipped is not an answer. Keeping it would put an empty line
   under a heading on the panel, which reads as "they said nothing" rather than "we did
   not get one". */
check('a question left blank is dropped rather than shown empty',
  !!iv && !iv.qa.some(x => x.q === 'Skipped on the form'),
  JSON.stringify(iv && iv.qa.map(x => x.a)));
check('a multi-select answer keeps its line breaks, so three choices stay three',
  !!iv && iv.qa[1].a === 'Google Ads\nSEO', JSON.stringify(iv && iv.qa[1].a));
check('the phone and the timezone come too',
  !!iv && iv.phone === '+447922116098' && iv.timezone === 'Europe/Berlin',
  JSON.stringify(iv && { p: iv.phone, t: iv.timezone }));
check('and when they booked, which is how far ahead they planned',
  !!iv && iv.booked_at === '2026-10-28T18:02:38.688540Z', iv && iv.booked_at);
/* Storing the whole invitee would be easier and wrong: payment, routing form submissions
   and utm parameters are nobody's business here and would sit in the row forever. */
check('payment, tracking and routing data are NOT kept',
  !!iv && !('payment' in iv) && !('tracking' in iv) && !('routing_form_submission' in iv),
  JSON.stringify(iv && Object.keys(iv)));

/* PostgREST refuses a batch whose objects do not all carry the same keys, so a run mixing
   a readable invitee with an unreadable one would fail outright on the write. */
calls = stubFetch(stubPlanMixed());
res = await runSync('tok');
const rowsOut = wroteMeetings(calls);
check('every row carries the invitee key, even when there was nothing to read',
  rowsOut.length === 2 && rowsOut.every(r => 'invitee' in r),
  JSON.stringify(rowsOut.map(r => 'invitee' in r)));
check('and the one that could not be read is null, not half an object',
  rowsOut.some(r => r.invitee === null) && rowsOut.some(r => r.invitee && r.invitee.qa),
  JSON.stringify(rowsOut.map(r => r.invitee === null ? 'null' : 'object')));

function stubPlanMixed() {
  return plan([
    [ev('https://cal/e1', 'Strategy', '2026-11-02T17:00:00Z'), 'Umra', 'umra@outlook.com', RICH],
    [ev('https://cal/e2', 'Strategy', '2026-11-03T17:00:00Z'), 'Nobody', null]
  ], HAVE);
}

globalThis.fetch = realFetch;
for (const r of results) console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   ' + r.detail : ''));
const bad = results.filter(r => !r.pass);
console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' checks passed');
console.log(bad.length ? 'RESULT: ' + bad.length + ' FAILED' : 'RESULT: clean');
process.exit(bad.length ? 1 : 0);
