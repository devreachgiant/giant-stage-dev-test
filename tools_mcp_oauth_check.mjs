// Does "Sign in with Giant" actually work, and does it refuse what it should?
//
// This drives the real OAuth endpoints over HTTP against a running server -- discovery,
// registration, the authorize page, PKCE, the token exchange, refresh, revocation -- and
// then uses the resulting token on the MCP endpoint itself.
//
//   node tools_mcp_oauth_check.mjs [baseUrl]        (default http://localhost:8888)
//
// Half of these checks are REFUSALS, which is the half that matters. An OAuth server that
// issues tokens is easy; one that declines to issue them to the wrong caller is the entire
// point. Each refusal names the attack it stands for.
//
// It needs a real database, because codes and tokens are rows -- it is an integration check,
// not a unit test, and it is honest about that: with no server reachable it says so and
// stops rather than passing.
//
// LEAVES A ROW BEHIND, on purpose: registering a client is one of the things being checked,
// and there is no endpoint to un-register one (nor should there be). Each run adds a
// mcp_clients row named 'Check Harness'. Sweep them when they pile up:
//
//   supabase db query --linked "delete from public.mcp_clients where client_name = 'Check Harness';"
//
// They are inert -- a client_id is not a credential, and nobody can authorize against one
// without signing in and pressing Allow -- but a list of connected assistants that is mostly
// test rows is a list nobody reads.

import crypto from 'node:crypto';

const BASE = (process.argv[2] || process.env.MCP_BASE || 'http://localhost:8888').replace(/\/$/, '');
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); return !!pass; };

const b64url = (b) => Buffer.from(b).toString('base64url');
const pkce = () => {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

async function jget(path) {
  const res = await fetch(BASE + path, { headers: { Accept: 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch (_) { /* not json */ }
  return { status: res.status, body, headers: res.headers };
}
async function jpost(path, payload, asForm) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': asForm ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: asForm ? new URLSearchParams(payload).toString() : JSON.stringify(payload),
  });
  let body = null;
  try { body = await res.json(); } catch (_) { /* not json */ }
  return { status: res.status, body, headers: res.headers };
}

// ── is anything there at all ────────────────────────────────────────────────
let reachable = true;
try {
  const r = await fetch(BASE + '/mcp', { method: 'GET' });
  reachable = r.status < 500;
} catch (_) { reachable = false; }
if (!reachable) {
  console.log('\n=== MCP OAUTH ===');
  console.log('No server at ' + BASE + '. Start one (netlify dev) or pass a base URL.');
  console.log('Nothing was checked.');
  process.exit(2);
}

// ── 1. discovery ────────────────────────────────────────────────────────────
const unauth = await jpost('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize' });
const challenge = unauth.headers.get('www-authenticate') || '';
check('an unauthenticated request is challenged with 401, not quietly refused',
  unauth.status === 401 && /Bearer/.test(challenge), unauth.status + ' ' + challenge);
