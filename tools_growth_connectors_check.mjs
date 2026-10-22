/* Connectors, driven.  Run:  node tools_growth_connectors_check.mjs
   (SHOT_DIR=/some/dir to also write screenshots of what it measured.)

   Connectors used to be a list that told you the bad news and stopped. Every row opens
   now, and three of the five genuinely connect from inside the app. The Netlify
   functions do not exist in this harness, so they are STUBBED HERE with a little server
   that behaves like the real one: it refuses a bad Calendly token with the same shape of
   error, and only reports connected once a good one has been handed over. That is what
   lets the check drive the whole flow -- type a token, be refused, type a real one, watch
   the row change -- instead of asserting that a button exists.

   Every check is chosen so it FAILS on what was there before:
     - the rows were divs that navigated away. Opening one and reading the panel could
       not have passed a week ago.
     - "Connected" is only ever asserted AFTER driving the thing that connects it, never
       from a fixture that starts green.
     - the Zoom panel is asserted to have NO token box, because Zoom is shared with
       Bookings and its credentials stay in Netlify. A check that let a token box appear
       there would be blessing the pretence this change was meant to remove.
*/
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
const MOCK = readFileSync(path.join(HERE, 'tools_newchat_mock_supabase.js'), 'utf8');

// playwright is a dev tool here, not a dependency of the app, so a global install is
// the normal case and worth resolving rather than demanding a local one.
let chromium;
{
  // playwright's entry point is CommonJS, so a namespace import puts it on .default
  // when it is loaded by path rather than by name.
  const pick = (m) => (m && m.chromium) || (m && m.default && m.default.chromium);
  const tries = ['playwright', ...['/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules',
    path.join(process.env.HOME || '', '.npm-global/lib/node_modules')]
    .map(d => pathToFileURL(path.join(d, 'playwright', 'index.js')).href)];
  for (const t of tries) {
    try { chromium = pick(await import(t)); } catch { /* next */ }
    if (chromium) break;
  }
  if (!chromium) {
    console.error('playwright not found. Install it with:  npm i -g playwright && npx playwright install chromium');
    process.exit(2);
  }
}

// Serve the repo ourselves, so this is one command and index.html is fetched over
// http -- file:// resolves /config.js differently and the app never boots.
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
                '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';   // the app is one page, any path
  const file = path.join(HERE, rel);
  if (!file.startsWith(HERE)) { res.writeHead(403).end(); return; }
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = process.env.BASE_URL || 'http://127.0.0.1:' + server.address().port;

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); return !!pass; };

const browser = await chromium.launch();
// Clipboard permission, because "copy link" is a feature now and a check that cannot read
// the clipboard can only assert that a button was clicked.
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 },
  permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
const blocked = [];
page.on('console', m => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400));
  if (m.type() === 'warning' && /newchat/.test(m.text())) consoleErrors.push('WARN ' + m.text().slice(0, 300));
});
// The message alone says what broke but never where. A stack turns "cannot read
// properties of null" into a line number, which is the difference between a fix and a
// hunt -- and this one only appears in some runs, so the run that catches it has to
// carry enough to act on.
page.on('pageerror', e => pageErrors.push(
  String(e.message || e).slice(0, 200)
  + ' @ ' + String(e.stack || '').split('\n').slice(1, 4).map(l => l.trim()).join(' <- ').slice(0, 300)));

// A bare "Failed to load resource" in the console says nothing about which host. Record
// the failures themselves so an external dependency is distinguishable from a real bug.
const failedReqs = [];
page.on('requestfailed', r => failedReqs.push(
  (r.failure() && r.failure().errorText || 'failed') + ' ' + r.url().slice(0, 110)));

// Playwright dismisses dialogs by default, so every confirm() reads as "no" and the
// guarded path never runs -- which looked like a broken control rather than a
// cancelled one. Accept them, and record what was asked.
const dialogs = [];
page.on('dialog', d => { dialogs.push(d.type() + ': ' + d.message().slice(0, 120)); d.accept().catch(() => {}); });

