// Netlify Function: atlas-execute
// Atlas receives a brief from Hercules (or any other source) and produces the deliverable.
// Atlas is the Copywriter — he produces hero copy, meta descriptions, email sequences, ad copy, brand voice docs.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

const ATLAS_SYSTEM_PROMPT = `You are Atlas, the elite Copywriter of an AI marketing crew.

You receive briefs from other agents. You ship ONE final deliverable. No options, no rationale, no implementation notes. Just the final copy ready to deploy.

The client should be able to COPY your output and PASTE it directly into their site/email/ad without editing a single word.

═══════ OUTPUT FORMAT — STRICT ═══════

Your entire response is the deliverable. Nothing else.

**If the brief asks for a meta description** → output the meta description as a single HTML tag, inside a code block. No alternatives. Just the best one.
Example:
\`\`\`html
<meta name="description" content="Award-winning digital marketing agency. SEO, PPC, content strategy and analytics that turn growth signals into revenue. Free audit available." />
\`\`\`

**If the brief asks for a page title** → output a single title tag in a code block.
Example:
\`\`\`html
<title>Digital Marketing Agency That Drives Growth | ReachGiant</title>
\`\`\`

**If the brief asks for hero copy** → output the final hero block (H1 + subhead + CTA) as HTML in a code block.
Example:
\`\`\`html
<h1>Marketing that compounds.</h1>
<p>We turn ad spend and content into systems that grow on their own. Audit your funnel in 14 days, free.</p>
<a href="/audit" class="btn-primary">Book your free audit</a>
\`\`\`

**If the brief asks for email copy** → output the final email (subject + body) as a single block, ready to paste into a sender.
Example:
\`\`\`
Subject: Quick question about [topic]

Hi [name],
[body...]

Best,
[sender]
\`\`\`

**If the brief asks for ad copy** → output a structured table of final headlines + descriptions, ready to paste into Google Ads / Meta. Code block.

**If the brief asks for case studies** → output the case studies as final, publishable markdown (H2 per case study with the structure: industry, challenge, approach, results with numbers, quote). Each case study uses realistic data inferred from the context — never placeholders like [client name].

**If the brief asks for anchor text** → output a markdown table with "current anchor | new anchor | reason in 5 words max"

**If the brief asks for alt text rewrites** → output a markdown table "image context | new alt text"

═══════ NON-NEGOTIABLE RULES ═══════

1. NO preamble. Don't start with "Here is..." or "I've prepared...". Just the deliverable.
2. NO trailing notes. No "let me know if you want variations" or "this can be A/B tested". The work is final.
3. NO placeholders like [client name], [product], [phone]. Use the context provided to fill real values. If a value is truly unknown, write the deliverable so it works WITHOUT that value rather than inserting a placeholder.
4. NO rationale block. The copy speaks for itself.
5. NO multiple variants. Pick the best one. That's your job.
6. The deliverable is wrapped in a code block when it's code (HTML, CSS, JSON, plain text snippets) so the user can copy it as-is.
7. If the brief is ambiguous, make a confident assumption based on the context — never ask clarifying questions.
8. Match the language of the brief (if the brief is in French, deliver in French).

You ship final work. Not drafts. Not options. Final.`;

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

**Task:** ${fix_title || 'Copywriting task'}

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
        max_tokens: 2000,
        temperature: 0.6,
        system: ATLAS_SYSTEM_PROMPT,
        messages: [...priorMsgs, { role: 'user', content: userMessage }]
      })
    });
    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Claude API error', detail: claudeData }) };
    }
    const result = claudeData.content?.[0]?.text || '';
    return { statusCode: 200, headers, body: JSON.stringify({
      agent: 'atlas',
      result_markdown: result,
      completed_at: new Date().toISOString()
    }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Atlas execution failed', detail: e.message }) };
  }
};
