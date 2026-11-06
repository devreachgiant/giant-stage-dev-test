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

/* WHAT THE PERSON TOLD THE BOOKING FORM. Ten questions -- budget, how ready they are,
   when they want to start, revenue, where they heard of us -- and every answer used to be
   dropped on the floor: the invitee was read only to find an email to match a deal by.
   Whoever took the call had a name and a time and had to open Calendly in another tab.

   Kept in Calendly's own order (position), and only the fields the panel shows. The raw
   invitee also carries payment, routing form submissions and utm tracking; none of it is
   read here, and storing it would age badly in a row we keep forever.

   A sync that cannot read the invitee writes null, exactly as it already leaves the email
   blank -- it does not try to preserve what was there. The next run restores it, and the
   job runs every half hour, so a transient Calendly hiccup heals itself. */
function inviteeRecord(inv) {
  const qa = (inv.questions_and_answers || []).slice()
    .sort((a, b) => (a.position || 0) - (b.position || 0))
    .map(x => ({ q: String(x.question || '').trim(), a: String(x.answer || '').trim() }))
    .filter(x => x.q && x.a);
  return {
    name: inv.name || '',
    email: String(inv.email || '').toLowerCase(),
    phone: inv.text_reminder_number || '',
    timezone: inv.timezone || '',
    booked_at: inv.created_at || '',
    qa: qa
  };
}

/* WHO A NEW DEAL BELONGS TO. Calendly cannot say. Every booking here is hosted by the
   shared growth@ address -- event_memberships names that mailbox on every single event,
   never a person -- so there is nothing in the booking that identifies a rep. It goes to
   whoever runs Growth, read as the profile already holding the most deals. That is a fact
   about the data rather than an id written in here, and it follows Growth if it changes
   hands. */
function busiestOwner(deals) {
  const tally = new Map();
  (deals || []).forEach(d => {
    if (d.owner_id) tally.set(d.owner_id, (tally.get(d.owner_id) || 0) + 1);
  });
  let best = null, most = 0;
  for (const [id, n] of tally) if (n > most) { most = n; best = id; }
  return best;
}

// Only reached on a pipeline with no deals in it at all, which is the first sync ever.
async function fallbackOwner() {
  try {
    const rows = await sb('profiles?role=in.(owner,manager,inhouse_dev)&select=id,role&limit=20');
    const byRole = (r) => (rows || []).find(p => p.role === r);
    const pick = byRole('owner') || byRole('manager') || byRole('inhouse_dev');
    return pick ? pick.id : null;
  } catch (e) { return null; }
}

/* SOMEBODY HAS TO BE TOLD. On 2026-11-05 Erica Morgan booked at 15:12 for a call at
   16:00 and the team missed it. The sync was blameless -- the booking was in the
   database at 15:20, 39 minutes before the call, with its Zoom link and attached to a
   deal. Nothing anywhere said so. It sat on a screen waiting to be looked at, and for a
   call booked 47 minutes ahead "go and look" is not a plan. Two of the nineteen
   bookings on record came in under four hours' notice, so this was not a freak.

   Giant already has notifications -- 4,140 of them, for mentions and task assignments
   -- and Growth wrote to none of it. This is that gap, and nothing more: an in-app
   notification, which is seen when somebody has Giant open. Whether a call booked
   inside the hour should also reach Slack is Luke's call, not this file's.

   WHO. The owner of the deal, because that is whose call it is. A booking with no deal
   goes to everybody on the Growth team rather than nobody -- an unmatched booking is
   exactly the one most likely to be missed.

   ONCE. notifications has a unique index on (recipient_id, dedupe_key), so the key is
   the Calendly event uri and a re-run rewrites rather than adding a second. Without it
   the ten-minute timer would say the same thing 144 times a day. */
