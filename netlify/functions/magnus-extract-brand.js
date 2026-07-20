// Netlify Function: magnus-extract-brand
// Fetches a URL and extracts a synthetic brand kit (palette, fonts, tone, voice notes,
// brand name, logo URL, sample product image URLs) so Vulcan can produce on-brand
// visuals without any manual brand kit upload.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

const EXTRACT_SYSTEM = `You are Magnus's Brand Synthesizer. You receive structured signals scraped from a URL (HTML head, meta tags, CSS-derived colors, font hints, OG image, brand name, etc.) and you synthesize a tight brand kit object that Vulcan can use to design on-brand visuals.

Output ONLY a single valid JSON object (no markdown fences, no preamble):

{
  "name": "<brand name as derived from the page>",
  "color_primary": "#hex",
  "color_secondary": "#hex",
  "color_accent": "#hex",
  "color_background": "#hex",
  "color_text": "#hex",
  "font_headline": "<font family name (e.g. 'Inter', 'Playfair Display')>",
  "font_body": "<font family name>",
  "tone": "<3-6 word descriptor: 'sleek minimal tech', 'warm artisanal handcrafted', 'bold playful youthful', etc.>",
  "voice_notes": "<2-3 sentences describing the brand voice and what it cares about, inferred from the page copy>"
}

Rules:
- Use the EXACT hex codes provided in the signals when available — don't invent if you have data.
- If only some colors are detected: fill the missing slots with values that make sense for the brand palette (e.g. white #FFFFFF for background if not given, off-black #0A0A0A for text).
- Match the brand's tone from the page copy — if the page sounds premium/luxury, the tone reflects that; if playful, reflect that.
- Tone descriptor should help Vulcan choose the visual MEDIUM (sleek → 3D abstract; warm → editorial photo; bold → typographic).
- Voice notes inform copywriting, not visual decisions.
- If the brand has no clear identity (generic landing page), make confident sensible defaults — don't return nulls.`;

