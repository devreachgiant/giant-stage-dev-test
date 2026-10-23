// Gmail sync: on a schedule for everyone, on demand for one person.
//
// Two callers, one implementation (_gmail.js). The browser used to own this, so a
// mailbox was only as current as the last time somebody had the Email tab open. Now
// the tab and the schedule ask the same endpoint to do the same thing, and the screen
// just reads what is in the database.
//
// POST with a signed-in user sync THAT person's mailboxes. This is what Refresh calls.
// The schedule (netlify.toml)         syncs every mailbox that has a refresh token.
//
// A mailbox that fails does not stop the others: each one reports, and the response
// says what happened to each, because "the sync ran" is not the same as "your mail
// arrived" and only one of those is worth knowing.

const { allowOrigin } = require('./_cors');
const { requireUser } = require('./_auth');
const { syncMailbox, mailboxes } = require('./_gmail');

async function runFor(profileId) {
  const rows = await mailboxes(profileId);
  const results = [];
  for (const row of rows) {
    try { results.push(await syncMailbox(row)); }
    catch (e) {
      console.error('[gmail-sync]', row.email, e.message);
      results.push({ profile_id: row.profile_id, slot: row.slot, email: row.email,
                     ok: false, error: e.message });
    }
  }
  return results;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin(event),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  /* Netlify invokes a scheduled function with no caller of its own, so there is no
     user to require and every mailbox is in scope. A request from a browser is the
     other case: it must be signed in, and it only ever syncs its own. */
  const scheduled = !!(event.headers && event.headers['x-nf-event'] === 'schedule');
  const began = Date.now();

  if (scheduled) {
    const results = await runFor(null);
    const ok = results.filter(r => r.ok).length;
    console.log('[gmail-sync] scheduled:', ok + '/' + results.length, 'mailboxes',
      Date.now() - began + 'ms');
    return { statusCode: 200, headers,
      body: JSON.stringify({ scheduled: true, ok, of: results.length, results }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const auth = await requireUser(event);
  if (!auth.ok) return { statusCode: auth.response.statusCode, headers, body: auth.response.body };

  try {
    const results = await runFor(auth.user.id);
    return { statusCode: 200, headers, body: JSON.stringify({
      ok: results.some(r => r.ok), ms: Date.now() - began, results }) };
  } catch (e) {
    console.error('[gmail-sync]', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
