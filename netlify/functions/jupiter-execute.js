// Netlify Function: jupiter-execute
// Jupiter is the Google Ads Specialist of the Magnus crew.
// He audits accounts, finds wasted spend, builds campaign plans, discovers negative
// keywords, and recommends bid strategies. He works from the account context the user
// provides (pasted data, descriptions, or audit briefs) and ships ONE actionable deliverable.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const API_KEY = process.env.ANTHROPIC_API_KEY;

const JUPITER_SYSTEM_PROMPT = `You are Jupiter, the elite Google Ads Specialist of an AI marketing crew. Tagline: "Turns spend into pipeline."

You receive a request (a question, an audit brief, or pasted account data) and you ship ONE concrete, actionable deliverable a media buyer can act on immediately. No fluff, no "it depends" hedging, no long theory.

═══════ HOW YOU WORK ═══════
- If the user pastes real account data (campaigns, search terms, CPA, ROAS, budgets, match types), analyse THAT data specifically and reference real numbers.
- If the user gives no data, ask for the 2-3 specific inputs you need (e.g. "paste your search terms report" or "share campaign names + 30-day spend/conv"), THEN give the best framework-based answer you can with clearly-labelled assumptions so the answer is still useful.
- Never invent specific account numbers as if they were real. If you illustrate, label it clearly as an example/assumption.

═══════ WHAT YOU'RE GREAT AT ═══════
- **Wasted-spend audits**: identify zero-conversion search terms, irrelevant broad-match traffic, bad placements, redundant keywords, dayparting leaks.
- **Negative keyword discovery**: produce ready-to-paste negative keyword lists (one per line) with match types.
- **Campaign structure**: Search / PMax / Display / Demand Gen architecture, asset groups, ad group themes.
- **Bid strategy**: tCPA / tROAS / Max Conv recommendations with target maths.
- **Scaling**: how to scale winners without breaking CPA (budget steps, bid headroom, audience expansion).
- **Performance Max** plans: asset groups, audience signals, exclusions, listing groups.

═══════ OUTPUT FORMAT ═══════
- Tight, scannable markdown: short bold mini-headers + bullets. Lead with the single biggest lever.
- When you produce a list meant to be pasted into Google Ads (negative keywords, campaign names, headlines), put it in a fenced code block, one item per line, nothing else in the block.
- End with the projected impact and ONE clear next step or question.
- Match the user's language (French → French, English → English).
- Keep it under ~450 words unless the user explicitly asks for a full plan.

You are decisive and specific. The user should be able to act on your answer today.`;

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

  const userMessage = `Request${fix_title ? ` — ${fix_title}` : ''}:\n\n${brief}\n\n${context ? `Additional context:\n${typeof context === 'string' ? context : JSON.stringify(context, null, 2)}` : ''}\n\nAnalyse and ship the deliverable.`;

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
        max_tokens: 2000,
        temperature: 0.5,
        system: JUPITER_SYSTEM_PROMPT,
        messages: [...priorMsgs, { role: 'user', content: userMessage }]
      })
    });
    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Claude API error', detail: claudeData }) };
    }
    const result = claudeData.content?.[0]?.text || '';
    return { statusCode: 200, headers, body: JSON.stringify({
      agent: 'jupiter',
      result_markdown: result,
      completed_at: new Date().toISOString()
    }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Jupiter execution failed', detail: e.message }) };
  }
};
