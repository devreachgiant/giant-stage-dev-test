// Netlify Function: vulcan-edit
// Edits an existing image (provided by the user via chat drag-drop) using Nano Banana.
// Nano Banana (gemini-2.5-flash-image) accepts an image input + a text instruction and
// returns a modified image. We wrap the user's edit instruction with strict integration
// directives so it preserves the subject and only changes what was asked.

const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;

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
    console.error('[vulcan-edit] crash:', e?.stack || e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Vulcan edit crashed', detail: (e && e.message) || String(e) }) };
  }
};

async function inner(event, headers) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!GEMINI_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'GEMINI_API_KEY not configured' }) };
  const canStore = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const instructions = (body.instructions || '').trim();
  if (!instructions) return { statusCode: 400, headers, body: JSON.stringify({ error: 'instructions required' }) };

  const source = body.source_image || {};
  if (!source.data_url) return { statusCode: 400, headers, body: JSON.stringify({ error: 'source_image.data_url required' }) };
  const m = String(source.data_url).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return { statusCode: 400, headers, body: JSON.stringify({ error: 'source_image.data_url must be a base64 data URL' }) };
  const sourceMime = m[1];
  const sourceBase64 = m[2];

  // Build the prompt: the source image first, then the wrapper that tells Nano Banana
  // to MODIFY that specific image according to the user's instructions.
  const wrappedPrompt = `The image above is the SOURCE image. Your task is to produce a modified version of this exact image.

═══ EDIT INSTRUCTIONS ═══
${instructions}

═══ RULES ═══
- Preserve anything the instructions DON'T explicitly mention to change (subject, framing, identity, materials, brand elements).
- If the instructions ask to change the background, keep the foreground subject pixel-precise.
- If the instructions ask to change colors or lighting, preserve composition and subject identity.
- If the instructions ask to add/remove an element, integrate seamlessly with the existing photography style.
- Do NOT draw text on the image unless the instructions explicitly ask for a specific phrase.
- Output a single edited image.`;

  const parts = [
    { inlineData: { mimeType: sourceMime, data: sourceBase64 } },
    { text: wrappedPrompt }
  ];

  // 22s timeout to leave 4s margin under Netlify's 26s limit
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 22000);
  let res;
  try {
    res = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': GEMINI_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }] }),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Edit took too long (>22s). Try a simpler instruction.' }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Network error calling Nano Banana', detail: e.message }) };
  }
  clearTimeout(timer);
  const data = await res.json();
  if (!res.ok) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: data.error?.message || `Gemini HTTP ${res.status}` }) };
  }
  const respParts = data.candidates?.[0]?.content?.parts || [];
  const imgPart = respParts.find(p => p.inlineData && p.inlineData.data);
  if (!imgPart) {
    const textPart = respParts.find(p => p.text);
    if (textPart) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Nano Banana refused: ' + textPart.text.slice(0, 200) }) };
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'No image returned by Nano Banana' }) };
  }
  const imageMime = imgPart.inlineData.mimeType || 'image/png';
  const imageBase64 = imgPart.inlineData.data;

  // Upload to Supabase Storage so the result can persist and be shared later
  let imageUrl = null;
  if (canStore) {
    try {
      const ext = imageMime.includes('jpeg') ? 'jpg' : imageMime.includes('webp') ? 'webp' : 'png';
      const filename = `edits/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
      const buf = Buffer.from(imageBase64, 'base64');
      const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/vulcan-images/${filename}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'apikey': SUPABASE_SERVICE_KEY, 'Content-Type': imageMime, 'x-upsert': 'true' },
        body: buf
      });
      if (upRes.ok) imageUrl = `${SUPABASE_URL}/storage/v1/object/public/vulcan-images/${filename}`;
    } catch (e) { /* non-fatal */ }
  }

  return { statusCode: 200, headers, body: JSON.stringify({
    post: {
      concept: 'Edited image — ' + instructions.slice(0, 80),
      headline: '',
      image_prompt: instructions,
      caption: '',
      hashtags: [],
      image_mime: imageMime,
      image_base64: imageBase64,
      image_url: imageUrl
    }
  }) };
}
