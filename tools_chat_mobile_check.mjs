/* Chat on a phone.  Run:  node tools_chat_mobile_check.mjs

   "can we make chat module responsive, accessible from mobile to reply"

   It could be opened on a phone and not used. Three fixed columns in a 390px viewport:
   the menu took 236 of it, the channel list is a fixed 300, and the thread -- the
   messages and the box you reply in -- was left with ZERO. Measured, not guessed:
   .nc_thread came out 0px wide and #nc_chatMsgs 44px.

   So: one pane at a time, the way every mail and chat app on a phone works. The
   conversation list, then the conversation, with a way back.

   Everything here is measured at 390x844 and asserted against the viewport, because
   "the element exists" is true of a 0x0 element and was true the whole time this was
   broken. The desktop width is checked too, so the phone rules cannot leak upwards.
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

async function openChat(size, mobile) {
  const ctx = await browser.newContext({ viewport: size, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  await page.route('**/@supabase/supabase-js@2*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
  await page.route('**://*.supabase.co/**', r => r.abort());
  await page.goto(BASE + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#view-app.on', { timeout: 30000 });
  await page.waitForTimeout(2800);
  // data-screen="newchat" is Chat. data-screen="chat" is the Archive copy -- driving
  // that one measures a screen nobody is using.
  await page.evaluate(() => document.querySelector('#appSidebar .nav-item[data-screen="newchat"]')?.click());
  await page.waitForTimeout(2600);
  return { ctx, page };
}

/* Measured against the viewport, never "is it in the DOM": a 0x0 element is in the DOM,
   and every one of these was, for as long as Chat was unusable on a phone. */
const BOX = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x),
           usable: b.width > 40 && b.height > 20 && b.x >= -1 && b.right <= innerWidth + 1 };
};

const PHONE = { width: 390, height: 844 };
let phone;

await step('the conversation list fills a phone', async () => {
  phone = await openChat(PHONE, true);
  const { page } = phone;
  const m = await page.evaluate((boxSrc) => {
    const BOX = eval('(' + boxSrc + ')');
    return {
      list: BOX('.screen[data-screen="newchat"] #nc_chatChannels'),
      sidebarX: Math.round(document.querySelector('.sidebar').getBoundingClientRect().x),
      sideways: document.documentElement.scrollWidth > innerWidth + 1,
      vw: innerWidth
    };
  }, BOX.toString());
  check('the list is there and takes the width', m.list && m.list.usable && m.list.w >= 340,
    JSON.stringify(m.list));
  // 236px of a 390px screen is the screen.
  check('the menu is off-canvas, not eating the screen', m.sidebarX < 0, 'x=' + m.sidebarX);
  check('nothing runs off the side', !m.sideways, String(m.sideways));
});

