// Giant as an MCP server.
//
// One URL somebody adds to Claude, ChatGPT or any other MCP client. From then on the
// assistant can ask Giant questions -- what is overdue, which clients have no payment date,
// what was said in a channel -- and gets answers under that person's own permissions.
//
// TWO WAYS TO BE SOMEBODY, because the clients people use are not alike:
//
//   1. OAuth. The client discovers /.well-known/oauth-protected-resource from the 401 below,
//      sends the person to Giant to press Allow, and gets a token. This is what claude.ai,
//      the Claude desktop app and ChatGPT do, and it is the only way they CAN connect -- they
//      have nowhere to paste a token. It is therefore what makes "anyone on the team, any
//      assistant" true rather than aspirational.
//   2. A personal token (giant_sk_...) from Settings → Connected AI, for command-line tools
//      and scripts where a browser round-trip is friction with no benefit.
//
// Either way the request runs as a real Supabase session for that person, and the database
// decides what comes back. Connecting an assistant can never show somebody more than they
// could already see by opening the app.
//
// Speaks JSON-RPC 2.0 over HTTP, which is MCP's Streamable HTTP transport. No streaming is
// needed: every tool is a single query that returns at once, so a plain JSON response is the
// whole protocol surface.
//
// Read-only on purpose. An assistant that can read is useful and cannot do damage; writes
// deserve their own decision about what should happen with nobody watching, and are not
// smuggled in on the back of this.

const { profileForToken, sessionFor, rest } = require('./_mcp_identity');
const { verifyAccessToken, protectedResourceMetadata, SCOPE, ORIGIN } = require('./_mcp_oauth');
const { byName, listForProtocol } = require('./_mcp_tools');

// Echoed back to whatever the client asked for when it looks like a protocol date, so a
// newer client is not turned away over a version string. The tool surface is identical
// across these revisions.
const DEFAULT_PROTOCOL = '2025-06-18';
const PRM_URL = ORIGIN + '/.well-known/oauth-protected-resource';

