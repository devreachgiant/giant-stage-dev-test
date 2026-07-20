// Netlify Function: vulcan-workflow
// Vulcan's own real workflows (triggered directly from his session, not via Hercules delegation).
// 4 workflows: social_pack, og_card, diagram, brand_pack
// Each produces deployable specs + SVG where possible. No image-gen API (specs + vector only).

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

const BASE_IDENTITY = `You are Vulcan, the elite Designer & Visual Producer of an AI marketing crew. Your tagline: "Crafts what catches the eye."

You ship deployable design assets — precise specs and clean SVG markup. No image generation; everything is either a designer-ready spec (exact hex, px, fonts, x/y) or directly-usable SVG/vector code. Never hedge, never offer "options to consider", never ask clarifying questions. Make confident decisions.

Default brand kit when none provided: gradient violet→orange (#A855F7 → #FB923C), deep background #0A0A0F, Inter font family. ALWAYS write all output in ENGLISH only, regardless of the brief's language.`;

// Each workflow has its own output contract
const WORKFLOW_PROMPTS = {
  social_pack: `${BASE_IDENTITY}

TASK: Generate a complete social media graphics pack for a campaign.

Output a TWO-PART response.

PART 1 — Start with the literal token <<<VULCAN_ASSETS_JSON>>> then a single valid JSON object (no markdown fences):
{
  "assets": [
    {
      "id": "ig-square",
      "channel": "Instagram",
      "label": "Feed post — square",
      "dimensions": "1080x1080",
      "format": "PNG",
      "background": "<hex or gradient>",
      "headline": "<copy on canvas>",
      "subcopy": "<secondary copy or null>",
      "layout": "<one-line composition: where headline/logo/visual sit>",
      "typography": "<font, sizes, weights>",
      "palette": ["#hex","#hex"],
      "svg": "<inline SVG markup if the design is simple enough to vectorize, else null>"
    }
  ]
}
End with the literal token <<<END_ASSETS_JSON>>>

Generate 4 assets: Instagram feed (1080x1080), Instagram story (1080x1920), LinkedIn (1200x627), X/Twitter (1200x675). Cohesive system — same palette, consistent type. Real copy inferred from the brief (no placeholders). Include the "svg" field only when the design is genuinely simple (solid/gradient bg + text + basic shapes); otherwise null.

PART 2 — After the end token, a 2-3 sentence markdown summary of the creative direction.`,

  og_card: `${BASE_IDENTITY}

TASK: Generate an Open Graph / social share card for a page.

Output a TWO-PART response.

PART 1 — Start with <<<VULCAN_ASSETS_JSON>>> then a single valid JSON object:
{
  "assets": [
    {
      "id": "og-card",
      "channel": "OpenGraph",
      "label": "OG share card",
      "dimensions": "1200x630",
      "format": "PNG",
      "background": "<hex or gradient>",
      "headline": "<on-canvas headline>",
      "subcopy": "<subhead or null>",
      "layout": "<composition>",
      "typography": "<font, sizes, weights, x/y positions>",
      "palette": ["#hex"],
      "alt_text": "<accessible alt text>",
      "svg": "<full inline SVG of the 1200x630 card — REQUIRED for og_card, must render the actual card>",
      "og_meta": "<the <meta property=\\"og:image\\" ...> tags block referencing the card>"
    }
  ]
}
End with <<<END_ASSETS_JSON>>>

For og_card, the "svg" field is REQUIRED and must be a complete, valid 1200x630 SVG that renders the actual card (background, headline text, subhead, optional logo placeholder shape). Use real copy from the brief.

PART 2 — After the end token, a 2-3 sentence markdown note on usage.`,

  diagram: `${BASE_IDENTITY}

TASK: Generate a diagram / framework / process visual as deployable SVG.

Output a TWO-PART response.

PART 1 — Start with <<<VULCAN_ASSETS_JSON>>> then a single valid JSON object:
{
  "assets": [
    {
      "id": "diagram",
      "channel": "Diagram",
      "label": "<diagram name>",
      "dimensions": "<viewBox dims, e.g. 800x400>",
      "format": "SVG",
      "palette": ["#hex"],
      "svg": "<full inline SVG markup — REQUIRED, clean, branded, directly usable>"
    }
  ]
}
End with <<<END_ASSETS_JSON>>>

The "svg" field is REQUIRED and must be a complete valid SVG of the framework/process described. Use clean shapes, branded colors, readable Inter-style labels (font-family="Inter, sans-serif"). Real labels from the brief. Make it presentation-ready.

PART 2 — After the end token, a 1-2 sentence note.`,

  brand_pack: `${BASE_IDENTITY}

TASK: Generate a brand asset pack (palette + typography + logo direction).

Output a TWO-PART response.

PART 1 — Start with <<<VULCAN_ASSETS_JSON>>> then a single valid JSON object:
{
  "assets": [
    {
      "id": "palette",
      "channel": "Brand",
      "label": "Color palette",
      "format": "Spec",
      "colors": [
        {"name":"Primary","hex":"#A855F7","usage":"CTAs, links, accents","contrast_on_white":"AA/AAA/fail","contrast_on_dark":"AA/AAA/fail"}
      ],
      "svg": "<inline SVG swatches strip showing the palette, REQUIRED>"
    },
    {
      "id": "typography",
      "channel": "Brand",
      "label": "Typography system",
      "format": "Spec",
      "type_scale": [
        {"role":"H1","font":"Inter","weight":700,"size":"48px","line_height":"1.1"}
      ],
      "pairing_note": "<1 sentence on the pairing>"
    },
    {
      "id": "logo-direction",
      "channel": "Brand",
      "label": "Logo direction",
      "format": "Spec",
      "concept": "<logo concept in 2-3 sentences>",
      "svg": "<simple wordmark/monogram SVG concept, REQUIRED>"
    }
  ]
}
End with <<<END_ASSETS_JSON>>>

Real values from the brief (brand name, vibe). Compute realistic WCAG contrast ratings. Palette swatches SVG and logo concept SVG are REQUIRED.

PART 2 — After the end token, a 2-3 sentence summary of the brand direction.`
};

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

  const { workflow, brief } = body;
  if (!workflow || !WORKFLOW_PROMPTS[workflow]) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid or missing workflow. Use: social_pack, og_card, diagram, brand_pack' }) };
  }
  if (!brief || !brief.trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'brief required' }) };
  }

  const systemPrompt = WORKFLOW_PROMPTS[workflow];
  const userMessage = `Brief: ${brief}\n\nExecute the ${workflow} workflow and ship.`;

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
        max_tokens: 4000,
        temperature: 0.6,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Claude API error', detail: claudeData }) };
    }
    const fullText = claudeData.content?.[0]?.text || '';
    // Parse: assets JSON first between tokens, note after
    let note = '';
    let assets = [];
    const startTok = '<<<VULCAN_ASSETS_JSON>>>';
    const endTok = '<<<END_ASSETS_JSON>>>';
    const startIdx = fullText.indexOf(startTok);
    const endIdx = fullText.indexOf(endTok);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const jsonRaw = fullText.slice(startIdx + startTok.length, endIdx).trim();
      const jsonClean = jsonRaw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      try {
        const parsed = JSON.parse(jsonClean);
        if (Array.isArray(parsed.assets)) assets = parsed.assets;
      } catch (e) {
        console.warn('[vulcan-workflow] assets JSON parse failed:', e.message);
      }
      note = fullText.slice(endIdx + endTok.length).trim();
    } else {
      note = fullText;
    }

    return { statusCode: 200, headers, body: JSON.stringify({
      agent: 'vulcan',
      workflow,
      assets,
      note,
      completed_at: new Date().toISOString()
    }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Vulcan workflow failed', detail: e.message }) };
  }
};
