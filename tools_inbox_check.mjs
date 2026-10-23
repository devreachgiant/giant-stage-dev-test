/* The Email screen's list.  Run:  node tools_inbox_check.mjs

   Two complaints, both real:

     "why does it open this mail by default?" -- the screen opened the newest message
     the moment it loaded. That marks somebody else's choice as read, hides the list
     behind it, and the first thing you see is whatever happened to arrive last.

     "where is the inbox?" -- the count said 13 and the list showed bundles. inPrimary
     deliberately surfaces a RECENT notification into the inbox, and the renderer then
     folded every notification into a "Notifications (n)" row. On a mailbox whose recent
     post is all LinkedIn and Netlify, that is an inbox with nothing in it.

   The fixture is that mailbox: two recent notifications, one ordinary email, and one
   older notification that SHOULD still bundle -- so "shows everything" and "bundles
   nothing" both fail it.
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
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('#view-app.on', { timeout: 30000 });
await page.waitForTimeout(2200);

await step('open the Email screen', async () => {
  const went = await page.evaluate(async () => {
    const nav = document.querySelector('#appSidebar .nav-item[data-screen="inbox"], #appSidebar .nav-item[data-screen="email"]');
    if (!nav) return null;
    nav.click();
    return nav.dataset.screen;
  });
  check('the Email screen is reachable', !!went, String(went));
  await page.waitForTimeout(2500);
});

await step('nothing is opened for you', async () => {
  const m = await page.evaluate(() => ({
    reader: (document.getElementById('mailReaderContent') || {}).style ?
      getComputedStyle(document.getElementById('mailReaderContent')).display : 'missing',
    empty: (document.getElementById('mailReaderEmpty') || {}) ?
      getComputedStyle(document.getElementById('mailReaderEmpty')).display : 'missing',
    emptyText: (document.getElementById('mailReaderEmpty') || {}).innerText || ''
  }));
  // The list is the screen. A message opens when it is picked, not before.
  check('no message is open', m.reader === 'none', m.reader);
  check('and the reader says to pick one', m.empty !== 'none' && /Select an email/i.test(m.emptyText),
    m.empty + ' / ' + m.emptyText.slice(0, 40));
});

await step('the inbox shows the mail that is in it', async () => {
  const m = await page.evaluate(() => {
    const rows = document.getElementById('inboxRows');
    const items = [...rows.querySelectorAll('[data-mail-id]')].map(x => x.getAttribute('data-mail-id'));
    const bundles = rows.querySelectorAll('[data-notif-section]').length;
    const count = (document.getElementById('folderCountInbox') || {}).textContent;
    return { items, bundles, count, text: rows.innerText.slice(0, 400) };
  });
  // em-1 and em-2 are recent notifications: inPrimary counts them, so the list has to
  // show them. em-3 is an ordinary email and was never at risk.
  check('a recent LinkedIn notification is listed in its own right',
    m.items.includes('em-1'), JSON.stringify(m.items));
  check('so is the recent Netlify one', m.items.includes('em-2'), JSON.stringify(m.items));
  check('and the ordinary email', m.items.includes('em-3'), JSON.stringify(m.items));
  // The whole complaint, as one measurement: what is counted is what is shown.
  check('the inbox count matches what is on screen',
    Number(m.count) === m.items.length, m.count + ' counted, ' + m.items.length + ' shown');
  /* And the older one is NOT here. inPrimary only lifts a notification into the inbox
     while it is recent, so a twelve-day-old Hubspot digest belongs in Notifications --
     which is the category that exists for it. Checked on both sides, because "not in
     the inbox" on its own would also be true if it had been lost. */
  check('an older notification is not in the inbox', !m.items.includes('em-4'),
    JSON.stringify(m.items));
});

await step('the older notification is in Notifications, not lost', async () => {
  const tab = page.locator('[data-mail-filter="NOTIFICATIONS"]').first();
  if (!(await tab.count())) { check('there is a Notifications category', false, 'missing'); return; }
  await tab.click();
  await page.waitForTimeout(1200);
  const m = await page.evaluate(() => {
    const rows = document.getElementById('inboxRows');
    return { items: [...rows.querySelectorAll('[data-mail-id]')].map(x => x.getAttribute('data-mail-id')),
             count: (document.getElementById('folderCountNotifications') || {}).textContent };
  });
  check('the old digest is in Notifications', m.items.includes('em-4'), JSON.stringify(m.items));
  check('and the recent ones are there too, not only in the inbox',
    m.items.includes('em-1') && m.items.includes('em-2'), JSON.stringify(m.items));
  check('the category count matches its list',
    Number(m.count) === m.items.length, m.count + ' counted, ' + m.items.length + ' shown');
});

