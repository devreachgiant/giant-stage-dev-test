/* growth-zoom.js, without a browser or a network.
   Run:  node tools_growth_zoom_check.mjs          (~1s)

   The browser suite drives the Connectors screen and watches what it POSTs. It cannot
   reach the two things that actually matter here, because both live inside the function:

     1. WHICH CREDENTIALS WIN. The table has to beat the environment. If the environment
        won, connecting in the app would appear to work and then quietly keep minting
        with the old Netlify keys -- the worst shape of bug this repo keeps shipping,
        because every screen says the right thing while the wrong credential is in use.

     2. WHO IS ALLOWED TO WRITE. These are ACCOUNT-level Zoom credentials: whoever holds
        them can create and read meetings across the whole Zoom account. The role is
        decided here from the caller's own login, never from anything the page sends.

   fetch is replaced with a script: each call is matched by URL and answered from a plan,
   so no request leaves the machine and no secret is real. Every assertion was watched to
   fail with the behaviour inverted -- the sabotage lines are in the commit message. */

import assert from 'node:assert';

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); };

const SUPA = 'https://example.supabase.co';
const realFetch = globalThis.fetch;

/* Answer calls by URL fragment. Anything unplanned throws rather than returning a
   plausible empty object: a stub that quietly answers a question the code should not
   have asked is how a test passes while measuring nothing. */
function stubFetch(plan) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts: opts || {} });
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

const secretRow = (v) => [{ value: JSON.stringify(v), label: 'zoom@reachgiant.com' }];
const MINTED = { body: { access_token: 'tok-1', scope: 'meeting:write' } };

process.env.SUPABASE_URL = SUPA;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-not-real';

const mod = await import('./netlify/functions/growth-zoom.js');
const { zoomCreds, handler, meetingNumber } = mod.default || mod;

/* ---------------------------------------------------------------- which wins */
process.env.ZOOM_ACCOUNT_ID = 'ENV-ACC';
process.env.ZOOM_CLIENT_ID = 'ENV-CID';
process.env.ZOOM_CLIENT_SECRET = 'ENV-SECRET';

stubFetch([['growth_secrets', { body: secretRow({
  account_id: 'DB-ACC', client_id: 'DB-CID', client_secret: 'DB-SECRET' }) }]]);
let creds = await zoomCreds();
check('the row beats the environment, so connecting in the app really takes effect',
  creds && creds.accountId === 'DB-ACC' && creds.clientSecret === 'DB-SECRET',
  JSON.stringify(creds && { id: creds.accountId, source: creds.source }));
check('and it says it came from the app, so the screen can offer Disconnect',
  creds && creds.source === 'app', creds && creds.source);

stubFetch([['growth_secrets', { body: [] }]]);
creds = await zoomCreds();
check('with no row it falls back to Netlify, so nothing that works today stops',
  creds && creds.accountId === 'ENV-ACC' && creds.source === 'netlify',
  JSON.stringify(creds && { id: creds.accountId, source: creds.source }));

/* A half-written row is not a credential. Falling through to the environment beats
   handing Zoom two values and a blank. */
stubFetch([['growth_secrets', { body: secretRow({ account_id: 'DB-ACC', client_id: 'DB-CID' }) }]]);
creds = await zoomCreds();
check('a row missing the secret is ignored rather than used half-filled',
  creds && creds.source === 'netlify', JSON.stringify(creds && creds.source));

stubFetch([['growth_secrets', { body: [{ value: 'not json at all', label: '' }] }]]);
creds = await zoomCreds();
check('and so is a row that will not parse', creds && creds.source === 'netlify',
  JSON.stringify(creds && creds.source));

delete process.env.ZOOM_ACCOUNT_ID;
delete process.env.ZOOM_CLIENT_ID;
delete process.env.ZOOM_CLIENT_SECRET;
stubFetch([['growth_secrets', { body: [] }]]);
creds = await zoomCreds();
check('neither set is honestly nothing, not an empty-string credential',
  creds === null, JSON.stringify(creds));

/* ---------------------------------------------------------------- who may write */
const GOOD_BODY = JSON.stringify({ account_id: 'A', client_id: 'C', client_secret: 'S' });
const save = (headers, body) => handler({
  queryStringParameters: { action: 'save' },
  headers: headers || {},
  body: body === undefined ? GOOD_BODY : body
});

