// Gmail sync, on demand. This is what the Refresh button calls.
//
// SEPARATE FROM gmail-sync-cron.js, and not because two copies are wanted -- the work
// itself is in _gmail.js and both files call that. Netlify REFUSES HTTP requests to a
// scheduled function: 403, empty body, before the handler runs at all. The first
// version of this was one file doing both jobs, which failed in the quietest possible
// way -- the ten-minute schedule ran perfectly while every press of Refresh got a 403
// that said nothing about why.
//
// Signed in, always, and only ever the caller's own mailboxes.
//
// A mailbox that fails does not stop the others: each reports, and the response says
// what happened to each, because "the sync ran" and "your mail arrived" are not the
// same thing and only one of them is worth knowing.

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
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const auth = await requireUser(event);
  if (!auth.ok) return { statusCode: auth.response.statusCode, headers, body: auth.response.body };

  const began = Date.now();
  try {
    const results = await runFor(auth.user.id);
    return { statusCode: 200, headers, body: JSON.stringify({
      ok: results.some(r => r.ok), ms: Date.now() - began, results }) };
  } catch (e) {
    console.error('[gmail-sync]', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

module.exports.runFor = runFor;
