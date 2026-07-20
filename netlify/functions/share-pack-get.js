// Netlify Function: share-pack-get
// Public, anonymous read of a share pack by slug. Used by the /share/<slug> page.
// Runs with the service role — anon SELECT on share_packs is revoked (security batch 1),
// so this function is the only public read path. Returns only the public fields and
// enforces expiry server-side. Bumps view_count as a side effect (best-effort).

const { allowOrigin } = require('./_cors');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin(event),
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    return await inner(event, headers);
  } catch (e) {
    console.error('[share-pack-get] crash:', e?.stack || e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Pack fetch crashed', detail: e?.message || String(e) }) };
  }
};

async function inner(event, headers) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase env vars missing' }) };
  }

  // Slug comes from query string (GET) or body (POST)
  let slug;
  if (event.httpMethod === 'GET') {
    slug = (event.queryStringParameters?.slug || '').trim();
  } else {
    try { slug = (JSON.parse(event.body || '{}').slug || '').trim(); } catch (e) { slug = ''; }
  }
  if (!slug) return { statusCode: 400, headers, body: JSON.stringify({ error: 'slug required' }) };
  // Slugs are 4-16 chars from share-pack-create's alphabet (23456789abcdefghjkmnpqrstuvwxyz)
  if (!/^[a-z2-9]{4,16}$/.test(slug)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid slug format' }) };
  }

  // Read the pack
  let pack;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/share_packs?slug=eq.${encodeURIComponent(slug)}&select=*`, {
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
    });
    const rows = await res.json();
    if (!res.ok) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase read failed', detail: JSON.stringify(rows).slice(0, 300) }) };
    }
    if (!Array.isArray(rows) || !rows[0]) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Pack not found' }) };
    }
    pack = rows[0];
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase error', detail: e.message }) };
  }

  // Enforce expiry server-side (the page also shows a friendly message)
  if (pack.expires_at && new Date(pack.expires_at) < new Date()) {
    return { statusCode: 410, headers, body: JSON.stringify({ error: 'expired' }) };
  }

  // Bump view_count best-effort (fire-and-forget — don't await)
  fetch(`${SUPABASE_URL}/rest/v1/share_packs?slug=eq.${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ view_count: (pack.view_count || 0) + 1 })
  }).catch(() => {});

  // Strip internal fields, return the public view of the pack
  const publicPack = {
    slug: pack.slug,
    title: pack.title,
    subtitle: pack.subtitle,
    client_name: pack.client_name,
    posts: pack.posts || [],
    created_at: pack.created_at,
    expires_at: pack.expires_at
  };

  return { statusCode: 200, headers, body: JSON.stringify({ pack: publicPack }) };
}
