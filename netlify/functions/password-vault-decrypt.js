// Netlify Function: password-vault-decrypt
// Decrypts one encrypted row. Deliberately does NOT use the service role to fetch the
// row -- it re-queries Supabase using the CALLER's own access token (apikey: anon, Authorization:
// Bearer <their token>), so the existing RLS policies on that table decide whether they're
// even allowed to see this row. If RLS denies it, the query returns nothing and nothing gets
// decrypted, regardless of what entry_id was requested. Encryption key never leaves the server.
//
// password_entries is the ONLY table that stores secrets. Chat 3.0's client vault briefly
// had its own copy; that was consolidated away (20260818090000) because one credential in
// two tables is two rotations to remember and one of them silently goes stale. A vault item
// now holds a password_entry_id and decrypts through this same path.
//
// SOURCES stays a fixed allowlist so the caller picks a KEY of this map, never a table name.
// An unknown source is rejected before any query runs, so this parameter can never be used
// to read a table it was not meant to.

const SOURCES = {
  password_entry: {
    table: 'password_entries',
    cipher: 'password_ciphertext', iv: 'password_iv', tag: 'password_auth_tag',
  },
};

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

  // Defaults to the password manager so existing callers keep working unchanged.
  const sourceKey = body.source || 'password_entry';
  const source = Object.prototype.hasOwnProperty.call(SOURCES, sourceKey) ? SOURCES[sourceKey] : null;
  if (!source) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown source' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const keyB64 = process.env.PASSWORD_ENCRYPTION_KEY;
  if (!SUPABASE_URL || !ANON_KEY || !keyB64) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured' }) };
  }

  try {
    // RLS-scoped fetch: this is the actual access-control check, done AS the caller.
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${source.table}?id=eq.${encodeURIComponent(entryId)}` +
        `&select=${source.cipher},${source.iv},${source.tag}`,
      { headers: { apikey: ANON_KEY, Authorization: `Bearer ${auth.token}` } }
    );
    if (!res.ok) return { statusCode: 502, headers, body: JSON.stringify({ error: 'Lookup failed' }) };
    const rows = await res.json();
    const row = rows && rows[0];
    if (!row) return { statusCode: 404, headers, body: JSON.stringify({ error: "Not found, or you don't have access to this password" }) };
    // A row with no secret is a legitimate state in the library (a plain link, a note),
    // so treat it as "nothing to reveal" rather than throwing a decryption error.
    if (!row[source.cipher]) return { statusCode: 404, headers, body: JSON.stringify({ error: 'This item has no saved password' }) };

    const key = Buffer.from(keyB64, 'base64');
    const iv = Buffer.from(row[source.iv], 'base64');
    const authTag = Buffer.from(row[source.tag], 'base64');
    const ciphertext = Buffer.from(row[source.cipher], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');

    return { statusCode: 200, headers, body: JSON.stringify({ password: plaintext }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Decryption failed: ' + e.message }) };
  }
};
