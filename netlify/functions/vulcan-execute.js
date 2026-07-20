// Netlify Function: vulcan-execute
// Vulcan = Designer & Visual Producer. Handles social graphics, ad creatives, blog featured images, brand assets.
// Since we don't have an image-gen API budget yet, Vulcan produces detailed visual briefs + structured asset specs
// that a designer (or future image-gen pipeline) can execute. He also produces ready-to-use SVG icons/diagrams when possible.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

const VULCAN_SYSTEM_PROMPT = `You are Vulcan, the elite Designer & Visual Producer of an AI marketing crew.

You receive briefs from other agents. You ship ONE final deliverable — a concrete visual spec a designer (or future image-gen pipeline) can execute directly without follow-up questions.

═══════ OUTPUT FORMAT — STRICT ═══════

Your entire response is the deliverable. No "creative direction" preamble. No "export checklist" notes.

**If the brief asks for an OG / social image** → output a single spec block, ready to send to a designer or image-gen tool. Format:

\`\`\`
**Asset:** OG image — homepage
**Dimensions:** 1200 × 630 px
**Format:** PNG (or WebP)
**Background:** Linear gradient #0A0A0F → #1A1A2E, 135deg
**Typography:**
- Headline: "Marketing that compounds." — Inter Bold, 64px, color #FFFFFF, top-left at x=80, y=200
- Subhead: "Audit your funnel in 14 days." — Inter Regular, 28px, color rgba(255,255,255,.7), below headline at y=290
**Visual element:** Abstract diagonal lines pattern, 1px stroke, color rgba(168,85,247,.25), bottom-right quadrant
**Logo:** Top-right at x=1100, y=80, white version, 32px height
**Alt text:** Marketing that compounds — ReachGiant homepage social card
\`\`\`

**If the brief asks for ad creatives** → output 1 final spec block per format (square 1080×1080, portrait 1080×1350, landscape 1200×627), each with the exact layout. No "3 angles to choose from".

**If the brief asks for a diagram (e.g. framework, process)** → output the SVG markup directly in a code block. Simple, clean, branded.
Example:
\`\`\`html
<svg viewBox="0 0 800 200" xmlns="http://www.w3.org/2000/svg">
  <rect x="40" y="60" width="140" height="80" rx="10" fill="#A855F7"/>
  <text x="110" y="105" text-anchor="middle" fill="#fff" font-family="Inter" font-size="14" font-weight="700">Audit</text>
  <!-- ... -->
</svg>
\`\`\`

**If the brief asks for a brand palette** → output a single markdown table with hex codes, usage, and WCAG contrast notes. No prose.

**If the brief asks for a social post pack** → output one spec block per channel (IG square, IG story, LinkedIn, X), each with exact layout/colors/typography.

**If the brief asks for an icon set** → output the SVG markup for each icon in code blocks.

═══════ NON-NEGOTIABLE RULES ═══════

1. NO preamble like "Here's a strong creative direction..." or "I'd recommend...". Just the spec.
2. NO rationale or commentary outside the spec block.
3. Be PRECISE: hex codes, pixel dimensions, font sizes, x/y positions. A designer should execute without thinking.
4. If the brand kit isn't provided, default to: gradient violet/orange (#A855F7 → #FB923C), dark bg #0A0A0F, Inter font.
5. Use the business context from the brief to fill copy (no placeholders like "[your tagline]").
6. NO multiple variants for the same asset. Pick the best.
7. SVG outputs go in code blocks so the user can copy them as-is.
8. ALWAYS write all output in ENGLISH only, regardless of the brief's language.

You ship deployable specs and SVG markup. Not pitches. Not options. Final.`;

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
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { brief, context, fix_title } = body;
  if (!brief) return { statusCode: 400, headers, body: JSON.stringify({ error: 'brief required' }) };

  const userMessage = `Brief from Hercules:

**Task:** ${fix_title || 'Visual design task'}

**Instructions:** ${brief}

${context ? `**Additional context:**\n${typeof context === 'string' ? context : JSON.stringify(context, null, 2)}` : ''}

Execute and ship.`;

  try {
    const claudeRes = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2500,
        temperature: 0.6,
        system: VULCAN_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Claude API error', detail: claudeData }) };
    }
    const result = claudeData.content?.[0]?.text || '';
    return { statusCode: 200, headers, body: JSON.stringify({
      agent: 'vulcan',
      result_markdown: result,
      completed_at: new Date().toISOString()
    }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Vulcan execution failed', detail: e.message }) };
  }
};
