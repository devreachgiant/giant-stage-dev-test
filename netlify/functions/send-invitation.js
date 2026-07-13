// Netlify Function: send-invitation
// Sends the invitation email via Resend when a new invitation row is created.
// Called by the frontend right after inserting a row in the `invitations` table.

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
      'Prefer': method === 'POST' ? 'return=representation' : ''
    }
  };
  if (payload) opts.body = JSON.stringify(payload);
  const res = await fetch(`${url}/rest/v1/${path}`, opts);
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch(e) { data = txt; }
  if (!res.ok) {
    const err = new Error((data && data.message) || `Supabase ${res.status}: ${txt.slice(0,200)}`);
    err.statusCode = res.status; err.detail = data; err.rawBody = txt;
    throw err;
  }
  return data;
}

function escHtml(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { invitation_id } = body;
  if (!invitation_id) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'invitation_id required' }) };
  }

  try {
    // Sanity check env vars first — clearer error than "invitation not found"
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({
        error: 'Server misconfigured: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var is missing. Add it in Netlify > Site settings > Environment variables.'
      }) };
    }
    // Load the invitation + inviter info
    const invs = await sb(`invitations?id=eq.${encodeURIComponent(invitation_id)}&select=id,email,full_name,role,token,invited_by,expires_at&limit=1`);
    if (!invs.length) {
      // Diagnostic: identify the key format being used + try a count query
      const keyPrefix = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').slice(0, 4);
      const urlHost = (process.env.SUPABASE_URL || '').replace(/^https?:\/\//, '').split('.')[0];
      let debugInfo = ` [url-host=${urlHost}, key-prefix=${keyPrefix}]`;
      try {
        const allRecent = await sb(`invitations?select=id,email,accepted_at,revoked_at&order=created_at.desc&limit=3`);
        debugInfo += ` (DB reachable, ${allRecent.length} recent invitations exist — id format mismatch?)`;
      } catch(e) {
        debugInfo += ` (DB query failed: ${e.message} | status=${e.statusCode||'?'} | body=${(e.rawBody||'').slice(0,120)})`;
      }
      return { statusCode: 404, headers, body: JSON.stringify({
        error: `Invitation ${invitation_id} not found${debugInfo}`
      }) };
    }
    const inv = invs[0];

    // Load inviter profile (best-effort — fallback to "your team" if missing)
    let inviterName = 'Your team';
    let inviterEmail = '';
    if (inv.invited_by) {
      try {
        const profs = await sb(`profiles?id=eq.${encodeURIComponent(inv.invited_by)}&select=full_name,email&limit=1`);
        if (profs.length) {
          inviterName = profs[0].full_name || profs[0].email || 'Your team';
          inviterEmail = profs[0].email || '';
        }
      } catch(e) {}
    }

    // Build invitation URL — frontend reads ?invite=<token> and walks the signup flow
    const baseUrl = process.env.GIANT_PUBLIC_URL || event.headers.origin || event.headers.Origin || 'https://giant-reachgiant.netlify.app';
    // Canonical route handled by the frontend bootstrap. Old format ?invite=<token> is still accepted (auto-rewritten).
    const inviteUrl = `${baseUrl}/accept-invite?token=${encodeURIComponent(inv.token)}`;

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'RESEND_API_KEY not set' }) };
    }

    const roleLabel = ({ owner: 'Owner', manager: 'Manager', member: 'Member', client: 'Client' })[inv.role] || 'Member';
    const recipientName = inv.full_name || inv.email.split('@')[0];

    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#111;background:#fff;">
        <div style="background:linear-gradient(135deg,#D00400,#F0312E);color:#fff;padding:28px 24px;border-radius:14px;margin-bottom:24px;text-align:center;">
          <div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;opacity:.85;margin-bottom:6px;">You're invited</div>
          <h1 style="margin:0;font-size:24px;font-weight:800;letter-spacing:-0.02em;">Join Giant</h1>
        </div>
        <p style="font-size:15px;line-height:1.6;margin:0 0 14px;">Hi ${escHtml(recipientName)},</p>
        <p style="font-size:15px;line-height:1.6;margin:0 0 14px;"><strong>${escHtml(inviterName)}</strong> has invited you to join their workspace on <strong>Giant</strong> as a <strong>${roleLabel}</strong>.</p>
        <p style="font-size:14px;line-height:1.6;color:#444;margin:0 0 24px;">Giant is the all-in-one workspace for chat, projects, time tracking, and client management.</p>
        <div style="text-align:center;margin:28px 0;">
          <a href="${inviteUrl}" style="display:inline-block;background:#D00400;color:#fff;padding:14px 32px;border-radius:10px;font-size:15px;font-weight:700;text-decoration:none;letter-spacing:.01em;">Accept invitation</a>
        </div>
        <div style="background:#f5f5f5;border-radius:8px;padding:14px;margin:18px 0;">
          <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:6px;">Or copy this link</div>
          <div style="font-size:12px;color:#444;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;">${escHtml(inviteUrl)}</div>
        </div>
        <p style="font-size:12px;color:#888;line-height:1.5;margin:24px 0 0;">This invitation expires in 7 days. If you weren't expecting this email, you can safely ignore it.</p>
        ${inviterEmail ? `<p style="font-size:12px;color:#888;line-height:1.5;margin:8px 0 0;">Questions? Reply to this email or contact ${escHtml(inviterEmail)}.</p>` : ''}
        <p style="font-size:11px;color:#aaa;margin-top:32px;border-top:1px solid #eaeaea;padding-top:16px;text-align:center;">Powered by Giant</p>
      </div>
    `;

    // Force from value to verified domain — bypass RESEND_FROM env var if it's broken/missing
    // (theparallel.studio is verified in Resend, so emails from this domain work for all recipients)
    const envFrom = process.env.RESEND_FROM;
    const isValidFrom = envFrom && /<[^@>]+@[^>]+\.[a-z]{2,}>/i.test(envFrom);
    const from = isValidFrom ? envFrom : 'Giant <noreply@theparallel.studio>';
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [inv.email],
        subject: `${inviterName} invited you to join Giant`,
        html,
        // Set reply-to so the recipient can reply directly to the inviter
        reply_to: inviterEmail || undefined
      })
    });
    const resBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn('[send-invitation] Resend failed:', res.status, resBody);
      const detailMsg = resBody.message || resBody.error || JSON.stringify(resBody).slice(0, 200);
      return { statusCode: 500, headers, body: JSON.stringify({
        error: `Resend ${res.status}: ${detailMsg}`,
        from_used: from,
        to_used: inv.email,
        detail: resBody
      }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, email_id: resBody.id }) };
  } catch (e) {
    console.error('[send-invitation] error:', e.message, e.detail);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
