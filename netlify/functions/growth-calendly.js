// Calendly -> Growth meetings.
//
// The only connector Growth needed that Giant did not already have. Gmail is the Email
// screen's connection (window.giantGmailSend) and Zoom is bookings-api.js's server
// credentials; both were already set up, so neither is rebuilt here.
//
// WHY A FUNCTION AND NOT A FETCH FROM THE PAGE. The Calendly token is a bearer token for
// the whole account. In the page it would be readable by anyone with devtools, and
// config.js is public by design. It lives in Netlify and never leaves this process.
//
// WHERE THE TOKEN LIVES. Two places, in this order:
//
//   1. growth_secrets.calendly_token, written by Connectors through ?action=save
//   2. CALENDLY_TOKEN in Netlify, which is how this worked before and still works
//
// The table wins, so connecting in the app overrides a stale environment variable rather
// than silently losing to it. Nothing reads that row but this function: growth_secrets
// has RLS on, no policies and no grants, so the publishable key gets nothing
// (20261022150000). The token never goes near the browser after it is handed over.
//
// SET UP: Calendly -> Integrations -> API & webhooks -> Personal Access Token, then
// paste it into Growth -> Connectors -> Calendly. A personal token covers one account,
// which is what ReachGiant has.
//
//   GET  ?action=status     -> { configured, who, source }   is there a token, whose
//   GET  ?action=sync       -> { added, updated, total }     pull bookings into Growth
//   POST ?action=save       -> { configured, who }           store a token, staff only
//   POST ?action=disconnect -> { configured:false }          forget it, staff only
//
// save PROVES the token before storing it. A connector that accepts a typo and then
// reports Connected is worse than one that refuses, because the next thing that fails
// is a sync at 3am that nobody is watching.
//
// Sync is idempotent. Calendly's event uri is stored as growth_meetings.external_id, which
// is unique, so running it twice updates rather than duplicating -- a re-sync after
// somebody reschedules has to move the existing row, not leave two.

const API = 'https://api.calendly.com';

const json = (code, body) => ({
  statusCode: code,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body)
});

