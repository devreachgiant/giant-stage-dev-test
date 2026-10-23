/* The Gmail sync engine.  Run:  node tools_gmail_sync_check.mjs

   This logic used to live in the page, where a browser check could drive it. It is in
   netlify/functions/_gmail.js now, so it is exercised here directly with Gmail and
   Supabase both stubbed -- no network, no database, no tokens.

   What it has to get right, and what went wrong before each rule existed:

     only download what is new     every sync fetched the full body of all ~370
                                   messages in the window and then discarded the ones
                                   already stored. That cost is why the window had to
                                   stay at 100, which is why Giant held 73 messages
                                   against a Gmail inbox of 886.

     notice removals               the old sync could only ADD. Archive or delete a
                                   message in Gmail and the row sat in Giant for ever,
                                   so the two lists drifted apart from the first day.

     notice label changes          read it on your phone, star it from the web -- none
                                   of it reached Giant.

     survive an expired cursor     Google keeps about a week of history. Past that it
                                   answers 404, and anything that treated that as an
                                   error would stop syncing forever rather than for a
                                   week.

     survive a revoked mailbox     one dead refresh token must not stop the scheduled
                                   run from doing everyone else's.
*/
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const HERE = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const require = createRequire(import.meta.url);

process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-key';
process.env.GOOGLE_CLIENT_SECRET = 'stub-secret';

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); return !!pass; };
/* A scenario that throws is not a scenario that passed, and it must not take the rest
   of the run down with it: removing the 404 branch made the engine throw, the harness
   died, and the output showed no failure at all -- which looked exactly like success
   to anything reading the exit summary. */
const scenario = async (label, fn) => {
  try { await fn(); }
  catch (e) { check(label, false, 'threw: ' + String(e.message || e).slice(0, 140)); }
};

// ── The world the engine talks to ────────────────────────────────────────────
let db;            // gmail_id -> row
let gmail;         // { messages, history, historyId, profile }
let calls;         // what the engine asked for

function resetWorld() {
  db = new Map();
  calls = { detail: [], list: 0, history: 0, deleted: [], upserted: [], patched: [], refresh: 0 };
  gmail = { messages: new Map(), history: [], historyId: '5000', historyStatus: 200, refreshOk: true, refreshDead: false };
}

const msg = (id, labels = ['INBOX'], subject = 'Subject ' + id) => ({
  id, threadId: 't-' + id, labelIds: labels, snippet: 's-' + id,
  internalDate: String(Date.parse('2026-10-20T10:00:00Z')),
  payload: { headers: [{ name: 'From', value: 'Someone <someone@example.com>' },
                       { name: 'To', value: 'me@example.com' },
                       { name: 'Subject', value: subject }],
             parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('hello ' + id).toString('base64url') } }] }
});

/* Stubbed at the fetch boundary rather than by rewriting the module, so what is
   measured is the requests the engine actually makes. */
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (body, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body)
  });

  // ── Google token endpoint (via google-oauth.refresh) ──
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    calls.refresh++;
    if (gmail.refreshDead) return json({ error: 'invalid_grant' }, 400);
    if (!gmail.refreshOk) return json({ error: 'invalid_client' }, 400);
    return json({ access_token: 'fresh-token', expires_in: 3600, scope: 'x' });
  }

  // ── Gmail ──
  if (u.includes('gmail.googleapis.com')) {
    const tail = u.split('/users/me/')[1];
    if (tail.startsWith('profile')) return json({ historyId: gmail.historyId });
    if (tail.startsWith('history')) {
      calls.history++;
      if (gmail.historyStatus === 404) return json({ error: { message: 'historyId too old' } }, 404);
      return json({ history: gmail.history });
    }
    if (tail.startsWith('messages?')) { calls.list++; return json({ messages: [...gmail.messages.keys()].map(id => ({ id, threadId: 't-' + id })) }); }
    if (tail.startsWith('messages/')) {
      const id = tail.split('messages/')[1].split('?')[0];
      calls.detail.push(id);
      const m = gmail.messages.get(id);
      return m ? json(m) : json({ error: { message: 'Not Found' } }, 404);
    }
  }

  // ── Supabase REST ──
  if (u.startsWith(process.env.SUPABASE_URL)) {
    const rest = u.slice((process.env.SUPABASE_URL + '/rest/v1/').length);
    const method = opts.method || 'GET';
    if (rest.startsWith('emails')) {
      if (method === 'GET') {
        const inList = /gmail_id=in\.\(([^)]*)\)/.exec(rest);
        const want = inList ? inList[1].split(',') : [...db.keys()];
        return json(want.filter(id => db.has(id)).map(id => ({ gmail_id: id })));
      }
      if (method === 'POST') {
        const rows = JSON.parse(opts.body);
        rows.forEach(r => { calls.upserted.push(r.gmail_id); db.set(r.gmail_id, r); });
        return json([]);
      }
      if (method === 'DELETE') {
        const inList = /gmail_id=in\.\(([^)]*)\)/.exec(rest);
        (inList ? inList[1].split(',') : []).forEach(id => { calls.deleted.push(id); db.delete(id); });
        return json([]);
      }
    }
    if (rest.startsWith('gmail_tokens')) {
      if (method === 'PATCH') { calls.patched.push(JSON.parse(opts.body)); return json([]); }
      return json([]);
    }
  }
  throw new Error('unexpected request: ' + u);
};

