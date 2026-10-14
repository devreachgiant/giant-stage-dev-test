// The token endpoint, at /oauth/token. Exchanges an authorization code for an access token,
// and rotates a refresh token.
//
// Public clients only, so there is no client authentication here: PKCE is what proves the
// caller is the same software that started the flow. A token request without a code_verifier
// is refused rather than treated as an older client being helpful.
const { redeemCode, issueTokens, refreshTokens, RESOURCE_URI } = require('./_mcp_oauth');

function form(body) {
  const out = {};
  new URLSearchParams(body || '').forEach((v, k) => { out[k] = v; });
  return out;
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    // A token must never be cached by anything, anywhere.
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'invalid_request' }) };
  }

  const ct = String((event.headers || {})['content-type'] || '');
  let p;
  if (ct.includes('application/json')) { try { p = JSON.parse(event.body || '{}'); } catch (_) { p = {}; } }
  else p = form(event.body);

  const fail = (code, status) => ({ statusCode: status || 400, headers,
    body: JSON.stringify({ error: code }) });

  try {
    if (p.grant_type === 'refresh_token') {
      const out = await refreshTokens({ refreshToken: p.refresh_token, clientId: p.client_id });
      if (out.error) return fail(out.error);
      return { statusCode: 200, headers, body: JSON.stringify(out.tokens) };
    }

    if (p.grant_type !== 'authorization_code') return fail('unsupported_grant_type');

    const out = await redeemCode({
      code: p.code,
      clientId: p.client_id,
      redirectUri: p.redirect_uri,
      codeVerifier: p.code_verifier,
    });
    if (out.error) return fail(out.error);

    // The audience is taken from what was recorded at authorize time, never from this
    // request -- otherwise a client could mint itself a token for a resource it was never
    // granted, which is the confused-deputy problem the resource parameter exists to stop.
    const tokens = await issueTokens({
      clientId: out.row.client_id,
      profileId: out.row.profile_id,
      audience: out.row.resource || RESOURCE_URI,
      scope: out.row.scope,
    });
    return { statusCode: 200, headers, body: JSON.stringify(tokens) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'server_error' }) };
  }
};
