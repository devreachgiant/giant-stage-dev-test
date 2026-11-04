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
//   GET  ?action=status        -> { configured, who, source }   are they set, whose account
//   POST ?action=save          -> { configured, who }           store them, staff only
//   POST ?action=disconnect    -> { configured:false }          forget them, staff only
//   POST ?action=sync_meetings -> { added, duplicate, seen }    pull calls in, staff only
//   POST ?action=sync_recordings -> { updated, added, transcripts, summaries }
//                                                           pull recordings in, staff only
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

/* ------------------------------------------------------------------- meetings

   WHY THIS DOES NOT JUST INSERT WHAT ZOOM RETURNS. Every Calendly booking in this
   account already carries a Zoom join link -- all 21 of them on the day this was
   written -- because the Calendly event type creates the Zoom meeting itself. So the
   same call comes back twice: once from Calendly, whose external_id is the booking uri,
   and once from Zoom, whose external_id is the meeting number. Inserting both would
   double every row on Meetings, and a duplicate reads as a real second call with the
   same client rather than as a bug.

   The join between the two is the MEETING NUMBER, which both sides carry: Calendly puts
   it in the join url as /j/<number>, and Zoom calls it `id`. A Zoom meeting whose number
   is already on a row is counted and skipped, whatever put that row there. */

// The number inside a Zoom join link, or '' -- which is the honest answer for the Google
// Meet or Teams link that can sit in the same column.
function meetingNumber(url) {
  const m = String(url || '').match(/\/j\/(\d+)/);
  return m ? m[1] : '';
}

/* Zoom refuses a scope the app was never granted with a 400 naming it. That is the one
   failure worth translating: the fix is a few clicks in the Zoom marketplace and nobody
   is going to guess it from "Zoom 400". */
function scopeHint(message) {
  const m = String(message || '').match(/scopes:\[([^\]]+)\]/);
  if (!m) return '';
  const names = m[1].split(',').map(x => x.trim()).filter(Boolean);
  const want = names.find(x => /:admin$/.test(x)) || names[0];
  return 'The Zoom app does not have the ' + want + ' scope. In the Zoom marketplace open ' +
         'the app, add that scope, Activate it again, then press Sync meetings.';
}

async function zoomGet(path, token) {
  const r = await fetch('https://api.zoom.us/v2' + path, {
    headers: { Authorization: 'Bearer ' + token }
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.message || ('Zoom ' + r.status));
    e.status = r.status;
    e.hint = scopeHint(data.message);
    throw e;
  }
  return data;
}

/* Both lists, because a screen that shows only what is still to come cannot show what
   happened. Zoom pages these, and a next_page_token that goes unsent returns the first
   page forever -- so the loop ends on the token, never on a count. */
