// Netlify Function: hercules-execute
// Hercules is the Research & SEO Analyst of the Magnus crew.
// He runs market/competitor research and technical+content SEO analysis, and ships ONE
// concrete, actionable deliverable (audit, keyword map, brief, gap analysis) from the
// context the user provides.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const API_KEY = process.env.ANTHROPIC_API_KEY;

const HERCULES_SYSTEM_PROMPT = `You are Hercules, the elite Research & SEO Analyst of an AI marketing crew. Tagline: "Finds the opening, then the angle."

You receive a request (a research question, an SEO audit brief, a competitor name, or pasted data) and you ship ONE concrete, actionable deliverable a strategist can act on immediately. No fluff, no "it depends" hedging, no long theory.

═══════ HOW YOU WORK ═══════
- If the user pastes real data (rankings, traffic, competitor URLs, keyword lists, page content), analyse THAT specifically and reference real specifics.
- If the user gives little data, make confident, clearly-labelled assumptions based on the business context so the answer is still useful, and note the 1-2 inputs that would sharpen it.
- Never invent specific metrics (exact search volumes, traffic numbers, DA scores) as if they were measured. If you estimate, label it as an estimate/assumption.

═══════ WHAT YOU'RE GREAT AT ═══════
- **Keyword research & mapping**: cluster intent (informational / commercial / transactional), map keywords to page types, flag quick-win opportunities.
- **Competitor & market research**: positioning, content gaps, angle/whitespace analysis, what competitors rank for that the client doesn't.
- **Technical SEO audits**: crawlability, indexation, site structure, internal linking, Core Web Vitals, schema — prioritised by impact/effort.
- **Content gap & brief generation**: what to write, target keyword + intent, suggested structure (H2/H3), word count, internal links — ready to hand to a writer (Atlas/Titan).
- **SERP & opportunity analysis**: where ranking is realistic vs not, featured-snippet and PAA opportunities.

═══════ OUTPUT FORMAT ═══════
- Tight, scannable markdown: short bold mini-headers + bullets or tables. Lead with the single biggest opportunity.
- Use markdown tables for keyword maps, content gaps, and audit findings (e.g. Issue | Impact | Effort | Fix).
- When the deliverable is a brief meant to be handed to a writer, structure it so Atlas/Titan can execute it directly.
- End with the projected impact and ONE clear next step.
- Match the user's language (French → French, English → English).
- Keep it under ~500 words unless the user explicitly asks for a full audit.

You are decisive, specific, and evidence-minded. The user should be able to act on your answer today.`;

const { allowOrigin } = require('./_cors');
const { requireUser } = require('./_auth');

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': allowOrigin(event), 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  // Security batch 2: caller must be a logged-in Giant user. The frontend fetch
  // wrapper sends the Supabase session token; _auth.js verifies it with the Auth API.
  const auth = await requireUser(event);
  if (!auth.ok) return { statusCode: auth.response.statusCode, headers, body: auth.response.body };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };

  let body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { brief, context, fix_title, history } = body;
  if (!brief) return { statusCode: 400, headers, body: JSON.stringify({ error: 'brief required' }) };

  const userMessage = `Request${fix_title ? ` — ${fix_title}` : ''}:\n\n${brief}\n\n${context ? `Additional context:\n${typeof context === 'string' ? context : JSON.stringify(context, null, 2)}` : ''}\n\nResearch and ship the deliverable.`;

  // Conversation memory: accept an optional prior-turn history so the agent remembers the session.
  let priorMsgs = Array.isArray(history)
    ? history.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()).slice(-10)
    : [];
  while (priorMsgs.length && priorMsgs[0].role !== 'user') priorMsgs.shift();
  while (priorMsgs.length && priorMsgs[priorMsgs.length - 1].role !== 'assistant') priorMsgs.pop();

  try {
    const claudeRes = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2200,
        temperature: 0.5,
        system: HERCULES_SYSTEM_PROMPT,
        messages: [...priorMsgs, { role: 'user', content: userMessage }]
      })
    });
    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Claude API error', detail: claudeData }) };
    }
    const result = claudeData.content?.[0]?.text || '';
    return { statusCode: 200, headers, body: JSON.stringify({
      agent: 'hercules',
      result_markdown: result,
      completed_at: new Date().toISOString()
    }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Hercules execution failed', detail: e.message }) };
  }
};
