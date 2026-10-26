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
  /* THIS CHECK USED TO ASSERT THE OPPOSITE, and it was right at the time: the rule
     was that an older notification belonged in Notifications and not in the inbox.
     The rule changed, because the rule was wrong -- Gmail's Inbox counted 886 against
     Giant's 13 on the same mailbox, and the difference was everything Google had
     filed under Updates or Promotions. The inbox now holds what Gmail says is in the
     inbox; Notifications is a view of part of it, not a place things are moved to.
     Kept rather than deleted, pointing the other way, so the change is visible. */
  check('an older notification is in the inbox too, as it is in Gmail',
    m.items.includes('em-4'), JSON.stringify(m.items));
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
             box: (() => { const b = row.querySelector('[data-mark-read]');
               const r = b && b.getBoundingClientRect();
               return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null; })(),
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
  /* Measured, not merely present. The box had no CSS rule of its own -- only a
     :hover -- so it rendered as a bare <button>: wider than it is tall, with the
     browser's own border. "There is a checkbox" passed the whole time. */
  check('the checkbox is a square box', !!m.box && Math.abs(m.box.w - m.box.h) <= 1 &&
    m.box.w >= 14 && m.box.w <= 20, JSON.stringify(m.box));
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

/* ── The checkbox ──────────────────────────────────────────────────────────────
   It was shaped exactly like Gmail's select box and did something else: one click
   marked the message read, wrote the id to localStorage and animated the row away.
   Nothing on screen said a selection existed, because none did.

   Each assertion below fails against that: the row used to be gone 400ms later, the
   id used to be in localStorage after a single click, and there was no bulk bar at
   all. The star is worse -- it was drawn in every row and wired in neither render
   path, so clicking it opened the message. */
await step('the checkbox selects, and does not quietly hide', async () => {
  const before = await page.evaluate(() => ({
    rows: document.querySelectorAll('#inboxRows .mailitem[data-mail-id]').length,
    id: (document.querySelector('#inboxRows .mailitem[data-mail-id]') || {}).dataset?.mailId,
  }));
  check('there are rows to select', before.rows > 1, JSON.stringify(before));
  if (!before.rows) return;

  await page.locator('#inboxRows .mailitem[data-mail-id] [data-mark-read]').first().click();
  // Longer than the old hide animation (180ms wait + 220ms collapse) on purpose.
  await page.waitForTimeout(900);

  const after = await page.evaluate((id) => {
    const el = document.querySelector('#inboxRows .mailitem[data-mail-id="' + id + '"]');
    const r = el ? el.getBoundingClientRect() : null;
    const bar = document.getElementById('inboxBulkBar');
    const hk = Object.keys(localStorage).find(k => k.startsWith('giant_inbox_hidden_'));
    let hidden = [];
    try { hidden = JSON.parse(localStorage.getItem(hk) || '[]'); } catch (_) {}
    return {
      stillThere: !!el,
      visible: !!r && r.height > 10 && r.width > 10,
      selClass: !!el && el.classList.contains('sel'),
      pressed: el ? (el.querySelector('[data-mark-read]') || {}).getAttribute?.('aria-pressed') : null,
      count: (document.getElementById('inboxSelCount') || {}).textContent,
      barOn: !!bar && bar.classList.contains('has-sel'),
      hiddenHasIt: hidden.includes(id),
      rows: document.querySelectorAll('#inboxRows .mailitem[data-mail-id]').length,
      readerOpen: !!document.querySelector('.screen[data-screen="inbox"].mail-open'),
    };
  }, before.id);

  // Measured, not merely present: the old row was still in the DOM for 220ms while it
  // collapsed to 0px, so "it exists" would have passed against the bug.
  check('the row stays, at its full height', after.stillThere && after.visible, JSON.stringify(after));
  check('the list did not lose a row', after.rows === before.rows, before.rows + ' -> ' + after.rows);
  check('the row reads as selected', after.selClass && after.pressed === 'true', after.pressed);
  check('the bulk bar counts it', after.barOn && /^1 selected/.test(after.count || ''), after.count);
  check('nothing was hidden behind your back', !after.hiddenHasIt, String(after.hiddenHasIt));
  check('and selecting did not open the message', !after.readerOpen, String(after.readerOpen));
});

await step('select all, then cancel', async () => {
  await page.locator('#inboxSelectAll').click();
  await page.waitForTimeout(300);
  const all = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#inboxRows .mailitem[data-mail-id]')];
    return { rows: rows.length, sel: rows.filter(r => r.classList.contains('sel')).length,
             count: (document.getElementById('inboxSelCount') || {}).textContent };
  });
  check('All selects every row shown', all.rows > 1 && all.sel === all.rows, JSON.stringify(all));
  check('and the count agrees with the rows', all.count === all.rows + ' selected', all.count);

  await page.locator('#inboxBulkBar [data-bulk="clear"]').click();
  await page.waitForTimeout(300);
  const cleared = await page.evaluate(() => ({
    sel: document.querySelectorAll('#inboxRows .mailitem.sel').length,
    barOn: document.getElementById('inboxBulkBar').classList.contains('has-sel'),
    count: (document.getElementById('inboxSelCount') || {}).textContent,
    rows: document.querySelectorAll('#inboxRows .mailitem[data-mail-id]').length,
  }));
  check('Cancel clears the selection', cleared.sel === 0 && !cleared.barOn, JSON.stringify(cleared));
  check('and cancelling removed nothing', cleared.rows === all.rows, all.rows + ' -> ' + cleared.rows);
});

