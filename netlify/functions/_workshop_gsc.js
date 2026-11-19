// Workshop <-> Google Search Console. The shared part: used by workshop-gsc.js (the
// buttons) and workshop-gsc-sync.mjs (the schedule), so there is one sync, not two.
//
// ONE AGENCY GOOGLE ACCOUNT. Each client adds ReachGiant's Google account as a user on
// their Search Console property. One refresh token for that account then reads every
// property it has been given, and all Giant has to remember per client is WHICH
// property is theirs -- a non-secret id kept in workshop_connections.meta.
//
// WHERE THE SECRET LIVES. growth_secrets, key 'gsc_google': RLS on, no policies, no
// grants, so only the service role in a Netlify function can read it. Nothing this
// module returns contains the token. The OAuth exchange and refresh are the ones in
// google-oauth.js, reused rather than copied: two copies of an OAuth exchange drift.
//
// ONLY WHAT GOOGLE RETURNED. Rows are stored as Google sent them. Totals are Google's
// own aggregate row (a query with no dimension), never a sum computed here.
//
// ADDING A WEBSITE DOES NOT GRANT ACCESS. If the agency account cannot see a property
// for the client's domain, the connection is marked failed with a message saying
// exactly who must add whom, and nothing is invented in its place.

const { refresh } = require('./google-oauth');

const SECRET_KEY = 'gsc_google';
const API = 'https://www.googleapis.com/webmasters/v3';
const DAY = 864e5;
const FIRST_SYNC_DAYS = 480;        // Search Console keeps about 16 months
const OVERLAP_DAYS = 3;             // recent days are revised by Google, so re-read them
const ROW_CAP = 1000;               // per period and dimension; the top rows by clicks
const PAGE = 1000;                  // Search Analytics rowLimit per request

// ------------------------------------------------------------------ Supabase (service)

