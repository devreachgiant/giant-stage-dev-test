// Netlify Function: vulcan-revise
// Takes an original Vulcan post + client feedback (rejections + comments) and produces
// a revised version of the post addressing the criticism. Used by the Shared Packs panel
// when Luke clicks "Ask Vulcan to revise" on a post the client has rejected or commented on.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;

const REVISE_SYSTEM = `You are Vulcan, the elite Designer & Art Director. The client has reviewed a social media post you generated and left feedback (sometimes negative, sometimes specific change requests). Your job: produce a REVISED version of the post that ADDRESSES the feedback while preserving the original strengths.

You receive:
- The original concept, headline, caption, image_prompt, and brand kit context
- An array of client feedback (action: approved/rejected/commented, comment text, reviewer name)

═══════ HOW TO READ FEEDBACK ═══════

- "approved" feedback = client likes this, keep what works
- "rejected" feedback = client wants changes; investigate the accompanying comments for direction
- "commented" feedback = explicit guidance — read carefully and apply literally where possible

If multiple feedbacks conflict, weight the most specific/recent comment higher than generic likes.

═══════ HOW TO REVISE ═══════

1. IDENTIFY the core complaint(s) in the feedback. Examples: too busy, wrong palette, off-brand tone, headline too long, product not prominent enough, lighting too harsh, etc.
2. CHANGE only what the feedback asks for — keep brand identity, palette, and core medium consistent UNLESS the feedback specifically asks for a different direction.
3. For visual revisions: write a NEW image_prompt that incorporates the requested changes. Be specific about what's DIFFERENT vs the original.
4. For copy revisions: rewrite headline/caption to match the feedback.
5. If feedback is vague ("doesn't work for us"), make a confident bold pivot — different composition, palette mix, or medium — rather than a timid tweak.

═══════ OUTPUT — STRICT JSON ═══════

Output ONLY a single valid JSON object (no markdown fences, no preamble):

{
  "revision_summary": "1-2 sentences in plain language explaining WHAT you changed and WHY (e.g. 'Reduced background clutter and brought the product forward; warmed the palette per the feedback.')",
  "post": {
    "concept": "...",
    "headline": "EXACT text to render on the image — 1-6 words max, no quotes inside, this is the ONLY text the image model will draw",
    "image_prompt": "Full prompt for the image model. Structure: MEDIUM+STYLE / SUBJECT / LIGHTING / PALETTE / TYPOGRAPHY / LOGO PLACEMENT / NEGATIVE.",
    "caption": "with \\n",
    "hashtags": ["#tag"]
  }
}

═══════ RULES ═══════

- ALWAYS write all output in ENGLISH only, regardless of the original language.
- The "headline" field is what gets rendered on the image — keep it short and impactful.
- No placeholders. JSON valid (escape \\" and \\n).`;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    return await inner(event, headers);
  } catch (e) {
    console.error('[vulcan-revise] crash:', e?.stack || e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Vulcan revision crashed', detail: (e && e.message) || String(e) }) };
  }
};

