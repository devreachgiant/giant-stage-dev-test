// Netlify Function: vulcan-image
// Vulcan as a REAL designer producing actual social media post images.
// Two-stage pipeline:
//   1) Claude (Vulcan's brain) turns the campaign brief into N posts, each with: concept, image_prompt, caption, hashtags
//   2) Nano Banana Pro (Gemini 3 Pro Image) generates the actual image for each post
// Returns posts with base64 PNG images ready to download + captions ready to copy.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';  // Vulcan's art-director brain — Haiku is vision-capable (sees the inspiration) AND fast enough to stay under the 26s function timeout
// Using gemini-2.5-flash-image (Nano Banana standard) instead of gemini-3-pro-image-preview (Pro):
// 2-3x faster (~6-10s vs 20-30s), 8x cheaper (~$0.005 vs $0.039 per image),
// quality still very strong for social posts. Avoids 504 timeouts on Netlify functions.
const GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;

// Stage 1 — Vulcan plans the campaign (text only)
const VULCAN_PLANNER_PROMPT = `You are Vulcan, the elite Art Director of an AI marketing crew. You produce social posts at the level of a top creative agency.

═══════ HOW TO DECIDE THE VISUAL ═══════

Let the BRAND KIT + BUSINESS guide the medium and aesthetic — don't grab a metaphor cliché.

1. Read brand DNA: palette personality (dark/light, high-contrast/soft), tone (sleek/warm/playful), fonts (sans=tech, serif=editorial).
2. Read business: what industry, what visual vocabulary is current and premium there?
   - Marketing/SEO/digital agency → 3D abstract renders, dark editorial typography, data-art, geometric type compositions (style of Linear, Vercel, Stripe, Framer).
   - SaaS/B2B tech → clean 3D, isometric, gradient meshes.
   - Luxury / beauty → editorial photography, single hero object, dramatic shadows.
   - Fashion / lifestyle → editorial photo with people, magazine spread.
   - Food → overhead flat lay, macro detail.
3. Pick a medium that matches both: 3D render / editorial photo / typographic composition / mixed-media / material study.
4. The visual should look like it could live on the brand's own marketing site.

═══════ image_prompt STRUCTURE ═══════

Write the image_prompt with this order:

1. MEDIUM + STYLE — name a real reference (e.g. "Abstract 3D render in Linear marketing style", "Editorial photo in Aesop campaign style", "Typographic composition in Pentagram poster spirit").
2. SUBJECT / COMPOSITION — concrete physical detail (materials, form, surface).
3. LIGHTING & GRADE — light source, shadow behavior, color grade reference.
4. PALETTE EXECUTION — cite EXACT brand hex codes and how they're used. For a black/white/red brand: "Dominant black + crisp white, red as a single thin accent <5% of frame".
5. TYPOGRAPHY OVERLAY — exact headline in quotes, brand font, LARGE size (minimum 10% of frame height, 14-22% for short 1-3 word headlines — magazine cover scale, not Instagram caption scale), color, position.
6. LOGO PLACEMENT (only if logo provided) — corner + size % + padding. Preserve original colors.
7. NEGATIVE — end with: "No conceptual clichés (compass, target, key, magnifying glass, lightbulb, puzzle, gear, chess piece). No stock-photo subjects (laptop on desk, smiling phone person, office handshake, city skyline). No watermarks. No extra text beyond the specified headline."

═══════ CALIBRATION (shapes, not subjects) ═══════

- Sleek black/white/red SEO agency → 3D matte black monolithic form with single thin red ring, dramatic side light, bold sans headline anchored in negative space.
- Warm cream/terracotta artisan brand → editorial overhead flat lay, golden hour, serif headline upper third.
- Cobalt/white SaaS B2B → isometric 3D abstract composition on soft gradient, studio light.

═══════ CAPTION ═══════

Hook line 1 (curiosity/strong claim, never "Excited to share..."). Value in 2-3 lines. CTA last. Use \\n for breaks. ALWAYS write ALL output — captions AND on-image headlines — in ENGLISH only, regardless of the language of the brand name, brief, or inspiration. Never output French or any other language.

═══════ OUTPUT — STRICT JSON ═══════

{
  "campaign_summary": "one-line direction explaining the medium + style chosen for this brand",
  "posts": [
    {
      "concept": "...",
      "headline": "EXACT text to render on the image — 1-6 words max, no quotes inside, this is the ONLY text the image model will draw",
      "image_prompt": "...",
      "caption": "with \\n",
      "hashtags": ["#tag"]
    }
  ]
}

The "headline" field is critical: it must contain ONLY the words that appear on the image, in their final form. The image_prompt should still describe typography placement and color, but the actual text-to-render comes from "headline" — the backend wraps the prompt so the image model can't confuse spec terms with text-to-render.

═══════ RULES ═══════

- FORBIDDEN clichés: compass, target, key, magnifying glass, lightbulb, puzzle, gear, chess piece, laptop on desk.
- Brand kit hex codes go in PALETTE EXECUTION + TYPOGRAPHY (overlay), not as the entire scene background.
- Logo placement line is mandatory when a logo is provided.
- No placeholders. JSON valid (escape \\" and \\n).`;

