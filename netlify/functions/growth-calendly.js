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
// SET UP: Calendly -> Integrations -> API & webhooks -> Personal Access Token. Put it in
// Netlify as CALENDLY_TOKEN. Nothing else is needed; a personal token covers one account,
// which is what ReachGiant has.
//
//   GET ?action=status   -> { configured, who }        does the server have a token
//   GET ?action=sync     -> { added, updated, total }  pull scheduled events into Growth
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

// Supabase with the service key, so this can write meetings for whoever owns the deal.
// RLS is bypassed here on purpose: the caller has already been checked below.
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

exports.handler = async (event) => {
  const action = (event.queryStringParameters || {}).action || 'status';
  const token = process.env.CALENDLY_TOKEN;

  if (action === 'status') {
    if (!token) return json(200, { configured: false, who: '' });
    try {
      const me = await cal('/users/me', token);
      return json(200, {
        configured: true,
        who: (me.resource && (me.resource.email || me.resource.name)) || ''
      });
    } catch (e) {
      // A token that is set but rejected is NOT "connected". Saying so here is the whole
      // point of the screen -- a stale token looks identical to no token from the outside.
      return json(200, { configured: false, who: '', error: String(e.message).slice(0, 160) });
    }
  }

  if (action !== 'sync') return json(400, { error: 'unknown action' });
  if (!token) return json(503, { error: 'CALENDLY_TOKEN is not set in Netlify.' });

  const profile = await callerProfile(event.headers.authorization || event.headers.Authorization);
  if (!profile) return json(401, { error: 'Sign in first.' });
  if (!['owner', 'manager', 'inhouse_dev'].includes(String(profile.role))) {
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
