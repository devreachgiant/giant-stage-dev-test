// Netlify Function: vulcan-brand-parse
// Receives a PDF brand book + low-res page screenshots (rasterized client-side via PDF.js).
// Asks Claude to extract:
//   - palette hex codes (primary, secondary, accent, background, text)
//   - fonts (headline, body)
//   - brand tone + voice notes
//   - which page contains the cleanest logo + its bounding box (normalized 0-1 coords)
// The frontend uses the page/bbox info to crop the logo from the rasterized page.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `You are Vulcan's brand analyst. You receive a PDF brand book (with its pages rasterized as images) and you extract the brand identity into structured JSON.

Output ONLY a single valid JSON object, no markdown fences, no preamble:

{
  "name": "<brand name as it appears in the document, or null>",
  "color_primary": "<#HEXCODE — the main brand color>",
  "color_secondary": "<#HEXCODE or null>",
  "color_accent": "<#HEXCODE or null>",
  "color_background": "<#HEXCODE — the primary background color used in the brand identity, often white or near-black>",
  "color_text": "<#HEXCODE — the primary text/foreground color, often black or white depending on background>",
  "font_headline": "<font family name as displayed/specified, e.g. 'Inter', 'Helvetica Neue', 'Playfair Display', or null>",
  "font_body": "<font family for body copy, or null>",
  "tone": "<3-8 words describing the brand tone: e.g. 'premium luxury, minimal, confident'>",
  "voice_notes": "<1-2 sentences capturing audience, do's and don'ts if mentioned>",
  "logo_page": <1-based page number of the page showing the PRIMARY logo in its CLEANEST presentation — a standalone logo on a plain/solid background (white, black, or a flat brand colour), NOT a logo embedded inside a photograph or busy mockup. Prefer the dedicated 'Logo' guidelines page or the cover. Use null if none exists>,
  "logo_bbox": {
    "x": <left edge as a fraction of page width, 0-1>,
    "y": <top edge as a fraction of page height, 0-1>,
    "w": <width as a fraction of page width, 0-1>,
    "h": <height as a fraction of page height, 0-1>
  }
}

Rules:
- Hex codes must be 6-char uppercase like "#A855F7". If the brand book gives RGB or CMYK, convert to hex.
- For colors, pick the official primary/secondary if labeled. If only a palette swatch grid is shown, infer roles by visual prominence and order.
- For logo_bbox: choose the version of the logo that sits on the most uniform background (so it crops cleanly), and draw the TIGHTEST rectangle that contains the WHOLE logo lockup including any ® / ™ and tagline that are part of it — but EXCLUDE surrounding captions, page numbers, swatches, or unrelated graphics. Leave only ~2% padding. Use NORMALIZED coordinates 0.0-1.0 relative to the page you see. A tight, accurate box matters more than a large one.
- If you cannot find a clear standalone logo presentation on any page, set logo_page to null and logo_bbox to null.
- If a field genuinely isn't in the document, use null — do not invent.
- ALWAYS write all tone/voice_notes and every output string in ENGLISH only, regardless of the brand book's language.`;

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
  // Expected payload:
  //   pages: [{ index: 1, mime: 'image/png', base64: '...' }, ...]   (rasterized PDF pages, low-res)
  // We do NOT need the original PDF here — Claude works from the page images.
  const pages = Array.isArray(body.pages) ? body.pages.slice(0, 20) : [];  // cap at 20 pages to stay under context limits
  if (pages.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'pages required (rasterized PDF pages as base64 PNG)' }) };
  }

  // Build the message content: each page as an image block, then a final text instruction
  const contentParts = [];
  pages.forEach(p => {
    if (!p.base64 || !p.mime) return;
    contentParts.push({
      type: 'image',
      source: { type: 'base64', media_type: p.mime, data: p.base64 }
    });
  });
  if (contentParts.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No valid page images in payload' }) };
  }
  contentParts.push({
    type: 'text',
    text: `Above are the ${contentParts.length} pages of a brand book, in order (page 1 first). Extract the brand identity per your JSON schema. Pay particular attention to: explicit color swatches with hex/RGB/Pantone labels, typography specimens, and the cleanest logo presentation. For logo_page use 1-based numbering matching the order above.`
  });

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
        max_tokens: 1500,
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: contentParts }]
      })
    });
    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Claude API error', detail: claudeData }) };
    }
    let text = claudeData.content?.[0]?.text || '';
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) text = text.slice(firstBrace, lastBrace + 1);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not parse Claude response as JSON', raw: text.slice(0, 500) }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({
      agent: 'vulcan',
      extraction: parsed,
      pages_analyzed: contentParts.length - 1,
      completed_at: new Date().toISOString()
    }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Brand parsing failed', detail: e.message }) };
  }
};