const { syncMailbox } = require(path.join(HERE, 'netlify/functions/_gmail.js'));
const MAILBOX = (over = {}) => Object.assign(
  { profile_id: 'p-1', slot: 1, email: 'me@example.com',
    refresh_token: 'r-1', history_id: null }, over);

// ── 1. First sync: full scan, and only what is missing ───────────────────────
await scenario("First sync: full scan, and only what is missing", async () => {
  resetWorld();
  for (let i = 1; i <= 6; i++) gmail.messages.set('m' + i, msg('m' + i));
  ['m1', 'm2'].forEach(id => db.set(id, { gmail_id: id }));   // already stored
  const r = await syncMailbox(MAILBOX());
  check('a mailbox with no cursor does a full scan', r.ok && r.mode === 'full', JSON.stringify(r));
  check('it downloads only the messages it does not have',
    calls.detail.sort().join(',') === 'm3,m4,m5,m6', calls.detail.join(','));
  check('and stores exactly those', calls.upserted.sort().join(',') === 'm3,m4,m5,m6', calls.upserted.join(','));
  check('the cursor is written down for next time',
    calls.patched.some(p => p.history_id === '5000'), JSON.stringify(calls.patched));
  check('along with the renewed token',
    calls.patched.some(p => p.access_token === 'fresh-token'), '');
});

// ── 2. Nothing has happened ──────────────────────────────────────────────────
await scenario("Nothing has happened", async () => {
  resetWorld();
  for (let i = 1; i <= 6; i++) { gmail.messages.set('m' + i, msg('m' + i)); db.set('m' + i, {}); }
  const r = await syncMailbox(MAILBOX({ history_id: '4000' }));
  check('with a cursor it asks what changed instead of listing everything',
    calls.history === 1 && calls.list === 0, 'history=' + calls.history + ' list=' + calls.list);
  check('a quiet mailbox downloads nothing at all', calls.detail.length === 0, calls.detail.join(','));
  check('and deletes nothing', calls.deleted.length === 0, calls.deleted.join(','));
});

// ── 3. One new message ───────────────────────────────────────────────────────
await scenario("One new message", async () => {
  resetWorld();
  for (let i = 1; i <= 3; i++) { gmail.messages.set('m' + i, msg('m' + i)); db.set('m' + i, {}); }
  gmail.messages.set('new1', msg('new1'));
  gmail.history = [{ messagesAdded: [{ message: { id: 'new1' } }] }];
  const r = await syncMailbox(MAILBOX({ history_id: '4000' }));
  check('a new message is fetched', calls.detail.join(',') === 'new1', calls.detail.join(','));
  check('and only it', calls.detail.length === 1, String(calls.detail.length));
  check('it lands in the database', db.has('new1'), [...db.keys()].join(','));
});

// ── 4. Archived or deleted in Gmail leaves Giant ─────────────────────────────
await scenario("Archived or deleted in Gmail leaves Giant", async () => {
  resetWorld();
  ['m1', 'm2', 'm3'].forEach(id => { gmail.messages.set(id, msg(id)); db.set(id, {}); });
  gmail.messages.delete('m2');
  gmail.history = [{ messagesDeleted: [{ message: { id: 'm2' } }] }];
  const r = await syncMailbox(MAILBOX({ history_id: '4000' }));
  // The whole point of the change: the old sync could only ever add.
  check('a message deleted in Gmail is removed here', !db.has('m2'), [...db.keys()].join(','));
  check('and it was the only one removed', calls.deleted.join(',') === 'm2', calls.deleted.join(','));
  check('the others are untouched', db.has('m1') && db.has('m3'), [...db.keys()].join(','));
});

// ── 5. Read somewhere else ───────────────────────────────────────────────────
await scenario("Read somewhere else", async () => {
  resetWorld();
  gmail.messages.set('m1', msg('m1', ['INBOX']));            // no UNREAD any more
  db.set('m1', { gmail_id: 'm1', is_unread: true });          // Giant still thinks unread
  gmail.history = [{ labelsRemoved: [{ message: { id: 'm1' } }] }];
  const r = await syncMailbox(MAILBOX({ history_id: '4000' }));
  check('a label change re-reads the message', calls.detail.join(',') === 'm1', calls.detail.join(','));
  check('read-elsewhere stops being unread here', db.get('m1').is_unread === false,
    JSON.stringify(db.get('m1') && db.get('m1').is_unread));
});

// ── 6. Starred from the web ──────────────────────────────────────────────────
await scenario("Starred from the web", async () => {
  resetWorld();
  gmail.messages.set('m1', msg('m1', ['INBOX', 'STARRED']));
  db.set('m1', { gmail_id: 'm1', is_starred: false });
  gmail.history = [{ labelsAdded: [{ message: { id: 'm1' } }] }];
  const r = await syncMailbox(MAILBOX({ history_id: '4000' }));
  check('a star added in Gmail shows up here', db.get('m1').is_starred === true,
    JSON.stringify(db.get('m1') && db.get('m1').is_starred));
});