await step('the star reaches Gmail, not just our copy', async () => {
  /* Starring used to write is_starred to our table and nothing else: the star never
     appeared in Gmail, a star added in Gmail never appeared here, and the two drifted
     apart in both directions. Gmail is the mailbox, so it is told first -- and if it
     refuses, the star goes back rather than sitting there claiming something untrue. */
  let modified = [];
  await page.route('**gmail.googleapis.com/**/modify', (route) => {
    modified.push({ url: route.request().url(), body: route.request().postData() });
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  const id = await page.evaluate(() =>
    (document.querySelector('#inboxRows .mailitem[data-mail-id]') || {}).dataset?.mailId);
  const was = await page.evaluate((i) =>
    !!(window.__mockDB.emails.find(e => e.id === i) || {}).is_starred, id);

  await page.locator('#inboxRows .mailitem[data-mail-id] [data-star]').first().click();
  await page.waitForTimeout(1500);

  const now = await page.evaluate((i) => {
    const row = document.querySelector('#inboxRows .mailitem[data-mail-id="' + i + '"]');
    return {
      db: !!(window.__mockDB.emails.find(e => e.id === i) || {}).is_starred,
      painted: !!row && row.querySelector('[data-star]').classList.contains('on'),
      glyph: row ? row.querySelector('[data-star]').textContent : '',
      readerOpen: !!document.querySelector('.screen[data-screen="inbox"].mail-open'),
    };
  }, id);

  check('Gmail was told about the star', modified.length === 1, 'modify calls=' + modified.length);
  check('with the STARRED label, added not removed',
    /"addLabelIds":\["STARRED"\]/.test((modified[0] || {}).body || ''), (modified[0] || {}).body);
  check('and our copy follows', now.db === !was, was + ' -> ' + now.db);
  check('the row shows it', now.painted === !was && now.glyph === (now.db ? '★' : '☆'), now.glyph);
  check('starring does not open the message', !now.readerOpen, String(now.readerOpen));

  // And if Gmail refuses, nothing is claimed.
  await page.unroute('**gmail.googleapis.com/**/modify');
  await page.route('**gmail.googleapis.com/**/modify', (route) =>
    route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":{"message":"no"}}' }));
  await page.locator('#inboxRows .mailitem[data-mail-id] [data-star]').first().click();
  await page.waitForTimeout(1500);
  const after = await page.evaluate((i) =>
    !!(window.__mockDB.emails.find(e => e.id === i) || {}).is_starred, id);
  check('a star Gmail refused is not written here', after === now.db, String(after));
  await page.unroute('**gmail.googleapis.com/**/modify');
  await page.route('**gmail.googleapis.com/**/modify', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
});

await step('Mark read marks read, and does not hide anything', async () => {
  /* It used to write the ids into localStorage and drop the rows: a state that lived
     in one browser, that Gmail knew nothing about, and that nothing could undo. Gmail
     has no such idea -- read is read, and the message stays where it is. */
  let modified = [];
  await page.unroute('**gmail.googleapis.com/**/modify').catch(() => {});
  await page.route('**gmail.googleapis.com/**/modify', (route) => {
    modified.push(route.request().postData());
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  const picked = await page.evaluate(() =>
    [...document.querySelectorAll('#inboxRows .mailitem[data-mail-id]')]
      .filter(el => el.classList.contains('unread')).slice(0, 2).map(el => el.dataset.mailId));
  check('there are unread rows to mark', picked.length > 0, JSON.stringify(picked));
  if (!picked.length) return;
  const before = await page.evaluate(() =>
    document.querySelectorAll('#inboxRows .mailitem[data-mail-id]').length);

  for (const id of picked) {
    await page.locator('#inboxRows .mailitem[data-mail-id="' + id + '"] [data-mark-read]').click();
  }
  await page.waitForTimeout(300);
  await page.locator('#inboxBulkBar [data-bulk="read"]').click();
  await page.waitForTimeout(2000);

  const after = await page.evaluate((ids) => {
    const hk = Object.keys(localStorage).filter(k => k.startsWith('giant_inbox_hidden_'));
    return {
      rows: document.querySelectorAll('#inboxRows .mailitem[data-mail-id]').length,
      stillThere: ids.every(i => !!document.querySelector('#inboxRows .mailitem[data-mail-id="' + i + '"]')),
      stillBold: ids.some(i => {
        const el = document.querySelector('#inboxRows .mailitem[data-mail-id="' + i + '"]');
        return el && el.classList.contains('unread');
      }),
      db: ids.map(i => (window.__mockDB.emails.find(e => e.id === i) || {}).is_unread),
      hiddenKeys: hk.length,
      sel: document.querySelectorAll('#inboxRows .mailitem.sel').length,
    };
  }, picked);

  check('Gmail was told to clear UNREAD',
    modified.length === picked.length
    && modified.every(b => /"removeLabelIds":\["UNREAD"\]/.test(b || '')),
    'calls=' + modified.length + ' ' + (modified[0] || ''));
  check('the messages stay in the list', after.stillThere && after.rows === before,
    before + ' -> ' + after.rows);
  check('they stop being bold', !after.stillBold, String(after.stillBold));
  check('and our copy says read', after.db.every(v => v === false), JSON.stringify(after.db));
  check('nothing was written to a hide list', after.hiddenKeys === 0, String(after.hiddenKeys));
  check('the selection resets afterwards', after.sel === 0, String(after.sel));
});

/* ── Three things found by using the screen ───────────────────────────────── */

await step('Compose opens from the list', async () => {
  /* The compose, template-picker and email-settings dialogs all sat inside
     <main class="reader">, and the reader is display:none until a message is open --
     so every one of them was unreachable from the list, which is the only place they
     are opened from. A fixed-positioned dialog is still removed by a hidden ancestor.
     Measured, not asserted present: the overlay was in the DOM the whole time, at
     0x0 and opacity 0. */
  await page.evaluate(() => document.getElementById('composeMailBtn')?.click());
  await page.waitForTimeout(900);
  const m = await page.evaluate(() => {
    const el = document.getElementById('composeMailModal');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const to = document.getElementById('composeTo');
    const tr = to && to.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), op: cs.opacity,
             on: el.classList.contains('on'),
             toVisible: !!tr && tr.width > 100 && tr.height > 10 };
  });
  check('the compose dialog exists', !!m, String(m));
  if (!m) return;
  check('it fills the screen, not 0x0', m.w > 600 && m.h > 400, m.w + 'x' + m.h);
  check('and it is actually visible', m.op === '1' && m.on, m.op);
  check('with a To field you can type in', m.toVisible, String(m.toVisible));

  const others = await page.evaluate(() => ['emailTplPickModal', 'inboxEmailSettingsModal', 'emailTplEditModal']
    .map(id => { const el = document.getElementById(id);
      return { id, inReader: !!el && !!el.closest('.reader') }; }));
  check('the other inbox dialogs left the reader too',
    others.every(o => !o.inReader), JSON.stringify(others));

  /* An hour after the page loaded the token in memory is stale, and Compose said
     "Gmail not connected" to somebody whose Gmail is connected -- the refresh token
     was sitting in the row the whole time. */
  const warn = await page.evaluate(() => {
    const a = document.getElementById('composeAlert');
    return { cls: a ? a.className : null, text: (a ? a.textContent : '').trim().slice(0, 60) };
  });
  check('it does not claim Gmail is disconnected', !/error/.test(warn.cls || ''),
    warn.cls + ' ' + warn.text);

  await page.evaluate(() => { const el = document.getElementById('composeMailModal');
    if (el) el.classList.remove('on'); });
  await page.waitForTimeout(300);
});

await step('the account chip is gone', async () => {
  const n = await page.evaluate(() =>
    document.querySelectorAll('.screen[data-screen="inbox"] .acct-tabs, .screen[data-screen="inbox"] .acct').length);
  // A single hard-coded "Gmail" pill that selected nothing: the account lives in the
  // connection, not in a tab strip of one.
  check('no dead Gmail pill above the list', n === 0, String(n));
});

await step('Refresh uses the stored refresh token, not a sign-in popup', async () => {
  /* The refresh button went to the GIS popup whenever the access token had expired.
     On any machine whose address is not an Authorized JavaScript origin for the OAuth
     client -- a dev laptop on :8888, for one -- Google answers popup_failed_to_open
     and no mail arrives. There has been a refresh token in the row since the code
     flow landed; the swap needs the client secret, so it goes through the function. */
  let fnCalls = 0;
  await page.route('**/.netlify/functions/google-oauth', (route) => {
    fnCalls++;
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ access_token: 'fresh-from-refresh-token', expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify email' }) });
  });
  // Gmail itself is not the subject here; the token swap is.
  await page.route('**://*.googleapis.com/**', r => r.abort());
  let popups = 0;
  await page.exposeFunction('__countPopup', () => { popups++; });
  await page.evaluate(() => {
    window.google = window.google || {};
    window.google.accounts = window.google.accounts || {};
    window.google.accounts.oauth2 = { initTokenClient: () => {
      window.__countPopup();
      return { requestAccessToken: () => window.__countPopup(), callback: null };
    } };
    // The hour is up, which is the state that used to reach for the popup.
    const row = window.__mockDB.gmail_tokens.find(t => t.slot === 1);
    row.expires_at = new Date(Date.now() - 5 * 60000).toISOString();
    row.access_token = 'stale-token';
  });

  await page.locator('#inboxRefreshBtn').click();
  await page.waitForTimeout(2500);

  const out = await page.evaluate(() => {
    const row = window.__mockDB.gmail_tokens.find(t => t.slot === 1);
    return { token: row.access_token, future: new Date(row.expires_at).getTime() > Date.now() };
  });

  check('the function was asked for a fresh token', fnCalls > 0, 'calls=' + fnCalls);
  check('and the new token was stored', out.token === 'fresh-from-refresh-token', out.token);
  check('with an expiry in the future', out.future, String(out.future));
  check('no Google sign-in popup was opened', popups === 0, 'popups=' + popups);
});

/* ── When Gmail will not connect, say which of the five things happened ─────
   "Gmail not connected (or token expired)" was the single answer to: never connected,
   pointing at a mailbox that no longer exists, a revoked grant, a refresh call that
   failed, and a missing permission. Only one of those is fixed by reconnecting, and
   the screen gave no way to tell them apart -- which is how an afternoon goes. */

const composeAlertText = async () => {
  await page.evaluate(() => { const el = document.getElementById('composeMailModal');
    if (el) el.classList.remove('on'); });
  await page.evaluate(() => document.getElementById('composeMailBtn')?.click());
  await page.waitForTimeout(1200);
  return page.evaluate(() => {
    const a = document.getElementById('composeAlert');
    const el = document.getElementById('composeMailModal');
    if (el) el.classList.remove('on');
    return { cls: a ? a.className : '', text: (a ? a.textContent : '').trim() };
  });
};

await step('a refusal from Google is quoted, not swallowed', async () => {
  await page.unroute('**/.netlify/functions/google-oauth');
  await page.route('**/.netlify/functions/google-oauth', r => r.fulfill({
    status: 400, contentType: 'application/json',
    body: JSON.stringify({ error: 'invalid_client: no secret configured' }) }));
  await page.evaluate(() => {
    const row = window.__mockDB.gmail_tokens.find(t => t.slot === 1);
    row.expires_at = new Date(Date.now() - 5 * 60000).toISOString();
  });
  const a = await composeAlertText();
  check('the warning is shown', /error/.test(a.cls), a.cls);
  check('and it repeats what Google said', /invalid_client/.test(a.text), a.text.slice(0, 120));
});

await step('a revoked connection says so', async () => {
  await page.unroute('**/.netlify/functions/google-oauth');
  await page.route('**/.netlify/functions/google-oauth', r => r.fulfill({
    status: 410, contentType: 'application/json',
    body: JSON.stringify({ error: 'invalid_grant', dead: true }) }));
  await page.evaluate(() => {
    const row = window.__mockDB.gmail_tokens.find(t => t.slot === 1);
    row.expires_at = new Date(Date.now() - 5 * 60000).toISOString();
    row.refresh_token = 'mock-refresh-1';
  });
  const a = await composeAlertText();
  check('it names the cause, not just the symptom',
    /revoked|ended this connection|password/i.test(a.text), a.text.slice(0, 120));
  check('and it does not still say "token expired"',
    !/token expired/i.test(a.text), a.text.slice(0, 120));
});

await step('a mailbox with no refresh token asks for one reconnect', async () => {
  await page.evaluate(() => {
    const row = window.__mockDB.gmail_tokens.find(t => t.slot === 1);
    row.expires_at = new Date(Date.now() - 5 * 60000).toISOString();
    row.refresh_token = null;
  });
  const a = await composeAlertText();
  check('it explains the reconnect is once, not hourly',
    /stays connected/i.test(a.text), a.text.slice(0, 140));
});

await step('a slot pointing at nothing heals instead of lying', async () => {
  /* The slot is remembered in localStorage. Remove a mailbox, or connect one on
     another machine, and this browser asks for a row that is not there -- which read
     as "Gmail not connected" on an account that was connected the whole time. */
  await page.unroute('**/.netlify/functions/google-oauth');
  await page.route('**/.netlify/functions/google-oauth', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ access_token: 'healed-token', expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify email' }) }));
  const SLOT_KEY = 'giant.gmailSlot';   // the key the app writes, read from the source
  await page.evaluate(({ k }) => {
    // Only slot 1 is this person's; point the browser at a slot nobody has.
    const db = window.__mockDB.gmail_tokens;
    db.forEach(t => { if (t.slot === 2) t.slot = 7; });
    const row = db.find(t => t.slot === 1);
    row.expires_at = new Date(Date.now() + 50 * 60000).toISOString();
    row.access_token = 'good-token';
    row.refresh_token = 'mock-refresh-1';
    localStorage.setItem(k, '5');
  }, { k: SLOT_KEY });
  const a = await composeAlertText();
  const healed = await page.evaluate(({ k }) => localStorage.getItem(k), { k: SLOT_KEY });
  // The key has to be the real one, or this measures nothing at all.
  check('the slot was pointing at a mailbox that is not there', SLOT_KEY === 'giant.gmailSlot');
  check('it falls back to the mailbox that exists', healed === '1', 'slot=' + healed);
  check('a connected mailbox is not called disconnected',
    !/error/.test(a.cls) && !a.text, a.cls + ' ' + a.text.slice(0, 100));
});

await step('connecting Gmail uses the code flow, not the sign-in popup', async () => {
  /* "Error 400: origin_mismatch". The Connect button ran Google Identity Services,
     which checks the page's address against the OAuth client's Authorized JavaScript
     origins -- so it failed outright anywhere but the live domain, and even where it
     worked it returned no refresh token, which is why a connected mailbox stopped
     working every hour. The code flow validates the redirect URI instead. */
  let sentTo = null;
  /* Aborted, not fulfilled. Letting this navigation through replaces the app with
     Google's page, and every step after it then runs against a blank document --
     which is how a later check "fails" for a reason that has nothing to do with it.
     The request URL is still readable from an aborted route, which is all this needs. */
  await page.route('**accounts.google.com/**', (route) => {
    sentTo = route.request().url();
    route.abort();
  });
  await page.evaluate(() => {
    // No mailbox at all: the state that shows Connect Gmail.
    window.__mockDB.gmail_tokens.length = 0;
    try { localStorage.removeItem('giant.gmailSlot'); } catch (_) {}
  });
  const clicked = await page.evaluate(() => {
    const b = document.getElementById('inboxConnectBtn');
    if (!b) return false;
    b.click();
    return true;
  });
  check('there is a Connect Gmail button', clicked);
  await page.waitForTimeout(1500);

  check('it goes to Google', !!sentTo && /accounts\.google\.com/.test(sentTo), String(sentTo).slice(0, 80));
  if (!sentTo) return;
  const u = new URL(sentTo);
  // response_type=code is the whole difference. The popup flow asks for a token.
  check('asking for a code, not a token', u.searchParams.get('response_type') === 'code',
    u.searchParams.get('response_type') || sentTo.slice(0, 120));
  // Without BOTH of these Google quietly returns no refresh token and the mailbox
  // goes back to expiring in an hour.
  check('offline access is requested', u.searchParams.get('access_type') === 'offline',
    u.searchParams.get('access_type'));
  check('and consent is forced, or no refresh token comes back',
    u.searchParams.get('prompt') === 'consent', u.searchParams.get('prompt'));
  check('it hands back to the registered redirect URI',
    /\/oauth\/google\/callback$/.test(u.searchParams.get('redirect_uri') || ''),
    u.searchParams.get('redirect_uri'));
  check('and it is not the gsi popup endpoint',
    !/\/gsi\//.test(sentTo), sentTo.slice(0, 100));
});

await step('the implicit flow is gone from the page', async () => {
  // The script tag is the tell: GIS is loaded on demand, so its absence after the
  // inbox has been driven means nothing asked for it.
  const gis = await page.evaluate(() =>
    !!document.querySelector('script[src*="accounts.google.com/gsi/client"]'));
  check('Google Identity Services was never loaded', !gis, String(gis));
});

/* ── Inbox means inbox, and the list says how much of it you are seeing ──── */

/* Connecting navigates the page to Google, and whether that navigation is fulfilled
   or aborted the app is gone afterwards -- aborting lands on chrome-error://. Anything
   that runs after it has to put the app back, or it fails for a reason that has
   nothing to do with what it is testing. */
const ensureApp = async () => {
  const live = await page.evaluate(() => !!window.__mockDB).catch(() => false);
  if (live) return;
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#view-app.on', { timeout: 30000 });
  await page.waitForTimeout(2200);
  await page.evaluate(() => document.querySelector('#appSidebar .nav-item[data-screen="inbox"]')?.click());
  await page.waitForTimeout(2200);
};

await step('Inbox counts everything Gmail counts', async () => {
  await ensureApp();
  /* Gmail's Inbox read 886 and Giant's read 13 on the same mailbox. Giant was
     subtracting everything Google had filed under Updates or Promotions and calling
     the remainder "Primary" -- so 873 messages were not missing, they were under two
     headings nobody opened. Gmail only splits like that when category tabs are on. */
  await page.evaluate(() => {
    const db = window.__mockDB.emails;
    // The connect-flow step above emptied gmail_tokens; without a live row the screen
    // shows the connect banner and clears the list, so there would be nothing to count.
    const me = (db[0] && db[0].profile_id)
      || (window.__mockDB.profiles && window.__mockDB.profiles[0] && window.__mockDB.profiles[0].id);
    window.__mockDB.gmail_tokens.length = 0;
    window.__mockDB.gmail_tokens.push({
      profile_id: me, slot: 1, email: 'big@reachgiant.com', label: null,
      access_token: 'good-token', refresh_token: 'mock-refresh-1',
      expires_at: new Date(Date.now() + 50 * 60000).toISOString(),
      scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify email',
      connected_at: new Date().toISOString(), last_sync_at: null });
    try { localStorage.setItem('giant.gmailSlot', '1'); } catch (_) {}
    db.length = 0;
    const mk = (i, labels) => ({
      id: 'bulk-' + i, profile_id: me, gmail_id: 'g-bulk-' + i, thread_id: 't-bulk-' + i,
      from_email: 'sender' + i + '@example.com', from_name: 'Sender ' + i,
      to_emails: 'me@example.com', subject: 'Message ' + i, snippet: 'body ' + i,
      is_unread: i % 3 === 0, is_starred: false, has_attachments: false,
      labels, received_at: new Date(Date.now() - (i + 2) * 86400000).toISOString()
    });
    // 20 plain, 40 Updates, 30 Promotions -- all of them in the inbox, as Gmail has it.
    for (let i = 0; i < 20; i++) db.push(mk(i, ['INBOX']));
    for (let i = 20; i < 60; i++) db.push(mk(i, ['INBOX', 'CATEGORY_UPDATES']));
    for (let i = 60; i < 90; i++) db.push(mk(i, ['INBOX', 'CATEGORY_PROMOTIONS']));
    try { Object.keys(localStorage).filter(k => k.startsWith('giant_inbox_hidden_'))
      .forEach(k => localStorage.removeItem(k)); } catch (_) {}
  });
  // A folder click is the app's own way back into renderInbox; nothing is exported.
  await page.evaluate(() => document.querySelector('.ml-folder[data-mail-filter="SENT"]')?.click());
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector('.ml-folder[data-mail-filter="INBOX"]')?.click());
  await page.waitForTimeout(1800);

  const c = await page.evaluate(() => ({
    inbox: (document.getElementById('folderCountInbox') || {}).textContent,
    notif: (document.getElementById('folderCountNotifications') || {}).textContent,
    news: (document.getElementById('folderCountNewsletters') || {}).textContent,
  }));
  // 90 in the inbox, of which 40 are Updates and 30 Promotions. Inbox counts all 90.
  check('Inbox is every inbox message, not the leftovers', c.inbox === '90',
    'inbox=' + c.inbox + ' (was 20 under the old rule)');
  check('Notifications still counts its own', c.notif === '40', c.notif);
  check('Newsletters still counts its own', c.news === '30', c.news);
});

await step('the list says how much of it you are seeing', async () => {
  const first = await page.evaluate(() => ({
    rows: document.querySelectorAll('#inboxRows .mailitem[data-mail-id]').length,
    more: !!document.getElementById('inboxMoreRow'),
    label: (document.querySelector('.ml-more-n') || {}).textContent,
  }));
  // It used to stop at 50 and say nothing -- indistinguishable from a 50-message inbox.
  check('a page is 50 rows', first.rows === 50, String(first.rows));
  check('and it admits there is more', first.more, String(first.more));
  check('naming how much more', (first.label || '').replace(/\s+/g, ' ') === '50 of 90', first.label);

  await page.locator('#inboxMoreBtn').click();
  await page.waitForTimeout(1200);
  const second = await page.evaluate(() => ({
    rows: document.querySelectorAll('#inboxRows .mailitem[data-mail-id]').length,
    more: !!document.getElementById('inboxMoreRow'),
  }));
  check('Load more shows the rest', second.rows === 90, String(second.rows));
  check('and then stops offering', !second.more, String(second.more));

  // Switching folders must start again at the top: carrying "show 90" into a folder
  // of 40 would be silent nonsense.
  await page.evaluate(() => document.querySelector('.ml-folder[data-mail-filter="NOTIFICATIONS"]')?.click());
  await page.waitForTimeout(1200);
  const other = await page.evaluate(() => ({
    rows: document.querySelectorAll('#inboxRows .mailitem[data-mail-id]').length,
    label: (document.querySelector('.ml-more-n') || {}).textContent,
  }));
  check('a new folder starts at the first page again', other.rows === 40 || other.rows === 40,
    String(other.rows));
});

await step('the page asks the server to sync, it does not sync itself', async () => {
  /* The browser used to run the whole sync: five label queries, download every
     message, write them all from the page. That meant a mailbox was only ever as
     current as the last time somebody had the Email tab open. The ten-minute schedule
     and the Refresh button now call the same endpoint, so there is one implementation
     instead of two that drift -- and the dedupe and history logic live there, covered
     by tools_gmail_sync_check.mjs.

     What is checked HERE is the thing the page is still responsible for: asking. */
  await ensureApp();
  let syncCalls = 0, gmailCalls = 0;
  await page.unroute('**://*.googleapis.com/**').catch(() => {});
  await page.route('**googleapis.com/**', (route) => { gmailCalls++; route.abort(); });
  await page.route('**/.netlify/functions/gmail-sync', (route) => {
    syncCalls++;
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, results: [{ ok: true, mode: 'history', added: 0 }] }) });
  });
  await page.evaluate(() => {
    const row = window.__mockDB.gmail_tokens[0];
    row.expires_at = new Date(Date.now() + 50 * 60000).toISOString();
    row.access_token = 'good-token';
  });

  await page.locator('#inboxRefreshBtn').click();
  await page.waitForTimeout(3000);
  check('Refresh asks the sync endpoint', syncCalls === 1, 'calls=' + syncCalls);
  check('and the page downloads no mail itself', gmailCalls === 0, 'gmail calls=' + gmailCalls);

  /* A FAILED SYNC MUST NOT BE ANNOUNCED AS A GOOD ONE. On the live site the endpoint
     answered 403 and the screen showed "Sync failed: sync failed (403)" with
     "Inbox refreshed" directly underneath it -- two toasts, one of them false, and
     nothing to say which. syncGmailInbox caught its own error and returned nothing,
     so the caller could not tell the difference. */
  await page.unroute('**/.netlify/functions/gmail-sync');
  await page.route('**/.netlify/functions/gmail-sync', (route) =>
    route.fulfill({ status: 403, contentType: 'text/plain', body: '' }));
  /* Recorded as they appear, not read afterwards: a toast auto-dismisses, so looking
     three seconds later can find an empty host and call that "nothing claimed
     success" -- a check that passes because it measured nothing. */
  await page.evaluate(() => {
    window.__toasts = [];
    const host = document.getElementById('toastHost');
    if (!host) return;
    host.querySelectorAll('.toast').forEach(t => t.remove());
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType === 1) window.__toasts.push((n.textContent || '').trim());
    }))).observe(host, { childList: true });
  });
  await page.locator('#inboxRefreshBtn').click();
  await page.waitForTimeout(3000);
  const said = await page.evaluate(() => (window.__toasts || []).join(' | '));
  check('a 403 is reported', /fail/i.test(said), said.slice(0, 120));
  check('and nothing claims the inbox refreshed', !/Inbox refreshed/i.test(said),
    said.slice(0, 120));
});

