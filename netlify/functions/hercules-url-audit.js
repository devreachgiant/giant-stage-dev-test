// Netlify Function: hercules-url-audit
// Fetches a URL server-side, parses HTML, extracts SEO signals, and sends to Claude for analysis.
// Returns a structured audit report in markdown.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
// Using Haiku 4.5 (Step 1 quick win): 3-5x faster than Sonnet 4.5, sufficient quality for structured SEO audits.
const MODEL = 'claude-haiku-4-5-20251001';

// SEO expert system prompt for Hercules
const HERCULES_SEO_PROMPT = `You are Hercules, an elite SEO research and audit specialist embedded in an AI marketing crew. You ACT, not just diagnose. For every fixable issue, you generate the EXACT deployable code, not abstract recommendations.

Your output has TWO parts in this exact order:

═══════ PART 1: STRUCTURED FIXES (must come FIRST, output this BEFORE anything else) ═══════

Start your response with the literal token <<<HERCULES_FIXES_JSON>>>
Then output a single valid JSON object (no markdown code fences, no commentary). Shape:

{
  "fixes": [
    {
      "id": "schema-organization",
      "category": "schema | meta | canonical | robots | headings | og_tags | viewport | lang | title | description | content",
      "title": "Add Organization schema",
      "priority": "P1",
      "effort_minutes": 5,
      "description": "1 sentence explaining the fix.",
      "instructions": "Where to paste it (e.g. 'Paste in <head> of homepage')",
      "code": "<full JSON-LD code OR meta tag string here>",
      "delegate_to": "self"
    }
  ]
}

End with the literal token <<<END_FIXES_JSON>>>

═══════ PART 2: NARRATIVE AUDIT (only after the JSON above) ═══════

A markdown audit report:

# SEO Audit — [extracted site name]

## 🟢 Strengths
[3-5 wins, quantified]

## 🟠 Critical issues (P1)
[3-5 issues, each with impact and the fix already mentioned in the JSON above]

## 🟡 Opportunities (P2)
[3-5 lower-impact items]

## 📈 Estimated impact
[Realistic projection]

## 📋 Next steps
[Numbered action list]

═══════ HARD RULES FOR FIXES ═══════

1. **Generate the actual code ONLY for "self" fixes**. For "atlas"/"titan"/"vulcan"/"dev" delegations, the "code" field MUST be null. Those agents produce the deliverable themselves — don't pre-generate their work, you'd just waste their turn.

2. **CRITICAL — No placeholders allowed in code**. If you don't have the data (e.g. no phone number in the site signals, no street address, no logo URL), you MUST do one of:
   (a) Skip that schema entirely (don't include it in the fixes array), OR
   (b) Generate the schema WITHOUT that field (omit telephone if unknown, omit address if unknown — but keep what you DO have)
   Never output strings like "[phone]", "[Your Street Address]", "[City]", "[logo URL]", etc.

3. **Schema markup (self only)** — generate FULL JSON-LD using ONLY the data available in the site signals (title, meta description, canonical, OG tags, lang). Example for Organization when all you have is title + description + URL:
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "<from title>",
  "url": "<URL from input>",
  "description": "<from meta description>"
}

4. **Meta tags (self only)** — generate the FULL tag string. Examples:
   - canonical: <link rel="canonical" href="https://example.com/" />
   - robots: <meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1" />
   - OG title/desc/image/url: provide all 4 as a block; use real values from input or omit fields you don't have

5. **For LocalBusiness schema** — only generate if address/phone/hours are extractable from the site. Otherwise SKIP this fix entirely.

6. **For delegated fixes (atlas/titan/vulcan)** — the "code" field is **null**. The "instructions" field is the brief the agent will execute. Examples:
   - delegate_to: "atlas", instructions: "Rewrite the current meta description (145 chars, generic) into a higher-CTR version. Lead with a credibility hook, include a benefit, end with a soft CTA. Match the brand voice based on the H1 and existing copy. Target 150-160 chars."
   - delegate_to: "titan", instructions: "Restructure the heading hierarchy. Current: 1 H1, 15 H2s, 51 H3s (over-nested). Produce a clean H1 → H2 → H3 tree where each H3 is a semantic child of an H2. Use the existing H1 text as anchor. Aim for 8-10 H2s with 2-3 H3s each."
   - delegate_to: "vulcan", instructions: "Design the OG image (1200×630). Base it on the H1 'Full-Service Digital Marketing Agency'. Use violet/orange gradient accents, dark background. Include a tagline and clean typography."

7. **Always include 6-12 fixes minimum**. Mix self/atlas/titan/vulcan/dev based on what's needed.

8. **delegate_to mapping**:
   - "self" = Hercules generates the code (schemas, meta tags, OG, canonical, robots) — code field MUST be filled
   - "atlas" = needs copywriting (meta description rewrite, alt text writing, hero copy, case studies, ad copy) — code field is null
   - "titan" = needs content restructuring (heading hierarchy, content depth, editorial plans) — code field is null
   - "vulcan" = needs visuals (missing OG image, social cards, framework diagrams) — code field is null
   - "dev" = developer intervention required (server-side caching, redirects, complex tech) — code field is null

9. **JSON validity**: NO trailing commas. NO comments. NO markdown fences. Just the raw JSON.

10. The "code" field is a STRING when present. Escape internal double quotes as \\" and newlines as \\n. JSON parser must succeed.

═══════ HARD RULES FOR AUDIT ═══════

- Keep narrative under 500 words. The fixes JSON does the heavy lifting.
- Never invent metrics for MSV/KD/DA (not provided).
- Be specific. Quantify with the data provided.`;