// The destructive paths use the app's own dialog (#giantConfirmWarnOverlay), not the
// browser's, so accepting native dialogs is not enough -- an in-page overlay just sits
// there and the awaited promise never settles. This polls for it and presses the
// confirm button, which is the last button in the overlay.
const confirmWatcher = setInterval(() => {
  page.evaluate(() => {
    const ov = document.getElementById('giantConfirmWarnOverlay');
    if (!ov) return null;
    const btns = [...ov.querySelectorAll('button')];
    const ok = btns[btns.length - 1];
    if (ok) { ok.click(); return ok.textContent; }
    return null;
  }).then(t => { if (t) dialogs.push('app-confirm: ' + t); }).catch(() => {});
}, 250);

await page.route('**/@supabase/supabase-js@2*', r =>
  r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
await page.route('**://*.supabase.co/**', r => { blocked.push(r.url().slice(0, 120)); r.abort(); });
await page.route('**://*.supabase.in/**', r => { blocked.push(r.url().slice(0, 120)); r.abort(); });

const step = async (label, fn) => {
  try { return await fn(); }
  catch (e) { check(label, false, 'threw: ' + String(e.message || e).slice(0, 200)); return null; }
};

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });

// ── the app itself must get past the gate ────────────────────────────────────
await step('app boots past the sign-in gate', async () => {
  await page.waitForSelector('#view-app.on', { timeout: 30000 });
  check('app boots past the sign-in gate', true);
});


const shotDir = process.env.SHOT_DIR || '';
const shot = async (name) => { if (shotDir) await page.screenshot({ path: shotDir + '/' + name + '.png' }); };
const navOf = (s) => page.locator('#appSidebar .nav-item[data-screen="' + s + '"]');

/* ── a stand-in for the Netlify functions ──────────────────────────────────── */
const GOOD = 'eyJraWQiOiJnb29kLXRva2VuIn0.real';
const fake = { calendlyToken: '', zoom: false, claudeCalls: 0, saves: [] };

await page.route('**/.netlify/functions/growth-calendly*', async (route) => {
  const url = new URL(route.request().url());
  const action = url.searchParams.get('action') || 'status';
  const send = (code, body) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
  if (action === 'status') {
    return send(200, fake.calendlyToken
      ? { configured: true, who: 'luke@reachgiant.com', source: 'app' }
      : { configured: false, who: '', source: '' });
  }
  if (action === 'save') {
    let tok = '';
    try { tok = JSON.parse(route.request().postData() || '{}').token || ''; } catch (e) { /* below */ }
    fake.saves.push(tok);
    if (tok !== GOOD) {
      return send(400, { error: 'Calendly would not accept that token. Check you copied the whole thing.' });
    }
    fake.calendlyToken = tok;
    return send(200, { configured: true, who: 'luke@reachgiant.com', source: 'app' });
  }
  if (action === 'disconnect') { fake.calendlyToken = ''; return send(200, { configured: false, source: '', note: 'Calendly is disconnected.' }); }
  if (action === 'sync') return send(200, { added: 0, updated: 0, total: 0, note: 'No bookings in range.' });
  return send(400, { error: 'unknown action' });
});

await page.route('**/.netlify/functions/bookings-api*', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ configured: fake.zoom }) }));

await page.route('**/.netlify/functions/claude-api', (route) => {
  fake.claudeCalls++;
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'ready' }) });
});

