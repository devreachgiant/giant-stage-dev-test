// Netlify Scheduled Function: growth-sync
//
// Runs every 30 minutes and keeps Growth current without anybody pressing anything.
// Each run writes one row to growth_runs saying what it did, because the Automations
// screen answers exactly one question -- is the thing that is supposed to be happening
// actually happening -- and it can only answer that from evidence.
//
// WHAT IT DOES, and what it deliberately does not:
//
//   Calendly bookings   pulled in, attached to the matching deal by email address.
//                       Shares runSync() with the Sync now button, so there is one
//                       implementation rather than two that drift.
//   Gmail replies       matched back to the deal they belong to. The mailbox itself is
//                       pulled in by gmail-sync on its own ten-minute schedule; this
//                       step is only the Growth-specific half -- deciding which of
//                       those messages belong to which deal and copying those into
//                       growth_messages, where the whole sales team can read them.
//                       Two earlier versions of this comment explained why it could
//                       not be done: first that a server cannot renew a Google token
//                       (untrue since Gmail moved to the authorization code flow), then
//                       that the matching was missing (true until 20261105).
//   Zoom recordings     pulled in, with the transcript and Zoom's own summary where
//                       there is one, attached to the call they belong to by Zoom
//                       meeting number. Shares runRecordingSync() with the Sync
//                       recordings button, same reason as Calendly.
//   Fathom             removed 20261028. Zoom and Calendly record calls themselves,
//                      so a third recorder was a connector nobody was going to set up.
//
// A step that cannot run is still REPORTED. A screen that lists only what works tells
// you nothing about the thing you are actually wondering about.

import cal from './growth-calendly.js';
import zoom from './growth-zoom.js';
import gmail from './growth-gmail.js';

const SUPA = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, method = 'GET', payload = null) {
  const res = await fetch(SUPA + '/rest/v1/' + path, {
    method,
    headers: {
      apikey: KEY, Authorization: 'Bearer ' + KEY,
      'content-type': 'application/json', Prefer: 'return=representation'
    },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const txt = await res.text();
  if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + txt.slice(0, 200));
  return txt ? JSON.parse(txt) : null;
}

async function calendlyToken() {
  try {
    const rows = await sb('growth_secrets?key=eq.calendly_token&select=value');
    if (rows && rows[0] && rows[0].value) return rows[0].value;
  } catch (e) { /* fall through to the environment */ }
  return process.env.CALENDLY_TOKEN || '';
}

export default async () => {
  const began = Date.now();
  const steps = [];
  let ok = true;

  // ---------------------------------------------------------------- Calendly
  const token = await calendlyToken();
  if (!token) {
    steps.push({ k: 'calendly', label: 'Calendly bookings',
                 said: 'Not connected yet', ok: null });
  } else {
    try {
      const r = await cal.runSync(token);
      steps.push({
        k: 'calendly', label: 'Calendly bookings', ok: true,
        said: r.total
          ? r.added + ' new, ' + r.updated + ' updated' +
            (r.matched != null ? ', ' + r.matched + ' matched to a deal' : '')
          : (r.note || 'No new bookings')
      });
    } catch (e) {
      ok = false;
      steps.push({ k: 'calendly', label: 'Calendly bookings', ok: false,
                   said: String((e && e.message) || e).slice(0, 180) });
    }
  }

  // -------------------------------------------------------- Zoom cloud recordings
  /* TWO DAYS, not the button's 120. This runs every half hour and only ever needs to
     notice what was recorded since it last ran; the long window belongs to a backfill
     somebody is watching. At 120 days each run costs five listing requests plus a
     summary lookup per recording, and half-hourly that is thousands of calls a day
     against endpoints Zoom rate-limits heavily, to find nothing almost every time.

     Why not every minute, which is what was asked for: a Zoom cloud recording is not
     there the moment a call ends. Zoom processes the video and generates the transcript
     afterwards, minutes to hours later. Polling faster than Zoom produces does not make
     a recording arrive sooner, it only asks more often while the answer is still no. */
  try {
    const creds = await zoom.zoomCreds();
    if (!creds) {
      steps.push({ k: 'zoomrec', label: 'Zoom recordings', ok: null,
                   said: 'Zoom is not connected, so there is nothing to pull' });
    } else {
      const r = await zoom.runRecordingSync(creds, 2);
      const n = (r.updated || 0) + (r.added || 0);
      steps.push({
        k: 'zoomrec', label: 'Zoom recordings', ok: true,
        said: (n
          ? n + ' call' + (n === 1 ? '' : 's') + ' now carry their recording' +
            (r.transcripts ? ', ' + r.transcripts + ' transcript' + (r.transcripts === 1 ? '' : 's') : '') +
            (r.summaries ? ', ' + r.summaries + ' summary' : '')
          : 'No new recordings') +
          (r.hint ? ' \u2014 ' + r.hint : '')
      });
    }
  } catch (e) {
    ok = false;
    steps.push({ k: 'zoomrec', label: 'Zoom recordings', ok: false,
                 said: String((e && e.hint) || (e && e.message) || e).slice(0, 180) });
  }

  // ---------------------------------------------------------------- Gmail replies
  /* No date window, unlike the two steps above. This one filters by deal address
     rather than by date, so a full pass returns only what matched -- see the long
     note at the top of growth-gmail.js. */
  try {
    const r = await gmail.runMessageSync();
    steps.push({
      k: 'gmail', label: 'Gmail replies', ok: r.ok ? true : null,
      said: r.ok
        ? (r.matched
            ? r.matched + ' message' + (r.matched === 1 ? '' : 's') + ' on ' + r.deals
              + ' deal' + (r.deals === 1 ? '' : 's')
              + ' (' + r.inbound + ' in, ' + r.outbound + ' out)'
            : r.note)
        : r.note
    });
  } catch (e) {
    ok = false;
    steps.push({ k: 'gmail', label: 'Gmail replies', ok: false,
                 said: String((e && e.message) || e).slice(0, 180) });
  }

  /* The note quoted Calendly alone, which was right while Calendly was the only step
     that did anything. With recordings in here, a run that pulled a call in and said
     "No new bookings" would be reporting the half that did nothing. */
  const note = steps.filter(x => x.ok === false).length
    ? steps.filter(x => x.ok === false).map(x => x.label + ': ' + x.said).join(' ')
    : steps.filter(x => x.ok === true).map(x => x.said).filter(Boolean).join(' \u00B7 ');

  try {
    await sb('growth_runs', 'POST', [{
      job: 'growth_sync', ok: ok, ms: Date.now() - began, steps: steps, note: note
    }]);
  } catch (e) {
    // The run still happened; losing the log is not worth failing it over.
    console.error('[growth-sync] could not write the run', e.message);
  }

  return new Response(JSON.stringify({ ok, ms: Date.now() - began, steps }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
};

/* TEN MINUTES, not thirty and not one. Counted on 2026-11-04, a run makes 33 outbound
   requests and takes 11.5s, so the interval is a real bill and not a free dial: at ten
   minutes that is ~1,580 Calendly and ~290 Zoom requests a day and ~28 minutes of
   function time; at one minute it would be ~15,800 and ~2,900 and over four hours.

   Ten rather than five because the run is not yet cheap enough to deserve five. Nine of
   its eleven Calendly requests are invitee lookups for bookings ALREADY held -- the
   same answer fetched again every run. Fix that and five is easy; until then five would
   mostly buy more of the same waste. */
export const config = { schedule: '*/10 * * * *' };
