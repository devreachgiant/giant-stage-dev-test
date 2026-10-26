/* Shared task links.  Run:  node tools_task_link_check.mjs

   "when I send the link from Projects, the link won't open the task -- it goes to the
   main project table instead."

   Two screens wrote task links and only one form was ever read. Projects 2.0's Copy
   link produced  #task=<id>  while the only deep-link handler in the app looked for
   ?task=<id>  -- so every link copied from the new module opened the app, landed on the
   project table, and stopped. Worse, the bootstrap normalises the URL with
   replaceState('', '/app') the moment auth resolves, which takes the hash with it, so
   even a handler that went looking for it later would have found nothing.

   This drives the whole round trip rather than reading the code: copy a link the way a
   person does, then open that link in a fresh page and see whether the task is on
   screen. A check that only asserted the href would have passed while the link still
   did nothing.
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
  for (const t of ['playwright', pathToFileURL('/opt/homebrew/lib/node_modules/playwright/index.js').href]) {
    try { chromium = pick(await import(t)); } catch { /* next */ }
    if (chromium) break;
  }
  if (!chromium) { console.error('playwright not found.'); process.exit(2); }
}
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  try { res.writeHead(200, { 'content-type': TYPES[path.extname(rel)] || 'text/plain' });
        res.end(readFileSync(path.join(HERE, rel))); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + server.address().port;

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); return !!pass; };
const step = async (label, fn) => {
  try { return await fn(); }
  catch (e) { check(label, false, 'threw: ' + String(e.message || e).slice(0, 180)); return null; }
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
await page.route('**/@supabase/supabase-js@2*', r =>
  r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
await page.route('**://*.supabase.co/**', r => r.abort());

const openProjects = async () => {
  await page.waitForSelector('#view-app.on', { timeout: 30000 });
  await page.waitForTimeout(2200);
  await page.evaluate(() => {
    const nav = document.querySelector('.nav-item[data-screen="projects2"]')
             || document.querySelector('.nav-item[data-screen="tasks"]');
    if (nav) nav.click();
  });
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate(() =>
      !!(window.p2State && window.p2State.projects && window.p2State.projects.length));
    if (ready) break;
    await page.waitForTimeout(300);
  }
};

let copied = null, taskId = null;

await step('copy a link the way a person does', async () => {
  await page.goto(BASE + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await openProjects();

  /* The project that opens by default has no tasks in the fixture, so pick the one
     that does -- by clicking its chip, the way a person gets there. */
  const wanted = await page.evaluate(() => {
    const counts = {};
    (window.__mockDB.tasks || []).forEach(t => {
      if (t.project_id) counts[t.project_id] = (counts[t.project_id] || 0) + 1;
    });
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
  });
  check('the fixture has a project with tasks in it', !!wanted, String(wanted));
  if (wanted) {
    await page.evaluate((id) => {
      const chip = document.querySelector('[data-p2-project="' + id + '"]');
      if (chip) chip.click();
    }, wanted);
  }
  for (let i = 0; i < 40; i++) {
    const n = await page.evaluate(() => (window.p2State.tasks || []).length);
    if (n) break;
    await page.waitForTimeout(300);
  }
  const picked = await page.evaluate(() => {
    const st = window.p2State || {};
    const t = (st.tasks || [])[0];
    return t ? { id: t.id, name: t.name }
             : { diag: { projects: (st.projects || []).length, activeId: st.activeId,
                         tasks: (st.tasks || []).length, loading: st.loading,
                         screenOn: !!document.querySelector('.screen[data-screen="projects2"].on') } };
  });
  check('Projects 2.0 has a task to share', !!(picked && picked.id), JSON.stringify(picked));
  if (!picked || !picked.id) return;
  taskId = picked.id;

  await page.evaluate((id) => window.p2OpenTask(id), taskId);
  await page.waitForTimeout(1200);
  check('its detail view opens', await page.evaluate(() => !!document.getElementById('p2_detail')));

  // The real button, with the clipboard stubbed so the value can be read back.
  await page.evaluate(() => {
    window.__copied = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } }
    });
  });
  await page.locator('#p2_dCopy').click();
  await page.waitForTimeout(600);
  copied = await page.evaluate(() => window.__copied);

  check('Copy link puts something on the clipboard', !!copied, String(copied));
  if (!copied) return;
  /* The format matters because only one form is ever read back. Asserting the id is in
     the string somewhere would have passed against the bug -- #task=<id> contains it
     too. */
  const u = new URL(copied);
  check('the link carries the task as a query parameter, not a hash',
    u.searchParams.get('task') === taskId, copied);
  check('and no hash is left on it', u.hash === '', u.hash || '(none)');
});