async function inner(event, headers) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!ANTHROPIC_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };
  if (!GEMINI_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'GEMINI_API_KEY not configured' }) };
  const canStore = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const originalPost = body.original_post || {};
  const brandKit = body.brand_kit && typeof body.brand_kit === 'object' ? body.brand_kit : null;
  const feedbacks = Array.isArray(body.feedbacks) ? body.feedbacks : [];
  const platformKey = body.platform || 'instagram_feed';
  const aspectRatio = platformKey === 'instagram_story' ? '9:16' : platformKey === 'linkedin_feed' ? '1.91:1' : platformKey === 'facebook_feed' ? '1.91:1' : '1:1';

  if (!originalPost.concept && !originalPost.image_prompt) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'original_post is required (with concept or image_prompt)' }) };
  }

  // Stage 1: ask Claude for a revised plan based on feedback
  const brandSection = buildBrandSection(brandKit);
  const feedbackLines = feedbacks.map(f => {
    const tag = f.action === 'approved' ? '[APPROVED]' : f.action === 'rejected' ? '[NEEDS CHANGES]' : '[COMMENT]';
    const name = f.reviewer_name ? ` from ${f.reviewer_name}` : '';
    return `- ${tag}${name}: ${f.comment || '(no comment)'}`;
  }).join('\n');

  const userMsg = `═══ ORIGINAL POST ═══
Concept: ${originalPost.concept || '(none)'}
Headline: ${originalPost.headline || '(none)'}
Caption: ${originalPost.caption || '(none)'}
Image prompt that produced it: ${originalPost.image_prompt || '(none)'}
${brandSection}

═══ CLIENT FEEDBACK (${feedbacks.length} item${feedbacks.length !== 1 ? 's' : ''}) ═══
${feedbackLines || '(no feedback)'}

═══ TASK ═══
Produce the revised version. Output the JSON.`;

  let plan;
  try {
    const res = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2200,
        temperature: 0.65,
        system: REVISE_SYSTEM,
        messages: [{ role: 'user', content: userMsg }]
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Claude HTTP ${res.status}`);
    let text = data.content?.[0]?.text || '';
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const first = text.indexOf('{'), last = text.lastIndexOf('}');
    if (first === -1 || last === -1) throw new Error('No JSON in revision plan. Raw: ' + text.slice(0, 200));
    plan = JSON.parse(text.slice(first, last + 1));
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Revision planning failed', detail: e.message }) };
  }

  const revisedPost = plan.post || {};
  if (!revisedPost.image_prompt) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Revision plan returned no image_prompt' }) };
  }

  // Stage 2: generate the new image using Nano Banana
  // We optionally include the original image as a visual reference for style continuity.
  let logoBase64 = null, logoMime = null;
  if (brandKit?.logo_data_url) {
    const m = String(brandKit.logo_data_url).match(/^data:([^;]+);base64,(.+)$/);
    if (m) { logoMime = m[1]; logoBase64 = m[2]; }
  }
  // Note: we do NOT include inspirations or products for revision — keeps payload light + focused
  // on the revision intent. Logo only if present (it must stay in the image).

  // Compose prompt with strict headline wrapper (same pattern as vulcan-image.js)
  const composedPrompt = revisedPost.headline && revisedPost.headline.trim()
    ? `Generate a single social media image.\n\n═══ TEXT TO RENDER ═══\nDraw EXACTLY this text on the image, nothing else: ${revisedPost.headline.trim().replace(/[\r\n]+/g, ' ')}\nDo NOT draw any other words. Do NOT draw font names, percentages, technical terms, or specification language anywhere in the image.\n\n═══ VISUAL DIRECTION ═══\n${revisedPost.image_prompt}`
    : revisedPost.image_prompt;

  const parts = [];
  if (logoBase64 && logoMime) {
    parts.push({ inlineData: { mimeType: logoMime, data: logoBase64 } });
    parts.push({ text: `The image just above is the EXACT brand logo. It MUST appear in the final image, preserving its original shape and colors — do not redraw or stylize it. Now:\n\n${composedPrompt}` });
  } else {
    parts.push({ text: composedPrompt });
  }

  // 22s timeout to leave 4s margin under Netlify's 26s
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 22000);
  let imgRes;
  try {
    imgRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': GEMINI_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { imageConfig: { aspectRatio } }
      }),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Image generation took too long (>22s). Try again.' }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Network error calling Nano Banana', detail: e.message }) };
  }
  clearTimeout(timer);

  const imgData = await imgRes.json();
  if (!imgRes.ok) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: imgData.error?.message || `Gemini HTTP ${imgRes.status}` }) };
  }
  const respParts = imgData.candidates?.[0]?.content?.parts || [];
  const imgPart = respParts.find(p => p.inlineData && p.inlineData.data);
  if (!imgPart) {
    const textPart = respParts.find(p => p.text);
    if (textPart) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Nano Banana refused: ' + textPart.text.slice(0, 200) }) };
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'No image returned by Nano Banana' }) };
  }

  const imageMime = imgPart.inlineData.mimeType || 'image/png';
  const imageBase64 = imgPart.inlineData.data;

  // Upload to Supabase Storage if possible
  let imageUrl = null;
  if (canStore) {
    try {
      const ext = imageMime.includes('jpeg') ? 'jpg' : imageMime.includes('webp') ? 'webp' : 'png';
      const filename = `revisions/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
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
    revision_summary: plan.revision_summary || '',
    post: {
      concept: revisedPost.concept || '',
      headline: revisedPost.headline || '',
      image_prompt: revisedPost.image_prompt || '',
      caption: revisedPost.caption || '',
      hashtags: Array.isArray(revisedPost.hashtags) ? revisedPost.hashtags : [],
      image_mime: imageMime,
      image_base64: imageBase64,
      image_url: imageUrl
    }
  }) };
}

// Helpers
function buildBrandSection(brandKit) {
  if (!brandKit) return '';
  const colors = [brandKit.color_primary, brandKit.color_secondary, brandKit.color_accent].filter(Boolean);
  const fonts = [brandKit.font_headline, brandKit.font_body].filter(Boolean);
  let out = '\n\n═══ BRAND KIT ═══';
  if (brandKit.name) out += `\nBrand: ${brandKit.name}`;
  if (colors.length) out += `\nColors: ${colors.join(', ')}`;
  if (fonts.length) out += `\nFonts: ${fonts.join(', ')}`;
  if (brandKit.tone) out += `\nTone: ${brandKit.tone}`;
  if (brandKit.voice_notes) out += `\nVoice: ${brandKit.voice_notes}`;
  return out;
}
