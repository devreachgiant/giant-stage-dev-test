/* Click-through test for GROWTH.  Run:  node tools_growth_clickthrough.mjs
   (needs playwright — a global install is found automatically.)

   `node --check` and tools_newchat_audit.py both pass on a build whose screen is
   broken, and there are no credentials for the real project, so this replaces the
   CDN's supabase-js at request time with tools_newchat_mock_supabase.js. Serving the
   mock in place of that <script> is what gets the timing right: window.supabase
   exists before the app's own code runs, and no request ever reaches the real
   project (every *.supabase.co request is aborted as a backstop).

   Then it does what a person would: sign-in resolves, click the New Chat nav item,
   open a team channel, open a client thread, click every tab, send a message, start
   an empty department. It asserts the two things the static audit cannot see —
   which element each pane is parented to, and which pane a tab's renderer actually
   paints — plus the layout claims (accordion sidebar, one-line tab strip) that were
   previously only ever checked by eye.

   It exercises New Chat's real code paths against stand-in data, so it proves the
   wiring and the structure. It does not prove anything about production rows; only
   signing in as a real manager does that. */
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

/* ── GROWTH ──────────────────────────────────────────────────────────────────
   The three static tools are all clean on a Growth screen that renders nothing: they
   read the file, they never open it. Every assertion below is a MEASUREMENT taken from
   the live DOM after a real click -- a count, a width, a visible string -- because the
   checks that have let bugs through in this repo were the ones that asserted a thing
   merely existed. A colour dot existed the whole time at 0px wide.                    */

const navOf = (s) => page.locator('#appSidebar .nav-item[data-screen="' + s + '"]');

// The nav group is an accordion: opening Growth closes whatever was open. Everything
// below therefore opens the group ONCE and never assumes a previous group stayed put.
await step('the Growth group is in the sidebar', async () => {
  const label = page.locator('.nav-group-label[data-navgroup="growth"]');
  check('the Growth group is in the sidebar', await label.count() === 1);
  check('it is marked NEW', (await label.innerText()).toUpperCase().includes('NEW'));
  await label.click();
  await page.waitForTimeout(350);
});

await step('all nine Growth items are there and visible', async () => {
  const want = ['gr_home', 'gr_meetings', 'gr_pipeline', 'gr_inbox',
                'gr_training', 'gr_analytics', 'gr_connectors', 'gr_settings', 'gr_automations'];
  const seen = await page.evaluate((w) => w.map(s => {
    const el = document.querySelector('#appSidebar .nav-item[data-screen="' + s + '"]');
    if (!el) return { s, found: false };
    const r = el.getBoundingClientRect();
    return { s, found: true, w: Math.round(r.width), h: Math.round(r.height),
             text: (el.textContent || '').trim() };
  }), want);
  check('all nine Growth items exist', seen.every(x => x.found), JSON.stringify(seen.filter(x => !x.found)));
  // ORDER, not just presence. The design's sidebar runs the four daily screens, then the
  // reference ones, then the two admin ones with Settings before Automations -- and
  // querying each item by name, as the line above does, passes whatever order they are in.
  const order = await page.evaluate(() => [...document.querySelectorAll('#railGrowth .nav-item')]
    .map(el => el.dataset.screen));
  check('and they are in the order the design puts them in',
    JSON.stringify(order) === JSON.stringify(want), JSON.stringify(order));
  // width AND height, not presence: a nav item collapsed to zero is the exact bug that
  // got through before, when display:'' deleted an inline rule and children went to 0.
  const sized = seen.filter(x => x.found && x.w > 60 && x.h > 14);
  check('and every one has real size on screen', sized.length === 9,
        JSON.stringify(seen.map(x => x.s + ':' + x.w + 'x' + x.h)));
  check('they read as the nine names asked for', seen.every(x => x.text && x.text.length > 2),
        JSON.stringify(seen.map(x => x.text)));
});

const screens = [
  ['gr_home',       'grHome',       ['Reply to', 'Meetings today']],
  ['gr_meetings',   'grMeetings',   ['Meetings']],
  ['gr_pipeline',   'grPipeline',   ['Pipeline', 'New client']],
  ['gr_inbox',      'grInbox',      ['Growth Inbox']],
  ['gr_training',   'grTraining',   ['Training']],
  ['gr_analytics',  'grAnalytics',  ['Analytics', 'Sales funnel']],
  ['gr_connectors', 'grConnectors', ['Connectors']],
  ['gr_automations','grAutomations',['Automations', 'Growth sync']],
  ['gr_settings',   'grSettings',   ['Growth settings']]
];

for (const [scr, host, must] of screens) {
  await step('the ' + scr + ' screen paints', async () => {
    const nav = navOf(scr);
    if (await nav.count() !== 1) { check(scr + ' has a nav item', false); return; }
    await nav.click();
    // Wait for CONTENT, not for a timer. A client-rendered screen that is merely slow
    // and one that is broken look identical unless you wait for something real.
    await page.waitForFunction((h) => {
      const el = document.getElementById(h);
      return el && el.innerHTML.length > 200;
    }, host, { timeout: 15000 }).catch(() => {});
    const m = await page.evaluate((h) => {
      const el = document.getElementById(h);
      if (!el) return { missing: true };
      const r = el.getBoundingClientRect();
      const screen = el.closest('.screen');
      return { missing: false, w: Math.round(r.width), h: Math.round(r.height),
               on: !!(screen && screen.classList.contains('on')),
               chars: (el.innerText || '').trim().length,
               text: (el.innerText || '').slice(0, 900) };
    }, host);
    if (m.missing) { check(scr + ' paints something', false, 'host div missing'); return; }
    check(scr + ' is the screen that is on', m.on);
    // Measured, not merely present. 0x0 is the failure this is here to catch.
    check(scr + ' has real size (' + m.w + 'x' + m.h + ')', m.w > 400 && m.h > 100);
    check(scr + ' actually has words on it (' + m.chars + ' chars)', m.chars > 40);
    must.forEach(s => check(scr + ' shows "' + s + '"', m.text.includes(s),
      m.text.slice(0, 160)));
  });
}

// ── the numbers have to come from the seeded rows, not from an empty render ──
await step('the pipeline shows the seeded deals in their stages', async () => {
  await navOf('gr_pipeline').click();
  await page.waitForFunction(() => document.querySelectorAll('#grPipeline .gr_bc').length > 0,
    null, { timeout: 15000 }).catch(() => {});
  const m = await page.evaluate(() => ({
    cards: document.querySelectorAll('#grPipeline .gr_bc').length,
    cols: document.querySelectorAll('#grPipeline .gr_col').length,
    // a column header's count must agree with the cards actually inside it
    perCol: [...document.querySelectorAll('#grPipeline .gr_col')].map(c => ({
      stage: c.dataset.grStage,
      says: (c.querySelector('.gr_colh span:last-child') || {}).textContent,
      has: c.querySelectorAll('.gr_bc').length
    })),
    headline: (document.querySelector('#grPipeline .gr_head') || {}).innerText || ''
  }));
  check('every seeded deal has a card', m.cards === 6, m.cards + ' of 6');
  check('one column per stage', m.cols === 6, m.cols + ' of 6');
  check('each column count matches the cards in it',
    m.perCol.every(c => String(c.says).trim() === String(c.has)), JSON.stringify(m.perCol));
  check('the header counts the deals', /6 clients/.test(m.headline), m.headline.slice(0, 90));
  check('money in play is summed, not left at zero', /\$\d/.test(m.headline), m.headline.slice(0, 90));
});