await step('open Growth and Connectors', async () => {
  await page.locator('.nav-group-label[data-navgroup="growth"]').click();
  await page.waitForTimeout(350);
  // The Email screen is not booted in this harness, so Growth would find no
  // giantGmailConnect. Stand one in that behaves like a user who says yes.
  // Stand in for BOTH halves of the contract Growth depends on: the one that connects,
  // and the one that says whether the token is usable. Growth asks the second after the
  // first, on purpose, so stubbing only the first would test a path that cannot happen.
  await page.evaluate(() => {
    window.__gmailOn = false;
    window.giantGmailConnect = async () => { window.__gmailAsked = true; window.__gmailOn = true; return true; };
    window.giantGmailReady = async () => !!window.__gmailOn;
  });
  await navOf('gr_connectors').click();
  await page.waitForFunction(() => {
    const el = document.getElementById('grConnectors');
    return el && el.querySelectorAll('[data-gr-conn]').length >= 5;
  }, null, { timeout: 15000 }).catch(() => {});
  check('Connectors paints its rows', await page.locator('#grConnectors [data-gr-conn]').count() === 5);
  await shot('20-connectors');
});

await step('every connector is listed, and says where it stands', async () => {
  const m = await page.evaluate(() => [...document.querySelectorAll('#grConnectors [data-gr-conn]')].map(b => ({
    k: b.dataset.grConn,
    name: (b.querySelector('b') || {}).textContent,
    why: (b.querySelector('.gr_rm span') || {}).textContent,
    state: (b.querySelector('.gr_st') || {}).textContent,
    lamp: (b.querySelector('.gr_lt') || {}).className,
    chev: !!b.querySelector('.gr_cnc'),
    w: Math.round(b.getBoundingClientRect().width)
  })));
  check('all five are there',
    JSON.stringify(m.map(x => x.k)) === JSON.stringify(['gmail', 'calendly', 'zoom', 'claude', 'fathom']),
    JSON.stringify(m.map(x => x.k)));
  check('each is named', m.every(x => x.name && x.name.length > 2), JSON.stringify(m.map(x => x.name)));
  check('each says why it matters, not just its state', m.every(x => (x.why || '').length > 20),
    JSON.stringify(m.map(x => (x.why || '').slice(0, 30))));
  check('each has a lamp and a state', m.every(x => /gr_(on|off|wait)/.test(x.lamp) && x.state), JSON.stringify(m.map(x => x.state)));
  // The old rows navigated away instead of opening. This is the line that fails on it.
  check('and each one opens', m.every(x => x.chev), JSON.stringify(m.map(x => x.chev)));
  check('none collapsed', m.every(x => x.w > 400), JSON.stringify(m.map(x => x.w)));
});

await step('a Not connected row opens and explains itself', async () => {
  await page.locator('[data-gr-conn="calendly"]').click();
  await page.waitForTimeout(350);
  const m = await page.evaluate(() => {
    const p = document.querySelector('#grConnectors .gr_cnp');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { what: (p.querySelector('.gr_cnwhat') || {}).textContent || '',
             how: (p.querySelector('.gr_cnhow') || {}).textContent || '',
             open: document.querySelectorAll('#grConnectors .gr_cnp').length,
             w: Math.round(r.width), h: Math.round(r.height) };
  });
  if (!m) { check('the panel opens', false); return; }
  check('the panel opens at a real size (' + m.w + 'x' + m.h + ')', m.w > 300 && m.h > 100);
  check('it says what Growth does with it', m.what.length > 40, m.what.slice(0, 70));
  check('and how to connect it', /Personal Access Token/i.test(m.how), m.how.slice(0, 70));
  check('only one panel is open at a time', m.open === 1, m.open + ' open');
});

await step('a bad Calendly token is refused, and nothing says connected', async () => {
  const box = page.locator('#grCalToken');
  check('there is somewhere to paste the token', await box.count() === 1);
  check('and it is a password field, not plain text',
    await box.getAttribute('type') === 'password');
  await box.fill('not-a-real-token');
  await page.locator('[data-gr-cal-save]').click();
  await page.waitForTimeout(700);
  const m = await page.evaluate(() => ({
    say: (document.querySelector('#grConnectors .gr_cstat') || {}).textContent || '',
    state: (document.querySelector('[data-gr-conn="calendly"] .gr_st') || {}).textContent || '',
    head: (document.querySelector('#grConnectors .gr_head p') || {}).textContent || ''
  }));
  check('the refusal is shown in the panel', /would not accept/i.test(m.say), m.say);
  // The point of refusing before storing: the screen must not go green on a typo.
  check('and the row still says Not connected', /Not connected/.test(m.state), m.state);
  check('the count at the top did not move', /0 of 5/.test(m.head), m.head);
  check('the server was asked to save exactly once', fake.saves.length === 1, JSON.stringify(fake.saves));
  check('and it refused to keep it', fake.calendlyToken === '', fake.calendlyToken);
});

