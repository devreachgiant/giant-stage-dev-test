// Netlify Function: manage-member
// Deactivate / reactivate a team member (Slack-style: blocks login, keeps all their data),
// or fully Remove them (permanent — deletes their login AND, via DB cascade, their messages,
// tasks, live pages, time tracking, recordings, huddles, etc.). Requires the caller to be an
// authenticated owner or manager — verified here, not trusted from the frontend, since this
// wields the service role key.

// Columns referencing profiles.id with ON DELETE NO ACTION (i.e. they'd block a profile
// delete outright) that are nullable — cleared before attempting the delete so removal
// succeeds for the common case. `projects.created_by` is NOT NULL and deliberately excluded:
// a profile that created a project can't be fully removed until that project is reassigned
// or deleted, and the delete below fails with a clear error in that case rather than silently
// leaving projects in a broken state.
const NO_ACTION_NULLABLE_REFS = [
  ['tasks', 'created_by'], ['tasks', 'completed_by'],
  ['pay_adspend_tiers', 'created_by'], ['pay_bonus_tiers', 'created_by'], ['pay_departments', 'created_by'],
  ['project_members', 'added_by'], ['project_views', 'created_by'],
  ['schedule_exceptions', 'created_by'], ['subtasks', 'created_by'],
  ['team_pay', 'created_by'], ['team_schedules', 'updated_by']
];

const { allowOrigin } = require('./_cors');
const { requireUser } = require('./_auth');

async function sb(path, method = 'GET', payload = null) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env not configured');
  const opts = {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: method === 'PATCH' || method === 'POST' ? 'return=representation' : ''
    }
  };
  if (payload) opts.body = JSON.stringify(payload);
  const res = await fetch(`${url}/rest/v1/${path}`, opts);
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  if (!res.ok) {
    const err = new Error((data && data.message) || `Supabase ${res.status}: ${txt.slice(0, 200)}`);
    err.statusCode = res.status; err.detail = data;
    throw err;
  }
  return data;
}

// Supabase Auth Admin API has no permanent "disable" flag — a long ban is the standard way
// to block sign-in without deleting the auth user (which would cascade-orphan their data).
const BAN_DURATION = '876000h'; // ~100 years
async function setAuthBan(userId, banned) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ban_duration: banned ? BAN_DURATION : 'none' })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Auth admin API ${res.status}: ${txt.slice(0, 200)}`);
  }
}

async function deleteAuthUser(userId) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  // 404 here just means there's no matching auth user (already gone) — not fatal for Remove.
  if (!res.ok && res.status !== 404) {
    const txt = await res.text();
    throw new Error(`Auth admin API ${res.status}: ${txt.slice(0, 200)}`);
  }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin(event),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  const auth = await requireUser(event);
  if (!auth.ok) return { statusCode: auth.response.statusCode, headers, body: auth.response.body };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, profile_id } = body;
  if (!profile_id || !['deactivate', 'reactivate', 'remove'].includes(action)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'action must be deactivate/reactivate/remove, profile_id required' }) };
  }

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured: SUPABASE_SERVICE_ROLE_KEY missing' }) };
    }

    // Caller must be owner or manager — checked server-side, never trust the frontend for this.
    const callers = await sb(`profiles?id=eq.${encodeURIComponent(auth.user.id)}&select=id,role`);
    const caller = callers[0];
    if (!caller || !['owner', 'manager'].includes(caller.role)) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Only owner/manager can manage members' }) };
    }

    if (profile_id === auth.user.id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `You can't ${action} your own account` }) };
    }

    const targets = await sb(`profiles?id=eq.${encodeURIComponent(profile_id)}&select=id,role,full_name,email,deactivated_at`);
    const target = targets[0];
    if (!target) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Member not found' }) };

    // Both deactivate and remove permanently take away an owner's access — same
    // last-owner protection applies to either.
    if ((action === 'deactivate' || action === 'remove') && target.role === 'owner') {
      const owners = await sb(`profiles?role=eq.owner&deactivated_at=is.null&select=id`);
      if (owners.length <= 1) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Can't ${action} the last remaining owner` }) };
      }
    }

    if (action === 'deactivate') {
      if (target.deactivated_at) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, already: true }) };
      }
      await setAuthBan(profile_id, true);
      await sb(`profiles?id=eq.${encodeURIComponent(profile_id)}`, 'PATCH', { deactivated_at: new Date().toISOString() });
    } else if (action === 'reactivate') {
      await setAuthBan(profile_id, false);
      await sb(`profiles?id=eq.${encodeURIComponent(profile_id)}`, 'PATCH', { deactivated_at: null });
    } else {
      // remove — permanent. profiles.id is ON DELETE CASCADE from auth.users, so deleting
      // the auth user cascade-deletes the profile row automatically — there's no separate
      // "delete profiles" step to run afterward. That means the nullable NO_ACTION refs
      // MUST be cleared before the auth delete, not after: if a blocker (e.g. a task they
      // created) is still in place when the cascade fires, the whole auth.users delete
      // fails transactionally with a raw Postgres FK error instead of the clean message
      // below. (Previously this ran auth-delete first, which meant a blocked removal left
      // the login deleted but the profile — and their data — stuck; now a blocked removal
      // leaves everything untouched, which is the safer failure mode.)
      for (const [table, column] of NO_ACTION_NULLABLE_REFS) {
        try { await sb(`${table}?${column}=eq.${encodeURIComponent(profile_id)}`, 'PATCH', { [column]: null }); }
        catch (e) { console.warn(`[manage-member] pre-clear ${table}.${column} failed:`, e.message); }
      }
      try {
        await deleteAuthUser(profile_id);
      } catch (e) {
        return { statusCode: 409, headers, body: JSON.stringify({
          error: `Couldn't remove ${target.full_name || target.email} — they likely created a project that still references them. Reassign or delete that project first, or use Deactivate instead. (${e.message})`
        }) };
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, profile_id, action }) };
  } catch (e) {
    console.error('[manage-member] error:', e.message, e.detail);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