// Platform presets — drives aspect ratio + Vulcan's framing
const PLATFORM_PRESETS = {
  instagram_feed:  { label: 'Instagram Feed',   aspect: '1:1', notes: 'Square 1:1 Instagram feed post. On-image headline placed boldly. Maximize stopping power in the first 0.5 seconds of scroll.' },
  instagram_story: { label: 'Instagram Story',  aspect: '9:16', notes: 'Vertical 9:16 Instagram Story. Headline in the upper third, CTA at the bottom. Reserve the top and bottom safe zones for UI overlays (avatar, swipe-up).' },
  linkedin_feed:   { label: 'LinkedIn Feed',    aspect: '1.91:1', notes: 'Landscape 1.91:1 LinkedIn feed post. Professional B2B tone, clean typography, headline that reads in 2 seconds.' },
  facebook_feed:   { label: 'Facebook Feed',    aspect: '1.91:1', notes: 'Landscape 1.91:1 Facebook feed post. Clear value prop, friendly tone, prominent CTA.' }
};

function buildBrandSection(kit) {
  if (!kit || typeof kit !== 'object') return '';
  const lines = [];
  if (kit.name) lines.push(`Brand name: ${kit.name}`);
  const colors = [];
  if (kit.color_primary) colors.push(`primary ${kit.color_primary}`);
  if (kit.color_secondary) colors.push(`secondary ${kit.color_secondary}`);
  if (kit.color_accent) colors.push(`accent ${kit.color_accent}`);
  if (kit.color_background) colors.push(`background-system ${kit.color_background}`);
  if (kit.color_text) colors.push(`text-on-dark ${kit.color_text}`);
  if (colors.length) lines.push(`Brand palette (these hex codes go in the BRAND OVERLAY + TYPOGRAPHY sections — they color the headline, accents, and subtle tints, NOT the entire scene): ${colors.join(', ')}`);
  if (kit.font_headline) lines.push(`Headline font (cite by name in the TYPOGRAPHY OVERLAY section): ${kit.font_headline}`);
  if (kit.font_body) lines.push(`Body font (for caption styling reference): ${kit.font_body}`);
  if (kit.tone) lines.push(`Brand tone — every shot type, scene choice, lighting, and copy decision must reflect this: ${kit.tone}`);
  if (kit.voice_notes) lines.push(`Brand voice notes: ${kit.voice_notes}`);
  if (kit.logo_data_url) lines.push(`A brand logo is attached — your image_prompt MUST include the LOGO PLACEMENT line specifying corner + size + padding.`);
  if (lines.length === 0) return '';
  return `\n\nBRAND KIT — apply to OVERLAY ELEMENTS (headline, accents, logo, subtle tints), NOT to the entire scene. The scene itself stays photographically rich:\n${lines.map(l => '- ' + l).join('\n')}`;
}

