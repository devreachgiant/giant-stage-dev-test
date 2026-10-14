// Giant as an OAuth 2.1 authorization server, so any AI client can connect any team member.
//
// WHY THIS EXISTS AT ALL. A personal token works in tools that give you somewhere to paste
// one. claude.ai, the Claude desktop app and ChatGPT do not -- they expect to discover an
// authorization server and send the person through a sign-in. Supporting "anyone on the
// team, any assistant" therefore means being that server, not merely being protected by one.
//
// Built to the MCP authorization spec of 2026-07-28, which is a selected subset of OAuth 2.1
// plus RFC 9728 (protected resource metadata), RFC 8414 (AS metadata), RFC 8707 (resource
// indicators) and RFC 9207 (issuer identification). Two things in it are easy to skim past
// and are load-bearing here:
//
//   * The resource server MUST reject a token that was not issued for it. That is why every
//     token row carries an audience and why verifyAccessToken checks it rather than trusting
//     that a valid-looking token is ours.
//   * Dynamic Client Registration is deprecated in favour of Client ID Metadata Documents --
//     a client_id that is itself an https URL serving the client's metadata. Both are
//     supported here: CIMD because it is what the spec now prefers, DCR because the clients
//     people actually have installed today still use it.
//
// Public clients only: no client secret. An app on somebody's laptop cannot keep one, so
// OAuth 2.1 requires PKCE instead, and this refuses any authorization request without it.
//
// Nothing here trusts the browser. Codes and tokens are generated server-side, stored as
// SHA-256 only, and the tables they live in have RLS on with no policies at all.

const crypto = require('crypto');
const { rest } = require('./_mcp_identity');

const ORIGIN = process.env.GIANT_ORIGIN || 'https://giant.reachgiant.com';

const ISSUER        = ORIGIN;
const RESOURCE_URI  = ORIGIN + '/mcp';          // canonical, no trailing slash (RFC 8707 §2)
const SCOPE         = 'giant:read';
const SCOPE_WRITE   = 'giant:read giant:write';
const CODE_TTL_MS   = 60 * 1000;                // one minute: it is redeemed immediately
const TOKEN_TTL_SEC = 60 * 60;                  // an hour, then the refresh token is used

const sha256  = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randTok = ()  => crypto.randomBytes(32).toString('base64url');

// Constant-time where it compares a secret, so a timing difference cannot be walked into a
// valid value one byte at a time.
function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// ── discovery documents ─────────────────────────────────────────────────────
// What a client fetches before it knows anything about us.

function protectedResourceMetadata() {
  return {
    resource: RESOURCE_URI,
    authorization_servers: [ISSUER],
    scopes_supported: ['giant:read', 'giant:write'],
    bearer_methods_supported: ['header'],
    resource_name: 'Giant',
    resource_documentation: ORIGIN + '/mcp',
  };
}

function authorizationServerMetadata() {
  return {
    issuer: ISSUER,
    authorization_endpoint: ORIGIN + '/oauth/authorize',
    token_endpoint:         ORIGIN + '/oauth/token',
    registration_endpoint:  ORIGIN + '/oauth/register',
    revocation_endpoint:    ORIGIN + '/oauth/revoke',
    scopes_supported: ['giant:read', 'giant:write'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // S256 only. "plain" is still in the OAuth text and is worth nothing against an attacker
    // who can read the authorization request, which is the attacker PKCE exists to stop.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    // We do emit iss on every authorization response, so we say so -- a client that sees
    // this set to true and no iss is required by the spec to reject the response.
    authorization_response_iss_parameter_supported: true,
    resource_indicators_supported: true,
    service_documentation: ORIGIN + '/mcp',
  };
}

// ── clients ─────────────────────────────────────────────────────────────────

const isHttpsUrl = (u) => { try { return new URL(u).protocol === 'https:'; } catch (_) { return false; } };

// A redirect_uri is the one thing an attacker would most like to control, so it is matched
// exactly -- never by prefix, never by hostname. Loopback is allowed because that is how
// every desktop client receives its callback, and 'http' is permitted there and only there.
function redirectAllowed(uri, registered) {
  if (!Array.isArray(registered) || !registered.length) return false;
  return registered.some(r => r === uri);
}
function redirectUsable(uri) {
  let u;
  try { u = new URL(uri); } catch (_) { return false; }
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === 'localhost')) return true;
  // Desktop clients commonly register a private-use scheme such as cursor://
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && u.protocol !== 'http:';
}

