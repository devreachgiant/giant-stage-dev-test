// Netlify Function: gcal-oauth-callback
// Exchanges the OAuth code from Google for an access_token + refresh_token.

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '821166997756-483v3q5verbk94el54lq05c5m7ppqe99.apps.googleusercontent.com';
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  if (!CLIENT_SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'GOOGLE_CLIENT_SECRET not configured in Netlify env vars' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
  const { code, redirect_uri } = body;
  if (!code) return { statusCode: 400, headers, body: JSON.stringify({ error: 'code required' }) };

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        redirect_uri: redirect_uri || `${event.headers.origin}/oauth/google/callback`,
        grant_type: 'authorization_code'
      }).toString()
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: tokenData.error_description || tokenData.error || 'Token exchange failed' }) };
    }

    // Get user email
    let email = null;
    try {
      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
      });
      if (userRes.ok) {
        const userData = await userRes.json();
        email = userData.email;
      }
    } catch(e) { /* non-fatal */ }

    return { statusCode: 200, headers, body: JSON.stringify({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      scope: tokenData.scope,
      email
    }) };
  } catch (e) {
    console.error('[gcal-oauth-callback]', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
