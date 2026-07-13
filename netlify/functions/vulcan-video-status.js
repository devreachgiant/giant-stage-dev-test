// Netlify Function: vulcan-video-status
// Polls Veo for the status of a long-running operation. When done, downloads the MP4,
// uploads it to Supabase Storage (bucket: vulcan-videos), updates the tracking row,
// and returns the public URL.

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!GEMINI_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const jobId = body.job_id;
  if (!jobId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'job_id required' }) };

  // 1) Read the job row
  let job;
  try {
    const sbGet = await fetch(`${SUPABASE_URL}/rest/v1/vulcan_videos?id=eq.${jobId}&select=*`, {
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
    });
    const rows = await sbGet.json();
    if (!sbGet.ok || !Array.isArray(rows) || !rows[0]) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Job not found' }) };
    }
    job = rows[0];
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase read failed', detail: e.message }) };
  }

  // 2) If already done or failed, short-circuit
  if (job.status === 'done') {
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'done', public_url: job.public_url, job_id: jobId }) };
  }
  if (job.status === 'failed') {
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'failed', error: job.error_message, job_id: jobId }) };
  }

  // 3) Poll Veo
  let opData;
  try {
    const opRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${job.operation_name}`, {
      headers: { 'x-goog-api-key': GEMINI_KEY }
    });
    opData = await opRes.json();
    if (!opRes.ok) {
      const msg = opData.error?.message || 'Veo polling failed';
      await markFailed(jobId, msg, SUPABASE_URL, SUPABASE_SERVICE_KEY);
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'failed', error: msg, job_id: jobId }) };
    }
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Veo poll error', detail: e.message }) };
  }

  // 4) Still running?
  if (!opData.done) {
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'running', job_id: jobId }) };
  }

  // 5) Done — extract the video URI. Veo returns generateVideoResponse.generatedSamples[*].video.uri
  //    The URI is a temporary signed Google file URL that needs the API key appended.
  const samples = opData.response?.generateVideoResponse?.generatedSamples
    || opData.response?.videos
    || opData.response?.generatedSamples
    || [];
  const videoUri = samples[0]?.video?.uri || samples[0]?.uri;
  if (!videoUri) {
    // Decode Veo's content-filter rejection into a clean message
    const filteredReasons = opData.response?.generateVideoResponse?.raiMediaFilteredReasons;
    const filteredCount = opData.response?.generateVideoResponse?.raiMediaFilteredCount;
    let msg;
    if (Array.isArray(filteredReasons) && filteredReasons.length > 0) {
      const raw = String(filteredReasons[0]);
      // The default Veo message is verbose — extract the human-useful part
      if (/real people|likeness|celebrity/i.test(raw)) {
        msg = 'Veo refused: the image or its context contains references to real people, brands, or trademarks. Try regenerating the image with a more abstract subject, or remove brand text on the image before animating.';
      } else if (/violent|gore|disturb/i.test(raw)) {
        msg = 'Veo refused: content moderation flagged the visual as potentially violent or disturbing.';
      } else if (/sex|nudity|explicit/i.test(raw)) {
        msg = 'Veo refused: content moderation flagged the visual as potentially explicit.';
      } else {
        msg = 'Veo refused for content reasons: ' + raw.slice(0, 200);
      }
    } else {
      msg = 'Veo finished but returned no video URI (likely a content filter or quota issue). Try regenerating the image first.';
    }
    await markFailed(jobId, msg, SUPABASE_URL, SUPABASE_SERVICE_KEY);
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'failed', error: msg, job_id: jobId }) };
  }

  // 6) Download the MP4 (need to append API key to the Google URI)
  let videoBuf;
  try {
    const separator = videoUri.includes('?') ? '&' : '?';
    const dlRes = await fetch(`${videoUri}${separator}key=${GEMINI_KEY}`);
    if (!dlRes.ok) {
      const msg = `Video download failed: HTTP ${dlRes.status}`;
      await markFailed(jobId, msg, SUPABASE_URL, SUPABASE_SERVICE_KEY);
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'failed', error: msg, job_id: jobId }) };
    }
    const arrayBuf = await dlRes.arrayBuffer();
    videoBuf = Buffer.from(arrayBuf);
  } catch (e) {
    await markFailed(jobId, e.message, SUPABASE_URL, SUPABASE_SERVICE_KEY);
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'failed', error: e.message, job_id: jobId }) };
  }

  // 7) Upload to Supabase Storage
  const storagePath = `videos/${jobId}.mp4`;
  try {
    const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/vulcan-videos/${storagePath}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'apikey': SUPABASE_SERVICE_KEY,
        'Content-Type': 'video/mp4',
        'x-upsert': 'true'
      },
      body: videoBuf
    });
    if (!upRes.ok) {
      const upText = await upRes.text();
      const msg = `Storage upload failed: ${upRes.status} ${upText.slice(0, 200)}`;
      await markFailed(jobId, msg, SUPABASE_URL, SUPABASE_SERVICE_KEY);
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'failed', error: msg, job_id: jobId }) };
    }
  } catch (e) {
    await markFailed(jobId, e.message, SUPABASE_URL, SUPABASE_SERVICE_KEY);
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'failed', error: e.message, job_id: jobId }) };
  }

  // 8) Build public URL + mark done
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/vulcan-videos/${storagePath}`;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/vulcan_videos?id=eq.${jobId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: 'done', storage_path: storagePath, public_url: publicUrl })
    });
  } catch (e) { /* non-fatal — video is uploaded */ }

  return { statusCode: 200, headers, body: JSON.stringify({ status: 'done', public_url: publicUrl, job_id: jobId }) };
};

async function markFailed(jobId, msg, supabaseUrl, serviceKey) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/vulcan_videos?id=eq.${jobId}`, {
      method: 'PATCH',
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'failed', error_message: String(msg).slice(0, 500) })
    });
  } catch (e) { /* ignore */ }
}
