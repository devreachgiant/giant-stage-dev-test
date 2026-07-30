// Netlify Function: password-vault-encrypt
// Encrypts a plaintext password with AES-256-GCM using a server-only secret key
// (PASSWORD_ENCRYPTION_KEY) that never reaches the browser. The frontend calls this before
// inserting/updating a password_entries row, then stores the returned ciphertext/iv/authTag
// directly via the normal (RLS-protected) Supabase client -- this function never touches the
// database itself, it's purely the encryption step.

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

  const password = body.password;
  if (!password || typeof password !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'password is required' }) };
  }

  const keyB64 = process.env.PASSWORD_ENCRYPTION_KEY;
  if (!keyB64) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured: PASSWORD_ENCRYPTION_KEY missing' }) };
  }
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured: PASSWORD_ENCRYPTION_KEY must be a base64-encoded 32-byte key' }) };
  }

  try {
    const iv = crypto.randomBytes(12); // 96-bit nonce, standard for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Encryption failed: ' + e.message }) };
  }
};
