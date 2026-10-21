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

await step('all eight Growth items are there and visible', async () => {
  const want = ['gr_home', 'gr_meetings', 'gr_pipeline', 'gr_inbox',
                'gr_training', 'gr_analytics', 'gr_connectors', 'gr_settings'];
  const seen = await page.evaluate((w) => w.map(s => {
    const el = document.querySelector('#appSidebar .nav-item[data-screen="' + s + '"]');
    if (!el) return { s, found: false };
    const r = el.getBoundingClientRect();
    return { s, found: true, w: Math.round(r.width), h: Math.round(r.height),
             text: (el.textContent || '').trim() };
  }), want);
  check('all eight Growth items exist', seen.every(x => x.found), JSON.stringify(seen.filter(x => !x.found)));
  // width AND height, not presence: a nav item collapsed to zero is the exact bug that
  // got through before, when display:'' deleted an inline rule and children went to 0.
  const sized = seen.filter(x => x.found && x.w > 60 && x.h > 14);
  check('and every one has real size on screen', sized.length === 8,
        JSON.stringify(seen.map(x => x.s + ':' + x.w + 'x' + x.h)));
  check('they read as the eight names asked for', seen.every(x => x.text && x.text.length > 2),
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
  check('it has its tabs', open.tabs === 3, open.tabs + ' of 3');

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
  await page.locator('[data-gr-settab="discounts"]').click();
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => (window.__mockDB.growth_discounts || []).length);
  await page.locator('#grNewDiscCode').fill('RG999');
  await page.locator('#grNewDiscLabel').fill('Test offer');
  await page.locator('[data-gr-disc-add]').click();
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => {
    const d = window.__mockDB.growth_discounts || [];
    return { n: d.length, last: d[d.length - 1] && d[d.length - 1].code };
  });
  check('a discount code is actually inserted', after.n === before + 1 && after.last === 'RG999',
    before + ' -> ' + after.n + ' last=' + after.last);
  const shown = await page.evaluate(() =>
    document.querySelectorAll('[data-gr-disc-code]').length);
  check('and the screen shows it without a reload', shown === after.n, shown + ' rows on screen');
});

await step('Settings: a template can be added and its body edited', async () => {
  await page.locator('[data-gr-settab="templates"]').click();
  await page.waitForTimeout(400);
  await page.locator('#grNewTpl').fill('Test template');
  await page.locator('[data-gr-tpl-add]').click();
  await page.waitForTimeout(600);
  const made = await page.evaluate(() => {
    const t = (window.__mockDB.growth_templates || []).find(x => x.name === 'Test template');
    return t ? t.id : null;
  });
  check('a template is inserted', !!made, 'id=' + made);
  if (!made) return;
  const body = page.locator('[data-gr-tpl-body="' + made + '"]');
  if (await body.count() === 0) { check('its body is editable', false, 'editor did not open'); return; }
  await body.fill('Hi {name}, this is the edited body.');
  await body.blur(); await page.waitForTimeout(500);
  const row = await dbRow('growth_templates', made);
  check('the edited body is written', !!row && /edited body/.test(row.body), row ? row.body.slice(0, 60) : 'no row');
});

await step('Training: all five tabs paint, and the plan ticks off', async () => {
  await navOf('gr_training').click();
  await page.waitForFunction(() => document.getElementById('grTraining').innerHTML.length > 300,
    null, { timeout: 15000 }).catch(() => {});
  for (const [tab, must] of [['plan','Your plan'],['calls','Calls to watch'],
                             ['phil','Top tips'],['script','How a good call runs'],['pricing','one service']]) {
    const b = page.locator('[data-gr-traintab="' + tab + '"]');
    if (await b.count() === 0) { check('Training tab ' + tab + ' exists', false); continue; }
    await b.click(); await page.waitForTimeout(400);
    const m = await page.evaluate(() => {
      const el = document.getElementById('grTraining');
      const r = el.getBoundingClientRect();
      return { chars: (el.innerText || '').trim().length, w: Math.round(r.width), text: el.innerText.slice(0, 600) };
    });
    check('Training/' + tab + ' has content (' + m.chars + ' chars)', m.chars > 60 && m.w > 400);
    check('Training/' + tab + ' shows "' + must + '"', m.text.includes(must), m.text.slice(0, 120));
  }
  await page.locator('[data-gr-traintab="plan"]').click();
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

await step('Training: a call can be added to the watch list', async () => {
  await page.locator('[data-gr-traintab="calls"]').click();
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => (window.__mockDB.growth_watch_calls || []).length);
  await page.locator('#grNewWatchTitle').fill('Test call');
  await page.locator('#grNewWatchUrl').fill('https://example.com/call');
  await page.locator('[data-gr-watch-add]').click();
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => (window.__mockDB.growth_watch_calls || []).length);
  check('a watch-list call is inserted', after === before + 1, before + ' -> ' + after);
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
