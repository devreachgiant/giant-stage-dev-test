// The page a person actually sees: "Claude wants to read Giant as you. Allow?"
//
// Served at /oauth/authorize. A GET renders the consent screen; the Allow button POSTs back
// here and gets a redirect URL carrying a one-time code.
//
// Two decisions worth stating.
//
// FIRST, this page is on giant.reachgiant.com, the same origin as the app, which means it can
// read the Supabase session the app already stored. In the normal case the person is signed
// in to Giant in that browser, so they see their own name and press one button. Only somebody
// signed out has to type anything, and then signing in here signs them into Giant too.
//
// SECOND, nothing the page sends is trusted. The POST re-validates the client, the redirect
// URI, the PKCE challenge and the person's session from scratch, because the page is just
// HTML and anybody can post to this endpoint. The browser's job is to prove who the person
// is; every decision is made here.
//
// An invalid client_id or redirect_uri renders an error instead of redirecting. Redirecting
// an error to an unverified URI is how open redirectors are built, and the OAuth security
// guidance is explicit that the one case you must not redirect is the one where you cannot
// trust where you would be redirecting to.

const {
  getClient, redirectAllowed, issueCode, ISSUER, RESOURCE_URI, SCOPE,
} = require('./_mcp_oauth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY     = process.env.SUPABASE_ANON_KEY;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const htmlHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  // This page is the thing an attacker would most like to frame and trick someone into
  // clicking through. It may not be framed at all.
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};

function errorPage(title, detail) {
  return { statusCode: 400, headers: htmlHeaders, body: shell(`
    <div class="card">
      <div class="mark">!</div>
      <h1>${esc(title)}</h1>
      <p>${esc(detail)}</p>
      <p class="fine">Nothing has been connected and nothing has changed. If an assistant sent
      you here, it asked for something Giant does not recognise — close this tab and try
      adding the connection again.</p>
    </div>`) };
}