await step('the categories rail reads like the rest of the app', async () => {
  /* Each folder row carried its own tinted gradient and coloured border -- a stack of
     seven little cards in a 184px column, next to a sidebar where every row is plain.
     Measured, not eyeballed: the old rows were ~29px tall with 12px text and a
     background-image on every one of them. */
  await ensureApp();
  const m = await page.evaluate(() => {
    const rail = document.querySelector('.ml-rail');
    const rows = [...document.querySelectorAll('.ml-rail .ml-folder')];
    if (!rail || !rows.length) return null;
    const read = (el) => {
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      return { h: Math.round(r.height), font: parseFloat(cs.fontSize),
               bgImage: cs.backgroundImage, border: parseFloat(cs.borderTopWidth) };
    };
    const nav = document.querySelector('#appSidebar .nav-item');
    const navCs = nav ? getComputedStyle(nav) : null;
    return {
      railW: Math.round(rail.getBoundingClientRect().width),
      rows: rows.map(read),
      navFont: navCs ? parseFloat(navCs.fontSize) : null,
      icon: (() => { const i = rows[0].querySelector('svg');
        const r = i && i.getBoundingClientRect();
        return r ? Math.round(r.width) : 0; })(),
      count: !!rows[0].querySelector('.ml-folder-c'),
    };
  });
  check('there is a rail with folders in it', !!m && m.rows.length >= 6, m ? m.rows.length : 'none');
  if (!m) return;
  check('it has room to breathe', m.railW >= 200, m.railW + 'px');
  check('every row is a comfortable height', m.rows.every(r => r.h >= 32),
    JSON.stringify(m.rows.map(r => r.h)));
  // The sidebar beside it is the standard; matching it is the whole point.
  check('the text is the size the sidebar uses',
    m.navFont && m.rows.every(r => r.font === m.navFont),
    'rail ' + m.rows[0].font + ' vs sidebar ' + m.navFont);
  check('no row is a card any more',
    m.rows.every(r => r.bgImage === 'none' && r.border === 0),
    JSON.stringify(m.rows.map(r => r.bgImage.slice(0, 18) + '|' + r.border)));
  check('the icons are still there, at sidebar size', m.icon === 16, m.icon + 'px');
  check('and the counts stay on the right', m.count);
});

