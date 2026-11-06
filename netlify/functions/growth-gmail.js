// Growth: match the mail already in Giant back to the deals it belongs to.
//
// WHY THIS EXISTS AT ALL. The Growth Inbox has been on screen since the module shipped
// and has never shown a single message, because growth_messages has never had a row in
// it. The screen says so in its own empty state. Everything else was already there:
// gmail-sync pulls growth@reachgiant.com into `emails` every ten minutes and has 4,060
// messages in it going back to June 2024. What was missing was the one step in the
// middle -- deciding which of those messages belong to which deal.
//
// WHY A SERVER AND NOT THE BROWSER. The obvious shortcut is to read `emails` straight
// from the Inbox screen and join it to the deals in JavaScript. That works perfectly
// for Luke and for Nishchay and shows Annie and Matthew an empty screen, which is the
// worst kind of bug because nothing errors. `emails` is gated by
// emails_select_own -- profile_id = auth.uid() -- and the growth@ rows belong to the
// two accounts that connected the mailbox. growth_messages has no such rule: anybody
// who is not a client can read it. So the copy has to be made by something holding the
// service-role key, which is this.
//
// WHY A COPY IS ACCEPTABLE HERE. Copying data usually means two versions that drift.
// It is safe in this direction because the copy is derived and idempotent: every row is
// keyed on the Gmail message id through growth_messages.external_id, which is UNIQUE,
// so re-running only ever rewrites a row with the same content. Nothing writes back the
// other way.
//
// WHY NO DATE WINDOW. The recordings sync takes a `days` argument because asking Zoom
// about an old date range is expensive. This is the opposite: the filter is the list of
// deal addresses, not the date, so a full pass returns the messages that matched and
// nothing else -- 34 of the 4,060 today. A window would add a way to silently miss an
// old thread in exchange for saving nothing worth saving.

const SUPA = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/* The mailbox the sales team actually works out of. Named rather than "whatever is
   connected": Giant syncs personal mailboxes too, and Luke's own inbox is not the
   Growth inbox. */
const MAILBOX = 'growth@reachgiant.com';

/* PostgREST puts the filter in the URL, so a long list of addresses becomes a long URL
   and a 414 nobody expects. Fifty at a time keeps it well inside any limit and costs
   one extra request per fifty deals, which at 22 deals is zero extra requests today. */
const CHUNK = 50;

