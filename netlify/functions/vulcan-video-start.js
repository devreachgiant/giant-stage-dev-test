// Netlify Function: vulcan-video-start
// Starts a Veo 3 video generation job from a source image + concept.
// Returns immediately with a job_id; the frontend polls vulcan-video-status to get the final MP4.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const VEO_MODEL = 'veo-3.1-generate-preview';
const VEO_URL = `https://generativelanguage.googleapis.com/v1beta/models/${VEO_MODEL}:predictLongRunning`;

const MOTION_PROMPT_SYSTEM = `You are Vulcan's motion director. Given the concept and visual context of a static social media post, you write a SHORT motion prompt (2-4 sentences) describing how the FRAME should ANIMATE as an 8-second video.

═══════ CRITICAL CONTENT RULES ═══════

The motion prompt is fed to Google Veo 3, which REJECTS any prompt containing:
- Brand names, product names, company names (e.g. "ReachGiant", "Nike", "Apple")
- Real people's names, celebrities, public figures
- Trademark references or logos by name
- Specific business descriptors that could identify a real entity

So your motion prompt must describe ONLY abstract visual motion.

═══════ THE GOLDEN RULE — SUBJECT MOTION, NOT CAMERA MOTION ═══════

The video must feel ALIVE. The SUBJECTS in the frame should move — not the camera. The camera should be locked, or move only very subtly (a hair of drift). What the viewer notices is the SCENE coming to life.

Default approach: pick 2-3 subject-motion elements from the list below that fit the visual concept, and describe them concretely.

═══════ SUBJECT MOTION PATTERNS — PICK WHAT FITS ═══════

**For textile / fabric subjects** (clothing, pillows, linens, curtains):
- Fabric subtly billows or breathes as if a gentle wind passes through
- Threads ripple along the surface
- Fibers catch and release light as they shift
- Cushions slowly deform and recover, suggesting weight and softness

**For liquid / beverage / pour subjects**:
- Liquid pours from above, ripples spread, droplets fall in slow motion
- Surface reflects shifting light, condensation slowly forms on glass
- Steam rises, swirls, dissipates

**For botanical / organic subjects** (flowers, leaves, dried branches, plants):
- Leaves and stems sway gently as if in soft breeze
- Petals quiver, individual elements shift their position
- Dried botanicals rotate slowly, casting moving shadows

**For 3D / abstract / sculptural subjects**:
- Subject slowly rotates on a vertical axis (lazy susan effect)
- Surface materials shimmer and shift their reflective properties
- Soft particles drift across the scene (dust motes, light bokeh)
- Color or light gradients on the surface evolve subtly

**For food / culinary subjects**:
- Steam curls upward, ingredients glisten as light shifts
- Sauce or oil drizzles in slow motion, settles into the dish
- Crumbs or seasonings tumble across the surface

**For typographic / poster subjects**:
- Letters appear with subtle kinetic reveal (fade up + slight scale)
- Background gradient breathes; accent color shifts
- Light sweeps across the typography

**For interior / architectural subjects** (rooms, furniture, ambient scenes):
- Curtains move with imagined breeze, dust motes drift through light shafts
- Candle flames flicker, fire crackles in soft focus
- Light from a window slowly evolves (cloud passing, time shift)

**For metallic / glass / reflective subjects**:
- Reflections drift and shift across the surface
- Highlights pulse with subtle breathing rhythm
- Surface refractions evolve as if light source moves

═══════ STYLE RULES ═══════

- Premium, editorial, deliberate motion — never frantic, never gimmicky, never crash zoom.
- The camera is LOCKED or has at most a 5% drift over 8 seconds. Subject motion is the primary action.
- Loop-friendly: motion should feel like it could repeat seamlessly.
- Lighting and atmosphere can evolve (light shifts, particles drift) to enhance the living feel.

═══════ OUTPUT ═══════

Output ONLY the motion prompt as plain text — no preamble, no quotes, no labels, no proper nouns. 2-4 sentences that name the SPECIFIC subject motions happening in this frame. Mention the subject(s) in generic terms ("the pillow", "the leaves", "the liquid", "the form") — never by brand or product name.

Example outputs:

For a pillow scene: "The pillow surface slowly breathes, fabric fibers catching and releasing the warm light. A dried botanical branch beside it sways imperceptibly, casting a slowly drifting shadow on the linen. Dust motes drift through the warm rake-light across the frame, the camera completely still."

For a 3D sculptural form: "The matte black form rotates slowly on its vertical axis, the thin accent ring catching and releasing light as it turns. Soft particles drift through the negative space in front of the form. The composition stays anchored, only the subject lives."

For a beverage: "The liquid pours from above, ripples spreading outward across the surface in slow motion. Tiny condensation droplets form on the outside of the glass. Steam curls upward and dissipates into the warm overhead light."`;