let calls = stubFetch([['growth_secrets', { body: [] }]]);
let res = await save({});
check('no login cannot save a credential', res.statusCode === 401, String(res.statusCode));
check('and nothing was written on the way to refusing',
  !calls.some(c => (c.opts.method || 'GET') !== 'GET'),
  JSON.stringify(calls.map(c => (c.opts.method || 'GET'))));

// Signed in, but a rep. Growth is theirs to use, not to re-point at another Zoom account.
calls = stubFetch([
  ['/auth/v1/user', { body: { id: 'u-rep' } }],
  ['profiles?id=eq.u-rep', { body: [{ id: 'u-rep', role: 'rep' }] }],
  ['growth_secrets', { body: [] }]
]);
res = await save({ authorization: 'Bearer x' });
check('a signed-in rep cannot either', res.statusCode === 403, String(res.statusCode));
check('and still nothing was written',
  !calls.some(c => (c.opts.method || 'GET') !== 'GET'),
  JSON.stringify(calls.map(c => (c.opts.method || 'GET'))));

// A manager, but the credentials are wrong: proved BEFORE storing, not after.
calls = stubFetch([
  ['/auth/v1/user', { body: { id: 'u-mgr' } }],
  ['profiles?id=eq.u-mgr', { body: [{ id: 'u-mgr', role: 'manager' }] }],
  ['zoom.us/oauth/token', { ok: false, status: 400, body: { reason: 'Invalid client' } }],
  ['growth_secrets', { body: [] }]
]);
res = await save({ authorization: 'Bearer x' });
check('a credential Zoom refuses is not stored', res.statusCode === 400, String(res.statusCode));
check('nothing reached the table', !calls.some(c => c.url.includes('growth_secrets') && c.opts.method === 'POST'),
  JSON.stringify(calls.map(c => c.url.split('/').pop().slice(0, 28))));

// A manager with credentials that work.
calls = stubFetch([
  ['/auth/v1/user', { body: { id: 'u-mgr' } }],
  ['profiles?id=eq.u-mgr', { body: [{ id: 'u-mgr', role: 'manager' }] }],
  ['zoom.us/oauth/token', MINTED],
  ['api.zoom.us/v2/users/me', { body: { email: 'zoom@reachgiant.com' } }],
  ['growth_secrets', { body: [{}] }]
]);
res = await save({ authorization: 'Bearer x' });
const wrote = calls.find(c => c.url.includes('growth_secrets') && c.opts.method === 'POST');
let stored = null;
try { stored = JSON.parse(wrote.opts.body)[0]; } catch (e) { /* reported below */ }
check('a manager with working credentials does save', res.statusCode === 200, String(res.statusCode));
check('all three land in ONE row, so there is no two-of-three state to be in',
  stored && JSON.parse(stored.value).account_id === 'A' &&
  JSON.parse(stored.value).client_id === 'C' && JSON.parse(stored.value).client_secret === 'S',
  stored && stored.key);
check('stamped with who did it', stored && stored.updated_by === 'u-mgr', stored && stored.updated_by);
check('and the reply never carries the secret back',
  !/\bS\b/.test(res.body) && !res.body.includes('client_secret'), res.body);

/* A Server-to-Server app scoped only to meetings cannot read /users/me. Refusing a
   working credential over a missing scope would be the screen lying the other way. */
calls = stubFetch([
  ['/auth/v1/user', { body: { id: 'u-mgr' } }],
  ['profiles?id=eq.u-mgr', { body: [{ id: 'u-mgr', role: 'manager' }] }],
  ['zoom.us/oauth/token', MINTED],
  ['api.zoom.us/v2/users/me', { ok: false, status: 403, body: { message: 'no scope' } }],
  ['growth_secrets', { body: [{}] }]
]);
res = await save({ authorization: 'Bearer x' });
check('a credential that cannot read its own account name is still accepted',
  res.statusCode === 200, String(res.statusCode) + ' ' + res.body);

// Two of three never gets as far as Zoom.
calls = stubFetch([
  ['/auth/v1/user', { body: { id: 'u-mgr' } }],
  ['profiles?id=eq.u-mgr', { body: [{ id: 'u-mgr', role: 'manager' }] }]
]);
res = await save({ authorization: 'Bearer x' }, JSON.stringify({ account_id: 'A', client_id: 'C' }));
check('two of the three is refused before Zoom is even asked',
  res.statusCode === 400 && !calls.some(c => c.url.includes('zoom.us')), String(res.statusCode));