function whenPhrase(startsAt) {
  const mins = Math.round((new Date(startsAt) - Date.now()) / 60000);
  if (mins < 0) return 'It has already started';
  if (mins < 60) return 'It starts in ' + mins + ' minute' + (mins === 1 ? '' : 's');
  if (mins < 60 * 20) {
    const h = Math.round(mins / 60);
    return 'It starts in about ' + h + ' hour' + (h === 1 ? '' : 's');
  }
  /* Beyond a day, a relative phrase stops helping -- "in 3 days" is not something you
     can put in a calendar. */
  return 'It is on ' + new Date(startsAt).toUTCString().slice(0, 16) + ' UTC';
}

async function tellSomebody(fresh) {
  const soon = (fresh || []).filter(r => new Date(r.starts_at) > Date.now());
  if (!soon.length) return 0;

  let team = [];
  try {
    const row = await sb('growth_settings?key=eq.team&select=value');
    if (row && row[0] && Array.isArray(row[0].value)) team = row[0].value;
  } catch (e) { /* no team row: fall back to the deal owner alone */ }

  const owners = new Map();
  try {
    const deals = await sb('growth_clients?select=id,owner_id');
    (deals || []).forEach(d => { if (d.owner_id) owners.set(d.id, d.owner_id); });
  } catch (e) { /* unmatched bookings still reach the team below */ }

  const notes = [];
  for (const r of soon) {
    const owner = r.client_id ? owners.get(r.client_id) : null;
    const to = owner ? [owner] : team;
    if (!to.length) continue;
    const who = (r.invitee && r.invitee.name) || 'Somebody';
    const mins = Math.round((new Date(r.starts_at) - Date.now()) / 60000);
    to.forEach(id => notes.push({
      recipient_id: id,
      actor_id: null,                       // the sync is nobody, and the policy allows null
      type: 'growth_booking',
      /* The urgency is in the TITLE, because a notification list is read as a column of
         titles and "New booking" reads the same whether the call is in nine days or
         nine minutes. */
      title: mins < 240 ? 'Call soon: ' + who : 'New booking: ' + who,
      body: who + ' booked ' + (r.title || 'a call') + '. ' + whenPhrase(r.starts_at),
      dedupe_key: 'growth_booking:' + r.external_id
    }));
  }
  if (!notes.length) return 0;
  try {
    /* sb() already sends resolution=merge-duplicates on every POST, so the unique
       index on (recipient_id, dedupe_key) turns a re-run into a rewrite. */
    await sb('notifications?on_conflict=recipient_id,dedupe_key', 'POST', notes);
    return notes.length;
  } catch (e) {
    /* A booking that arrived and a notification that did not is still better than
       failing the sync and losing the booking too. */
    console.error('[growth-calendly] could not notify', e.message);
    return 0;
  }
}

/* The sync itself, with no HTTP around it. Two things call this: the Sync now button,
   and growth-sync.mjs on its half-hourly timer. One implementation, because two would
   drift and the one that drifted would be the one running at 3am unattended. */
