// Netlify Function: share-pack-get
// Public, anonymous read of a shared pack by slug. Used by the /share/<slug> page.
// Bumps the views_count as a side effect (best-effort, non-blocking).

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
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
  // Basic format check
  if (!/^[a-z2-9]{4,16}$/.test(slug)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid slug format' }) };
  }

  // Read the pack
  let pack;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/shared_packs?slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&select=*`, {
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

  // Bump views_count best-effort (fire-and-forget — don't await)
  fetch(`${SUPABASE_URL}/rest/v1/shared_packs?slug=eq.${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ views_count: (pack.views_count || 0) + 1 })
  }).catch(() => {});

  // Strip internal fields, return the public view of the pack
  const publicPack = {
    slug: pack.slug,
    title: pack.title,
    intro: pack.intro,
    posts: pack.posts || [],
    brand_name: pack.brand_name,
    client_name: pack.client_name,
    created_at: pack.created_at,
    views_count: (pack.views_count || 0) + 1
  };

  return { statusCode: 200, headers, body: JSON.stringify({ pack: publicPack }) };
}