await step('the copied link opens the task', async () => {
  if (!copied) { check('there is a link to follow', false, 'nothing copied'); return; }
  // A fresh page, as the person receiving the link gets.
  const fresh = await ctx.newPage();
  await fresh.route('**/@supabase/supabase-js@2*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
  await fresh.route('**://*.supabase.co/**', r => r.abort());
  const url = copied.replace(/^https?:\/\/[^/]+/, BASE);
  await fresh.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await fresh.waitForSelector('#view-app.on', { timeout: 30000 });

  let open = false;
  for (let i = 0; i < 30; i++) {
    open = await fresh.evaluate(() => !!document.getElementById('p2_detail'));
    if (open) break;
    await fresh.waitForTimeout(500);
  }
  /* The whole complaint, measured: the task is on screen, not the project table. */
  check('the task detail is open, not just the project table', open, String(open));
  if (open) {
    const showing = await fresh.evaluate(() => window.p2State.detailId);
    check('and it is the task that was shared', showing === taskId, showing + ' vs ' + taskId);
  }
  await fresh.close();
});

await step('links already sent out still work', async () => {
  /* The old form has been copied by people and sent to other people. Those links do not
     change when the code does, so the hash is still accepted -- and the hash is also
     the harder case, because replaceState strips it before any handler runs. */
  if (!taskId) { check('there is a task to link to', false, ''); return; }
  const fresh = await ctx.newPage();
  await fresh.route('**/@supabase/supabase-js@2*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
  await fresh.route('**://*.supabase.co/**', r => r.abort());
  await fresh.goto(BASE + '/app#task=' + encodeURIComponent(taskId),
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await fresh.waitForSelector('#view-app.on', { timeout: 30000 });

  let open = false;
  for (let i = 0; i < 30; i++) {
    open = await fresh.evaluate(() => !!document.getElementById('p2_detail'));
    if (open) break;
    await fresh.waitForTimeout(500);
  }
  check('an old #task= link opens the task too', open, String(open));
  if (open) {
    const showing = await fresh.evaluate(() => window.p2State.detailId);
    check('and it is the right one', showing === taskId, showing + ' vs ' + taskId);
  }
  await fresh.close();
});

await step('a plain visit opens nothing', async () => {
  /* The other half of the measurement: if the detail panel opened by itself, the checks
     above would pass without the link doing anything at all. */
  const fresh = await ctx.newPage();
  await fresh.route('**/@supabase/supabase-js@2*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
  await fresh.route('**://*.supabase.co/**', r => r.abort());
  await fresh.goto(BASE + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await fresh.waitForSelector('#view-app.on', { timeout: 30000 });
  await fresh.waitForTimeout(6000);
  const open = await fresh.evaluate(() => !!document.getElementById('p2_detail'));
  check('no task opens without a link saying so', !open, String(open));
  await fresh.close();
});

await step('the link still works on a slow cold load', async () => {
  /* The harness boots in well under a second; a real sign-in on the live site does
     not. The handler fired on a fixed 1500ms timer and clicked a sidebar that might
     not exist yet -- which looks exactly like "the link does nothing and does not even
     switch screen". The supabase module is held back here to reproduce that. */
  if (!taskId) { check('there is a task to link to', false, ''); return; }
  const slow = await ctx.newPage();
  await slow.route('**/@supabase/supabase-js@2*', async (r) => {
    await new Promise(res => setTimeout(res, 4000));   // a slow cold load
    r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK });
  });
  await slow.route('**://*.supabase.co/**', r => r.abort());
  await slow.goto(BASE + '/app?task=' + encodeURIComponent(taskId),
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await slow.waitForSelector('#view-app.on', { timeout: 40000 });

  let open = false;
  for (let i = 0; i < 40; i++) {
    open = await slow.evaluate(() => !!document.getElementById('p2_detail'));
    if (open) break;
    await slow.waitForTimeout(500);
  }
  const where = await slow.evaluate(() => {
    const on = document.querySelector('.screen.on[data-screen]');
    return on ? on.getAttribute('data-screen') : null;
  });
  check('it switches to Projects even when the app was slow to start',
    where === 'projects2' || where === 'tasks', String(where));
  check('and the task opens', open, String(open));
  await slow.close();
});

await step('a task link clicked with Giant already open', async () => {
  /* The handler ran once, on load. A link followed while Giant is already open in that
     tab changes the URL WITHOUT reloading -- the browser treats it as navigation
     inside the same document -- so nothing re-ran and the link did nothing at all. */
  if (!taskId) { check('there is a task to link to', false, ''); return; }
  const live = await ctx.newPage();
  await live.route('**/@supabase/supabase-js@2*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
  await live.route('**://*.supabase.co/**', r => r.abort());
  await live.goto(BASE + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await live.waitForSelector('#view-app.on', { timeout: 30000 });
  await live.waitForTimeout(4000);
  check('nothing is open to start with',
    !(await live.evaluate(() => !!document.getElementById('p2_detail'))), '');

  // Follow the link in this tab, which is a hash change and not a load.
  await live.evaluate((id) => { window.location.hash = 'task=' + id; }, taskId);
  let open = false;
  for (let i = 0; i < 30; i++) {
    open = await live.evaluate(() => !!document.getElementById('p2_detail'));
    if (open) break;
    await live.waitForTimeout(500);
  }
  check('it opens without a page reload', open, String(open));
  if (open) {
    const showing = await live.evaluate(() => window.p2State.detailId);
    check('showing the task from the link', showing === taskId, showing + ' vs ' + taskId);
  }
  await live.close();
});

await step('a task link CLICKED inside the app opens the full view', async () => {
  /* The reported bug, and the case none of the checks above touched. A link clicked
     inside Giant never reaches the URL handler: a global interceptor catches our own
     links, calls preventDefault so nothing navigates, and opened the old side panel
     over whatever screen you happened to be on. Clicking a task link in Chat left you
     in Chat with an overlay; the same link pasted into the address bar opened the full
     view in Projects. Same link, two behaviours. */
  if (!taskId) { check('there is a task to link to', false, ''); return; }
  const app = await ctx.newPage();
  await app.route('**/@supabase/supabase-js@2*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
  await app.route('**://*.supabase.co/**', r => r.abort());
  await app.goto(BASE + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await app.waitForSelector('#view-app.on', { timeout: 30000 });
  await app.waitForTimeout(3500);

  // Sit on a screen that is NOT Projects, as somebody reading Chat would be.
  await app.evaluate(() => document.querySelector('#appSidebar .nav-item[data-screen="chat"]')?.click());
  await app.waitForTimeout(2500);
  const before = await app.evaluate(() =>
    (document.querySelector('.screen.on[data-screen]') || {}).dataset?.screen);
  check('we start somewhere else', before && before !== 'projects2', String(before));

  // A real anchor, exactly as the chat linkifier writes one.
  await app.evaluate(({ base, id }) => {
    const a = document.createElement('a');
    a.id = '__linkprobe';
    a.href = base + '/app?task=' + id;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'the task';
    a.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;color:#fff;';
    document.body.appendChild(a);
  }, { base: BASE, id: taskId });
  await app.click('#__linkprobe');

  let open = false;
  for (let i = 0; i < 30; i++) {
    open = await app.evaluate(() => !!document.getElementById('p2_detail'));
    if (open) break;
    await app.waitForTimeout(500);
  }
  const after = await app.evaluate(() => ({
    screen: (document.querySelector('.screen.on[data-screen]') || {}).dataset?.screen,
    detailId: window.p2State && window.p2State.detailId,
    overlay: (() => { const o = document.getElementById('taskDetailPanelOverlay');
      return o ? getComputedStyle(o).display : 'missing'; })(),
    tabs: 1
  }));
  check('clicking it switches to Projects', after.screen === 'projects2', String(after.screen));
  check('and opens the full view, not the side panel', open, String(open));
  check('showing the task that was linked', after.detailId === taskId,
    after.detailId + ' vs ' + taskId);
  check('the old side overlay is not what opened', after.overlay === 'none' || after.overlay === 'missing',
    after.overlay);
  await app.close();
});

for (const r of results) console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   ' + r.detail : ''));
const bad = results.filter(r => !r.pass);
console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' checks passed');
console.log(bad.length ? 'RESULT: ' + bad.length + ' FAILED' : 'RESULT: clean');
await browser.close();
server.close();
process.exit(bad.length ? 1 : 0);
