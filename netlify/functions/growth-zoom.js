// Zoom Server-to-Server credentials, connected from the app instead of from Netlify.
//
// Zoom was the last connector that only an admin with Netlify access could set up, which
// made the person who owns the Zoom account wait on the person who owns the deploy. This
// is the same shape as growth-calendly.js, for the same reason, and the two files are
// deliberately alike: a second way of doing this would be a second thing to get wrong.
//
// WHERE THE CREDENTIALS LIVE. Two places, in this order:
//
//   1. growth_secrets.zoom_s2s, written by Connectors through ?action=save
//   2. ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET in Netlify
//
// The table wins, so connecting in the app overrides a stale environment variable rather
// than silently losing to it. growth_secrets has RLS on, no policies and no grants, so
// anon and authenticated get nothing from it even with the publishable key -- only the
// service role reads it, and only in here and in bookings-api.js.
//
// ALL THREE OR NONE. They go in as ONE row holding all three values, not three rows.
// Two-thirds of a credential is not a credential: it would leave the connector saying
// Connected while every meeting it tried to mint failed on the missing piece.
//
// WHAT COUNTS AS PROOF. Minting a token. Zoom hands one back only if the account id, the
// client id and the secret all match and the app is activated, so a successful mint is
// the whole credential proved at once. Reading the account's name afterwards is a nicety
// for the row and is allowed to fail: a Server-to-Server app scoped only to meetings
// cannot call /users/me, and refusing a working credential over a missing scope would be
// this screen lying in the other direction.
//
//   GET  ?action=status     -> { configured, who, source }   are they set, whose account
//   POST ?action=save       -> { configured, who }           store them, staff only
//   POST ?action=disconnect -> { configured:false }          forget them, staff only
//
// SET UP: Zoom -> Develop -> Build App -> Server-to-Server OAuth. Copy the Account ID,
// Client ID and Client Secret into Growth -> Connectors -> Zoom.
//
// These are ACCOUNT-level credentials: whoever holds them can create and read meetings
// for the whole Zoom account. That is why save and disconnect check the caller's role
// here, from their own login, and why nothing ever sends the values back to the browser.

const KEY = 'zoom_s2s';

const json = (code, body) => ({
  statusCode: code,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body)
});

// Service key: growth_secrets is unreadable any other way, and the caller has already
// been checked by the time anything in here writes.
async function sb(path, method, body) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(url + '/rest/v1/' + path, {
    method: method || 'GET',
    headers: {
      apikey: key, Authorization: 'Bearer ' + key,
      'content-type': 'application/json',
      Prefer: method === 'POST' ? 'resolution=merge-duplicates,return=representation' : 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + text.slice(0, 200));
  return text ? JSON.parse(text) : null;
}

// Who is asking, from their own token -- never a role passed in from the page.
async function callerProfile(authHeader) {
  if (!authHeader) return null;
  const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: authHeader }
  });
  if (!r.ok) return null;
  const user = await r.json().catch(() => null);
  if (!user || !user.id) return null;
  const rows = await sb('profiles?id=eq.' + user.id + '&select=id,role');
  return (rows && rows[0]) || null;
}

/* The credentials in use, table first. Exported because bookings-api.js mints Zoom
   meetings and must read them the same way; two readers that disagree would mean the
   connector row and the booking that fails are talking about different credentials. */
async function zoomCreds() {
  let row = null;
  try {
    const rows = await sb('growth_secrets?key=eq.' + KEY + '&select=value,label');
    row = (rows && rows[0]) || null;
  } catch (e) { row = null; }        // table missing on an old deploy is not an outage
  if (row && row.value) {
    try {
      const v = JSON.parse(row.value);
      if (v && v.account_id && v.client_id && v.client_secret) {
        return {
          accountId: v.account_id, clientId: v.client_id, clientSecret: v.client_secret,
          source: 'app', label: row.label || ''
        };
      }
    } catch (e) { /* unreadable row falls through to the environment */ }
  }
  const a = process.env.ZOOM_ACCOUNT_ID, c = process.env.ZOOM_CLIENT_ID, s = process.env.ZOOM_CLIENT_SECRET;
  if (a && c && s) return { accountId: a, clientId: c, clientSecret: s, source: 'netlify', label: '' };
  return null;
}