async function sb(path, method = 'GET', payload = null, prefer = 'return=representation') {
  const res = await fetch(SUPA + '/rest/v1/' + path, {
    method,
    headers: {
      apikey: KEY, Authorization: 'Bearer ' + KEY,
      'content-type': 'application/json', Prefer: prefer
    },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const txt = await res.text();
  if (!res.ok) throw new Error('Supabase ' + res.status + ': ' + txt.slice(0, 200));
  return txt ? JSON.parse(txt) : null;
}

const chunks = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/* Each value quoted, because an unquoted PostgREST list is split on commas and a value
   containing one would silently become two filters. No address here has a comma in it,
   which is exactly the kind of thing that stays true until it doesn't. */
const inList = (vals) => '(' + vals.map(v => '"' + String(v).replace(/"/g, '') + '"').join(',') + ')';

/* TO IS A HEADER, NOT AN ADDRESS. from_email holds a bare address, so it can be matched
   with a plain list. to_emails does not: it holds the To header as written --
   "Luke Griffin <big@reachgiant.com>", and 136 of the 4,060 rows carry several
   recipients in one string. It is also a `text` column rather than `text[]`, which is
   easy to get wrong because `labels` next to it IS an array; the first version of this
   file used an array-overlap filter and Postgres answered
   "operator does not exist: text && unknown". So: a substring match per address. */
const likeAny = (col, vals) =>
  '(' + vals.map(v => col + '.ilike.*' + String(v).replace(/[(),*"]/g, '') + '*').join(',') + ')';

/* Addresses out of a To header, for deciding which deal an outbound message belongs to
   once it is back in JavaScript. */
const addrsIn = (s) => (String(s || '').match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || [])
  .map(a => a.toLowerCase());

function htmlToText(h) {
  return String(h || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* THE QUOTED HISTORY IS CUT OFF. A reply carries every previous message underneath it,
   so the raw body of the fifth email in a thread is mostly the first four. Left in, the
   Inbox preview reads as the oldest message rather than the newest, and a draft written
   from it answers something that was settled a week ago.
//
   This is lossy on purpose and the loss is bounded: the whole mail is still in Gmail,
   and the thread is on screen in order anyway, so nothing a person needs disappears.
   The markers are the ones Gmail, Outlook and Apple Mail actually emit. */
function stripQuoted(t) {
  const lines = String(t || '').split(/\r?\n/);
  const marks = [
    /^\s*On .{5,120}\bwrote:\s*$/i,          // Gmail, Apple Mail
    /^\s*-{2,}\s*Original Message\s*-{2,}/i, // Outlook
    /^\s*_{10,}\s*$/,                        // Outlook's rule above a quoted block
    /^\s*From:\s.+\bSent:\s/i,               // Outlook header block on one line
    /^\s*>{1,}/                              // plain-text quoting
  ];
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (marks.some(re => re.test(lines[i]))) { cut = i; break; }
  }
  const kept = lines.slice(0, cut).join('\n').trim();
  /* If the cut leaves nothing, the message WAS the quote -- a bare forward, usually.
     Better to keep the lot than to file an empty message against a deal. */
  return kept || String(t || '').trim();
}

function bodyOf(e) {
  const txt = String(e.body_text || '').trim();
  const raw = txt || htmlToText(e.body_html) || String(e.snippet || '').trim();
  return stripQuoted(raw).slice(0, 20000);
}

/* The sync itself, with no HTTP around it, so the ten-minute timer and anything else
   that wants it share one implementation rather than two that drift. */
async function runMessageSync() {
  const toks = await sb('gmail_tokens?email=eq.' + encodeURIComponent(MAILBOX)
    + '&select=profile_id');
  const pids = [...new Set((toks || []).map(t => t.profile_id).filter(Boolean))];
  if (!pids.length) {
    return { ok: false, matched: 0, written: 0,
             note: MAILBOX + ' is not connected to any account yet' };
  }

  const deals = await sb('growth_clients?select=id,email');
  const byAddr = new Map();
  (deals || []).forEach(d => {
    const e = String(d.email || '').trim().toLowerCase();
    if (e) byAddr.set(e, d.id);
  });
  if (!byAddr.size) {
    return { ok: true, matched: 0, written: 0, note: 'No deal has an email address yet' };
  }

  const addrs = [...byAddr.keys()];
  const cols = 'gmail_id,thread_id,from_email,to_emails,subject,snippet,body_text,body_html,received_at';
  /* Encoded like the two address filters below it. The quotes and parentheses a
     PostgREST list needs are legal in a query string by accident rather than by rule,
     and the one that is left raw is the one that breaks on a value nobody foresaw. */
  const pidF = 'profile_id=in.' + encodeURIComponent(inList(pids));

  /* TWO QUERIES, NOT ONE. A message is theirs or ours, and the two are found different
     ways: inbound by who sent it, outbound by who it went to. PostgREST can OR them in
     one request, but the OR has to carry an array-overlap operator inside it and the
     resulting filter string is the kind nobody can read six months later. */
  const found = [];
  for (const part of chunks(addrs, CHUNK)) {
    found.push(...(await sb('emails?' + pidF
      + '&from_email=in.' + encodeURIComponent(inList(part))
      + '&select=' + cols) || []));
    found.push(...(await sb('emails?' + pidF
      + '&or=' + encodeURIComponent(likeAny('to_emails', part))
      + '&select=' + cols) || []));
  }

  /* DEDUPE ON THE GMAIL ID. growth@ is connected to two accounts, so `emails` holds the
     same message once per account: 4,060 rows for 3,392 messages. Without this the
     Inbox shows every reply twice, and the upsert fights itself over one external_id
     within a single request, which PostgREST rejects outright. The two queries above
     can also return the same row twice when we are both sender and recipient. */
  const seen = new Set();
  const rows = [];
  for (const e of found) {
    if (!e.gmail_id || seen.has(e.gmail_id)) continue;
    seen.add(e.gmail_id);

    const from = String(e.from_email || '').trim().toLowerCase();
    const to = addrsIn(e.to_emails);

    /* Direction is decided by the deal, not by the mailbox: a message is inbound when
       the person on the deal sent it. Checking "is it from growth@" instead would call
       a forward from a colleague an inbound reply from the client. */
    let clientId = byAddr.get(from);
    let direction = 'in';
    if (!clientId) {
      const hit = to.find(a => byAddr.has(a));
      if (!hit) continue;             // matched the filter but not a deal we can name
      clientId = byAddr.get(hit);
      direction = 'out';
    }

    rows.push({
      client_id: clientId,
      direction: direction,
      subject: String(e.subject || '').slice(0, 500),
      body: bodyOf(e),
      sent_at: e.received_at,
      thread_id: e.thread_id || null,
      external_id: e.gmail_id
    });
  }

  if (!rows.length) {
    return { ok: true, matched: 0, written: 0,
             note: 'No mail in ' + MAILBOX + ' matches a deal address' };
  }

  /* merge-duplicates, so a second run rewrites rather than failing on the unique
     external_id. Written in batches because one 500-row POST is one thing that either
     works or does not, and 34 rows today says nothing about 3,400 later. */
  let written = 0;
  for (const part of chunks(rows, 200)) {
    const back = await sb('growth_messages?on_conflict=external_id', 'POST', part,
      'return=representation,resolution=merge-duplicates');
    written += (back || []).length;
  }

  const ins = rows.filter(r => r.direction === 'in').length;
  return {
    ok: true,
    matched: rows.length,
    written: written,
    inbound: ins,
    outbound: rows.length - ins,
    deals: new Set(rows.map(r => r.client_id)).size,
    note: rows.length + ' message' + (rows.length === 1 ? '' : 's') + ' on '
        + new Set(rows.map(r => r.client_id)).size + ' deal'
        + (new Set(rows.map(r => r.client_id)).size === 1 ? '' : 's')
  };
}

module.exports = { runMessageSync, stripQuoted, htmlToText, bodyOf, inList, likeAny, addrsIn, chunks };
