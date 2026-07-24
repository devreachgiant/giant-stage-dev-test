// Netlify Function: blog-draft
// Step 2 of the Blog Content Agent. Writes the article in PIECES so each call stays
// well under Netlify's 26s function limit (a single full-article generation would risk
// a 504). The frontend loops the approved outline and assembles the Markdown.
//
// Modes:
//   intro   → opening (no H2): hook + what the reader will get, in the client's voice.
//   section → one outline section: "## {h2}" + prose (+ "### {h3}" where given).
//   faq     → "## Frequently Asked Questions" from the brief's FAQ set.
//   meta    → JSON { meta_title, meta_description } (used if the brief's need refreshing).

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const BLOG_MODEL = 'claude-sonnet-5'; // content model for the blog agent

const { allowOrigin } = require('./_cors');
const { requireUser } = require('./_auth');
const { brandVoiceContext, extractJson } = require('./_brand');

const BASE_RULES = `You are an expert SEO copywriter writing for a specific client in THEIR brand voice. Rules that always apply:
- Write in the client's tone exactly; never generic marketing filler ("In today's fast-paced world", "Look no further").
- Apply semantic SEO: use the primary keyword naturally and weave in secondary/semantic terms where they genuinely fit — never stuff.
- Demonstrate real expertise (E-E-A-T): specifics, numbers, concrete steps — not vague reassurance.
- Scannable: short paragraphs (2-4 sentences), and use "### " sub-headings only where the outline provides them.
- Add a Markdown link ONLY where the brief supplies a relevant internal/external link and it fits naturally; use the given anchor text. Do not invent URLs — for internal links use the anchor with a placeholder like [anchor](#) the human will resolve.
- Output GitHub-flavored Markdown for the requested piece ONLY. No preamble, no "Here is", no meta commentary, no wrapping code fence.`;

function keywordLine(brief) {
  const kw = brief && brief.keywords ? brief.keywords : brief;
  const primary = (brief && brief.primary_keyword) || (kw && kw.primary) || '';
  const secondary = (brief && brief.secondary_keywords) || (kw && kw.secondary) || [];
  const semantic = (brief && brief.semantic_keywords) || (kw && kw.semantic) || [];
  const parts = [];
  if (primary) parts.push(`Primary keyword: ${primary}`);
  if (Array.isArray(secondary) && secondary.length) parts.push(`Secondary: ${secondary.slice(0, 12).join(', ')}`);
  if (Array.isArray(semantic) && semantic.length) parts.push(`Semantic: ${semantic.slice(0, 15).join(', ')}`);
  return parts.length ? '\n\nSEO terms to work in naturally:\n- ' + parts.join('\n- ') : '';
}

function linkLine(brief) {
  const parts = [];
  if (Array.isArray(brief && brief.internal_links) && brief.internal_links.length) {
    parts.push('Internal links to use where natural: ' + brief.internal_links.map((l) => `"${l.anchor}" (→ ${l.target})`).join('; '));
  }
  if (Array.isArray(brief && brief.external_links) && brief.external_links.length) {
    parts.push('External links to cite where natural: ' + brief.external_links.map((l) => `"${l.anchor}" (→ ${l.target})`).join('; '));
  }
  return parts.length ? '\n\n' + parts.join('\n') : '';
}

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

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };

  let body;
  try { body = JSON.parse(event.body); } catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const mode = ['intro', 'section', 'faq', 'meta'].includes(body.mode) ? body.mode : 'section';
  const brief = body.brief || {};
  const ctx = brandVoiceContext({ kit: body.brand_kit, client: body.client, guidelines: body.guidelines });
  const title = (body.title || brief.title || '').trim();
  const topic = (body.topic || '').trim();

  const system = BASE_RULES + ctx;
  let userMsg = '';
  let expectJson = false;
  let maxTokens = 1500;
  let temperature = 0.7;

  if (mode === 'intro') {
    userMsg = `Write the OPENING of an article titled "${title || topic}" (topic: ${topic}). Search intent: ${brief.search_intent || 'informational'}. 1-2 short paragraphs: a strong hook (no clichés) and a promise of what the reader will get. Do NOT include an H1 or any H2 heading — opening prose only.${keywordLine(brief)}`;
    maxTokens = 700;
  } else if (mode === 'faq') {
    const faqs = Array.isArray(brief.faqs) ? brief.faqs : [];
    userMsg = `Write a "## Frequently Asked Questions" section. For each question below, write it as "### {question}" followed by a concise, accurate 2-4 sentence answer in the client's voice.\n\nQuestions:\n${faqs.map((f, i) => `${i + 1}. ${f.q}${f.a ? ` (draft answer to improve: ${f.a})` : ''}`).join('\n')}${keywordLine(brief)}`;
    maxTokens = 1400;
  } else if (mode === 'meta') {
    expectJson = true;
    temperature = 0.4;
    maxTokens = 300;
    userMsg = `For an article titled "${title || topic}" (topic: ${topic}, primary keyword: ${brief.primary_keyword || ''}), output STRICT JSON only: {"meta_title":"<=60 chars, includes primary keyword","meta_description":"<=155 chars, earns the click"}`;
  } else { // section
    const section = body.section || {};
    if (!section.h2) return { statusCode: 400, headers, body: JSON.stringify({ error: 'section.h2 required for mode=section' }) };
    const priorSummary = (body.prior_sections_summary || '').trim();
    const h3s = Array.isArray(section.h3) ? section.h3 : [];
    const points = Array.isArray(section.key_points) ? section.key_points : [];
    userMsg = `Write ONE section of the article "${title || topic}".\n\nSection heading (render as "## ${section.h2}"): ${section.h2}` +
      (h3s.length ? `\nSub-sections (render each as "### "): ${h3s.join(' | ')}` : '') +
      (points.length ? `\nKey points to cover: ${points.map((p) => '• ' + p).join('  ')}` : '') +
      (priorSummary ? `\n\nWhat earlier sections already covered (do NOT repeat): ${priorSummary}` : '') +
      keywordLine(brief) + linkLine(brief) +
      `\n\nWrite the "## ${section.h2}" heading and its body only. 150-350 words. No intro/outro framing.`;
    maxTokens = 1400;
  }

  try {
    const res = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: BLOG_MODEL,
        max_tokens: maxTokens,
        thinking: { type: 'disabled' }, // sonnet-5 rejects `temperature`; keep this a plain completion
        system,
        messages: [{ role: 'user', content: userMsg }]
      })
    });
    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, headers, body: JSON.stringify({ error: data.error?.message || `Claude API ${res.status}`, type: data.error?.type }) };
    }
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

    if (expectJson) {
      let meta;
      try { meta = extractJson(text); }
      catch (e) { return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not parse meta JSON', detail: e.message }) }; }
      return { statusCode: 200, headers, body: JSON.stringify({ agent: 'blog-draft', mode, meta, usage: data.usage }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({
      agent: 'blog-draft',
      mode,
      markdown: text,
      usage: data.usage,
      completed_at: new Date().toISOString()
    }) };
  } catch (e) {
    console.error('[blog-draft]', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