await step('one unanswered reply is counted in exactly one place', async () => {
  await navOf('gr_inbox').click();
  await page.waitForFunction(() => document.getElementById('grInbox').innerHTML.length > 200,
    null, { timeout: 15000 }).catch(() => {});
  const m = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#grInbox .gr_card')];
    const yours = cards[0];
    const badge = document.getElementById('grInboxBadge');
    return {
      yourTurnRows: yours ? yours.querySelectorAll('.gr_row').length : -1,
      yourTurnText: yours ? yours.innerText.slice(0, 200) : '',
      waitingRows: cards[1] ? cards[1].querySelectorAll('.gr_row').length : 0,
      badge: badge ? badge.textContent : null,
      badgeShown: badge ? getComputedStyle(badge).display !== 'none' : false
    };
  });
  // gc-2 is the only deal whose last message is inbound and unhandled.
  check('"Your turn" holds the one unanswered reply', m.yourTurnRows === 1, m.yourTurnRows + ' rows');
  check('it names the client who replied', /Cesar/.test(m.yourTurnText), m.yourTurnText.slice(0, 120));
  check('the others sit under "Waiting on them"', m.waitingRows >= 1, m.waitingRows + ' rows');
  check('the sidebar badge agrees with the screen', m.badge === '1' && m.badgeShown,
    'badge=' + m.badge + ' shown=' + m.badgeShown);
});

await step('opening a deal shows that deal, and closing puts it away', async () => {
  await navOf('gr_pipeline').click();
  await page.waitForFunction(() => document.querySelectorAll('#grPipeline .gr_bc').length > 0,
    null, { timeout: 15000 }).catch(() => {});
  const name = await page.evaluate(() => {
    const c = document.querySelector('#grPipeline .gr_bc');
    return c ? c.querySelector('.gr_bn b').textContent : null;
  });
  await page.locator('#grPipeline .gr_bc').first().click();
  await page.waitForTimeout(400);
  const open = await page.evaluate(() => {
    const w = document.getElementById('grSheet');
    const sh = w && w.querySelector('.gr_sheet');
    if (!sh) return { open: false };
    const r = sh.getBoundingClientRect();
    return { open: w.classList.contains('on'), w: Math.round(r.width), h: Math.round(r.height),
             title: (sh.querySelector('.gr_si h2') || {}).textContent,
             tabs: sh.querySelectorAll('.gr_stabs button').length };
  });
  check('the sheet opens', open.open);
  check('and is a real size (' + open.w + 'x' + open.h + ')', open.w > 300 && open.h > 200);
  check('it is the deal that was clicked', open.title === name, open.title + ' vs ' + name);
  check('it has its tabs', open.tabs === 5, open.tabs + ' of 5');

  await page.locator('#grSheet [data-gr-close]').click();
  await page.waitForTimeout(300);
  // Count what is VISIBLE. Closing hides the host; the markup can still be in the DOM,
  // which is how a collapse check once passed by counting rows that never went away.
  const shut = await page.evaluate(() => {
    const w = document.getElementById('grSheet');
    return { hasOn: w.classList.contains('on'), display: getComputedStyle(w).display };
  });
  check('closing actually hides it', !shut.hasOn && shut.display === 'none', JSON.stringify(shut));
});

await step('writing an email fills the composer from the template', async () => {
  await navOf('gr_inbox').click();
  await page.waitForFunction(() => document.querySelectorAll('#grInbox .gr_row').length > 0,
    null, { timeout: 15000 }).catch(() => {});
  const btn = page.locator('#grInbox [data-gr-act]').first();
  if (await btn.count() === 0) { check('a Reply button is offered', false); return; }
  await btn.click();
  await page.waitForTimeout(450);
  const m = await page.evaluate(() => {
    const sub = document.getElementById('grCSub'), body = document.getElementById('grCBody');
    const gm = document.querySelector('.gr_comp a[href*="mail.google.com"]');
    return { hasComposer: !!sub, subject: sub ? sub.value : '', bodyLen: body ? body.value.length : 0,
             gmailHref: gm ? gm.getAttribute('href') : null };
  });
  check('the composer opens', m.hasComposer);
  check('with a subject already written', m.subject.length > 3, m.subject);
  check('and a body already written', m.bodyLen > 40, m.bodyLen + ' chars');
  // The Gmail hand-off is the whole point while there is no send: assert the address and
  // the text actually made it into the link, not just that a link is there.
  check('the Gmail link carries the address and the text',
    !!m.gmailHref && /[?&]to=[^&]+%40/.test(m.gmailHref) && /[?&]body=.{40,}/.test(m.gmailHref),
    String(m.gmailHref).slice(0, 140));
});

await step('the pipeline board FITS instead of clipping the last stage', async () => {
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await navOf('gr_pipeline').click();
  await page.waitForFunction(() => document.querySelectorAll('#grPipeline .gr_col').length > 0,
    null, { timeout: 15000 }).catch(() => {});
  const m = await page.evaluate(() => {
    const board = document.querySelector('#grPipeline .gr_board');
    const cols = [...board.querySelectorAll('.gr_col')];
    const br = board.getBoundingClientRect();
    const last = cols[cols.length - 1].getBoundingClientRect();
    return {
      cols: cols.length,
      overflow: board.scrollWidth - board.clientWidth,
      lastRight: Math.round(last.right), boardRight: Math.round(br.right),
      everyColVisible: cols.every(c => {
        const r = c.getBoundingClientRect();
        return r.width > 120 && r.right <= br.right + 2;
      })
    };
  });
  // The bug: 1fr columns sized against content, so the last stage sat past the right edge
  // behind a scrollbar. Measure the overflow, not whether a column element exists.
  check('the board does not scroll sideways', m.overflow <= 2, m.overflow + 'px of overflow');
  check('the last stage is inside the board', m.lastRight <= m.boardRight + 2,
    'last ends at ' + m.lastRight + ', board ends at ' + m.boardRight);
  check('every stage column is visible and wide enough', m.everyColVisible, m.cols + ' columns');
  // The header wrapping to two lines was what made the grid look broken even once the
  // columns fitted, so measure its height rather than trusting the eye twice.
  const head = await page.evaluate(() => {
    const hs = [...document.querySelectorAll('#grPipeline .gr_colh')];
    return hs.map(h => ({ t: h.querySelector('b').textContent, h: Math.round(h.getBoundingClientRect().height) }));
  });
  const tallest = Math.max(...head.map(h => h.h));
  check('no stage header wraps to a second line', tallest < 34,
    JSON.stringify(head.filter(h => h.h >= 34)) || ('tallest ' + tallest + 'px'));
});

