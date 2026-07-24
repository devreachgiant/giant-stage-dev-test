// Netlify Function: blog-research
// Step 1 of the Blog Content Agent. Turns a topic (+ client/brand context) into a
// structured content brief using semantic-SEO principles: search intent, primary +
// secondary + semantic keywords, an FAQ set of likely real user questions, an H2/H3
// outline, suggested internal/external links, and meta title/description.
//
// v1 does the keyword/FAQ/intent work with Claude's own knowledge. Real Ahrefs
// volume/difficulty enrichment plugs in at enrichWithAhrefs() once a key is wired —
// the frontend + rest of the pipeline don't change when it does.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const BLOG_MODEL = 'claude-sonnet-5'; // content model for the blog agent

const { allowOrigin } = require('./_cors');
const { requireUser } = require('./_auth');
const { brandVoiceContext, extractJson } = require('./_brand');

const SYSTEM_PROMPT = `You are an elite SEO content strategist who builds content briefs a specialist writer can execute without guesswork. You apply SEMANTIC SEO: you cover a topic's full entity/subtopic space, match the searcher's intent, and target terms worth ranking for — not keyword stuffing.

Given a topic, a content type, and a specific client's brand context, produce a brief that:
1. Classifies SEARCH INTENT (informational / commercial / transactional / navigational) and states, in one line, what the searcher actually wants — then commit the whole brief to serving that.
2. Picks ONE primary keyword (the head term), a set of SECONDARY keywords (close variants / subtopics), and SEMANTIC keywords (entities and related terms Google expects to see for topical authority).
3. Builds an FAQ set from the kind of real questions people ask on Google autosuggest, Reddit, and Quora for this topic — phrased the way a real person would ask, with a concise correct answer.
4. Produces a logical H2/H3 OUTLINE that fully covers the intent, with 2-4 key points per section so the writer knows what to say.
5. Suggests INTERNAL links (to the client's own key pages/services — infer sensible ones from their site/services) and EXTERNAL links (to the TYPE of authoritative, non-competitor source to cite).
6. Writes a meta_title (<= 60 chars) and meta_description (<= 155 chars) that earn the click and include the primary keyword naturally.

For a location_page: center it on {service} in {location} — local intent, proximity, local proof. For a service_page: center on the service, its outcomes, and commercial intent.

OUTPUT — STRICT JSON only, no prose, no code fences:
{
  "search_intent": "informational|commercial|transactional|navigational — one-line explanation",
  "primary_keyword": "string",
  "secondary_keywords": ["string"],
  "semantic_keywords": ["string"],
  "faqs": [{"q": "real user question", "a": "concise answer"}],
  "outline": [{"h2": "string", "h3": ["string"], "key_points": ["string"]}],
  "internal_links": [{"anchor": "string", "target": "which client page/topic"}],
  "external_links": [{"anchor": "string", "target": "type of authoritative source"}],
  "meta_title": "<= 60 chars",
  "meta_description": "<= 155 chars",
  "recommended_word_count": 1200
}
Escape all quotes and newlines so the JSON parses.`;

// Seam for real keyword data (Ahrefs volume/difficulty, SERP FAQs). v1: no-op.
// When wired, look up brief.primary_keyword + secondary_keywords, attach
// {volume, difficulty} per term, and optionally reorder by opportunity.
async function enrichWithAhrefs(brief) {
  // if (process.env.AHREFS_API_KEY) { ... attach metrics ... }
  return brief;
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

  const topic = (body.topic || '').trim();
  if (!topic) return { statusCode: 400, headers, body: JSON.stringify({ error: 'topic required' }) };
  const contentType = ['blog', 'location_page', 'service_page'].includes(body.content_type) ? body.content_type : 'blog';
  const notes = (body.notes || '').trim();
  const target = (body.target || '').trim(); // e.g. "Plumbing in Austin, TX" for location/service pages
  const ctx = brandVoiceContext({ kit: body.brand_kit, client: body.client, guidelines: body.guidelines });

  const typeLine = contentType === 'blog'
    ? 'Content type: blog post.'
    : `Content type: ${contentType.replace('_', ' ')}${target ? ` — target: ${target}` : ''}.`;
  const userMsg = `Topic: ${topic}\n${typeLine}${notes ? `\nExtra notes from the strategist: ${notes}` : ''}${ctx}\n\nProduce the content brief now as strict JSON.`;

  try {
    const res = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: BLOG_MODEL,
        max_tokens: 2600,
        thinking: { type: 'disabled' }, // sonnet-5 rejects `temperature`; keep this a plain, all-output-token completion so the JSON brief isn't truncated by adaptive thinking
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }]
      })
    });
    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, headers, body: JSON.stringify({ error: data.error?.message || `Claude API ${res.status}`, type: data.error?.type }) };
    }
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    let brief;
    try { brief = extractJson(text); }
    catch (e) { return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not parse brief JSON', detail: e.message }) }; }

    brief = await enrichWithAhrefs(brief);

    return { statusCode: 200, headers, body: JSON.stringify({
      agent: 'blog-research',
      content_type: contentType,
      brief,
      usage: data.usage,
      completed_at: new Date().toISOString()
    }) };
  } catch (e) {
    console.error('[blog-research]', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
