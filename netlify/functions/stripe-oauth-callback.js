// Netlify Function: stripe-oauth-callback
// Exchanges the OAuth code returned by Stripe for an access_token + stripe_user_id.
// Called by the frontend after redirect from Stripe.

const { allowOrigin } = require('./_cors');
const { requireUser } = require('./_auth');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin(event),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Security batch 2: caller must be a logged-in Giant user. The frontend fetch
  // wrapper sends the Supabase session token; _auth.js verifies it with the Auth API.
  const auth = await requireUser(event);
  if (!auth.ok) return { statusCode: auth.response.statusCode, headers, body: auth.response.body };

  // Stripe integration disabled — keys removed by owner decision. Fail closed with 503.
  const SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!SECRET_KEY) {
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Stripe integration is currently disabled' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { code } = body;
  if (!code) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing code parameter' }) };
  }

  try {
    // Exchange the code for an access_token
    // POST https://connect.stripe.com/oauth/token with form-encoded body
    const tokenRes = await fetch('https://connect.stripe.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_secret=${encodeURIComponent(SECRET_KEY)}&code=${encodeURIComponent(code)}&grant_type=authorization_code`
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || tokenData.error) {
      const errMsg = tokenData.error_description || tokenData.error || `HTTP ${tokenRes.status}`;
      return { statusCode: 400, headers, body: JSON.stringify({ error: errMsg }) };
    }
    // Response includes: access_token, refresh_token, stripe_user_id, stripe_publishable_key, scope, livemode, token_type
    // Fetch account details for display name
    let accountDetails = {};
    try {
      const acctRes = await fetch(`https://api.stripe.com/v1/accounts/${tokenData.stripe_user_id}`, {
        headers: { 'Authorization': `Bearer ${SECRET_KEY}` }
      });
      if (acctRes.ok) accountDetails = await acctRes.json();
    } catch(e) { /* non-fatal */ }

    return { statusCode: 200, headers, body: JSON.stringify({
      stripe_user_id: tokenData.stripe_user_id,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      publishable_key: tokenData.stripe_publishable_key,
      livemode: tokenData.livemode,
      scope: tokenData.scope,
      business_name: accountDetails.business_profile?.name || null,
      display_name: accountDetails.settings?.dashboard?.display_name || accountDetails.business_profile?.name || null,
      email: accountDetails.email || null
    }) };
  } catch (e) {
    console.error('[stripe-oauth-callback]', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