await step('the list header has room to breathe', async () => {
  /* The title, the search box, the select bar and the first message were stacked with
     4px between them and a hard rule running the full width right underneath --
     everything touching everything, with a separator doing the job that space should.
     Measured as gaps, because "it looks cramped" is not something a check can read. */
  await ensureApp();
  /* Scrolled to the top first. An earlier step pressed Load more, and measuring a
     viewport gap against a scrolled list gave -723px -- a number that says nothing
     about spacing and everything about where the list happened to be. */
  await page.evaluate(() => {
    const sc = document.querySelector('.ml-scroll');
    if (sc) sc.scrollTop = 0;
  });
  await page.waitForTimeout(250);
  const m = await page.evaluate(() => {
    const head = document.querySelector('.ml-head');
    const search = document.querySelector('.ml-search');
    const bulk = document.getElementById('inboxBulkBar');
    const row = document.querySelector('#inboxRows .mailitem');
    if (!head || !search || !bulk || !row) return null;
    const r = (el) => el.getBoundingClientRect();
    return {
      headPadTop: parseFloat(getComputedStyle(head).paddingTop),
      titleGap: Math.round(r(search).top - r(head.querySelector('h2')).bottom),
      bulkH: Math.round(r(bulk).height),
      searchToFirstRow: Math.round(r(row).top - r(search).bottom),
    };
  });
  check('there is a header to measure', !!m, JSON.stringify(m));
  if (!m) return;
  check('the title is not jammed against the top', m.headPadTop >= 18, m.headPadTop + 'px');
  check('the search box clears the title', m.titleGap >= 20, m.titleGap + 'px');
  check('the select bar is a bar, not a seam', m.bulkH >= 36, m.bulkH + 'px');
  check('and the first message clears the search box', m.searchToFirstRow >= 60,
    m.searchToFirstRow + 'px');
});