// Every call, not only the ones that change something. A log that records just the writes
// cannot answer "what was it doing just before that", which is the question you actually
// have afterwards. Best-effort and never awaited into the critical path: failing to log
// must not fail the request.
function audit(entry) {
  rest('mcp_audit', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(entry),
  }).catch(() => {});
}

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
    // An MCP client is any host on the internet, and what it may read is decided by the
    // token it holds, not by where it was served from. A per-origin allowlist would only
    // block the browser-based clients this exists to support.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  // A GET is a person opening the URL, or a client probing it. Say what this is and how to
  // connect, rather than returning a protocol error to somebody reading it.
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, headers, body: JSON.stringify({
      name: 'giant',
      description: 'Read ReachGiant\'s Giant workspace as yourself.',
      transport: 'http',
      how_to_connect: 'Add this URL to your AI assistant as an MCP server. It will send you '
                    + 'to Giant to sign in and approve. Command-line tools can instead send a '
                    + 'personal token from Giant → Settings → Connected AI as '
                    + 'Authorization: Bearer giant_sk_...',
      authorization_servers: [ORIGIN],
      resource_metadata: PRM_URL,
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

  // A notification carries no id and expects no reply.
  if (method === 'notifications/initialized' || /^notifications\//.test(method || '')) {
    return { statusCode: 202, headers, body: '' };
  }

  // ── who is asking ─────────────────────────────────────────────────────────
  // Resolved before anything else, including initialize. The 401 and its WWW-Authenticate
  // header are not an error condition here -- they are the first step of the OAuth flow, and
  // the thing that makes a client offer "Sign in with Giant" instead of giving up.
  const token = bearer(event);
  let profile = null;
  if (token) {
    try {
      if (token.startsWith('giant_sk_')) {
        // Kept whole. Picking fields out by hand here dropped scope, and a token granted
        // writing silently behaved as read-only -- the tools were simply not offered, with
        // nothing anywhere saying why.
        const p = await profileForToken(token);
        if (p) profile = p;
      } else {
        const p = await verifyAccessToken(token);
        if (p) profile = p;
      }
    } catch (e) {
      return { statusCode: 500, headers,
        body: JSON.stringify(rpcError(id, -32603, 'Could not check that credential: ' + e.message)) };
    }
  }

  if (!profile) {
    return {
      statusCode: 401,
      headers: {
        ...headers,
        'WWW-Authenticate': `Bearer resource_metadata="${PRM_URL}", scope="${SCOPE}"`,
      },
      body: JSON.stringify(rpcError(id, -32001,
        'Not signed in to Giant. Approve this connection in your assistant, or send a personal '
        + 'token from Giant → Settings → Connected AI as Authorization: Bearer giant_sk_...')),
    };
  }

  if (method === 'initialize') {
    const asked = params && params.protocolVersion;
    const version = (typeof asked === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asked))
      ? asked : DEFAULT_PROTOCOL;
    return { statusCode: 200, headers, body: JSON.stringify(rpcOk(id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'giant', version: '1.0.0' },
    })) };
  }

  // What this connection was granted, decided when the person pressed Allow and recorded on
  // the token. Not re-derived from their role: somebody who connected read-only stays
  // read-only even though they could write by hand.
  const canWrite = / giant:write\b|^giant:write\b/.test(' ' + (profile.scope || 'giant:read'));

  if (method === 'tools/list') {
    return { statusCode: 200, headers, body: JSON.stringify(rpcOk(id, { tools: listForProtocol(canWrite) })) };
  }

  // Answered so a client that probes them does not treat the server as broken. Giant exposes
  // tools and nothing else, so both are empty rather than unimplemented.
  if (method === 'resources/list') {
    return { statusCode: 200, headers, body: JSON.stringify(rpcOk(id, { resources: [] })) };
  }
  if (method === 'prompts/list') {
    return { statusCode: 200, headers, body: JSON.stringify(rpcOk(id, { prompts: [] })) };
  }
  if (method === 'ping') {
    return { statusCode: 200, headers, body: JSON.stringify(rpcOk(id, {})) };
  }

  if (method !== 'tools/call') {
    return { statusCode: 200, headers, body: JSON.stringify(rpcError(id, -32601, `Unknown method: ${method}`)) };
  }

  const toolName = params && params.name;
  const tool = byName(toolName);
  if (!tool) {
    return { statusCode: 200, headers, body: JSON.stringify(rpcError(id, -32602, `No such tool: ${toolName}`)) };
  }

  // A read-only connection is not shown the writing tools, but it may still ask for one --
  // from a stale tool list, or because it was told to. Refused here, and recorded, because
  // an assistant being asked to do something it was not granted is worth knowing about.
  if (tool.writes && !canWrite) {
    audit({ profile_id: profile.profileId, via: profile.via || 'oauth', tool: toolName,
            writes: true, arguments: (params && params.arguments) || {}, ok: false,
            detail: 'refused: this connection was granted read-only' });
    return { statusCode: 200, headers, body: JSON.stringify(rpcOk(id, {
      content: [{ type: 'text', text:
        'This connection can only read Giant. To let it make changes, reconnect it and tick '
        + '"let it make changes" on the Allow screen.' }],
      isError: true,
    })) };
  }

  try {
    // The session is the person. Everything the tool reads is read as them, so the database
    // decides what comes back -- not this file.
    const accessToken = await sessionFor(profile);
    const ctx = { accessToken, role: profile.role, name: profile.name,
                  email: profile.email, profileId: profile.profileId, canWrite };
    const out = await tool.run(ctx, (params && params.arguments) || {});
    audit({ profile_id: profile.profileId, via: profile.via || 'oauth',
            client_name: profile.clientName || null, tool: toolName, writes: !!tool.writes,
            arguments: (params && params.arguments) || {}, ok: !out || !out.error,
            detail: out && out.error ? String(out.error).slice(0, 300)
                                     : (out && out.note) || null,
            target_table: tool.writes ? (toolName.includes('task') ? 'tasks'
                                       : toolName.includes('client') ? 'clients'
                                       : toolName.includes('message') ? 'messages' : null) : null,
            target_id: tool.writes
              ? String((out && (out.created || out.updated || out.posted) || {}).id || '') || null
              : null });
    return { statusCode: 200, headers, body: JSON.stringify(rpcOk(id, {
      content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
    })) };
  } catch (e) {
    // Reported as a tool error rather than a protocol one: the assistant can then tell the
    // person what went wrong instead of the connection appearing to break.
    audit({ profile_id: profile.profileId, via: profile.via || 'oauth', tool: toolName,
            writes: !!tool.writes, arguments: (params && params.arguments) || {},
            ok: false, detail: String(e.message).slice(0, 300) });
    return { statusCode: 200, headers, body: JSON.stringify(rpcOk(id, {
      content: [{ type: 'text', text: 'Giant could not answer that: ' + e.message }],
      isError: true,
    })) };
  }
};
