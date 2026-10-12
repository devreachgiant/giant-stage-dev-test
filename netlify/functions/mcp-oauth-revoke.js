// RFC 7009 token revocation, at /oauth/revoke. A client that is being disconnected can hand
// back its token instead of leaving a live one lying around until it expires.
//
// RFC 7009 is explicit that this returns 200 whether or not the token existed: telling an
// unauthenticated caller "that token was real" would turn this endpoint into a way to test
// stolen tokens.
const { sha256 } = require('./_mcp_oauth');
const { rest } = require('./_mcp_identity');

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
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'invalid_request' }) };
  }
  const ct = String((event.headers || {})['content-type'] || '');
  let p;
  if (ct.includes('application/json')) { try { p = JSON.parse(event.body || '{}'); } catch (_) { p = {}; } }
  else p = form(event.body);

  const token = p.token;
  if (token) {
    const hash = sha256(token);
    const at = new Date().toISOString();
    // The caller need not say which kind it is, so revoke on either column. A refresh token
    // and its access token belong to one row, so either kills both.
    await rest(`mcp_access_tokens?token_hash=eq.${encodeURIComponent(hash)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ revoked_at: at }),
    }).catch(() => {});
    await rest(`mcp_access_tokens?refresh_hash=eq.${encodeURIComponent(hash)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ revoked_at: at }),
    }).catch(() => {});
  }
  return { statusCode: 200, headers, body: '{}' };
};
