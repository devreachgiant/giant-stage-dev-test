// Giant as an MCP server.
//
// One URL somebody pastes into Claude (or any MCP client) along with their personal Giant
// token. From then on the assistant can ask Giant questions -- what is overdue, which
// clients have no payment date, what was said in a channel -- and gets answers under that
// person's own permissions.
//
// Speaks JSON-RPC 2.0 over HTTP, which is MCP's Streamable HTTP transport. No streaming is
// needed here: every tool is a single query that returns at once, so a plain JSON response
// is the whole protocol surface. Clients that expect SSE accept this; what they require is
// a JSON-RPC reply, not a particular framing.
//
// Read-only on purpose. An assistant that can read is useful and cannot do damage; writes
// deserve their own decisions about what should happen without a person watching, and are
// not smuggled in on the back of this.

const { allowOrigin } = require('./_cors');
const { profileForToken, sessionFor } = require('./_mcp_identity');
const { byName, listForProtocol } = require('./_mcp_tools');

const PROTOCOL_VERSION = '2024-11-05';

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcOk    = (id, result)        => ({ jsonrpc: '2.0', id: id ?? null, result });

function bearer(event) {
  const h = event.headers || {};
  const raw = h.authorization || h.Authorization || '';
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin(event),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  // A GET is somebody opening the URL in a browser, or a client probing it. Say what this
  // is and what it needs, rather than returning a protocol error to a human.
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, headers, body: JSON.stringify({
      name: 'giant',
      description: 'Read ReachGiant\'s Giant workspace as yourself.',
      transport: 'http',
      authentication: 'Send your personal Giant token as: Authorization: Bearer giant_sk_...',
      where_to_get_a_token: 'Giant → Settings → Connected AI',
      tools: listForProtocol().map(t => t.name),
    }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify(rpcError(null, -32600, 'Use POST')) };
  }

  let req;
  try { req = JSON.parse(event.body || '{}'); }
  catch (_) { return { statusCode: 400, headers, body: JSON.stringify(rpcError(null, -32700, 'Invalid JSON')) }; }

  const { id, method, params } = req;

  // initialize and tools/list are answered without a token, so a client can connect and
  // show what is available before anybody has pasted one in. Nothing about the workspace
  // leaks here -- it is the tool names and their descriptions, which are public by nature.
  if (method === 'initialize') {
    return { statusCode: 200, headers, body: JSON.stringify(rpcOk(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'giant', version: '1.0.0' },
    })) };
  }
  if (method === 'notifications/initialized') {
    return { statusCode: 202, headers, body: '' };
  }
  if (method === 'tools/list') {
    return { statusCode: 200, headers, body: JSON.stringify(rpcOk(id, { tools: listForProtocol() })) };
  }

  if (method !== 'tools/call') {
    return { statusCode: 200, headers, body: JSON.stringify(rpcError(id, -32601, `Unknown method: ${method}`)) };
  }

  // From here on it is a real request for data, so it needs to be somebody.
  const token = bearer(event);
  if (!token) {
    return { statusCode: 200, headers, body: JSON.stringify(rpcError(id, -32001,
      'No Giant token. Send Authorization: Bearer giant_sk_... — make one in Giant → Settings → Connected AI.')) };
  }

  let profile;
  try { profile = await profileForToken(token); }
  catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify(rpcError(id, -32603,
      'Could not check that token: ' + e.message)) };
  }
  if (!profile) {
    return { statusCode: 200, headers, body: JSON.stringify(rpcError(id, -32001,
      'That Giant token is not valid, has been revoked, or belongs to an account that cannot use this.')) };
  }

  const toolName = params && params.name;
  const tool = byName(toolName);
  if (!tool) {
    return { statusCode: 200, headers, body: JSON.stringify(rpcError(id, -32602,
      `No such tool: ${toolName}`)) };
  }

  try {
    // The session is the person. Everything the tool reads is read as them, so the database
    // decides what comes back -- not this file.
    const accessToken = await sessionFor(profile);
    const ctx = { accessToken, role: profile.role, name: profile.name, email: profile.email };
    const out = await tool.run(ctx, (params && params.arguments) || {});
    return { statusCode: 200, headers, body: JSON.stringify(rpcOk(id, {
      content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
    })) };
  } catch (e) {
    // Reported as a tool error rather than a protocol one: the assistant can then tell the
    // person what went wrong instead of the connection appearing to break.
    return { statusCode: 200, headers, body: JSON.stringify(rpcOk(id, {
      content: [{ type: 'text', text: 'Giant could not answer that: ' + e.message }],
      isError: true,
    })) };
  }
};
