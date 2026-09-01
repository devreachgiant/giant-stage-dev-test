// Netlify Function: recording-share-get
// Public, anonymous read of a screen recording by share token. Used by the /rec/<token>
// page. Same shape as password-share-get: runs with the service role, and decides
// server-side whether this recording is meant to be public, so the browser is never
// trusted with that call.

const { allowOrigin } = require('./_cors');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin(event),
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'GET only' }) };

  try {
    return await inner(event, headers);
  } catch (e) {
    console.error('[recording-share-get] crash:', e?.stack || e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Lookup crashed' }) };
  }
};

async function inner(event, headers) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured' }) };
  }

  const token = (event.queryStringParameters?.token || '').trim();
  if (!token || !/^[a-f0-9]{16,64}$/.test(token)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid link' }) };
  }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/recordings?share_token=eq.${encodeURIComponent(token)}` +
    `&select=id,title,url,duration_secs,created_at,visibility,view_count,profile_id`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
  );
  const rows = await res.json().catch(() => []);
  const rec = Array.isArray(rows) ? rows[0] : null;
  if (!res.ok || !rec) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'not_found' }) };
  }
  // A workspace recording is a real recording behind a link that is simply not public.
  // Saying so -- rather than 404 -- is what lets the page offer "Open in Giant" to
  // someone who does have an account.
  if (rec.visibility !== 'public') {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'not_public', id: rec.id }) };
  }
  if (!rec.url) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'no_file' }) };
  }

  let author = '';
  try {
    const pr = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(rec.profile_id)}&select=full_name`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    const prows = await pr.json().catch(() => []);
    author = (prows && prows[0] && prows[0].full_name) || '';
  } catch (_) {}

  // Best-effort, and never allowed to hold up playback.
  fetch(`${SUPABASE_URL}/rest/v1/recordings?share_token=eq.${encodeURIComponent(token)}`, {
    method: 'PATCH',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ view_count: (rec.view_count || 0) + 1 })
  }).catch(() => {});

  return {
    statusCode: 200, headers, body: JSON.stringify({
      title: rec.title || 'Screen recording',
      url: rec.url,
      duration_secs: rec.duration_secs,
      created_at: rec.created_at,
      author
    })
  };
}
