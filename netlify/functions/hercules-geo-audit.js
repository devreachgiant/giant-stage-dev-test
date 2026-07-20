// Netlify Function: hercules-geo-audit
// Single-call GEO audit. Avoids Netlify timeout by doing everything in one Claude inference.
// User provides only a site URL. Hercules:
// 1. Fetches site context (title, meta, h1)
// 2. Sends everything to Claude in ONE inference. Claude:
//    - Imagines 2-3 realistic search queries
//    - Mentally simulates how it would respond to each (would it cite the user's site?)
//    - Identifies likely competitors that would be cited instead
//    - Produces the structured report + fixes JSON

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

const HERCULES_GEO_PROMPT = `You are Hercules, an elite Generative Engine Optimization (GEO) specialist embedded in an AI marketing crew. You ACT, not just diagnose. For every fixable issue, you generate the EXACT deployable code/brief.

Given a site URL + extracted homepage context, you will:

1. **Imagine 2-3 realistic search queries** an audience for this business would type into ChatGPT/Claude/Perplexity (informational/comparative, not branded)

2. **Mentally simulate** how Claude would answer each — listing the companies/sites that would be cited based on your training knowledge

3. **Compute the visibility score**: (mentions of user's site / total queries) × 100. Be brutally honest — if you wouldn't cite the user's site organically for these queries, the score is 0.

4. **Identify the top competitors** that WOULD be cited (real companies you know in this space)

5. **Produce the output** in two parts in this exact order:

═══════ PART 1: STRUCTURED FIXES (FIRST) ═══════

Start with the literal token <<<HERCULES_FIXES_JSON>>>
Then a single valid JSON object (no markdown fences):

{
  "fixes": [
    {
      "id": "schema-faqpage",
      "category": "schema | content | positioning | thought_leadership | backlinks | distribution",
      "title": "Short title",
      "priority": "P1",
      "effort_hours": 4,
      "description": "1-2 sentences",
      "instructions": "How to deploy",
      "code": "<JSON-LD if applicable, else null>",
      "delegate_to": "self | atlas | titan | vulcan | dev"
    }
  ],
  "queries_simulated": ["query 1", "query 2"],
  "score": 0,
  "mentions": 0,
  "total_queries": 2,
  "top_competitors": [{"domain": "competitor.com", "mentions": 2, "rate": 100}]
}

End with the literal token <<<END_FIXES_JSON>>>

═══════ PART 2: NARRATIVE AUDIT ═══════

# GEO Visibility Report — [site]

## 📊 Visibility score
[Score X/100, brutally honest. Explain why.]

## 🔍 Queries simulated
[The 2-3 queries you mentally tested]

## 🥊 Competitive landscape
[Top 5 sites that WOULD be cited for these queries, with rationale]

## ❌ Why you're not being cited
[3-5 specific reasons grounded in the site context provided]

## 🎯 5 specific actions to lift your GEO score
[Each action's expected outcome]

## 📈 Estimated outcome
[Realistic projection]

## ⚠️ Note on methodology
[This audit ran a single-pass simulation. For exhaustive data, run multi-engine queries across ChatGPT + Perplexity + Claude.]

═══════ HARD RULES FOR FIXES ═══════

1. **Generate code ONLY for "self" fixes** (schemas: FAQPage, Article, Organization, BreadcrumbList, Speakable). For "atlas"/"titan"/"vulcan"/"dev" delegations, the "code" field MUST be null. Those agents produce the deliverable themselves when triggered — don't pre-generate their work.

2. **No placeholders in code**. If you don't have the data (no real phone, address, social links, logo URL), SKIP that schema OR omit the field. Never output "[phone]", "[address]", "[city]", etc.

3. **Generate the actual code for "self" fixes**:
   - **FAQPage schema** — full JSON-LD with 3-5 realistic questions+answers inferred from the business
   - **Article schema TEMPLATE** for case studies — JSON-LD with realistic structure (no fake metrics, structure only)
   - **Organization schema** — only fields you can fill from site context (name, url, description). Omit sameAs, logo, telephone if unknown.
   - **BreadcrumbList schema** — using URL structure

4. **For delegated fixes** — the "code" field is **null**. The "instructions" field is the brief the agent executes. Examples:
   - delegate_to: "atlas", instructions: "Write 5 case studies for our key verticals. Each 600-900 words. Required sections: client industry, the challenge with specific metrics, the methodology applied, results with quantified outcomes (revenue lift %, conversion %, timeline), client testimonial quote. Use anonymized client names. Inferred verticals from the audit data: ecommerce DTC, B2B SaaS, fintech."
   - delegate_to: "titan", instructions: "Plan a 'State of [industry]' pillar report. 2500+ words. Define 5 specific data findings with hero stats. Include methodology section, 3 distribution angles, and a hero chart concept."
   - delegate_to: "vulcan", instructions: "Design the framework diagram for our proprietary methodology. 5 stages, each with icon + title + 1-sentence description. Branded palette."

5. **Include 6-10 fixes minimum**. Mix self/atlas/titan/vulcan/dev.

6. **JSON validity**: no trailing commas, no markdown fences. Escape internal quotes as \\" and newlines as \\n.

═══════ HARD RULES FOR AUDIT ═══════

- Be brutally honest about the score (don't soften)
- All claims grounded in the data provided
- Keep narrative under 500 words`;