await step('opening a conversation gives it the screen', async () => {
  const { page } = phone;
  await page.evaluate(() => { const r = document.querySelector('[data-nc-channel-id]'); if (r) r.click(); });
  await page.waitForTimeout(2600);
  const m = await page.evaluate((boxSrc) => {
    const BOX = eval('(' + boxSrc + ')');
    const head = document.querySelector('.screen[data-screen="newchat"] .nc_thread-head');
    const over = [];
    if (head) head.querySelectorAll('*').forEach(e => {
      const b = e.getBoundingClientRect();
      if (b.width > 0 && b.right > innerWidth + 1) over.push(e.id || e.className || e.tagName);
    });
    return {
      thread: BOX('.screen[data-screen="newchat"] .nc_thread'),
      msgs: BOX('.screen[data-screen="newchat"] #nc_chatMsgs'),
      composer: BOX('.screen[data-screen="newchat"] #nc_chatInput'),
      back: BOX('.nc_backBtn'),
      listShown: !!document.querySelector('.screen[data-screen="newchat"] #nc_chatChannels')
        ?.getBoundingClientRect().width,
      headOverflow: over.slice(0, 4),
      composerFont: (() => { const e = document.querySelector('.screen[data-screen="newchat"] #nc_chatInput');
        return e ? getComputedStyle(e).fontSize : null; })()
    };
  }, BOX.toString());

  // The whole complaint, as one measurement.
  check('the thread takes the screen, not 0px', m.thread && m.thread.usable && m.thread.w >= 340,
    JSON.stringify(m.thread));
  check('you can read the messages', m.msgs && m.msgs.usable && m.msgs.h > 150, JSON.stringify(m.msgs));
  check('and reply: the box is on screen and big enough to tap',
    m.composer && m.composer.usable && m.composer.h >= 36, JSON.stringify(m.composer));
  /* 16px or iOS zooms the page on focus, which throws the layout out the moment you
     tap to type -- the one thing you came to the phone to do. */
  check('typing will not zoom the page', m.composerFont && parseFloat(m.composerFont) >= 16,
    m.composerFont);
  check('the list stood aside', !m.listShown, String(m.listShown));
  check('there is a way back', m.back && m.back.w >= 30, JSON.stringify(m.back));
  // #nc_chatHuddleBtn ran to 416px in a 390 viewport, with no way to scroll to it.
  check('nothing in the header is off the right edge', m.headOverflow.length === 0,
    m.headOverflow.join(',') || 'none');
});

await step('back returns to the conversations', async () => {
  const { page } = phone;
  await page.locator('.nc_backBtn').click();
  await page.waitForTimeout(1200);
  const m = await page.evaluate((boxSrc) => {
    const BOX = eval('(' + boxSrc + ')');
    return { list: BOX('.screen[data-screen="newchat"] #nc_chatChannels'),
             thread: BOX('.screen[data-screen="newchat"] .nc_thread') };
  }, BOX.toString());
  check('the list is back', m.list && m.list.usable, JSON.stringify(m.list));
  check('and the thread stepped aside', !m.thread || m.thread.w === 0, JSON.stringify(m.thread));
  await phone.ctx.close();
});

await step('none of this leaks onto a desktop', async () => {
  /* The phone rules are a media query, and a media query written at the wrong width
     silently rearranges the screen everybody actually uses. */
  const desk = await openChat({ width: 1500, height: 950 }, false);
  const { page } = desk;
  await page.evaluate(() => { const r = document.querySelector('[data-nc-channel-id]'); if (r) r.click(); });
  await page.waitForTimeout(2400);
  const m = await page.evaluate((boxSrc) => {
    const BOX = eval('(' + boxSrc + ')');
    return {
      list: BOX('.screen[data-screen="newchat"] #nc_chatChannels'),
      thread: BOX('.screen[data-screen="newchat"] .nc_thread'),
      back: (() => { const e = document.querySelector('.nc_backBtn');
        return e ? Math.round(e.getBoundingClientRect().width) : 0; })(),
      sidebarX: Math.round(document.querySelector('.sidebar').getBoundingClientRect().x),
      privacy: (() => { const e = document.querySelector('#nc_chatHeadPrivacyBtn');
        return e ? getComputedStyle(e).display : 'missing'; })()
    };
  }, BOX.toString());
  check('both panes still show side by side', m.list && m.list.w > 200 && m.thread && m.thread.w > 400,
    JSON.stringify({ list: m.list && m.list.w, thread: m.thread && m.thread.w }));
  check('the back button stays out of the way', m.back === 0, String(m.back));
  check('the menu is still a menu, not a drawer', m.sidebarX >= 0, 'x=' + m.sidebarX);
  check('and the privacy toggle is still there', m.privacy !== 'none', m.privacy);
  await desk.ctx.close();
});

for (const r of results) console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   ' + r.detail : ''));
const bad = results.filter(r => !r.pass);
console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' checks passed');
console.log(bad.length ? 'RESULT: ' + bad.length + ' FAILED' : 'RESULT: clean');
await browser.close();
server.close();
process.exit(bad.length ? 1 : 0);
