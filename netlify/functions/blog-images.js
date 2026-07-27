// Netlify Function: blog-images
// Step 3 of the Blog Content Agent. Reads the finished article, picks 1 feature image
// + N body-image spots, writes brand-matched prompts, and generates clean editorial
// photos via the image model. Returns base64 + a hosted URL + SEO alt text per image.
// Two-stage (like Vulcan): Claude art-directs → image model renders in parallel.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
// Art director — reads the article as text (no vision) and writes image prompts + alt JSON.
// MUST be a fast model: this planning call runs BEFORE the parallel image render, so a slow
// planner eats the whole 26s function budget. claude-sonnet-4-6 measured 17-23s here and was
// the cause of the step-5 502 timeouts; claude-haiku-4-5 does the same job in ~7s.
const PLANNER_MODEL = 'claude-haiku-4-5';

const { allowOrigin } = require('./_cors');
const { requireUser } = require('./_auth');
const { extractJson } = require('./_brand');
const { generateImage, uploadImageToStorage } = require('./_image');

function brandVisualNote(kit) {
  if (!kit || typeof kit !== 'object') return '';
  const colors = [kit.color_primary, kit.color_secondary, kit.color_accent].filter(Boolean);
  const bits = [];
  if (kit.name) bits.push(`brand "${kit.name}"`);
  if (colors.length) bits.push(`palette ${colors.join(', ')} used as accents/grade (not the whole scene)`);
  if (kit.tone) bits.push(`tone: ${kit.tone}`);
  return bits.length ? `\n\nBRAND STYLE to reflect in every image (as mood/grade, subtly): ${bits.join('; ')}.` : '';
}

const PLANNER_SYSTEM = `You are an art director selecting imagery for a blog article. You read the article and choose photographic images that genuinely illustrate its content — never generic stock clichés (no laptop-on-desk, no smiling-phone-person, no handshake, no lightbulb/target/puzzle metaphors).

For each image write an "image_prompt" that specifies: MEDIUM + STYLE (name a real editorial reference), concrete SUBJECT/COMPOSITION, LIGHTING & COLOR GRADE, and generous clean negative space. NEVER request any text, words, or logos in the image. Also write SEO "alt" text: a natural, descriptive sentence (include the topic/keyword where it fits honestly).

OUTPUT — STRICT JSON only:
{
  "feature": { "image_prompt": "...", "alt": "..." },
  "body": [ { "after_heading": "the H2 this image follows", "image_prompt": "...", "alt": "..." } ]
}`;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin(event),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  const auth = await requireUser(event);
  if (!auth.ok) return { statusCode: auth.response.statusCode, headers, body: auth.response.body };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!ANTHROPIC_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };
  if (!GEMINI_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'GEMINI_API_KEY not configured' }) };
  const canStore = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

  let body;
  try { body = JSON.parse(event.body); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const article = (body.article || '').trim();
  if (!article) return { statusCode: 400, headers, body: JSON.stringify({ error: 'article required' }) };
  const spotCount = Math.min(Math.max(parseInt(body.spot_count) || 3, 1), 4); // 1 feature + up to 4 body
  const wantFeature = body.feature !== false;
  const kit = body.brand_kit && typeof body.brand_kit === 'object' ? body.brand_kit : null;

  try {
    // Stage 1 — art-direct the image set (Claude reads the article, which may be long → truncate for planning)
    const forPlan = article.length > 9000 ? article.slice(0, 9000) : article;
    const planRes = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: PLANNER_MODEL,
        max_tokens: 1600,
        temperature: 0.6,
        system: PLANNER_SYSTEM,
        messages: [{ role: 'user', content: `Choose ${wantFeature ? '1 feature image + ' : ''}${spotCount} body image(s) for this article.${brandVisualNote(kit)}\n\nARTICLE:\n${forPlan}\n\nOutput the strict JSON now.` }]
      })
    });
    const planData = await planRes.json();
    if (!planRes.ok) return { statusCode: planRes.status, headers, body: JSON.stringify({ error: planData.error?.message || 'Image planning failed' }) };
    const planText = (planData.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    let plan;
    try { plan = extractJson(planText); }
    catch (e) { return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not parse image plan', detail: e.message }) }; }

    // Build the generation list: feature (16:9) + body (4:3)
    const jobs = [];
    if (wantFeature && plan.feature && plan.feature.image_prompt) {
      jobs.push({ role: 'feature', aspect: '16:9', image_prompt: plan.feature.image_prompt, alt: plan.feature.alt || '', after_heading: null });
    }
    (Array.isArray(plan.body) ? plan.body : []).slice(0, spotCount).forEach((b) => {
      if (b && b.image_prompt) jobs.push({ role: 'body', aspect: '4:3', image_prompt: b.image_prompt, alt: b.alt || '', after_heading: b.after_heading || null });
    });
    if (!jobs.length) return { statusCode: 502, headers, body: JSON.stringify({ error: 'Image planner returned no usable spots' }) };

    // Stage 2 — render all images in parallel
    const images = await Promise.all(jobs.map(async (job) => {
      let out = { role: job.role, after_heading: job.after_heading, alt: job.alt, image_prompt: job.image_prompt, image_base64: null, image_mime: null, image_url: null, image_error: null };
      const img = await generateImage(job.image_prompt, job.aspect, GEMINI_KEY);
      if (img.error) { out.image_error = img.error; return out; }
      out.image_url = canStore ? await uploadImageToStorage(img.base64, img.mime, SUPABASE_URL, SUPABASE_SERVICE_KEY, 'blog') : null;
      // Only ship base64 when there's no hosted URL (upload failed / Supabase off). A full set of
      // base64 images blows Netlify's ~6MB function response limit → 502. Frontend uses image_url.
      if (!out.image_url) { out.image_base64 = img.base64; out.image_mime = img.mime; }
      return out;
    }));

    return { statusCode: 200, headers, body: JSON.stringify({
      agent: 'blog-images',
      images,
      completed_at: new Date().toISOString()
    }) };
  } catch (e) {
    console.error('[blog-images]', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Blog image generation failed', detail: e.message }) };
  }
};