await step('mail arrives without anybody pressing Refresh', async () => {
  /* Three things have to line up, and only one was here. The server syncs every ten
     minutes; realtime pushes what it writes into an open page. What was missing was
     the sync running from a page that is open: the old poll required the EMAIL SCREEN
     to be the one showing, so sitting in Chat meant no sync and an unread badge that
     had stopped counting -- the number people actually watch. */
  await ensureApp();
  let syncCalls = 0;
  await page.unroute('**/.netlify/functions/gmail-sync').catch(() => {});
  await page.route('**/.netlify/functions/gmail-sync', (route) => {
    syncCalls++;
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, results: [{ ok: true, mode: 'history', added: 0 }] }) });
  });

  // On another screen entirely -- which used to mean no syncing at all.
  await page.evaluate(() => document.querySelector('#appSidebar .nav-item[data-screen="chat"]')?.click());
  await page.waitForTimeout(1200);
  const onInbox = await page.evaluate(() =>
    !!document.querySelector('.screen[data-screen="inbox"].on'));
  check('we are no longer on the Email screen', !onInbox, String(onInbox));

  syncCalls = 0;
  await page.evaluate(() => { window.__inboxTickProbe = true; });
  // Coming back to the window syncs straight away rather than waiting for a tick.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(300);
  check('nothing syncs while the tab is hidden', syncCalls === 0, 'calls=' + syncCalls);

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(2500);
  check('coming back to the tab syncs at once, from any screen',
    syncCalls >= 1, 'calls=' + syncCalls);

  // And it does not stampede: focus and visibility together are still one sync.
  const before = syncCalls;
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  await page.waitForTimeout(1500);
  check('a flurry of focus events is still one sync', syncCalls === before,
    before + ' -> ' + syncCalls);

  // Realtime is what makes a row appear without any sync at all.
  const live = await page.evaluate(() => typeof window.__mock?.emit === 'function');
  if (live) {
    await page.evaluate(() => document.querySelector('#appSidebar .nav-item[data-screen="inbox"]')?.click());
    await page.waitForTimeout(1500);
    /* On the INBOX folder, not wherever an earlier step left it. The new row is
       labelled INBOX, so emitting it while the list is filtered to Notifications
       proves nothing -- and reads as "realtime is broken". */
    await page.evaluate(() => document.querySelector('.ml-folder[data-mail-filter="INBOX"]')?.click());
    await page.waitForTimeout(1500);
    const was = await page.evaluate(() =>
      document.querySelectorAll('#inboxRows .mailitem[data-mail-id]').length);
    await page.evaluate(() => {
      const me = window.__mockDB.emails[0].profile_id;
      const row = { id: 'rt-1', profile_id: me, gmail_id: 'g-rt-1', thread_id: 't-rt-1',
        from_email: 'live@example.com', from_name: 'Arrived By Itself',
        to_emails: 'me@example.com', subject: 'Pushed in', snippet: 'no refresh pressed',
        is_unread: true, is_starred: false, has_attachments: false,
        labels: ['INBOX'], received_at: new Date().toISOString() };
      window.__mockDB.emails.unshift(row);
      window.__mock.emit('emails', 'INSERT', row);
    });
    await page.waitForTimeout(2000);
    const now = await page.evaluate(() => ({
      rows: document.querySelectorAll('#inboxRows .mailitem[data-mail-id]').length,
      shown: !!document.querySelector('#inboxRows .mailitem[data-mail-id="rt-1"]'),
      first: (document.querySelector('#inboxRows .mailitem[data-mail-id]') || {}).dataset?.mailId,
      count: (document.getElementById('folderCountInbox') || {}).textContent,
    }));
    /* The row COUNT cannot grow -- a page is capped at 50 -- so asserting was+1 here
       measured the cap, not the arrival, and failed on working code. What proves it
       is the message being on screen, at the top, and counted. */
    check('a message written by the server appears with no Refresh', now.shown,
      'rows ' + was + ' -> ' + now.rows + ', shown=' + now.shown);
    check('and it is the newest, so it is at the top', now.first === 'rt-1', now.first);
    check('the Inbox count went up', Number(now.count) === 91, now.count);
  } else {
    check('the mock can deliver a realtime event', false, 'no __mock.emit');
  }
});

