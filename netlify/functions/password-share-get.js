// Netlify Function: password-share-get
// Public, anonymous read of a shared password by token. Used by the /pwshare/<token> page.
// This is the ONE deliberate public/unauthenticated path into the Password Manager — same
// pattern as share-pack-get for share packs. Runs with the service role (anon has no grants
// on password_share_links or password_entries), enforces expiry/revocation server-side, and
// decrypts using the server-only PASSWORD_ENCRYPTION_KEY, which never reaches the browser.

const crypto = require('crypto');
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
    console.error('[password-share-get] crash:', e?.stack || e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Lookup crashed', detail: e?.message || String(e) }) };
  }
};

async function inner(event, headers) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const keyB64 = process.env.PASSWORD_ENCRYPTION_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !keyB64) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured' }) };
  }

  const token = (event.queryStringParameters?.token || '').trim();
  if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid link' }) };
  }

  const linkRes = await fetch(`${SUPABASE_URL}/rest/v1/password_share_links?token=eq.${encodeURIComponent(token)}&select=*`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const linkRows = await linkRes.json().catch(() => []);
  if (!linkRes.ok || !Array.isArray(linkRows) || !linkRows[0]) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'This link is invalid' }) };
  }
  const link = linkRows[0];
  if (link.revoked_at) return { statusCode: 410, headers, body: JSON.stringify({ error: 'revoked' }) };
  if (new Date(link.expires_at) < new Date()) return { statusCode: 410, headers, body: JSON.stringify({ error: 'expired' }) };

  const entryRes = await fetch(
    `${SUPABASE_URL}/rest/v1/password_entries?id=eq.${encodeURIComponent(link.entry_id)}&select=title,username,url,notes,password_ciphertext,password_iv,password_auth_tag`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
  );
  const entryRows = await entryRes.json().catch(() => []);
  const entry = entryRows && entryRows[0];
  if (!entryRes.ok || !entry) return { statusCode: 404, headers, body: JSON.stringify({ error: 'The password behind this link no longer exists' }) };

  let plaintext;
  try {
    const key = Buffer.from(keyB64, 'base64');
    const iv = Buffer.from(entry.password_iv, 'base64');
    const authTag = Buffer.from(entry.password_auth_tag, 'base64');
    const ciphertext = Buffer.from(entry.password_ciphertext, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Decryption failed' }) };
  }

  // Bump view_count best-effort (fire-and-forget)
  fetch(`${SUPABASE_URL}/rest/v1/password_share_links?token=eq.${encodeURIComponent(token)}`, {
    method: 'PATCH',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ view_count: (link.view_count || 0) + 1 }),
  }).catch(() => {});

  return {
    statusCode: 200, headers, body: JSON.stringify({
      title: entry.title, username: entry.username, url: entry.url, notes: entry.notes,
      password: plaintext, expires_at: link.expires_at,
    }),
  };
}