async function fetchSiteContext(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    let html = await res.text();
    if (html.length > 150000) html = html.slice(0, 150000);
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
    const metaDesc = (html.match(/<meta\s+(?:[^>]*?\s+)?name=["']description["']\s+(?:[^>]*?\s+)?content=["']([^"']*)["']/i) || [])[1] || '';
    const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || ['', ''])[1].replace(/<[^>]*>/g, '').trim().slice(0, 200);
    const textContent = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 800);
    return { title, metaDesc, h1, textContent };
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

function normalizeDomain(url) {
  let d = url.toLowerCase().trim();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  return d;
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

  let { site, url } = body;
  site = site || url; // Magnus dispatches with { url }, the standalone UI sends { site } — accept both.
  if (!site) return { statusCode: 400, headers, body: JSON.stringify({ error: 'site required' }) };
  if (!/^https?:\/\//i.test(site)) site = 'https://' + site;
  const userDomain = normalizeDomain(site);

  // Step 1: fetch site context (5s max)
  const siteContext = await fetchSiteContext(site);

  // Step 2: single Claude inference does everything (simulate queries + audit + fixes)
  const ctxStr = siteContext
    ? `**Site URL:** ${site}\n**Domain:** ${userDomain}\n**Title:** ${siteContext.title}\n**Meta description:** ${siteContext.metaDesc}\n**H1:** ${siteContext.h1}\n**First 800 chars of homepage text:**\n${siteContext.textContent}`
    : `**Site URL:** ${site}\n**Domain:** ${userDomain}\n(Site content could not be fetched. Infer business type from domain name alone.)`;

  const userMessage = `Run a GEO (Generative Engine Optimization) audit on this site.

${ctxStr}

Imagine 2-3 search queries an audience for this business would type into AI search engines. Simulate how Claude would answer (based on your knowledge — what sites would you cite for these queries?). Determine if ${userDomain} would be cited. Compute the visibility score. Identify the top competitors that WOULD be cited instead. Produce the structured fixes JSON + narrative audit per your instructions.`;

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
        temperature: 0.4,
        system: HERCULES_GEO_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
      })
    });
    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Claude API error', detail: claudeData }) };
    }
    const fullText = claudeData.content?.[0]?.text || '';
    // Parse: JSON first between tokens, audit after
    let audit = fullText;
    let fixes = [];
    let parsedData = null;
    const startTok = '<<<HERCULES_FIXES_JSON>>>';
    const endTok = '<<<END_FIXES_JSON>>>';
    const startIdx = fullText.indexOf(startTok);
    const endIdx = fullText.indexOf(endTok);
    let parseMethod = 'no_tokens';
    let rawFixesLen = 0;
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const jsonRaw = fullText.slice(startIdx + startTok.length, endIdx).trim();
      const jsonClean = jsonRaw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      rawFixesLen = jsonClean.length;
      const r = robustParseFixes(jsonClean);
      fixes = r.fixes; parsedData = r.data; parseMethod = r.method;
      if (parseMethod === 'failed') console.warn('[hercules-geo-audit] fixes parse failed after salvage; raw len', rawFixesLen);
      audit = fullText.slice(endIdx + endTok.length).trim();
    }
    const score = (parsedData && typeof parsedData.score === 'number') ? parsedData.score : 0;
    const mentions = (parsedData && typeof parsedData.mentions === 'number') ? parsedData.mentions : 0;
    const totalQueries = (parsedData && typeof parsedData.total_queries === 'number') ? parsedData.total_queries : (Array.isArray(parsedData?.queries_simulated) ? parsedData.queries_simulated.length : 0);
    const competitors = (parsedData && Array.isArray(parsedData.top_competitors)) ? parsedData.top_competitors : [];
    const generatedPrompts = (parsedData && Array.isArray(parsedData.queries_simulated)) ? parsedData.queries_simulated : [];

    return { statusCode: 200, headers, body: JSON.stringify({
      site: userDomain,
      score,
      mentions,
      total_queries: totalQueries,
      generated_prompts: generatedPrompts,
      competitors,
      audit,
      fixes,
      _debug: { parse_method: parseMethod, raw_fixes_len: rawFixesLen, fixes_count: fixes.length }
    }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Claude analysis failed', detail: e.message }) };
  }
};
