// RFC 8414 authorization server metadata, served at /.well-known/oauth-authorization-server
// and mirrored at /.well-known/openid-configuration, because the MCP spec requires clients to
// support both discovery mechanisms and real clients try them in different orders.
const { authorizationServerMetadata } = require('./_mcp_oauth');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'public, max-age=300',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  return { statusCode: 200, headers, body: JSON.stringify(authorizationServerMetadata()) };
};
