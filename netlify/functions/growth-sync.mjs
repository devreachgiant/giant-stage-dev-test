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
//   Gmail replies       NOT done here -- but no longer for the reason this comment
//                       used to give. It said a server cannot renew a Gmail token on
//                       its own, which was true while the browser got tokens through
//                       Google's implicit flow: an hour of access and nothing to renew
//                       it with. Gmail uses the authorization code flow now and
//                       gmail_tokens holds a refresh token, so a server CAN. The
//                       mailbox itself is synced by gmail-sync (every ten minutes);
//                       what is still missing is the Growth-specific part -- matching
//                       replies back to deals -- not the ability to read mail.
//   Fathom call notes   not built.
//
// A step that cannot run is still REPORTED. A screen that lists only what works tells
// you nothing about the thing you are actually wondering about.

import cal from './growth-calendly.js';

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

  // ---------------------------------------------------------------- the rest, honestly
  steps.push({ k: 'gmail', label: 'Gmail replies', ok: null,
               said: 'Not set up. The stored Google token lasts an hour and cannot be renewed from a server.' });
  steps.push({ k: 'fathom', label: 'Fathom call notes', ok: null,
               said: 'Not built yet' });

  const note = steps.filter(x => x.ok === false).length
    ? steps.filter(x => x.ok === false).map(x => x.label + ': ' + x.said).join(' ')
    : (steps.find(x => x.k === 'calendly') || {}).said || '';

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

export const config = { schedule: '*/30 * * * *' };