// Parse the fetched HTML to extract brand signals
function extractBrandSignals(html, finalUrl) {
  const signals = {
    name: null,
    title: null,
    description: null,
    og_image: null,
    favicon: null,
    apple_touch_icon: null,
    theme_color: null,
    colors: [],         // extracted from CSS inline / style attributes / variables
    fonts: [],          // from Google Fonts links and font-family declarations
    images: [],         // first few large images that might be products
    body_text_sample: ''
  };

  // <title>
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) signals.title = titleMatch[1].trim().slice(0, 200);

  // <meta> tags
  const metaRegex = /<meta\s+([^>]+)>/gi;
  let m;
  while ((m = metaRegex.exec(html)) !== null) {
    const attrs = m[1];
    const propM = /(?:property|name)=["']([^"']+)["']/i.exec(attrs);
    const contentM = /content=["']([^"']+)["']/i.exec(attrs);
    if (!propM || !contentM) continue;
    const prop = propM[1].toLowerCase();
    const content = contentM[1].trim();
    if (prop === 'og:site_name') signals.name = content;
    else if (prop === 'og:title' && !signals.title) signals.title = content;
    else if (prop === 'description' || prop === 'og:description') signals.description = content.slice(0, 300);
    else if (prop === 'og:image' || prop === 'twitter:image') {
      if (!signals.og_image) signals.og_image = resolveUrl(content, finalUrl);
    }
    else if (prop === 'theme-color') signals.theme_color = content;
  }

  // <link rel="icon" / "apple-touch-icon">
  const linkRegex = /<link\s+([^>]+)>/gi;
  while ((m = linkRegex.exec(html)) !== null) {
    const attrs = m[1];
    const relM = /rel=["']([^"']+)["']/i.exec(attrs);
    const hrefM = /href=["']([^"']+)["']/i.exec(attrs);
    if (!relM || !hrefM) continue;
    const rel = relM[1].toLowerCase();
    const href = hrefM[1];
    if (rel.includes('apple-touch-icon') && !signals.apple_touch_icon) {
      signals.apple_touch_icon = resolveUrl(href, finalUrl);
    } else if (rel.includes('icon') && !signals.favicon) {
      signals.favicon = resolveUrl(href, finalUrl);
    }
    // Google Fonts
    if (href.includes('fonts.googleapis.com') || href.includes('fonts.gstatic.com')) {
      const familyM = /family=([^&"']+)/.exec(href);
      if (familyM) {
        const fam = decodeURIComponent(familyM[1].replace(/\+/g, ' ').split(':')[0]);
        if (!signals.fonts.includes(fam)) signals.fonts.push(fam);
      }
    }
  }

  // Inline font-family in <style> blocks
  const styleBlocks = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [];
  styleBlocks.forEach(block => {
    const ffMatches = block.match(/font-family\s*:\s*([^;}'"]+)/gi) || [];
    ffMatches.forEach(ff => {
      const families = ff.replace(/font-family\s*:\s*/i, '').split(',');
      families.forEach(f => {
        const clean = f.trim().replace(/^["']|["']$/g, '').replace(/!important/i, '').trim();
        if (clean && !/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|-apple-system|inherit|initial)$/i.test(clean) && !signals.fonts.includes(clean)) {
          signals.fonts.push(clean);
        }
      });
    });
    // Hex colors in CSS
    const colorMatches = block.match(/#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b/g) || [];
    colorMatches.forEach(c => {
      const norm = c.length === 4 ? '#' + c.slice(1).split('').map(x => x + x).join('') : c;
      if (!signals.colors.includes(norm.toUpperCase())) signals.colors.push(norm.toUpperCase());
    });
  });
  // Also inline style attributes
  const inlineColors = (html.match(/(?:color|background|background-color)\s*:\s*(#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{3})/gi) || []);
  inlineColors.forEach(c => {
    const cm = /#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{3}/.exec(c);
    if (!cm) return;
    const v = cm[0].length === 4 ? '#' + cm[0].slice(1).split('').map(x => x + x).join('') : cm[0];
    if (!signals.colors.includes(v.toUpperCase())) signals.colors.push(v.toUpperCase());
  });
  // theme-color contributes too
  if (signals.theme_color && !signals.colors.includes(signals.theme_color.toUpperCase())) signals.colors.push(signals.theme_color.toUpperCase());

  // First few images that could be products (filter by reasonable sizes / src patterns)
  const imgRegex = /<img\s+([^>]+)>/gi;
  while ((m = imgRegex.exec(html)) !== null && signals.images.length < 6) {
    const attrs = m[1];
    const srcM = /\bsrc=["']([^"']+)["']/i.exec(attrs);
    const altM = /\balt=["']([^"']*)["']/i.exec(attrs);
    if (!srcM) continue;
    const src = srcM[1];
    if (src.startsWith('data:')) continue;
    if (/\.(svg)(\?|$)/i.test(src)) continue; // skip inline SVG icons
    signals.images.push({ url: resolveUrl(src, finalUrl), alt: altM ? altM[1].slice(0, 80) : null });
  }

  // Body text sample (strip tags)
  const bodyTextMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyTextMatch) {
    let text = bodyTextMatch[1].replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    signals.body_text_sample = text.slice(0, 1500);
  }

  // Cap colors list to top 12 most likely brand colors
  signals.colors = signals.colors.slice(0, 12);
  signals.fonts = signals.fonts.slice(0, 6);

  return signals;
}

function resolveUrl(href, baseUrl) {
  if (!href) return href;
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  try {
    const u = new URL(href, baseUrl);
    return u.toString();
  } catch (e) { return href; }
}

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
    console.error('[magnus-extract-brand] crash:', e?.stack || e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Brand extraction crashed', detail: (e && e.message) || String(e) }) };
  }
};

async function inner(event, headers) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON in request' }) };
  }
  let url = (body.url || '').trim();
  if (!url) return { statusCode: 400, headers, body: JSON.stringify({ error: 'url required' }) };
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  // Fetch the page (8s timeout)
  let html = '', finalUrl = url, fetchError = null;
  const fetchController = new AbortController();
  const fetchTimer = setTimeout(() => fetchController.abort(), 8000);
  try {
    const fetchRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
        'Cache-Control': 'no-cache'
      },
      redirect: 'follow',
      signal: fetchController.signal
    });
    clearTimeout(fetchTimer);
    if (!fetchRes.ok) {
      fetchError = `HTTP ${fetchRes.status} ${fetchRes.statusText}`;
    } else {
      html = await fetchRes.text();
      if (html.length > 500000) html = html.slice(0, 500000);
      finalUrl = fetchRes.url || url;
    }
  } catch (e) {
    clearTimeout(fetchTimer);
    fetchError = e.name === 'AbortError' ? 'URL fetch timed out (8s limit)' : (e.message || 'Fetch failed');
  }

  if (fetchError) {
    return { statusCode: 200, headers, body: JSON.stringify({
      error: `Could not fetch URL: ${fetchError}`,
      url
    }) };
  }

  const signals = extractBrandSignals(html, finalUrl);

  // Ask Claude to synthesize the brand kit
  let brandKitSynth;
  try {
    const userMsg = `URL: ${finalUrl}\n\nSignals scraped from the page:\n\`\`\`json\n${JSON.stringify(signals, null, 2)}\n\`\`\`\n\nSynthesize the brand kit object.`;
    const res = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1500,
        temperature: 0.3,
        system: EXTRACT_SYSTEM,
        messages: [{ role: 'user', content: userMsg }]
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Claude HTTP ${res.status}`);
    let text = data.content?.[0]?.text || '';
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const first = text.indexOf('{'), last = text.lastIndexOf('}');
    if (first === -1 || last === -1) throw new Error('Claude returned no JSON. Raw: ' + text.slice(0, 200));
    brandKitSynth = JSON.parse(text.slice(first, last + 1));
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Brand synthesis failed', detail: e.message }) };
  }

  // Build the final brand_kit object in the same shape Vulcan expects
  const brandKit = {
    name: brandKitSynth.name || signals.title || 'Brand from URL',
    color_primary: brandKitSynth.color_primary || null,
    color_secondary: brandKitSynth.color_secondary || null,
    color_accent: brandKitSynth.color_accent || null,
    color_background: brandKitSynth.color_background || '#FFFFFF',
    color_text: brandKitSynth.color_text || '#0A0A0A',
    font_headline: brandKitSynth.font_headline || null,
    font_body: brandKitSynth.font_body || null,
    tone: brandKitSynth.tone || null,
    voice_notes: brandKitSynth.voice_notes || null,
    // Pass image URLs as hints for Vulcan (not as integrated assets) — Nano Banana can't fetch URLs,
    // so these are informational. If Luke wants the actual logo/products integrated, they need to
    // be uploaded manually (or in a future sprint we can auto-fetch + base64 them).
    extracted_logo_url: signals.apple_touch_icon || signals.favicon || null,
    extracted_og_image_url: signals.og_image || null,
    extracted_product_urls: (signals.images || []).slice(0, 4).map(i => ({ url: i.url, alt: i.alt }))
  };

  return { statusCode: 200, headers, body: JSON.stringify({
    brand_kit: brandKit,
    source_url: finalUrl,
    raw_signals: signals
  }) };
}
