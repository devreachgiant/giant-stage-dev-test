// Netlify Function: ai-dictate
// Transcribes a short mic recording (inline base64) with Gemini and returns the text.
// Reliable across all browsers (no Web Speech API dependency).
// Required env: GEMINI_API_KEY

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
const BASE = 'https://generativelanguage.googleapis.com';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!GEMINI_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'GEMINI_API_KEY not configured in Netlify env' }) };

  let body;
  try { body = JSON.parse(event.body); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
  const { audio_base64, mime } = body;
  if (!audio_base64) return { statusCode: 400, headers, body: JSON.stringify({ error: 'audio_base64 required' }) };

  // Dictation audio is sent as WAV (converted client-side) — a format Gemini accepts everywhere.
  const gmime = mime || 'audio/wav';

  const prompt = 'Transcribe the spoken audio verbatim. Return ONLY the transcribed text — no preamble, no quotes, no commentary. Preserve the original language. If there is no speech, return an empty string.';

  try {
    const genRes = await fetch(`${BASE}/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': GEMINI_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [ { inlineData: { mimeType: gmime, data: audio_base64 } }, { text: prompt } ] }],
        generationConfig: { temperature: 0 }
      })
    });
    const data = await genRes.json();
    if (!genRes.ok) return { statusCode: genRes.status, headers, body: JSON.stringify({ error: 'Gemini error: ' + ((data.error && data.error.message) || genRes.status) }) };
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const text = parts.map(p => p.text || '').join('').trim();
    return { statusCode: 200, headers, body: JSON.stringify({ text }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