async function getClient(clientId) {
  if (!clientId) return null;
  const r = await rest(`mcp_clients?client_id=eq.${encodeURIComponent(clientId)}&limit=1`);
  if (r.ok && Array.isArray(r.body) && r.body.length) return r.body[0];
  // A client_id that is an https URL is a Client ID Metadata Document: the spec's replacement
  // for dynamic registration. Fetch it, believe only its redirect_uris, and cache the result
  // so a later authorize does not depend on that host being up.
  if (isHttpsUrl(clientId)) return await registerFromMetadataDocument(clientId);
  return null;
}

async function registerFromMetadataDocument(url) {
  let doc;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'error' });
    if (!res.ok) return null;
    doc = await res.json();
  } catch (_) { return null; }
  // The document must claim the identity it is served from, or anyone could host a document
  // naming someone else's client_id.
  if (!doc || doc.client_id !== url) return null;
  const uris = (doc.redirect_uris || []).filter(redirectUsable);
  if (!uris.length) return null;
  const row = {
    client_id: url,
    client_name: String(doc.client_name || url).slice(0, 200),
    redirect_uris: uris,
    origin: 'cimd',
    metadata: doc,
  };
  await rest('mcp_clients?on_conflict=client_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  return row;
}

async function registerClient(body) {
  const uris = (body && body.redirect_uris) || [];
  if (!Array.isArray(uris) || !uris.length) {
    return { error: 'invalid_redirect_uri', description: 'redirect_uris is required' };
  }
  const bad = uris.find(u => !redirectUsable(u));
  if (bad) {
    return { error: 'invalid_redirect_uri', description: 'Not a usable redirect URI: ' + bad };
  }
  const grants = body.grant_types || ['authorization_code', 'refresh_token'];
  if (grants.some(g => g !== 'authorization_code' && g !== 'refresh_token')) {
    return { error: 'invalid_client_metadata', description: 'Only authorization_code and refresh_token are supported' };
  }
  const clientId = 'giant_mcp_' + crypto.randomBytes(16).toString('hex');
  const row = {
    client_id: clientId,
    client_name: String((body && body.client_name) || 'An AI assistant').slice(0, 200),
    redirect_uris: uris,
    origin: 'dcr',
    metadata: body || {},
  };
  const r = await rest('mcp_clients', {
    method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row),
  });
  if (!r.ok) return { error: 'server_error', description: 'Could not register that client' };
  return {
    registered: {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: row.client_name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Public client: there is no secret to return, and saying so explicitly stops a client
      // from waiting for one.
      token_endpoint_auth_method: 'none',
    },
  };
}

// ── authorization codes ─────────────────────────────────────────────────────

async function issueCode({ clientId, profileId, redirectUri, codeChallenge, resource, scope }) {
  const code = randTok();
  const r = await rest('mcp_auth_codes', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      code_hash: sha256(code),
      client_id: clientId,
      profile_id: profileId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      resource: resource || RESOURCE_URI,
      scope: scope || SCOPE,
      expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    }),
  });
  if (!r.ok) throw new Error('Could not issue an authorization code');
  return code;
}

// Redeeming is where most OAuth implementations get quietly broken, so each condition is
// checked separately and the code is burned before anything is issued.
async function redeemCode({ code, clientId, redirectUri, codeVerifier }) {
  if (!code || !codeVerifier) return { error: 'invalid_request' };
  const hash = sha256(code);
  const r = await rest(`mcp_auth_codes?code_hash=eq.${encodeURIComponent(hash)}&limit=1`);
  if (!r.ok || !Array.isArray(r.body) || !r.body.length) return { error: 'invalid_grant' };
  const row = r.body[0];

  // Burn it first, and only accept the burn if WE were the one who burned it. Two token
  // requests racing with the same code both find an unused row; only the one whose
  // conditional update returns a row may continue.
  const burn = await rest(
    `mcp_auth_codes?code_hash=eq.${encodeURIComponent(hash)}&used_at=is.null`,
    { method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ used_at: new Date().toISOString() }) });
  if (!burn.ok || !Array.isArray(burn.body) || !burn.body.length) return { error: 'invalid_grant' };

  if (new Date(row.expires_at).getTime() < Date.now()) return { error: 'invalid_grant' };
  if (row.client_id !== clientId) return { error: 'invalid_grant' };
  if (row.redirect_uri !== redirectUri) return { error: 'invalid_grant' };

  // PKCE S256: the verifier must hash to the challenge recorded at authorize time.
  const computed = crypto.createHash('sha256').update(String(codeVerifier)).digest('base64url');
  if (!sameSecret(computed, row.code_challenge)) return { error: 'invalid_grant' };

  return { row };
}

