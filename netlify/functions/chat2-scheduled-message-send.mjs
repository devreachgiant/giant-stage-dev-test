// Netlify Scheduled Function: chat2-scheduled-message-send
// Mirrors scheduled-message-send.mjs (old Chat & Huddles) but targets Chat 2.0's
// own isolated tables. Runs every minute. Finds chat2_scheduled_messages that are
// due (status='pending', scheduled_for <= now), inserts each as a real row in
// chat2_messages, and marks the scheduled row as sent (or failed, so it doesn't
// retry forever).

async function sb(path, method = 'GET', payload = null) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env not configured');
  const opts = {
    method,
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' || method === 'PATCH' ? 'return=representation' : ''
    }
  };
  if (payload) opts.body = JSON.stringify(payload);
  const res = await fetch(`${url}/rest/v1/${path}`, opts);
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch(e) { data = txt; }
  if (!res.ok) {
    const err = new Error((data && data.message) || `Supabase ${res.status}: ${txt.slice(0,200)}`);
    err.statusCode = res.status; err.detail = data;
    throw err;
  }
  return data;
}

export default async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[chat2-scheduled-message-send] Supabase env not configured');
    return new Response('Server misconfigured', { status: 500 });
  }

  const nowIso = new Date().toISOString();
  let due = [];
  try {
    due = await sb(`chat2_scheduled_messages?status=eq.pending&scheduled_for=lte.${encodeURIComponent(nowIso)}&select=id,thread_id,sender_id,body,attachments,parent_id&limit=50`);
  } catch (e) {
    console.error('[chat2-scheduled-message-send] fetch due failed:', e.message);
    return new Response('fetch failed', { status: 500 });
  }

  for (const row of due) {
    try {
      const [inserted] = await sb('chat2_messages', 'POST', {
        thread_id: row.thread_id,
        author_id: row.sender_id,
        body: row.body,
        attachments: row.attachments || [],
        parent_id: row.parent_id || null
      });
      await sb(`chat2_scheduled_messages?id=eq.${encodeURIComponent(row.id)}`, 'PATCH', {
        status: 'sent',
        sent_message_id: inserted && inserted.id,
        sent_at: new Date().toISOString()
      });
    } catch (e) {
      console.error('[chat2-scheduled-message-send] failed to send', row.id, e.message);
      try {
        await sb(`chat2_scheduled_messages?id=eq.${encodeURIComponent(row.id)}`, 'PATCH', {
          status: 'failed',
          error: e.message
        });
      } catch (e2) {}
    }
  }

  return new Response(JSON.stringify({ processed: due.length }), { status: 200 });
};

export const config = {
  schedule: '* * * * *'
};
