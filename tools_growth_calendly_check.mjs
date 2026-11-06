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
    ['growth_meetings', (u, o) => o.method === 'POST' ? { body: JSON.parse(o.body) } : { body: [] }],
    /* The two the notifier reads and writes. They were missing, and because the
       notifier catches its own errors so a failed notification cannot lose a booking,
       the whole thing silently did nothing and the suite stayed green. */
    ['growth_settings', { body: [{ value: [LUKE, NISH] }] }],
    ['notifications', (u, o) => o.method === 'POST' ? { body: JSON.parse(o.body) } : { body: [] }]
  ];
}
const wroteNotes = (calls) => {
  const w = calls.find(c => c.url.includes('notifications') && c.opts.method === 'POST');
  try { return w ? JSON.parse(w.opts.body) : []; } catch (e) { return []; }
};
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

/* ------------------------------------------------- somebody is told
   On 2026-11-05 Erica Morgan booked at 15:12 for a call at 16:00. The sync was
   blameless: the booking was in the database at 15:20, 39 minutes before the call,
   with its Zoom link, attached to a deal. Nothing said so, and the team missed it.

   None of this is visible on a screen -- the screen was right the whole time -- so
   these are the only place the behaviour exists. */
const soonEv = (uri, name, mins) => ev(uri, name,
  new Date(Date.now() + mins * 60000).toISOString());

calls = stubFetch(plan(
  [[soonEv('https://cal/n1', 'Strategy', 48), 'Erica Morgan', 'pete@finzanza.com']], HAVE));
res = await runSync('tok');
let notes = wroteNotes(calls);
check('a new booking tells the owner of the deal it belongs to',
  notes.length === 1 && notes[0].recipient_id === LUKE,
  JSON.stringify(notes.map(n => n.recipient_id)));
/* The urgency belongs in the title: a notification list is read as a column of titles,
   and "New booking" reads the same whether the call is in nine days or nine minutes. */
check('and says in the title that it is soon',
  notes[0] && /^Call soon/.test(notes[0].title), notes[0] && notes[0].title);
check('with how long there is, in the body',
  notes[0] && /starts in 4[5-9] minutes/.test(notes[0].body), notes[0] && notes[0].body);
/* The ten-minute timer would otherwise say the same thing 144 times a day. */
check('keyed on the booking, so a re-run rewrites rather than saying it again',
  notes[0] && notes[0].dedupe_key === 'growth_booking:https://cal/n1',
  notes[0] && notes[0].dedupe_key);

/* A booking already held is not new, however many times the sync runs. */
calls = stubFetch(plan(
  [[soonEv('https://cal/n1', 'Strategy', 48), 'Erica Morgan', 'pete@finzanza.com']], HAVE));
await (async () => {
  const p2 = plan([[soonEv('https://cal/n1', 'Strategy', 48), 'Erica Morgan', 'pete@finzanza.com']], HAVE);
  p2[p2.findIndex(x => x[0] === 'growth_meetings')] =
    ['growth_meetings', (u, o) => o.method === 'POST'
      ? { body: JSON.parse(o.body) } : { body: [{ external_id: 'https://cal/n1' }] }];
  calls = stubFetch(p2);
  res = await runSync('tok');
})();
check('a booking we already had tells nobody, however often the timer runs',
  wroteNotes(calls).length === 0, String(wroteNotes(calls).length));

/* The first sync after a quiet weekend would otherwise announce every call that has
   already happened. */
calls = stubFetch(plan(
  [[ev('https://cal/n2', 'Strategy', '2026-11-02T17:00:00Z'), 'Old Booking', 'pete@finzanza.com']], HAVE));
res = await runSync('tok');
check('a booking whose call has already been and gone tells nobody',
  wroteNotes(calls).length === 0, String(wroteNotes(calls).length));

/* An unmatched booking is the one MOST likely to be missed -- nobody owns it -- so it
   goes to the whole team rather than to nobody. */
calls = stubFetch(plan(
  [[soonEv('https://cal/n3', 'Strategy', 30), 'Nobody Tracked', 'stranger@nowhere.com']], HAVE));