await step('the Home assistant is there and takes a question', async () => {
  await navOf('gr_home').click();
  await page.waitForFunction(() => document.getElementById('grHome').innerHTML.length > 300,
    null, { timeout: 15000 }).catch(() => {});
  const m = await page.evaluate(() => {
    const box = document.getElementById('grAsk');
    const chips = [...document.querySelectorAll('[data-gr-chip]')].map(b => b.textContent);
    const r = box && box.getBoundingClientRect();
    return { hasBox: !!box, placeholder: box ? box.placeholder : '',
             w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0,
             chips: chips, note: (document.querySelector('.gr_asr span') || {}).textContent || '' };
  });
  check('the ask box is on Home', m.hasBox);
  check('and is a usable size (' + m.w + 'x' + m.h + ')', m.w > 300 && m.h > 30);
  check('it says what it is for', /Ask about your clients/.test(m.placeholder), m.placeholder);
  check('it promises nothing sends without approval', /without your approval/.test(m.note), m.note);
  check('all four suggestion chips are offered', m.chips.length === 4, JSON.stringify(m.chips));
});

await step('asking a question shows the question and a pending answer', async () => {
  // The mock has no AI endpoint, so the answer will be an error. What is being checked is
  // the loop: the question is echoed, a pending state appears, and it resolves to
  // something readable rather than hanging or throwing.
  // Watch from BEFORE the click. Under the mock there is no AI endpoint, so the request
  // fails almost instantly and a check that looks 400ms later has already missed the
  // thinking state -- which says nothing about whether the app ever showed one.
  await page.evaluate(() => {
    window.__grSawDots = false;
    const o = new MutationObserver(() => {
      if (document.querySelector('.gr_dots')) window.__grSawDots = true;
    });
    o.observe(document.body, { childList: true, subtree: true });
    window.__grObs = o;
  });
  await page.locator('[data-gr-chip]').first().click();
  await page.waitForTimeout(400);
  const mid = await page.evaluate(() => {
    if (window.__grObs) window.__grObs.disconnect();
    return {
      user: (document.querySelector('.gr_asu span') || {}).textContent || '',
      sawDots: !!window.__grSawDots
    };
  });
  check('the question is echoed back', /reply to/i.test(mid.user), mid.user);
  check('it showed it was thinking', mid.sawDots, 'observed=' + mid.sawDots);
  await page.waitForFunction(() => !document.querySelector('.gr_dots'), null, { timeout: 20000 }).catch(() => {});
  const end = await page.evaluate(() => ({
    answer: (document.querySelector('.gr_ast p') || {}).textContent || '',
    stillPending: !!document.querySelector('.gr_dots')
  }));
  check('it finishes rather than hanging', !end.stillPending);
  check('and says something rather than nothing', end.answer.trim().length > 10, end.answer.slice(0, 120));
});

await step('Home is laid out like the design: badge, big greeting, narrow column', async () => {
  await navOf('gr_home').click();
  await page.waitForFunction(() => document.getElementById('grHome').innerHTML.length > 300,
    null, { timeout: 15000 }).catch(() => {});
  // The hero steps aside once a conversation starts, which is what the design does and
  // what the chat step above left behind. Start a fresh chat so this measures the
  // landing state rather than the mid-conversation one.
  const fresh = page.locator('[data-gr-newchat]');
  if (await fresh.count()) { await fresh.click(); await page.waitForTimeout(400); }
  const m = await page.evaluate(() => {
    const badge = document.querySelector('.gr_asbadge');
    const h1 = document.querySelector('.gr_ashero h1');
    const box = document.querySelector('.gr_asbox');
    const wrap = document.getElementById('grHome');
    const r = x => x ? x.getBoundingClientRect() : null;
    const br = r(badge), hr = r(h1), bx = r(box), wr = r(wrap);
    const centred = (el) => {
      const e = r(el); if (!e || !wr) return false;
      return Math.abs((e.left + e.right) / 2 - (wr.left + wr.right) / 2) < 14;
    };
    return {
      hasBadge: !!badge, badgeSize: br ? Math.round(br.width) : 0, badgeCentred: centred(badge),
      greeting: h1 ? h1.textContent : '', greetingSize: hr ? Math.round(parseFloat(getComputedStyle(h1).fontSize)) : 0,
      greetingCentred: centred(h1),
      boxWidth: bx ? Math.round(bx.width) : 0, wrapWidth: wr ? Math.round(wr.width) : 0,
      // The old header is gone: no page title / date line above the hero.
      startsWithHero: !!(wrap && wrap.firstElementChild && wrap.firstElementChild.classList.contains('gr_as'))
    };
  });
  check('the star badge is there', m.hasBadge && m.badgeSize > 30, m.badgeSize + 'px');
  check('and it is centred', m.badgeCentred);
  check('the greeting is big', m.greetingSize >= 28, m.greetingSize + 'px');
  check('the greeting is centred', m.greetingCentred, m.greeting);
  check('it greets by name', /Good (morning|afternoon|evening), \w/.test(m.greeting), m.greeting);
  // The box must be a narrow column, not stretched across the whole screen.
  check('the ask box is a narrow column (' + m.boxWidth + ' of ' + m.wrapWidth + ')',
    m.boxWidth > 400 && m.boxWidth <= 790 && m.boxWidth < m.wrapWidth - 100,
    m.boxWidth + '/' + m.wrapWidth);
  check('nothing sits above the hero', m.startsWithHero);
});

await step('a meeting row shows how long until it, and a way in', async () => {
  const m = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#grHome .gr_card')]
      .filter(c => /Meetings today/.test(c.innerText))
      .flatMap(c => [...c.querySelectorAll('.gr_row')]);
    return rows.map(r => ({
      text: r.innerText.replace(/\n/g, ' | '),
      hasJoin: !!r.querySelector('.gr_join'),
      rel: (r.querySelector('.gr_st') || {}).textContent || ''
    }));
  });
  check('there is a meeting today to measure', m.length > 0, m.length + ' rows');
  if (!m.length) return;
  check('it says how long until it starts', /in \d/.test(m[0].rel), m[0].rel);
  // This was the bug: Join was hidden until fifteen minutes before, so the row told you
  // about a call you could not get into.
  check('and offers Join straight away', m[0].hasJoin, m[0].text.slice(0, 90));
});

await step('Gone quiet offers to write the follow ups', async () => {
  const m = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#grHome .gr_card')]
      .find(c => /Gone quiet|Follow ups ready/.test(c.innerText));
    if (!card) return { none: true };
    const btn = card.querySelector('.gr_write');
    const r = btn && btn.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    return { none: false, heading: card.querySelector('h2').textContent,
             text: card.innerText.replace(/\n/g, ' | ').slice(0, 160),
             hasBtn: !!btn, btnW: r ? Math.round(r.width) : 0, cardW: Math.round(cr.width) };
  });
  check('there is a Gone quiet card', !m.none, JSON.stringify(m).slice(0, 120));
  if (m.none) return;
  check('it says how many and asks', /not replied in 3 days|Want drafts/.test(m.text), m.text.slice(0, 120));
  check('with a Write follow ups button', m.hasBtn);
  check('and the button spans the card', m.btnW > m.cardW - 60, m.btnW + ' of ' + m.cardW);
});

