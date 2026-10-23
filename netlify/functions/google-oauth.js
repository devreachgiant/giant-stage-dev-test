// Google OAuth, for every Google thing Giant connects to.
//
// WHY THIS EXISTS AT ALL. The browser cannot do this part: swapping an authorization
// code for tokens, and later swapping a refresh token for a fresh access token, both
// need GOOGLE_CLIENT_SECRET, and a secret in a page is not a secret. So the browser
// gets a one-time code and hands it here.
//
// WHAT CHANGED FOR GMAIL. Gmail used the implicit flow (GIS initTokenClient), which
// returns an access token good for an hour and NO refresh token. That is why the one
// token in the database expired in June and why a scheduled inbox sync was impossible:
// a server cannot refresh what it was never given. The authorization code flow with
// access_type=offline returns a refresh token, which fixes both.
//
// ONE COPY. Calendar had this logic in gcal-oauth-callback.js and Gmail was about to
// need the same thing. Two copies of an OAuth exchange drift, and the copy nobody is
// looking at is the one that ends up with the stale scope list. That file now calls
// into this one.

const { allowOrigin } = require('./_cors');
const { requireUser } = require('./_auth');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID
  || '821166997756-483v3q5verbk94el54lq05c5m7ppqe99.apps.googleusercontent.com';

// Exchange an authorization code for tokens.
async function exchangeCode(code, redirectUri) {
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) return { ok: false, status: 500, error: 'GOOGLE_CLIENT_SECRET not configured in Netlify env vars' };

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: CLIENT_ID, client_secret: secret,
      redirect_uri: redirectUri, grant_type: 'authorization_code'
    }).toString()
  });
  const data = await res.json();
  if (!res.ok) return { ok: false, status: 400, error: data.error_description || data.error || 'Token exchange failed' };

  // Which mailbox this actually is. Asking Google beats trusting what the page thought,
  // because the person may well have picked a different account on the consent screen
  // than the one they meant -- and that is exactly how a second account gets saved over
  // the first.
  let email = null;
  try {
    const who = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + data.access_token }
    });
    if (who.ok) email = (await who.json()).email || null;
  } catch (e) { /* non-fatal: the caller can still store the token */ }

  return { ok: true, status: 200, body: {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_in: data.expires_in,
    scope: data.scope,
    email
  } };
}

// Swap a refresh token for a fresh access token. Google does NOT return a new refresh
// token here, so the caller keeps the one it already has.
async function refresh(refreshToken) {
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) return { ok: false, status: 500, error: 'GOOGLE_CLIENT_SECRET not configured in Netlify env vars' };

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: secret,
      refresh_token: refreshToken, grant_type: 'refresh_token'
    }).toString()
  });
  const data = await res.json();
  if (!res.ok) {
    // invalid_grant means the person revoked access, or changed their Google password,
    // or the token went unused for six months. It will never work again, so the caller
    // is told to ask for a reconnect rather than to retry.
    const dead = data.error === 'invalid_grant';
    return { ok: false, status: dead ? 410 : 400,
             error: data.error_description || data.error || 'Refresh failed', dead: dead };
  }
  return { ok: true, status: 200, body: {
    access_token: data.access_token,
    expires_in: data.expires_in,
    scope: data.scope
  } };
}

exports.exchangeCode = exchangeCode;
exports.refresh = refresh;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin(event),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  // Signed in, always. This endpoint spends a secret on the caller's behalf.
  const auth = await requireUser(event);
  if (!auth.ok) return { statusCode: auth.response.statusCode, headers, body: auth.response.body };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  try {
    if (body.action === 'refresh') {
      if (!body.refresh_token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'refresh_token required' }) };
      const r = await refresh(body.refresh_token);
      return r.ok
        ? { statusCode: 200, headers, body: JSON.stringify(r.body) }
        : { statusCode: r.status, headers, body: JSON.stringify({ error: r.error, dead: !!r.dead }) };
    }
    if (!body.code) return { statusCode: 400, headers, body: JSON.stringify({ error: 'code required' }) };
    const redirectUri = body.redirect_uri || ((event.headers && event.headers.origin) || '') + '/oauth/google/callback';
    const r = await exchangeCode(body.code, redirectUri);
    return r.ok
      ? { statusCode: 200, headers, body: JSON.stringify(r.body) }
      : { statusCode: r.status, headers, body: JSON.stringify({ error: r.error }) };
  } catch (e) {
    console.error('[google-oauth]', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