// ── access tokens ───────────────────────────────────────────────────────────

async function issueTokens({ clientId, profileId, audience, scope }) {
  const access = randTok();
  const refresh = randTok();
  const r = await rest('mcp_access_tokens', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      client_id: clientId,
      profile_id: profileId,
      token_hash: sha256(access),
      refresh_hash: sha256(refresh),
      audience: audience || RESOURCE_URI,
      scope: scope || SCOPE,
      expires_at: new Date(Date.now() + TOKEN_TTL_SEC * 1000).toISOString(),
    }),
  });
  if (!r.ok) throw new Error('Could not issue a token');
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL_SEC,
    scope: scope || SCOPE,
  };
}

// Rotating refresh: the old refresh token stops working the moment a new one is handed out,
// so a stolen one is usable at most until the real client next refreshes -- at which point
// the theft shows up as the legitimate client being logged out.
async function refreshTokens({ refreshToken, clientId }) {
  if (!refreshToken) return { error: 'invalid_request' };
  const hash = sha256(refreshToken);
  const r = await rest(`mcp_access_tokens?refresh_hash=eq.${encodeURIComponent(hash)}&limit=1`);
  if (!r.ok || !Array.isArray(r.body) || !r.body.length) return { error: 'invalid_grant' };
  const row = r.body[0];
  if (row.revoked_at) return { error: 'invalid_grant' };
  if (clientId && row.client_id !== clientId) return { error: 'invalid_grant' };

  const access = randTok();
  const refresh = randTok();
  const upd = await rest(
    `mcp_access_tokens?id=eq.${row.id}&refresh_hash=eq.${encodeURIComponent(hash)}`,
    { method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        token_hash: sha256(access),
        refresh_hash: sha256(refresh),
        expires_at: new Date(Date.now() + TOKEN_TTL_SEC * 1000).toISOString(),
      }) });
  if (!upd.ok || !Array.isArray(upd.body) || !upd.body.length) return { error: 'invalid_grant' };

  return { tokens: {
    access_token: access, refresh_token: refresh, token_type: 'Bearer',
    expires_in: TOKEN_TTL_SEC, scope: row.scope,
  } };
}

// The check the resource server makes on every single request.
async function verifyAccessToken(presented) {
  if (!presented) return null;
  const r = await rest(
    `mcp_access_tokens?select=id,profile_id,audience,scope,expires_at,revoked_at,` +
    `mcp_clients(client_name),profiles(id,full_name,email,role)` +
    `&token_hash=eq.${encodeURIComponent(sha256(presented))}&limit=1`);
  if (!r.ok || !Array.isArray(r.body) || !r.body.length) return null;
  const row = r.body[0];
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  // "MUST validate that access tokens were issued specifically for them as the intended
  // audience". A token minted for anything else is not ours and is refused here.
  if (row.audience !== RESOURCE_URI) return null;
  const prof = row.profiles || {};
  // Same rule the personal tokens follow: somebody who has become a client-portal account
  // stops being able to drive an assistant over this workspace, whatever they hold.
  if (String(prof.role || 'client').toLowerCase() === 'client') return null;
  rest(`mcp_access_tokens?id=eq.${row.id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  }).catch(() => {});
  return { profileId: row.profile_id, role: prof.role, name: prof.full_name,
           email: prof.email, scope: row.scope || 'giant:read', via: 'oauth',
           clientName: (row.mcp_clients || {}).client_name || null };
}

module.exports = {
  ISSUER, RESOURCE_URI, SCOPE, SCOPE_WRITE, ORIGIN, TOKEN_TTL_SEC,
  sha256, randTok, sameSecret,
  protectedResourceMetadata, authorizationServerMetadata,
  getClient, registerClient, registerFromMetadataDocument,
  redirectAllowed, redirectUsable, isHttpsUrl,
  issueCode, redeemCode, issueTokens, refreshTokens, verifyAccessToken,
};