await step('Home shows the digest under the assistant', async () => {
  const m = await page.evaluate(() => {
    const el = document.getElementById('grHome');
    return { text: el.innerText, intents: document.querySelectorAll('.gr_intent').length,
             doneBtns: document.querySelectorAll('[data-gr-done]').length };
  });
  check('Reply to card is under the chat', m.text.includes('Reply to'));
  check('Meetings today card is under the chat', m.text.includes('Meetings today'));
  check('a waiting reply gets an intent tag', m.intents >= 1, m.intents + ' tags');
  check('and a Done button to mark it handled', m.doneBtns >= 1, m.doneBtns + ' buttons');
});

// The composer step above leaves the client sheet open, and it is position:fixed;inset:0
// so it covers the sidebar. Every click below would time out against an overlay rather
// than a missing control, which reads as "the screen is broken" and is not.
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// ── everything has to be EDITABLE, not merely on screen ──────────────────────
// Each of these changes a value and then reads the row back out of the mock database.
// Asserting the input exists would pass on a screen whose Save does nothing at all,
// which is precisely what Settings was before this.
const dbRow = (table, id) => page.evaluate(([t, i]) => {
  const db = window.__mockDB && window.__mockDB[t];
  if (!db) return null;
  return db.find(r => r.id === i) || null;
}, [table, id]);

await step('Settings: a stage can be renamed and it saves', async () => {
  await navOf('gr_settings').click();
  await page.waitForFunction(() => document.getElementById('grSettings').innerHTML.length > 300,
    null, { timeout: 15000 }).catch(() => {});
  // Settings opens on Email templates now, which is the tab people are in most.
  await page.locator('[data-gr-settab="stages"]').click();
  await page.waitForTimeout(400);
  const box = page.locator('[data-gr-stage-label="booked"]');
  if (await box.count() === 0) { check('the stage list is editable', false, 'no stage input'); return; }
  await box.fill('Just booked');
  await box.blur();
  await page.waitForTimeout(500);
  const saved = await page.evaluate(() => {
    const db = window.__mockDB && window.__mockDB.growth_settings;
    const row = db && db.find(r => r.key === 'pipeline');
    const st = row && row.value && row.value.stages;
    const b = st && st.find(x => x.key === 'booked');
    return { label: b && b.label, onScreen: document.querySelector('[data-gr-stage-label="booked"]').value };
  });
  check('the new stage name is written to the database', saved.label === 'Just booked', JSON.stringify(saved));
});

await step('Settings: the gone-quiet threshold saves', async () => {
  await page.locator('[data-gr-settab="stages"]').click();
  await page.waitForTimeout(300);
  const f = page.locator('[data-gr-stale]');
  if (await f.count() === 0) { check('gone-quiet is editable', false); return; }
  await f.fill('9'); await f.blur(); await page.waitForTimeout(400);
  const v = await page.evaluate(() => {
    const row = (window.__mockDB.growth_settings || []).find(r => r.key === 'pipeline');
    return row && row.value && row.value.staleDays;
  });
  check('gone-quiet after N days saves', v === 9, 'staleDays=' + v);
});

await step('Settings: a discount code can be added', async () => {
  // Codes live under Email templates now, as cards you open rather than a row of inputs.
  await page.locator('[data-gr-settab="templates"]').click();
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => (window.__mockDB.growth_discounts || []).length);
  await page.locator('[data-gr-disc-new]').click();
  await page.waitForTimeout(350);
  await page.locator('#grDcCode').fill('RG999');
  await page.locator('#grDcLabel').fill('Test offer');
  await page.locator('[data-gr-disc-save="new"]').click();
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => {
    const d = window.__mockDB.growth_discounts || [];
    return { n: d.length, last: d[d.length - 1] && d[d.length - 1].code };
  });
  check('a discount code is actually inserted', after.n === before + 1 && after.last === 'RG999',
    before + ' -> ' + after.n + ' last=' + after.last);
  const shown = await page.evaluate(() =>
    document.querySelectorAll('#grSettings .gr_dcard:not(.gr_dcadd):not(.gr_dcedit)').length);
  check('and the screen shows it without a reload', shown === after.n, shown + ' cards on screen');
});

await step('Settings: a template can be added and its body edited', async () => {
  await page.locator('[data-gr-settab="templates"]').click();
  await page.waitForTimeout(400);
  await page.locator('#grTplN').fill('Test template');
  await page.locator('#grTplS').fill('A test subject');
  await page.locator('#grTplB').fill('Hi {name}, from the add card.');
  await page.locator('[data-gr-tpl-add]').click();
  await page.waitForTimeout(700);
  const made = await page.evaluate(() => {
    const t = (window.__mockDB.growth_templates || []).find(x => x.name === 'Test template');
    return t ? t.id : null;
  });
  check('a template is inserted', !!made, 'id=' + made);
  if (!made) return;
  const kept = await dbRow('growth_templates', made);
  check('with the subject and body that were typed',
    !!kept && kept.subject === 'A test subject' && /from the add card/.test(kept.body),
    kept ? kept.subject + ' / ' + kept.body.slice(0, 40) : 'no row');
  // The add card empties itself, or the next template starts as a copy of the last.
  const cleared = await page.evaluate(() => ({
    n: (document.getElementById('grTplN') || {}).value,
    b: (document.getElementById('grTplB') || {}).value }));
  check('and the add card is emptied', !cleared.n && !cleared.b, JSON.stringify(cleared));
  const body = page.locator('[data-gr-tpl-body="' + made + '"]');
  if (await body.count() === 0) { check('its body is editable', false, 'editor did not open'); return; }
  await body.fill('Hi {name}, this is the edited body.');
  await body.blur(); await page.waitForTimeout(500);
  const row = await dbRow('growth_templates', made);
  check('the edited body is written', !!row && /edited body/.test(row.body), row ? row.body.slice(0, 60) : 'no row');
});

await step('Settings reads as one job: templates, codes and the signature together', async () => {
  await navOf('gr_settings').click();
  await page.waitForTimeout(500);
  const m = await page.evaluate(() => {
    const seg = document.querySelector('#grSettings .gr_seg');
    return {
      tabs: seg ? [...seg.querySelectorAll('button')].map(b => b.innerText.trim()) : [],
      // all three on ONE tab now: you write a template, drop a code in, sign it off.
      addCard: !!document.getElementById('grTplN'),
      insert: !!document.querySelector('#grSettings [data-gr-ins]'),
      upload: !!document.getElementById('grTplFile'),
      codes: document.querySelectorAll('#grSettings .gr_dcard:not(.gr_dcadd):not(.gr_dcedit)').length,
      newCode: !!document.querySelector('#grSettings [data-gr-disc-new]'),
      sig: !!document.querySelector('#grSettings [data-gr-sig="name"]'),
      testTo: !!document.querySelector('#grSettings [data-gr-sig="testTo"]')
    };
  });
  // The old strip was Pipeline / Email templates / Discount codes / Team.
  check('three tabs, not four', m.tabs.length === 3, JSON.stringify(m.tabs));
  check('they read Email templates / Pipeline / Team',
    JSON.stringify(m.tabs) === JSON.stringify(['Email templates', 'Pipeline', 'Team']), JSON.stringify(m.tabs));
  check('there is an Add a template card', m.addCard);
  check('with an Insert control and a file upload', m.insert && m.upload, JSON.stringify(m));
  check('the codes are on the same tab', m.codes >= 3 && m.newCode, m.codes + ' cards');
  check('and so is the signature, with somewhere to send tests', m.sig && m.testTo, JSON.stringify(m));
});

