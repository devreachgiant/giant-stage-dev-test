// Shared image generation for the Blog Content Agent — a standalone copy of the
// Vulcan Nano-Banana pipeline so we don't refactor (and risk) the live vulcan-image
// function before a client demo. Blog images are CLEAN editorial photos (no baked
// text or logos); captions/headings live in the article, not on the image.
//
// TODO (post-demo cleanup): extract vulcan-image.js's generateImage + upload into
// this module and have both callers share it.

const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image'; // Nano Banana standard — fast + cheap, stays under the 26s function limit
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;

// Generate one clean editorial photograph. Returns { mime, base64 } or { error }.
async function generateImage(imagePrompt, aspectRatio, apiKey) {
  const composedPrompt = `Generate a single high-end editorial photograph for a blog article.\n\n‼️ ABSOLUTE RULES — the image MUST contain:\n- ZERO text: no words, letters, headlines, captions, numbers, or watermarks anywhere.\n- ZERO logos or brand marks.\nThis is a pure photograph. Any text or logo in the output is a failure.\n\n═══ VISUAL DIRECTION ═══\n${imagePrompt}`;

  const controller = new AbortController();
  // 14s per-image cap. The render runs after the ~7s art-direction planning call, so the
  // image budget must leave room for planning + upload inside the 26s function limit. Typical
  // renders are 7-11s; a slower one aborts gracefully (marked image_error, regenerable) rather
  // than pushing the whole function past the wall into a platform 502.
  const timer = setTimeout(() => controller.abort(), 14000);
  let res;
  try {
    res = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: composedPrompt }] }],
        generationConfig: { imageConfig: { aspectRatio: aspectRatio || '16:9' } }
      }),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') return { error: 'The image model took too long. Try regenerating this one.' };
    return { error: 'Network error calling the image model: ' + (e.message || 'unknown') };
  }
  clearTimeout(timer);

  const data = await res.json();
  if (!res.ok) return { error: data.error?.message || `Image model HTTP ${res.status}` };
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p) => p.inlineData && p.inlineData.data);
  if (!imgPart) {
    const textPart = parts.find((p) => p.text);
    if (textPart) return { error: 'Image model refused: ' + textPart.text.slice(0, 200) };
    return { error: 'No image returned' };
  }
  return { mime: imgPart.inlineData.mimeType || 'image/png', base64: imgPart.inlineData.data };
}

// Upload base64 image to Supabase Storage (reuses the existing public vulcan-images
// bucket under a blog/ prefix — no new bucket or storage policy needed). Non-fatal.
async function uploadImageToStorage(base64, mime, supabaseUrl, serviceKey, prefix) {
  try {
    const ext = (mime && mime.includes('jpeg')) ? 'jpg' : (mime && mime.includes('webp')) ? 'webp' : 'png';
    const filename = `${prefix || 'blog'}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
    const buf = Buffer.from(base64, 'base64');
    const upRes = await fetch(`${supabaseUrl}/storage/v1/object/vulcan-images/${filename}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'apikey': serviceKey,
        'Content-Type': mime || 'image/png',
        'x-upsert': 'true'
      },
      body: buf
    });
    if (!upRes.ok) { console.warn('[_image] storage upload failed:', upRes.status); return null; }
    return `${supabaseUrl}/storage/v1/object/public/vulcan-images/${filename}`;
  } catch (e) {
    console.warn('[_image] storage upload error:', e.message);
    return null;
  }
}

module.exports = { generateImage, uploadImageToStorage };
