// Netlify Function: claude-api proxy
// Calls Anthropic Claude API server-side, keeping the API key secret.
// Supports both regular and streaming responses.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

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

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    messages,
    system,
    model = DEFAULT_MODEL,
    max_tokens = 2048,
    temperature = 0.7
  } = body;

  if (!messages || !Array.isArray(messages) || !messages.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'messages array required' }) };
  }

  const payload = { model, max_tokens, temperature, messages };
  if (system) payload.system = system;

  try {
    const res = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      const errMsg = data.error?.message || `Claude API ${res.status}`;
      return { statusCode: res.status, headers, body: JSON.stringify({ error: errMsg, type: data.error?.type }) };
    }
    // Extract just the text content from the response
    const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
    const text = textBlocks.join('\n');
    return { statusCode: 200, headers, body: JSON.stringify({
      text,
      usage: data.usage,
      stop_reason: data.stop_reason,
      raw: data
    }) };
  } catch (e) {
    console.error('[claude-api]', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
