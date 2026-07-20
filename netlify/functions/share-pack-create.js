// Netlify Function: share-pack-create
// Authenticated POST that creates a new share pack and returns its public slug.
// Uses the service role key so we don't fight with RLS for the dedupe-slug check.

const crypto = require('crypto');

const { allowOrigin } = require('./_cors');
const { requireUser } = require('./_auth');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin(event),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  // Security batch 2: caller must be a logged-in Giant user. The frontend fetch
  // wrapper sends the Supabase session token; _auth.js verifies it with the Auth API.
  const auth = await requireUser(event);
  if (!auth.ok) return { statusCode: auth.response.statusCode, headers, body: auth.response.body };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    return await inner(event, headers);
  } catch (e) {
    console.error('[share-pack-create] crash:', e?.stack || e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Share pack creation crashed', detail: (e && e.message) || String(e) }) };
  }
};

function makeSlug(len = 8) {
  // Base36 random — no profane vowels, easy to type, no ambiguous chars
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function inner(event, headers) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase env vars not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const rawTitle = (body.title || '').trim();
  if (!rawTitle) return { statusCode: 400, headers, body: JSON.stringify({ error: 'title required' }) };
  // Prepend brand_name to title if provided (keeps schema simple)
  const brandName = (body.brand_name || '').trim();
  const title = (brandName ? `${brandName} — ${rawTitle}` : rawTitle).slice(0, 240);
  // intro → subtitle (just a rename to keep frontend friendly)
  const subtitle = (body.intro || '').trim().slice(0, 600) || null;
  const clientName = (body.client_name || '').trim().slice(0, 200) || null;
  // Get author email from auth header (Supabase JWT). For MVP we'll trust whatever the frontend sends OR default.
  const createdByEmail = (body.created_by_email || '').trim() || 'unknown@reachgiant.com';

  const posts = Array.isArray(body.posts) ? body.posts : [];
  if (posts.length === 0) return { statusCode: 400, headers, body: JSON.stringify({ error: 'at least one post required' }) };
  // Sanitize posts — only keep fields we need to render the share page
  const cleanPosts = posts.slice(0, 24).map(p => ({
    image_url: p.image_url || null,
    concept: (p.concept || '').slice(0, 800),
    headline: (p.headline || '').slice(0, 240),
    caption: (p.caption || '').slice(0, 4000),
    hashtags: Array.isArray(p.hashtags) ? p.hashtags.slice(0, 30) : []
  })).filter(p => p.image_url);
  if (cleanPosts.length === 0) return { statusCode: 400, headers, body: JSON.stringify({ error: 'posts must have image_url' }) };

  // Generate a unique slug — retry a few times if collision
  let slug = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = makeSlug(8);
    const check = await fetch(`${SUPABASE_URL}/rest/v1/share_packs?slug=eq.${encodeURIComponent(candidate)}&select=id`, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
    });
    const existing = await check.json();
    if (Array.isArray(existing) && existing.length === 0) { slug = candidate; break; }
  }
  if (!slug) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not generate unique slug after 5 attempts' }) };

  // Insert
  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/share_packs`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({
      slug, title, subtitle, client_name: clientName,
      posts: cleanPosts, created_by_email: createdByEmail
    })
  });
  if (!insertRes.ok) {
    const errText = await insertRes.text();
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to create share pack', detail: errText.slice(0, 500) }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({
    success: true,
    slug,
    share_path: `/share/${slug}`
  }) };
}