async function runSync(token) {
  const me = await cal('/users/me', token);
  const userUri = me.resource.uri;
  const orgUri = me.resource.current_organization;
  /* Our own domain, taken from the Calendly account instead of written in. Somebody here
     booking the link to see what it looks like is a test, not a lead, and a deal named
     "ReachGiant Test" sitting in the pipeline is worse than no deal at all. */
  const ourDomain = String(me.resource.email || '').split('@')[1] || '';

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
  const needDeal = new Map();       // invitee email -> { name, at: [row indexes] }
  for (const ev of events) {
    if (ev.status === 'canceled') continue;
    let inviteeEmail = '', inviteeName = '', invitee = null;
    try {
      const inv = await cal(ev.uri + '/invitees?count=1', token);
      const first = (inv.collection || [])[0];
      if (first) {
        inviteeEmail = String(first.email || '').toLowerCase();
        inviteeName = first.name || '';
        invitee = inviteeRecord(first);
      }
    } catch (e) { /* a booking with no readable invitee is still a booking */ }

    const deal = inviteeEmail ? byEmail.get(inviteeEmail) : null;
    const ours = ourDomain && inviteeEmail.endsWith('@' + ourDomain);
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
      source: 'Calendly',
      // Present on every row even when null: PostgREST refuses a batch whose objects do
      // not all carry the same keys.
      invitee: invitee
    });
    if (!deal && inviteeName) rows[rows.length - 1].title = ev.name + ' — ' + inviteeName;

    /* AN ONBOARDING CALL IS NOT A LEAD. Calendly carries two event types now: the Growth
       Strategy Session, which is a stranger, and the Kickoff Call, which is somebody who
       has already paid and is being started. Both arrive here the same way.

       Opening a deal from a kickoff would put a client we have already won back at the
       top of the pipeline as a fresh prospect, and the only way it does NOT happen is
       the booking matching an existing deal by email -- which is exactly the thing that
       fails when somebody books with a different address from the one we hold. So it is
       refused outright rather than left to a coincidence.

       The booking itself is still kept, with a null client_id, the same as a colleague
       testing the link: it shows on Meetings and can be attached to its deal by hand.
       Nothing is lost, and nothing is invented. */
    const onboarding = /kick ?off|onboard/i.test(String(ev.name || ''));

    /* A booking nobody is tracking. One entry per EMAIL, not per booking: three bookings
       from the same person are three calls with one lead, and three deals for them would
       be the pipeline counting one person three times. */
    if (!deal && inviteeEmail && !ours && !onboarding) {
      if (!needDeal.has(inviteeEmail)) needDeal.set(inviteeEmail, { name: inviteeName, at: [] });
      needDeal.get(inviteeEmail).at.push(rows.length - 1);
    }
  }

  if (!rows.length) return { added: 0, updated: 0, total: 0, dealsCreated: 0, note: 'No bookings in range.' };

  /* CREATE THE MISSING DEALS. Until now a booking that matched nothing was kept with a
     null client_id and nothing ever made one, so every booking since the pipeline was
     last tidied by hand sat outside it -- twelve of twenty-one rows on the day this was
     written. Somebody booked a call and never appeared in the pipeline at all.

     THIS USED TO SAY it did not fix the Growth Inbox, because nothing anywhere wrote an
     inbound row into growth_messages and a reply had nothing to land in. That stopped
     being true on 20261105: growth-gmail.js matches the mail already in `emails` back to
     the deal it belongs to, on the same ten-minute timer. So a deal created here now
     does carry its replies -- which makes the deal matter more, not less, and is why
     the kickoff rule above is worth being careful about. */
  let dealsCreated = 0;
  if (needDeal.size) {
    const owner = busiestOwner(deals) || await fallbackOwner();
    if (owner) {
      const fresh = [...needDeal.entries()].map(([email, v]) => ({
        owner_id: owner,
        name: v.name || email.split('@')[0],
        email: email,
        stage: 'booked',          // the first stage: they have booked and not yet been met
        source: 'Calendly'
      }));
      const made = await sb('growth_clients', 'POST', fresh);
      (made || []).forEach(d => {
        const v = needDeal.get(String(d.email || '').toLowerCase());
        if (v) v.at.forEach(i => { rows[i].client_id = d.id; });
      });
      dealsCreated = (made || []).length;
    }
  }

  const before = await sb('growth_meetings?select=external_id&source=eq.Calendly');
  const seen = new Set((before || []).map(r => r.external_id));
  const written = await sb('growth_meetings?on_conflict=external_id', 'POST', rows);

  const added = rows.filter(r => !seen.has(r.external_id)).length;
  const told = await tellSomebody(rows.filter(r => !seen.has(r.external_id)));
  return {
    added, updated: rows.length - added, total: (written || rows).length,
    matched: rows.filter(r => r.client_id).length,
    dealsCreated: dealsCreated,
    withZoom: rows.filter(r => r.zoom_url).length
  };
}
exports.runSync = runSync;
exports.busiestOwner = busiestOwner;

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
    const out = await runSync(token);
    return json(200, out);
  } catch (e) {
    return json(502, { error: String(e.message || e).slice(0, 300) });
  }
};