await step('a good token connects it, for real', async () => {
  await page.locator('#grCalToken').fill(GOOD);
  await page.locator('[data-gr-cal-save]').click();
  await page.waitForTimeout(900);
  check('the server kept it', fake.calendlyToken === GOOD, fake.calendlyToken.slice(0, 12));
  const m = await page.evaluate(() => ({
    state: (document.querySelector('[data-gr-conn="calendly"] .gr_st') || {}).textContent || '',
    why: (document.querySelector('[data-gr-conn="calendly"] .gr_rm span') || {}).textContent || '',
    head: (document.querySelector('#grConnectors .gr_head p') || {}).textContent || '',
    lamp: (document.querySelector('[data-gr-conn="calendly"] .gr_lt') || {}).className || '',
    acts: [...document.querySelectorAll('#grConnectors .gr_cnp button')].map(b => b.innerText.trim()),
    tokenBox: document.querySelectorAll('#grCalToken').length
  }));
  check('the row flips to Connected', /Connected/.test(m.state) && !/Not/.test(m.state), m.state);
  check('the lamp goes green', /gr_on/.test(m.lamp), m.lamp);
  check('it names the account', /luke@reachgiant\.com/.test(m.why), m.why);
  check('the count at the top moves to 1 of 5', /1 of 5/.test(m.head), m.head);
  check('the token box is gone once it is connected', m.tokenBox === 0, m.tokenBox + '');
  check('and it offers Sync now and Disconnect',
    m.acts.some(a => /Sync now/.test(a)) && m.acts.some(a => /Disconnect/.test(a)), JSON.stringify(m.acts));
  // The whole promise of growth_secrets: the page cannot read it back.
  const leaked = await page.evaluate((t) => document.body.innerHTML.indexOf(t) >= 0, GOOD);
  check('the token is nowhere in the page afterwards', !leaked);
  // And it stops telling you how to connect something that is connected.
  const how = await page.evaluate(() => (document.querySelector('#grConnectors .gr_cnhow') || {}).textContent || '');
  check('the panel stops explaining how to connect it', !/Paste it below/i.test(how), how.slice(0, 90));
  check('and says how it stands instead', /read it back|holding the token/i.test(how), how.slice(0, 90));
  await shot('21-calendly-connected');
});

await step('Gmail connects from here, through the one place that knows how', async () => {
  await page.locator('[data-gr-conn="gmail"]').click();
  await page.waitForTimeout(350);
  const before = await page.evaluate(() => ({
    state: (document.querySelector('[data-gr-conn="gmail"] .gr_st') || {}).textContent || '',
    btn: (document.querySelector('[data-gr-conn-gmail]') || {}).innerText || '' }));
  check('it starts Not connected', /Not connected/.test(before.state), before.state);
  check('and offers to connect', /Connect Gmail/.test(before.btn), before.btn);
  await page.locator('[data-gr-conn-gmail]').click();
  await page.waitForTimeout(900);
  const m = await page.evaluate(() => ({
    asked: !!window.__gmailAsked,
    state: (document.querySelector('[data-gr-conn="gmail"] .gr_st') || {}).textContent || '',
    head: (document.querySelector('#grConnectors .gr_head p') || {}).textContent || '' }));
  // It must go through window.giantGmailConnect, not carry its own copy of the OAuth
  // dance -- a second copy is the one that breaks when Google changes something.
  check('it goes through the shared connect', m.asked);
  check('and the row flips to Connected', /Connected/.test(m.state) && !/Not/.test(m.state), m.state);
  check('the count moves to 2 of 5', /2 of 5/.test(m.head), m.head);
});

