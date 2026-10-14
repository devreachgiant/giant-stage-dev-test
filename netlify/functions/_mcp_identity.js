// Turning a Giant API token into a Supabase session for the person who owns it.
//
// This is the whole security model of the MCP server, so it is worth being explicit about
// why it is shaped this way.
//
// Everything an assistant asks for is executed AS the token's owner, using a real Supabase
// session for that person. Row-level security then decides what comes back, exactly as it
// does when they open the app. Connecting an assistant can therefore never show somebody
// more than they could already see.
//
// The alternative -- querying with the service-role key and filtering in this file -- would
// mean re-implementing every policy in the database in JavaScript, and keeping the two in
// step forever. The first time they drift is a leak, and nothing would report it.
//
// Why a session is MINTED rather than signed here: this project signs JWTs with an
// asymmetric key (ECC P-256) and only Supabase holds the private half. The old HS256 shared
// secret is marked "previous" in the dashboard and flagged to revoke, so signing with it
// would be building on something scheduled for removal. Asking Supabase for a session by
// way of a one-time link uses the current keys and keeps working after the old one goes.
//
// generate_link does NOT send an email. It returns a token; /auth/v1/verify exchanges it
// for a session. Both are server-side and need the service role, which is why this lives in
// a function and never near the browser.

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY;

const TOKEN_PREFIX = 'giant_sk_';

// Sessions last an hour; reuse one rather than minting per tool call. The cache lives in the
// function instance, so it dies with it -- which is the right lifetime for a credential.
const sessions = new Map();   // profile_id -> { token, expires }

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function newToken() {
  const raw = TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
  return { raw, hash: sha256(raw), prefix: raw.slice(0, TOKEN_PREFIX.length + 4) };
}

async function rest(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
  return { ok: res.ok, status: res.status, body };
}

// The token presented by the assistant -> the person it belongs to.
//
// Looked up by HASH. The raw token is never stored, so a leaked backup hands nobody a
// working key, and this is also why a token can only be shown once.
async function profileForToken(presented) {
  if (!presented || !String(presented).startsWith(TOKEN_PREFIX)) return null;
  const hash = sha256(presented);
  const r = await rest(
    `api_tokens?select=id,profile_id,revoked_at,scope,name,profiles(id,full_name,email,role)` +
    `&token_hash=eq.${encodeURIComponent(hash)}&limit=1`);
  if (!r.ok || !Array.isArray(r.body) || !r.body.length) return null;
  const row = r.body[0];
  if (row.revoked_at) return null;
  const prof = row.profiles || {};
  // A client-portal login has no business driving an assistant over this workspace. The
  // insert policy already refuses to create one; this refuses to honour a token whose owner
  // has since BECOME a client, which the policy cannot retroactively do.
  if (String(prof.role || 'client').toLowerCase() === 'client') return null;
  // Best-effort: knowing when a token was last used is most of what makes one auditable.
  rest(`api_tokens?id=eq.${row.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  }).catch(() => {});
  return { tokenId: row.id, profileId: row.profile_id, role: prof.role,
           name: prof.full_name, email: prof.email,
           scope: row.scope || 'giant:read', via: 'token', clientName: row.name || null };
}

// A real session for that person, so the database applies their permissions and not ours.
async function sessionFor(profile) {
  const cached = sessions.get(profile.profileId);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;

  const gen = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
               'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email: profile.email }),
  });
  if (!gen.ok) {
    throw new Error(`Could not start a session for this user (${gen.status}). ` +
      `Check SUPABASE_SERVICE_ROLE_KEY is set for this site.`);
  }
  const link = await gen.json();
  const hashed = link.hashed_token || (link.properties && link.properties.hashed_token);
  if (!hashed) throw new Error('Supabase returned no one-time token');

  // token_hash, NOT token. generate_link returns a HASHED token, and /auth/v1/verify takes
  // that under token_hash -- the `token` field is for the six-digit code it also returns as
  // email_otp. Sent under the wrong name it answers 400 and the connection fails at the
  // first question with nothing to go on.
  const ver = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed }),
  });
  if (!ver.ok) {
    const why = await ver.text().catch(() => '');
    throw new Error(`Could not complete the session (${ver.status}) ${why.slice(0, 160)}`);
  }
  const sess = await ver.json();
  if (!sess.access_token) throw new Error('Supabase returned no access token');

  sessions.set(profile.profileId, {
    token: sess.access_token,
    expires: Date.now() + ((sess.expires_in || 3600) * 1000),
  });
  return sess.access_token;
}

// Every read an MCP tool makes goes through here, with the PERSON's token -- never the
// service key. If a policy would refuse them in the app, it refuses them here.
async function asUser(accessToken, path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Giant refused that request (${res.status}): ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch (_) { return []; }
}

// Writing, as the person. Same session, same policies -- if the database would refuse them
// doing this by hand, it refuses here, and the zero-rows case is reported rather than
// swallowed. PostgREST answers a refused write with no rows and no error, which is how a
// silent failure becomes a bug report three days later.
async function writeAsUser(accessToken, path, method, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Giant refused that (${res.status}): ${text.slice(0, 200)}`);
  let rows = [];
  try { rows = JSON.parse(text); } catch (_) { rows = []; }
  if (!Array.isArray(rows)) rows = [rows];
  if (!rows.length) {
    throw new Error('Giant would not allow that change for you. Nothing was altered.');
  }
  return rows;
}

module.exports = { TOKEN_PREFIX, sha256, newToken, profileForToken, sessionFor, asUser, writeAsUser, rest };
