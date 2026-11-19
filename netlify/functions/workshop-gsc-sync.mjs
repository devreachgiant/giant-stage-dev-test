// Search Console for Workshop, on a schedule.
//
// Hourly, but each client is fetched at most about once a day: _workshop_gsc.syncDue
// skips anything synced in the last 20 hours and takes the least recently synced first.
// Search Console data arrives two to three days late, so more often would only spend
// quota. Hourly runs with a time budget mean a long client list is worked through over
// a few runs instead of being cut off by the function timeout mid-write.
//
// Nothing to do until Search Console is connected in Workshop; then every client with a
// website is tried, which is how a newly added website gets its first numbers even if
// nobody presses "Test". Quota or a dead login stops the run rather than repeating the
// same failure for every client.
//
// Separate from gmail-sync-cron and growth-sync on purpose: neither is touched, and a
// Search Console failure cannot hold up mail or Calendly.

import gsc from './_workshop_gsc.js';

export default async () => {
  const began = Date.now();
  try {
    const r = await gsc.syncDue(20000);
    console.log('[workshop-gsc-sync]', JSON.stringify({ synced: r.synced, tried: r.tried || 0, skipped: r.skipped || null }));
    return new Response(JSON.stringify(Object.assign({ ms: Date.now() - began }, r)), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  } catch (e) {
    console.error('[workshop-gsc-sync]', e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  }
};

export const config = { schedule: '@hourly' };
