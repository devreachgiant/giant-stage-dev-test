// Shared caller authentication for Netlify functions.
//
// ⚠️  NOT YET WIRED IN — this is batch 2 of the security remediation.
// Enforcing it is a COORDINATED change: every frontend fetch() to a protected function must
// first send `Authorization: Bearer <supabase session access_token>`, or the live app breaks.
// The frontend change and the per-function `requireUser` calls ship and are verified together.
// This file is committed now so the pattern is reviewed and ready.
//
// Rollout target (functions that currently run with the service role and NO caller auth):
//   send-invitation, ai-transcribe, ai-dictate, report-notify, share-pack-create,
//   magnus-* / hercules-* / atlas- / titan- / jupiter- / vulcan-*  (burn LLM spend if open),
//   gcal-api. Genuinely-public endpoints stay open but get input validation + rate limiting:
//   share-pack-get, share-pack-feedback, bookings-api (public availability/create only).
//
// Usage inside a handler:
//   const { requireUser } = require('./_auth');
//   const auth = await requireUser(event);
//   if (!auth.ok) return auth.response;      // 401 / 500 already shaped
//   const userId = auth.user.id;

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

function bearerToken(event) {
  const h = event.headers || {};
  const raw = h.authorization || h.Authorization || '';
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function fail(statusCode, error) {
  return {
    ok: false,
    response: {
      statusCode,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error }),
    },
  };
}

// Verifies the Supabase access token by asking the Auth API who it belongs to.
// Avoids needing the JWT secret in each function; returns { ok, user, token } on success.
async function requireUser(event) {
  const token = bearerToken(event);
  if (!token) return fail(401, 'Missing bearer token');
  if (!SUPABASE_URL || !ANON_KEY) return fail(500, 'Auth not configured');

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return fail(401, 'Invalid or expired token');
    const user = await res.json();
    if (!user || !user.id) return fail(401, 'Invalid token');
    return { ok: true, user, token };
  } catch (e) {
    return fail(401, 'Auth check failed');
  }
}

module.exports = { requireUser, bearerToken };