async function listZoomMeetings(token) {
  const out = [];
  for (const type of ['scheduled', 'previous_meetings']) {
    let pageToken = '';
    for (let guard = 0; guard < 20; guard++) {
      const data = await zoomGet('/users/me/meetings?type=' + type + '&page_size=300' +
        (pageToken ? '&next_page_token=' + encodeURIComponent(pageToken) : ''), token);
      for (const m of (data.meetings || [])) out.push(m);
      pageToken = data.next_page_token || '';
      if (!pageToken) break;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- recordings

   Zoom records every call on this account and none of it reached the app: a recording
   lived in Zoom and the only way to find one was to go and look. This pulls the link,
   what was said and what Zoom made of it onto the call itself.

   THE DATE WINDOW IS NOT OPTIONAL AND NOT A DETAIL. /accounts/{id}/recordings accepts
   at most one month between from and to, and when you ask for more it TRUNCATES rather
   than erroring -- six months in, one month back, nothing saying five are missing. So
   the range is walked a window at a time and the pages inside each are followed to the
   end, same as listZoomMeetings: a next_page_token that goes unsent returns page one
   forever, so the loop ends on the token and never on a count. */

function monthWindows(days) {
  const out = [];
  const end = Date.now();
  let cursor = end - Math.max(1, days) * 86400000;
  // 27 days, not "a month": February and July are not the same length and the cap is.
  while (cursor < end) {
    const stop = Math.min(end, cursor + 27 * 86400000);
    out.push([new Date(cursor).toISOString().slice(0, 10), new Date(stop).toISOString().slice(0, 10)]);
    cursor = stop + 86400000;
  }
  return out;
}

async function listRecordings(token, days) {
  const out = [];
  let downloadToken = '';
  for (const win of monthWindows(days)) {
    let pageToken = '';
    for (let guard = 0; guard < 20; guard++) {
      const data = await zoomGet('/accounts/me/recordings?from=' + win[0] + '&to=' + win[1] +
        '&page_size=300&include_fields=download_access_token' +
        (pageToken ? '&next_page_token=' + encodeURIComponent(pageToken) : ''), token);
      for (const m of (data.meetings || [])) out.push(m);
      // Only some responses carry it, and it is good for the whole account, so the last
      // one seen is kept rather than looked for again per recording.
      if (data.download_access_token) downloadToken = data.download_access_token;
      pageToken = data.next_page_token || '';
      if (!pageToken) break;
    }
  }
  return { recordings: out, downloadToken: downloadToken };
}

/* Zoom's own rule, and getting it wrong fails in the direction that looks like a
   deleted meeting rather than like a bug: a uuid that STARTS WITH / or CONTAINS //
   must be encoded twice. Anything else is encoded once. */
function uuidPath(uuid) {
  const u = String(uuid || '');
  return (u.charAt(0) === '/' || u.indexOf('//') !== -1)
    ? encodeURIComponent(encodeURIComponent(u))
    : encodeURIComponent(u);
}

/* WEBVTT in, what was actually said out. Cue numbers and timings are noise to anything
   reading this later; the speaker name is not, and Zoom puts it in the line itself. */
function vttToText(vtt) {
  const out = [];
  for (const raw of String(vtt || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === 'WEBVTT') continue;
    if (/^\d+$/.test(line)) continue;                       // cue number
    if (line.indexOf('-->') !== -1) continue;               // timing
    if (out.length && out[out.length - 1] === line) continue; // Zoom repeats a caption
    out.push(line);
  }
  return out.join('\n');
}

/* The recording host is not the API host and will not take the ordinary bearer token.
   It answers 401 -- or, worse, 200 WITH ZOOM'S SIGN-IN PAGE. That is why this checks
   the body begins WEBVTT rather than checking the status: a download that "succeeded"
   and handed back 21kB of HTML would otherwise be stored as the transcript of the call,
   and nothing downstream would ever notice. */
async function fetchTranscript(file, token, downloadToken) {
  const url = String(file.download_url || '');
  if (!url) return '';
  const tries = [];
  if (downloadToken) tries.push([url + (url.indexOf('?') === -1 ? '?' : '&') + 'access_token=' + downloadToken, {}]);
  tries.push([url, { Authorization: 'Bearer ' + token }]);
  for (const t of tries) {
    try {
      const r = await fetch(t[0], { headers: t[1] });
      const body = await r.text();
      if (r.ok && /^\uFEFF?WEBVTT/.test(body)) return vttToText(body);
    } catch (e) { /* try the other way in */ }
  }
  return '';
}

/* Zoom answers 404 "Meeting does not exist" for a meeting that exists perfectly well
   and simply has no AI Companion summary. A 404 here is an absence, not a fault, and
   the hint is carried back separately so a MISSING SCOPE does not read as an absence
   too -- those two look identical from the call site and are fixed in different places. */
async function zoomSummary(uuid, token) {
  let d;
  try {
    d = await zoomGet('/meetings/' + uuidPath(uuid) + '/meeting_summary', token);
  } catch (e) {
    return { text: '', hint: e.hint || '' };
  }
  const parts = [];
  if (d.summary_overview) parts.push(String(d.summary_overview).trim());
  for (const s of (d.summary_details || [])) {
    const label = String(s.label || '').trim();
    const text = String(s.summary || '').trim();
    if (text) parts.push((label ? label + '\n' : '') + text);
  }
  const next = (d.next_steps || []).map(x => String(x || '').trim()).filter(Boolean);
  if (next.length) parts.push('Do next\n' + next.join('\n'));
  return { text: parts.join('\n\n').trim(), hint: '' };
}

const STAFF = ['owner', 'manager', 'inhouse_dev'];
const isStaff = (p) => !!p && STAFF.includes(String(p.role));

exports.zoomCreds = zoomCreds;
exports.mintToken = mintToken;
exports.meetingNumber = meetingNumber;
exports.scopeHint = scopeHint;
exports.uuidPath = uuidPath;
exports.vttToText = vttToText;
exports.monthWindows = monthWindows;

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

  // ------------------------------------------------------------------ sync
  if (action === 'sync_meetings') {
    const profile = await callerProfile(auth);
    if (!profile) return json(401, { error: 'Sign in first.' });
    if (!isStaff(profile)) return json(403, { error: 'Only an owner or manager can sync meetings.' });

    const creds = await zoomCreds();
    if (!creds) return json(400, { error: 'Zoom is not connected, so there is nothing to sync.' });

    let meetings;
    try {
      meetings = await listZoomMeetings(await mintToken(creds));
    } catch (e) {
      // scope:true tells the screen this is a settings problem in Zoom, not a wrong key.
      return json(400, { error: e.hint || String(e.message || e).slice(0, 200), scope: !!e.hint });
    }

    // Everything the screen already shows, by meeting number, whatever put it there.
    const existing = await sb('growth_meetings?select=zoom_url,external_id');
    const have = new Set();
    for (const row of (existing || [])) {
      const n = meetingNumber(row.zoom_url);
      if (n) have.add(n);
      const x = String(row.external_id || '').match(/^zoom:(\d+)$/);
      if (x) have.add(x[1]);
    }

    const rows = [];
    let duplicate = 0, undated = 0;
    for (const m of meetings) {
      const id = String(m.id || '');
      if (!id) continue;
      /* Type 3 is "recurring, no fixed time": it has no start, so it cannot sit on a
         dated screen. Counting it is more honest than giving it today's date. */
      if (!m.start_time) { undated++; continue; }
      if (have.has(id)) { duplicate++; continue; }
      have.add(id);              // the same number twice in one pull is still one call

      /* client_id stays null on purpose. Calendly can attach a booking because it knows
         the INVITEE's email; Zoom's meeting carries only the host, who is always us, so
         matching on it would file every call under whichever deal shares Luke's address.
         An unattached call is visible to staff and can be attached by hand, which beats
         a confident wrong answer. */
      rows.push({
        external_id: 'zoom:' + id,
        client_id: null,
        title: m.topic || 'Zoom meeting',
        starts_at: m.start_time,
        minutes: Math.max(5, Number(m.duration) || 30),
        zoom_url: /^https?:\/\//.test(m.join_url || '') ? m.join_url : '',
        source: 'Zoom'
      });
    }

    if (rows.length) await sb('growth_meetings?on_conflict=external_id', 'POST', rows);
    return json(200, {
      added: rows.length, duplicate: duplicate, undated: undated, seen: meetings.length,
      note: rows.length ? ''
        : duplicate ? 'Every Zoom meeting was already on the screen through Calendly.'
        : 'Zoom returned no meetings.'
    });
  }

  // ------------------------------------------------------------- recordings
  if (action === 'sync_recordings') {
    const profile = await callerProfile(auth);
    if (!profile) return json(401, { error: 'Sign in first.' });
    if (!isStaff(profile)) return json(403, { error: 'Only an owner or manager can sync recordings.' });

    const creds = await zoomCreds();
    if (!creds) return json(400, { error: 'Zoom is not connected, so there is nothing to sync.' });

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) { /* the default below */ }
    const days = Math.min(365, Math.max(1, Number(body.days) || 120));

    let token, found;
    try {
      token = await mintToken(creds);
      found = await listRecordings(token, days);
    } catch (e) {
      return json(400, { error: e.hint || String(e.message || e).slice(0, 200), scope: !!e.hint });
    }

    /* Everything already on the screen, by MEETING NUMBER -- the one key Calendly and
       Zoom both carry. Without it a recorded Calendly booking arrives a second time as
       a Zoom row and reads as a real second call with the same client. */
    const existing = await sb('growth_meetings?select=id,zoom_url,external_id,transcript,summary');
    const byNumber = new Map();
    for (const row of (existing || [])) {
      const n = meetingNumber(row.zoom_url);
      if (n && !byNumber.has(n)) byNumber.set(n, row);
      const x = String(row.external_id || '').match(/^zoom:(\d+)$/);
      if (x && !byNumber.has(x[1])) byNumber.set(x[1], row);
    }

    let updated = 0, added = 0, transcripts = 0, summaries = 0, noTranscript = 0;
    const hints = [];

    for (const rec of found.recordings) {
      const id = String(rec.id || '');
      if (!id || !rec.start_time) continue;
      const row = byNumber.get(id) || null;
      const files = rec.recording_files || [];

      const patch = {
        recording_url: rec.share_url || '',
        /* Stored because the link alone is not enough to watch it. A passcode that
           lives only in Zoom's notification email is a recording nobody can open. */
        recording_passcode: rec.recording_play_passcode || rec.password || '',
        recording_at: (files[0] && files[0].recording_start) || rec.start_time,
        recording_minutes: Math.max(1, Number(rec.duration) || 0),
        recording_files: files.map(f => ({
          type: f.file_type || '',
          kind: f.recording_type || '',
          mb: Math.round((Number(f.file_size) || 0) / 1e5) / 10
        }))
      };

      // The transcript is the slow call, so it is made once and never again.
      if (!(row && row.transcript)) {
        /* TRANSCRIPT FIRST, and the order matters. Zoom can produce two text files for
           one call and they are not the same thing: TRANSCRIPT is the audio transcript
           and carries WHO SAID WHAT, CC is the live closed captions and carries no
           speaker at all. find() returns whichever sits earlier in Zoom's array, so a
           single test for either would take the captions on a call that had both and
           quietly lose the attribution. Nothing on this account has a TRANSCRIPT file
           today -- "Create audio transcript" is off in Zoom's recording settings -- so
           this is the branch that starts working the day somebody turns it on. */
        const cc = files.find(f => f.file_type === 'TRANSCRIPT')
                || files.find(f => f.file_type === 'CC');
        if (cc) {
          const text = await fetchTranscript(cc, token, found.downloadToken);
          if (text) { patch.transcript = text; transcripts++; } else { noTranscript++; }
        }
      }

      /* Zoom's own summary wins when there is one: it is free, and it is the host's
         words rather than ours. A summary already on the row is never replaced -- a
         later sync finding nothing would otherwise wipe one Claude had written. */
      if (!(row && row.summary)) {
        const s = await zoomSummary(rec.uuid, token);
        if (s.hint && hints.indexOf(s.hint) === -1) hints.push(s.hint);
        if (s.text) {
          patch.summary = s.text;
          patch.summary_at = new Date().toISOString();
          patch.summary_source = 'zoom';
          summaries++;
        }
      }

      if (row) {
        await sb('growth_meetings?id=eq.' + row.id, 'PATCH', patch);
        updated++;
      } else {
        /* A recording with no booking behind it is still a call that happened: an
           instant meeting, or one started outside Calendly. A row is the only place it
           can carry notes. Same external_id shape sync_meetings uses, on the same
           unique key, so the two actions cannot produce the call twice. */
        await sb('growth_meetings?on_conflict=external_id', 'POST', [Object.assign({
          external_id: 'zoom:' + id,
          client_id: null,
          title: rec.topic || 'Zoom call',
          starts_at: rec.start_time,
          minutes: Math.max(5, Number(rec.duration) || 30),
          zoom_url: '',
          source: 'Zoom'
        }, patch)]);
        added++;
      }
    }

    if (noTranscript) {
      hints.unshift('The Zoom app cannot download recording files, so ' + noTranscript +
        (noTranscript === 1 ? ' call has no transcript' : ' calls have no transcript') +
        '. In the Zoom marketplace open the app, add cloud_recording:read:list_recording_files:admin, ' +
        'Activate it again, then sync once more.');
    }

    return json(200, {
      updated: updated, added: added, transcripts: transcripts, summaries: summaries,
      seen: found.recordings.length, days: days,
      hint: hints.join(' '),
      note: found.recordings.length ? ''
        : 'Zoom has no cloud recordings in the last ' + days + ' days.'
    });
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