res = await runSync('tok');
notes = wroteNotes(calls);
check('a booking with no deal goes to the whole Growth team, not nowhere',
  notes.length === 2 && notes.map(n => n.recipient_id).sort().join(',') === [LUKE, NISH].sort().join(','),
  JSON.stringify(notes.map(n => n.recipient_id)));

/* Further out, a relative phrase stops being useful: "in 9 days" is not something you
   can act on, and the title should not shout. */
calls = stubFetch(plan(
  [[soonEv('https://cal/n4', 'Strategy', 60 * 24 * 9), 'Far Future', 'pete@finzanza.com']], HAVE));
res = await runSync('tok');
notes = wroteNotes(calls);
check('a call next week is announced quietly, with a date rather than a countdown',
  notes[0] && /^New booking/.test(notes[0].title) && /It is on /.test(notes[0].body),
  notes[0] && JSON.stringify([notes[0].title, notes[0].body]));

/* A notification that fails must not take the booking with it. The booking is the
   thing that matters; being told about it is the improvement. */
await (async () => {
  const p3 = plan([[soonEv('https://cal/n5', 'Strategy', 20), 'Erica Morgan', 'pete@finzanza.com']], HAVE);
  p3[p3.findIndex(x => x[0] === 'notifications')] =
    ['notifications', { ok: false, status: 500, body: { message: 'nope' } }];
  calls = stubFetch(p3);
  res = await runSync('tok');
})();
check('and if telling somebody fails, the booking is still saved',
  res && res.total === 1 && wroteMeetings(calls).length === 1, JSON.stringify(res));

/* ------------------------------------------------- the second event type
   Luke turned on a Kickoff Call in Calendly in November. It is not a lead: it is a
   client who has already paid, being started. Opening a deal from one would put
   somebody we have already won back at the top of the pipeline as a fresh prospect,
   and the only thing stopping that is the booking happening to match an existing deal
   by email -- which is exactly what fails when they book with a different address.

   Zero kickoffs have ever been booked, so nothing on any screen can show this. */
calls = stubFetch(plan(
  [[ev('https://cal/k1', 'ReachGiant Kickoff Call', '2026-11-09T15:00:00Z'),
    'Jordan Lee', 'jordan@leedental.com']], HAVE));
res = await runSync('tok');
check('a kickoff call never opens a deal, because they are already a client',
  res.dealsCreated === 0 && madeDeals(calls).length === 0, JSON.stringify(res));
check('and the booking is still kept, so it shows on Meetings',
  wroteMeetings(calls).length === 1 && wroteMeetings(calls)[0].client_id === null,
  JSON.stringify(wroteMeetings(calls).map(r => r.client_id)));
/* It still has to attach when it CAN. Refusing to open a deal is not the same as
   refusing to join the call to one that already exists. */
calls = stubFetch(plan(
  [[ev('https://cal/k2', 'ReachGiant Kickoff Call', '2026-11-09T15:00:00Z'),
    'Pete Patrino', 'pete@finzanza.com']], HAVE));
res = await runSync('tok');
check('but a kickoff from somebody we DO hold still attaches to their deal',
  res.dealsCreated === 0 && wroteMeetings(calls)[0] &&
  wroteMeetings(calls)[0].client_id === 'd-pete',
  JSON.stringify(wroteMeetings(calls).map(r => r.client_id)));
/* The sales call it sits beside must be unaffected -- a rule that refused both would
   pass the two checks above and quietly stop the pipeline filling at all. */
calls = stubFetch(plan(
  [[ev('https://cal/s9', 'ReachGiant Growth Strategy Session', '2026-11-09T16:00:00Z'),
    'Dana Brooks', 'dana@brooksplumbing.com']], HAVE));
res = await runSync('tok');
check('and a sales call from a stranger still opens one, as it always did',
  res.dealsCreated === 1 && madeDeals(calls).length === 1, JSON.stringify(res));

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

