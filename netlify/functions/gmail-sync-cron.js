// Gmail sync on a schedule. Every ten minutes, every connected mailbox.
//
// SEPARATE FROM gmail-sync.js ON PURPOSE, and not because two copies are wanted --
// the logic lives in _gmail.js and both files call it. Netlify REFUSES HTTP requests
// to a scheduled function: it answers 403 with an empty body before the handler runs
// at all. One file doing both jobs therefore cannot work, and the way it fails is
// quiet -- the schedule keeps running perfectly while every Refresh gets a 403 that
// says nothing about why.
//
// So: this one is the clock's. gmail-sync.js is the person's.

const { syncMailbox, mailboxes } = require('./_gmail');

async function runFor(profileId) {
  const rows = await mailboxes(profileId);
  const results = [];
  for (const row of rows) {
    try { results.push(await syncMailbox(row)); }
    catch (e) {
      console.error('[gmail-sync-cron]', row.email, e.message);
      results.push({ profile_id: row.profile_id, slot: row.slot, email: row.email,
                     ok: false, error: e.message });
    }
  }
  return results;
}

exports.handler = async () => {
  const began = Date.now();
  const results = await runFor(null);
  const ok = results.filter(r => r.ok).length;
  console.log('[gmail-sync-cron]', ok + '/' + results.length, 'mailboxes',
    Date.now() - began + 'ms');
  /* Every mailbox reports, including the ones that could not run. A scheduled job
     that logs only its successes cannot answer the question anybody actually has,
     which is whether the thing supposed to be happening is happening. */
  results.filter(r => !r.ok).forEach(r =>
    console.warn('[gmail-sync-cron]', r.email, r.skipped || r.error));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({ ok, of: results.length, results }) };
};
