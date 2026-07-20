// Netlify Function: magnus-plan
// Magnus the Crew Lead reads a client brief and decomposes it into a structured plan of tasks,
// each assigned to the specialist that can ship it (Hercules / Atlas / Titan / Vulcan).
// Saves the mission to Supabase so magnus-execute-task and magnus-synthesize can pick it up later.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

const PLANNER_SYSTEM = `You are Magnus, the Crew Lead of an AI marketing crew. A client just sent you a brief. Decompose it into a tight, deliverable-focused plan that you'll dispatch across 4 specialists.

═══════ YOUR SPECIALISTS ═══════

- **brand_extract** — Brand Synthesizer. Use FIRST when a URL is provided in the brief AND any visual creation task is needed (vulcan tasks). Extracts palette, fonts, tone, and brand voice from the URL so Vulcan can produce on-brand visuals without manual brand kit upload. Input: target_url. Output: a synthetic brand_kit object that downstream Vulcan tasks will automatically use.
- **hercules_url_audit** — SEO/GEO/data research. Use when a URL is provided in the brief and you need an SEO + on-page audit. Input: target_url. Output: audit + structured fixes.
- **hercules_geo_audit** — Generative-Engine Optimization audit (visibility in AI search). Use when the brief is about ranking in AI engines. Input: target_url. Output: GEO audit + fixes.
- **atlas** — Copywriter. Use for meta descriptions, page titles, hero copy, email sequences, ad copy, brand voice docs. Input: a specific brief. Output: deployable HTML/markdown copy.
- **titan** — Content Strategist & Editor-in-Chief. Use for blog articles, heading restructures, editorial calendars, case study templates, pillar pages, content repurposing. Input: a specific brief. Output: deployable markdown/HTML.
- **vulcan** — Designer. Generates real social media post images (with on-image headline) using Nano Banana. Use for Instagram/Facebook/LinkedIn posts, ad creatives. Input: a creative brief + brand kit. Output: PNG image + caption + hashtags.

═══════ RULES ═══════

1. **Be ruthless about scope**: only include tasks the brief explicitly asks for or that are obvious dependencies. Do NOT pad with "nice to have" tasks. Quality > quantity.
2. **Auto-inject brand_extract** as the FIRST task when:
   - A target URL is detected in the brief, AND
   - At least one vulcan task is planned (to produce visuals).
   The brand_extract task gives Vulcan a tailored brand kit derived from the actual website — without it Vulcan would use generic defaults.
3. **Order tasks logically**: brand_extract first (if present), then research/audits (Hercules), then strategy (Titan), then copy (Atlas), then visuals (Vulcan).
4. **Each task brief is self-contained**: each specialist receives this task brief, period. They don't see the full client brief. So include all the context they need.
5. **Hercules tasks** require a target_url. If no URL is given, skip Hercules tasks unless the brief is purely about SEO/auditing the URL provided.
6. **Task count target**: typically 1-6 tasks. A "Generate a social post" brief = 1 Vulcan task (or 2 if a URL is provided: brand_extract + vulcan). A "Launch our new product" brief = 3-6 tasks across the crew.
7. **Match the brief language** (FR brief → FR intro_message + FR task titles).

═══════ OUTPUT — STRICT JSON ═══════

Output ONLY a single valid JSON object, no markdown fences, no preamble:

{
  "intro_message": "2-3 sentence message FROM Magnus TO the client, explaining the plan in plain language.",
  "tasks": [
    {
      "id": "t1",
      "agent": "brand_extract" | "hercules_url_audit" | "hercules_geo_audit" | "atlas" | "titan" | "vulcan",
      "title": "Short task title (3-7 words, no period)",
      "brief": "Self-contained brief for the specialist. Be specific. Include all the context they need from the client brief.",
      "context": { "any_extra_fields": "..." }
    }
  ]
}

The "id" values are stable strings ("t1", "t2", ...). The "context" object can carry the target_url for Hercules/brand_extract tasks, or any additional structured data.`;

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

  // GLOBAL TRY/CATCH — guarantees a JSON body in every case so the frontend never sees "Unexpected end of JSON input"
  try {
    return await innerHandler(event, headers);
  } catch (e) {
    console.error('[magnus-plan] unexpected crash:', e && e.stack || e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Magnus crashed unexpectedly', detail: (e && e.message) || String(e) }) };
  }
};