async function cal(path, token) {
  const r = await fetch(path.startsWith('http') ? path : API + path, {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    const e = new Error('Calendly ' + r.status + (t ? ': ' + t.slice(0, 200) : ''));
    e.status = r.status;
    throw e;
  }
  return r.json();
}

// Supabase with the service key, so this can write meetings for whoever owns the deal
// and read the connector credential. RLS is bypassed here on purpose: the caller has
// already been checked below, and growth_secrets is unreadable any other way.
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

// Who is asking? Growth is staff-and-reps only, and a sync writes rows, so the caller's
// own token decides -- never a role passed in from the page.
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

// The stored credential, if there is one. Nothing else in the app can ask for this.
async function storedToken() {
  try {
    const rows = await sb('growth_secrets?key=eq.calendly_token&select=value,label');
    return (rows && rows[0]) || null;
  } catch (e) { return null; }      // table missing on an old deploy is not an outage
}

const STAFF = ['owner', 'manager', 'inhouse_dev'];
const isStaff = (p) => !!p && STAFF.includes(String(p.role));

exports.handler = async (event) => {
  const action = (event.queryStringParameters || {}).action || 'status';
  const auth = event.headers.authorization || event.headers.Authorization;

  const row = await storedToken();
  const token = (row && row.value) || process.env.CALENDLY_TOKEN || '';
  const source = row && row.value ? 'app' : (process.env.CALENDLY_TOKEN ? 'netlify' : '');

  // ------------------------------------------------------------------ connect
  if (action === 'save' || action === 'disconnect') {
    const profile = await callerProfile(auth);
    if (!profile) return json(401, { error: 'Sign in first.' });
    if (!isStaff(profile)) return json(403, { error: 'Only an owner or manager can change a connector.' });

    if (action === 'disconnect') {
      try { await sb('growth_secrets?key=eq.calendly_token', 'DELETE'); } catch (e) { /* already gone */ }
      return json(200, {
        configured: !!process.env.CALENDLY_TOKEN, source: process.env.CALENDLY_TOKEN ? 'netlify' : '',
        note: process.env.CALENDLY_TOKEN
          ? 'Forgotten. CALENDLY_TOKEN in Netlify is still set, so bookings keep syncing through that.'
          : 'Calendly is disconnected.'
      });
    }

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) { /* handled by the check below */ }
    const given = String(body.token || '').trim();
    if (!given) return json(400, { error: 'Paste the token first.' });

    // Prove it before storing it.
    let who = '';
    try {
      const me = await cal('/users/me', given);
      who = (me.resource && (me.resource.email || me.resource.name)) || '';
    } catch (e) {
      return json(400, {
        error: e.status === 401
          ? 'Calendly would not accept that token. Check you copied the whole thing.'
          : String(e.message || e).slice(0, 200)
      });
    }

    await sb('growth_secrets?on_conflict=key', 'POST', [{
      key: 'calendly_token', value: given, label: who,
      updated_at: new Date().toISOString(), updated_by: profile.id
    }]);
    return json(200, { configured: true, who: who, source: 'app' });
  }

  // ------------------------------------------------------------------ status
  if (action === 'status') {
    if (!token) return json(200, { configured: false, who: '', source: '' });
    try {
      const me = await cal('/users/me', token);
      return json(200, {
        configured: true, source: source,
        who: (me.resource && (me.resource.email || me.resource.name)) || ''
      });
    } catch (e) {
      // A token that is set but rejected is NOT "connected". Saying so here is the whole
      // point of the screen -- a stale token looks identical to no token from the outside.
      return json(200, { configured: false, who: '', source: source,
                         error: String(e.message).slice(0, 160) });
    }
  }

  if (action !== 'sync') return json(400, { error: 'unknown action' });
  if (!token) return json(503, { error: 'Calendly is not connected yet.' });

  const profile = await callerProfile(auth);
  if (!profile) return json(401, { error: 'Sign in first.' });
  if (!isStaff(profile)) {
    return json(403, { error: 'Only an owner or manager can sync Calendly.' });
  }

  try {
    const me = await cal('/users/me', token);
    const userUri = me.resource.uri;
    const orgUri = me.resource.current_organization;

    // Everything from a week ago forward: far enough back that this morning's call is
    // still picked up, not so far that a first sync pulls years of history.
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    let url = '/scheduled_events?count=100&sort=start_time:asc'
      + '&organization=' + encodeURIComponent(orgUri)
      + '&user=' + encodeURIComponent(userUri)
      + '&min_start_time=' + encodeURIComponent(since);

    const events = [];
    for (let page = 0; page < 10 && url; page++) {
      const data = await cal(url, token);
      events.push(...(data.collection || []));
      url = (data.pagination && data.pagination.next_page) || null;
    }

    // Match a booking to a deal by the invitee's email. Anything that does not match is
    // still worth keeping -- an unmatched meeting with no client is visible to staff and
    // can be attached later, which beats dropping it silently.
    const deals = await sb('growth_clients?select=id,email,owner_id');
    const byEmail = new Map();
    (deals || []).forEach(d => { if (d.email) byEmail.set(String(d.email).toLowerCase(), d); });

    const rows = [];
    for (const ev of events) {
      if (ev.status === 'canceled') continue;
      let inviteeEmail = '', inviteeName = '';
      try {
        const inv = await cal(ev.uri + '/invitees?count=1', token);
        const first = (inv.collection || [])[0];
        if (first) { inviteeEmail = String(first.email || '').toLowerCase(); inviteeName = first.name || ''; }
      } catch (e) { /* a booking with no readable invitee is still a booking */ }

      const deal = inviteeEmail ? byEmail.get(inviteeEmail) : null;
      const loc = ev.location || {};
      const joinUrl = loc.join_url || loc.location || '';
      const mins = Math.max(5, Math.round(
        (new Date(ev.end_time) - new Date(ev.start_time)) / 60000) || 30);

      rows.push({
        external_id: ev.uri,
        client_id: deal ? deal.id : null,
        title: ev.name || 'Calendly booking',
        starts_at: ev.start_time,
        minutes: mins,
        zoom_url: /^https?:\/\//.test(joinUrl) ? joinUrl : '',
        source: 'Calendly'
      });
      if (!deal && inviteeName) rows[rows.length - 1].title = ev.name + ' — ' + inviteeName;
    }

    if (!rows.length) return json(200, { added: 0, updated: 0, total: 0, note: 'No bookings in range.' });

    const before = await sb('growth_meetings?select=external_id&source=eq.Calendly');
    const seen = new Set((before || []).map(r => r.external_id));
    const written = await sb('growth_meetings?on_conflict=external_id', 'POST', rows);

    const added = rows.filter(r => !seen.has(r.external_id)).length;
    return json(200, {
      added, updated: rows.length - added, total: (written || rows).length,
      matched: rows.filter(r => r.client_id).length,
      withZoom: rows.filter(r => r.zoom_url).length
    });
  } catch (e) {
    return json(502, { error: String(e.message || e).slice(0, 300) });
  }
};