// A mint IS the proof: Zoom only answers when all three values line up.
async function mintToken(creds) {
  const basic = Buffer.from(creds.clientId + ':' + creds.clientSecret).toString('base64');
  const r = await fetch(
    'https://zoom.us/oauth/token?grant_type=account_credentials&account_id=' +
      encodeURIComponent(creds.accountId),
    { method: 'POST', headers: { Authorization: 'Basic ' + basic } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    const e = new Error(data.reason || data.error_description || data.error || 'Zoom refused the credentials');
    e.status = r.status;
    throw e;
  }
  return data.access_token;
}

// A friendly name for the row. Allowed to fail -- see the note at the top.
async function accountName(accessToken) {
  try {
    const r = await fetch('https://api.zoom.us/v2/users/me', {
      headers: { Authorization: 'Bearer ' + accessToken }
    });
    if (!r.ok) return '';
    const u = await r.json().catch(() => ({}));
    return u.email || [u.first_name, u.last_name].filter(Boolean).join(' ') || '';
  } catch (e) { return ''; }
}

const STAFF = ['owner', 'manager', 'inhouse_dev'];
const isStaff = (p) => !!p && STAFF.includes(String(p.role));

exports.zoomCreds = zoomCreds;
exports.mintToken = mintToken;

exports.handler = async (event) => {
  const action = (event.queryStringParameters || {}).action || 'status';
  const auth = event.headers.authorization || event.headers.Authorization;

  // ------------------------------------------------------------------ connect
  if (action === 'save' || action === 'disconnect') {
    const profile = await callerProfile(auth);
    if (!profile) return json(401, { error: 'Sign in first.' });
    if (!isStaff(profile)) return json(403, { error: 'Only an owner or manager can change a connector.' });

    if (action === 'disconnect') {
      try { await sb('growth_secrets?key=eq.' + KEY, 'DELETE'); } catch (e) { /* already gone */ }
      const envSet = !!(process.env.ZOOM_ACCOUNT_ID && process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET);
      return json(200, {
        configured: envSet, source: envSet ? 'netlify' : '',
        note: envSet
          ? 'Forgotten. The Zoom keys in Netlify are still set, so meetings keep working through those.'
          : 'Zoom is disconnected.'
      });
    }

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) { /* caught by the check below */ }
    const accountId = String(body.account_id || '').trim();
    const clientId = String(body.client_id || '').trim();
    const clientSecret = String(body.client_secret || '').trim();
    if (!accountId || !clientId || !clientSecret) {
      return json(400, { error: 'All three are needed: Account ID, Client ID and Client Secret.' });
    }

    // Prove them before storing them. A connector that accepts a typo and then reports
    // Connected is worse than one that refuses.
    let who = '';
    try {
      const tok = await mintToken({ accountId, clientId, clientSecret });
      who = await accountName(tok);
    } catch (e) {
      return json(400, {
        error: e.status === 400 || e.status === 401
          ? 'Zoom would not accept those. Check the Account ID, Client ID and Secret, and that the app is activated.'
          : String(e.message || e).slice(0, 200)
      });
    }

    await sb('growth_secrets?on_conflict=key', 'POST', [{
      key: KEY,
      value: JSON.stringify({ account_id: accountId, client_id: clientId, client_secret: clientSecret }),
      label: who,
      updated_at: new Date().toISOString(),
      updated_by: profile.id
    }]);
    return json(200, { configured: true, who: who, source: 'app' });
  }

  // ------------------------------------------------------------------ status
  if (action !== 'status') return json(400, { error: 'unknown action' });

  const creds = await zoomCreds();
  if (!creds) return json(200, { configured: false, who: '', source: '' });
  try {
    const tok = await mintToken(creds);
    const who = creds.label || await accountName(tok);
    return json(200, { configured: true, who: who, source: creds.source });
  } catch (e) {
    // Set but rejected is NOT connected. Credentials that have been revoked at Zoom's end
    // look identical to working ones from in here unless something asks.
    return json(200, {
      configured: false, who: '', source: creds.source,
      error: String(e.message || e).slice(0, 160)
    });
  }
};
