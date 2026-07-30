// Netlify Function: password-vault-decrypt
// Decrypts one password_entries row. Deliberately does NOT use the service role to fetch the
// row -- it re-queries Supabase using the CALLER's own access token (apikey: anon, Authorization:
// Bearer <their token>), so the existing RLS policies on password_entries decide whether they're
// even allowed to see this row. If RLS denies it, the query returns nothing and nothing gets
// decrypted, regardless of what entry_id was requested. Encryption key never leaves the server.

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
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  const auth = await requireUser(event);
  if (!auth.ok) return { statusCode: auth.response.statusCode, headers, body: auth.response.body };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const entryId = body.entry_id;
  if (!entryId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'entry_id is required' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const keyB64 = process.env.PASSWORD_ENCRYPTION_KEY;
  if (!SUPABASE_URL || !ANON_KEY || !keyB64) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured' }) };
  }

  try {
    // RLS-scoped fetch: this is the actual access-control check, done AS the caller.
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/password_entries?id=eq.${encodeURIComponent(entryId)}&select=password_ciphertext,password_iv,password_auth_tag`,
      { headers: { apikey: ANON_KEY, Authorization: `Bearer ${auth.token}` } }
    );
    if (!res.ok) return { statusCode: 502, headers, body: JSON.stringify({ error: 'Lookup failed' }) };
    const rows = await res.json();
    const row = rows && rows[0];
    if (!row) return { statusCode: 404, headers, body: JSON.stringify({ error: "Not found, or you don't have access to this password" }) };

    const key = Buffer.from(keyB64, 'base64');
    const iv = Buffer.from(row.password_iv, 'base64');
    const authTag = Buffer.from(row.password_auth_tag, 'base64');
    const ciphertext = Buffer.from(row.password_ciphertext, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');

    return { statusCode: 200, headers, body: JSON.stringify({ password: plaintext }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Decryption failed: ' + e.message }) };
  }
};
