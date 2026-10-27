/* Setting your status, and it resetting itself.  Run:  node tools_status_check.mjs

   A status with no end is the one people forget: "On lunch" set on Friday afternoon is
   still there on Monday morning, because the only thing that ever cleared it was
   noticing. So picking one now asks when it ends.

   The half that is easy to get wrong is the resetting. The expiry was consulted only
   when something happened to repaint, which means "clear after 30 minutes" really meant
   "stop showing it the next time anybody looks" -- leave the tab open and it sits there
   all afternoon. The row has to be cleared at the moment itself.

   Time is faked rather than waited for: a check that sleeps 30 minutes is a check that
   never runs.
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
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
await page.route('**/@supabase/supabase-js@2*', r =>
  r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
await page.route('**://*.supabase.co/**', r => r.abort());
await page.goto(BASE + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('#view-app.on', { timeout: 30000 });
await page.waitForTimeout(3000);

const openMenu = () => page.evaluate(() => {
  const p = document.getElementById('hdrPerson');
  if (p) p.click();
  return !!document.getElementById('statusMenu');
});

await step('picking a status asks when it ends', async () => {
  await openMenu();
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => ({
    menuOpen: document.getElementById('statusMenu').classList.contains('on'),
    whenShown: getComputedStyle(document.getElementById('statusWhenPanel')).display !== 'none'
  }));
  check('the status menu opens', before.menuOpen, JSON.stringify(before));
  check('and it does not start on the reset step', !before.whenShown, String(before.whenShown));

  await page.evaluate(() => document.querySelector('.status-menu-item[data-status="lunch"]').click());
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    whenShown: getComputedStyle(document.getElementById('statusWhenPanel')).display !== 'none',
    what: (document.getElementById('statusWhenWhat') || {}).textContent,
    options: [...document.querySelectorAll('#statusWhenPanel [data-when]')].map(e => e.dataset.when),
    // Nothing may be saved yet: the status is not set until the second step answers.
    saved: (window.giantCurrentProfile || {}).status_key || null
  }));
  check('it asks when to reset', after.whenShown, String(after.whenShown));
  check('and says which status it is asking about', /lunch/i.test(after.what || ''), after.what);
  check('with the choices that were asked for',
    ['30', '60', '240', 'today', 'tomorrow', 'custom', ''].every(o => after.options.includes(o)),
    after.options.join('|'));
  check('nothing is set until the question is answered', after.saved !== 'lunch', String(after.saved));
});

await step('answering it sets the status and the end time', async () => {
  const t0 = Date.now();
  await page.evaluate(() => document.querySelector('#statusWhenPanel [data-when="30"]').click());
  await page.waitForTimeout(600);
  const m = await page.evaluate(() => {
    const p = window.giantCurrentProfile || {};
    const row = (window.__mockDB.profiles || []).find(x => x.id === p.id) || {};
    return { key: p.status_key, text: p.status_text, expires: p.status_expires_at,
             savedKey: row.status_key, savedExpires: row.status_expires_at,
             menuOpen: document.getElementById('statusMenu').classList.contains('on') };
  });
  check('the status is set', m.key === 'lunch' && /lunch/i.test(m.text || ''), JSON.stringify(m.key));
  // Written, not just held in the page: this is the row every screen reads.
  check('and written to the profile row', m.savedKey === 'lunch', String(m.savedKey));
  const mins = m.expires ? Math.round((new Date(m.expires).getTime() - t0) / 60000) : null;
  check('with an end time 30 minutes out', mins === 30, mins + ' minutes');
  check('and the row carries it too', !!m.savedExpires, String(m.savedExpires));
  check('the menu closes', !m.menuOpen, String(m.menuOpen));
});

await step('Online and Offline do not ask, because neither is timed', async () => {
  for (const key of ['online', 'offline']) {
    await openMenu();
    await page.waitForTimeout(400);
    await page.evaluate((k) => document.querySelector('.status-menu-item[data-status="' + k + '"]').click(), key);
    await page.waitForTimeout(500);
    const m = await page.evaluate((k) => ({
      whenShown: getComputedStyle(document.getElementById('statusWhenPanel')).display !== 'none',
      key: (window.giantCurrentProfile || {}).status_key,
      menuOpen: document.getElementById('statusMenu').classList.contains('on')
    }), key);
    check(key + ' saves straight away', m.key === key && !m.menuOpen, JSON.stringify(m));
    check(key + ' never asks about resetting', !m.whenShown, String(m.whenShown));
  }
});

await step('it resets itself, without anybody looking', async () => {
  /* THE HALF THAT WAS MISSING. The expiry used to be consulted only when something
     repainted, so a status "cleared after 30 minutes" sat on screen for as long as the
     tab stayed open. Two seconds stands in for thirty minutes here -- waiting out the
     real thing is how a check stops being run. */
  await openMenu();
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('.status-menu-item[data-status="meeting"]').click());
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('#statusWhenPanel [data-when="30"]').click());
  await page.waitForTimeout(600);

  const set = await page.evaluate(() => (window.giantCurrentProfile || {}).status_key);
  check('a status is on', set === 'meeting', String(set));

  // Move its end time to two seconds away and let the page notice by itself.
  await page.evaluate(() => {
    window.giantCurrentProfile.status_expires_at = new Date(Date.now() + 2000).toISOString();
    window.giantPaintMyStatus();          // the repaint that re-arms the timer
  });
  await page.waitForTimeout(4500);

  const after = await page.evaluate(() => {
    const p = window.giantCurrentProfile || {};
    const row = (window.__mockDB.profiles || []).find(x => x.id === p.id) || {};
    return { key: p.status_key, text: p.status_text, expires: p.status_expires_at,
             savedKey: row.status_key, label: (document.getElementById('userStatusLabel') || {}).textContent };
  });
  check('it cleared itself when the time came', after.key === null, String(after.key));
  check('the end time went with it', after.expires === null, String(after.expires));
  // Not merely hidden: the row is what every other screen reads.
  check('and the profile row was cleared, not just the screen', !after.savedKey, String(after.savedKey));
  check('the header stopped showing it', !/meeting/i.test(after.label || ''), after.label);
});

await step('a long reset is not treated as an immediate one', async () => {
  /* setTimeout overflows past about 24.8 days and fires straight away. A status set to
     clear next month would have been wiped the instant it was set. */
  await page.evaluate(() => {
    window.giantCurrentProfile.status_key = 'ooo';
    window.giantCurrentProfile.status_text = 'Out of office';
    window.giantCurrentProfile.status_expires_at = new Date(Date.now() + 60 * 86400000).toISOString();
    window.giantPaintMyStatus();
  });
  await page.waitForTimeout(2500);
  const m = await page.evaluate(() => ({ key: (window.giantCurrentProfile || {}).status_key }));
  check('a status set to clear in two months survives being set', m.key === 'ooo', String(m.key));
});

for (const r of results) console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   ' + r.detail : ''));
const bad = results.filter(r => !r.pass);
console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' checks passed');
console.log(bad.length ? 'RESULT: ' + bad.length + ' FAILED' : 'RESULT: clean');
await browser.close();
server.close();
process.exit(bad.length ? 1 : 0);