await step('Insert drops a placeholder at the caret, not at the end', async () => {
  const box = page.locator('#grTplB');
  await box.fill('Hi there, welcome.');
  // Put the caret after "Hi " so an append would be obvious.
  await page.evaluate(() => {
    const el = document.getElementById('grTplB');
    el.focus(); el.setSelectionRange(3, 3);
  });
  await page.locator('#grSettings [data-gr-ins="grTplB"]').selectOption('{name}');
  await page.waitForTimeout(350);
  const v = await page.evaluate(() => ({
    text: document.getElementById('grTplB').value,
    sel: document.getElementById('grTplB').selectionStart,
    reset: document.querySelector('#grSettings [data-gr-ins="grTplB"]').value
  }));
  check('the placeholder lands where the caret was', v.text === 'Hi {name}there, welcome.', v.text);
  check('and the caret follows it', v.sel === 3 + '{name}'.length, v.sel + '');
  check('the Insert control resets itself', v.reset === '', JSON.stringify(v.reset));
  await box.fill('');
});

await step('Automations reports a real run, and judges it by its age', async () => {
  await navOf('gr_automations').click();
  await page.waitForFunction(() => document.getElementById('grAutomations').innerHTML.length > 300,
    null, { timeout: 15000 }).catch(() => {});
  const m = await page.evaluate(() => {
    const c = document.querySelector('#grAutomations .gr_auc');
    if (!c) return null;
    return {
      title: (c.querySelector('.gr_aun b') || {}).textContent || '',
      state: (c.querySelector('.gr_st') || {}).textContent || '',
      chips: [...c.querySelectorAll('.gr_aum span')].map(x => x.textContent),
      steps: [...c.querySelectorAll('.gr_aus li')].map(li => ({
        name: (li.querySelector('b') || {}).textContent,
        why: (li.querySelector('span') || {}).textContent,
        said: (li.querySelector('em') || {}).textContent,
        dim: li.classList.contains('gr_auoff')
      })),
      last: (c.querySelector('.gr_aur') || {}).textContent || ''
    };
  });
  if (!m) { check('the Automations card renders', false); return; }
  check('it names the job', /Growth sync/.test(m.title), m.title);
  check('it says the schedule', m.chips.some(x => /Every 30 minutes/.test(x)), JSON.stringify(m.chips));
  check('and when it last ran', m.chips.some(x => /Last run .*(ago|now)/.test(x)), JSON.stringify(m.chips));
  check('three steps are listed', m.steps.length === 3, JSON.stringify(m.steps.map(x => x.name)));
  check('each says what it does and what it found',
    m.steps.every(x => (x.why || '').length > 20 && (x.said || '').length > 3),
    JSON.stringify(m.steps.map(x => x.said)));
  // A page that lists only what works tells you nothing about what you came to ask about.
  check('the two that cannot run are still listed, and greyed',
    m.steps.filter(x => x.dim).length === 2, JSON.stringify(m.steps.map(x => x.dim)));
  check('and the last result is quoted', /No new bookings/.test(m.last), m.last.replace(/\s+/g, ' '));

  // The verdict has to come from the run's AGE. The mock boots with a run three hours
  // old, which is past the half-hour schedule, so it must read Not running.
  check('three hours is Not running', /Not running/.test(m.state), m.state);
  // Move the same run to ten minutes ago and it must change its mind by itself.
  await page.evaluate(() => {
    window.__mockDB.growth_runs[0].ran_at = new Date(Date.now() - 10 * 60000).toISOString();
  });
  await navOf('gr_pipeline').click(); await page.waitForTimeout(300);
  await page.evaluate(() => { if (window.grReload) window.grReload(); });
  await navOf('gr_automations').click(); await page.waitForTimeout(900);
  const after = await page.evaluate(() => ({
    state: (document.querySelector('#grAutomations .gr_st') || {}).textContent || '',
    chips: [...document.querySelectorAll('#grAutomations .gr_aum span')].map(x => x.textContent) }));
  check('ten minutes is Running', /^Running/.test(after.state.trim()), after.state);
  check('and it works out when the next one is due', after.chips.some(x => /Next run in \d+ min/.test(x)),
    JSON.stringify(after.chips));
});

await step('Training: all five tabs paint, and the plan ticks off', async () => {
  await navOf('gr_training').click();
  await page.waitForFunction(() => document.getElementById('grTraining').innerHTML.length > 300,
    null, { timeout: 15000 }).catch(() => {});
  // Matched case-insensitively: a couple of these headings are uppercased by CSS, and
  // innerText reports what is rendered, not what is in the markup.
  // Training became the sales course (20261022120000). Philosophy and the call script
  // are no longer in the strip: they are reached FROM the lesson that points at them,
  // and tools_growth_training_check.mjs drives that path and asserts Course stays lit.
  for (const [tab, must] of [['course','Sales course'],['clear','Best clear answers'],
                             ['lib','Best calls'],['qa','Questions people ask'],
                             ['pricing','start with one service']]) {
    const b = page.locator('[data-gr-traintab="' + tab + '"]');
    if (await b.count() === 0) { check('Training tab ' + tab + ' exists', false); continue; }
    await b.click(); await page.waitForTimeout(400);
    const m = await page.evaluate(() => {
      const el = document.getElementById('grTraining');
      const r = el.getBoundingClientRect();
      return { chars: (el.innerText || '').trim().length, w: Math.round(r.width), text: el.innerText.slice(0, 600) };
    });
    check('Training/' + tab + ' has content (' + m.chars + ' chars)', m.chars > 60 && m.w > 400);
    check('Training/' + tab + ' shows "' + must + '"',
      m.text.toLowerCase().includes(must.toLowerCase()),
      m.text.replace(/\n/g, ' | ').slice(0, 150));
  }
  // The personal task list is a sub view of Course now, so get there the way a person
  // would: the course screen, then the link at the bottom of it.
  await page.locator('#grTraining .gr_seg [data-gr-traintab="course"]').click();
  await page.waitForTimeout(300);
  await page.locator('#grTraining [data-gr-traintab="plan"]').click();
  await page.waitForTimeout(400);
  const boxes = page.locator('#grTraining input[data-gr-task]');
  if (await boxes.count() === 0) { check('the plan has tickable tasks', false); return; }
  const id = await boxes.first().evaluate(el => el.dataset.grTask);
  const was = await dbRow('growth_tasks', id);
  await boxes.first().click();
  await page.waitForTimeout(500);
  const now = await dbRow('growth_tasks', id);
  check('ticking a task writes it', !!now && now.done !== (was && was.done),
    (was && was.done) + ' -> ' + (now && now.done));
});

