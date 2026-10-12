// RFC 9728 protected resource metadata, served at /.well-known/oauth-protected-resource
// (and the /mcp-suffixed form clients derive from the resource path).
//
// This is the first thing an AI client fetches after a 401, and it is what tells it where to
// send the person to sign in. The spec makes it a MUST for MCP servers.
//
// Deliberately public and unauthenticated: it names an issuer and a scope, nothing about the
// workspace or who is in it.
const { protectedResourceMetadata } = require('./_mcp_oauth');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    // Discovery is fetched cross-origin by clients we do not know in advance, so this one
    // document is genuinely open -- unlike every other function here.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'public, max-age=300',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  return { statusCode: 200, headers, body: JSON.stringify(protectedResourceMetadata()) };
};
