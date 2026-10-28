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
const { zoomCreds, handler } = mod.default || mod;

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

globalThis.fetch = realFetch;
for (const r of results) console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   ' + r.detail : ''));
const bad = results.filter(r => !r.pass);
console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' checks passed');
console.log(bad.length ? 'RESULT: ' + bad.length + ' FAILED' : 'RESULT: clean');
process.exit(bad.length ? 1 : 0);