await step('a rep gets their own copy of the training plan on first open', async () => {
  await navOf('gr_training').click();
  await page.waitForTimeout(300);
  await page.locator('#grTraining .gr_seg [data-gr-traintab="course"]').click();
  await page.waitForTimeout(300);
  await page.locator('#grTraining [data-gr-traintab="plan"]').click();
  // Seeding is a write, so wait for the rows rather than a fixed delay.
  await page.waitForFunction(() => (window.__mockDB.growth_tasks || []).length > 0,
    null, { timeout: 15000 }).catch(() => {});
  const m = await page.evaluate(() => {
    const tpl = (window.__mockDB.growth_settings || []).find(r => r.key === 'training_plan');
    const mine = window.__mockDB.growth_tasks || [];
    const onScreen = document.querySelectorAll('#grTraining .gr_task:not(.gr_addt)').length;
    const head = (document.querySelector('#grTraining .gr_pn') || {}).textContent || '';
    return { want: tpl ? tpl.value.tasks.length : 0, got: mine.length,
             allMine: mine.every(t => t.owner_id === 'u-me'),
             dated: mine.filter(t => t.due_on).length, onScreen, head,
             doneCount: mine.filter(t => t.done).length };
  });
  check('the plan is seeded from the template', m.got === m.want && m.want > 0, m.got + ' of ' + m.want);
  check('and every task belongs to the person who opened it', m.allMine);
  check('each task carries a due date', m.dated === m.got, m.dated + ' of ' + m.got);
  check('they are all drawn on screen', m.onScreen === m.got, m.onScreen + ' rows');
  // Against the real done count, not zero: an earlier step in this suite ticks one, and a
  // check that assumes a pristine fixture only passes when it runs first.
  check('the header counts them', m.head.trim() === m.doneCount + ' of ' + m.got + ' done',
    m.head + ' (expected ' + m.doneCount + ' of ' + m.got + ')');
  // Opening it again must not hand out a second copy.
  await navOf('gr_pipeline').click(); await page.waitForTimeout(400);
  await navOf('gr_training').click(); await page.waitForTimeout(900);
  const again = await page.evaluate(() => (window.__mockDB.growth_tasks || []).length);
  check('opening it again does not seed a second copy', again === m.got, m.got + ' -> ' + again);
});

await step('Training: a task can be added', async () => {
  const before = await page.evaluate(() => (window.__mockDB.growth_tasks || []).length);
  await page.locator('#grNewTask').fill('Test task from the check');
  await page.locator('[data-gr-task-add]').click();
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => {
    const t = window.__mockDB.growth_tasks || [];
    return { n: t.length, last: t[t.length - 1] && t[t.length - 1].text };
  });
  check('a training task is inserted', after.n === before + 1 && /Test task/.test(after.last || ''),
    before + ' -> ' + after.n);
});

await step('a watch-list card is laid out like the design', async () => {
  await navOf('gr_training').click();
  await page.locator('[data-gr-traintab="lib"]').click();
  await page.waitForTimeout(500);
  const m = await page.evaluate(() => {
    const c = document.querySelector('#grTraining .gr_bc3');
    if (!c) return { none: true };
    const cr = c.getBoundingClientRect();
    const ta = c.querySelector('textarea');
    const btn = c.querySelector('.gr_wbtn');
    const tr = ta ? ta.getBoundingClientRect() : null;
    const br = btn ? btn.getBoundingClientRect() : null;
    return {
      none: false,
      title: (c.querySelector('b') || {}).textContent || '',
      date: (c.querySelector('.gr_bch span') || {}).textContent || '',
      tags: c.querySelectorAll('.gr_tg').length,
      cardW: Math.round(cr.width),
      taW: tr ? Math.round(tr.width) : 0,
      // The button belongs under the box, not beside it.
      btnBelow: !!(tr && br && br.top >= tr.bottom - 2)
    };
  });
  check('there is a call on the list', !m.none);
  if (m.none) return;
  check('it names the call and dates it', m.title.length > 2 && /\d{4}/.test(m.date), m.title + ' / ' + m.date);
  check('it carries its tags', m.tags >= 2, m.tags + ' tags');
  // A textarea with flex:1 in a block parent falls back to ~20 columns, which is what
  // squashed this one beside the button.
  check('the lesson box fills the card (' + m.taW + ' of ' + m.cardW + ')',
    m.taW > m.cardW - 70, m.taW + '/' + m.cardW);
  check('and Watch call sits under it', m.btnBelow);
});

await step('Training: a call can be added to the watch list', async () => {
  await page.locator('[data-gr-traintab="lib"]').click();
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => (window.__mockDB.growth_watch_calls || []).length);
  // The form is behind "+ Add a call" now, so the list is not a wall of empty inputs.
  await page.locator('[data-gr-watch-open]').click();
  await page.waitForTimeout(350);
  await page.locator('#grNewWatchTitle').fill('Test call');
  await page.locator('#grNewWatchUrl').fill('https://example.com/call');
  await page.locator('[data-gr-watch-add]').click();
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => (window.__mockDB.growth_watch_calls || []).length);
  check('a watch-list call is inserted', after === before + 1, before + ' -> ' + after);
});

await step('the client sheet has all five tabs, and each one paints', async () => {
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await navOf('gr_pipeline').click();
  await page.waitForFunction(() => document.querySelectorAll('#grPipeline .gr_bc').length > 0,
    null, { timeout: 15000 }).catch(() => {});
  await page.locator('#grPipeline .gr_bc').first().click();
  await page.waitForTimeout(400);
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('#grSheet .gr_stabs button')].map(b => b.dataset.grTab));
  check('five tabs are offered', tabs.length === 5, JSON.stringify(tabs));
  for (const t of ['overview', 'notes', 'emails', 'meetings', 'details']) {
    const b = page.locator('#grSheet [data-gr-tab="' + t + '"]');
    if (await b.count() === 0) { check('tab ' + t + ' exists', false); continue; }
    await b.click(); await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const el = document.querySelector('#grSheet .gr_sbody');
      const r = el.getBoundingClientRect();
      return { chars: (el.innerText || '').trim().length, h: Math.round(r.height) };
    });
    check('tab ' + t + ' paints (' + m.chars + ' chars, ' + m.h + 'px)', m.chars > 20 && m.h > 60);
  }
});