/* ------------------------------------------------------------------ the re-fetch
   Every booking used to cost a Calendly request for its invitee on EVERY run, so a
   window holding eleven bookings spent eleven of its thirteen requests re-reading
   answers already in the database. Nothing on a screen can show this -- the rows come
   out identical either way -- so the request log is the only place it exists.

   These count the requests the function actually made. Asserting the cache helper
   instead would stay green if the call to it were dropped from the path, which is the
   mistake that cost a pass in the Gmail suite. */
const storedInvitee = (email, name) => ({
  name: name, email: email, phone: '+447922116098',
  timezone: 'Europe/Berlin', booked_at: '2026-10-28T18:02:38.688540Z',
  qa: [{ q: 'Monthly budget', a: '5000' }]
});
const inviteeCalls = (calls) => calls.filter(c => c.url.includes('/invitees')).length;

/* `stored` is what growth_meetings already holds, which is what the old code ignored. */
function planWithStored(bookings, deals, stored) {
  const p = plan(bookings, deals);
  p[p.findIndex(x => x[0] === 'growth_meetings')] =
    ['growth_meetings', (u, o) => o.method === 'POST'
      ? { body: JSON.parse(o.body) } : { body: stored }];
  return p;
}

const E1 = ev('https://cal/s1', 'Growth Strategy Session', '2026-11-02T17:00:00Z');
const E2 = ev('https://cal/s2', 'Growth Strategy Session', '2026-11-09T17:00:00Z');

// --- both already stored, with readable invitees: nothing to ask Calendly for.
calls = stubFetch(planWithStored([
  [E1, 'Umra', 'umra@outlook.com'],
  [E2, 'Kai', 'k@example.com']
], HAVE, [
  { external_id: 'https://cal/s1', invitee: storedInvitee('umra@outlook.com', 'Umra') },
  { external_id: 'https://cal/s2', invitee: storedInvitee('k@example.com', 'Kai') }
]));
res = await runSync('tok');
check('a booking already stored costs NO second Calendly request for its invitee',
  inviteeCalls(calls) === 0, inviteeCalls(calls) + ' invitee requests, expected 0');
/* Cheap and wrong would be writing null over what we had. */
let reused = wroteMeetings(calls);
check('and the answers it already had are written back, not blanked',
  reused.length === 2 && reused.every(r => r.invitee && r.invitee.qa.length === 1
    && r.invitee.phone === '+447922116098'),
  JSON.stringify(reused.map(r => r.invitee && r.invitee.email)));
/* The email the deal is matched by now comes from the cache, so if the cache were read
   wrongly a known client would quietly turn into a new lead. k@example.com is Nishchay's
   deal in HAVE. */
check('a deal is still matched by the cached email, so a client stays a client',
  reused.length === 2 && reused.some(r => r.client_id === 'd-k'),
  JSON.stringify(reused.map(r => r.client_id)));
/* Kai is a deal we hold, Umra is not. One deal is opened, for Umra -- and the fact that
   it happens off a CACHED email is the point: read the cache wrongly and the known
   client becomes a second deal, or the stranger never gets one at all. */
check('one deal is opened, for the stranger, and none for the client we hold',
  madeDeals(calls).length === 1 && madeDeals(calls)[0].email === 'umra@outlook.com',
  JSON.stringify(madeDeals(calls).map(d => d.email)));
/* Both were already there, so both are updates. This is the tally that would break if
   moving the read above the loop had lost the "which did we have" set. */
check('both count as updated rather than added, so the read above the loop still works',
  res.added === 0 && res.updated === 2, JSON.stringify({ a: res.added, u: res.updated }));

// --- a booking we have never seen is still fetched.
calls = stubFetch(planWithStored([
  [E1, 'Umra', 'umra@outlook.com'],
  [E2, 'Kai', 'k@example.com']
], HAVE, [
  { external_id: 'https://cal/s1', invitee: storedInvitee('umra@outlook.com', 'Umra') }
]));
res = await runSync('tok');
check('a booking we have never seen IS fetched -- exactly one, for the new one',
  inviteeCalls(calls) === 1 && calls.some(c => c.url.startsWith('https://cal/s2/invitees')),
  inviteeCalls(calls) + ' invitee requests');
check('and it is the new booking that counts as added',
  res.added === 1 && res.updated === 1, JSON.stringify({ a: res.added, u: res.updated }));