await step('refreshing does not make the list flash', async () => {
  /* Every row slid in on an entry animation, and the list is rebuilt on every render
     -- so a refresh, a realtime row, or the 60-second tick replayed it on all fifty
     rows at once. The whole list flashing, several times a minute, while you read. */
  await ensureApp();
  let syncBody = { ok: true, results: [{ ok: true, mode: 'history', added: 0 }] };
  await page.unroute('**/.netlify/functions/gmail-sync').catch(() => {});
  await page.route('**/.netlify/functions/gmail-sync', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(syncBody) }));

  const animOf = () => page.evaluate(() => {
    const row = document.querySelector('#inboxRows .mailitem');
    return row ? getComputedStyle(row).animationName : null;
  });
  const settled = await animOf();
  check('a settled list is not animating', settled === 'none', String(settled));

  await page.locator('#inboxRefreshBtn').click();
  await page.waitForTimeout(2500);
  const afterRefresh = await animOf();
  check('and it still is not, after a refresh', afterRefresh === 'none', String(afterRefresh));
  check('the first-paint flag is off once the list is filled',
    !(await page.evaluate(() => document.getElementById('inboxRows').classList.contains('first-paint'))), '');
});

await step('Refresh says what it found', async () => {
  const toastsAfterClick = async () => {
    await page.evaluate(() => {
      window.__toasts = [];
      const host = document.getElementById('toastHost');
      host.querySelectorAll('.toast').forEach(t => t.remove());
      if (!host.__wired) {
        host.__wired = 1;
        new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => {
          if (n.nodeType === 1) window.__toasts.push((n.textContent || '').trim());
        }))).observe(host, { childList: true });
      }
    });
    await page.locator('#inboxRefreshBtn').click();
    await page.waitForTimeout(2600);
    return page.evaluate(() => (window.__toasts || []).join(' | '));
  };

  /* "Inbox refreshed" said the same thing whether twenty messages had arrived or none
     had -- the one question somebody pressing Refresh is actually asking. */
  await page.unroute('**/.netlify/functions/gmail-sync').catch(() => {});
  await page.route('**/.netlify/functions/gmail-sync', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, results: [{ ok: true, mode: 'history', added: 0 }] }) }));
  let said = await toastsAfterClick();
  check('nothing new says so plainly', /up to date/i.test(said), said.slice(0, 90));

  await page.unroute('**/.netlify/functions/gmail-sync');
  await page.route('**/.netlify/functions/gmail-sync', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, results: [{ ok: true, mode: 'history', added: 3 }] }) }));
  said = await toastsAfterClick();
  check('new mail is counted', /3 new messages/.test(said), said.slice(0, 90));

  await page.unroute('**/.netlify/functions/gmail-sync');
  await page.route('**/.netlify/functions/gmail-sync', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, results: [{ ok: true, mode: 'full', added: 120, remaining: 640, done: false }] }) }));
  said = await toastsAfterClick();
  check('a first sync says it is still catching up', /still catching up/i.test(said) && /640/.test(said),
    said.slice(0, 110));
});

