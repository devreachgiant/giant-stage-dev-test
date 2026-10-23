/* More than one Gmail account per person.  Run:  node tools_gmail_accounts_check.mjs

   gmail_tokens was PRIMARY KEY (profile_id): one row each, so connecting a second
   mailbox overwrote the first. It is keyed (profile_id, slot) now (20261022210000).

   The checks below are MEASUREMENTS against the mock database rather than assertions
   that a function exists, because the ways this breaks are all quiet ones:

     - maybeSingle() ERRORS when a second row exists. Every read of this table had one,
       so adding an account would have broken sending for the account that worked. The
       check reads a token with two mailboxes present, which is the exact case that used
       to throw.
     - the token the browser holds belongs to the mailbox it was fetched for, so
       switching mailboxes has to drop it. Keeping it sends the next email from the
       wrong address -- and the screen would still say the right one.
     - a mailbox with no refresh token is an old implicit-flow row that will stop
       working within the hour. The fixture has one of each so "says it is lasting"
       cannot pass by saying that about everything.
*/
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const MOCK = readFileSync(path.join(HERE, 'tools_newchat_mock_supabase.js'), 'utf8');

let chromium;
{
  const pick = (m) => (m && m.chromium) || (m && m.default && m.default.chromium);
  const tries = ['playwright', ...['/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules',
    path.join(process.env.HOME || '', '.npm-global/lib/node_modules')]
    .map(d => pathToFileURL(path.join(d, 'playwright', 'index.js')).href)];
  for (const t of tries) { try { chromium = pick(await import(t)); } catch { /* next */ } if (chromium) break; }
  if (!chromium) { console.error('playwright not found.'); process.exit(2); }
}

const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.join(HERE, rel);
  if (!file.startsWith(HERE)) { res.writeHead(403).end(); return; }
  try {
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + server.address().port;

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); return !!pass; };
const step = async (label, fn) => {
  try { return await fn(); }
  catch (e) { check(label, false, 'threw: ' + String(e.message || e).slice(0, 200)); return null; }
};

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e.message || e).slice(0, 160)));
await page.route('**/@supabase/supabase-js@2*', r =>
  r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
await page.route('**://*.supabase.co/**', r => r.abort());

// The exchange and the refresh both live in a Netlify function, which is not running
// here. Stubbed so the browser half can be driven; the function has its own checks.
await page.route('**/.netlify/functions/google-oauth', r => {
  const body = JSON.parse(r.request().postData() || '{}');
  if (body.action === 'refresh') {
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ access_token: 'refreshed-token', expires_in: 3600 }) });
  }
  return r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ access_token: 'new-token', refresh_token: 'new-refresh',
                           expires_in: 3600, email: 'third@reachgiant.com' }) });
});

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('#view-app.on', { timeout: 30000 });
await page.waitForTimeout(2500);

await step('the app lists every connected mailbox', async () => {
  const rows = await page.evaluate(() => window.giantGmailAccounts ? window.giantGmailAccounts() : null);
  check('the accounts API is there', !!rows, String(rows));
  if (!rows) return;
  check('both mailboxes come back', rows.length === 2, JSON.stringify(rows.map(r => r.email)));
  check('each one knows its slot', rows[0].slot === 1 && rows[1].slot === 2,
    JSON.stringify(rows.map(r => r.slot)));
  // The difference that matters: one keeps itself signed in, the other does not.
  check('it says which will stay signed in',
    rows[0].lasting === true && rows[1].lasting === false,
    JSON.stringify(rows.map(r => r.email + ':' + r.lasting)));
  // The refresh token itself must never reach the page.
  check('and no refresh token is handed to the page',
    rows.every(r => !('refresh_token' in r)), JSON.stringify(Object.keys(rows[0])));
});

await step('a token can be fetched while two mailboxes exist', async () => {
  // This is the case that used to throw: maybeSingle() with two rows is an error, so
  // sending broke for everybody the moment a second account was added.
  const ok = await page.evaluate(async () => {
    try { return { ready: await window.giantGmailReady() }; }
    catch (e) { return { threw: String(e.message || e) }; }
  });
  check('asking whether Gmail is ready does not throw', !ok.threw, JSON.stringify(ok));
  check('and it says yes', ok.ready === true, JSON.stringify(ok));
});

await step('switching mailbox drops the token that belonged to the old one', async () => {
  const before = await page.evaluate(() => ({
    slot: Number(localStorage.getItem('giant.gmailSlot') || 1)
  }));
  const moved = await page.evaluate(() => window.giantGmailUse(2));
  check('switching to the second one is allowed', moved === true, String(moved));
  const after = await page.evaluate(() => Number(localStorage.getItem('giant.gmailSlot') || 1));
  check('the choice is remembered', after === 2, before.slot + ' -> ' + after);

  // Slot 2 is expired AND has no refresh token, so Giant must say it cannot send
  // rather than sending from the mailbox it happened to have a token for.
  const ready = await page.evaluate(async () => {
    try { return { ready: await window.giantGmailReady() }; }
    catch (e) { return { threw: String(e.message || e) }; }
  });
  check('an expired mailbox with no refresh token is not ready', ready.ready === false,
    JSON.stringify(ready));

  const back = await page.evaluate(() => window.giantGmailUse(1));
  check('and switching back works', back === true, String(back));
});