/* ------------------------------------------------- pulling calls in from Zoom

   The duplicate is the whole problem here. Every Calendly booking in this account
   already carries a Zoom join link, so the same call comes back from both sides with
   two different external_ids. Nothing in the browser can see that: the page holds one
   page of meetings and the unique index is on external_id, which differs. If these
   checks are wrong, Meetings silently doubles. */

const ZOOM_OK = { id: 'u-mgr', role: 'manager' };
const sched = (list) => (u) => u.includes('type=scheduled')
  ? { body: { meetings: list, next_page_token: '' } }
  : { body: { meetings: [], next_page_token: '' } };

// Build a plan for one sync. `rows` is what growth_meetings already holds.
function syncPlan(meetings, rows, who) {
  return [
    ['/auth/v1/user', { body: { id: (who || ZOOM_OK).id } }],
    ['profiles?id=eq.', { body: [who || ZOOM_OK] }],
    ['growth_secrets', { body: secretRow({
       account_id: 'A', client_id: 'C', client_secret: 'S' }) }],
    ['zoom.us/oauth/token', MINTED],
    // more specific than /users/me, so it must come first
    ['/users/me/meetings', typeof meetings === 'function' ? meetings : sched(meetings)],
    ['growth_meetings', (u, o) => o.method === 'POST'
       ? { body: [{}] } : { body: rows || [] }]
  ];
}
const doSync = (headers) => handler({
  queryStringParameters: { action: 'sync_meetings' },
  headers: headers === undefined ? { authorization: 'Bearer x' } : headers,
  body: ''
});
const posted = (calls) => {
  const w = calls.find(c => c.url.includes('growth_meetings') && c.opts.method === 'POST');
  try { return w ? JSON.parse(w.opts.body) : []; } catch (e) { return []; }
};

/* The one that matters. A Calendly row whose join link carries meeting number 88123,
   and Zoom handing back that same meeting. One call, so one row. */
calls = stubFetch(syncPlan(
  [{ id: 88123, topic: 'Strategy call', start_time: '2026-11-02T17:00:00Z',
     duration: 45, join_url: 'https://us06web.zoom.us/j/88123?pwd=x' }],
  [{ zoom_url: 'https://us06web.zoom.us/j/88123?pwd=x', external_id: 'https://api.calendly.com/scheduled_events/abc' }]));
res = await doSync();
let body = JSON.parse(res.body);
check('a Zoom call already on the screen through Calendly is not added twice',
  res.statusCode === 200 && body.added === 0 && body.duplicate === 1,
  res.body);
check('and nothing at all was written for it',
  posted(calls).length === 0, JSON.stringify(posted(calls).map(r => r.external_id)));

/* ...while a call that genuinely is not there yet does land. Without this the check
   above passes just as well on code that inserts nothing, ever. */
calls = stubFetch(syncPlan(
  [{ id: 99999, topic: 'Discovery with Rob', start_time: '2026-11-03T14:00:00Z',
     duration: 30, join_url: 'https://us06web.zoom.us/j/99999' }],
  [{ zoom_url: 'https://us06web.zoom.us/j/88123?pwd=x', external_id: 'cal-abc' }]));
res = await doSync();
body = JSON.parse(res.body);
let wrote2 = posted(calls);
check('a Zoom call that is not on the screen yet is added',
  res.statusCode === 200 && body.added === 1 && wrote2.length === 1,
  res.body);
check('stored under the meeting number, so the next sync recognises it',
  wrote2[0] && wrote2[0].external_id === 'zoom:99999', wrote2[0] && wrote2[0].external_id);
check('tagged Zoom, so the screen can tell the two sources apart',
  wrote2[0] && wrote2[0].source === 'Zoom', wrote2[0] && wrote2[0].source);
check('and left unattached rather than filed under the host’s own deal',
  wrote2[0] && wrote2[0].client_id === null, JSON.stringify(wrote2[0] && wrote2[0].client_id));

/* A row this function wrote last time is recognised by its external_id, not only by a
   join link -- a meeting whose link was cleared would otherwise come back every sync. */
calls = stubFetch(syncPlan(
  [{ id: 77777, topic: 'Repeat', start_time: '2026-11-04T10:00:00Z', duration: 30, join_url: '' }],
  [{ zoom_url: '', external_id: 'zoom:77777' }]));