function shell(inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to Giant</title>
<style>
  :root{--bg:#0B0B0E;--surface:#15161c;--line:rgba(255,255,255,.12);--line2:rgba(255,255,255,.2);
        --text:#E8E8EA;--text2:#A8A8AE;--text3:#6E6E76;--red:#D00400;}
  *{box-sizing:border-box;}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       padding:24px;background:var(--bg);color:var(--text);
       font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;}
  .card{width:100%;max-width:440px;background:var(--surface);border:1px solid var(--line);
        border-radius:16px;padding:28px;box-shadow:0 24px 70px rgba(0,0,0,.55);}
  .mark{width:38px;height:38px;border-radius:11px;background:var(--red);color:#fff;
        display:flex;align-items:center;justify-content:center;font-weight:800;font-size:17px;
        margin-bottom:16px;}
  h1{font-size:19px;font-weight:800;letter-spacing:-.02em;margin:0 0 8px;}
  p{font-size:13.5px;line-height:1.6;color:var(--text2);margin:0 0 12px;}
  .fine{font-size:11.5px;color:var(--text3);}
  .who{display:flex;align-items:center;gap:11px;padding:11px 13px;border:1px solid var(--line);
       border-radius:11px;margin:16px 0;}
  .ava{width:32px;height:32px;border-radius:9px;background:#4A2424;color:#F0A0A0;flex-shrink:0;
       display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;}
  .who b{display:block;font-size:13px;color:var(--text);}
  .who span{font-size:11.5px;color:var(--text3);}
  ul{margin:14px 0;padding-left:18px;}
  li{font-size:12.5px;color:var(--text2);line-height:1.8;}
  .row{display:flex;gap:9px;margin-top:20px;}
  button{flex:1;padding:11px 16px;border-radius:9px;font-size:13px;font-weight:700;
         cursor:pointer;font-family:inherit;border:none;transition:.15s;}
  .ghost{background:rgba(255,255,255,.07);color:var(--text);}
  .ghost:hover{background:rgba(255,255,255,.12);}
  .go{background:var(--red);color:#fff;}
  .go:hover{filter:brightness(1.12);}
  button[disabled]{opacity:.55;cursor:default;}
  input{width:100%;padding:10px 12px;margin-bottom:9px;border-radius:9px;font-size:13.5px;
        background:rgba(255,255,255,.05);border:1px solid var(--line2);color:var(--text);
        font-family:inherit;outline:none;}
  .err{color:#FF6B66;font-size:12.5px;margin-top:10px;min-height:17px;}
</style></head><body>${inner}</body></html>`;
}

async function userForToken(accessToken) {
  if (!accessToken) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const u = await res.json();
    return u && u.id ? u : null;
  } catch (_) { return null; }
}

// The person's role decides whether they may connect an assistant at all, and it is read
// here rather than taken from anything the browser said.
async function profileFor(userId) {
  const { rest } = require('./_mcp_identity');
  const r = await rest(`profiles?select=id,full_name,email,role&id=eq.${encodeURIComponent(userId)}&limit=1`);
  if (!r.ok || !Array.isArray(r.body) || !r.body.length) return null;
  return r.body[0];
}

// Everything a valid authorize request must carry, checked in one place so GET and POST
// cannot drift apart.
async function validate(q) {
  const clientId = q.client_id;
  const redirectUri = q.redirect_uri;
  if (!clientId || !redirectUri) {
    return { fatal: ['Something is missing', 'The request did not include a client or a redirect address.'] };
  }
  const client = await getClient(clientId);
  if (!client) {
    return { fatal: ['Unknown assistant', 'Giant has no record of the app that sent you here.'] };
  }
  if (!redirectAllowed(redirectUri, client.redirect_uris)) {
    return { fatal: ['That redirect address is not registered',
      'The app asked Giant to send you back to an address it never registered, so Giant stopped.'] };
  }
  // From here the redirect_uri is trusted, so errors may be reported to it.
  if (q.response_type !== 'code')        return { client, redirect: 'unsupported_response_type' };
  if (!q.code_challenge)                 return { client, redirect: 'invalid_request' };
  if (q.code_challenge_method !== 'S256')return { client, redirect: 'invalid_request' };
  // RFC 8707: a resource we do not serve is not something to issue a token for.
  if (q.resource && q.resource.replace(/\/$/, '') !== RESOURCE_URI) {
    return { client, redirect: 'invalid_target' };
  }
  return { client };
}

// Error responses carry iss too, because a client that validates iss on success and not on
// failure can still be fed a forged error.
function redirectWithError(redirectUri, error, state) {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  if (state) u.searchParams.set('state', state);
  u.searchParams.set('iss', ISSUER);
  return u.toString();
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};

  if (event.httpMethod === 'POST') {
    const json = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch (_) { return { statusCode: 400, headers: json, body: JSON.stringify({ error: 'invalid_request' }) }; }

    // Re-validated from the posted values, not from a server-side memory of the GET. There
    // is no session between the two requests and there deliberately isn't one.
    const v = await validate(body);
    if (v.fatal)    return { statusCode: 400, headers: json, body: JSON.stringify({ error: 'invalid_request', message: v.fatal[1] }) };
    if (v.redirect) return { statusCode: 400, headers: json, body: JSON.stringify({ error: v.redirect }) };

    if (body.decision === 'deny') {
      return { statusCode: 200, headers: json,
        body: JSON.stringify({ redirect: redirectWithError(body.redirect_uri, 'access_denied', body.state) }) };
    }

    const user = await userForToken(body.access_token);
    if (!user) return { statusCode: 401, headers: json, body: JSON.stringify({ error: 'login_required' }) };
    const prof = await profileFor(user.id);
    if (!prof || String(prof.role || 'client').toLowerCase() === 'client') {
      return { statusCode: 403, headers: json, body: JSON.stringify({ error: 'access_denied',
        message: 'Client accounts cannot connect an assistant to this workspace.' }) };
    }

    let code;
    try {
      code = await issueCode({
        clientId: body.client_id,
        profileId: prof.id,
        redirectUri: body.redirect_uri,
        codeChallenge: body.code_challenge,
        resource: body.resource || RESOURCE_URI,
        scope: SCOPE,
      });
    } catch (e) {
      return { statusCode: 500, headers: json, body: JSON.stringify({ error: 'server_error' }) };
    }

    const u = new URL(body.redirect_uri);
    u.searchParams.set('code', code);
    if (body.state) u.searchParams.set('state', body.state);
    u.searchParams.set('iss', ISSUER);
    return { statusCode: 200, headers: json, body: JSON.stringify({ redirect: u.toString() }) };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: htmlHeaders, body: shell('<div class="card"><h1>Use GET</h1></div>') };
  }

  const v = await validate(q);
  if (v.fatal) return errorPage(v.fatal[0], v.fatal[1]);
  if (v.redirect) {
    return { statusCode: 302,
      headers: { Location: redirectWithError(q.redirect_uri, v.redirect, q.state), 'Cache-Control': 'no-store' },
      body: '' };
  }

  const appName = v.client.client_name || 'An AI assistant';
  // The request is handed to the page as data and posted back verbatim. It is re-checked on
  // the way in, so this is a convenience, not a trust boundary.
  const req = JSON.stringify({
    client_id: q.client_id, redirect_uri: q.redirect_uri, state: q.state || '',
    code_challenge: q.code_challenge, code_challenge_method: q.code_challenge_method,
    resource: q.resource || RESOURCE_URI,
  });

  return { statusCode: 200, headers: htmlHeaders, body: shell(`
<div class="card" id="card">
  <div class="mark">G</div>
  <h1>${esc(appName)} wants to read Giant</h1>
  <p>It will see Giant <b>as you</b> — the same clients, projects, tasks and channels you see
     when you open the app, and nothing else.</p>
  <ul>
    <li>It can <b>read</b> your clients, projects, tasks, meetings and chat</li>
    <li>It <b>cannot</b> post, edit or delete anything</li>
    <li>You can cut it off any time in Settings → Connected AI</li>
  </ul>
  <div id="who" class="who" style="display:none;">
    <div class="ava" id="ava">·</div>
    <div><b id="whoName">—</b><span id="whoEmail">—</span></div>
  </div>
  <div id="signin" style="display:none;">
    <p class="fine">Sign in to Giant to continue.</p>
    <input id="email" type="email" placeholder="you@reachgiant.com" autocomplete="username">
    <input id="password" type="password" placeholder="Password" autocomplete="current-password">
    <button class="go" id="signinBtn" style="width:100%;">Sign in</button>
  </div>
  <div class="err" id="err"></div>
  <div class="row" id="actions" style="display:none;">
    <button class="ghost" id="deny">Cancel</button>
    <button class="go" id="allow">Allow</button>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>
<script>
(function(){
  var REQ = ${req};
  // Same origin and the default storage key, so this reads the session the app already
  // stored and the person is normally signed in before they arrive. persistSession keeps
  // that true in reverse: signing in here signs them into Giant. autoRefreshToken is off
  // because this page lives for a few seconds and a second client refreshing in the
  // background can race the app's own refresh in another tab.
  var sb = window.supabase.createClient(${JSON.stringify(SUPABASE_URL)}, ${JSON.stringify(ANON_KEY)}, {
    auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false }
  });
  var err = document.getElementById('err');
  var show = function(id, on){ document.getElementById(id).style.display = on ? '' : 'none'; };

  function present(session){
    if (!session) { show('signin', true); show('actions', false); show('who', false); return; }
    var u = session.user || {};
    var name = (u.user_metadata && (u.user_metadata.full_name || u.user_metadata.name)) || u.email || 'You';
    document.getElementById('whoName').textContent = name;
    document.getElementById('whoEmail').textContent = u.email || '';
    document.getElementById('ava').textContent = (name.charAt(0) || '?').toUpperCase();
    show('who', true); show('actions', true); show('signin', false);
  }

  sb.auth.getSession().then(function(r){ present(r.data && r.data.session); });

  document.getElementById('signinBtn').addEventListener('click', function(){
    var btn = this; btn.disabled = true; err.textContent = '';
    sb.auth.signInWithPassword({
      email: document.getElementById('email').value.trim(),
      password: document.getElementById('password').value
    }).then(function(r){
      btn.disabled = false;
      if (r.error) { err.textContent = r.error.message; return; }
      present(r.data.session);
    });
  });

  function decide(decision){
    err.textContent = '';
    document.getElementById('allow').disabled = true;
    document.getElementById('deny').disabled = true;
    sb.auth.getSession().then(function(r){
      var s = r.data && r.data.session;
      var payload = Object.assign({}, REQ, {
        decision: decision,
        access_token: s ? s.access_token : null
      });
      return fetch(window.location.pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }).then(function(res){ return res.json(); }).then(function(out){
      if (out && out.redirect) { window.location.href = out.redirect; return; }
      document.getElementById('allow').disabled = false;
      document.getElementById('deny').disabled = false;
      err.textContent = (out && (out.message || out.error)) || 'Something went wrong.';
      if (out && out.error === 'login_required') present(null);
    }).catch(function(){
      document.getElementById('allow').disabled = false;
      document.getElementById('deny').disabled = false;
      err.textContent = 'Could not reach Giant.';
    });
  }

  document.getElementById('allow').addEventListener('click', function(){ decide('allow'); });
  document.getElementById('deny').addEventListener('click', function(){ decide('deny'); });
})();
</script>`) };
};
