// Netlify Function: magnus-synthesize
// Once all tasks in a mission are done (or failed), Magnus writes the final summary for the client.
// Reads results_json from the mission, asks Claude to produce a clean, client-ready closing message.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

const SYNTHESIZE_SYSTEM = `You are Magnus, the Crew Lead. The crew just finished a mission for the client. Write the final closing message FROM Magnus TO the client.

Tone: confident, calm, friendly-professional. The crew lead reporting back. Concise.

═══════ CRITICAL GROUNDING RULES (read carefully) ═══════
- Only state what the crew ACTUALLY delivered, based on the task details provided below. NEVER invent findings, metrics, competitors, or conclusions that aren't in the details.
- VOCABULARY — do not get this wrong:
  • "GEO audit" = Generative Engine Optimization: how visible the site is INSIDE AI answer engines (ChatGPT, Claude, Perplexity). It has NOTHING to do with geography, geographic markets, or global positioning. NEVER describe a GEO audit as "geographic" or "well-positioned globally".
  • "SEO audit" = technical / on-page search optimization.
- A low fix count does NOT mean the site is "perfect", "solid", or "flawless". If few or zero fixes were produced, just describe what was delivered plainly — do not editorialize the site as issue-free.
- Use the fix counts and titles given to you. If a GEO visibility score is provided, report it honestly (a low score is the normal, useful finding — don't soften it into praise).

Structure (markdown):
- 1 line saying what was delivered (count of deliverables, who contributed)
- A short bulleted list (3-6 bullets) of what's in their hands now, one bullet per agent/deliverable
- 1-2 closing lines: any caveat (failed tasks if any), what they should do next (review the deliverables on the right, etc.)

Keep it under 8 lines total. Match the brief's language (FR brief → FR summary).`;

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

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!ANTHROPIC_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const missionId = body.mission_id;
  if (!missionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'mission_id required' }) };

  // Read the mission
  let mission;
  try {
    const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/magnus_missions?id=eq.${missionId}&select=*`, {
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
    });
    const rows = await sbRes.json();
    if (!sbRes.ok || !Array.isArray(rows) || !rows[0]) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Mission not found' }) };
    }
    mission = rows[0];
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase read failed', detail: e.message }) };
  }

  // Build a compact summary of what was done
  const tasks = mission.plan_json || [];
  const results = mission.results_json || {};
  const AGENT_DESC = {
    hercules_url_audit: 'Technical/on-page SEO audit',
    hercules_geo_audit: 'GEO audit = Generative Engine Optimization (visibility inside AI answer engines; NOT geography)',
    titan: 'Long-form content / editorial deliverable',
    atlas: 'Copywriting deliverable',
    vulcan: 'Visual / image deliverable',
    brand_extract: 'Brand kit extraction'
  };
  const taskSummaries = tasks.map(t => {
    const r = results[t.id] || { status: 'missing' };
    const od = r.output_data || {};
    let detail = r.output_summary || r.error || '';
    if (t.agent === 'hercules_url_audit' || t.agent === 'hercules_geo_audit') {
      const fixCount = (od.fixes || []).length;
      const topTitles = (od.fixes || []).slice(0, 3).map(f => f && f.title).filter(Boolean);
      const bits = [`${fixCount} actionable fix(es) generated`];
      if (t.agent === 'hercules_geo_audit' && typeof od.score === 'number') bits.push(`AI-search visibility score ${od.score}/100`);
      if (topTitles.length) bits.push('top fixes: ' + topTitles.join('; '));
      detail = bits.join(' — ');
    } else if ((t.agent === 'titan' || t.agent === 'atlas') && od.result) {
      const firstLine = String(od.result).split('\n').map(l => l.trim()).find(Boolean) || '';
      detail = 'deliverable shipped — opens with: ' + firstLine.replace(/[#*`>|]/g, '').trim().slice(0, 90);
    }
    return { agent: t.agent, agent_desc: AGENT_DESC[t.agent] || t.agent, title: t.title, status: r.status || 'unknown', detail };
  });
  const allDone = taskSummaries.every(t => t.status === 'done');
  const anyFailed = taskSummaries.some(t => t.status === 'failed');

  // Ask Claude to write the final summary
  let finalSummary;
  try {
    const userMsg = `Original client brief: ${mission.brief}\n\nTasks executed (with what each one actually is + what was delivered):\n${taskSummaries.map(t => `- [${t.status}] ${t.title}\n    type: ${t.agent_desc}\n    result: ${t.detail || 'n/a'}`).join('\n')}\n\nWrite the closing message to the client. Ground every statement in the results above — do not invent anything.`;
    const res = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 600,
        temperature: 0.6,
        system: SYNTHESIZE_SYSTEM,
        messages: [{ role: 'user', content: userMsg }]
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Claude failed');
    finalSummary = (data.content?.[0]?.text || '').trim();
  } catch (e) {
    finalSummary = `Mission complete. ${taskSummaries.filter(t => t.status === 'done').length}/${taskSummaries.length} task(s) delivered. Review the deliverables on the right.`;
  }

  // Persist
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/magnus_missions?id=eq.${missionId}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        final_summary: finalSummary,
        status: anyFailed && !allDone ? 'failed' : 'done'
      })
    });
  } catch (e) { /* non-fatal */ }

  return { statusCode: 200, headers, body: JSON.stringify({ final_summary: finalSummary, mission_id: missionId }) };
};
