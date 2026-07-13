// Netlify Function: gcal-api proxy
// Calls Google Calendar API server-side using the user's stored access_token.
// Refreshes the token automatically if expired.

const GCAL_API_BASE = 'https://www.googleapis.com/calendar/v3';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

async function refreshAccessToken(refreshToken, clientId, clientSecret) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token'
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Refresh failed');
  return data; // { access_token, expires_in }
}

async function supabaseUpdateToken(profileId, slot, patch) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const slotFilter = slot ? `&slot=eq.${slot}` : '';
  await fetch(`${url}/rest/v1/gcal_tokens?profile_id=eq.${profileId}${slotFilter}`, {
    method: 'PATCH',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(patch)
  });
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

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, params, access_token, refresh_token, profile_id, slot } = body;
  if (!access_token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'access_token required' }) };

  let tokenToUse = access_token;

  const callGcal = async (path, method, payload, token) => {
    let url = `${GCAL_API_BASE}${path}`;
    if (method === 'GET' && payload) {
      const qs = new URLSearchParams(payload);
      url += '?' + qs.toString();
    }
    const opts = {
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    };
    if (method !== 'GET' && payload) opts.body = JSON.stringify(payload);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  try {
    let { res, data } = await callGcal(pathFor(action, params), methodFor(action), bodyFor(action, params), tokenToUse);

    // If 401, try refresh
    if (res.status === 401 && refresh_token && profile_id) {
      const clientId = process.env.GOOGLE_CLIENT_ID || '821166997756-483v3q5verbk94el54lq05c5m7ppqe99.apps.googleusercontent.com';
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientSecret) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'GOOGLE_CLIENT_SECRET not configured on server. Contact admin.', config_error: true }) };
      }
      try {
        const refreshed = await refreshAccessToken(refresh_token, clientId, clientSecret);
        tokenToUse = refreshed.access_token;
        const expiresAt = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString();
        await supabaseUpdateToken(profile_id, slot || 1, { access_token: tokenToUse, expires_at: expiresAt });
        // Retry
        ({ res, data } = await callGcal(pathFor(action, params), methodFor(action), bodyFor(action, params), tokenToUse));
      } catch (refreshErr) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'refresh_failed: ' + refreshErr.message, refresh_failed: true }) };
      }
    }

    if (!res.ok) {
      return { statusCode: res.status, headers, body: JSON.stringify({ error: data.error?.message || `HTTP ${res.status}`, type: data.error?.code }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ data, new_access_token: tokenToUse !== access_token ? tokenToUse : null }) };
  } catch (e) {
    console.error('[gcal-api]', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

function pathFor(action, params) {
  switch (action) {
    case 'list_calendars': return '/users/me/calendarList';
    case 'list_events': return `/calendars/${encodeURIComponent(params.calendarId || 'primary')}/events`;
    case 'get_event': return `/calendars/${encodeURIComponent(params.calendarId || 'primary')}/events/${encodeURIComponent(params.eventId)}`;
    case 'insert_event': {
      const cdv = params.conferenceDataVersion ? `?conferenceDataVersion=${params.conferenceDataVersion}` : '';
      return `/calendars/${encodeURIComponent(params.calendarId || 'primary')}/events${cdv}`;
    }
    case 'update_event': return `/calendars/${encodeURIComponent(params.calendarId || 'primary')}/events/${encodeURIComponent(params.eventId)}`;
    case 'delete_event': return `/calendars/${encodeURIComponent(params.calendarId || 'primary')}/events/${encodeURIComponent(params.eventId)}`;
    case 'freebusy': return '/freeBusy';
    default: throw new Error('Unknown action: ' + action);
  }
}
function methodFor(action) {
  if (action === 'insert_event' || action === 'freebusy') return 'POST';
  if (action === 'update_event') return 'PATCH';
  if (action === 'delete_event') return 'DELETE';
  return 'GET';
}
function bodyFor(action, params) {
  if (action === 'list_events') {
    const { calendarId, ...query } = params || {};
    return query;
  }
  if (action === 'insert_event' || action === 'update_event') return params.event;
  if (action === 'freebusy') return params;
  return null;
}