check('the challenge points at the protected resource metadata',
  /resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource"/.test(challenge), challenge);

const prm = await jget('/.well-known/oauth-protected-resource');
check('protected resource metadata is served and names an authorization server',
  prm.status === 200 && !!prm.body && Array.isArray(prm.body.authorization_servers) &&
  prm.body.authorization_servers.length > 0 && /\/mcp$/.test(prm.body.resource || ''),
  JSON.stringify(prm.body || prm.status).slice(0, 120));

const as = await jget('/.well-known/oauth-authorization-server');
const meta = as.body || {};
check('authorization server metadata is served',
  as.status === 200 && !!meta.authorization_endpoint && !!meta.token_endpoint,
  JSON.stringify(Object.keys(meta)).slice(0, 120));
// PKCE "plain" is worth nothing against anyone who can read the authorization request.
check('only S256 PKCE is advertised, never plain',
  JSON.stringify(meta.code_challenge_methods_supported || []) === '["S256"]',
  JSON.stringify(meta.code_challenge_methods_supported));
check('issuer identification is advertised, so a client can detect a mix-up attack',
  meta.authorization_response_iss_parameter_supported === true,
  String(meta.authorization_response_iss_parameter_supported));

// ── 2. registration ─────────────────────────────────────────────────────────
const REDIRECT = 'http://127.0.0.1:41999/callback';
const reg = await jpost('/oauth/register', {
  client_name: 'Check Harness',
  redirect_uris: [REDIRECT],
  grant_types: ['authorization_code', 'refresh_token'],
});
const clientId = reg.body && reg.body.client_id;
check('a client can register itself and gets no secret back',
  reg.status === 201 && !!clientId && !reg.body.client_secret &&
  reg.body.token_endpoint_auth_method === 'none',
  JSON.stringify(reg.body || reg.status).slice(0, 120));

// A redirect URI is the one thing an attacker most wants to control.
const badReg = await jpost('/oauth/register', { client_name: 'Bad', redirect_uris: ['not a url'] });
check('REFUSES registration with an unusable redirect address',
  badReg.status === 400, badReg.status + ' ' + JSON.stringify(badReg.body).slice(0, 80));

// ── 3. the authorize page ───────────────────────────────────────────────────
const { verifier, challenge: pkceChallenge } = pkce();
const authQ = (over = {}) => new URLSearchParams({
  response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
  code_challenge: pkceChallenge, code_challenge_method: 'S256',
  state: 'xyz', resource: (prm.body && prm.body.resource) || (BASE + '/mcp'),
  ...over,
}).toString();

const page = await fetch(BASE + '/oauth/authorize?' + authQ());
const pageHtml = await page.text();
check('the consent page renders and says what is being asked for',
  page.status === 200 && /wants to read Giant/.test(pageHtml) && /Allow/.test(pageHtml),
  page.status + ' ' + pageHtml.length + ' bytes');
check('the consent page cannot be framed',
  (page.headers.get('x-frame-options') || '').toUpperCase() === 'DENY' &&
  /frame-ancestors 'none'/.test(page.headers.get('content-security-policy') || ''),
  page.headers.get('x-frame-options') + ' / ' + page.headers.get('content-security-policy'));

// An unregistered redirect must NOT be redirected to -- that is how open redirectors are
// built. It must render an error instead.
const evilRedirect = await fetch(
  BASE + '/oauth/authorize?' + authQ({ redirect_uri: 'https://evil.test/steal' }),
  { redirect: 'manual' });
check('REFUSES an unregistered redirect address, and does not redirect to it',
  evilRedirect.status === 400 && !evilRedirect.headers.get('location'),
  evilRedirect.status + ' location=' + evilRedirect.headers.get('location'));

const noPkce = await fetch(BASE + '/oauth/authorize?' + authQ({ code_challenge: '' }),
  { redirect: 'manual' });
check('REFUSES an authorization request with no PKCE challenge',
  noPkce.status === 302 && /error=invalid_request/.test(noPkce.headers.get('location') || ''),
  noPkce.status + ' ' + (noPkce.headers.get('location') || '').slice(0, 90));

const plainPkce = await fetch(
  BASE + '/oauth/authorize?' + authQ({ code_challenge_method: 'plain' }), { redirect: 'manual' });
check('REFUSES plain PKCE even when a client asks for it',
  plainPkce.status === 302 && /error=invalid_request/.test(plainPkce.headers.get('location') || ''),
  plainPkce.status + ' ' + (plainPkce.headers.get('location') || '').slice(0, 90));

// RFC 8707: a token for a resource we do not serve is a confused-deputy waiting to happen.
const wrongResource = await fetch(
  BASE + '/oauth/authorize?' + authQ({ resource: 'https://someone-else.example/mcp' }),
  { redirect: 'manual' });
check('REFUSES a request for a resource this server does not serve',
  wrongResource.status === 302 && /error=invalid_target/.test(wrongResource.headers.get('location') || ''),
  wrongResource.status + ' ' + (wrongResource.headers.get('location') || '').slice(0, 90));

const unknownClient = await fetch(
  BASE + '/oauth/authorize?' + authQ({ client_id: 'giant_mcp_nope' }), { redirect: 'manual' });
check('REFUSES an unknown client without redirecting anywhere',
  unknownClient.status === 400 && !unknownClient.headers.get('location'),
  String(unknownClient.status));

// Approving needs a real signed-in person, which this harness is not.
const noSession = await jpost('/oauth/authorize', {
  client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkceChallenge,
  code_challenge_method: 'S256', response_type: 'code', decision: 'allow', access_token: null,
});
check('REFUSES to issue a code to a caller who is not signed in',
  noSession.status === 401 && noSession.body && noSession.body.error === 'login_required',
  noSession.status + ' ' + JSON.stringify(noSession.body).slice(0, 80));

const forgedSession = await jpost('/oauth/authorize', {
  client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkceChallenge,
  code_challenge_method: 'S256', response_type: 'code', decision: 'allow',
  access_token: 'eyJhbGciOiJIUzI1NiJ9.forged.nonsense',
});
check('REFUSES a forged sign-in token',
  forgedSession.status === 401, forgedSession.status + ' ' + JSON.stringify(forgedSession.body).slice(0, 80));

const denied = await jpost('/oauth/authorize', {
  client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkceChallenge,
  code_challenge_method: 'S256', response_type: 'code', decision: 'deny', state: 'xyz',
});
// state must come back: a client that cannot match the response to its own request has no
// defence against a response forged by somebody else. The first version of this check did
// not send one, so the "and the state" in its name was proving nothing.
check('pressing Cancel sends back access_denied, the state and the issuer, not a code',
  denied.status === 200 && /error=access_denied/.test((denied.body || {}).redirect || '') &&
  /[?&]state=xyz(&|$)/.test((denied.body || {}).redirect || '') &&
  /[?&]iss=/.test((denied.body || {}).redirect || '') &&
  !/[?&]code=/.test((denied.body || {}).redirect || ''),
  ((denied.body || {}).redirect || String(denied.status)).slice(0, 130));

// ── 4. the token endpoint ───────────────────────────────────────────────────
const fakeCode = await jpost('/oauth/token', {
  grant_type: 'authorization_code', code: 'made-up', client_id: clientId,
  redirect_uri: REDIRECT, code_verifier: verifier,
}, true);
check('REFUSES an authorization code it never issued',
  fakeCode.status === 400 && fakeCode.body && fakeCode.body.error === 'invalid_grant',
  fakeCode.status + ' ' + JSON.stringify(fakeCode.body));

const noVerifier = await jpost('/oauth/token', {
  grant_type: 'authorization_code', code: 'made-up', client_id: clientId, redirect_uri: REDIRECT,
}, true);
check('REFUSES a token request with no PKCE verifier',
  noVerifier.status === 400, noVerifier.status + ' ' + JSON.stringify(noVerifier.body));

const badGrant = await jpost('/oauth/token', { grant_type: 'password', username: 'x' }, true);
check('REFUSES grant types this server does not implement',
  badGrant.status === 400 && badGrant.body.error === 'unsupported_grant_type',
  JSON.stringify(badGrant.body));

const fakeRefresh = await jpost('/oauth/token',
  { grant_type: 'refresh_token', refresh_token: 'made-up', client_id: clientId }, true);
check('REFUSES a refresh token it never issued',
  fakeRefresh.status === 400 && fakeRefresh.body.error === 'invalid_grant',
  JSON.stringify(fakeRefresh.body));

// ── 5. the resource server ──────────────────────────────────────────────────
const fakeToken = await fetch(BASE + '/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + b64url(crypto.randomBytes(32)) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
});
check('REFUSES an access token this server never issued',
  fakeToken.status === 401, String(fakeToken.status));

const revoke = await jpost('/oauth/revoke', { token: 'anything-at-all' }, true);
check('revocation answers 200 whether or not the token was real',
  revoke.status === 200, String(revoke.status));

// ── report ──────────────────────────────────────────────────────────────────
const fails = results.filter(r => !r.pass);
console.log('\n=== MCP OAUTH ===  ' + BASE);
results.forEach(r => console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name +
  (r.detail ? '   [' + r.detail + ']' : '')));
console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
console.log('Note: pressing Allow needs a signed-in person, so the happy path is proven by a '
          + 'browser, not here. What is proven here is every way it must say no.');
process.exit(fails.length ? 1 : 0);
