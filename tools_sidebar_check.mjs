/* Sidebar labels.  Run:  node tools_sidebar_check.mjs

   Four items were renamed: SOPs & Workflows → SOP, Settings → Preferences,
   Help & Feedback → Feedbacks, Version & Changelog → Changelog.

   A rename here is two edits, not one -- data-label AND the text people read -- and I
   got two of the four half-right on the first pass: the attribute changed and the
   visible text did not, which looks finished in a diff and wrong on screen. So every
   item is checked on BOTH, from a rendered sidebar.

   data-screen is deliberately NOT renamed: it is what every link, tab and deep link
   keys off. Each item is clicked to prove the screen it points at still opens, because
   a label change that quietly breaks navigation is the real risk here.
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

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
await page.route('**/@supabase/supabase-js@2*', r =>
  r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
await page.route('**://*.supabase.co/**', r => r.abort());
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('#view-app.on', { timeout: 30000 });
await page.waitForTimeout(2200);

// screen, group it lives in, what it must say now, what it must NOT say any more
const ITEMS = [
  ['sops',      'work',     'SOP',         ['SOPs', 'Workflows']],
  ['settings',  'settings', 'Preferences', ['Settings']],
  ['report',    'settings', 'Feedbacks',   ['Help & Feedback', 'Help Us Improve']],
  ['changelog', 'settings', 'Changelog',   ['Version']]
];

for (const [screen, group, want, gone] of ITEMS) {
  /* The nav is an accordion, so the group has to be OPEN for this item to be a real row
     with a size. Opened by state, not by clicking: the label toggles, so clicking it for
     the second item in the same group shuts the group the first one just opened. */
  const openGroup = async () => page.evaluate((s) => {
    const el = document.querySelector('#appSidebar .nav-item[data-screen="' + s + '"]');
    const r = el ? el.getBoundingClientRect() : null;
    return !!(r && r.width > 0 && r.height > 0);
  }, screen);
  if (!(await openGroup())) {
    await page.locator('.nav-group-label[data-navgroup="' + group + '"]').click().catch(() => {});
    await page.waitForTimeout(500);
  }
  const m = await page.evaluate((s) => {
    const el = document.querySelector('#appSidebar .nav-item[data-screen="' + s + '"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { label: el.dataset.label || '', text: (el.textContent || '').trim(),
             w: Math.round(r.width), h: Math.round(r.height) };
  }, screen);
  if (!m) { check(screen + ': the item exists', false, 'not found'); continue; }
  check(screen + ': it is a real row on screen', m.w > 60 && m.h > 14, m.w + 'x' + m.h);
  check(screen + ': data-label says ' + want, m.label === want, m.label);
  // The half-rename I actually made: attribute right, text left behind.
  check(screen + ': the text people read says ' + want, m.text.indexOf(want) === 0, m.text);
  check(screen + ': the old name is gone from both',
    gone.every(g => m.label.indexOf(g) < 0 && m.text.indexOf(g) < 0),
    m.label + ' / ' + m.text);

  // And it still goes where it went before.
  await page.locator('#appSidebar .nav-item[data-screen="' + screen + '"]').click();
  await page.waitForTimeout(700);
  const on = await page.evaluate(() => {
    const o = document.querySelector('.screen.on');
    return o ? o.dataset.screen : null;
  });
  check(screen + ': clicking it still opens that screen', on === screen, String(on));
}

for (const r of results) console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   ' + r.detail : ''));
const bad = results.filter(r => !r.pass);
console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' checks passed');
console.log(bad.length ? 'RESULT: ' + bad.length + ' FAILED' : 'RESULT: clean');
await browser.close();
server.close();
process.exit(bad.length ? 1 : 0);