await step('the Overview timeline shows what has actually happened', async () => {
  await page.locator('#grSheet [data-gr-tab="overview"]').click();
  await page.waitForTimeout(300);
  await page.waitForFunction(() => !!document.querySelector('#grSheet .gr_tl span'),
    null, { timeout: 5000 }).catch(() => {});
  const m = await page.evaluate(() => {
    const tl = document.querySelector('#grSheet .gr_tl');
    if (!tl) return { rows: 0, events: [], widths: [] };
    const rows = [...tl.children];
    return {
      rows: rows.length,
      // The row's own span, not the container's innerText: innerText was being read
      // mid-render and came back as just the date, which looked like a missing event.
      events: rows.map(r => (r.querySelector('span') || {}).textContent || ''),
      widths: rows.map(r => Math.round((r.querySelector('span') || r).getBoundingClientRect().width))
    };
  });
  check('the timeline has entries', m.rows > 0, m.rows + ' rows');
  check('and they read as events', m.events.some(t => /Email sent|Meeting|replied/.test(t)),
    JSON.stringify(m.events).slice(0, 140));
  check('each entry is actually visible', m.widths.every(w => w > 50), JSON.stringify(m.widths));
});

await step('a deal can be dragged to another stage and it saves', async () => {
  await page.locator('#grSheet [data-gr-close]').click();
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => {
    const c = document.querySelector('#grPipeline .gr_bc');
    const id = c && c.dataset.grCard;
    const row = (window.__mockDB.growth_clients || []).find(r => r.id === id);
    return { id, stage: row && row.stage };
  });
  check('a card is draggable', !!before.id, JSON.stringify(before));
  if (!before.id) return;
  // Pick a stage the card is NOT already in, so the assertion measures a real move.
  const target = await page.evaluate((cur) => {
    const cols = [...document.querySelectorAll('#grPipeline .gr_col')];
    const other = cols.find(c => c.dataset.grStage !== cur);
    return other ? other.dataset.grStage : null;
  }, before.stage);
  // Playwright's dragTo does not fire the HTML5 drag events this uses, so dispatch them.
  await page.evaluate(([id, to]) => {
    const card = document.querySelector('[data-gr-card="' + id + '"]');
    const col = document.querySelector('[data-gr-stage="' + to + '"]');
    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, [before.id, target]);
  await page.waitForTimeout(700);
  const after = await page.evaluate((id) =>
    (window.__mockDB.growth_clients || []).find(r => r.id === id), before.id);
  check('the dropped deal moved stage in the database', after && after.stage === target,
    before.stage + ' -> ' + (after && after.stage) + ' (wanted ' + target + ')');
  const onScreen = await page.evaluate(([id, to]) => {
    const card = document.querySelector('[data-gr-card="' + id + '"]');
    const col = card && card.closest('[data-gr-stage]');
    return col ? col.dataset.grStage : null;
  }, [before.id, target]);
  check('and the card is drawn in the new column', onScreen === target, 'card is in ' + onScreen);
});

await step('the To do view lists what needs doing', async () => {
  const b = page.locator('[data-gr-pview="todo"]');
  if (await b.count() === 0) { check('a To do toggle exists', false); return; }
  await b.click(); await page.waitForTimeout(400);
  const m = await page.evaluate(() => {
    const el = document.getElementById('grPipeline');
    return { rows: el.querySelectorAll('.gr_row').length, board: el.querySelectorAll('.gr_col').length,
             text: el.innerText.slice(0, 300) };
  });
  check('To do shows a list, not the board', m.board === 0, m.board + ' columns still drawn');
  check('and it has rows to act on', m.rows > 0, m.rows + ' rows');
  check('each row offers the next action', /Send|Reply|Follow/.test(m.text), m.text.slice(0, 120));
  await page.locator('[data-gr-pview="board"]').click();
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => document.querySelectorAll('#grPipeline .gr_col').length);
  check('and Board brings the columns back', back > 0, back + ' columns');
});

await step('Meetings offers all four views and each one paints', async () => {
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await navOf('gr_meetings').click();
  await page.waitForFunction(() => document.getElementById('grMeetings').innerHTML.length > 300,
    null, { timeout: 15000 }).catch(() => {});
  const views = await page.evaluate(() =>
    [...document.querySelectorAll('[data-gr-mview]')].map(b => b.dataset.grMview));
  check('four views are offered', views.length === 4, JSON.stringify(views));
  for (const v of ['up', 'week', 'month', 'past']) {
    const b = page.locator('[data-gr-mview="' + v + '"]');
    if (await b.count() === 0) { check('view ' + v + ' exists', false); continue; }
    await b.click(); await page.waitForTimeout(400);
    const m = await page.evaluate(() => {
      const el = document.getElementById('grMeetings');
      const r = el.getBoundingClientRect();
      return { chars: (el.innerText || '').trim().length, w: Math.round(r.width),
               days: el.querySelectorAll('.gr_dayc').length,
               grid: el.querySelectorAll('.gr_mgrid button').length };
    });
    check('Meetings/' + v + ' paints (' + m.chars + ' chars)', m.chars > 40 && m.w > 400);
    if (v === 'week') check('the week shows seven days', m.days === 7, m.days + ' day cards');
    if (v === 'month') check('the month shows a 42-cell grid', m.grid === 42, m.grid + ' cells');
  }
});

await step('a meeting row carries the time, the source and a way in', async () => {
  await page.locator('[data-gr-mview="up"]').click();
  await page.waitForTimeout(400);
  const m = await page.evaluate(() => {
    const row = document.querySelector('#grMeetings .gr_mx');
    if (!row) return { none: true };
    const tile = row.querySelector('.gr_mt');
    const tr = tile.getBoundingClientRect();
    return {
      none: false,
      time: tile.querySelector('b').textContent,
      mins: tile.querySelector('span').textContent,
      tileColoured: getComputedStyle(tile).backgroundColor,
      tileW: Math.round(tr.width), tileH: Math.round(tr.height),
      source: (row.querySelector('.gr_src') || {}).textContent || '',
      rel: (row.querySelector('.gr_rel') || {}).textContent || '',
      join: !!row.querySelector('.gr_joinbig'),
      icons: row.querySelectorAll('.gr_ico').length
    };
  });
  check('there is a meeting to measure', !m.none);
  if (m.none) return;
  check('the time tile shows the time and length', /\d/.test(m.time) && /min/.test(m.mins), m.time + ' / ' + m.mins);
  // A tile with no colour and no size is the "existed the whole time at 0px" failure.
  check('the tile is coloured and real (' + m.tileW + 'x' + m.tileH + ')',
    m.tileW > 50 && m.tileH > 40 && !/rgba\(0, 0, 0, 0\)/.test(m.tileColoured), m.tileColoured);
  check('it names where the booking came from', m.source.length > 2, m.source);
  check('it says how long until it starts', m.rel.length > 1, m.rel);
  check('and offers Join plus the two round buttons', m.join && m.icons === 2,
    'join=' + m.join + ' icons=' + m.icons);
});