async function innerHandler(event, headers) {
  console.log('[magnus-plan] start');
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!ANTHROPIC_KEY) {
    console.error('[magnus-plan] ANTHROPIC_API_KEY missing');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured in Netlify env vars' }) };
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[magnus-plan] Supabase env vars missing — URL?', !!SUPABASE_URL, 'KEY?', !!SUPABASE_SERVICE_KEY);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase env vars not configured (SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing)' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON in request' }) };
  }
  const brief = (body.brief || '').trim();
  const targetUrl = body.target_url || null;
  const brandKitId = body.brand_kit_id || null;
  const crewContext = (body.crew_context || '').trim();
  if (!brief) return { statusCode: 400, headers, body: JSON.stringify({ error: 'brief required' }) };

  // Ask Claude to plan
  console.log('[magnus-plan] calling Claude');
  let plan;
  try {
    const userMsg = `Client brief: ${brief}${targetUrl ? `\n\nTarget URL detected in brief: ${targetUrl}` : ''}${brandKitId ? `\n\nThe client has a brand kit selected — pass it through to any Vulcan tasks.` : ''}${crewContext ? `\n\n──────────\n[CREW & WORKSPACE KNOWLEDGE — this is what your crew has already produced and what the workspace knows right now. Use it as the project lead: do NOT re-run audits or re-create designs that already exist, build on prior work, and reference relevant existing items when planning.]\n${crewContext}` : ''}`;
    const res = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2500,
        temperature: 0.4,
        system: PLANNER_SYSTEM,
        messages: [{ role: 'user', content: userMsg }]
      })
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('[magnus-plan] Claude API error:', data);
      throw new Error(data.error?.message || `Claude HTTP ${res.status}`);
    }
    let text = data.content?.[0]?.text || '';
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const first = text.indexOf('{'), last = text.lastIndexOf('}');
    if (first === -1 || last === -1) throw new Error('No JSON in Claude response. Raw: ' + text.slice(0, 200));
    plan = JSON.parse(text.slice(first, last + 1));
    console.log('[magnus-plan] plan with', (plan.tasks || []).length, 'tasks');
  } catch (e) {
    console.error('[magnus-plan] planning failed:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Magnus could not plan the mission', detail: e.message }) };
  }

  // Validate the plan
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  if (tasks.length === 0) {
    // Vague or conversational input (e.g. "ok", "thanks", "hi") — respond conversationally
    // instead of hard-failing, so Magnus simply asks for a concrete goal.
    return { statusCode: 200, headers, body: JSON.stringify({
      intro_message: plan.intro_message || "I'm ready when you are. Give me a concrete goal — a launch, a campaign, an audit, or content to produce — and I'll break it into tasks and dispatch the crew.",
      tasks: [],
      mission_id: null,
      status: 'no_tasks'
    }) };
  }
  tasks.forEach(t => {
    if ((t.agent === 'hercules_url_audit' || t.agent === 'hercules_geo_audit' || t.agent === 'brand_extract') && targetUrl) {
      t.context = t.context || {};
      if (!t.context.target_url) t.context.target_url = targetUrl;
    }
  });

  // Persist the mission
  console.log('[magnus-plan] inserting mission');
  let missionId;
  try {
    const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/magnus_missions`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        brief,
        target_url: targetUrl,
        brand_kit_id: brandKitId,
        intro_message: plan.intro_message || '',
        plan_json: tasks,
        status: 'running'
      })
    });
    const sbText = await sbRes.text();
    if (!sbRes.ok) {
      console.error('[magnus-plan] Supabase insert non-OK:', sbRes.status, sbText.slice(0, 500));
      return { statusCode: 500, headers, body: JSON.stringify({ error: `Supabase insert failed (HTTP ${sbRes.status})`, detail: sbText.slice(0, 400) }) };
    }
    let rows;
    try { rows = JSON.parse(sbText); } catch (e) {
      console.error('[magnus-plan] Supabase response not JSON:', sbText.slice(0, 500));
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase returned non-JSON response', detail: sbText.slice(0, 400) }) };
    }
    if (!Array.isArray(rows) || !rows[0]) {
      console.error('[magnus-plan] Supabase response empty or unexpected:', sbText.slice(0, 500));
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase insert returned no row', detail: sbText.slice(0, 400) }) };
    }
    missionId = rows[0].id;
    console.log('[magnus-plan] mission inserted', missionId);
  } catch (e) {
    console.error('[magnus-plan] Supabase fetch error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase fetch error', detail: e.message }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({
    mission_id: missionId,
    intro_message: plan.intro_message || '',
    tasks
  }) };
}
