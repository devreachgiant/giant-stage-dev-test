// Netlify Function: report-notify
// Sends an email to dev@reachgiant.com when a new bug report / feature suggestion is
// created ("Help Us Improve"). Called by the frontend right after inserting a row in
// the `reports` table.

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

const NOTIFY_EMAIL = 'dev@reachgiant.com';

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

  const { report_id } = body;
  if (!report_id) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'report_id required' }) };
  }

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({
        error: 'Server misconfigured: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var is missing.'
      }) };
    }

    const reports = await sb(`reports?id=eq.${encodeURIComponent(report_id)}&select=id,type,title,description,media_url,media_type,link,page_context,reporter_id,created_at&limit=1`);
    if (!reports.length) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: `Report ${report_id} not found` }) };
    }
    const report = reports[0];

    let reporterName = 'Someone';
    if (report.reporter_id) {
      try {
        const profs = await sb(`profiles?id=eq.${encodeURIComponent(report.reporter_id)}&select=full_name,email&limit=1`);
        if (profs.length) reporterName = profs[0].full_name || profs[0].email || 'Someone';
      } catch(e) {}
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      // No-op gracefully — the in-app notification already covers this, email is best-effort.
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, email_skipped: 'RESEND_API_KEY not set' }) };
    }

    const isBug = report.type === 'bug';
    const badgeColor = isBug ? '#D00400' : '#2563eb';
    const badgeLabel = isBug ? 'Bug report' : 'Feature suggestion';
    const isVideo = report.media_type === 'video';

    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#111;background:#fff;">
        <div style="display:inline-block;background:${badgeColor};color:#fff;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:6px 12px;border-radius:6px;margin-bottom:16px;">${badgeLabel}</div>
        <h1 style="margin:0 0 12px;font-size:20px;font-weight:800;letter-spacing:-0.01em;">${escHtml(report.title)}</h1>
        <p style="font-size:13px;color:#666;margin:0 0 20px;">Submitted by <strong>${escHtml(reporterName)}</strong>${report.page_context ? ` on <code>${escHtml(report.page_context)}</code>` : ''}</p>
        <p style="font-size:15px;line-height:1.6;margin:0 0 20px;white-space:pre-wrap;">${escHtml(report.description)}</p>
        <div style="margin:0 0 20px;">
          <a href="${escHtml(report.media_url)}" style="display:inline-block;background:#111;color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none;">View attached ${isVideo ? 'video' : 'screenshot'}</a>
        </div>
        ${report.link ? `<p style="font-size:13px;color:#444;margin:0 0 20px;">Reference link: <a href="${escHtml(report.link)}" style="color:#2563eb;">${escHtml(report.link)}</a></p>` : ''}
        <p style="font-size:11px;color:#aaa;margin-top:28px;border-top:1px solid #eaeaea;padding-top:16px;">Sent from Giant — Help Us Improve</p>
      </div>
    `;

    const envFrom = process.env.RESEND_FROM;
    const isValidFrom = envFrom && /<[^@>]+@[^>]+\.[a-z]{2,}>/i.test(envFrom);
    const from = isValidFrom ? envFrom : 'Giant <noreply@theparallel.studio>';

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [NOTIFY_EMAIL],
        subject: `[${badgeLabel}] ${report.title}`,
        html
      })
    });
    const resBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn('[report-notify] Resend failed:', res.status, resBody);
      const detailMsg = resBody.message || resBody.error || JSON.stringify(resBody).slice(0, 200);
      return { statusCode: 500, headers, body: JSON.stringify({ error: `Resend ${res.status}: ${detailMsg}` }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, email_id: resBody.id }) };
  } catch (e) {
    console.error('[report-notify] error:', e.message, e.detail);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
