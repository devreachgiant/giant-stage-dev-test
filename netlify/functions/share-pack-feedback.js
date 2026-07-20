// Netlify Function: share-pack-feedback
// Public POST endpoint where anonymous reviewers submit feedback on a share pack.
// Uses the Supabase service role key to bypass RLS (no anon insert policy on share_feedback).

const crypto = require('crypto');

const { allowOrigin } = require('./_cors');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin(event),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    return await inner(event, headers);
  } catch (e) {
    console.error('[share-pack-feedback] crash:', e?.stack || e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Feedback handler crashed', detail: (e && e.message) || String(e) }) };
  }
};

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

  const slug = (body.slug || '').trim();
  const postIndex = parseInt(body.post_index);
  const action = (body.action || '').trim();
  const comment = (body.comment || '').trim().slice(0, 2000) || null;
  const reviewerName = (body.reviewer_name || '').trim().slice(0, 120) || null;

  if (!slug) return { statusCode: 400, headers, body: JSON.stringify({ error: 'slug required' }) };
  if (Number.isNaN(postIndex) || postIndex < 0) return { statusCode: 400, headers, body: JSON.stringify({ error: 'post_index required' }) };
  if (!['approve', 'reject', 'comment'].includes(action)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid action' }) };

  // Hash the reviewer's IP (for dedupe + light spam protection, never exposed)
  const ip = event.headers['x-forwarded-for']?.split(',')[0]?.trim() || event.headers['client-ip'] || 'unknown';
  const ipHash = crypto.createHash('sha256').update(ip + ':' + slug).digest('hex').slice(0, 32);

  // Look up the pack id by slug
  const packRes = await fetch(`${SUPABASE_URL}/rest/v1/share_packs?slug=eq.${encodeURIComponent(slug)}&select=id`, {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }
  });
  const packs = await packRes.json();
  if (!Array.isArray(packs) || packs.length === 0) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Share pack not found' }) };
  }
  const packId = packs[0].id;

  // Insert the feedback row
  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/share_feedback`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({
      pack_id: packId,
      post_index: postIndex,
      action,
      comment,
      reviewer_name: reviewerName,
      reviewer_ip_hash: ipHash
    })
  });
  if (!insertRes.ok) {
    const errText = await insertRes.text();
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to record feedback', detail: errText.slice(0, 500) }) };
  }
  const row = await insertRes.json();
  return { statusCode: 200, headers, body: JSON.stringify({ success: true, id: row?.[0]?.id }) };
}