async function planCampaign(brief, count, apiKey, brandKit, platformPreset, hasProduct, productName, inspirations, productB64, productMime) {
  const platformNote = platformPreset ? `\n\nPLATFORM: ${platformPreset.label} — ${platformPreset.notes}` : '';
  const brandNote = buildBrandSection(brandKit);
  const productNote = hasProduct
    ? `\n\nFEATURED PRODUCT: a real product photo is attached to this brief${productName ? ` (named "${productName}")` : ''}. The product will be passed as a reference image to the image model alongside your prompt. Your concept and composition MUST treat the product as the HERO of the image — it should be the focal point, prominently visible, with the brand kit aesthetic as the backdrop. The image_prompt must:\n- explicitly describe the scene as featuring "the product" as the hero (do not describe the product's visual details — the image model will integrate it from the reference, exactly as provided)\n- specify the product's position, scale (typically large, occupying 30-60% of the frame), and angle\n- describe an editorial environment/backdrop that ENHANCES the product without competing with it (surface, light, shadow, materials, props)\n- include a LITERAL INTEGRATION instruction: "Integrate the provided product reference image exactly as-is (preserving its shape, packaging, label, and colors). Do not redraw or stylize the product."`
    : '';
  // A freshness seed nudges Claude towards a different angle each run, even on identical briefs.
  const freshnessSeed = Math.random().toString(36).slice(2, 10);
  const userMsg = `Campaign brief: ${brief}${platformNote}${brandNote}${productNote}\n\nProduce exactly ${count} post(s). Let the BRAND KIT and the business industry guide your MEDIUM and AESTHETIC — match the brand's universe and the premium visual vocabulary of its industry. Do NOT default to forced object metaphors. (Freshness seed: ${freshnessSeed} — different seeds should yield meaningfully different visuals.)`;

  // ── Build MULTIMODAL content so the art-director (Claude) actually SEES the references ──
  const content = [];
  const insps = Array.isArray(inspirations) ? inspirations.slice(0, 2) : [];
  insps.forEach((ins) => {
    const du = ins && (ins.data_url || ins.url);
    const m = du && String(du).match(/^data:([^;]+);base64,(.+)$/);
    if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  });
  if (hasProduct && productB64 && productMime) {
    content.push({ type: 'image', source: { type: 'base64', media_type: productMime, data: productB64 } });
  }
  const refNote = (insps.length || (hasProduct && productB64))
    ? `\n\n═══ ATTACHED REFERENCE IMAGES ═══\nYou are given ${insps.length} INSPIRATION reference(s)${hasProduct && productB64 ? ' followed by the actual PRODUCT photo' : ''}. STUDY them like an art director. Your image_prompt MUST concretely capture the inspiration's: lighting direction & quality (hard/soft, key direction), colour grading & palette, framing & crop, depth of field, the amount and PLACEMENT of EMPTY negative space (so a headline can be overlaid later), surface/material textures, and overall editorial mood.\n\n‼️ IMPORTANT: the generated photo must be COMPLETELY CLEAN — NO text, NO words, NO logo baked into it. Your "headline" field is placed SEPARATELY on top afterwards; it must NEVER appear in image_prompt. In image_prompt, explicitly state "no text, no logo, clean empty negative space for later text overlay". Even though the inspiration images may contain text/logos, your image_prompt must describe ONLY the photographic style, never any wording or graphics.`
    : '';
  content.push({ type: 'text', text: userMsg + refNote });

  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: Math.min(2200, 750 + count * 420),
      temperature: 0.85,
      system: VULCAN_PLANNER_PROMPT,
      messages: [{ role: 'user', content }]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Claude planning failed');
  let text = data.content?.[0]?.text || '';
  if (!text) throw new Error('Claude returned empty response');
  // Strip code fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Find the outermost JSON object
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('Claude response did not contain a JSON object. Raw start: ' + text.slice(0, 300));
  }
  const jsonSlice = text.slice(firstBrace, lastBrace + 1);
  let parsed;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (e) {
    throw new Error('JSON parse failed (' + e.message + '). Raw start: ' + jsonSlice.slice(0, 300));
  }
  return parsed;
}