// Scrub the prompt of any obvious proper noun / brand-like token before sending to Veo.
// Conservative: strips capitalized multi-word tokens that look like brand names (e.g. "ReachGiant", "John Doe").
// Standalone capitalized words at sentence start are kept (those are normal English).
function scrubProperNouns(text) {
  if (!text) return text;
  let out = text;
  // Remove obvious brand-like CamelCase tokens (e.g. "ReachGiant", "TechCorp")
  out = out.replace(/\b[A-Z][a-z]+[A-Z][a-zA-Z]+\b/g, '');
  // Remove "Name LastName" patterns (two capitalized words in a row, not at sentence start)
  out = out.replace(/(?<=[a-z,] )[A-Z][a-z]+ [A-Z][a-z]+/g, '');
  // Collapse extra whitespace
  out = out.replace(/\s{2,}/g, ' ').trim();
  return out;
}

async function planMotion(concept, imagePrompt, apiKey) {
  try {
    const res = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 400,
        temperature: 0.75,
        system: MOTION_PROMPT_SYSTEM,
        messages: [{ role: 'user', content: `Concept (scrubbed of any brand/personal names): ${scrubProperNouns(concept) || '(no concept)'}\n\nOriginal image direction (scrubbed): ${scrubProperNouns(imagePrompt) || '(none)'}\n\nWrite the 8-second motion prompt for this post. Remember: NO proper nouns of any kind in your output.` }]
      })
    });
    const data = await res.json();
    if (!res.ok) return null;
    let motion = (data.content?.[0]?.text || '').trim().replace(/^["']|["']$/g, '');
    // Second scrub on Claude's output as a belt-and-suspenders defense
    motion = scrubProperNouns(motion);
    return motion;
  } catch (e) { return null; }
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

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!ANTHROPIC_KEY || !GEMINI_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing env vars (ANTHROPIC_API_KEY, GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  // Expected: { image_base64, image_mime, concept, image_prompt }
  const imageBase64 = body.image_base64;
  const imageMime = body.image_mime || 'image/png';
  const concept = body.concept || '';
  const imagePrompt = body.image_prompt || '';
  if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: 'image_base64 required' }) };

  // 1) Plan motion via Claude
  let motionPrompt = await planMotion(concept, imagePrompt, ANTHROPIC_KEY);
  if (!motionPrompt) {
    motionPrompt = 'The main subject in the frame slowly breathes and shifts, surface materials catching and releasing light. Soft particles drift through the warm ambient light across the scene. The camera stays locked — only the subject lives.';
  }

  // 2) Launch Veo 3 — image-to-video, 8s, 16:9 default but the source aspect carries over
  let operationName;
  try {
    const veoRes = await fetch(VEO_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': GEMINI_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{
          prompt: motionPrompt,
          image: { bytesBase64Encoded: imageBase64, mimeType: imageMime }
        }],
        parameters: {
          durationSeconds: 8,
          aspectRatio: '16:9'
        }
      })
    });
    const veoData = await veoRes.json();
    if (!veoRes.ok) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Veo launch failed', detail: veoData.error?.message || JSON.stringify(veoData).slice(0, 400) }) };
    }
    operationName = veoData.name;
    if (!operationName) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Veo did not return an operation name', detail: JSON.stringify(veoData).slice(0, 400) }) };
    }
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Veo launch error', detail: e.message }) };
  }

  // 3) Insert the tracking row in Supabase using the service role key
  let jobId;
  try {
    const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/vulcan_videos`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        status: 'running',
        operation_name: operationName,
        prompt_motion: motionPrompt,
        source_image_caption: concept,
        duration_s: 8
      })
    });
    const rows = await sbRes.json();
    if (!sbRes.ok || !Array.isArray(rows) || !rows[0]) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase insert failed', detail: JSON.stringify(rows).slice(0, 400) }) };
    }
    jobId = rows[0].id;
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase error', detail: e.message }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({
    agent: 'vulcan',
    job_id: jobId,
    status: 'running',
    operation_name: operationName,
    motion_prompt: motionPrompt,
    estimated_seconds: 90
  }) };
};