res = await doSync();
check('a call synced earlier is not added again even with no link on the row',
  JSON.parse(res.body).added === 0 && JSON.parse(res.body).duplicate === 1, res.body);

/* Recurring-with-no-fixed-time has no start. Giving it today's date would park a phantom
   call on today's list every single sync. */
calls = stubFetch(syncPlan(
  [{ id: 55555, topic: 'Recurring standup', duration: 30, join_url: 'https://us06web.zoom.us/j/55555' }],
  []));
res = await doSync();
body = JSON.parse(res.body);
check('a recurring meeting with no fixed time is counted, not dated',
  body.added === 0 && body.undated === 1, res.body);

/* Zoom pages. A next_page_token that goes unsent returns page one forever. */
let pages = 0;
calls = stubFetch(syncPlan((u) => {
  if (!u.includes('type=scheduled')) return { body: { meetings: [] } };
  pages++;
  return u.includes('next_page_token=')
    ? { body: { meetings: [{ id: 222, topic: 'p2', start_time: '2026-11-06T09:00:00Z',
        duration: 30, join_url: 'https://us06web.zoom.us/j/222' }], next_page_token: '' } }
    : { body: { meetings: [{ id: 111, topic: 'p1', start_time: '2026-11-05T09:00:00Z',
        duration: 30, join_url: 'https://us06web.zoom.us/j/111' }], next_page_token: 'PAGE2' } };
}, []));
res = await doSync();
check('the second page is fetched, so a long history is not silently cut off',
  JSON.parse(res.body).added === 2 && pages === 2,
  'added=' + JSON.parse(res.body).added + ' pages=' + pages);

/* The scope Zoom is missing today. A raw "Zoom 400" would send somebody looking at the
   keys, which are fine -- the fix is in the Zoom app's own settings. */
calls = stubFetch([
  ['/auth/v1/user', { body: { id: 'u-mgr' } }],
  ['profiles?id=eq.', { body: [ZOOM_OK] }],
  ['growth_secrets', { body: secretRow({ account_id: 'A', client_id: 'C', client_secret: 'S' }) }],
  ['zoom.us/oauth/token', MINTED],
  ['/users/me/meetings', { ok: false, status: 400, body: { message:
    'Invalid access token, does not contain scopes:[meeting:read:list_meetings, meeting:read:list_meetings:admin].' } }]
]);
res = await doSync();
body = JSON.parse(res.body);
check('a missing scope names the scope instead of saying 400',
  res.statusCode === 400 && /meeting:read:list_meetings:admin/.test(body.error) &&
  /marketplace/i.test(body.error), body.error);
check('and is flagged as a scope problem, so the panel can keep it on screen',
  body.scope === true, JSON.stringify(body.scope));
check('nothing was written when the list could not be read',
  !calls.some(c => c.url.includes('growth_meetings') && c.opts.method === 'POST'), '');

/* Same gate as save. These calls are account-wide. */
calls = stubFetch(syncPlan([], [], { id: 'u-rep', role: 'rep' }));
res = await doSync();
check('a signed-in rep cannot pull the account’s calls in',
  res.statusCode === 403, String(res.statusCode));
check('and nothing was written on the way to refusing',
  !calls.some(c => (c.opts.method || 'GET') !== 'GET'), '');

calls = stubFetch(syncPlan([], []));
res = await doSync({});
check('no login cannot either', res.statusCode === 401, String(res.statusCode));

/* The helper the de-duplicating rests on. */
check('a join link gives up its meeting number',
  meetingNumber('https://us06web.zoom.us/j/88123?pwd=abc') === '88123',
  meetingNumber('https://us06web.zoom.us/j/88123?pwd=abc'));
check('and a Google Meet link in the same column gives nothing rather than a wrong number',
  meetingNumber('https://meet.google.com/abc-defg-hij') === '',
  JSON.stringify(meetingNumber('https://meet.google.com/abc-defg-hij')));

globalThis.fetch = realFetch;
for (const r of results) console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   ' + r.detail : ''));
const bad = results.filter(r => !r.pass);
console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' checks passed');
console.log(bad.length ? 'RESULT: ' + bad.length + ' FAILED' : 'RESULT: clean');
process.exit(bad.length ? 1 : 0);