async function generateImage(imagePrompt, headline, aspectRatio, apiKey, logoBase64, logoMime, inspirations, productBase64, productMime, productName) {
  // CLEAN-ONLY ARCHITECTURE: the headline and logo are composited by the app's Overlay studio
  // AFTER generation, so the image model must NEVER bake any text or logo. This is what prevents
  // the doubled headline + doubled logo. The inspiration's *style* was already translated into the
  // VISUAL DIRECTION text by Claude, so we do NOT send the inspiration images (Nano was copying
  // their baked text/logo) and we do NOT send the logo image here either.
  const composedPrompt = `Generate a single high-end photographic social-media image.\n\n‼️ ABSOLUTE RULES — the image MUST contain:\n- ZERO text: no words, letters, headlines, captions, numbers, font names, or watermarks anywhere.\n- ZERO logos or brand marks.\nLeave clean, empty negative space (typically toward one side or the bottom) where a headline will be added later. This is a pure photograph only — any text or logo in the output is a failure.\n\n═══ VISUAL DIRECTION ═══\n${imagePrompt}`;

  const parts = [];
  const hasProduct = !!(productBase64 && productMime);
  // Product is the ONLY reference image we still send (it must appear as the real hero product).
  if (hasProduct) {
    parts.push({ inlineData: { mimeType: productMime, data: productBase64 } });
    parts.push({ text: `The image just above is the EXACT brand product${productName ? ` ("${productName}")` : ''}. It MUST appear as the HERO of the final image, preserving its exact shape, packaging, label text, materials, and colors — do not redraw, restyle, or substitute it. Integrate it into the composition described below with editorial lighting and a backdrop that enhances it. Remember the absolute rules: NO text and NO logo anywhere in the image.\n\n${composedPrompt}` });
  } else {
    parts.push({ text: composedPrompt });
  }
  // 17s abort: with Claude planning (~5-8s) this keeps total under Netlify's 26s hard kill,
  // so a slow image fails with a clean JSON error instead of a raw 504.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 17000);
  let res;
  try {
    res = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { imageConfig: { aspectRatio: aspectRatio || '1:1' } }
      }),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      return { error: 'The image model took too long. Try again (it usually works on a second attempt), or generate one creative at a time.' };
    }
    return { error: 'Network error calling Nano Banana: ' + (e.message || 'unknown') };
  }
  clearTimeout(timer);
  const data = await res.json();
  if (!res.ok) {
    const msg = data.error?.message || `Gemini HTTP ${res.status}`;
    return { error: msg };
  }
  const respParts = data.candidates?.[0]?.content?.parts || [];
  const imgPart = respParts.find(p => p.inlineData && p.inlineData.data);
  if (!imgPart) {
    // Sometimes Gemini returns a text "I cannot..." instead of image (safety filter, etc.)
    const textPart = respParts.find(p => p.text);
    if (textPart) return { error: 'Nano Banana refused: ' + textPart.text.slice(0, 200) };
    return { error: 'No image returned by Nano Banana' };
  }
  return { mime: imgPart.inlineData.mimeType || 'image/png', base64: imgPart.inlineData.data };
}

