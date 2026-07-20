// Netlify Function: magnus-router
// Classifies follow-up messages in the Magnus chat AFTER a mission has run.
// Decides between: new_brief (run a new mission), chat (just respond), or regenerate (rerun a task).

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

const ROUTER_SYSTEM = `You are Magnus, Crew Lead. The user has an active mission you already delivered. They just sent you a follow-up message. Decide what to do.

Output ONLY a single JSON object (no markdown fences, no preamble):

{
  "action": "new_brief" | "chat" | "regenerate",
  "message": "your response in markdown (concise — max 4 short lines)",
  "brief": "<only if action=new_brief: the cleaned-up brief to run as a new mission>",
  "task_id": "<only if action=regenerate: the id of the task to rerun (e.g. 't2')>",
  "task_brief_override": "<only if action=regenerate: a tweaked brief to use this time, or null>"
}

How to decide:

- **new_brief** — the user is asking for something genuinely NEW (a separate launch, different brand, additional deliverables in a new direction). Example: "Now do the same for our winter collection" → new_brief. Example: "Also add a TikTok script" → if the original mission was for Instagram only, this is a new_brief expanding scope.

- **chat** — the user asks a question about the mission, wants feedback, asks why something looks a certain way, or is making conversational remarks. Example: "What do you think of the second post?" → chat. Example: "How long did the audit take?" → chat. Example: "I love the first post!" → chat (thank them, ask if they want more variants).

- **regenerate** — the user wants you to RE-RUN one of the existing tasks (with optional tweaks). Example: "I don't have the second post" → regenerate the 2nd vulcan task. Example: "Redo post 2 with a darker palette" → regenerate the 2nd vulcan task with tweak. Example: "Can you make the meta title shorter?" → regenerate the atlas task with tweak.

To pick task_id for regenerate: look at the mission's task list (provided in the user context). Match the user's intent ("the second post" → the 2nd vulcan task in order; "the meta title" → the atlas task with that title; "the audit" → the hercules task). If genuinely ambiguous, pick the most recent task of that type. The task_id values are the stable ids from the plan ("t1", "t2", ...).

The "message" field is what the user sees. Be confident and brief — Magnus the Crew Lead, not chatty. Match the brief language (FR brief → FR; EN brief → EN).`;

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

  try {
    return await inner(event, headers);
  } catch (e) {
    console.error('[magnus-router] crash:', e?.stack || e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Magnus router crashed', detail: (e && e.message) || String(e) }) };
  }
};

async function inner(event, headers) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const userMessage = (body.user_message || '').trim();
  const mission = body.mission || null; // { brief, tasks[], results_map }
  if (!userMessage) return { statusCode: 400, headers, body: JSON.stringify({ error: 'user_message required' }) };

  // If there's no active mission, this is automatically a new_brief
  if (!mission || !Array.isArray(mission.tasks) || mission.tasks.length === 0) {
    return { statusCode: 200, headers, body: JSON.stringify({
      action: 'new_brief',
      message: '',
      brief: userMessage
    }) };
  }

  // Build a compact mission summary for Claude
  const taskList = mission.tasks.map(t => {
    const r = (mission.results_map || {})[t.id] || {};
    return `- ${t.id} (${t.agent}): "${t.title}" — status: ${r.status || 'unknown'}${r.output_summary ? ' — ' + r.output_summary : ''}`;
  }).join('\n');

  const userMsg = `Original mission brief:\n${mission.brief}\n\nTasks executed:\n${taskList}\n\nUser's follow-up message:\n"${userMessage}"\n\nDecide what to do and output the JSON.`;

  let parsed;
  try {
    const res = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1000,
        temperature: 0.4,
        system: ROUTER_SYSTEM,
        messages: [{ role: 'user', content: userMsg }]
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Claude HTTP ${res.status}`);
    let text = data.content?.[0]?.text || '';
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const first = text.indexOf('{'), last = text.lastIndexOf('}');
    if (first === -1 || last === -1) throw new Error('No JSON in router response. Raw: ' + text.slice(0, 200));
    parsed = JSON.parse(text.slice(first, last + 1));
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Router failed', detail: e.message }) };
  }

  // Sanity-check the action
  if (!['new_brief', 'chat', 'regenerate'].includes(parsed.action)) {
    parsed.action = 'chat';
  }
  // If regenerate but no matching task_id, fall back to chat
  if (parsed.action === 'regenerate') {
    const validIds = mission.tasks.map(t => t.id);
    if (!validIds.includes(parsed.task_id)) {
      parsed.action = 'chat';
      parsed.message = (parsed.message || '') + `\n\n_(I couldn't match a specific task to regenerate — could you tell me which one?)_`;
    }
  }

  return { statusCode: 200, headers, body: JSON.stringify(parsed) };
}