async function sb(path, method, body, prefer) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw codeErr('config', 'Supabase is not configured for this function');
  const headers = {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(url + '/rest/v1/' + path, {
    method: method || 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  if (!r.ok) throw codeErr('db', 'Supabase ' + r.status + ': ' + txt.slice(0, 300));
  try { return txt ? JSON.parse(txt) : null; } catch (e) { return null; }
}

function codeErr(code, message) { const e = new Error(message); e.code = code; return e; }

// ------------------------------------------------------------------ the agency token

async function readSecret() {
  const rows = await sb('growth_secrets?key=eq.' + SECRET_KEY + '&select=value,label,updated_at');
  return rows && rows[0] ? rows[0] : null;
}

async function saveSecret(refreshToken, email, userId) {
  await sb('growth_secrets?on_conflict=key', 'POST', [{
    key: SECRET_KEY, value: refreshToken, label: email || '',
    updated_at: new Date().toISOString(), updated_by: userId || null,
  }], 'resolution=merge-duplicates,return=minimal');
}

async function deleteSecret() {
  await sb('growth_secrets?key=eq.' + SECRET_KEY, 'DELETE', null, 'return=minimal');
}

async function accessToken() {
  const s = await readSecret();
  if (!s || !s.value) throw codeErr('not_connected', 'Search Console is not connected. Connect the ReachGiant Google account first.');
  const r = await refresh(s.value);
  if (!r.ok) {
    if (r.dead) throw codeErr('reconnect', 'Google no longer accepts the saved Search Console login (' + (r.error || 'invalid_grant') + '). Reconnect Search Console.');
    throw codeErr('google', 'Google refused to refresh the Search Console login: ' + (r.error || 'unknown error'));
  }
  return { token: r.body.access_token, account: s.label || '' };
}

// ------------------------------------------------------------------ Google calls

async function gapi(token, path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(API + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const txt = await r.text();
    let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) { /* not JSON */ }
    if (r.ok) return j || {};
    const msg = (j && j.error && j.error.message) || txt.slice(0, 200) || ('HTTP ' + r.status);
    if (r.status === 429) throw codeErr('quota', 'Search Console quota reached. It resets on its own; try again later. (' + msg + ')');
    if (r.status === 401) throw codeErr('reconnect', 'Google rejected the Search Console login. Reconnect Search Console.');
    if (r.status === 403) throw codeErr('permission', 'The connected Google account has no permission for this property. (' + msg + ')');
    if (r.status >= 500 && attempt === 0) { await new Promise((res) => setTimeout(res, 1200)); continue; }
    throw codeErr('google', 'Search Console answered ' + r.status + ': ' + msg);
  }
  throw codeErr('google', 'Search Console did not answer');
}

async function listSites(token) {
  const j = await gapi(token, '/sites');
  return (j.siteEntry || []).filter((s) => s.permissionLevel && s.permissionLevel !== 'siteUnverifiedUser');
}

// Every row of one query, page by page, up to `cap` rows.
async function queryAll(token, property, body, cap) {
  const out = [];
  let startRow = 0;
  for (;;) {
    const limit = Math.min(PAGE, cap - out.length);
    if (limit <= 0) break;
    const j = await gapi(token, '/sites/' + encodeURIComponent(property) + '/searchAnalytics/query',
      Object.assign({}, body, { rowLimit: limit, startRow }));
    const rows = j.rows || [];
    out.push(...rows);
    if (rows.length < limit) break;
    startRow += rows.length;
  }
  return out;
}

// ------------------------------------------------------------------ matching a website

function domainOf(website) {
  let s = String(website || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z]+:\/\//, '').replace(/[\/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : '';
}

// Domain property first (it covers http, https and every subdomain), then URL-prefix.
function matchProperty(sites, domain) {
  const want = [
    'sc-domain:' + domain,
    'https://' + domain + '/', 'https://www.' + domain + '/',
    'http://' + domain + '/', 'http://www.' + domain + '/',
  ];
  for (const w of want) {
    const hit = sites.find((s) => String(s.siteUrl).toLowerCase() === w);
    if (hit) return hit;
  }
  return null;
}

// ------------------------------------------------------------------ connection row

async function readConn(clientId) {
  const rows = await sb('workshop_connections?client_id=eq.' + clientId + '&source=eq.gsc'
    + '&select=client_id,status,meta,last_error,tested_at');
  return rows && rows[0] ? rows[0] : null;
}

async function writeConn(clientId, status, meta, lastError, userId) {
  const now = new Date().toISOString();
  await sb('workshop_connections?on_conflict=client_id,source', 'POST', [{
    client_id: clientId, source: 'gsc', status, meta: meta || {},
    last_error: lastError || null, tested_at: now, updated_at: now, updated_by: userId || null,
  }], 'resolution=merge-duplicates,return=minimal');
}

// ------------------------------------------------------------------ dates

const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (s, n) => ymd(new Date(s + 'T00:00:00Z').getTime() + n * DAY);

function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

// ------------------------------------------------------------------ the sync

const BREAKDOWNS = [
  // [period, dimensions to fetch besides the total]
  ['last_28d', ['query', 'page', 'country', 'device', 'searchAppearance']],
  ['prev_28d', ['query', 'page', 'country', 'device']],
  ['last_3m', ['query', 'page']],
];

async function syncClient(clientId, opts) {
  opts = opts || {};
  const userId = opts.userId || null;
  const cl = await sb('clients?id=eq.' + clientId + '&select=id,name,company_website');
  const client = cl && cl[0];
  if (!client) throw codeErr('not_found', 'That client does not exist.');

  const prev = await readConn(clientId);
  const prevMeta = (prev && prev.meta) || {};
  const domain = domainOf(client.company_website);
  if (!domain) {
    await writeConn(clientId, 'failed', prevMeta, 'No website on record for ' + client.name + '. Add the website to the client first.', userId);
    return { ok: false, code: 'no_website', error: 'No website on record for ' + client.name + '.' };
  }

  let tok;
  try { tok = await accessToken(); }
  catch (e) {
    await writeConn(clientId, 'failed', prevMeta, e.message, userId);
    return { ok: false, code: e.code, error: e.message };
  }

  try {
    const sites = opts.sites || await listSites(tok.token);
    const still = prevMeta.property && sites.find((s) => s.siteUrl === prevMeta.property);
    const site = still || matchProperty(sites, domain);
    if (!site) {
      const msg = 'No Search Console property for ' + domain + ' is shared with ' + (tok.account || 'the connected Google account')
        + '. Ask the client to add ' + (tok.account || 'that account') + ' as a user in Search Console (Settings > Users and permissions).';
      await writeConn(clientId, 'failed', Object.assign({}, prevMeta, { domain, account: tok.account }), msg, userId);
      return { ok: false, code: 'no_property', error: msg };
    }
    const property = site.siteUrl;

    // Daily totals, from where the last sync stopped (minus a few days Google revises).
    const yesterday = ymd(Date.now() - DAY);
    const from = (prevMeta.property === property && prevMeta.last_daily_date)
      ? addDays(prevMeta.last_daily_date, -OVERLAP_DAYS)
      : ymd(Date.now() - FIRST_SYNC_DAYS * DAY);
    const daily = await queryAll(tok.token, property,
      { startDate: from, endDate: yesterday, dimensions: ['date'], type: 'web' }, 25000);
    const now = new Date().toISOString();
    const dailyRows = daily.map((r) => ({
      client_id: clientId, date: r.keys[0], clicks: num(r.clicks), impressions: num(r.impressions),
      ctr: num(r.ctr), position: num(r.position), synced_at: now,
    }));
    for (let i = 0; i < dailyRows.length; i += 500) {
      await sb('workshop_gsc_daily?on_conflict=client_id,date', 'POST', dailyRows.slice(i, i + 500),
        'resolution=merge-duplicates,return=minimal');
    }

    // The last day Google has data for, so periods end on real data, not on a gap.
    let lastDate = dailyRows.reduce((m, r) => (r.date > m ? r.date : m), prevMeta.last_daily_date || '');
    if (!lastDate) lastDate = ymd(Date.now() - 3 * DAY);
    const ranges = {
      last_28d: [addDays(lastDate, -27), lastDate],
      prev_28d: [addDays(lastDate, -55), addDays(lastDate, -28)],
      last_3m: [addDays(lastDate, -89), lastDate],
    };

    let breakdownRows = 0;
    for (const [period, dims] of BREAKDOWNS) {
      const [startDate, endDate] = ranges[period];
      const rows = [];
      const tot = await queryAll(tok.token, property, { startDate, endDate, type: 'web' }, 1);
      if (tot[0]) rows.push({ dimension: 'total', key: '', r: tot[0] });
      for (const d of dims) {
        const got = await queryAll(tok.token, property, { startDate, endDate, dimensions: [d], type: 'web' }, ROW_CAP);
        got.forEach((r) => rows.push({ dimension: d, key: String((r.keys && r.keys[0]) || ''), r }));
      }
      // Replace this period: delete what the last sync left, then insert what Google sent now.
      await sb('workshop_gsc_breakdown?client_id=eq.' + clientId + '&period=eq.' + period, 'DELETE', null, 'return=minimal');
      const payload = rows.map((x) => ({
        client_id: clientId, period, dimension: x.dimension, key: x.key,
        clicks: num(x.r.clicks), impressions: num(x.r.impressions), ctr: num(x.r.ctr), position: num(x.r.position),
        start_date: startDate, end_date: endDate, synced_at: now,
      }));
      for (let i = 0; i < payload.length; i += 500) {
        await sb('workshop_gsc_breakdown?on_conflict=client_id,period,dimension,key', 'POST', payload.slice(i, i + 500),
          'resolution=merge-duplicates,return=minimal');
      }
      breakdownRows += payload.length;
    }

    const meta = {
      property, permission: site.permissionLevel, domain, account: tok.account,
      last_synced_at: now, last_daily_date: lastDate, daily_rows: dailyRows.length, breakdown_rows: breakdownRows,
    };
    await writeConn(clientId, 'ok', meta, null, userId);
    return { ok: true, property, last_synced_at: now, last_daily_date: lastDate, daily_rows: dailyRows.length, breakdown_rows: breakdownRows };
  } catch (e) {
    await writeConn(clientId, 'failed', prevMeta, e.message, userId).catch(() => {});
    return { ok: false, code: e.code || 'error', error: e.message };
  }
}

// The schedule: every client with a website, least recently synced first, within a time
// budget so a long list carries on next run instead of being cut off mid-write.
async function syncDue(budgetMs) {
  const began = Date.now();
  const s = await readSecret();
  if (!s || !s.value) return { ok: true, skipped: 'not_connected', synced: 0 };
  const clients = await sb('clients?company_website=not.is.null&select=id,company_website');
  const conns = await sb('workshop_connections?source=eq.gsc&select=client_id,status,meta');
  const byId = {};
  (conns || []).forEach((c) => { byId[c.client_id] = c; });
  const fresh = Date.now() - 20 * 36e5;
  const due = (clients || [])
    .filter((c) => domainOf(c.company_website))
    .filter((c) => { const m = byId[c.id] && byId[c.id].meta; return !(m && m.last_synced_at && Date.parse(m.last_synced_at) > fresh); })
    .sort((a, b) => {
      const ta = Date.parse((byId[a.id] && byId[a.id].meta && byId[a.id].meta.last_synced_at) || 0) || 0;
      const tb = Date.parse((byId[b.id] && byId[b.id].meta && byId[b.id].meta.last_synced_at) || 0) || 0;
      return ta - tb;
    });
  if (!due.length) return { ok: true, synced: 0 };
  const tok = await accessToken();
  const sites = await listSites(tok.token);
  const results = [];
  for (const c of due) {
    if (Date.now() - began > budgetMs) break;
    const r = await syncClient(c.id, { sites });
    results.push({ client_id: c.id, ok: r.ok, code: r.code || null });
    if (r.code === 'quota' || r.code === 'reconnect') break;   // no point hammering
  }
  return { ok: true, synced: results.filter((r) => r.ok).length, tried: results.length, results };
}

// What the Workshop page reads: the connection, the daily series, and the top rows of
// each breakdown. Never the token.
async function readData(clientId) {
  const conn = await readConn(clientId);
  const daily = await sb('workshop_gsc_daily?client_id=eq.' + clientId
    + '&select=date,clicks,impressions,ctr,position&order=date.asc&limit=' + (FIRST_SYNC_DAYS + 10));
  const bd = await sb('workshop_gsc_breakdown?client_id=eq.' + clientId
    + '&select=period,dimension,key,clicks,impressions,ctr,position,start_date,end_date&order=clicks.desc&limit=20000');
  const breakdown = {};
  (bd || []).forEach((r) => {
    const p = (breakdown[r.period] = breakdown[r.period] || { start_date: r.start_date, end_date: r.end_date });
    if (r.dimension === 'total') { p.total = { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }; return; }
    const list = (p[r.dimension] = p[r.dimension] || []);
    if (list.length < 100) list.push({ key: r.key, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position });
  });
  return {
    status: conn ? conn.status : 'off',
    error: conn ? conn.last_error : null,
    property: conn && conn.meta ? conn.meta.property || null : null,
    last_synced_at: conn && conn.meta ? conn.meta.last_synced_at || null : null,
    last_daily_date: conn && conn.meta ? conn.meta.last_daily_date || null : null,
    daily: daily || [],
    breakdown,
  };
}

async function listConns() {
  const rows = await sb('workshop_connections?source=eq.gsc&select=client_id,status,meta,last_error,tested_at');
  return (rows || []).map((r) => ({
    client_id: r.client_id, status: r.status, error: r.last_error, tested_at: r.tested_at,
    property: (r.meta && r.meta.property) || null, last_synced_at: (r.meta && r.meta.last_synced_at) || null,
  }));
}

module.exports = {
  SECRET_KEY, readSecret, saveSecret, deleteSecret, accessToken, listSites,
  syncClient, syncDue, readData, listConns, domainOf, matchProperty, sb,
};
