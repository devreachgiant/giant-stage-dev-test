// Keeping a mailbox in step with Gmail. One copy, used by the schedule and by Refresh.
//
// WHY THIS IS SERVER SIDE NOW. The browser did the syncing, which meant it could only
// happen while somebody had the Email tab open -- so "your inbox" was a snapshot of
// whenever that last was, and the unread badge on a fresh page load was whatever it had
// been hours ago. A server can only do this if it can renew the mailbox's access token
// on its own, which needs a refresh token, which the implicit flow never returned. That
// is why this did not exist before and does now.
//
// WHY THE HISTORY API. The old sync listed the newest N ids in five label queries and
// inserted anything it did not already have. That can only ADD. Archive a message in
// Gmail, delete it, read it on your phone, star it from the web -- none of it reached
// Giant, so the two lists drifted apart from the first day. users.history.list answers
// "what changed since <historyId>" with exactly the additions, removals and label
// changes, usually nothing, for a few hundred bytes. Cheap enough to run every few
// minutes; complete enough that the lists stay identical.
//
// The full scan is still here, for the first sync of a mailbox and for when Google has
// expired the history (it keeps roughly a week). Both arrive as "start from scratch",
// which is what a null history_id means.

const { refresh } = require('./google-oauth');

const SUPA = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, method = 'GET', payload = null, extraHeaders = {}) {
  const res = await fetch(SUPA + '/rest/v1/' + path, {
    method,
    headers: Object.assign({
      apikey: KEY, Authorization: 'Bearer ' + KEY,
      'content-type': 'application/json', Prefer: 'return=representation'
    }, extraHeaders),
    body: payload ? JSON.stringify(payload) : undefined
  });
  const txt = await res.text();
  if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + txt.slice(0, 300));
  return txt ? JSON.parse(txt) : null;
}

// ── Gmail message → the row the Email screen reads ────────────────────────────
// Deliberately identical in shape to what the browser used to write, so existing rows
// and new ones are the same thing.
function decodeBase64Url(data) {
  if (!data) return '';
  try {
    return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
      .toString('utf8');
  } catch (e) { return ''; }
}