await step('a pipeline card carries its status, warmth and controls', async () => {
  await navOf('gr_pipeline').click();
  await page.waitForFunction(() => document.querySelectorAll('#grPipeline .gr_bc').length > 0,
    null, { timeout: 15000 }).catch(() => {});
  const m = await page.evaluate(() => {
    const c = document.querySelector('#grPipeline .gr_bc');
    return {
      status: (c.querySelector('.gr_st') || {}).textContent || '',
      score: (c.querySelector('.gr_sc') || {}).textContent || '',
      scoreWhy: (c.querySelector('.gr_sc') || {}).title || '',
      mail: !!c.querySelector('[data-gr-mail]'),
      dots: !!c.querySelector('[data-gr-menu]'),
      meta: (c.querySelector('.gr_bm') || {}).textContent || '',
      hint: (document.querySelector('#grPipeline .gr_hint') || {}).textContent || ''
    };
  });
  check('the card says what is happening', m.status.length > 3, m.status);
  check('it shows how warm the deal is', /Hot|Warm|Cold/.test(m.score), m.score);
  check('and the warmth can be explained', m.scoreWhy.length > 5, m.scoreWhy);
  check('it has the mail and menu buttons', m.mail && m.dots, 'mail=' + m.mail + ' dots=' + m.dots);
  check('and a line of context', m.meta.length > 3, m.meta);
  check('the board explains how to use it', /Drag a card/.test(m.hint), m.hint);

  // Cramped columns are what wrapped every name onto two lines and truncated the company
  // to "Kr...". Measure the text, not just that the elements are present.
  const fit = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#grPipeline .gr_bc')];
    return cards.map(c => {
      const b = c.querySelector('.gr_bn b'), sp = c.querySelector('.gr_bn span');
      const lh = parseFloat(getComputedStyle(b).lineHeight) || 18;
      return {
        name: b.textContent,
        lines: Math.round(b.getBoundingClientRect().height / lh),
        coClipped: sp ? sp.scrollHeight > sp.clientHeight + 2 : false,
        co: sp ? sp.textContent : ''
      };
    });
  });
  const wrapped = fit.filter(f => f.lines > 1);
  const clipped = fit.filter(f => f.coClipped);
  check('no client name wraps onto a second line', wrapped.length === 0,
    JSON.stringify(wrapped.map(w => w.name)));
  // The company is allowed to wrap -- the design does that -- but it must not be cut off
  // mid-sentence with nothing to show for it.
  check('no company is cut off', clipped.length === 0, JSON.stringify(clipped.map(c => c.co)));
  // The meta line was being squeezed to "1 ema..." once the warmth pill and owner sat
  // beside it, which is the same cramping in a different place.
  const meta = await page.evaluate(() =>
    [...document.querySelectorAll('#grPipeline .gr_bm > span:first-child')].map(sp => ({
      t: sp.textContent, clipped: sp.scrollWidth > sp.clientWidth + 1 })));
  check('the email/age line is not truncated', meta.every(x => !x.clipped),
    JSON.stringify(meta.filter(x => x.clipped).map(x => x.t)));
});

await step('the three-dot menu opens and can move a deal', async () => {
  const before = await page.evaluate(() => {
    const c = document.querySelector('#grPipeline .gr_bc');
    const id = c.dataset.grCard;
    return { id, stage: (window.__mockDB.growth_clients || []).find(r => r.id === id).stage };
  });
  await page.locator('#grPipeline .gr_bc [data-gr-menu]').first().click();
  await page.waitForTimeout(350);
  const menu = await page.evaluate(() => {
    const el = document.getElementById('grMenu');
    if (!el) return { open: false };
    const r = el.getBoundingClientRect();
    return { open: true, w: Math.round(r.width), h: Math.round(r.height),
             items: el.querySelectorAll('button').length,
             moves: [...el.querySelectorAll('[data-gr-m="mv"]')].map(b => b.dataset.to) };
  });
  check('the menu opens', menu.open);
  check('and is a real size (' + menu.w + 'x' + menu.h + ')', menu.w > 150 && menu.h > 100);
  check('it offers every other stage', menu.moves && menu.moves.length === 5 &&
    !menu.moves.includes(before.stage), JSON.stringify(menu.moves));
  const to = menu.moves[0];
  await page.locator('#grMenu [data-gr-m="mv"][data-to="' + to + '"]').click();
  await page.waitForTimeout(600);
  const after = await page.evaluate((id) =>
    (window.__mockDB.growth_clients || []).find(r => r.id === id).stage, before.id);
  check('moving from the menu writes the new stage', after === to, before.stage + ' -> ' + after);
  const shut = await page.evaluate(() => !document.getElementById('grMenu'));
  check('and the menu closes behind it', shut);
});

await step('no screen shows a raw HTML entity', async () => {
  // grHead escapes its subtitle, so an entity written in there reaches the user as the
  // literal text "&middot;". Easy to write, invisible to every static tool, and it was
  // sitting on the Meetings header.
  const bad = [];
  for (const scr of ['gr_home', 'gr_meetings', 'gr_pipeline', 'gr_inbox',
                     'gr_training', 'gr_analytics', 'gr_connectors', 'gr_settings']) {
    const nav = navOf(scr);
    if (await nav.count() === 0) continue;
    await nav.click();
    await page.waitForTimeout(450);
    const hit = await page.evaluate(() => {
      const t = document.querySelector('.screen.on') ? document.querySelector('.screen.on').innerText : '';
      const m = t.match(/&(?:[a-z]+|#\d+);/i);
      return m ? m[0] : null;
    });
    if (hit) bad.push(scr + ': ' + hit);
  }
  check('no raw entity reaches the screen', bad.length === 0, bad.join(' | '));
});

// ── it must not have leaked into the rest of the app ─────────────────────────
await step('Growth has not reached into another module', async () => {
  const m = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
    const gr = ids.filter(i => /^gr[A-Z_]/.test(i));
    const dupes = gr.filter(i => document.querySelectorAll('[id="' + i + '"]').length > 1);
    return { grIds: gr.length, dupes: [...new Set(dupes)] };
  });
  check('no Growth id is used twice', m.dupes.length === 0, JSON.stringify(m.dupes));
});

await step('Chat still works after Growth has been opened', async () => {
  // Two things make the sidebar unreachable here, and both were found by measuring rather
  // than by reasoning about the diff. The client sheet is position:fixed;inset:0, so while
  // it is open it covers the sidebar -- Escape it. And the nav groups are an accordion, so
  // Growth being open means Communication is CLOSED and Chat's item sits at 0x0.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.locator('.nav-group-label[data-navgroup="communication"]').click();
  await page.waitForTimeout(350);
  const nav = page.locator('#appSidebar .nav-item[data-screen="newchat"]');
  if (await nav.count() === 0) { check('Chat is still reachable', false); return; }
  await nav.click();
  await page.waitForTimeout(900);
  const m = await page.evaluate(() => {
    const s = document.querySelector('.screen[data-screen="newchat"]');
    const sheet = document.getElementById('grSheet');
    return { on: !!(s && s.classList.contains('on')),
             chars: s ? (s.innerText || '').trim().length : 0,
             growthSheetShut: !sheet || getComputedStyle(sheet).display === 'none' };
  });
  check('Chat is still reachable and on', m.on);
  check('Chat still renders (' + m.chars + ' chars)', m.chars > 100);
  check('the Growth sheet is not floating over it', m.growthSheetShut);
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
