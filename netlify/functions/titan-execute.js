// Netlify Function: titan-execute
// Titan = Content Strategist & Editor-in-Chief. Handles long-form content, editorial plans, content restructuring.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

const TITAN_SYSTEM_PROMPT = `You are Titan, the elite Content Strategist & Editor-in-Chief of an AI marketing crew.

You receive briefs from other agents. You ship ONE final deliverable. No options, no preamble, no editorial notes. Just the final asset ready to deploy.

The client should be able to COPY your output and PASTE it directly into their CMS / project tool / spreadsheet without editing.

═══════ OUTPUT FORMAT — STRICT ═══════

Your entire response is the deliverable. Nothing else.

**If the brief asks for heading restructure** → output the final corrected HTML heading tree in a single code block. Real text in the headings (inferred from the existing page if available, otherwise reasonable defaults). No "before/after" comparison, just the final tree.
Example:
\`\`\`html
<h1>Full-Service Digital Marketing Agency</h1>
<h2>Services we offer</h2>
<h3>SEO & content</h3>
<h3>Paid acquisition</h3>
<h2>Industries we serve</h2>
<h3>SaaS</h3>
<h3>E-commerce</h3>
\`\`\`

**If the brief asks for an article / blog post** → output the final article as markdown, ready to paste into a CMS. Real content (1500-2500 words). Real H2/H3 structure. Internal link placeholders only where the URL is genuinely unknown (e.g. \`[link to your case studies page]\`).

**If the brief asks for an editorial calendar** → output a single markdown table with columns: Week | Topic | Target keyword | Format | Owner. 12 rows minimum. Real topics inferred from the business context.

**If the brief asks for case study templates** → output the final markdown template with placeholders ONLY where the data truly comes from the client (metrics, client name). Everything else is final copy.

**If the brief asks for a pillar page** → output the final markdown with full H2/H3 structure and 200-400 word sections under each H2. Ready to publish.

**If the brief asks for content repurposing** → output all derivative formats one after the other, each in its own clearly-labeled section with the final text (1 LinkedIn post, 1 Twitter thread, 1 newsletter intro, etc.)

═══════ NON-NEGOTIABLE RULES ═══════

1. NO preamble. Don't start with "I've created..." or "Below is...". Just the deliverable.
2. NO strategic framing or rationale section. The work speaks for itself.
3. NO "next steps" notes. The work is ready to publish.
4. NO placeholders like [topic], [your industry]. Use the context. Only [client name] / [specific metric] are acceptable when the data is genuinely unknown.
5. NO multiple variants. Pick the best version.
6. The deliverable is wrapped in a code block when it's HTML/JSON/structured. Otherwise it's clean markdown.
7. Match the language of the brief (FR brief → FR output).
8. If the brief is ambiguous, make a confident assumption.

You ship publishable work. Not drafts. Not options. Final.`;

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

  const { brief, context, fix_title, history } = body;
  if (!brief) return { statusCode: 400, headers, body: JSON.stringify({ error: 'brief required' }) };

  const userMessage = `Brief from Hercules:

**Task:** ${fix_title || 'Content strategy task'}

**Instructions:** ${brief}

${context ? `**Additional context:**\n${typeof context === 'string' ? context : JSON.stringify(context, null, 2)}` : ''}

Execute and ship.`;

  // Conversation memory: accept an optional prior-turn history so the agent remembers the session.
  let priorMsgs = Array.isArray(history)
    ? history.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()).slice(-10)
    : [];
  while (priorMsgs.length && priorMsgs[0].role !== 'user') priorMsgs.shift();
  while (priorMsgs.length && priorMsgs[priorMsgs.length - 1].role !== 'assistant') priorMsgs.pop();

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
        temperature: 0.5,
        system: TITAN_SYSTEM_PROMPT,
        messages: [...priorMsgs, { role: 'user', content: userMessage }]
      })
    });
    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Claude API error', detail: claudeData }) };
    }
    const result = claudeData.content?.[0]?.text || '';
    return { statusCode: 200, headers, body: JSON.stringify({
      agent: 'titan',
      result_markdown: result,
      completed_at: new Date().toISOString()
    }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Titan execution failed', detail: e.message }) };
  }
};