function getHeader(headers, name) {
  const h = (headers || []).find(x => x.name && x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function extractBody(payload) {
  let html = '', text = '';
  (function walk(part) {
    if (!part) return;
    const mime = part.mimeType || '';
    if (part.body && part.body.data) {
      const decoded = decodeBase64Url(part.body.data);
      if (mime === 'text/html' && !html) html = decoded;
      else if (mime === 'text/plain' && !text) text = decoded;
    }
    (part.parts || []).forEach(walk);
  })(payload);
  return { html, text };
}

function parseGmailMessage(msg) {
  if (!msg || !msg.id) return null;
  const headers = (msg.payload && msg.payload.headers) || [];
  const from = getHeader(headers, 'From');
  const dateHeader = getHeader(headers, 'Date');
  const receivedAt = msg.internalDate
    ? new Date(parseInt(msg.internalDate, 10)).toISOString()
    : (dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString());
  let fromName = from, fromEmail = from;
  const m = from.match(/^(.*?)\s*<(.+?)>\s*$/);
  if (m) { fromName = m[1].trim().replace(/^"|"$/g, ''); fromEmail = m[2].trim(); }
  else if (from.includes('@')) { fromName = from.split('@')[0]; fromEmail = from; }
  const labels = msg.labelIds || [];
  const { html, text } = extractBody(msg.payload);
  return {
    gmail_id: msg.id,
    thread_id: msg.threadId || null,
    from_email: fromEmail,
    from_name: fromName,
    to_emails: getHeader(headers, 'To'),
    subject: getHeader(headers, 'Subject') || '(no subject)',
    snippet: msg.snippet || '',
    body_html: html || null,
    body_text: text || null,
    is_unread: labels.includes('UNREAD'),
    is_starred: labels.includes('STARRED'),
    has_attachments: !!((msg.payload && msg.payload.parts) || [])
      .find(p => p.filename && p.filename.length),
    labels,
    received_at: receivedAt
  };
}

// ── Gmail calls ───────────────────────────────────────────────────────────────
async function gapi(token, path) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, {
    headers: { Authorization: 'Bearer ' + token }
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function fetchMessages(token, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const got = await Promise.all(batch.map(id => gapi(token, 'messages/' + id + '?format=full')));
    got.forEach(r => { if (r.ok) out.push(r.body); });
  }
  return out;
}

async function storeMessages(profileId, messages) {
  const rows = messages.map(parseGmailMessage).filter(Boolean)
    .map(r => Object.assign({ profile_id: profileId }, r));
  if (!rows.length) return 0;
  // Small batches: this database is on a small instance and a 300-row insert has put
  // it into an unhealthy state before.
  for (let i = 0; i < rows.length; i += 25) {
    await sb('emails?on_conflict=profile_id,gmail_id', 'POST', rows.slice(i, i + 25),
      { Prefer: 'resolution=merge-duplicates,return=minimal' });
  }
  return rows.length;
}

// ── The two kinds of sync ─────────────────────────────────────────────────────

/* Everything in the window, for a mailbox we have no cursor for. Ids are cheap -- it
   is the per-message fetch that costs -- so the database is asked which of them it
   already holds and only the rest are downloaded.

   CAPPED, BECAUSE A FUNCTION HAS 26 SECONDS. The first scan of a real mailbox is
   hundreds of messages -- one account here had 73 stored against 886 in Gmail -- and
   downloading all of them in one invocation times out. Worse, the cursor is only
   written on a completed scan, so a run that times out records nothing and the next
   one starts over: it would have failed every ten minutes, for ever, while creeping
   forward on whatever it managed before being killed.

   So a run takes a bite, says whether it finished, and leaves the cursor unset until
   it has. Each run is cheaper than the last because the dedupe above skips what the
   previous ones stored, and the mailbox fills in over a few runs instead of never. */
const SCAN_CAP = 120;

async function fullScan(token, profileId) {
  const windows = [
    { q: 'in:inbox', limit: 500 },
    { q: 'in:sent', limit: 200 },
    { q: 'is:draft', limit: 50 },
    { q: 'category:updates', limit: 300 },
    { q: 'category:promotions', limit: 300 }
  ];
  const ids = [];
  for (const w of windows) {
    const r = await gapi(token, 'messages?maxResults=' + w.limit + '&q=' + encodeURIComponent(w.q));
    if (!r.ok) continue;
    (r.body.messages || []).forEach(m => { if (!ids.includes(m.id)) ids.push(m.id); });
  }
  if (!ids.length) return { added: 0, seen: 0 };

  const known = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const have = await sb('emails?select=gmail_id&profile_id=eq.' + profileId
      + '&gmail_id=in.(' + slice.join(',') + ')');
    (have || []).forEach(r => known.add(r.gmail_id));
  }
  const fresh = ids.filter(id => !known.has(id));
  const bite = fresh.slice(0, SCAN_CAP);
  const added = await storeMessages(profileId, await fetchMessages(token, bite));
  return { added, seen: ids.length, remaining: fresh.length - bite.length,
           done: fresh.length <= SCAN_CAP };
}

/* What changed since last time. Returns null when Google says the cursor is too old
   (404), which is the caller's signal to fall back to a full scan. */
async function applyHistory(token, profileId, startHistoryId) {
  const added = new Set();
  const removed = new Set();
  const relabelled = new Set();
  let pageToken = null;

  do {
    const path = 'history?startHistoryId=' + encodeURIComponent(startHistoryId)
      + '&historyTypes=messageAdded&historyTypes=messageDeleted'
      + '&historyTypes=labelAdded&historyTypes=labelRemoved'
      + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const r = await gapi(token, path);
    if (r.status === 404) return null;      // cursor expired -- full scan instead
    if (!r.ok) throw new Error('Gmail history ' + r.status
      + ': ' + ((r.body.error && r.body.error.message) || ''));
    for (const h of (r.body.history || [])) {
      (h.messagesAdded || []).forEach(x => added.add(x.message.id));
      (h.messagesDeleted || []).forEach(x => { removed.add(x.message.id); added.delete(x.message.id); });
      (h.labelsAdded || []).forEach(x => relabelled.add(x.message.id));
      (h.labelsRemoved || []).forEach(x => relabelled.add(x.message.id));
    }
    pageToken = r.body.nextPageToken || null;
  } while (pageToken);

  // Deleted in Gmail means gone here. Without this the list only ever grew.
  if (removed.size) {
    await sb('emails?profile_id=eq.' + profileId
      + '&gmail_id=in.(' + [...removed].join(',') + ')', 'DELETE', null,
      { Prefer: 'return=minimal' });
  }

  /* A label change is read-state, star, archive. Re-fetching the message is the
     simplest correct way to get all of them, and there are only ever a handful.
     A message that has left the mailbox altogether answers 404 and is dropped. */
  const touched = [...new Set([...added, ...relabelled])].filter(id => !removed.has(id));
  const msgs = await fetchMessages(token, touched);
  const stored = await storeMessages(profileId, msgs);
  const vanished = touched.filter(id => !msgs.find(m => m.id === id));
  if (vanished.length) {
    await sb('emails?profile_id=eq.' + profileId
      + '&gmail_id=in.(' + vanished.join(',') + ')', 'DELETE', null,
      { Prefer: 'return=minimal' });
  }
  return { added: stored, removed: removed.size + vanished.length, touched: touched.length };
}

/* One mailbox, start to finish: renew the token, apply what changed (or scan), and
   write down where we got to. Never throws for one mailbox's sake -- the scheduled run
   has others to get through -- it reports. */
async function syncMailbox(row) {
  const out = { profile_id: row.profile_id, slot: row.slot, email: row.email, ok: false };
  if (!row.refresh_token) { out.skipped = 'no refresh token -- needs one reconnect'; return out; }

  const r = await refresh(row.refresh_token);
  if (!r.ok) {
    out.error = r.error;
    if (r.dead) {
      // Revoked, or the password changed. It will never work again, so the dead token
      // is cleared and the screen can ask for a reconnect instead of retrying for ever.
      out.dead = true;
      await sb('gmail_tokens?profile_id=eq.' + row.profile_id + '&slot=eq.' + row.slot,
        'PATCH', { refresh_token: null }, { Prefer: 'return=minimal' });
    }
    return out;
  }
  const token = r.body.access_token;
  const expiresAt = new Date(Date.now() + ((r.body.expires_in || 3600) * 1000)).toISOString();

  let result = null, mode = 'history';
  if (row.history_id) result = await applyHistory(token, row.profile_id, row.history_id);
  if (!result) { mode = 'full'; result = await fullScan(token, row.profile_id); }

  /* Where to resume from next time. Asked for AFTER the work, so anything that
     arrives mid-sync is picked up by the next run rather than skipped.

     Only on a COMPLETED scan. Recording a cursor part way through a first scan would
     be the worst of both: history only describes what changes from that point on, so
     every message older than the bite we happened to take would never be fetched by
     anything, ever. Leaving it null costs one more scan run and loses nothing. */
  const patch = { access_token: token, expires_at: expiresAt,
                  last_sync_at: new Date().toISOString() };
  if (mode === 'history' || result.done) {
    const prof = await gapi(token, 'profile');
    if (prof.ok) patch.history_id = String(prof.body.historyId);
  }

  await sb('gmail_tokens?profile_id=eq.' + row.profile_id + '&slot=eq.' + row.slot,
    'PATCH', patch, { Prefer: 'return=minimal' });

  return Object.assign(out, { ok: true, mode }, result);
}

async function mailboxes(profileId) {
  const q = 'gmail_tokens?select=profile_id,slot,email,refresh_token,history_id'
    + (profileId ? '&profile_id=eq.' + profileId : '');
  return (await sb(q)) || [];
}

module.exports = { syncMailbox, mailboxes, parseGmailMessage, fullScan, applyHistory };