// ── 7. A cursor Google has expired ───────────────────────────────────────────
await scenario("A cursor Google has expired", async () => {
  resetWorld();
  for (let i = 1; i <= 4; i++) gmail.messages.set('m' + i, msg('m' + i));
  db.set('m1', {});
  gmail.historyStatus = 404;
  const r = await syncMailbox(MAILBOX({ history_id: 'ancient' }));
  /* Google keeps about a week. Treating 404 as an error would have stopped this mailbox
     syncing for good rather than for a week. */
  check('an expired cursor falls back to a full scan', r.ok && r.mode === 'full', JSON.stringify(r));
  check('and catches up on what it missed',
    calls.detail.sort().join(',') === 'm2,m3,m4', calls.detail.join(','));
  check('a fresh cursor replaces the dead one',
    calls.patched.some(p => p.history_id === '5000'), JSON.stringify(calls.patched));
});

// ── 8. A mailbox whose access was revoked ────────────────────────────────────
await scenario("A mailbox whose access was revoked", async () => {
  resetWorld();
  gmail.refreshDead = true;
  const r = await syncMailbox(MAILBOX({ history_id: '4000' }));
  check('a revoked mailbox reports rather than throwing', r.ok === false && r.dead === true,
    JSON.stringify(r));
  check('its dead refresh token is cleared, so it stops being retried',
    calls.patched.some(p => Object.prototype.hasOwnProperty.call(p, 'refresh_token')
      && p.refresh_token === null), JSON.stringify(calls.patched));
  check('and nothing was synced for it', calls.detail.length === 0 && calls.history === 0, '');
});

// ── 9. A mailbox connected before refresh tokens existed ─────────────────────
await scenario("A mailbox connected before refresh tokens existed", async () => {
  resetWorld();
  const r = await syncMailbox(MAILBOX({ refresh_token: null }));
  check('a mailbox with no refresh token is skipped, with a reason',
    r.ok === false && /reconnect/i.test(r.skipped || ''), JSON.stringify(r));
  check('it does not even try to renew', calls.refresh === 0, String(calls.refresh));
});

// ── 10. A first scan bigger than one invocation can manage ──────────────────
await scenario('A mailbox too big for one run', async () => {
  resetWorld();
  for (let i = 1; i <= 300; i++) gmail.messages.set('b' + i, msg('b' + i));
  const r = await syncMailbox(MAILBOX());
  /* 26 seconds per function. One account here had 73 stored against 886 in Gmail;
     fetching all of them in one invocation times out, and because the cursor is only
     written on a completed scan the run would record nothing and the next would start
     over -- failing every ten minutes for ever while creeping forward on whatever it
     managed before being killed. */
  check('it takes a bite rather than the whole mailbox',
    calls.detail.length === 120, 'fetched=' + calls.detail.length);
  check('and says it has not finished', r.done === false && r.remaining === 180,
    JSON.stringify({ done: r.done, remaining: r.remaining }));
  /* The cursor must NOT be set here. History only describes what changes from that
     point on, so recording one mid-scan would mean every message older than this bite
     is never fetched by anything, ever. */
  check('no cursor is recorded part way through',
    calls.patched.every(p => !('history_id' in p)), JSON.stringify(calls.patched));
  check('but the renewed token still is',
    calls.patched.some(p => p.access_token === 'fresh-token'), '');
});

// ── 11. and the run after it carries on ─────────────────────────────────────
await scenario('The next run continues where it stopped', async () => {
  resetWorld();
  for (let i = 1; i <= 300; i++) gmail.messages.set('b' + i, msg('b' + i));
  await syncMailbox(MAILBOX());                 // run 1: 120
  const afterOne = db.size;
  await syncMailbox(MAILBOX());                 // run 2: next 120
  const afterTwo = db.size;
  const r3 = await syncMailbox(MAILBOX());      // run 3: the last 60, finished
  check('each run gets through another bite', afterOne === 120 && afterTwo === 240,
    afterOne + ' then ' + afterTwo);
  check('and it does converge', db.size === 300 && r3.done === true,
    db.size + ' stored, done=' + r3.done);
  check('the cursor is written once it is actually complete',
    calls.patched.some(p => p.history_id === '5000'), JSON.stringify(calls.patched.slice(-1)));
  // Nothing is downloaded twice across the three runs.
  check('no message is fetched more than once',
    new Set(calls.detail).size === calls.detail.length,
    calls.detail.length + ' fetches, ' + new Set(calls.detail).size + ' distinct');
});

for (const r2 of results) console.log((r2.pass ? 'PASS  ' : 'FAIL  ') + r2.name + (r2.detail ? '   ' + r2.detail : ''));
const bad = results.filter(x => !x.pass);
console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' checks passed');
console.log(bad.length ? 'RESULT: ' + bad.length + ' FAILED' : 'RESULT: clean');
process.exit(bad.length ? 1 : 0);
