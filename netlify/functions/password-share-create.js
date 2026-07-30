// Netlify Function: password-share-create
// Authenticated. Creates a public, unauthenticated share link for ONE password entry —
// like 1Password/Bitwarden Send: whoever holds the link can view the password, no Giant
// login required. Deliberate exception to the rest of the Password Manager's access model;
// mitigated by a high-entropy token and a short default expiry (3 days).
//
// The caller's own access token is used to re-fetch the entry via the normal (RLS-protected)
// REST endpoint first — if RLS denies it, nothing is created, regardless of what entry_id was
// requested. Only after that check do we switch to the service role to insert the link row
// (service role is needed because anon INSERT on password_share_links is not granted).

const crypto = require('crypto');
const { allowOrigin } = require('./_cors');
const { requireUser } = require('./_auth');

const MAX_DAYS = 30;
const DEFAULT_DAYS = 3;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin(event),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  const auth = await requireUser(event);
  if (!auth.ok) return { statusCode: auth.response.statusCode, headers, body: auth.response.body };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const entryId = body.entry_id;
  if (!entryId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'entry_id is required' }) };
  let days = Number(body.expires_in_days);
  if (!Number.isFinite(days) || days <= 0) days = DEFAULT_DAYS;
  days = Math.min(days, MAX_DAYS);

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured' }) };
  }

  try {
    // RLS-scoped access check, as the caller.
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/password_entries?id=eq.${encodeURIComponent(entryId)}&select=id`,
      { headers: { apikey: ANON_KEY, Authorization: `Bearer ${auth.token}` } }
    );
    const rows = await checkRes.json().catch(() => []);
    if (!checkRes.ok || !Array.isArray(rows) || !rows[0]) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Not found, or you don't have access to this password" }) };
    }

    const token = crypto.randomBytes(24).toString('base64url'); // 32 chars, unguessable
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/password_share_links`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ entry_id: entryId, token, created_by: auth.user.id, expires_at: expiresAt }),
    });
    const inserted = await insertRes.json().catch(() => null);
    if (!insertRes.ok) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not create link', detail: JSON.stringify(inserted).slice(0, 300) }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ token, expires_at: expiresAt, link: inserted[0] }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Share link creation failed: ' + e.message }) };
  }
};