// Upload an image (base64 PNG) to Supabase Storage and return its public URL.
// Non-fatal: if upload fails, we still return the base64 to the frontend so the user sees the image.
async function uploadImageToStorage(base64, mime, supabaseUrl, serviceKey) {
  try {
    const ext = (mime && mime.includes('jpeg')) ? 'jpg' : (mime && mime.includes('webp')) ? 'webp' : 'png';
    const filename = `posts/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
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
    if (!upRes.ok) {
      console.warn('[vulcan-image] storage upload failed:', upRes.status);
      return null;
    }
    return `${supabaseUrl}/storage/v1/object/public/vulcan-images/${filename}`;
  } catch (e) {
    console.warn('[vulcan-image] storage upload error:', e.message);
    return null;
  }
}

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
    return await innerHandler(event, headers);
  } catch (e) {
    console.error('[vulcan-image] uncaught:', e?.stack || e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Vulcan crashed', detail: (e && e.message) || String(e) }) };
  }
};

async function innerHandler(event, headers) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!ANTHROPIC_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };
  if (!GEMINI_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'GEMINI_API_KEY not configured in Netlify' }) };
  // Supabase keys are recommended (for persistent storage) but not strictly required.
  const canStore = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const brief = (body.brief || '').trim();
  if (!brief) return { statusCode: 400, headers, body: JSON.stringify({ error: 'brief required' }) };
  const count = Math.min(Math.max(parseInt(body.count) || 1, 1), 4);
  const platformKey = body.platform && PLATFORM_PRESETS[body.platform] ? body.platform : 'instagram_feed';
  const platformPreset = PLATFORM_PRESETS[platformKey];
  const aspectRatio = body.aspect_ratio || platformPreset.aspect;
  const brandKit = body.brand_kit && typeof body.brand_kit === 'object' ? body.brand_kit : null;
  // Clean mode: generate a pure editorial photograph with NO baked-in text or logo (added later via Overlay Studio)
  const cleanImage = !!body.clean_image;
  // Featured product — a real product photo to be LITERALLY integrated into the visual
  const featuredProduct = body.featured_product && typeof body.featured_product === 'object' ? body.featured_product : null;
  let productBase64 = null, productMime = null, productName = null;
  if (featuredProduct?.data_url) {
    const m = String(featuredProduct.data_url).match(/^data:([^;]+);base64,(.+)$/);
    if (m) { productMime = m[1]; productBase64 = m[2]; productName = featuredProduct.name || null; }
  }
  // Extract logo (data URL "data:image/png;base64,XXX" → mime + base64)
  let logoBase64 = null, logoMime = null;
  if (brandKit?.logo_data_url) {
    const m = String(brandKit.logo_data_url).match(/^data:([^;]+);base64,(.+)$/);
    if (m) { logoMime = m[1]; logoBase64 = m[2]; }
  } else if (brandKit?.logo_base64 && brandKit?.logo_mime) {
    logoBase64 = brandKit.logo_base64;
    logoMime = brandKit.logo_mime;
  }
  // Extract inspirations (array of { data_url, mime } stored in brand_kits.inspirations)
  const inspirations = Array.isArray(brandKit?.inspirations) ? brandKit.inspirations : [];

  try {
    // Stage 1: plan with brand + platform context + product (so the concept makes the product the hero)
    const plan = await planCampaign(brief, count, ANTHROPIC_KEY, brandKit, platformPreset, !!productBase64, productName, inspirations, productBase64, productMime);
    const posts = Array.isArray(plan.posts) ? plan.posts.slice(0, count) : [];
    if (posts.length === 0) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Vulcan could not plan the campaign (no posts returned).' }) };
    }
    // Stage 2: generate images IN PARALLEL with optional logo reference + inspirations + product
    const results = await Promise.all(posts.map(async (post) => {
      let image = null;
      let imageError = null;
      // Clean mode → no on-image text, no baked logo. Pure photographic base with negative space; text+logo added via Overlay Studio.
      const headlineToUse = cleanImage ? '' : (post.headline || '');
      const promptToUse = cleanImage
        ? ('ABSOLUTELY CRITICAL: Render NO text, NO letters, NO words, NO headline, NO captions, NO logo, NO watermark anywhere in this image. Produce a pure high-end editorial photograph ONLY, with generous clean negative space (top, side, or bottom) intentionally left empty for text to be added later in post-production.\n\n' + (post.image_prompt || ''))
        : (post.image_prompt || '');
      const logoB64 = cleanImage ? null : logoBase64;
      const logoM = cleanImage ? null : logoMime;
      try {
        const img = await generateImage(promptToUse, headlineToUse, aspectRatio, GEMINI_KEY, logoB64, logoM, inspirations, productBase64, productMime, productName);
        if (img.error) imageError = img.error;
        else image = img;
      } catch (e) {
        imageError = e.message || 'image generation failed';
      }
      // Upload to Supabase Storage for persistence (non-fatal)
      let imageUrl = null;
      if (image && canStore) {
        imageUrl = await uploadImageToStorage(image.base64, image.mime, SUPABASE_URL, SUPABASE_SERVICE_KEY);
      }
      return {
        concept: post.concept || '',
        headline: post.headline || '',
        image_prompt: post.image_prompt || '',
        caption: post.caption || '',
        hashtags: Array.isArray(post.hashtags) ? post.hashtags : [],
        image_mime: image ? image.mime : null,
        image_base64: image ? image.base64 : null,
        image_url: imageUrl,
        image_error: imageError
      };
    }));
    return { statusCode: 200, headers, body: JSON.stringify({
      agent: 'vulcan',
      engine_version: 'clean-v7',
      campaign_summary: plan.campaign_summary || '',
      platform: platformKey,
      platform_label: platformPreset.label,
      aspect_ratio: aspectRatio,
      posts: results,
      completed_at: new Date().toISOString()
    }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Vulcan campaign failed', detail: e.message }) };
  }
}