// HTML parser — extracts SEO-relevant signals using regex (no external deps)
function parseHtmlForSeo(html, baseUrl) {
  const signals = {};
  // Title
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  signals.title = titleMatch ? titleMatch[1].trim() : null;
  signals.title_length = signals.title ? signals.title.length : 0;

  // Meta description
  const metaDescMatch = html.match(/<meta\s+(?:[^>]*?\s+)?name=["']description["']\s+(?:[^>]*?\s+)?content=["']([^"']*)["']/i)
    || html.match(/<meta\s+(?:[^>]*?\s+)?content=["']([^"']*)["']\s+(?:[^>]*?\s+)?name=["']description["']/i);
  signals.meta_description = metaDescMatch ? metaDescMatch[1].trim() : null;
  signals.meta_description_length = signals.meta_description ? signals.meta_description.length : 0;

  // Meta keywords (legacy but still tells us about effort level)
  const metaKwMatch = html.match(/<meta\s+(?:[^>]*?\s+)?name=["']keywords["']\s+(?:[^>]*?\s+)?content=["']([^"']*)["']/i);
  signals.meta_keywords = metaKwMatch ? metaKwMatch[1].trim() : null;

  // Canonical
  const canonicalMatch = html.match(/<link\s+(?:[^>]*?\s+)?rel=["']canonical["']\s+(?:[^>]*?\s+)?href=["']([^"']*)["']/i);
  signals.canonical = canonicalMatch ? canonicalMatch[1] : null;

  // Robots
  const robotsMatch = html.match(/<meta\s+(?:[^>]*?\s+)?name=["']robots["']\s+(?:[^>]*?\s+)?content=["']([^"']*)["']/i);
  signals.robots = robotsMatch ? robotsMatch[1] : null;

  // Viewport
  signals.has_viewport = /<meta\s+[^>]*name=["']viewport["']/i.test(html);

  // Language
  const langMatch = html.match(/<html\s+[^>]*lang=["']([a-z\-]+)["']/i);
  signals.lang = langMatch ? langMatch[1] : null;

  // Headings counts
  const h1Matches = [...html.matchAll(/<h1[^>]*>(.*?)<\/h1>/gis)];
  const h2Matches = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/gis)];
  const h3Matches = [...html.matchAll(/<h3[^>]*>(.*?)<\/h3>/gis)];
  signals.h1_count = h1Matches.length;
  signals.h2_count = h2Matches.length;
  signals.h3_count = h3Matches.length;
  signals.h1_texts = h1Matches.slice(0, 3).map(m => m[1].replace(/<[^>]*>/g, '').trim().slice(0, 100));
  signals.h2_texts = h2Matches.slice(0, 5).map(m => m[1].replace(/<[^>]*>/g, '').trim().slice(0, 100));

  // Images
  const imgMatches = [...html.matchAll(/<img\s+[^>]*>/gi)];
  signals.image_count = imgMatches.length;
  signals.images_missing_alt = imgMatches.filter(m => !/alt=["']/i.test(m[0])).length;

  // Links
  const linkMatches = [...html.matchAll(/<a\s+[^>]*href=["']([^"']+)["']/gi)];
  let host = '';
  try { host = new URL(baseUrl).hostname; } catch(_) {}
  signals.link_total = linkMatches.length;
  signals.link_internal = linkMatches.filter(m => {
    try {
      const href = m[1];
      if (href.startsWith('/') || href.startsWith('#')) return true;
      if (host && new URL(href, baseUrl).hostname === host) return true;
    } catch(_) {}
    return false;
  }).length;
  signals.link_external = signals.link_total - signals.link_internal;

  // OG tags
  signals.og_title = (html.match(/<meta\s+[^>]*property=["']og:title["']\s+[^>]*content=["']([^"']*)["']/i) || [])[1];
  signals.og_description = (html.match(/<meta\s+[^>]*property=["']og:description["']\s+[^>]*content=["']([^"']*)["']/i) || [])[1];
  signals.og_image = (html.match(/<meta\s+[^>]*property=["']og:image["']\s+[^>]*content=["']([^"']*)["']/i) || [])[1];

  // Schema.org JSON-LD
  const schemaMatches = [...html.matchAll(/<script\s+[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  signals.schema_count = schemaMatches.length;
  signals.schema_types = [];
  schemaMatches.forEach(m => {
    try {
      const obj = JSON.parse(m[1].trim());
      const t = obj['@type'] || (obj['@graph'] && obj['@graph'].map(g => g['@type']).filter(Boolean).join(', '));
      if (t) signals.schema_types.push(t);
    } catch(_) {}
  });

  // Word count (rough — strip tags)
  const textContent = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  signals.word_count = textContent.split(/\s+/).filter(w => w.length > 0).length;

  // HTML size
  signals.html_size_kb = Math.round(html.length / 1024);

  // External scripts (perf signal)
  const scriptMatches = [...html.matchAll(/<script\s+[^>]*src=["']([^"']+)["']/gi)];
  signals.external_script_count = scriptMatches.length;

  // Stylesheets
  const cssMatches = [...html.matchAll(/<link\s+[^>]*rel=["']stylesheet["']\s+[^>]*href=["']([^"']+)["']/gi)];
  signals.external_css_count = cssMatches.length;

  return signals;
}


// ── Robust fixes parser (shared logic, inlined) ──────────────────────────────
// Haiku's #1 failure mode: unescaped control chars (newlines/tabs) inside string
// values — e.g. multi-line JSON-LD in the "code" field — which makes JSON.parse throw
// and silently drops ALL fixes. This parser: (1) tries clean parse, (2) repairs raw
// control chars + trailing commas, (3) salvages each fix object individually so one
// bad fix never nukes the whole array.
function _repairJsonControlChars(s) {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { out += c; esc = false; continue; }
      if (c === '\\') { out += c; esc = true; continue; }
      if (c === '"') { out += c; inStr = false; continue; }
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') { out += '\\r'; continue; }
      if (c === '\t') { out += '\\t'; continue; }
      out += c;
    } else {
      if (c === '"') { out += c; inStr = true; continue; }
      out += c;
    }
  }
  return out;
}
function _salvagePerObject(s) {
  const out = [];
  const arrStart = s.indexOf('"fixes"');
  if (arrStart === -1) return out;
  const bracket = s.indexOf('[', arrStart);
  if (bracket === -1) return out;
  let depth = 0, inStr = false, esc = false, objStart = -1;
  for (let i = bracket + 1; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) objStart = i; depth++; continue; }
    if (c === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try { out.push(JSON.parse(s.slice(objStart, i + 1))); } catch (_) {}
        objStart = -1;
      }
      continue;
    }
    if (c === ']' && depth === 0) break;
  }
  return out;
}
function robustParseFixes(jsonClean) {
  try {
    const p = JSON.parse(jsonClean);
    return { data: p, fixes: Array.isArray(p.fixes) ? p.fixes : [], method: 'clean' };
  } catch (_) {}
  const repaired = _repairJsonControlChars(jsonClean).replace(/,(\s*[}\]])/g, '$1');
  try {
    const p = JSON.parse(repaired);
    return { data: p, fixes: Array.isArray(p.fixes) ? p.fixes : [], method: 'repaired' };
  } catch (_) {}
  const fixes = _salvagePerObject(repaired);
  return { data: { fixes }, fixes, method: fixes.length ? 'salvaged' : 'failed' };
}
// ─────────────────────────────────────────────────────────────────────────────

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

  let { url } = body;
  if (!url) return { statusCode: 400, headers, body: JSON.stringify({ error: 'url required' }) };
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  // Fetch the URL with a hard 8s timeout (we have 26s total budget; leave 15s+ for Claude)
  let html, finalUrl, fetchError;
  const fetchController = new AbortController();
  const fetchTimer = setTimeout(() => fetchController.abort(), 6000);
  try {
    const fetchRes = await fetch(url, {
      method: 'GET',
      headers: {
        // Use a realistic browser User-Agent — many sites (Cloudflare, anti-bot defaults) block unknown bots.
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
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
      // Cap HTML size at ~500kb to avoid huge payloads to Claude
      if (html.length > 500000) html = html.slice(0, 500000);
      finalUrl = fetchRes.url || url;
    }
  } catch (e) {
    clearTimeout(fetchTimer);
    fetchError = e.name === 'AbortError' ? 'URL fetch timed out (8s limit)' : (e.message || 'Fetch failed');
  }

  if (fetchError) {
    return { statusCode: 200, headers, body: JSON.stringify({
      error: `Failed to fetch URL: ${fetchError}`,
      url, signals: null, audit: null
    }) };
  }

  // Parse HTML
  const signals = parseHtmlForSeo(html, finalUrl || url);

  // Send to Claude for analysis
  const userMessage = `Audit this URL and produce a structured SEO report.

**URL audited:** ${finalUrl || url}

**Structured signals extracted from the HTML:**
\`\`\`json
${JSON.stringify(signals, null, 2)}
\`\`\`

Produce the audit report in the exact markdown format you've been trained on.`;

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
        max_tokens: 2400,
        temperature: 0.3,
        system: HERCULES_SEO_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Claude API error', detail: claudeData }) };
    }
    const fullText = claudeData.content?.[0]?.text || '';
    // NEW ORDER: JSON comes first (between <<<HERCULES_FIXES_JSON>>> and <<<END_FIXES_JSON>>>),
    // then the audit narrative follows. This way, if Claude hits max_tokens,
    // we still have the fixes (most valuable output) and only lose the tail of the audit.
    let audit = fullText;
    let fixes = [];
    let parseMethod = 'no_tokens';
    let rawFixesLen = 0;
    const startTok = '<<<HERCULES_FIXES_JSON>>>';
    const endTok = '<<<END_FIXES_JSON>>>';
    const startIdx = fullText.indexOf(startTok);
    const endIdx = fullText.indexOf(endTok);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const jsonRaw = fullText.slice(startIdx + startTok.length, endIdx).trim();
      const jsonClean = jsonRaw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      rawFixesLen = jsonClean.length;
      const r = robustParseFixes(jsonClean);
      fixes = r.fixes; parseMethod = r.method;
      if (parseMethod === 'failed') console.warn('[hercules-url-audit] fixes parse failed after salvage; raw len', rawFixesLen);
      audit = fullText.slice(endIdx + endTok.length).trim();
    } else if (startIdx !== -1) {
      // Legacy fallback: old format with JSON at the end (no end token)
      audit = fullText.slice(0, startIdx).trim();
      const jsonRaw = fullText.slice(startIdx + startTok.length).trim();
      const jsonClean = jsonRaw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      rawFixesLen = jsonClean.length;
      const r = robustParseFixes(jsonClean);
      fixes = r.fixes; parseMethod = 'legacy_' + r.method;
    }
    return { statusCode: 200, headers, body: JSON.stringify({
      url: finalUrl || url,
      signals,
      audit,
      fixes,
      _debug: { parse_method: parseMethod, raw_fixes_len: rawFixesLen, fixes_count: fixes.length }
    }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Claude call failed', detail: e.message }) };
  }
};
