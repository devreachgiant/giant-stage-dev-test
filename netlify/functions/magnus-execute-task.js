// Netlify Function: magnus-execute-task
// Executes a single task from a Magnus mission by dispatching to the right specialist function.
// Reads the mission row, finds the task by id, calls the right backend (atlas-execute, titan-execute,
// vulcan-image, hercules-url-audit, hercules-geo-audit), stores the result back in results_json.

// Defensive helper: read response as text, then try JSON parse. Returns { ok, data, rawText }.
async function readJsonSafely(res) {
  const rawText = await res.text();
  if (!rawText) return { ok: false, data: null, rawText: '', error: 'empty body' };
  try { return { ok: true, data: JSON.parse(rawText), rawText }; }
  catch (e) {
    // If the response looks like HTML, it's likely a Netlify timeout/error page
    const looksHtml = rawText.trim().startsWith('<');
    return { ok: false, data: null, rawText, error: looksHtml ? 'backend returned HTML (likely a timeout)' : 'non-JSON response' };
  }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase env vars not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  // The frontend doesn't pass mission_id explicitly — it passes task_id (the "t1", "t2" string) plus
  // an optional brand_kit object. We need to look up the most recent running mission that has this task.
  // (Simpler approach: the frontend should pass mission_id; we do that fallback if it does, otherwise
  //  we find by task id in the most recent running mission.)
  const taskId = body.task_id;
  const brandKit = body.brand_kit || null;
  let missionId = body.mission_id || null;
  if (!taskId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'task_id required' }) };

  // Locate the mission
  let mission;
  try {
    let url;
    if (missionId) {
      url = `${SUPABASE_URL}/rest/v1/magnus_missions?id=eq.${missionId}&select=*`;
    } else {
      // Fallback: most recent running mission
      url = `${SUPABASE_URL}/rest/v1/magnus_missions?status=eq.running&order=created_at.desc&limit=1&select=*`;
    }
    const sbRes = await fetch(url, {
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
    });
    const rows = await sbRes.json();
    if (!sbRes.ok || !Array.isArray(rows) || !rows[0]) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Mission not found' }) };
    }
    mission = rows[0];
    missionId = mission.id;
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase read failed', detail: e.message }) };
  }

  const task = (mission.plan_json || []).find(t => t.id === taskId);
  if (!task) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: `Task ${taskId} not in mission plan` }) };
  }

  // Build the base function URL — prefer Netlify's automatic URL env, fallback to event headers
  const baseUrl = process.env.URL || process.env.DEPLOY_URL || (`https://${event.headers.host || event.headers.Host || ''}`);
  if (!baseUrl || baseUrl === 'https://') {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not determine base URL for internal function calls' }) };
  }

  // Dispatch to the right specialist
  let outputData = null;
  let outputSummary = '';
  let taskError = null;
  try {
    // Helper: when a Vulcan task runs, look for a brand_kit that was extracted
    // by an earlier brand_extract task in the same mission, and use it if no
    // explicit brandKit is passed in this call.
    const extractedBrandKit = (() => {
      const results = mission.results_json || {};
      for (const tid of Object.keys(results)) {
        const r = results[tid];
        if (r?.status === 'done' && r?.output_data?.brand_kit) return r.output_data.brand_kit;
      }
      return null;
    })();

    if (task.agent === 'atlas') {
      const r = await fetch(`${baseUrl}/.netlify/functions/atlas-execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: task.brief, context: task.context, fix_title: task.title })
      });
      const parsed = await readJsonSafely(r);
      if (!r.ok || !parsed.ok || parsed.data?.error) throw new Error(parsed.data?.error || parsed.error || `Atlas HTTP ${r.status}`);
      outputData = { result: parsed.data.result_markdown || parsed.data.result || parsed.data.output || parsed.data.deliverable || '' };
      outputSummary = 'Copy delivered';
    } else if (task.agent === 'titan') {
      const r = await fetch(`${baseUrl}/.netlify/functions/titan-execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: task.brief, context: task.context, fix_title: task.title })
      });
      const parsed = await readJsonSafely(r);
      if (!r.ok || !parsed.ok || parsed.data?.error) throw new Error(parsed.data?.error || parsed.error || `Titan HTTP ${r.status}`);
      outputData = { result: parsed.data.result_markdown || parsed.data.result || parsed.data.output || parsed.data.deliverable || '' };
      outputSummary = 'Content delivered';
    } else if (task.agent === 'vulcan') {
      // Pick the brand_kit to use: explicit param > extracted from URL > task context > none
      const effectiveBrandKit = brandKit || extractedBrandKit || (task.context && task.context.brand_kit) || undefined;
      const r = await fetch(`${baseUrl}/.netlify/functions/vulcan-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brief: task.brief,
          count: 1,
          platform: (task.context && task.context.platform) || 'instagram_feed',
          brand_kit: effectiveBrandKit
        })
      });
      const parsed = await readJsonSafely(r);
      if (!r.ok || !parsed.ok || parsed.data?.error) throw new Error(parsed.data?.error || parsed.error || `Vulcan HTTP ${r.status}`);
      outputData = { posts: parsed.data.posts || [], campaign_summary: parsed.data.campaign_summary };
      outputSummary = (parsed.data.posts?.[0]?.concept || 'Image generated');
    } else if (task.agent === 'hercules_url_audit') {
      const targetUrl = task.context?.target_url || mission.target_url;
      if (!targetUrl) throw new Error('No target_url for Hercules URL audit');
      const r = await fetch(`${baseUrl}/.netlify/functions/hercules-url-audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl })
      });
      const parsed = await readJsonSafely(r);
      if (!r.ok || !parsed.ok || parsed.data?.error) throw new Error(parsed.data?.error || parsed.error || `Hercules HTTP ${r.status} on URL ${targetUrl}`);
      outputData = { fixes: parsed.data.fixes || [], audit: parsed.data.audit || '', signals: parsed.data.signals || {}, target_url: targetUrl };
      outputSummary = `${(parsed.data.fixes || []).length} fix(es) identified`;
    } else if (task.agent === 'hercules_geo_audit') {
      const targetUrl = task.context?.target_url || mission.target_url;
      if (!targetUrl) throw new Error('No target_url for Hercules GEO audit');
      const r = await fetch(`${baseUrl}/.netlify/functions/hercules-geo-audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl })
      });
      const parsed = await readJsonSafely(r);
      if (!r.ok || !parsed.ok || parsed.data?.error) throw new Error(parsed.data?.error || parsed.error || `Hercules GEO HTTP ${r.status} on URL ${targetUrl}`);
      outputData = { fixes: parsed.data.fixes || [], audit: parsed.data.audit || '', target_url: targetUrl, score: parsed.data.score, competitors: parsed.data.competitors || [], generated_prompts: parsed.data.generated_prompts || [] };
      outputSummary = `GEO audit: ${(parsed.data.fixes || []).length} fix(es)`;
    } else if (task.agent === 'brand_extract') {
      const targetUrl = task.context?.target_url || mission.target_url;
      if (!targetUrl) throw new Error('No target_url for brand extraction');
      const r = await fetch(`${baseUrl}/.netlify/functions/magnus-extract-brand`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl })
      });
      const parsed = await readJsonSafely(r);
      if (!r.ok || !parsed.ok || parsed.data?.error) throw new Error(parsed.data?.error || parsed.error || `Brand extract HTTP ${r.status} on URL ${targetUrl}`);
      outputData = { brand_kit: parsed.data.brand_kit || {}, target_url: targetUrl };
      const bk = parsed.data.brand_kit || {};
      const colorCount = [bk.color_primary, bk.color_secondary, bk.color_accent].filter(Boolean).length;
      outputSummary = `Brand kit: ${colorCount} color${colorCount===1?'':'s'}${bk.font_headline ? ', ' + bk.font_headline : ''}${bk.tone ? ', ' + bk.tone.slice(0, 30) : ''}`;
    } else {
      throw new Error(`Unknown agent: ${task.agent}`);
    }
  } catch (e) {
    taskError = e.message || 'task failed';
  }

  // Persist the result back into the mission row
  try {
    const currentResults = mission.results_json || {};
    currentResults[taskId] = taskError
      ? { status: 'failed', error: taskError, completed_at: new Date().toISOString() }
      : { status: 'done', output_data: outputData, output_summary: outputSummary, completed_at: new Date().toISOString() };
    await fetch(`${SUPABASE_URL}/rest/v1/magnus_missions?id=eq.${missionId}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ results_json: currentResults })
    });
  } catch (e) { /* non-fatal */ }

  if (taskError) {
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'failed', error: taskError, task_id: taskId }) };
  }
  return { statusCode: 200, headers, body: JSON.stringify({
    status: 'done',
    task_id: taskId,
    output_data: outputData,
    output_summary: outputSummary
  }) };
};