await step('a mailbox with a refresh token renews itself', async () => {
  const r = await page.evaluate(async () => {
    // Expire slot 1 in the database, exactly as time would.
    const row = window.__mockDB.gmail_tokens.find(x => x.slot === 1);
    row.expires_at = new Date(Date.now() - 60000).toISOString();
    try {
      const ready = await window.giantGmailReady();
      const now = window.__mockDB.gmail_tokens.find(x => x.slot === 1);
      return { ready, token: now.access_token, expires: now.expires_at };
    } catch (e) { return { threw: String(e.message || e) }; }
  });
  check('an expired mailbox with a refresh token is still ready', r.ready === true, JSON.stringify(r));
  // Renewed through the function and WRITTEN BACK: a token refreshed in memory only
  // means the next page load starts expired again.
  check('the new token is saved to the database', r.token === 'refreshed-token', String(r.token));
  check('with a new expiry', new Date(r.expires).getTime() > Date.now(), String(r.expires));
});

await step('switching to a mailbox that is not connected is refused', async () => {
  const no = await page.evaluate(() => window.giantGmailUse(7));
  check('an empty slot cannot be chosen', no === false, String(no));
  const slot = await page.evaluate(() => Number(localStorage.getItem('giant.gmailSlot') || 1));
  check('and the choice is left alone', slot === 1, String(slot));
});

await step('Growth reads the mailbox without tripping over the second one', async () => {
  /* Growth asks the Email screen whether Gmail works and which address it sends from.
     It used to read gmail_tokens itself with maybeSingle on profile_id alone, which
     ERRORS with two mailboxes -- and its catch turned that into "Gmail not connected"
     on a connection that was fine. Driven with both mailboxes present, which is the
     case that broke it. */
  const r = await page.evaluate(async () => {
    try { window.giantCurrentProfile.role = 'owner'; } catch (e) { /* fixture */ }
    if (!window.grInit) return { noGrowth: true };
    window.grInit('gr_connectors');
    await new Promise(res => setTimeout(res, 1500));
    const row = document.querySelector('[data-gr-conn="gmail"]');
    return {
      state: row ? (row.querySelector('.gr_st') || {}).textContent.trim() : null,
      says: row ? (row.querySelector('.gr_rm span') || {}).textContent.trim() : null
    };
  });
  if (r.noGrowth) { check('Growth is on the page to ask', false, 'grInit missing'); return; }
  // Connected, and naming the mailbox it would send from -- not "Not connected".
  check('Growth says Gmail is connected', /Connected/i.test(r.state || ''), JSON.stringify(r));
  check('and names the address it would send from',
    /@/.test(r.says || ''), JSON.stringify(r));
});

await step('when Google refuses, the app says so', async () => {
  /* "Access blocked" sends the person back to the app with error=access_denied on the
     URL. That was written to sessionStorage and never read, so the screen still said
     Not connected and gave no reason at all. */
  const said = await page.evaluate(async () => {
    const seen = [];
    const realToast = window.toast;
    window.toast = (o) => { seen.push(o); };
    try {
      sessionStorage.setItem('gmail_oauth_error', 'access_denied');
      await window.__gmailCallbackForTest();
    } finally { window.toast = realToast; }
    return { seen, left: sessionStorage.getItem('gmail_oauth_error') };
  });
  check('something is said at all', said.seen.length === 1, JSON.stringify(said.seen));
  if (!said.seen.length) return;
  const m = said.seen[0];
  check('and it is reported as a failure', m.type === 'error', m.type);
  // access_denied means EITHER cancelled OR not on the tester list. Telling somebody to
  // "try again" when their address is not approved is the wrong advice, so both have to
  // be in the words.
  check('it covers being cancelled', /cancel/i.test(m.message || ''), m.message);
  check('and not being approved yet', /approved list|Internal/i.test(m.message || ''), m.message);
  check('the error is cleared so it cannot repeat on the next load', !said.left, String(said.left));
});

/* LAST ON PURPOSE. This one really does send the browser to Google -- that is what
   connecting an account now does -- and the page is gone from that point on, so any
   step after it would fail with "execution context was destroyed" and look like a bug
   in the thing it was checking. */
await step('adding an account takes the next free slot', async () => {
  const where = await page.evaluate(() => {
    // Don't actually leave the page: record where it was about to send us.
    let went = null;
    const d = Object.getOwnPropertyDescriptor(window.location, 'href');
    window.__go = (u) => { went = u; };
    return new Promise((resolve) => {
      const orig = window.giantGmailAddAccount;
      // startGmailOAuth sets location.href; capture it by stubbing the setter is not
      // possible on location, so read the slot it recorded in sessionStorage instead.
      orig().then(() => {
        resolve({ slot: sessionStorage.getItem('gmail_oauth_slot'),
                  state: sessionStorage.getItem('gmail_oauth_state') });
      });
    });
  });
  check('it picks slot 3, the first one free', where && where.slot === '3', JSON.stringify(where));
  check('and says it is Gmail asking, so the callback knows',
    where && /^gmail_3_/.test(where.state || ''), JSON.stringify(where));
});

const real = pageErrors.filter(e => !/supabase\.(co|in)/.test(e));
check('no uncaught page errors', real.length === 0, real.slice(0, 3).join(' | '));

for (const r of results) console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   ' + r.detail : ''));
const bad = results.filter(r => !r.pass);
console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' checks passed');
console.log(bad.length ? 'RESULT: ' + bad.length + ' FAILED' : 'RESULT: clean');
await browser.close();
server.close();
process.exit(bad.length ? 1 : 0);