/* THE HEAL PATH. A run that could not read an invitee writes null and says so, and the
   next run is what puts it right. Caching on external_id alone would make that null
   permanent: the row exists, so it would never be asked for again, and ten form answers
   would be lost for the life of the booking because Calendly hiccuped once. */
calls = stubFetch(planWithStored([
  [E1, 'Umra', 'umra@outlook.com'],
  [E2, 'Kai', 'k@example.com']
], HAVE, [
  { external_id: 'https://cal/s1', invitee: null },
  { external_id: 'https://cal/s2', invitee: storedInvitee('k@example.com', 'Kai') }
]));
res = await runSync('tok');
check('a stored row whose invitee is null is fetched again, so a hiccup still heals',
  inviteeCalls(calls) === 1 && calls.some(c => c.url.startsWith('https://cal/s1/invitees')),
  inviteeCalls(calls) + ' invitee requests');
const healed = wroteMeetings(calls).find(r => r.external_id === 'https://cal/s1');
check('and the second run is what actually fills the answers in',
  !!healed && !!healed.invitee && healed.invitee.email === 'umra@outlook.com',
  JSON.stringify(healed && healed.invitee));

/* Half a record is the same failure wearing a different hat: an invitee object with no
   email matches nothing and opens no deal, so it has to be re-read like a null. */
calls = stubFetch(planWithStored([
  [E1, 'Umra', 'umra@outlook.com']
], HAVE, [
  { external_id: 'https://cal/s1', invitee: { name: 'Umra', email: '', qa: [] } }
]));
res = await runSync('tok');
check('a stored invitee with no email is re-read rather than trusted',
  inviteeCalls(calls) === 1, inviteeCalls(calls) + ' invitee requests');
check('and reading it again is what finally opens the deal nobody was tracking',
  madeDeals(calls).length === 1 && madeDeals(calls)[0].email === 'umra@outlook.com',
  JSON.stringify(madeDeals(calls).map(d => d.email)));

/* A cancellation is dropped on status before any of this, and a reschedule arrives as a
   new uri with nothing stored -- which is the whole reason reusing the record is safe,
   and worth measuring rather than asserting in a comment. */
const CANCELLED = Object.assign({}, ev('https://cal/s1', 'Strategy', '2026-11-02T17:00:00Z'),
  { status: 'canceled' });
calls = stubFetch(planWithStored([
  [CANCELLED, 'Umra', 'umra@outlook.com'],
  [E2, 'Kai', 'k@example.com']
], HAVE, [
  { external_id: 'https://cal/s2', invitee: storedInvitee('k@example.com', 'Kai') }
]));
res = await runSync('tok');
check('a cancelled booking is dropped before the cache is ever consulted',
  wroteMeetings(calls).every(r => r.external_id !== 'https://cal/s1'),
  JSON.stringify(wroteMeetings(calls).map(r => r.external_id)));

/* The read that feeds the cache must ask for the invitee column. Selecting external_id
   alone would leave every record undefined, every booking would be fetched, and every
   check above except the heal ones would still pass -- the sync would simply be as slow
   as it was before while looking fixed. */
calls = stubFetch(planWithStored([[E1, 'Umra', 'umra@outlook.com']], HAVE, []));
res = await runSync('tok');
const reads = calls.filter(c => c.url.includes('growth_meetings') && c.opts.method !== 'POST');
check('the stored-booking read asks for the invitee column, not just the id',
  reads.length === 1 && /select=external_id,invitee/.test(reads[0].url),
  reads.length + ' reads: ' + reads.map(r => r.url.split('?')[1]).join(' | '));
check('and it is read ONCE a run, not once for the cache and again for the tally',
  reads.length === 1, reads.length + ' reads of growth_meetings');

globalThis.fetch = realFetch;
for (const r of results) console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   ' + r.detail : ''));
const bad = results.filter(r => !r.pass);
console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' checks passed');
console.log(bad.length ? 'RESULT: ' + bad.length + ' FAILED' : 'RESULT: clean');
process.exit(bad.length ? 1 : 0);
