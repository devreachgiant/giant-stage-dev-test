// RFC 7591 dynamic client registration, at /oauth/register.
//
// Deprecated by the 2026-07-28 MCP spec in favour of Client ID Metadata Documents, and
// supported anyway: it is what the clients people have installed today actually use, and
// turning it off would mean "any AI" quietly meaning "any AI released after the switch".
//
// Open by design -- that is what "dynamic" means, and it is how OAuth works for a public
// client. Registering buys nothing on its own: a client_id is not a credential, every
// authorization still requires a person to sign in and press Allow, and every redirect_uri is
// matched exactly at that point.
const { registerClient } = require('./_mcp_oauth');

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
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid_client_metadata' }) }; }

  let out;
  try { out = await registerClient(body); }
  catch (e) { return { statusCode: 500, headers, body: JSON.stringify({ error: 'server_error' }) }; }

  if (out.error) {
    return { statusCode: 400, headers,
      body: JSON.stringify({ error: out.error, error_description: out.description }) };
  }
  // 201, per RFC 7591 §3.2.1. Some clients check for it.
  return { statusCode: 201, headers, body: JSON.stringify(out.registered) };
};