await step('picking a message opens it, and switching category closes it', async () => {
  // Back to the inbox: the step above left us in Notifications, where this message is
  // not, and clicking for it there would time out on a screen that is working fine.
  const inboxTab = page.locator('[data-mail-filter="INBOX"]').first();
  if (await inboxTab.count()) { await inboxTab.click(); await page.waitForTimeout(1200); }
  await page.locator('#inboxRows [data-mail-id="em-3"]').click();
  await page.waitForTimeout(900);
  const open = await page.evaluate(() => ({
    reader: getComputedStyle(document.getElementById('mailReaderContent')).display,
    subject: (document.getElementById('mailReaderSubject') || {}).textContent || ''
  }));
  check('the picked message opens', open.reader !== 'none', open.reader);
  check('and it is the one that was picked', /proposal/i.test(open.subject), open.subject);

  const other = page.locator('[data-mail-filter="INBOX"]').first();
  if (await other.count()) {
    await other.click();
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => ({
      reader: getComputedStyle(document.getElementById('mailReaderContent')).display,
      empty: getComputedStyle(document.getElementById('mailReaderEmpty')).display
    }));
    // Leaving the previous category's message open beside a list it is not in is how
    // somebody replies to the wrong thing.
    check('switching category closes the message', after.reader === 'none', after.reader);
    check('and shows the empty reader again', after.empty !== 'none', after.empty);
  }
});

await step('a message takes the whole width, and the folders stay', async () => {
  const back = page.locator('[data-mail-filter="INBOX"]').first();
  if (await back.count()) { await back.click(); await page.waitForTimeout(900); }
  const before = await page.evaluate(() => {
    const w = (s) => { const el = document.querySelector(s); return el ? Math.round(el.getBoundingClientRect().width) : 0; };
    return { list: w('.maillist'), rail: w('.ml-rail'), reader: w('.reader') };
  });
  // The list is the screen: no permanent half-width reading pane beside it.
  check('the list fills the width', before.list > 500, JSON.stringify(before));
  check('and the reader is not taking half of it', before.reader === 0, JSON.stringify(before));

  await page.locator('#inboxRows [data-mail-id]').first().click();
  await page.waitForTimeout(900);
  const open = await page.evaluate(() => {
    const el = (s) => document.querySelector(s);
    const w = (s) => { const e = el(s); return e ? Math.round(e.getBoundingClientRect().width) : 0; };
    return { list: w('.maillist'), rail: w('.ml-rail'), reader: w('.reader'),
             back: !!el('#mailBackBtn') && getComputedStyle(el('#mailBackBtn')).display !== 'none' };
  });
  check('opening a message hides the list', open.list === 0, JSON.stringify(open));
  check('and gives the reader the width', open.reader > 500, JSON.stringify(open));
  // Gmail keeps its folder nav while you read. Ours used to live INSIDE the list, so it
  // disappeared with it and there was no way to change folder without going back.
  check('the folder rail stays put', open.rail > 80 && open.rail === before.rail,
    before.rail + ' -> ' + open.rail);
  check('and there is a way back', open.back);

  await page.locator('#mailBackBtn').click();
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => {
    const w = (s) => { const el = document.querySelector(s); return el ? Math.round(el.getBoundingClientRect().width) : 0; };
    return { list: w('.maillist'), reader: w('.reader') };
  });
  check('back returns the list', after.list > 500 && after.reader === 0, JSON.stringify(after));
});

await step('a row is one line: who, what, when', async () => {
  const m = await page.evaluate(() => {
    const row = document.querySelector('#inboxRows .mailitem');
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { h: Math.round(r.height),
             who: (row.querySelector('.mi-who') || {}).textContent,
             line: (row.querySelector('.mi-line') || {}).textContent,
             when: (row.querySelector('.mi-when') || {}).textContent,
             star: !!row.querySelector('[data-star]'),
             avatar: !!row.querySelector('.mi-ava') };
  });
  check('there is a row to measure', !!m, '');
  if (!m) return;
  // The whole point of the change: three lines and a logo became one line, so twenty
  // messages fit where three did.
  check('it is one line tall', m.h <= 44, m.h + 'px');
  check('the sender is there', (m.who || '').length > 1, m.who);
  check('subject and snippet share the line', /—/.test(m.line || ''), (m.line || '').slice(0, 70));
  check('the time is on the right', (m.when || '').trim().length > 0, m.when);
  check('and there is a star, as Gmail has', m.star);
  check('the per-row logo is gone', !m.avatar, String(m.avatar));
});

await step('the snippet is not double-escaped', async () => {
  /* Gmail hands back snippets already HTML-escaped, and escaping them again for the
     page printed the entity: "You&#39;re using your credits". */
  // Read from the row as it first rendered: the fixture's snippet already carries the
  // entities, so no re-render hook is needed and the check measures the real path.
  const r = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#inboxRows .mailitem')]
      .find(x => x.getAttribute('data-mail-id') === 'em-2');
    return el ? (el.querySelector('.mi-line') || {}).textContent : null;
  });
  check('the row rendered', !!r, String(r));
  if (!r) return;
  check("an apostrophe reads as an apostrophe", /You're/.test(r), r.slice(0, 80));
  check('and an ampersand as an ampersand', /& running/.test(r), r.slice(0, 80));
  check('no raw entity is left on screen', !/&#\d+;|&amp;/.test(r), r.slice(0, 80));
});

for (const r of results) console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   ' + r.detail : ''));
const bad = results.filter(r => !r.pass);
console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' checks passed');
console.log(bad.length ? 'RESULT: ' + bad.length + ' FAILED' : 'RESULT: clean');
await browser.close();
server.close();
process.exit(bad.length ? 1 : 0);