await step('a sync does not throw you back to the top', async () => {
  /* A GUARD, NOT A FIX. The list is rebuilt wholesale on every render and syncing is
     now automatic, so being thrown back to the top mid-read would hit everybody,
     constantly. I wrote code to save and restore the position -- and then this check
     passed with that code deleted, which means the position was never being lost:
     replacing innerHTML in one go never leaves an intermediate layout for the browser
     to clamp against. The restore was removed as dead weight.

     This stays as a regression guard. Being honest about it: no sabotage makes it
     fail today, so it is proving a property rather than catching a bug. */
  await ensureApp();
  await page.evaluate(() => {
    const db = window.__mockDB.emails;
    const me = (db[0] && db[0].profile_id) || window.__mockDB.profiles[0].id;
    for (let i = 0; i < 60; i++) db.push({
      id: 'scroll-' + i, profile_id: me, gmail_id: 'g-scroll-' + i, thread_id: 't-scroll-' + i,
      from_email: 's' + i + '@example.com', from_name: 'Sender ' + i,
      to_emails: 'me@example.com', subject: 'Scrollable ' + i, snippet: 'body',
      is_unread: false, is_starred: false, has_attachments: false,
      labels: ['INBOX'], received_at: new Date(Date.now() - (i + 5) * 3600000).toISOString() });
  });
  await page.evaluate(() => document.querySelector('.ml-folder[data-mail-filter="SENT"]')?.click());
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelector('.ml-folder[data-mail-filter="INBOX"]')?.click());
  await page.waitForTimeout(1500);

  const scrolled = await page.evaluate(() => {
    const sc = document.querySelector('.ml-scroll');
    if (!sc) return null;
    sc.scrollTop = 400;
    return { set: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight };
  });
  check('the list is long enough to scroll', !!scrolled && scrolled.set > 200,
    JSON.stringify(scrolled));
  if (!scrolled || scrolled.set <= 200) return;

  await page.unroute('**/.netlify/functions/gmail-sync').catch(() => {});
  await page.route('**/.netlify/functions/gmail-sync', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, results: [{ ok: true, mode: 'history', added: 0 }] }) }));
  await page.locator('#inboxRefreshBtn').click();
  await page.waitForTimeout(2600);

  const after = await page.evaluate(() => document.querySelector('.ml-scroll').scrollTop);
  check('your place in the list is kept', Math.abs(after - scrolled.set) <= 4,
    scrolled.set + ' -> ' + after);
});

for (const r of results) console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   ' + r.detail : ''));
const bad = results.filter(r => !r.pass);
console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' checks passed');
console.log(bad.length ? 'RESULT: ' + bad.length + ' FAILED' : 'RESULT: clean');
await browser.close();
server.close();
process.exit(bad.length ? 1 : 0);
