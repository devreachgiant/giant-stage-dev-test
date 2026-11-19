// Workshop's Search Console endpoint. The page calls this; the work is in _workshop_gsc.js.
//
//   GET  ?action=status                 -> { configured, connected, account, can_edit }
//   GET  ?action=auth_url&redirect_uri= -> { url }       staff: Google consent URL
//   POST ?action=connect  {code, redirect_uri}          staff: store the agency login
//   POST ?action=disconnect                             staff: forget it
//   GET  ?action=clients                -> [{ client_id, status, error, property, last_synced_at }]
//   POST ?action=sync     {client_id}   -> sync result   staff: link the property and fetch now
//   GET  ?action=data&client_id=        -> the stored numbers for one client
//
// WHO. Every call needs a Giant login (Supabase access token, checked by _auth.js).
// Reading is for the team -- the same rule as `clients` -- and never for a client user.
// Changing anything is for owner, manager and inhouse_dev, as with every Workshop
// connector. The user id comes from the verified token, never from the request.
//
// THE TOKEN NEVER LEAVES. connect swaps the code for tokens here, on the server, and
// keeps only the refresh token, in growth_secrets. No response contains either token.
//
// WHY THE REDIRECT IS /workshop.html. Gmail and Calendar come back to
// /oauth/google/callback, and index.html hands any code there to one of those two
// screens by reading `state`. A Search Console code landing there would be stored as a
// Calendar login. Its own return address keeps the three apart without touching them.

const { requireUser } = require('./_auth');
const { exchangeCode } = require('./google-oauth');
const G = require('./_workshop_gsc');

const STAFF = ['owner', 'manager', 'inhouse_dev'];
const SCOPES = 'openid email https://www.googleapis.com/auth/webmasters.readonly';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

async function roleOf(userId) {
  const rows = await G.sb('profiles?id=eq.' + userId + '&select=role');
  return rows && rows[0] ? String(rows[0].role) : null;
}

// The redirect must be this site's own /workshop.html, so a code is never sent elsewhere.
function okRedirect(event, uri) {
  try {
    const u = new URL(String(uri || ''));
    const host = (event.headers && (event.headers.host || event.headers.Host)) || '';
    const local = /^localhost(:\d+)?$/.test(u.host) && u.protocol === 'http:';
    return (u.protocol === 'https:' || local) && u.host === host && u.pathname === '/workshop.html' && !u.search && !u.hash;
  } catch (e) { return false; }
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const action = String(q.action || '');
  let body = {};
  if (event.httpMethod === 'POST') {
    try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Invalid JSON' }); }
  }

  const auth = await requireUser(event);
  if (!auth.ok) return auth.response;
  const userId = auth.user.id;

  let role;
  try { role = await roleOf(userId); }
  catch (e) { return json(500, { error: e.message }); }
  if (!role || role === 'client') return json(403, { error: 'Workshop is for the ReachGiant team.' });
  const staff = STAFF.includes(role);
  const needStaff = () => (staff ? null : json(403, { error: 'Only an owner or manager can change Search Console.' }));

  const clientId = String(q.client_id || body.client_id || '');
  const needClient = () => (UUID.test(clientId) ? null : json(400, { error: 'client_id is missing or not valid' }));

  try {
    if (action === 'status' && event.httpMethod === 'GET') {
      const s = await G.readSecret();
      return json(200, {
        configured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
        connected: !!(s && s.value), account: (s && s.label) || null,
        connected_at: (s && s.updated_at) || null, can_edit: staff,
      });
    }

    if (action === 'auth_url' && event.httpMethod === 'GET') {
      const deny = needStaff(); if (deny) return deny;
      if (!process.env.GOOGLE_CLIENT_ID) return json(500, { error: 'GOOGLE_CLIENT_ID is not set in Netlify.' });
      if (!okRedirect(event, q.redirect_uri)) return json(400, { error: 'redirect_uri must be this site\'s /workshop.html' });
      const state = String(q.state || '');
      if (!/^wsgsc-[A-Za-z0-9]{16,64}$/.test(state)) return json(400, { error: 'state is missing' });
      const p = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: q.redirect_uri, response_type: 'code',
        scope: SCOPES, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state,
      });
      return json(200, { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString() });
    }

    if (action === 'connect' && event.httpMethod === 'POST') {
      const deny = needStaff(); if (deny) return deny;
      if (!body.code) return json(400, { error: 'code is missing' });
      if (!okRedirect(event, body.redirect_uri)) return json(400, { error: 'redirect_uri must be this site\'s /workshop.html' });
      const r = await exchangeCode(String(body.code), body.redirect_uri);
      if (!r.ok) return json(r.status || 400, { error: r.error });
      const scope = String(r.body.scope || '');
      if (scope.indexOf('webmasters') < 0) return json(400, { error: 'Google did not grant Search Console access. Tick the Search Console box on the Google screen and try again.' });
      if (!r.body.refresh_token) return json(400, { error: 'Google sent no refresh token. Remove the app at myaccount.google.com/permissions and connect again.' });
      await G.saveSecret(r.body.refresh_token, r.body.email, userId);
      // Prove it works before saying Connected.
      try {
        const tok = await G.accessToken();
        const sites = await G.listSites(tok.token);
        return json(200, { connected: true, account: r.body.email || null, properties: sites.length });
      } catch (e) {
        return json(200, { connected: true, account: r.body.email || null, warning: e.message });
      }
    }

    if (action === 'disconnect' && event.httpMethod === 'POST') {
      const deny = needStaff(); if (deny) return deny;
      await G.deleteSecret();
      return json(200, { connected: false });
    }

    if (action === 'clients' && event.httpMethod === 'GET') {
      return json(200, { items: await G.listConns() });
    }

    if (action === 'sync' && event.httpMethod === 'POST') {
      const deny = needStaff() || needClient(); if (deny) return deny;
      const r = await G.syncClient(clientId, { userId });
      return json(200, r);
    }

    if (action === 'data' && event.httpMethod === 'GET') {
      const deny = needClient(); if (deny) return deny;
      return json(200, await G.readData(clientId));
    }

    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('[workshop-gsc]', action, e.message);
    return json(e.code === 'not_found' ? 404 : 500, { error: e.message, code: e.code || null });
  }
};
