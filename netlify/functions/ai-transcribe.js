// Netlify Function: ai-transcribe (Gemini)
// 1) Fetches a recording from the public `recordings` bucket
// 2) Uploads it to the Gemini Files API (handles large files, no 25MB cap)
// 3) Gemini transcribes the audio + summarizes + extracts action items in one call
// 4) Persists transcript/summary/action_items back to the recording row
//
// Required env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
  const { storage_path, recording_id } = body;
  if (!storage_path) return { statusCode: 400, headers, body: JSON.stringify({ error: 'storage_path required' }) };

  try {
    // 1) Fetch the recording bytes from the public bucket
    const fileUrl = `${SUPABASE_URL}/storage/v1/object/public/recordings/${storage_path}`;
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not fetch recording (' + fileRes.status + ')' }) };
    const bytes = Buffer.from(await fileRes.arrayBuffer());
    const mime = 'video/webm';

    // 2) Upload to Gemini Files API (resumable)
    const startRes = await fetch(`${BASE}/upload/v1beta/files`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': GEMINI_KEY,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(bytes.length),
        'X-Goog-Upload-Header-Content-Type': mime,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ file: { display_name: 'giant-recording' } })
    });
    const uploadUrl = startRes.headers.get('x-goog-upload-url');
    if (!uploadUrl) { const t = await startRes.text(); return { statusCode: 502, headers, body: JSON.stringify({ error: 'Gemini upload init failed: ' + t.slice(0, 200) }) }; }

    const upRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'x-goog-api-key': GEMINI_KEY,
        'X-Goog-Upload-Command': 'upload, finalize',
        'X-Goog-Upload-Offset': '0',
        'Content-Type': mime
      },
      body: bytes
    });
    const upData = await upRes.json();
    if (!upRes.ok || !upData.file) return { statusCode: 502, headers, body: JSON.stringify({ error: 'Gemini upload failed: ' + JSON.stringify(upData).slice(0, 200) }) };
    let fileInfo = upData.file; // { name, uri, state, mimeType }

    // 3) Poll until the file is ACTIVE (video/audio processing)
    let tries = 0;
    while (fileInfo.state === 'PROCESSING' && tries < 30) {
      await new Promise(r => setTimeout(r, 1500));
      const chk = await fetch(`${BASE}/v1beta/${fileInfo.name}`, { headers: { 'x-goog-api-key': GEMINI_KEY } });
      fileInfo = await chk.json();
      tries++;
    }
    if (fileInfo.state !== 'ACTIVE') return { statusCode: 502, headers, body: JSON.stringify({ error: 'Gemini could not process the recording (state: ' + fileInfo.state + ')' }) };

    // 4) Transcribe + summarize in one call (JSON-constrained output)
    const prompt = 'You are given a screen recording. Transcribe the spoken audio verbatim, then summarize it. ' +
      'Return JSON with keys: "transcript" (full transcript string), "summary" (3-6 sentence summary string), ' +
      '"action_items" (array of clear action item strings, include who is responsible if stated). ' +
      'If there is no speech, return empty strings and an empty array.';
    const genRes = await fetch(`${BASE}/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': GEMINI_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [ { fileData: { fileUri: fileInfo.uri, mimeType: mime } }, { text: prompt } ] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              transcript: { type: 'STRING' },
              summary: { type: 'STRING' },
              action_items: { type: 'ARRAY', items: { type: 'STRING' } }
            }
          }
        }
      })
    });
    const genData = await genRes.json();

    // best-effort cleanup of the uploaded file
    try { await fetch(`${BASE}/v1beta/${fileInfo.name}`, { method: 'DELETE', headers: { 'x-goog-api-key': GEMINI_KEY } }); } catch (_) {}

    if (!genRes.ok) return { statusCode: genRes.status, headers, body: JSON.stringify({ error: 'Gemini error: ' + ((genData.error && genData.error.message) || genRes.status) }) };
    const parts = (genData.candidates && genData.candidates[0] && genData.candidates[0].content && genData.candidates[0].content.parts) || [];
    const txt = parts.map(p => p.text || '').join('').trim();
    let transcript = '', summary = '', action_items = [];
    try {
      const parsed = JSON.parse(txt.replace(/```json|```/g, '').trim());
      transcript = parsed.transcript || '';
      summary = parsed.summary || '';
      action_items = Array.isArray(parsed.action_items) ? parsed.action_items : [];
    } catch (_) { summary = txt; }

    // 5) Persist to the recording row (best-effort)
    if (recording_id && SERVICE_KEY && SUPABASE_URL) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/recordings?id=eq.${recording_id}`, {
          method: 'PATCH',
          headers: { 'apikey': SERVICE_KEY, 'Authorization': 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ transcript, summary, action_items })
        });
      } catch (_) {}
    }

    return { statusCode: 200, headers, body: JSON.stringify({ transcript, summary, action_items }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