await step('Claude is tested by being asked something', async () => {
  await page.locator('[data-gr-conn="claude"]').click();
  await page.waitForTimeout(350);
  const was = fake.claudeCalls;
  check('it offers a test', await page.locator('[data-gr-conn-test]').count() === 1);
  await page.locator('[data-gr-conn-test]').click();
  await page.waitForTimeout(900);
  const m = await page.evaluate(() => ({
    say: (document.querySelector('#grConnectors .gr_cstat') || {}).textContent || '',
    state: (document.querySelector('[data-gr-conn="claude"] .gr_st') || {}).textContent || '' }));
  check('it really calls the endpoint', fake.claudeCalls === was + 1, was + ' -> ' + fake.claudeCalls);
  check('and repeats what came back', /answered/i.test(m.say) && /ready/.test(m.say), m.say);
  check('the row says Connected afterwards', /Connected/.test(m.state) && !/Not/.test(m.state), m.state);
});

await step('Zoom and Fathom are honest about not connecting here', async () => {
  await page.locator('[data-gr-conn="zoom"]').click();
  await page.waitForTimeout(350);
  const z = await page.evaluate(() => ({
    how: (document.querySelector('#grConnectors .gr_cnhow') || {}).textContent || '',
    boxes: document.querySelectorAll('#grConnectors .gr_cnp input').length,
    acts: [...document.querySelectorAll('#grConnectors .gr_cnp button, #grConnectors .gr_cnp a')].map(b => b.innerText.trim())
  }));
  // Zoom is shared with Bookings, so its credentials stay in Netlify. Offering a token
  // box here would be the pretence this whole change was meant to remove.
  check('Zoom offers no token box', z.boxes === 0, z.boxes + ' inputs');
  check('and says where its credentials live', /Netlify/.test(z.how) && /ZOOM_ACCOUNT_ID/.test(z.how), z.how.slice(0, 90));
  check('with a way to re-check', z.acts.some(a => /Check again/i.test(a)), JSON.stringify(z.acts));

  await page.locator('[data-gr-conn="fathom"]').click();
  await page.waitForTimeout(350);
  const f = await page.evaluate(() => ({
    how: (document.querySelector('#grConnectors .gr_cnhow') || {}).textContent || '',
    boxes: document.querySelectorAll('#grConnectors .gr_cnp input').length }));
  check('Fathom says it is not built yet', /not built/i.test(f.how), f.how.slice(0, 80));
  check('and does not pretend to have a setup', f.boxes === 0, f.boxes + ' inputs');
  check('but points at what does work today', /Call notes/i.test(f.how), f.how.slice(0, 120));
});

await step('nothing raw reaches the screen', async () => {
  const raw = await page.evaluate(() => {
    const t = document.getElementById('grConnectors').innerText || '';
    return (t.match(/&(?:[a-z]+|#\d+);/ig) || []);
  });
  check('no raw HTML entity is visible', raw.length === 0, JSON.stringify(raw));
});

// ── report ───────────────────────────────────────────────────────────────────
clearInterval(confirmWatcher);
const realErrors = pageErrors.filter(e => !/supabase\.(co|in)/.test(e));
check('no uncaught page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
const grConsole = consoleErrors.filter(e => !/supabase\.(co|in)|Failed to load resource/.test(e));
check('no console errors', grConsole.length === 0, grConsole.slice(0, 3).join(' | '));

for (const r of results) console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   ' + r.detail : ''));
const bad = results.filter(r => !r.pass);
console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' checks passed');
console.log(bad.length ? 'RESULT: ' + bad.length + ' FAILED' : 'RESULT: clean');
await browser.close();
server.close();
process.exit(bad.length ? 1 : 0);
