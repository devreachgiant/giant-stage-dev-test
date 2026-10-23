// Netlify Function: gcal-oauth-callback
//
// KEPT AS A PATH, NOT AS AN IMPLEMENTATION. The Calendar screen calls this URL, and
// changing that at the same time as moving Gmail onto the same flow would be two risks
// in one deploy. The exchange itself now lives in google-oauth.js, which Gmail uses
// too -- two copies of an OAuth exchange drift, and the copy nobody is looking at is
// the one left holding a stale scope list or a missing fix.

const { allowOrigin } = require('./_cors');
const { requireUser } = require('./_auth');
const { exchangeCode } = require('./google-oauth');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin(event),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  const auth = await requireUser(event);
  if (!auth.ok) return { statusCode: auth.response.statusCode, headers, body: auth.response.body };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
  if (!body.code) return { statusCode: 400, headers, body: JSON.stringify({ error: 'code required' }) };

  try {
    const redirectUri = body.redirect_uri || `${(event.headers && event.headers.origin) || ''}/oauth/google/callback`;
    const r = await exchangeCode(body.code, redirectUri);
    return r.ok
      ? { statusCode: 200, headers, body: JSON.stringify(r.body) }
      : { statusCode: r.status, headers, body: JSON.stringify({ error: r.error }) };
  } catch (e) {
    console.error('[gcal-oauth-callback]', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
