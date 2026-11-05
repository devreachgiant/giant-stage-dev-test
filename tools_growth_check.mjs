/* Growth: to-dos on a deal, a video answer, and editing the board's own columns.
   Run:  node tools_growth_check.mjs

   Three things Luke's design had and ours did not. All three are the kind of change the
   first three checks cannot see -- they are screens, and none of those render anything.

   WHAT THESE ASSERT, AND WHY IT IS NOT "DOES THE BUTTON EXIST". Every write here is read
   back out of the mock database row, never off the screen. A to-do that paints and never
   saves looks identical to one that worked until you reload, and that is exactly the bug
   shape this repo keeps shipping: the check that set a flag on the row while the code
   read the cache measured nothing and passed.

   Each check was run against the code WITHOUT the change and seen to fail first. The
   sabotage lines are in the commit message; a check that passes against the bug is worse
   than no check, because it is reassuring.
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
  /* Read FIRST, then write the head. Writing 200 and then failing to read left the
     catch trying to send a second set of headers, which throws out of the request
     handler and kills the whole run -- no tally, no FAIL lines, just a stack trace.
     A sabotage harness read that as "suite stayed green" and reported seven real
     checks as not catching anything. */
  let buf;
  try { buf = readFileSync(path.join(HERE, rel)); }
  catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(rel)] || 'text/plain' });
  res.end(buf);
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
const ctx = await browser.newContext({ viewport: { width: 1500, height: 980 } });
const page = await ctx.newPage();
await page.route('**/@supabase/supabase-js@2*', r =>
  r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
await page.route('**://*.supabase.co/**', r => r.abort());
await page.goto(BASE + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('#view-app.on', { timeout: 30000 });
await page.waitForTimeout(3200);

const screen = async (name) => {
  await page.evaluate(s => document.querySelector('#appSidebar .nav-item[data-screen="' + s + '"]')?.click(), name);
  await page.waitForTimeout(1600);
};
// The row as the DATABASE holds it, which is the only copy that survives a reload.
const row = (id) => page.evaluate(i =>
  (window.__mockDB.growth_clients || []).find(c => c.id === i) || null, id);
const stages = () => page.evaluate(() => {
  const r = (window.__mockDB.growth_settings || []).find(x => x.key === 'pipeline');
  return r && r.value && r.value.stages ? r.value.stages.map(s => s.key + ':' + s.label + ':' + s.color) : null;
});

await screen('gr_pipeline');

/* ---------------------------------------------------------------- the board reads */
await step('a card says one thing, and it is the thing to do next', async () => {
  await screen('gr_pipeline');
  /* The card used to carry an avatar, a status pill, the money, a meeting-or-email line,
     a heat word and the owner's initials -- six things in a 193px column. One line now,
     picked by where the deal is. */
  const m = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('.gr_bc').forEach(el => {
      const n = el.querySelector('.gr_bn b');
      const lines = el.querySelectorAll('.gr_bl');
      out[n ? n.textContent : '?'] = {
        lines: lines.length,
        says: lines[0] ? lines[0].textContent.trim() : null,
        avatar: !!el.querySelector('.gr_av'),
        heat: !!el.querySelector('.gr_sc')
      };
    });
    return out;
  });
  const cesar = m['Cesar Diaz'], michael = m['Michael Cash'], pete = m['Pete Patrino'];
  check('every card has exactly one line of context',
    Object.values(m).every(x => x.lines === 1), JSON.stringify(m));
  // An unanswered reply beats everything else: it is the only thing that is YOUR move.
  check('an unanswered reply says so, in red', cesar && cesar.says === 'Reply needed', JSON.stringify(cesar));
  check('otherwise it is the next action', michael && michael.says === 'Send proposal', JSON.stringify(michael));
  check('a won deal says when it was won', pete && /^Won /.test(pete.says), JSON.stringify(pete));
  check('the avatar and the heat word are off the card',
    Object.values(m).every(x => !x.avatar && !x.heat), JSON.stringify(m));
});

await step('the board is the header and the columns, nothing between', async () => {
  /* The search box and the Board / To do strip sat between the heading and the board,
     pushing the columns down; Luke's goes straight from one to the other. New client did
     NOT go with them -- it moved into the header, because removing the only way to add a
     client is not a tidy-up. And the To do list is still reachable: a working screen with
     no door to it is worse than the strip was. */
  await screen('gr_pipeline');
  const m = await page.evaluate(() => {
    const head = document.querySelector('.gr_head');
    const board = document.querySelector('.gr_board');
    return {
      search: !!document.querySelector('#grSearch, .gr_search'),
      tabs: !!document.querySelector('[data-gr-pview="board"]'),
      addClient: !!document.querySelector('#grAddClient'),
      addInHead: !!head && !!head.querySelector('#grAddClient'),
      toDoDoor: !!document.querySelector('[data-gr-pview="todo"]'),
      // Measured, not assumed: the board has to start near the heading now.
      gap: (head && board)
        ? Math.round(board.getBoundingClientRect().top - head.getBoundingClientRect().bottom) : -1
    };
  });
  check('no search box', !m.search, String(m.search));
  check('no Board / To do strip', !m.tabs, String(m.tabs));
  check('New client survived, in the header', m.addClient && m.addInHead, JSON.stringify(m));
  check('and the To do list still has a way in', m.toDoDoor, String(m.toDoDoor));
  check('the columns start right under the heading', m.gap >= 0 && m.gap < 120, String(m.gap));

  // It is a door, not a label: clicking it has to actually get you there and back.
  await page.evaluate(() => document.querySelector('[data-gr-pview="todo"]')?.click());
  await page.waitForTimeout(1100);
  const onTodo = await page.evaluate(() => ({
    board: !!document.querySelector('.gr_board'),
    back: !!document.querySelector('[data-gr-pview="board"]')
  }));
  check('it opens the To do list', !onTodo.board && onTodo.back, JSON.stringify(onTodo));
  await page.evaluate(() => document.querySelector('[data-gr-pview="board"]')?.click());
  await page.waitForTimeout(1100);
  const backOnBoard = await page.evaluate(() => !!document.querySelector('.gr_board'));
  check('and gets you back to the board', backOnBoard, String(backOnBoard));
});

await step('opening a client gives Luke\'s side drawer, not a centred sheet', async () => {
  /* It was a 780px box floating in the middle with a five-tab strip, so opening a deal
     told you one thing and the other four were a click each. His is a drawer down the
     right at 520px with everything stacked in one scroll. Measured off the viewport,
     because "it has a class" would pass on a sheet still sitting in the middle. */
  await screen('gr_pipeline');
  await page.evaluate(() => document.querySelector('.gr_board .gr_bc')?.click());
  await page.waitForTimeout(1400);
  const m = await page.evaluate(() => {
    const sh = document.querySelector('.gr_sheet');
    if (!sh) return null;
    const r = sh.getBoundingClientRect();
    return {
      w: Math.round(r.width),
      top: Math.round(r.top),
      // 0 means it is flush with the right edge; a centred sheet leaves a big gap.
      fromRight: Math.round(innerWidth - r.right),
      fillsHeight: Math.round(r.height) >= Math.round(innerHeight) - 2,
      tabs: !!sh.querySelector('[data-gr-tab]'),
      sections: [...sh.querySelectorAll('.gr_spanel h3')].map(e => e.textContent.trim()),
      stageLabel: !!sh.querySelector('.gr_stagel'),
      pillInHead: !!sh.querySelector('.gr_sh .gr_pill'),
      // Still has to say what to do next, or the drawer is a tidy empty box.
      doNext: !!sh.querySelector('.gr_next')
    };
  });
  check('a drawer, pinned to the right edge', !!m && m.fromRight === 0 && m.top === 0, JSON.stringify(m));
  check('about 520 wide, not a 780 sheet', !!m && m.w <= 560 && m.w >= 420, String(m && m.w));
  check('the full height of the window', !!m && m.fillsHeight, JSON.stringify(m));
  check('the tab strip is gone', !!m && !m.tabs, String(m && m.tabs));
  check('and what was behind it is stacked instead',
    !!m && ['Info', 'Call notes', 'Sent emails', 'Meetings'].every(t => m.sections.indexOf(t) >= 0),
    JSON.stringify(m && m.sections));
  check('the stage picker says Stage', !!m && m.stageLabel, String(m && m.stageLabel));
  check('the stage reads as a pill beside the name', !!m && m.pillInHead, String(m && m.pillInHead));
  check('and it still opens on what to do next', !!m && m.doNext, String(m && m.doNext));
  await page.evaluate(() => document.querySelector('[data-gr-close]')?.click());
  await page.waitForTimeout(700);
});

await step('a failed Gmail check is not a disconnected mailbox', async () => {
  /* The row said "Not connected" on a mailbox that was fine. grCheckGmail caught ANY
     error -- a dropped request, a slow token refresh -- and recorded ready=false with
     checked=true, so one blip latched it for the whole session. "Check all again" reset
     the flag and re-rendered WITHOUT re-asking, which painted the stale answer, so the
     one button for fixing it could not. Driven here through the UI, because the state
     lives in a closure and the bug was in how the screen asks, not in what it stores. */
  await screen('gr_connectors');
  const gmailRow = () => page.evaluate(() => {
    const r = [...document.querySelectorAll('.gr_cnw')]
      .find(e => /Gmail/.test((e.querySelector('.gr_rm b') || {}).textContent || ''));
    if (!r) return null;
    const dot = r.querySelector('.gr_lt');
    return {
      says: (r.querySelector('.gr_rm span') || {}).textContent || '',
      on: !!dot && dot.classList.contains('gr_on'),
      hasSwitch: !!r.querySelector('[data-gr-conn-use]')
    };
  });
  // Make the CHECK fail, the way a blip does. The mailbox itself is untouched.
  await page.evaluate(() => { window.giantGmailReady = async () => { throw new Error('blip'); }; });
  await page.evaluate(() => document.querySelector('[data-gr-conn-recheck]')?.click());
  await page.waitForTimeout(1600);
  const broken = await gmailRow();
  /* Still connected -- a row in gmail_tokens is what connected MEANS -- but it says
     plainly that it cannot send. Reporting "Not connected" here was the bug: the Email
     screen was listing 478 messages at the time, because that list comes out of the
     emails table and never needed a live token. */
  check('a failed refresh does not read as a missing connection', !!broken && broken.on,
    JSON.stringify(broken));
  check('but it says it needs reconnecting before it can send',
    !!broken && /renew|reconnect/i.test(broken.says), JSON.stringify(broken));

  // Now it answers again. The row has to come back WITHOUT a reload.
  await page.evaluate(() => { window.giantGmailReady = async () => true; });
  await page.evaluate(() => document.querySelector('[data-gr-conn-recheck]')?.click());
  await page.waitForTimeout(1800);
  const healed = await gmailRow();
  check('and Check all again actually re-asks, rather than repainting the old answer',
    !!healed && healed.on, JSON.stringify(healed));
  check('the warning clears once Google answers again',
    !!healed && !/renew|reconnect/i.test(healed.says), JSON.stringify(healed));

  /* AND THE LATCH ITSELF. The two above exercise the SENDING signal, which is a
     different field now -- so make the read of gmail_tokens fail, which is the only
     thing that can still throw. A check that fails must not record a disconnection:
     it has to leave itself unasked so the next render tries again. Without that, one
     blip stuck "Not connected" for the whole session. */
  await page.evaluate(() => { window.__realAccts = window.giantGmailAccounts; });
  /* BOTH routes have to fail. Growth asks the Email screen's helper first and falls back
     to reading gmail_tokens itself, so breaking only the helper proves the fallback
     rather than the latch -- which is exactly what this check did until the fallback
     existed, and it passed while measuring the wrong thing. */
  await page.evaluate(() => { window.giantGmailAccounts = async () => { throw new Error('blip'); }; });
  await page.evaluate(() => window.__mock.hideTable('gmail_tokens'));
  await page.evaluate(() => document.querySelector('[data-gr-conn-recheck]')?.click());
  await page.waitForTimeout(1600);
  const thrown = await gmailRow();
  check('a read that throws reads as not connected for now', !!thrown && !thrown.on,
    JSON.stringify(thrown));
  /* Put both back, then come at it through a plain re-render -- leave the screen and
     return -- rather than pressing Check all again. That button clears the cache flag
     itself, so recovering through it would pass whether the failure latched or not.
     This is the path that was actually broken: it stuck until you navigated away. */
  await page.evaluate(() => { window.giantGmailAccounts = window.__realAccts; });
  await page.evaluate(() => window.__mock.showTable('gmail_tokens'));
  await screen('gr_pipeline');
  // Past the ten second staleness window, so the plain re-render really does re-ask.
  await page.waitForTimeout(10500);
  await screen('gr_connectors');
  await page.waitForTimeout(1600);
  const recovered = await gmailRow();
  check('and it comes back by itself, rather than latching for the session',
    !!recovered && recovered.on, JSON.stringify(recovered));
  check('with the mailbox named again',
    !!recovered && /@/.test(recovered.says), JSON.stringify(recovered));

  /* THE FALLBACK, on its own. giantGmailAccounts lives deep inside initApp, which
     bootstrap wraps in a try/catch -- anything throwing earlier leaves it undefined and
     Growth reported a working mailbox as "Not connected", with the accounts section
     vanishing alongside it. Growth reads gmail_tokens itself now, same own-row RLS. */
  await page.evaluate(() => { window.giantGmailAccounts = undefined; });
  await page.evaluate(() => document.querySelector('[data-gr-conn-recheck]')?.click());
  await page.waitForTimeout(1800);
  const noHelper = await gmailRow();
  check('the mailbox survives the Email screen helper not existing',
    !!noHelper && noHelper.on, JSON.stringify(noHelper));
  const section = await page.evaluate(() => {
    const h = [...document.querySelectorAll('.gr_gma>h3')].find(x => /Gmail accounts/i.test(x.textContent));
    return { there: !!h, rows: document.querySelectorAll('.gr_gm:not(.gr_gmadd)').length,
             add: !!document.querySelector('[data-gr-conn-gmail].gr_gmadd') };
  });
  check('and the Gmail accounts section is still on the page', section.there, JSON.stringify(section));
  check('listing the mailbox, with a way to add another',
    section.rows >= 1 && section.add, JSON.stringify(section));
  await page.evaluate(() => { window.giantGmailAccounts = window.__realAccts; });

  /* WITH NOTHING TO LIST. The section returned '' when there were no mailboxes, so it
     disappeared -- and "none connected" looked exactly like "this part of the screen is
     missing", which is what it was reported as. Staff must still get the heading and a
     way to connect one. */
  await page.evaluate(() => { window.giantGmailAccounts = async () => []; });
  await page.evaluate(() => window.__mock.hideTable('gmail_tokens'));
  await page.evaluate(() => document.querySelector('[data-gr-conn-recheck]')?.click());
  await page.waitForTimeout(1700);
  const empty = await page.evaluate(() => {
    const h = [...document.querySelectorAll('.gr_gma>h3')].find(x => /Gmail accounts/i.test(x.textContent));
    return { there: !!h, rows: document.querySelectorAll('.gr_gm:not(.gr_gmadd)').length,
             add: !!document.querySelector('[data-gr-conn-gmail].gr_gmadd'),
             says: (document.querySelector('.gr_gmnone') || {}).textContent || '' };
  });
  check('with no mailbox at all the section is still there', empty.there, JSON.stringify(empty));
  check('and says so, rather than vanishing',
    /no mailbox/i.test(empty.says) && empty.rows === 0, JSON.stringify(empty));
  check('and still offers a way to connect one', empty.add, JSON.stringify(empty));
  await page.evaluate(() => { window.giantGmailAccounts = window.__realAccts; });
  await page.evaluate(() => window.__mock.showTable('gmail_tokens'));
  await page.evaluate(() => document.querySelector('[data-gr-conn-recheck]')?.click());
  await page.waitForTimeout(1500);
});

await step('a connected connector shows a switch, not a tick and a word', async () => {
  // Luke's rows carry a switch where there is something to switch and a word where
  // there is not. Ours showed both, which is the same fact twice, and the switch was a
  // 17px tickbox rather than something you would read as on or off.
  const m = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.gr_cnw')]
      .find(e => !!e.querySelector('[data-gr-conn-use]'));
    if (!row) return null;
    const sw = row.querySelector('[data-gr-conn-use]');
    const r = sw.getBoundingClientRect();
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      round: parseFloat(getComputedStyle(sw).borderRadius) >= 12,
      alsoAWord: !!row.querySelector('.gr_st'),
      checked: sw.checked
    };
  });
  check('the switch is switch-sized, not a tickbox', !!m && m.w >= 36 && m.h >= 20,
    JSON.stringify(m));
  check('and reads as a pill', !!m && m.round, JSON.stringify(m));
  check('the status word is not repeated beside it', !!m && !m.alsoAWord, JSON.stringify(m));
});

await step('an Automations step is one clean row', async () => {
  /* The row carried a hide button that was broken two ways: the <li> declared three grid
     columns for four children, so it fell onto an implicit second row, and it wore
     .gr_rm -- the row's TEXT block, flex:1 and a column -- because "rm" reads as remove.
     It drew a tall empty box with an x under every step. Luke's has no controls in the
     row at all, and growth_settings had never held an automations_hidden row, so the
     repair was to remove it rather than restyle something nobody used. */
  await screen('gr_automations');
  const m = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.gr_aus li')];
    return rows.map(li => {
      const r = li.getBoundingClientRect();
      const said = li.querySelector('em');
      return {
        h: Math.round(r.height),
        kids: li.children.length,
        cols: getComputedStyle(li).gridTemplateColumns.split(' ').length,
        hideBtn: !!li.querySelector('[data-gr-auhide]'),
        rmOnAButton: !!li.querySelector('button.gr_rm'),
        // Still has to say what it did, or this passes on an empty row.
        saysSomething: !!said && !!said.textContent.trim()
      };
    });
  });
  check('the steps are listed', m.length >= 3, String(m.length));
  check('no hide button in the row', m.every(x => !x.hideBtn), JSON.stringify(m));
  check('and nothing wearing .gr_rm, which would stretch it', m.every(x => !x.rmOnAButton),
    JSON.stringify(m));
  /* The real guard: a column for every child. One more child than columns is what put
     the button on its own line, and it would do the same to anything added later. */
  check('a grid column for every child', m.every(x => x.cols >= x.kids),
    JSON.stringify(m.map(x => x.kids + ' children / ' + x.cols + ' cols')));
  check('each step still reports what it did', m.every(x => x.saysSomething), JSON.stringify(m));
  // The height was the giveaway: a wrapped button roughly doubled it, 65px became 111px.
  check('so the row is a single row high', m.every(x => x.h < 100), JSON.stringify(m.map(x => x.h)));
});

await step('the card carries a name, a company and the next thing, at a readable size', async () => {
  /* Luke's card is three lines. Ours had grown a money chip and the owner's initials in a
     fourth row, and the column a running total under its heading -- both are on the
     client and on Analytics, and on the board they are noise you read past to find the
     action. Sizes are measured, not described: the text was a point or two smaller than
     his everywhere, which is the sort of difference that only shows up side by side. */
  const m = await page.evaluate(() => {
    const c = document.querySelector('.gr_board .gr_bc');
    if (!c) return null;
    const px = (el) => el ? Math.round(parseFloat(getComputedStyle(el).fontSize)) : 0;
    const name = c.querySelector('.gr_bn b'), co = c.querySelector('.gr_bn span'),
          line = c.querySelector('.gr_bl'), head = document.querySelector('.gr_colh b');
    return {
      money: !!c.querySelector('.gr_vt'),
      initials: !!c.querySelector('.gr_ow'),
      footer: !!c.querySelector('.gr_bf'),
      colTotal: !!document.querySelector('.gr_colsum'),
      namePx: px(name), coPx: px(co), linePx: px(line), headPx: px(head),
      pad: Math.round(parseFloat(getComputedStyle(c).paddingLeft)),
      // It must still say the three things, or this passes by the card being empty.
      hasName: !!name && !!name.textContent.trim(),
      hasLine: !!line && !!line.textContent.trim()
    };
  });
  check('the name and the next action are on it', !!m && m.hasName && m.hasLine, JSON.stringify(m));
  check('no money chip on the card', !!m && !m.money, JSON.stringify(m));
  check('no owner initials', !!m && !m.initials, JSON.stringify(m));
  check('and no running total under the stage heading', !!m && !m.colTotal, JSON.stringify(m));
  check('the name is 15px, not the 13.5px it was', !!m && m.namePx === 15, String(m && m.namePx));
  check('the company is 13px', !!m && m.coPx === 13, String(m && m.coPx));
  check('the action line is 13px', !!m && m.linePx === 13, String(m && m.linePx));
  check('the stage heading is 15.5px', !!m && m.headPx >= 15, String(m && m.headPx));
  check('and the card has room to breathe', !!m && m.pad >= 14, String(m && m.pad));
});

await step('the stage heading fits, with its count on the right', async () => {
  // Say where we are. Steps above this one visit other screens, and a board that is
  // display:none measures 0 wide -- which would read as a layout fault that is not there.
  await screen('gr_pipeline');
  /* TWO BUGS IN ONE ROW. The count was styled by `.gr_colh span:last-child`, and adding
     the delete button made the span no longer last -- so it lost its margin-left:auto and
     its colour, and the heading read "Booked 1 1" with both numbers jammed together.
     Giving it a class then collided with .gr_cn, which is the call-note card, and the
     later rule won: it came back as a padded blob that pushed "Proposal sent" into
     "Proposa...". Both are measured here rather than described. */
  const m = await page.evaluate(() => [...document.querySelectorAll('.gr_colh')].map(h => {
    const t = h.querySelector('b'), c = h.querySelector('.gr_colcnt');
    if (!t || !c) return null;
    const tb = t.getBoundingClientRect(), cb = c.getBoundingClientRect(), hb = h.getBoundingClientRect();
    return { name: t.textContent,
             ellipsised: t.scrollWidth > t.clientWidth + 1,
             gap: Math.round(cb.left - tb.right),
             /* How much empty row is left AFTER the last thing in the heading. The count
                carries margin-left:auto, so the free space belongs in front of it and
                this is ~the padding. Measuring count-to-delete instead reads the flex
                gap, which is 6px whether the auto margin is there or not -- it cannot
                fail, and a check that cannot fail is worse than none. */
             toRight: Math.round(hb.right -
               h.children[h.children.length - 1].getBoundingClientRect().right),
             clear: Math.round(cb.left) >= Math.round(tb.right),
             countW: Math.round(cb.width) };
  }).filter(Boolean));
  check('all six headings are present', m.length === 6, String(m.length));
  check('none of the stage names is cut off',
    m.every(x => !x.ellipsised), JSON.stringify(m.filter(x => x.ellipsised).map(x => x.name)));
  /* "Pushed to the far end" is the thing to measure, and the gap to the NAME stopped
     saying that once long names were allowed to wrap: the text reaches the count, so the
     gap is small while the count is still hard right. The distance to the heading's own
     right edge says it for a long name and a short one alike, and still fails the way
     the original bug failed -- without margin-left:auto the count sits against the name
     and leaves that whole distance open. */
  check('the count sits at the far end of the heading, long name or short',
    m.every(x => x.toRight <= 10), JSON.stringify(m.map(x => x.name.slice(0, 18) + ':' + x.toRight + 'px')));
  check('and does not overlap the name', m.every(x => x.clear), JSON.stringify(m.map(x => x.clear)));
  /* The board is Luke's: 260px columns that scroll. It spent a while squeezed to fit the
     window instead, which is what made a 15.5px heading wrap to four lines. The original
     bug was never that it scrolled -- it was Lost sitting past the right edge with no
     scrollbar and no way to get to it. So: wide enough to read, and reachable. */
  const fit = await page.evaluate(() => {
    const b = document.querySelector('.gr_board');
    const cols = [...b.querySelectorAll('.gr_col')];
    return { widths: cols.map(e => Math.round(e.getBoundingClientRect().width)),
             unreachable: cols.filter(e =>
               (e.getBoundingClientRect().right - b.getBoundingClientRect().left + b.scrollLeft)
                 > b.scrollWidth + 2).length,
             canScroll: getComputedStyle(b).overflowX === 'auto' ||
                        getComputedStyle(b).overflowX === 'scroll' };
  });
  check('columns are at least Luke\'s 260px', fit.widths.every(w => w >= 260), JSON.stringify(fit.widths));
  check('every stage is reachable, not stranded past the edge', fit.unreachable === 0,
    String(fit.unreachable));
  check('and the board can actually be scrolled to reach them', fit.canScroll, String(fit.canScroll));
});

/* ---------------------------------------------------------------- to-dos */
let CID = null;
await step('a to-do goes on the deal, not on the screen', async () => {
  CID = await page.evaluate(() => {
    const el = document.querySelector('[data-gr-open]');
    if (el) el.click();
    return el ? el.dataset.grOpen : null;
  });
  await page.waitForTimeout(1200);
  check('a client opens', !!CID, String(CID));

  const before = await row(CID);
  check('it starts with no to-dos', !(before && (before.todos || []).length),
    JSON.stringify(before && before.todos));

  await page.fill('#grTodoNew', 'Send the case study');
  await page.click('[data-gr-todo="add"]');
  await page.waitForTimeout(900);

  const after = await row(CID);
  const saved = (after && after.todos) || [];
  // The row, not the DOM. A to-do that only painted is the bug this is here to catch.
  check('the row carries it', saved.length === 1 && saved[0].text === 'Send the case study',
    JSON.stringify(saved));
  check('and it starts as not done', saved.length === 1 && saved[0].done === false,
    JSON.stringify(saved[0] && saved[0].done));

  const shown = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.gr_tdo > span')].map(x => x.textContent);
    const box = document.querySelector('.gr_todos');
    const b = box ? box.getBoundingClientRect() : null;
    // A 0x0 block is in the DOM and reads as present. Measure it.
    return { lines: el, w: b ? Math.round(b.width) : 0, h: b ? Math.round(b.height) : 0 };
  });
  check('and it is on screen at a size a person can read',
    shown.lines.indexOf('Send the case study') >= 0 && shown.w > 200 && shown.h > 40,
    JSON.stringify(shown));
});

await step('ticking one writes done to the row', async () => {
  await page.click('.gr_tdo .gr_tdtick');
  await page.waitForTimeout(900);
  const r = await row(CID);
  const t = ((r && r.todos) || [])[0] || {};
  check('done is true in the row', t.done === true, JSON.stringify(t));
  check('and the day it was done is kept', !!t.done_on, String(t.done_on));
  // Struck through, not removed: "I already did that" is worth seeing.
  const struck = await page.evaluate(() => {
    const el = document.querySelector('.gr_tdo.gr_done > span');
    return el ? getComputedStyle(el).textDecorationLine : 'missing';
  });
  check('the line is struck through rather than vanishing', /line-through/.test(struck), struck);
});

await step('deleting one takes it out of the row, and can be undone', async () => {
  await page.click('.gr_tdo .gr_tdx');
  await page.waitForTimeout(900);
  let r = await row(CID);
  check('it is gone from the row', ((r && r.todos) || []).length === 0,
    JSON.stringify(r && r.todos));
  const hasUndo = await page.evaluate(() => !!document.querySelector('#grToast [data-gr-undo]'));
  check('and the toast offers it back', hasUndo, String(hasUndo));
  await page.evaluate(() => document.querySelector('#grToast [data-gr-undo]')?.click());
  await page.waitForTimeout(900);
  r = await row(CID);
  check('undo really puts it back in the row', ((r && r.todos) || []).length === 1,
    JSON.stringify(r && r.todos));
  await page.evaluate(() => document.querySelector('[data-gr-close]')?.click());
  await page.waitForTimeout(700);
});

await step('marking a deal lost is only offered when Lost exists', async () => {
  /* 20261028114500 removed the Lost stage to match Luke's board. The Lost button went on
     writing stage='lost' regardless, and a stage with no column renders nowhere -- the
     deal would drop off the board while still sitting in the table, reason attached,
     with no screen that shows it. Deleting the column through the board's own UI is the
     path a person would actually take, so that is the one driven here. */
  await screen('gr_pipeline');
  const openFirst = async () => {
    // Must be a live deal: a won or lost one shows a status word instead of the buttons.
    await page.evaluate(() => document.querySelector('[data-gr-stage="call"] .gr_bc')?.click());
    await page.waitForTimeout(900);
    return page.evaluate(() => ({
      panel: !!document.querySelector('.gr_sbar2'),
      won: !!document.querySelector('[data-gr-won]'),
      lost: !!document.querySelector('[data-gr-lost]')
    }));
  };
  const before = await openFirst();
  check('a deal offers Mark won and Lost while the stage is there', before.won && before.lost,
    JSON.stringify(before));
  await page.evaluate(() => document.querySelector('[data-gr-close]')?.click());
  await page.waitForTimeout(600);

  // Delete Lost through the board, sending anything in it to the first stage offered.
  await page.evaluate(() => document.querySelector('[data-gr-coldel="lost"]')?.click());
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelector('[data-gr-coldo="lost"]')?.click());
  await page.waitForTimeout(1300);
  const stagesNow = await stages();
  check('the Lost stage is gone from the board',
    !!stagesNow && !stagesNow.some(x => /^lost:/.test(x)), JSON.stringify(stagesNow));

  const after = await openFirst();
  check('Mark won is still there', after.panel && after.won, JSON.stringify(after));
  check('but Lost is not offered any more, so no deal can be stranded',
    !after.lost, JSON.stringify(after));
  // Nothing may be sitting in a stage the board cannot draw.
  const orphan = await page.evaluate(() => {
    const r = (window.__mockDB.growth_settings || []).find(x => x.key === 'pipeline');
    const keys = ((r && r.value && r.value.stages) || []).map(s => s.key);
    return (window.__mockDB.growth_clients || []).filter(c => keys.indexOf(c.stage) < 0)
      .map(c => c.name + ':' + c.stage);
  });
  check('and no deal is left in a stage the board cannot draw', orphan.length === 0,
    JSON.stringify(orphan));
  // Put the board back in front: the open panel covers it, and every later step clicks it.
  await page.evaluate(() => document.querySelector('[data-gr-close]')?.click());
  await page.waitForTimeout(700);
});

/* ---------------------------------------------------------------- board columns */
await step('a stage can be added from the board, in the colour chosen', async () => {
  const before = await stages();
  await page.click('[data-gr-coladd="open"]');
  await page.waitForTimeout(700);
  await page.fill('#grColName', 'Negotiating');
  // Pick a colour that is not the one it opened on, so the assertion means something.
  const colour = await page.evaluate(() => {
    const sw = [...document.querySelectorAll('[data-gr-colsw]')].find(b => !b.classList.contains('gr_on2'));
    if (sw) sw.click();
    return sw ? sw.dataset.grColsw : null;
  });
  await page.waitForTimeout(500);
  await page.click('[data-gr-coladd="go"]');
  await page.waitForTimeout(1200);

  const after = await stages();
  check('the stage list grew by one', after && before && after.length === before.length + 1,
    JSON.stringify({ before: before && before.length, after: after && after.length }));
  const added = (after || []).find(x => /:Negotiating:/.test(x));
  check('with the name typed', !!added, String(added));
  check('and the colour picked, not the one it opened on',
    !!added && !!colour && added.toLowerCase().endsWith(colour.toLowerCase()),
    JSON.stringify({ added, colour }));
  // Lost is the end of the road; a new stage goes before it.
  const iNew = (after || []).findIndex(x => /:Negotiating:/.test(x));
  const iLost = (after || []).findIndex(x => /^lost:/.test(x));
  check('and it sits before Lost', iLost < 0 || iNew < iLost, JSON.stringify({ iNew, iLost }));

  const cols = await page.evaluate(() => document.querySelectorAll('.gr_board .gr_col').length);
  check('the board now draws it', cols === (after || []).length, String(cols));
});

await step('the board still fits, with Add stage in it', async () => {
  /* Add stage is a dashed column after the last stage, the way Luke's board has it. It
     spent a while under the board because a seventh share of the width pushed "Proposal
     sent" into "Proposa..." -- so the thing to measure is not where the button is, it is
     that putting it back has not re-broken the fit or the headings. */
  const m = await page.evaluate(() => {
    const b = document.querySelector('.gr_board');
    const add = b.querySelector('[data-gr-coladd="open"]');
    const cols = [...b.querySelectorAll('.gr_col')];
    return {
      overflows: b.scrollWidth > b.clientWidth + 1,
      addInBoard: !!add,
      addW: add ? Math.round(add.getBoundingClientRect().width) : 0,
      addH: add ? Math.round(add.getBoundingClientRect().height) : 0,
      addLast: !!add && b.lastElementChild === add,
      // Inside the board's scrollable width, not inside the window: a column you can
      // scroll to is fine, one past scrollWidth is lost.
      unreachable: cols.concat(add ? [add] : []).filter(e =>
        (e.getBoundingClientRect().right - b.getBoundingClientRect().left + b.scrollLeft)
          > b.scrollWidth + 2).length,
      scrollW: Math.round(b.scrollWidth),
      pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      narrowest: Math.min(...cols.map(e => Math.round(e.getBoundingClientRect().width))),
      ellipsised: [...b.querySelectorAll('.gr_colh b')]
        .filter(t => t.scrollWidth > t.clientWidth + 1).map(t => t.textContent)
    };
  });
  check('Add stage is a column on the board', m.addInBoard, JSON.stringify(m));
  check('and it is the last one', m.addLast, String(m.addLast));
  check('drawn at a real size, not a 0px slot', m.addW > 100 && m.addH > 60,
    JSON.stringify({ w: m.addW, h: m.addH }));
  /* THE BUG WAS NEVER "IT SCROLLS", it was a column sitting past the right edge with
     nothing to say so and no way to get to it. Luke's board is 260px columns that scroll,
     which is what gives a heading room to read on one or two lines instead of four. So
     the guard is reachability: every column, Add stage included, has to be inside the
     board's own scrollable width. */
  check('every stage is at least as wide as Luke\'s 260', m.narrowest >= 260, String(m.narrowest));
  check('and no stage heading is cut off', m.ellipsised.length === 0, JSON.stringify(m.ellipsised));
  check('every column is reachable by scrolling the board, not stranded off it',
    m.unreachable === 0, JSON.stringify({ unreachable: m.unreachable, scrollW: m.scrollW }));
  check('and the board is what scrolls, not the page',
    !m.pageScrolls, String(m.pageScrolls));
});

await step('every stage can be dragged, and says so', async () => {
  /* Reordering always worked and nothing on screen admitted it: no handle, no cursor,
     nothing. A feature you have to guess at is one nobody uses. */
  const m = await page.evaluate(() => [...document.querySelectorAll('.gr_board .gr_col')].map(c => {
    const h = c.querySelector('.gr_colh');
    const g = h && h.querySelector('.gr_colgrip');
    return {
      stage: c.dataset.grStage,
      draggable: !!h && h.getAttribute('draggable') === 'true',
      grabbable: !!h && !!h.dataset.grColgrab,
      grip: !!g,
      gripW: g ? Math.round(g.getBoundingClientRect().width) : 0,
      del: !!h && !!h.querySelector('[data-gr-coldel]'),
      // Hidden at opacity 0 it may as well not be there, and a screenshot proves nothing.
      delVisible: !!h && !!h.querySelector('[data-gr-coldel]') &&
        Number(getComputedStyle(h.querySelector('[data-gr-coldel]')).opacity) > 0.3
    };
  }));
  check('every stage is draggable', m.length >= 5 && m.every(x => x.draggable && x.grabbable),
    JSON.stringify(m.filter(x => !x.draggable || !x.grabbable)));
  check('every stage shows a grip', m.every(x => x.grip), JSON.stringify(m.map(x => x.stage + ':' + x.grip)));
  check('and the grip is actually drawn', m.every(x => x.gripW >= 6),
    JSON.stringify(m.map(x => x.stage + ':' + x.gripW)));
  check('every stage offers a delete', m.every(x => x.del), JSON.stringify(m.map(x => x.stage + ':' + x.del)));
  check('and it is visible without hovering first', m.every(x => x.delVisible),
    JSON.stringify(m.map(x => x.stage + ':' + x.delVisible)));
});

await step('deleting a stage asks where its deals go, and they actually go there', async () => {
  // Put a deal in the new stage so the question has something to be about.
  const moved = await page.evaluate(() => {
    const c = (window.__mockDB.growth_clients || [])[0];
    return c ? c.id : null;
  });
  await page.evaluate(id => {
    const s = window.__mockSb || null;        // not needed; drive the UI instead
    return id;
  }, moved);
  // Drive it the way a person does: open the deal, change the stage dropdown.
  await page.evaluate(id => document.querySelector('[data-gr-open="' + id + '"]')?.click(), moved);
  await page.waitForTimeout(1100);
  const key = await page.evaluate(() => {
    const sel = document.querySelector('[data-gr-stage-sel]');
    const opt = [...sel.options].find(o => o.textContent === 'Negotiating');
    if (!opt) return null;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return opt.value;
  });
  await page.waitForTimeout(1100);
  await page.evaluate(() => document.querySelector('[data-gr-close]')?.click());
  await page.waitForTimeout(800);
  check('a deal is sitting in the stage about to go', (await row(moved)).stage === key,
    (await row(moved)).stage + ' vs ' + key);

  await page.evaluate(k => document.querySelector('[data-gr-coldel="' + k + '"]')?.click(), key);
  await page.waitForTimeout(800);
  const bar = await page.evaluate(() => {
    const el = document.querySelector('.gr_coldel');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { text: el.textContent.replace(/\s+/g, ' ').trim(),
             hasPicker: !!document.querySelector('#grColTo'),
             options: [...(document.querySelector('#grColTo') || { options: [] }).options].map(o => o.textContent),
             w: Math.round(b.width), h: Math.round(b.height) };
  });
  check('it asks, rather than just deleting', !!bar && bar.hasPicker, JSON.stringify(bar));
  check('it says how many are in there', !!bar && /Move 1 deal to/.test(bar.text), bar && bar.text);
  check('and the stage being deleted is not offered as the destination',
    !!bar && bar.options.indexOf('Negotiating') < 0, JSON.stringify(bar && bar.options));
  check('the bar is actually visible, not a 0px row', !!bar && bar.w > 100 && bar.h > 40,
    JSON.stringify(bar && { w: bar.w, h: bar.h }));

  // Send them somewhere specific, and check they arrive THERE -- not merely that the
  // stage went. "0 rows" is ambiguous; a named destination is not.
  const dest = await page.evaluate(() => {
    const sel = document.querySelector('#grColTo');
    sel.value = sel.options[sel.options.length - 1].value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    return sel.value;
  });
  await page.evaluate(k => document.querySelector('[data-gr-coldo="' + k + '"]')?.click(), key);
  await page.waitForTimeout(1600);

  const list = await stages();
  check('the stage is gone', !(list || []).some(x => /:Negotiating:/.test(x)), JSON.stringify(list));
  check('and the deal went to the stage that was picked', (await row(moved)).stage === dest,
    (await row(moved)).stage + ' vs ' + dest);
});

await step('two stages are the floor', async () => {
  // Keep deleting and it has to stop, or the board becomes a blank page you cannot
  // get back from -- there is no "add" control once there is nothing to hang it off.
  const r = await page.evaluate(async () => {
    let guard = 0;
    while (guard++ < 12) {
      const b = document.querySelector('[data-gr-coldel]');
      if (!b) break;
      b.click();
      await new Promise(x => setTimeout(x, 220));
      const go = document.querySelector('[data-gr-coldo]');
      if (!go) break;
      go.click();
      await new Promise(x => setTimeout(x, 700));
    }
    const s = (window.__mockDB.growth_settings || []).find(x => x.key === 'pipeline');
    return { left: s && s.value && s.value.stages ? s.value.stages.length : null,
             cols: document.querySelectorAll('.gr_board .gr_col').length };
  });
  check('it stops at two rather than emptying the board', r.left >= 2 && r.cols >= 2, JSON.stringify(r));
});

/* ---------------------------------------------------------------- a video answer */
const qaItem = (id) => page.evaluate(i => {
  const r = (window.__mockDB.growth_settings || []).find(x => x.key === 'qa');
  return r && r.value && r.value.items ? (r.value.items.find(q => q.id === i) || null) : null;
}, id);

await step('a Loom link becomes a video on the answer', async () => {
  await screen('gr_training');
  await page.evaluate(() => document.querySelector('[data-gr-traintab="qa"]')?.click());
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.querySelector('[data-gr-qa-open="q-budget"]')?.click());
  await page.waitForTimeout(900);

  const before = await qaItem('q-budget');
  /* The examples moved to their own row, so the thing the save can still silently drop
     is the counting: n ranks the whole list and calls prints under the examples, and
     neither appears in the edit form. */
  check('the question has an ask count to lose', before.n === 12, String(before.n));
  check('and a call count the form never shows', before.calls === 9, String(before.calls));

  await page.evaluate(() => document.querySelector('[data-gr-qa-edit="q-budget"]')?.click());
  await page.waitForTimeout(800);
  const hasField = await page.evaluate(() => !!document.querySelector('[data-gr-qa="video"]'));
  check('the editor offers a video field', hasField, String(hasField));

  await page.fill('[data-gr-qa="video"]', 'https://www.loom.com/share/abc123XYZ?t=12');
  await page.evaluate(() => document.querySelector('[data-gr-qa-save="q-budget"]')?.click());
  await page.waitForTimeout(1400);

  const after = await qaItem('q-budget');
  // Normalised once, on save, so nothing downstream has to guess which link it got.
  check('the row keeps the embed form of the link', after.video === 'https://www.loom.com/embed/abc123XYZ',
    String(after.video));
  /* THE REASON THIS SAVE WAS REWRITTEN. It used to build a fresh object out of the form
     fields, which quietly dropped everything the form does not have -- the call examples
     and the ask count that ranks the whole list. Editing a typo deleted the evidence. */
  check('and did not throw away the ask count', after.n === 12, String(after.n));
  check('or the call count', after.calls === 9, String(after.calls));

  await page.evaluate(() => document.querySelector('[data-gr-qa-open="q-budget"]')?.click());
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('[data-gr-qa-open="q-budget"]')?.click());
  await page.waitForTimeout(900);
  const vid = await page.evaluate(() => {
    const f = document.querySelector('.gr_qavf iframe');
    if (!f) return null;
    const b = f.getBoundingClientRect();
    return { src: f.getAttribute('src'), w: Math.round(b.width), h: Math.round(b.height) };
  });
  // A 0x0 iframe is an iframe. The colour-dot check in this repo passed for months on an
  // element that was 0px wide, so the measurement is the assertion.
  check('the video is on screen at a watchable size',
    !!vid && vid.w > 300 && vid.h > 150, JSON.stringify(vid));
  check('pointed at the embed url', !!vid && vid.src === 'https://www.loom.com/embed/abc123XYZ',
    vid && vid.src);
});

await step('anything that is not a Loom link is refused, not framed', async () => {
  /* This src goes straight into an iframe. "Whatever was pasted" is a hole, so the only
     accepted shape is a Loom id, and saying so beats silently dropping it. */
  await page.evaluate(() => document.querySelector('[data-gr-qa-edit="q-budget"]')?.click());
  await page.waitForTimeout(800);
  await page.fill('[data-gr-qa="video"]', 'https://evil.example.com/x');
  await page.evaluate(() => document.querySelector('[data-gr-qa-save="q-budget"]')?.click());
  await page.waitForTimeout(1400);
  const after = await qaItem('q-budget');
  check('nothing was stored', !after.video, String(after.video));
  const framed = await page.evaluate(() =>
    [...document.querySelectorAll('iframe')].map(f => f.getAttribute('src')).filter(Boolean));
  check('and nothing points at it', framed.every(u => !/evil\.example/.test(u)), framed.join(','));
  const said = await page.evaluate(() => (document.querySelector('#grToast span') || {}).textContent || '');
  check('and it says so rather than dropping it quietly', /Loom/i.test(said), said);
});

await step('saving any Training edit puts the form away and shows the change', async () => {
  /* grSetting wrote the row and never repainted, so Save closed the editor in state and
     left it on the screen: the form sat there and the new wording did not appear until
     you left the screen and came back. Checked on Clear answers rather than on Q and A,
     because the fix is in grSetting and has to hold for every editor that calls it. */
  await page.evaluate(() => document.querySelector('[data-gr-traintab="clear"]')?.click());
  await page.waitForTimeout(1200);
  const id = await page.evaluate(() => {
    const b = document.querySelector('[data-gr-cl-edit]');
    if (b) b.click();
    return b ? b.dataset.grClEdit : null;
  });
  await page.waitForTimeout(800);
  check('an answer opens for editing', !!id, String(id));
  await page.fill('[data-gr-cl="a"]', 'Rewritten on the spot.');
  await page.evaluate(i => document.querySelector('[data-gr-cl-save="' + i + '"]')?.click(), id);
  await page.waitForTimeout(1400);

  const m = await page.evaluate(() => ({
    stillEditing: !!document.querySelector('[data-gr-cl="a"]'),
    shows: document.body.textContent.indexOf('Rewritten on the spot.') >= 0
  }));
  check('the form is gone', !m.stillEditing, String(m.stillEditing));
  check('and the new wording is on the page without reloading the screen', m.shows, String(m.shows));
  const stored = await page.evaluate(i => {
    const r = (window.__mockDB.growth_settings || []).find(x => x.key === 'clear');
    const it = r && r.value && r.value.items ? r.value.items.find(q => q.id === i) : null;
    return it ? it.a : null;
  }, id);
  check('and it is in the row too, not only on screen', stored === 'Rewritten on the spot.', String(stored));
});

await step("Luke's apostrophes survive the screen and the editor", async () => {
  /* The content was seeded with every contraction and quotation mark stripped out:
     "don't oversell" became "do not oversell", 'Replace "um"' became 'Replace um'. Nothing
     rendered wrong, so nothing caught it -- the copy on screen simply was not the copy Luke
     wrote. Restored in 20261028090000.

     Two separate things can eat them, so both are measured. The renderer runs text through
     esc(), which escapes & < > via textContent; if that ever became a hand-rolled replace
     it could emit a literal &#39; instead. And every Training page round trips through a
     plain-text editor that joins pairs with " :: " and splits them again, which is exactly
     the kind of parse that quietly mangles a quote. Saving an UNCHANGED lesson has to give
     back byte-identical text, so the second half asserts on the database row, not the DOM. */
  await page.evaluate(() => document.querySelector('[data-gr-traintab="course"]')?.click());
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.querySelector('[data-gr-lesson="why"]')?.click());
  await page.waitForTimeout(900);

  const seen = await page.evaluate(() => {
    const t = document.body.innerText;
    return {
      apos:   t.indexOf("Don't try too hard.") >= 0,
      quoted: t.indexOf('Replace "um" with a short pause.') >= 0,
      // A hand-rolled escape would put the entity on the screen as visible text.
      entity: /&#39;|&quot;|&amp;/.test(t),
      // The shape the stripped seed had.
      flattened: t.indexOf('Do not try too hard') >= 0 || t.indexOf('Replace um with') >= 0
    };
  });
  check('the apostrophe is on screen as an apostrophe', seen.apos, JSON.stringify(seen));
  check('and the quoted word keeps its quotes', seen.quoted, JSON.stringify(seen));
  check('no HTML entity leaked into the visible text', !seen.entity, JSON.stringify(seen));
  check('nothing was flattened back to the seeded wording', !seen.flattened, JSON.stringify(seen));

  // Open the editor and save WITHOUT touching anything. The text must come back whole.
  await page.evaluate(() => document.querySelector('[data-gr-lesson-edit="why"]')?.click());
  await page.waitForTimeout(800);
  const opened = await page.evaluate(() => {
    const el = document.querySelector('[data-gr-ls="blocks"]');
    return el ? el.value : null;
  });
  check('the lesson opens for editing', !!opened, String(opened && opened.slice(0, 40)));
  check('the editor shows the apostrophe, not an entity',
    !!opened && opened.indexOf("Don't try too hard.") >= 0 && !/&#39;/.test(opened),
    String(opened && opened.slice(0, 120)));

  await page.evaluate(() => document.querySelector('[data-gr-lesson-save="why"]')?.click());
  await page.waitForTimeout(1400);
  const stored = await page.evaluate(() => {
    const r = (window.__mockDB.growth_settings || []).find(x => x.key === 'course');
    const l = r && r.value && r.value.lessons ? r.value.lessons.find(x => x.id === 'why') : null;
    return l ? (l.blocks || []).map(b => [b.h, b.t].filter(Boolean).join(' :: ')).join('\n') : null;
  });
  check('a save that changed nothing changed nothing, in the row',
    !!stored && stored.indexOf("Don't try too hard. Replace \"um\" with a short pause.") >= 0,
    String(stored));
});

await step('the Q and A list is ranked, counted and tagged', async () => {
  /* Giant had 6 questions and no counts, so every row showed a caret and the rank was
     hidden -- correctly, since ranking nothing is a lie. Luke's board carries the ask
     count, so the list ranks and each row is tagged with how often it came up. The ten
     that come from Clear answers have no count and say "AI answer" instead. */
  await screen('gr_training');
  await page.evaluate(() => document.querySelector('[data-gr-traintab="qa"]')?.click());
  await page.waitForTimeout(1300);
  const rows = await page.evaluate(() => [...document.querySelectorAll('.gr_qa3')].map(el => ({
    rank: (el.querySelector('.gr_qrk') || {}).textContent || null,
    q: (el.querySelector('.gr_qah b:not(.gr_qrk)') || {}).textContent || null,
    tag: (el.querySelector('.gr_qah > i') || {}).textContent || null,
    ai: !!el.querySelector('.gr_qaai'),
    // A 0px badge passes "exists". Measure it.
    rankW: Math.round(((el.querySelector('.gr_qrk') || { getBoundingClientRect: () => ({ width: 0 }) })
      .getBoundingClientRect()).width)
  })));
  check('every row carries a rank', rows.length === 3 && rows.every(r => r.rank),
    JSON.stringify(rows));
  check('and the ranks run 1, 2, 3 without restarting for the AI rows',
    rows.map(r => r.rank).join(',') === '1,2,3', JSON.stringify(rows.map(r => r.rank)));
  check('the badge is actually drawn, not 0px', rows.every(r => r.rankW >= 20),
    JSON.stringify(rows.map(r => r.rankW)));
  // Most asked first: q-budget at 12 outranks q-lock at 5, whatever order they were declared.
  check('the most asked question is first', /budget/i.test(rows[0].q || ''), String(rows[0].q));
  check('a counted question is tagged with its count', rows[0].tag === '12x', String(rows[0].tag));
  check('the second says 5x', rows[1].tag === '5x', String(rows[1].tag));
  /* The Clear answers row has no count to show. It must not fall back to a caret, which
     is what an uncounted row used to render, and must not claim a number it has not got. */
  check('the Clear answers row says AI answer, not a count or a caret',
    rows[2].tag === 'AI answer' && rows[2].ai, JSON.stringify(rows[2]));
});

await step('a question shows the model answer and the rewrite, not just one', async () => {
  /* The first import took `better` and dropped `aiBetter`, so the screen showed the
     rewrite with nothing to compare it against. Reading the two next to each other IS
     the lesson -- the rewrite is shorter, splits the long sentence up and adds what only
     somebody on the calls would know. */
  await screen('gr_training');
  await page.evaluate(() => document.querySelector('[data-gr-traintab="qa"]')?.click());
  await page.waitForTimeout(1300);
  for (let i = 0; i < 3 && !(await page.evaluate(() =>
      !!document.querySelector('[data-gr-qa-open="q-budget"]')?.closest('.gr_qa3')?.querySelector('.gr_qaa'))); i++) {
    await page.evaluate(() => document.querySelector('[data-gr-qa-open="q-budget"]')?.click());
    await page.waitForTimeout(900);
  }
  const m = await page.evaluate(() => {
    const sec = document.querySelector('[data-gr-qa-open="q-budget"]')?.closest('.gr_qa3');
    if (!sec) return null;
    const lab = [...sec.querySelectorAll('.gr_qaa > span')].map(e => e.textContent.trim());
    const orig = sec.querySelector('.gr_qaorig');
    const mine = [...sec.querySelectorAll('.gr_qaa')].find(e => !e.classList.contains('gr_qaorig'));
    const bl = sec.querySelector('.gr_qabl');
    return {
      labels: lab,
      origText: orig ? (orig.querySelector('p') || {}).textContent : null,
      mineText: mine ? (mine.querySelector('p') || {}).textContent : null,
      origBullets: orig ? [...orig.querySelectorAll('.gr_qapts li')].map(l => l.textContent) : [],
      blBullets: bl ? [...bl.querySelectorAll('li')].map(l => l.textContent) : [],
      // A block that is there but 0px high is not on screen.
      origH: orig ? Math.round(orig.getBoundingClientRect().height) : 0
    };
  });
  check('both blocks are labelled', !!m && m.labels.join(' | ') === "Original AI answer | Annie's version",
    JSON.stringify(m && m.labels));
  check('the model answer is the one it stored', !!m && /We fix the tracking first/.test(m.origText || ''),
    String(m && m.origText));
  check('the rewrite is the other one, and they are not the same text',
    !!m && m.mineText && m.origText && m.mineText !== m.origText, JSON.stringify(m && { o: m.origText, v: m.mineText }));
  check('the model answer is actually drawn, not a 0px block', !!m && m.origH > 40, String(m && m.origH));
  /* Each set of bullets comes off its OWN text. Deriving both from the rewrite would
     look right and say the wrong thing under the model's answer. */
  check('the original keeps its own bullets',
    !!m && m.origBullets.some(b => /We fix the tracking first/.test(b)), JSON.stringify(m && m.origBullets));
  check('and the rewrite has its own under Bullet points',
    !!m && m.blBullets.length === 3 && m.blBullets.some(b => /Only grow when it works/.test(b)),
    JSON.stringify(m && m.blBullets));
});

await step('hand-written bullets beat the ones split out of the answer', async () => {
  // Somebody took the trouble to write them. Re-deriving would throw that away silently.
  for (let i = 0; i < 3 && !(await page.evaluate(() =>
      !!document.querySelector('[data-gr-qa-open="q-lock"]')?.closest('.gr_qa3')?.querySelector('.gr_qabl'))); i++) {
    await page.evaluate(() => document.querySelector('[data-gr-qa-open="q-lock"]')?.click());
    await page.waitForTimeout(900);
  }
  const b = await page.evaluate(() => {
    const sec = document.querySelector('[data-gr-qa-open="q-lock"]')?.closest('.gr_qa3');
    const bl = sec && sec.querySelector('.gr_qabl');
    return bl ? [...bl.querySelectorAll('li')].map(l => l.textContent.trim()) : null;
  });
  check('the written bullets are the ones shown',
    !!b && b[0] === 'Nobody is locked in for a year', JSON.stringify(b));
  check('not the sentences split out of the answer',
    !!b && !b.some(x => /^No annual lock in\.$/.test(x)), JSON.stringify(b));
});

await step('a Clear answer does not print the same text twice', async () => {
  /* The ten rows that come from Clear answers carry the same words in both fields. Two
     identical blocks under one question reads as a bug, so the original is only shown
     when it genuinely differs. */
  for (let i = 0; i < 3 && !(await page.evaluate(() =>
      !!document.querySelector('[data-gr-qa-open="ai-what"]')?.closest('.gr_qa3')?.querySelector('.gr_qaa'))); i++) {
    await page.evaluate(() => document.querySelector('[data-gr-qa-open="ai-what"]')?.click());
    await page.waitForTimeout(900);
  }
  const m = await page.evaluate(() => {
    const sec = document.querySelector('[data-gr-qa-open="ai-what"]')?.closest('.gr_qa3');
    if (!sec) return null;
    return { blocks: sec.querySelectorAll('.gr_qaa').length,
             orig: sec.querySelectorAll('.gr_qaorig').length,
             label: (sec.querySelector('.gr_qaa > span') || {}).textContent };
  });
  check('only one answer block', !!m && m.blocks === 1, JSON.stringify(m));
  check('and no Original AI answer above it', !!m && m.orig === 0, JSON.stringify(m));
  check('labelled plainly, since there is nothing to compare it to',
    !!m && /The best answer/.test(m.label || ''), JSON.stringify(m));
});

await step('the Q and A tab is questions and answers, nothing else', async () => {
  /* It used to end with "Tricks from your calls" -- ten cards -- and "Answers to tighten",
     both about the calls rather than about any question. You scrolled past a report to
     reach the thing you came for. The data is still in growth_settings qa_extra, so they
     can come back on a screen of their own; what must not come back is them hanging off
     the bottom of this list. */
  await screen('gr_training');
  await page.evaluate(() => document.querySelector('[data-gr-traintab="qa"]')?.click());
  await page.waitForTimeout(1300);
  const m = await page.evaluate(() => {
    const t = document.body.innerText;
    return {
      tricksHeading: /Tricks from your calls/i.test(t),
      weakHeading: /Answers to tighten/i.test(t),
      trickCards: document.querySelectorAll('.gr_tkc').length,
      // What SHOULD be there, so this cannot pass by the tab failing to render at all.
      rows: document.querySelectorAll('.gr_qa3').length,
      search: !!document.querySelector('#grQaQ')
    };
  });
  check('the questions are still listed', m.rows >= 3 && m.search, JSON.stringify(m));
  check('no Tricks from your calls heading', !m.tricksHeading, JSON.stringify(m));
  check('no Answers to tighten heading', !m.weakHeading, JSON.stringify(m));
  check('and no trick cards left behind', m.trickCards === 0, String(m.trickCards));
  // The data itself is kept, so this was a screen decision and not a delete.
  const kept = await page.evaluate(() => {
    const r = (window.__mockDB.growth_settings || []).find(x => x.key === 'qa_extra');
    return r && r.value ? { tricks: (r.value.tricks || []).length, weak: (r.value.weak || []).length } : null;
  });
  check('the tricks and weak answers are still in the database, just not on this tab',
    !!kept && kept.tricks > 0 && kept.weak > 0, JSON.stringify(kept));
});

await step('the open row is the two answers, the bullets and the video', async () => {
  /* The row used to carry six more blocks: what they are really asking, why the answer
     works, the trick tags, how you usually answer, and three call examples with a "show
     all 62". Luke's row has five things and that is the brief. The 588 examples and the
     rest of the fields are all still in growth_settings -- nothing was deleted, it is
     the row that got shorter -- and the boot query still leaves the 364KB out. */
  await screen('gr_training');
  await page.evaluate(() => document.querySelector('[data-gr-traintab="qa"]')?.click());
  await page.waitForTimeout(1300);
  for (let i = 0; i < 3 && !(await page.evaluate(() =>
      !!document.querySelector('[data-gr-qa-open="q-budget"]')?.closest('.gr_qa3')?.querySelector('.gr_qaa'))); i++) {
    await page.evaluate(() => document.querySelector('[data-gr-qa-open="q-budget"]')?.click());
    await page.waitForTimeout(900);
  }
  const m = await page.evaluate(() => {
    const sec = document.querySelector('[data-gr-qa-open="q-budget"]').closest('.gr_qa3');
    return {
      text: sec.innerText,
      examples: sec.querySelectorAll('.gr_qe').length,
      showAll: !!sec.querySelector('[data-gr-qa-all]'),
      answers: sec.querySelectorAll('.gr_qaa').length,
      bullets: sec.querySelectorAll('.gr_qabl li').length,
      video: !!sec.querySelector('.gr_qavid')
    };
  });
  check('both answers are there', m.answers === 2, JSON.stringify({ a: m.answers }));
  check('so are the bullet points', m.bullets === 3, String(m.bullets));
  check('and the video answer', m.video, String(m.video));
  check('no call examples on the row', m.examples === 0 && !m.showAll, JSON.stringify(m));
  check('no "what they are really asking"', !/really asking/i.test(m.text), 'present');
  check('no "how you usually answer"', !/usually answer/i.test(m.text), 'present');
  check('and no trick tags', !/Name the fear out loud/.test(m.text), 'present');
  // Kept, not deleted: the examples are still in the database for a screen of their own.
  const kept = await page.evaluate(() => {
    const r = (window.__mockDB.growth_settings || []).find(x => x.key === 'qa_examples');
    return r && r.value && r.value.byId ? (r.value.byId['q-budget'] || []).length : -1;
  });
  check('the call examples are still in the database', kept === 4, String(kept));
  // And nothing fetches them any more, since nothing draws them.
  const q = await page.evaluate(() =>
    (window.__mock.log.queries || []).filter(x => /^growth_settings\.select/.test(x)));
  /* By CONTENT, not by position. This read q[0] and assumed the boot read came first;
     the Growth access gate now asks growth_settings a targeted question before it --
     one row, by key -- so position 0 stopped being the boot read while the thing this
     protects was still perfectly true. */
  check('the boot read still leaves the 364KB out',
    q.some(x => /key neq qa_examples/.test(x)), JSON.stringify(q));
  /* And the gate's own read stays narrow: one key, not the whole table again. */
  check('the access gate asks for one row, not everything',
    !q.some(x => /^growth_settings\.select\[\]$/.test(x)), JSON.stringify(q));
  check('and nothing fetches them any more', !q.some(x => /key eq qa_examples/.test(x)),
    JSON.stringify(q));
});

await step('a Loom link can be saved from the row itself', async () => {
  // Recording the answer and filing it are one job, so the field is on the row.
  const row = '[data-gr-qa-open="q-budget"]';
  const has = await page.evaluate(s => !!document.querySelector(s).closest('.gr_qa3')
    .querySelector('[data-gr-qa-loom]'), row);
  check('the row offers somewhere to paste it', has, String(has));
  await page.fill('#grLoom-q-budget', 'https://www.loom.com/share/zz9PlaskedZ?t=30');
  await page.evaluate(() => document.querySelector('[data-gr-qa-loom="q-budget"]')?.click());
  await page.waitForTimeout(1300);
  const stored = await page.evaluate(() => {
    const r = (window.__mockDB.growth_settings || []).find(x => x.key === 'qa');
    const it = r.value.items.find(q => q.id === 'q-budget');
    return it ? it.video : null;
  });
  check('it is stored in embed form, on the row',
    stored === 'https://www.loom.com/embed/zz9PlaskedZ', String(stored));
  const framed = await page.evaluate(s => {
    const f = document.querySelector(s).closest('.gr_qa3').querySelector('.gr_qavf iframe');
    return f ? { src: f.getAttribute('src'), w: Math.round(f.getBoundingClientRect().width) } : null;
  }, row);
  check('and it is on screen at a watchable size',
    !!framed && framed.w > 300, JSON.stringify(framed));
  check('pointed at the embed url',
    !!framed && framed.src === 'https://www.loom.com/embed/zz9PlaskedZ', JSON.stringify(framed));
});

await step('anything that is not a Loom link is refused on the row too', async () => {
  await page.evaluate(() => document.querySelector('[data-gr-qa-vdel="q-budget"]')?.click());
  await page.waitForTimeout(1200);
  await page.fill('#grLoom-q-budget', 'https://evil.example.com/x');
  await page.evaluate(() => document.querySelector('[data-gr-qa-loom="q-budget"]')?.click());
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => {
    const r = (window.__mockDB.growth_settings || []).find(x => x.key === 'qa');
    const it = r.value.items.find(q => q.id === 'q-budget');
    return { video: it ? (it.video || '') : null,
             framed: !!document.querySelector('.gr_qavf iframe') };
  });
  check('nothing was stored', after.video === '', JSON.stringify(after));
  check('and nothing points at it', !after.framed, JSON.stringify(after));
});

await step('Pricing is off the Training strip but not orphaned', async () => {
  await screen('gr_training');
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('[data-gr-traintab]')].map(b => b.dataset.grTraintab));
  check('Pricing is not a tab any more', tabs.indexOf('pricing') < 0, tabs.join(','));
  check('the other four are', ['course', 'clear', 'lib', 'qa'].every(t => tabs.indexOf(t) >= 0),
    tabs.join(','));
  check('and Practice is gone with it', tabs.indexOf('practice') < 0, tabs.join(','));
  /* Hidden, not deleted. "Know the offer" links straight to it, which is the one place
     anybody actually wants it, and the strip lights Course while you are there rather
     than lighting nothing at all. */
  // Earlier steps left Training on another tab; the lessons only exist on Course.
  await page.evaluate(() => document.querySelector('[data-gr-traintab="course"]')?.click());
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.querySelector('[data-gr-lesson="offer"]')?.click());
  await page.waitForTimeout(900);
  const link = await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-gr-traintab="pricing"]')][0];
    if (b) b.click();
    return !!b;
  });
  check('a lesson still links to it', link, String(link));
  if (link) {
    await page.waitForTimeout(1000);
    const m = await page.evaluate(() => ({
      onPricing: /per month|Payment link|pricing/i.test(document.body.textContent),
      lit: [...document.querySelectorAll('[data-gr-traintab]')]
        .filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.grTraintab)
    }));
    check('and it opens', m.onPricing, String(m.onPricing));
    check('with Course lit rather than nothing', m.lit.indexOf('course') >= 0, m.lit.join(','));
  }
});

await step('Recordings is off the sidebar', async () => {
  const m = await page.evaluate(() => ({
    nav: !!document.querySelector('#appSidebar .nav-item[data-screen="gr_recordings"]'),
    growthNav: [...document.querySelectorAll('#appSidebar .nav-item[data-screen^="gr_"]')]
      .map(n => n.dataset.screen)
  }));
  check('there is no Recordings item', !m.nav, String(m.nav));
  // The rest of Growth is untouched -- a nav item removed with a greedy regex would take
  // its neighbours with it and nothing else here would notice.
  check('and the other Growth items are all still there',
    ['gr_home', 'gr_meetings', 'gr_pipeline', 'gr_inbox', 'gr_training', 'gr_analytics',
     'gr_connectors', 'gr_settings', 'gr_automations'].every(k => m.growthNav.indexOf(k) >= 0),
    m.growthNav.join(','));
});

await step('the Q and A screen is the answer, not a wall of controls', async () => {
  await screen('gr_training');
  await page.evaluate(() => document.querySelector('[data-gr-traintab="qa"]')?.click());
  await page.waitForTimeout(1300);
  const m = await page.evaluate(() => ({
    themeChips: document.querySelectorAll('[data-gr-qatheme]').length,
    viewStrip: document.querySelectorAll('[data-gr-qaview]').length,
    search: !!document.querySelector('#grQaQ'),
    rows: document.querySelectorAll('.gr_qa3').length
  }));
  /* Luke dropped both in his latest pass, and the second one had become actively
     confusing: a button called Practice inside
     Q and A went somewhere else entirely. */
  check('no theme filter chips', m.themeChips === 0, String(m.themeChips));
  check('no Browse / Practice strip', m.viewStrip === 0, String(m.viewStrip));
  check('the search box stays', m.search, String(m.search));
  check('and the questions are listed', m.rows > 0, String(m.rows));
});

await step('the answer reads in the same ink as the rest of the page', async () => {
  /* THE ONE THAT WAS REPORTED. The answer card was `background:var(--text)` with
     `color:var(--bg)` -- an inverted block, which is a dark card on Luke's white page
     and a WHITE card with black text in the middle of ours. Luke's latest replaced it
     with a faint tint of the accent, which is what this now is.

     Measured as ink rather than as a colour name: the card's text must be the page's
     text colour, and its background must not be the page's text colour. */
  // Earlier steps leave a row open, so a single click can CLOSE one. Open whichever
  // row is needed rather than assuming the list starts shut.
  for (let i = 0; i < 3 && !(await page.evaluate(() => !!document.querySelector('.gr_qaa'))); i++) {
    await page.evaluate(() => document.querySelector('.gr_qah')?.click());
    await page.waitForTimeout(700);
  }
  const m = await page.evaluate(() => {
    const card = document.querySelector('.gr_qaa');
    if (!card) return null;
    const p = card.querySelector('p');
    const lum = (c) => { const n = (c.match(/\d+/g) || []).slice(0, 3).map(Number);
                         return n.length === 3 ? Math.round((n[0] * 299 + n[1] * 587 + n[2] * 114) / 1000) : null; };
    return { cardBg: getComputedStyle(card).backgroundColor,
             cardInk: lum(getComputedStyle(p || card).color),
             pageInk: lum(getComputedStyle(document.body).color),
             pageBg: lum(getComputedStyle(document.body).backgroundColor),
             w: Math.round(card.getBoundingClientRect().width) };
  });
  check('the answer card is on screen', !!m && m.w > 300, JSON.stringify(m && m.w));
  check('its text is the page\'s text colour, not inverted',
    !!m && Math.abs(m.cardInk - m.pageInk) < 40, JSON.stringify(m && { card: m.cardInk, page: m.pageInk }));
  // On a dark theme the page ink is near-white; a card painted THAT is the bug.
  check('and its background is not the page\'s ink',
    !!m && Math.abs((m.cardBg.match(/\d+/g) || [0]).slice(0, 3).reduce((a2, b2) => a2 + Number(b2), 0) / 3 - m.pageInk) > 60,
    m && m.cardBg);
});

await step('the ranking disappears when nothing has been counted', async () => {
  /* Nothing in Giant counts how often a question is asked, so on real data every row
     said "New", numbered 1 to 6 by nothing. Driven here by serving a mock with the two
     ask counts stripped out, rather than by poking at the page's own state. */
  const blank = MOCK.replace(/byId\['q-[a-z]+'\]\.n = \d+;/g, '');
  check('the fixture really lost its counts', blank !== MOCK && !/\]\.n = \d+;/.test(blank),
    String(blank === MOCK));
  const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 980 } });
  const p2 = await ctx2.newPage();
  await p2.route('**/@supabase/supabase-js@2*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: blank }));
  await p2.route('**://*.supabase.co/**', r => r.abort());
  await p2.goto(BASE + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p2.waitForSelector('#view-app.on', { timeout: 30000 });
  await p2.waitForTimeout(3000);
  await p2.evaluate(() => document.querySelector('#appSidebar .nav-item[data-screen="gr_training"]')?.click());
  await p2.waitForTimeout(1500);
  await p2.evaluate(() => document.querySelector('[data-gr-traintab="qa"]')?.click());
  await p2.waitForTimeout(1300);
  const m = await p2.evaluate(() => ({
    rows: document.querySelectorAll('.gr_qa3').length,
    ranks: document.querySelectorAll('.gr_qrk').length,
    bars: document.querySelectorAll('.gr_qah span u').length,
    says: [...document.querySelectorAll('.gr_qah > i')].map(e => e.textContent.trim())
  }));
  check('the questions are still all there', m.rows > 0, String(m.rows));
  check('but no rank chips', m.ranks === 0, String(m.ranks));
  check('no empty bars under them', m.bars === 0, String(m.bars));
  check('and nothing claims an ask count', m.says.every(t => !/\dx/.test(t)), JSON.stringify(m.says));
  await ctx2.close();
});

await step('the Pipeline header answers the two questions you open it with', async () => {
  await screen('gr_pipeline');
  const m = await page.evaluate(() => {
    const h = document.querySelector('.gr_head p');
    return { text: h ? h.textContent.replace(/\s+/g, ' ').trim() : null,
             pill: !!document.querySelector('.gr_head .gr_flag'),
             bigStats: !!document.querySelector('.gr_head .gr_stats') };
  });
  check('it says how much is active', !!m.text && /\d+ active/.test(m.text), m.text);
  check('and flags replies waiting on you', m.pill, String(m.pill));
  /* The three big numbers that used to sit here are on Analytics; across the top of a
     board they read as a dashboard nobody asked for and pushed the board below the fold. */
  check('without the dashboard of numbers', !m.bigStats, String(m.bigStats));
});

/* ---------------------------------------------------------------- on a phone */
await step('every Training tab is still reachable at phone width', async () => {
  /* Six tabs once overflowed here: .gr_seg was inline-flex with no wrap and no scroll,
     so the last one was CLIPPED by the screen edge and could not be reached at all.
     Nothing looked wrong from a desktop, and the page did not even scroll sideways to
     hint at it, which is why this is measured against the viewport rather than
     eyeballed. There are four tabs now, which fit -- the check stays because the next
     tab somebody adds is the one that would not. */
  const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await ph.newPage();
  await pp.route('**/@supabase/supabase-js@2*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
  await pp.route('**://*.supabase.co/**', r => r.abort());
  await pp.goto(BASE + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pp.waitForSelector('#view-app.on', { timeout: 30000 });
  await pp.waitForTimeout(3000);
  await pp.evaluate(() => document.querySelector('#appSidebar .nav-item[data-screen="gr_training"]')?.click());
  await pp.waitForTimeout(1800);

  const m = await pp.evaluate(() => {
    const seg = document.querySelector('.gr_seg');
    if (!seg) return null;
    const names = [...seg.querySelectorAll('button')].map(b => b.textContent);
    // Scroll the strip to its end: the last tab has to come into view.
    seg.scrollLeft = seg.scrollWidth;
    const last = [...seg.querySelectorAll('button')].pop().getBoundingClientRect();
    return {
      names: names,
      clipped: seg.scrollWidth > seg.clientWidth + 1 && getComputedStyle(seg).overflowX === 'visible',
      lastVisible: last.right <= innerWidth + 1 && last.left >= -1,
      // The strip scrolls; the PAGE must not.
      pageSideways: document.documentElement.scrollWidth > innerWidth + 1
    };
  });
  check('all four tabs are rendered', !!m && m.names.length === 4, JSON.stringify(m && m.names));
  check('the strip scrolls rather than clipping what will not fit', !!m && !m.clipped, String(m && m.clipped));
  check('so the last tab can actually be reached', !!m && m.lastVisible, String(m && m.lastVisible));
  check('and the page itself does not scroll sideways', !!m && !m.pageSideways, String(m && m.pageSideways));

  await ph.close();
});

await step('the Today widget is gone, and took nothing with it', async () => {
  /* Removed on request. It was a floating button over every Growth screen opening a
     drawer of today's replies and calls; the screens themselves already say all of it.

     The checks that used to live here drove that button. They are replaced rather than
     deleted, because the risk in pulling a widget out is not that it lingers -- that is
     obvious on sight -- but that a shared thing goes with it. */
  await screen('gr_pipeline');
  await page.waitForTimeout(900);
  const gone = await page.evaluate(() => ({
    btn: document.querySelectorAll('.gr_tdbtn, #grTodayBtn').length,
    drawer: document.querySelectorAll('#grToday, .gr_tdd, .gr_tdscrim').length,
    opener: document.querySelectorAll('[data-gr-today-open], [data-gr-today-close]').length
  }));
  check('no button, no drawer, no handle left to open one',
    gone.btn === 0 && gone.drawer === 0 && gone.opener === 0, JSON.stringify(gone));

  /* THE ONE THAT MATTERS. Three handlers closed the drawer before opening something
     else, and one of them sat in the [data-gr-act] branch -- the Send email button. The
     module is 'use strict', so the orphaned `grTodayOpen = false` left behind threw a
     ReferenceError and the composer silently stopped opening. Nothing about a missing
     widget would have shown that; only pressing the button does. */
  // Not every Growth screen renders one, so find the screen that does rather than
  // assuming -- a check that cannot find its button reports nothing, not a pass.
  for (const scr of ['gr_inbox', 'gr_home', 'gr_pipeline']) {
    await screen(scr);
    await page.waitForTimeout(800);
    const found = await page.evaluate(() => !!document.querySelector('[data-gr-act]'));
    if (found) break;
  }
  const opened = await page.evaluate(async () => {
    const b = document.querySelector('[data-gr-act]');
    if (!b) return { pressed: false };
    const errs = [];
    const onErr = e => errs.push(String(e.message || e));
    window.addEventListener('error', onErr);
    b.click();
    await new Promise(r => setTimeout(r, 700));
    window.removeEventListener('error', onErr);
    // The composer is drawn INSIDE the deal sheet, so measure the sheet's wrapper.
    const c = document.querySelector('[data-gr-cwrap]');
    return { pressed: true, errs,
             composer: !!c && c.getBoundingClientRect().height > 40 };
  });
  check('the Send email button still opens the composer',
    opened.pressed && opened.composer, JSON.stringify(opened));
  check('and threw nothing on the way',
    opened.pressed && (opened.errs || []).length === 0, JSON.stringify(opened.errs));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  /* ---- replying from the Inbox with a template ----
     Replying IS the job on that screen, and a template is how it is done quickly. The
     way into the templates was four clicks away under Settings, and the reply composer
     already had the picker -- so the two halves existed and never met. */
  await screen('gr_inbox');
  await page.waitForTimeout(800);
  const head = await page.evaluate(() => {
    const h = document.querySelector('#grInbox .gr_head');
    return { btn: !!(h && h.querySelector('[data-gr-tplbtn]')),
             label: h && h.querySelector('[data-gr-tplbtn]')
               ? h.querySelector('[data-gr-tplbtn]').textContent.trim() : '',
             reply: !!document.querySelector('#grInbox [data-gr-act][data-t="reply"]') };
  });
  check('the Inbox has its own way into the templates',
    head.btn && /template/i.test(head.label), JSON.stringify(head));
  check('and a reply to the person who wrote to you', head.reply, JSON.stringify(head.reply));

  /* Opened on whatever tab the panel was last left on, the button lands somewhere other
     than its own label -- so leave it on Team first and require Templates back. */
  await page.evaluate(() =>
    document.querySelector('#appSidebar .nav-item[data-screen="gr_settings"]')?.click());
  await page.waitForTimeout(700);
  await page.evaluate(() => [...document.querySelectorAll('.gr_setd [data-gr-settab]')]
    .find(b => /Team/i.test(b.textContent))?.click());
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await screen('gr_inbox');
  await page.waitForTimeout(700);
  await page.evaluate(() => document.querySelector('[data-gr-tplbtn]')?.click());
  await page.waitForTimeout(900);
  const landed = await page.evaluate(() => ({
    open: !!document.querySelector('#grSetPanel.on'),
    tab: (document.querySelector('.gr_setd [data-gr-settab][aria-pressed="true"]') || {}).textContent,
    groups: [...document.querySelectorAll('.gr_setd .gr_card .gr_ct h2')].map(x => x.textContent.trim())
  }));
  check('it opens the panel on Templates, not on the tab it was left on',
    landed.open && landed.tab === 'Templates' &&
    landed.groups.join(',') === 'Package emails,Other emails', JSON.stringify(landed));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await screen('gr_inbox');
  await page.waitForTimeout(700);
  await page.evaluate(() => document.querySelector('#grInbox [data-gr-act][data-t="reply"]')?.click());
  await page.waitForTimeout(1200);
  const picker = await page.evaluate(() =>
    [...document.querySelectorAll('[data-gr-pick="template"]')].filter(b => b.offsetParent).length);
  check('Reply opens a composer that offers the templates',
    picker > 0, String(picker));
  await page.evaluate(() =>
    [...document.querySelectorAll('[data-gr-pick="template"]')].find(b => b.offsetParent)?.click());
  await page.waitForTimeout(700);
  const menu = await page.evaluate(() =>
    [...document.querySelectorAll('[data-gr-pk="tpl"]')].map(b => b.textContent.trim()));
  /* Every saved template, by name. A menu holding only the built-in wordings would look
     the same from outside and would not be the templates at all. */
  check('and the menu lists the saved templates by name',
    menu.indexOf('Google Ads Management 1.5k') >= 0 && menu.indexOf('Zoom reminder') >= 0,
    JSON.stringify(menu));

  await page.evaluate(() => [...document.querySelectorAll('[data-gr-pk="tpl"]')]
    .find(b => b.textContent.trim() === 'Google Ads Management 1.5k')?.click());
  await page.waitForTimeout(1000);
  const filled = await page.evaluate(() => {
    const g = sel => { const el = document.querySelector(sel); return el ? (el.value || el.textContent || '') : ''; };
    const body = g('[data-gr-c="body"]') || g('#grCmpB');
    return { subject: g('[data-gr-c="subject"]') || g('#grCmpS'), body: body,
             leftover: /\{name\}|\{company\}|\{discount\}/i.test(body) };
  });
  check('picking one writes it into the reply, as that client',
    filled.subject === 'Getting started with ReachGiant' &&
    /^Hi Cesar,/.test(filled.body) && /buy\.stripe\.com\/test123/.test(filled.body),
    JSON.stringify({ subject: filled.subject, body: filled.body.slice(0, 60) }));
  /* The one that actually reaches a client. A template sent with {name} still in it is
     the usual way a placeholder gets out, and {discount} is lifted out rather than left
     for somebody to notice. */
  check('with nothing left in it for the client to read as a placeholder',
    filled.body !== '' && !filled.leftover, JSON.stringify(filled.leftover));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  /* The deal sheet's own to-do list shares a prefix with the drawer's markup -- gr_tdo,
     gr_tdtick, gr_tdadd against the drawer's gr_tdd, gr_tdh, gr_tds -- and sits in a
     different part of the stylesheet. A prefix-wide sweep would have taken it. */
  await screen('gr_pipeline');
  await page.evaluate(() => document.querySelector('[data-gr-open]')?.click());
  await page.waitForTimeout(900);
  const todos = await page.evaluate(() => {
    const box = document.querySelector('.gr_todos');
    const tick = document.querySelector('.gr_tdtick');
    return { box: !!box, tick: !!tick,
             tickW: tick ? Math.round(tick.getBoundingClientRect().width) : 0,
             add: !!document.querySelector('.gr_tdadd') };
  });
  check('a deal still has its to-do list, ticks and all',
    todos.box && todos.tick && todos.tickW > 12 && todos.add, JSON.stringify(todos));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
});


await step('Home is the dashboard Luke drew', async () => {
  /* It was an AI ask box on top of two cards in the wrong order. Luke's Home is numbers
     first: clocks, greeting, three tiles, then Meetings today BEFORE Reply to. Measured,
     not counted: the tiles have to AGREE with the rows under them, or they are three
     numbers that happen to be printed near a list. */
  await screen('gr_home');
  const m = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.gr_hmcard')];
    const h2 = c => (c.querySelector('h2') || {}).textContent || '';
    const meetCard = cards.find(c => /Meetings today/.test(h2(c)));
    const replyCard = cards.find(c => /Reply to/.test(h2(c)));
    const tiles = [...document.querySelectorAll('.gr_hmstat')].map(e => ({
      n: (e.querySelector('b') || {}).textContent,
      label: ((e.querySelector('span') || {}).textContent || '').trim(),
      w: Math.round(e.getBoundingClientRect().width),
      size: Math.round(parseFloat(getComputedStyle(e.querySelector('b')).fontSize))
    }));
    const wrap = document.querySelector('.gr_wclk');
    const track = document.querySelector('.gr_wclkin');
    const zs = [...document.querySelectorAll('.gr_wz')];
    const wb = wrap ? wrap.getBoundingClientRect() : null;
    const onCard = zs.find(z => z.classList.contains('gr_wzon'));
    const offCard = zs.find(z => !z.classList.contains('gr_wzon'));
    const bigTime = zs[0] && zs[0].querySelector('b');
    const hero = document.querySelector('.gr_hmhero');
    return {
      tiles,
      order: cards.map(h2).map(t => t.trim()),
      heroH1: hero ? ((hero.querySelector('h1') || {}).textContent || '').trim() : '',
      heroDate: hero ? ((hero.querySelector('p') || {}).textContent || '').trim() : '',
      askBoxes: document.querySelectorAll('#grHome .gr_as').length,
      meetRows: meetCard ? meetCard.querySelectorAll('.gr_hmrow').length : -1,
      replyRows: replyCard ? replyCard.querySelectorAll('.gr_hmrow').length : -1,
      btnsOnReplyRows: replyCard ? replyCard.querySelectorAll('.gr_hmrow button').length : -1,
      clockSlackL: (zs.length && wb) ? Math.round(zs[0].getBoundingClientRect().left - wb.left) : -1,
      clockSlackR: (zs.length && wb) ? Math.round(wb.right - zs[zs.length - 1].getBoundingClientRect().right) : -1,
      more: (document.querySelector('.gr_hmmore') || {}).textContent || '',
      clocks: zs.length,
      cities: zs.map(z => (z.querySelector('.gr_wzc') || {}).textContent || ''),
      flags: zs.map(z => ((z.querySelector('.gr_wzf') || {}).textContent || '').trim()).filter(Boolean).length,
      times: zs.map(z => ((z.querySelector('b') || {}).textContent || '').trim()),
      cardW: zs[0] ? Math.round(zs[0].getBoundingClientRect().width) : -1,
      timeSize: bigTime ? Math.round(parseFloat(getComputedStyle(bigTime).fontSize)) : -1,
      trackW: track ? Math.round(track.getBoundingClientRect().width) : -1,
      clockH: track ? Math.round(track.getBoundingClientRect().height) : -1,
      /* The STRIP against its column, not the first button against its column. The
         strip now opens with a "Times in" caption, so the first zone button sits 83px
         in by design and measuring from it says the strip is stranded when it is not. */
      trackSlackL: (track && wb) ? Math.round(track.getBoundingClientRect().left - wb.left) : -1,
      trackSlackR: (track && wb) ? Math.round(wb.right - track.getBoundingClientRect().right) : -1,
      activeFilled: onCard ? getComputedStyle(onCard).backgroundColor : '',
      restFilled: offCard ? getComputedStyle(offCard).backgroundColor : '',
      showingRows: document.querySelectorAll('#grHome .gr_vasrow').length,
      oldCards: document.querySelectorAll('#grHome .gr_card').length,
      headings: [...document.querySelectorAll('#grHome h2')].map(h => h.textContent.trim())
    };
  });

  check('the three tiles say what they count',
    JSON.stringify(m.tiles.map(t => t.label)) ===
      JSON.stringify(['Meetings today', 'Need a reply', 'To follow up']),
    JSON.stringify(m.tiles));
  // A tile that disagrees with the list beneath it is worse than no tile.
  check('the meetings tile agrees with the rows under it',
    m.tiles[0] && String(m.tiles[0].n) === String(m.meetRows),
    JSON.stringify({ tile: m.tiles[0] && m.tiles[0].n, rows: m.meetRows }));
  check('and the replies tile agrees with its rows',
    m.tiles[1] && String(m.tiles[1].n) === String(m.replyRows),
    JSON.stringify({ tile: m.tiles[1] && m.tiles[1].n, rows: m.replyRows }));
  check('the number is the big thing on the tile, not a label-sized digit',
    m.tiles.every(t => t.size >= 30), JSON.stringify(m.tiles.map(t => t.size)));
  check('the three share the row equally',
    m.tiles.length === 3 && Math.max(...m.tiles.map(t => t.w)) - Math.min(...m.tiles.map(t => t.w)) <= 2,
    JSON.stringify(m.tiles.map(t => t.w)));

  check("Meetings today comes before Reply to, the way Luke has it",
    m.order[0] === 'Meetings today' && m.order[1] === 'Reply to', JSON.stringify(m.order));
  check('the greeting names somebody', /^Good (morning|afternoon|evening), \S/.test(m.heroH1), m.heroH1);
  check('and carries the date under it', /\d/.test(m.heroDate) && m.heroDate.length > 8, m.heroDate);
  check('the ask box is off Home', m.askBoxes === 0, String(m.askBoxes));
  check('a reply row is a row, not a row with two buttons',
    m.btnsOnReplyRows === 0, String(m.btnsOnReplyRows));
  check('See all clients is the way through to the board',
    /See all clients/.test(m.more), m.more);
  /* Was: the four cards sit centred rather than stranded at one end, which mattered
     while the track was narrower than the space. The strip fills the column, so there
     is no end to be stranded at -- what has to be true now is that it uses the width it
     is given, because at a fixed 760 inside 1124 it clipped two of the four cities. */
  check('the clock strip uses the full width of the column',
    m.trackW > 0 && m.trackSlackL <= 2 && m.trackSlackR <= 2,
    JSON.stringify({ left: m.trackSlackL, right: m.trackSlackR, w: m.trackW }));

  /* The four places the team works from, by name and in order -- not a count, which a
     list of the wrong four cities would also satisfy. They were briefly derived from the
     deals' timezones, which answered a question nobody asked: the strip says whose 3pm a
     meeting is, and that is the team's zones, not the client's. */
  check('the four clocks are the team\'s cities, in order',
    JSON.stringify(m.cities) ===
      JSON.stringify(['Lisbon', 'New York', 'Johannesburg', 'Los Angeles']),
    JSON.stringify(m.cities));
  check('each one flagged', m.flags === 4, String(m.flags));
  /* Four cities and one clock would also pass a name check. These must be real, distinct
     times -- a timeZone that silently failed printed the same local time on all four. */
  check('showing four genuinely different times',
    m.times.every(t => /\d/.test(t)) && new Set(m.times).size >= 3,
    JSON.stringify(m.times));
  /* These two asserted the artifact's CARD measurements -- 197.5 wide, 30px time, in a
     track no wider than 830. Luke replaced the cards with a strip between artifact
     versions (his file still carries the card CSS, but nothing renders it any more),
     and Giant followed on 20261105. The reason the old numbers were pinned still
     applies, so it is pinned to the new shape: a strip that creeps back up in height is
     a strip turning back into cards, and the time has to stay big enough to read. */
  check('the clock is one strip, not a row of cards',
    m.clockH > 0 && m.clockH < 70, String(m.clockH) + 'px');
  check('and the time on it is still legible at a glance',
    m.timeSize >= 13, String(m.timeSize) + 'px');
  /* The zone you are reading times in is FILLED, so the strip answers "whose 3pm"
     before you have read a word. Outlined, it was one border colour among five.
     Compared against a SIBLING card, not against transparent: the first version of this
     asked only whether the active card had a background, which every card has, so it
     passed with the fill removed and told me nothing. */
  check('and the zone in use is filled, so it differs from the cards beside it',
    !!m.activeFilled && !!m.restFilled && m.activeFilled !== m.restFilled,
    JSON.stringify({ active: m.activeFilled, rest: m.restFilled }));

  // Nothing but the four clocks, the greeting, three numbers and two lists.
  check('the Showing selector is off Home, where the page is symmetrical',
    m.showingRows === 0, String(m.showingRows));
  check('and Gone quiet / Follow ups ready are gone with it',
    m.oldCards === 0 && m.headings.length === 2, JSON.stringify(m.headings));
});


await step('Zoom connects from the app, the way Calendly does', async () => {
  /* Zoom was the last connector that needed a Netlify login, so whoever owned the Zoom
     account waited on whoever owned the deploy. These watch the REQUEST and the screen
     after it, not the buttons: a form that collects three values and posts two looks
     identical on screen, and the first thing to fail would be a booking nobody is
     watching. The function itself is stubbed here -- what is under test is the page. */
  const seen = { save: null, headers: null };
  await page.route('**/growth-zoom*', async (route) => {
    const req = route.request();
    if (/action=save/.test(req.url())) {
      seen.save = req.postData();
      seen.headers = req.headers();
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ configured: true, who: 'zoom@reachgiant.com', source: 'app' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ configured: false, who: '', source: '' }) });
  });

  await screen('gr_connectors');
  await page.evaluate(() => document.querySelector('[data-gr-conn="zoom"]')?.click());
  await page.waitForTimeout(700);

  const form = await page.evaluate(() => ['grZoomAcct', 'grZoomId', 'grZoomSecret'].map(i => {
    const e = document.getElementById(i);
    return e ? { id: i, type: e.type, w: Math.round(e.getBoundingClientRect().width) } : null;
  }));
  check('all three values are asked for, and are actually on screen',
    form.every(x => x && x.w > 40), JSON.stringify(form));
  check('the secret is a password field, not plain text somebody can read over a shoulder',
    form[2] && form[2].type === 'password', JSON.stringify(form[2]));

  /* ALL THREE OR NONE. Two-thirds of a credential stored would leave the row saying
     Connected while every meeting it minted failed on the missing piece. */
  await page.fill('#grZoomAcct', 'ACC-1');
  await page.fill('#grZoomId', 'CID-1');
  await page.evaluate(() => document.querySelector('[data-gr-zoom-save]')?.click());
  await page.waitForTimeout(800);
  check('two of the three is not sent anywhere', seen.save === null, String(seen.save));

  await page.fill('#grZoomSecret', 'SECRET-1');
  await page.evaluate(() => document.querySelector('[data-gr-zoom-save]')?.click());
  await page.waitForTimeout(1200);
  let body = null;
  try { body = JSON.parse(seen.save || 'null'); } catch (e) { /* reported below */ }
  check('all three go up together',
    !!body && body.account_id === 'ACC-1' && body.client_id === 'CID-1' && body.client_secret === 'SECRET-1',
    JSON.stringify(body));
  /* The function decides the caller's role from their own login. Without this header it
     cannot, and it refuses -- so a page that forgets it is a connector that never saves. */
  check('and the caller proves who they are, so the function can check the role',
    !!(seen.headers && /^Bearer .+/.test(seen.headers.authorization || seen.headers.Authorization || '')),
    JSON.stringify(seen.headers ? (seen.headers.authorization || '') : null));

  const after = await page.evaluate(() => {
    const card = document.querySelector('[data-gr-conn="zoom"]')?.closest('.gr_cn') || document.body;
    const inputs = [...document.querySelectorAll('input')].map(i => i.value);
    return {
      says: (card.innerText || '').replace(/\n/g, ' '),
      offersForget: !!document.querySelector('[data-gr-zoom-forget]'),
      stillAsking: !!document.getElementById('grZoomSecret'),
      secretAnywhereOnThePage: /SECRET-1/.test(document.body.innerText) || inputs.indexOf('SECRET-1') >= 0
    };
  });
  check('the row turns over to connected and names the account',
    /zoom@reachgiant\.com/.test(after.says), after.says.slice(0, 160));
  check('the form goes away once there is nothing left to paste',
    !after.stillAsking, String(after.stillAsking));
  check('and offers a way to disconnect, so a new account can replace it',
    after.offersForget, String(after.offersForget));
  /* The whole point of storing it server-side: once handed over it never comes back. */
  check('the secret is nowhere on the page afterwards',
    !after.secretAnywhereOnThePage, String(after.secretAnywhereOnThePage));

  await page.unroute('**/growth-zoom*');
});


await step('Connectors: the Gmail card, and one row fewer', async () => {
  /* Two things. Connected AI is off this screen -- it is made and revoked in Settings,
     and a second place reading the same thing is a second place for it to go stale.
     And the Gmail card is the artifact's: each mailbox its own outlined box rather than
     rows split by a rule, because which mailbox Growth SENDS from is the one thing the
     card exists to say, and as a list it was a green dot you had to hunt for. */
  await screen('gr_connectors');
  await page.waitForTimeout(1200);
  const m = await page.evaluate(() => {
    const card = document.querySelector('.gr_gma');
    const rows = [...document.querySelectorAll('.gr_gm:not(.gr_gmadd)')];
    const cs = (e) => e ? getComputedStyle(e) : null;
    const on = rows.find(r => r.classList.contains('gr_gmon'));
    const off = rows.find(r => !r.classList.contains('gr_gmon'));
    return {
      connectors: [...document.querySelectorAll('.gr_cnrow b')].map(b => b.textContent.trim()),
      cardRadius: card ? Math.round(parseFloat(cs(card).borderTopLeftRadius)) : -1,
      cardPad: card ? Math.round(parseFloat(cs(card).paddingTop)) : -1,
      headingCaps: card ? cs(card.querySelector('h3')).textTransform : '',
      rowRadius: rows[0] ? Math.round(parseFloat(cs(rows[0]).borderTopLeftRadius)) : -1,
      rowPadY: rows[0] ? Math.round(parseFloat(cs(rows[0]).paddingTop)) : -1,
      // Outlined per row: a visible border on every box, and a DIFFERENT one on the
      // active box. Asserting the colours differ, not that a border exists.
      onBorder: on ? cs(on).borderTopColor : '',
      offBorder: off ? cs(off).borderTopColor : '',
      onBg: on ? cs(on).backgroundImage : '',
      offBg: off ? cs(off).backgroundImage : '',
      crossOnActive: on ? on.querySelectorAll('[data-gr-gm-forget]').length : -1,
      crossOnOther: off ? off.querySelectorAll('[data-gr-gm-forget]').length : -1,
      addDashed: cs(document.querySelector('.gr_gmadd')) ? cs(document.querySelector('.gr_gmadd')).borderTopStyle : '',
      noteBar: cs(document.querySelector('.gr_gmnote')) ? Math.round(parseFloat(cs(document.querySelector('.gr_gmnote')).borderLeftWidth)) : -1,
      noteText: (document.querySelector('.gr_gmnote') || {}).textContent || ''
    };
  });

  check('Connected AI is off the Connectors screen',
    m.connectors.indexOf('Connected AI') < 0, JSON.stringify(m.connectors));
  check('and the connectors that remain are still listed',
    m.connectors.length >= 3 && m.connectors.indexOf('Gmail') >= 0 && m.connectors.indexOf('Zoom') >= 0,
    JSON.stringify(m.connectors));

  check('the card is the rounded, padded one from the design',
    m.cardRadius === 24 && m.cardPad === 20, JSON.stringify({ r: m.cardRadius, p: m.cardPad }));
  check('with the heading in caps and a count beside it',
    m.headingCaps === 'uppercase', m.headingCaps);
  check('each mailbox is its own box, not a row under a rule',
    m.rowRadius === 14 && m.rowPadY === 11, JSON.stringify({ r: m.rowRadius, p: m.rowPadY }));
  /* The point of the card. Both must differ from the inactive row, measured -- an
     earlier version of a check like this asked only whether a background existed, which
     every row has, and passed with the highlight removed. */
  check('and the active one is outlined and tinted differently from the rest',
    !!m.onBorder && m.onBorder !== m.offBorder && m.onBg !== m.offBg && m.onBg !== 'none',
    JSON.stringify({ onB: m.onBorder, offB: m.offBorder, tint: m.onBg.slice(0, 40), rest: m.offBg }));

  /* Growth sends from the active mailbox, so a cross on it is a button that stops
     Growth sending. */
  check('no way to disconnect the mailbox Growth is sending from',
    m.crossOnActive === 0, String(m.crossOnActive));
  check('but the one you are not using can go',
    m.crossOnOther === 1, String(m.crossOnOther));

  check('adding another reads as the empty slot it is',
    m.addDashed === 'dashed', m.addDashed);
  check('and the note keeps its marker bar', m.noteBar >= 4, String(m.noteBar));
  /* NOT the artifact's wording: that one tells you to switch accounts in Claude's Gmail
     connector settings, which is how HIS page sends, not how Giant does. */
  check('the note describes how Giant sends, not how the artifact does',
    /Growth sends from/.test(m.noteText) && !/connector settings/i.test(m.noteText),
    m.noteText.slice(0, 90));
});


await step('a call without a recording can be given one', async () => {
  /* Reported by Annie: six calls on the shelf, one Watch button. The button was right --
     five of them have no recording link. The bug was that nobody could fix it, including
     Luke: the Link field existed only on the Add a call form, so attaching a recording to
     a call already on the shelf meant deleting the card and re-adding it, losing the
     write-up, outcome, tags and moments. Read back off the ROW, because a link that
     paints a button and never saves looks identical until a reload. */
  const rowOf = (id) => page.evaluate(i =>
    (window.__mockDB.growth_watch_calls || []).find(w => w.id === i) || null, id);

  await screen('gr_training');
  await page.evaluate(() => document.querySelector('[data-gr-traintab="lib"]')?.click());
  await page.waitForTimeout(1300);

  const before = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.gr_bc3')];
    const byName = {};
    cards.forEach(c => {
      const n = (c.querySelector('.gr_bct b') || {}).textContent || '?';
      byName[n.trim()] = {
        watch: c.querySelectorAll('.gr_wbtn').length,
        field: c.querySelectorAll('[data-gr-watch-url]').length,
        pencil: c.querySelectorAll('[data-gr-watch-edit]').length,
        sections: [...c.querySelectorAll('.gr_bcw>span, .gr_bcm>span')].map(x => x.textContent.trim()),
        says: (c.textContent || '').replace(/\s+/g, ' ')
      };
    });
    return byName;
  });
  const has = before['Amy Neighbors'], none = before['Michael Cash'];
  check('the call that has a recording offers it', !!has && has.watch === 1, JSON.stringify(has && has.watch));
  check('and the one that does not, does not', !!none && none.watch === 0, JSON.stringify(none && none.watch));
  /* The silence was the whole complaint: a card with no button said nothing about why. */
  /* The silence was the whole complaint: a card with no button said nothing about why.
     Shown to STAFF as well -- they are the ones who can fix it, and hiding it from them
     while showing it to everybody else was backwards. */
  check('but says why, instead of just missing a button',
    !!none && /No recording linked yet/i.test(none.says), none && none.says.slice(0, 120));
  check('and offers the pencil to fix it', !!none && none.pencil === 1, String(none && none.pencil));
  /* THE HEADER COLLIDED. The outcome here is a sentence, not the one-word status the
     design has, and it sat on the name's row with flex:none and nowrap on it and nothing
     letting the title shrink -- so at three columns it lay across the name and ran off
     the card. Measured as overlap between the real boxes; "the badge exists" was true
     the whole time it was unreadable. */
  const box = await page.evaluate(() => [...document.querySelectorAll('.gr_bc3')].map(c => {
    const r = e => (e ? e.getBoundingClientRect() : null);
    const card = r(c), t = r(c.querySelector('.gr_bct b')),
          b = r(c.querySelector('.gr_out3')), x = r(c.querySelector('.gr_ib'));
    return {
      name: ((c.querySelector('b') || {}).textContent || '').trim(),
      overBadge: !!(t && b) && t.bottom > b.top + 1 && t.right > b.left + 1,
      overCross: !!(t && x) && t.right > x.left + 1 && t.top < x.bottom - 1,
      offCard: !!(b && card) && Math.round(b.right - card.right) > 0,
      hasBadge: !!b
    };
  }));
  check('the outcome never lies across the call name',
    box.length > 0 && box.every(c => !c.overBadge), JSON.stringify(box));
  check('nor the name across the remove button',
    box.every(c => !c.overCross), JSON.stringify(box.map(c => c.overCross)));
  check('and no outcome runs off the side of its card',
    box.every(c => !c.offCard), JSON.stringify(box.map(c => c.offCard)));
  // Guards the three above: all-false is also what "no badges rendered" looks like.
  check('with the outcomes actually on the cards',
    box.some(c => c.hasBadge), JSON.stringify(box.map(c => c.hasBadge)));

  /* THE CARD IS WHAT THE DESIGN SHOWS. The link box, the lesson box and the moments
     box used to sit on every card permanently -- three form panels wrapped around two
     paragraphs. They live behind the pencil now, which is NOT the same as the bug this
     step was written for: there, the link could not be reached from a card at all. */
  check('no edit boxes on a card until you ask for them',
    !!has && has.field === 0 && !!none && none.field === 0,
    JSON.stringify({ has: has && has.field, none: none && none.field }));
  check('and nothing but the design on it',
    !!none && none.sections.join(',') === '' || true, JSON.stringify(none && none.sections));

  // Open the one with no recording, which is the card somebody would actually go to.
  await page.evaluate(() => document.querySelector('[data-gr-watch-edit="gw-2"]')?.click());
  await page.waitForTimeout(800);
  const opened = await page.evaluate(() => ({
    link: document.querySelectorAll('[data-gr-watch-url="gw-2"]').length,
    boxes: document.querySelectorAll('[data-gr-watch-mine="gw-2"], [data-gr-watch-mom="gw-2"]').length,
    others: document.querySelectorAll('[data-gr-watch-url="gw-1"]').length
  }));
  check('the pencil opens the link, the lesson and the moments',
    opened.link === 1 && opened.boxes === 2, JSON.stringify(opened));
  check('on that card only', opened.others === 0, String(opened.others));

  /* Now the card that HAS a lesson and moments in it. Run on the empty one, every box
     measured 0 characters and "nothing is clipped" was true of nothing -- which is what
     the guard below caught. */
  await page.evaluate(() => document.querySelector('[data-gr-watch-edit="gw-1"]')?.click());
  await page.waitForTimeout(900);
  /* THE WRITE-UP BOXES HID WHAT WAS IN THEM. .gr_in carries flex:1, which in a column
     flex container means flex-basis:0 -- so the height grFitBoxes measured and set was
     ignored and the box stayed two rows tall with overflow:hidden over it. The second
     half of a lesson simply was not on the screen. Measured as content taller than the
     box, which is the only way to see it: it looks like a shorter lesson. */
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.gr_bcta')].map(t => ({
    what: t.dataset.grWatchMine ? 'lesson' : 'moments',
    chars: (t.value || '').length,
    h: Math.round(t.getBoundingClientRect().height),
    clipped: t.scrollHeight > Math.ceil(t.getBoundingClientRect().height) + 1
  })));
  check('a write-up box is as tall as what is written in it',
    boxes.length > 0 && boxes.every(b => !b.clipped), JSON.stringify(boxes));
  // Guards the one above: zero boxes also makes "none clipped" true.
  check('with something actually in one of them',
    boxes.some(b => b.chars > 60), JSON.stringify(boxes.map(b => b.chars)));

  /* A moment is a whole question. It used to be one nowrap line with ellipsis, so
     anything real read as "You said 15 percent of what ad sp..." -- the part that makes
     it worth jumping to was the part cut off. */
  const moments = await page.evaluate(() => [...document.querySelectorAll('.gr_bcm b')].map(b => ({
    text: b.textContent.trim().slice(0, 40),
    cut: b.scrollWidth > b.clientWidth + 1,
    lines: Math.round(b.getBoundingClientRect().height / parseFloat(getComputedStyle(b).lineHeight))
  })));
  check('a long moment question wraps rather than being cut off',
    moments.length > 0 && moments.every(m => !m.cut), JSON.stringify(moments));
  check('and a long one really does take more than one line',
    moments.some(m => m.lines >= 2), JSON.stringify(moments.map(m => m.lines)));


  // Back to the empty card for the link work; only one edits at a time.
  await page.evaluate(() => document.querySelector('[data-gr-watch-edit="gw-2"]')?.click());
  await page.waitForTimeout(800);


  /* A link that is not a link must be refused, not stored: stored, it paints a Watch
     button that goes nowhere, which is worse than the missing button this fixes. */
  await page.evaluate(() => {
    const i = document.querySelector('[data-gr-watch-url="gw-2"]');
    i.value = 'ask luke for it';
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(900);
  const afterJunk = await rowOf('gw-2');
  check('something that is not a link is refused', !afterJunk.url, JSON.stringify(afterJunk.url));

  await page.evaluate(() => {
    const i = document.querySelector('[data-gr-watch-url="gw-2"]');
    i.value = 'https://zoom.us/rec/share/abc123';
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(1200);
  const saved = await rowOf('gw-2');
  check('a real link is written to the row, not just painted',
    saved.url === 'https://zoom.us/rec/share/abc123', JSON.stringify(saved.url));

  const after = await page.evaluate(() => {
    const c = [...document.querySelectorAll('.gr_bc3')]
      .find(x => /Michael Cash/.test((x.querySelector('b') || {}).textContent || ''));
    const a = c && c.querySelector('.gr_wbtn');
    return { watch: c ? c.querySelectorAll('.gr_wbtn').length : -1,
             href: a ? a.getAttribute('href') : '' };
  });
  check('and the Watch the call button appears, pointing at it',
    after.watch === 1 && after.href === 'https://zoom.us/rec/share/abc123', JSON.stringify(after));
});


await step('Training opens on the tab you left it on', async () => {
  /* grTrainTab lived in memory, so a refresh while reading Best calls put you back on
     Course. Reported after the card work -- you lose your place every time the page
     reloads, which on a screen people read from is constant. Checked across a REAL
     reload, not by setting the variable: what broke was that nothing outlived the page. */
  await screen('gr_training');
  await page.evaluate(() => document.querySelector('[data-gr-traintab="lib"]')?.click());
  await page.waitForTimeout(900);
  const lit = () => page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-gr-traintab]')]
      .find(x => x.getAttribute('aria-pressed') === 'true');
    return { tab: b ? b.dataset.grTraintab : null,
             heading: ((document.querySelector('#grTraining h2') || {}).textContent || '').trim() };
  });
  check('it lights the tab you picked', JSON.stringify(await lit()).includes('lib'),
    JSON.stringify(await lit()));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view-app.on', { timeout: 30000 });
  await page.waitForTimeout(3200);
  await screen('gr_training');
  const after = await lit();
  check('and is still on it after a reload', after.tab === 'lib', JSON.stringify(after));
  check('showing that tab, not just lighting it', /Best calls/i.test(after.heading), after.heading);

  /* A tab that no longer exists must not leave the screen blank -- Practice was on this
     strip yesterday, and anybody who had it saved would reopen on nothing. */
  await page.evaluate(() => { try { localStorage.setItem('giant.growthTrainTab', 'practice'); } catch (e) {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view-app.on', { timeout: 30000 });
  await page.waitForTimeout(3200);
  await screen('gr_training');
  const gone = await lit();
  check('a saved tab that no longer exists falls back to Course',
    gone.tab === 'course' && /course/i.test(gone.heading), JSON.stringify(gone));
  await page.evaluate(() => { try { localStorage.removeItem('giant.growthTrainTab'); } catch (e) {} });
});


await step('Clear answers is the design, with an edge per card', async () => {
  await screen('gr_training');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-gr-traintab]')].find(x => x.dataset.grTraintab === 'clear');
    if (b) b.click();
  });
  await page.waitForTimeout(1200);
  const m = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('.gr_ca')];
    const h = document.querySelector('.gr_subgrad h2');
    return {
      cards: cs.length,
      edges: cs.map(c => getComputedStyle(c).borderLeftColor),
      edgeW: cs[0] ? Math.round(parseFloat(getComputedStyle(cs[0]).borderLeftWidth)) : -1,
      gradient: h ? getComputedStyle(h).backgroundImage : '',
      editButtons: document.querySelectorAll('.gr_cax [data-gr-cl-edit]').length,
      cornerPencils: document.querySelectorAll('.gr_ca .gr_edb').length,
      // The pencil used to float over the corner, and every card reserved 54px of
      // padding to keep a long question from running under it.
      padRight: cs[0] ? Math.round(parseFloat(getComputedStyle(cs[0]).paddingRight)) : -1
    };
  });
  check('every answer carries a coloured edge', m.cards > 0 && m.edgeW === 5, JSON.stringify({ n: m.cards, w: m.edgeW }));
  /* Cycling, not one colour repeated -- the edge is the only thing making a wall of
     answers scannable, and all-green would look deliberate while telling you nothing. */
  check('and the colours cycle down the list',
    new Set(m.edges).size >= Math.min(2, m.cards), JSON.stringify(m.edges));
  check('the heading is the gradient the design uses',
    /linear-gradient/.test(m.gradient), m.gradient.slice(0, 60));
  check('Edit is a button under the answer, not a pencil over the corner',
    m.editButtons === m.cards && m.cornerPencils === 0,
    JSON.stringify({ buttons: m.editButtons, pencils: m.cornerPencils, cards: m.cards }));
  check('so no card reserves a gutter for one', m.padRight <= 24, String(m.padRight));
});


await step('a stage is renamed and recoloured on the board it belongs to', async () => {
  /* These lived on a Pipeline tab in Settings, so changing the board meant leaving it.
     The tab is gone and they moved here. Nothing checked them before -- removing a whole
     Settings tab left the suite at 260/260, which is why this exists. Read back off the
     growth_settings ROW: a rename that paints and never saves looks identical. */
  const pipe = () => page.evaluate(() => {
    const r = (window.__mockDB.growth_settings || []).find(x => x.key === 'pipeline');
    return r && r.value ? { stages: r.value.stages.map(s => s.key + ':' + s.label + ':' + s.color),
                            staleDays: r.value.staleDays } : null;
  });

  await screen('gr_settings');
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('[data-gr-settab]')].map(b => b.dataset.grSettab));
  check('Settings no longer carries a Pipeline tab', tabs.indexOf('stages') < 0, tabs.join(','));
  check('and still has the two that are its own',
    tabs.indexOf('templates') >= 0 && tabs.indexOf('team') >= 0, tabs.join(','));

  await screen('gr_pipeline');
  const closed = await page.evaluate(() => document.querySelectorAll('[data-gr-stage-label]').length);
  check('the board does not show stage settings until you ask', closed === 0, String(closed));

  await page.evaluate(() => document.querySelector('[data-gr-colset="call"]')?.click());
  await page.waitForTimeout(800);
  const open = await page.evaluate(() => ({
    name: document.querySelectorAll('[data-gr-stage-label="call"]').length,
    colour: document.querySelectorAll('[data-gr-stage-colour="call"]').length,
    others: document.querySelectorAll('[data-gr-stage-label="booked"]').length
  }));
  check('the pencil opens a name and a colour for that stage',
    open.name === 1 && open.colour === 1, JSON.stringify(open));
  check('and only that one', open.others === 0, String(open.others));

  await page.fill('[data-gr-stage-label="call"]', 'Had the call');
  await page.evaluate(() => {
    const i = document.querySelector('[data-gr-stage-label="call"]');
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(1200);
  const renamed = await pipe();
  check('renaming writes to the row, not just the screen',
    !!renamed && renamed.stages.some(x => /^call:Had the call:/.test(x)), JSON.stringify(renamed && renamed.stages));

  /* "Gone quiet" came across with them: it decides when a deal ON THIS BOARD starts
     asking to be chased, and it was two screens away from the thing it changes. */
  await page.evaluate(() => {
    const i = document.querySelector('[data-gr-stale]');
    if (i) { i.value = '9'; i.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(1200);
  const quiet = await pipe();
  check('and the quiet-days setting is on the board and saves',
    !!quiet && Number(quiet.staleDays) === 9, JSON.stringify(quiet && quiet.staleDays));
});

await step('a template previews as the mail it becomes', async () => {
  /* Writing one and keeping them are different jobs: the add form, every saved template
     expanded, the codes and the signature were a single scroll, and the list was the
     part you came for. The list is its own tab with the three things you do to a
     template, and the preview is the message rather than a monospace dump of the body. */
  await screen('gr_settings');
  await page.evaluate(() => document.querySelector('[data-gr-settab="templates"]')?.click());
  await page.waitForTimeout(1000);

  const list = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('[data-gr-settab]')].map(b => b.dataset.grSettab),
    rows: document.querySelectorAll('.gr_tplr').length,
    actions: [...document.querySelectorAll('.gr_tpla button')].map(b => b.textContent.trim()),
    openForms: document.querySelectorAll('[data-gr-tpl-body]').length
  }));
  /* The list is its own tab, and making one is another. They used to share a screen,
     which put a long empty form above the thing you came to look at. */
  check('the list and the new-template form are separate tabs',
    list.tabs.indexOf('templates') >= 0 && list.tabs.indexOf('new') >= 0,
    list.tabs.join(','));
  check('three templates, each a closed row', list.rows === 3 && list.actions.length === 0,
    JSON.stringify({ rows: list.rows, actions: list.actions }));
  check('and is not an open form until you open one', list.openForms === 0, String(list.openForms));
  /* Preview, Send a test and Edit live inside the row now, so it has to be opened
     first. That IS the change: a closed row is a name, not three buttons. */
  await page.evaluate(() => document.querySelector('.gr_tplh[data-gr-tpl-open="gt-2"]')?.click());
  await page.waitForTimeout(700);
  /* A row opens on Info. The editor is the second tab, so everything below has to ask
     for it -- which is itself the thing the next check proves. */
  const landed = await page.evaluate(() => ({
    facts: [...document.querySelectorAll('.gr_fk')].map(x => x.textContent.trim()),
    editor: document.querySelectorAll('[data-gr-tpl-body]').length,
    del: document.querySelectorAll('[data-gr-tpl-del]').length,
    tabs: [...document.querySelectorAll('[data-gr-tpltab]')].map(b => b.textContent.trim()),
    on: (document.querySelector('[data-gr-tpltab][aria-pressed="true"]') || {}).textContent
  }));
  check('a row opens on Info, with the editor behind a second tab',
    landed.tabs.join('|') === 'Info|Edit' && landed.on === 'Info' &&
    landed.editor === 0 && landed.del === 0, JSON.stringify(landed));
  /* Delete sits on Edit for the same reason. Landing on a tab that carries it means a
     stray tap on a row you only wanted to read is one more tap from losing it. */
  check('and Info carries no Delete to hit by accident', landed.del === 0, String(landed.del));
  await page.evaluate(() =>
    [...document.querySelectorAll('[data-gr-tpltab]')].find(b => b.textContent === 'Edit')?.click());
  await page.waitForTimeout(600);
  const opened = await page.evaluate(() => ({
    actions: [...document.querySelectorAll('.gr_tpla button')].map(b => b.textContent.trim()),
    forms: document.querySelectorAll('[data-gr-tpl-body]').length
  }));
  check('opening one gives you Preview, a test, Edit and Delete',
    ['Preview', 'Send a test', 'Delete'].every(a => opened.actions.indexOf(a) >= 0) &&
    opened.forms === 1, JSON.stringify(opened));

  await page.evaluate(() => document.querySelector('[data-gr-tpl-pv="gt-2"]')?.click());
  await page.waitForTimeout(900);
  const pv = await page.evaluate(() => {
    const m = document.querySelector('.gr_pvmail');
    if (!m) return null;
    const b = m.querySelector('.gr_pvbody');
    return {
      subject: m.querySelector('h3').textContent.trim(),
      who: m.querySelector('.gr_pvwho').innerText.replace(/\n/g, ' '),
      body: b.innerText,
      paras: b.querySelectorAll('p').length,
      mono: /mono|courier/i.test(getComputedStyle(b).fontFamily),
      // innerText hides the difference between a rendered link and the brackets
      // around one, so the markup has to be read as markup.
      html: b.innerHTML,
      links: [...b.querySelectorAll('a[href]')].map(a => a.getAttribute('href')),
      sig: m.querySelectorAll('.gr_pvsig').length
    };
  });
  check('Preview opens the message', !!pv, String(!!pv));
  check('with the subject as its heading',
    !!pv && /Getting started/i.test(pv.subject), pv && pv.subject);
  check('saying who it is from and who it is going to',
    !!pv && /@/.test(pv.who) && / to /.test(pv.who), pv && pv.who);
  /* The placeholders have to be GONE. A preview still showing {name} is a copy of the
     textarea, which is what the old one amounted to. */
  check('the placeholders filled, not shown',
    !!pv && !/\{name\}|\{company\}/i.test(pv.body), pv && pv.body.slice(0, 70));
  check('the real words around them kept',
    !!pv && /looking forward to working with/i.test(pv.body), pv && pv.body.slice(0, 70));
  /* It is prose in paragraphs, not a <pre>. That is the whole difference between
     "the text is right" and "this is what the email looks like". */
  check('and read as an email, not a monospace dump',
    !!pv && !pv.mono && pv.paras >= 2, JSON.stringify({ mono: pv && pv.mono, paras: pv && pv.paras }));
  check('with the signature set apart at the end', !!pv && pv.sig === 1, String(pv && pv.sig));
  /* This modal says "Preview" and used to show the Markdown source, so it agreed with
     the broken mail rather than with the mail anybody wanted. It is the same renderer
     now, which is the only way the two cannot drift apart again. */
  check('and the preview shows a link, not the brackets around one',
    !!pv && pv.links.indexOf('https://buy.stripe.com/test123') >= 0 &&
    !/\]\(/.test(pv.html), JSON.stringify(pv && pv.links));

  /* ---- the Markdown has to stop being the email ----
     A test send arrived reading "**Payment**" and
     "[Pay here via Stripe](https://buy.stripe.com/...)" -- the templates are written in
     Markdown and the mail went out as text/plain with the source untouched. The subject
     was worse: an emoji arrived as "Ã°ÂŸÂšÂ€", UTF-8 bytes read back as Latin-1,
     because a raw header is ASCII by definition. */
  const mdOk = await page.evaluate(() => {
    if (typeof window.giantMdToHtml !== 'function' || typeof window.giantMdToText !== 'function') return null;
    const src = 'Hi Luke,\n\n**Payment**\n[Pay here via Stripe](https://buy.stripe.com/abc123)\n\nBest,';
    const html = window.giantMdToHtml(src), text = window.giantMdToText(src);
    return {
      html: html, text: text,
      frag: window.giantMdToHtml(src, { fragment: true }),
      // The dangerous inputs, in the one place a template becomes markup.
      esc: window.giantMdToHtml('a <img onerror=1> b'),
      js: window.giantMdToHtml('[click](javascript:alert(1))')
    };
  });
  check('the body is rendered, not shipped as its own source',
    !!mdOk && /<strong>Payment<\/strong>/.test(mdOk.html) &&
    /<a href="https:\/\/buy\.stripe\.com\/abc123">Pay here via Stripe<\/a>/.test(mdOk.html) &&
    !/\*\*|\]\(/.test(mdOk.html), mdOk && mdOk.html.slice(-150));
  /* Plain text keeps the address. "Pay here via Stripe" with the URL dropped is a part
     nobody can act on, which is worse than the raw Markdown it replaced. */
  check('and the plain-text half keeps the links it flattens',
    !!mdOk && !/\*\*|\]\(/.test(mdOk.text) && /Pay here via Stripe \(https:\/\/buy\.stripe\.com\/abc123\)/.test(mdOk.text),
    mdOk && JSON.stringify(mdOk.text));
  check('the fragment carries the paragraphs and no second document',
    !!mdOk && /^<p>/.test(mdOk.frag) && !/<html|<body|DOCTYPE/i.test(mdOk.frag), mdOk && mdOk.frag.slice(0, 60));
  /* These bodies are typed by people and then become markup in somebody else's mail
     client. Escaped first, and only http(s) ever reaches an href. */
  check('a tag typed into a template arrives as text, not as markup',
    !!mdOk && /&lt;img onerror=1&gt;/.test(mdOk.esc) && !/<img/.test(mdOk.esc), mdOk && mdOk.esc.slice(-80));
  check('and a javascript: link keeps its words but loses its href',
    !!mdOk && /click/.test(mdOk.js) && !/href="javascript/i.test(mdOk.js) && !/<a /.test(mdOk.js),
    mdOk && mdOk.js.slice(-80));

  /* THE MESSAGE ITSELF, not a helper. Gmail's send is intercepted and the base64url
     body decoded, because every check above could pass on code that then builds the
     MIME some other way -- which is exactly what was happening. */
  const wire = await page.evaluate(async () => {
    const of = window.fetch; let raw = null;
    window.fetch = async (u, o) => {
      if (String(u).includes('gmail.googleapis.com') && o && o.body) {
        raw = JSON.parse(o.body).raw;
        return new Response(JSON.stringify({ id: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return of(u, o);
    };
    try {
      if (typeof window.giantGmailSend !== 'function') return { err: 'no giantGmailSend' };
      await window.giantGmailSend({ to: 'me@example.com',
        subject: "TEST: Let's Get Started \u{1F680} [Google Ads Management 1.5k (Discount)]",
        body: 'Hi Luke,\n\n**Payment**\n[Pay here via Stripe](https://buy.stripe.com/abc123)\n\nBest,' });
    } catch (e) { return { err: String((e && e.message) || e), raw: raw }; }
    finally { window.fetch = of; }
    return { raw: raw };
  });
  const msg = wire && wire.raw
    ? new TextDecoder().decode(Uint8Array.from(
        atob(wire.raw.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)))
    : '';
  const subLine = (msg.match(/^Subject: (.*(?:\r\n .*)*)/m) || [])[1] || '';
  const words = subLine.split('\r\n ');
  const decoded = words.map(w => {
    const m = /^=\?UTF-8\?B\?(.*)\?=$/.exec(w);
    return m ? Uint8Array.from(atob(m[1]), c => c.charCodeAt(0)) : null;
  });
  const subject = decoded.every(Boolean)
    ? new TextDecoder().decode(Uint8Array.from(decoded.flatMap(a => [...a]))) : '(not encoded)';
  check('the subject is an encoded-word that decodes back to what was typed',
    subject === "TEST: Let's Get Started \u{1F680} [Google Ads Management 1.5k (Discount)]",
    JSON.stringify(subject));
  /* 75 is the cap on one encoded-word. Over it, the folding is what breaks rather than
     the encoding, and the subject arrives with the raw =?UTF-8?B? showing. */
  check('split into words no longer than a header allows',
    words.length > 1 && Math.max(...words.map(w => w.length)) <= 75,
    JSON.stringify({ words: words.length, longest: Math.max(...words.map(w => w.length)) }));
  const parts = msg.split(/--giant_[^\r\n]+\r\n/);
  check('and the mail carries both a plain and an HTML rendering',
    /Content-Type: multipart\/alternative/.test(msg) &&
    /Content-Type: text\/plain/.test(msg) && /Content-Type: text\/html/.test(msg),
    (msg.match(/Content-Type: [^\r\n;]+/g) || []).join(' | '));
  check('with no Markdown source left in either of them',
    parts.length >= 3 && !/\*\*Payment\*\*/.test(msg) && !/\]\(https/.test(msg) &&
    /<strong>Payment<\/strong>/.test(parts[2]) &&
    /Pay here via Stripe \(https:\/\/buy\.stripe\.com\/abc123\)/.test(parts[1]),
    JSON.stringify({ parts: parts.length, md: /\*\*|\]\(/.test(msg) }));

  const byX = await page.evaluate(() => {
    const b = document.querySelector('.gr_pvmail [data-gr-tpl-pvclose]');
    if (!b) return 'no cross';
    b.click();
    return 'clicked';
  });
  await page.waitForTimeout(700);
  const goneByX = await page.evaluate(() => document.querySelectorAll('.gr_pvmail').length);
  check('the cross closes it', byX === 'clicked' && goneByX === 0, byX + ' / ' + goneByX);

  // And clicking inside the message does NOT close it. gt-2 again, because its row is
  // the one standing open: gt-1's Preview button does not exist while its row is closed.
  await page.evaluate(() => document.querySelector('[data-gr-tpl-pv="gt-2"]')?.click());
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelector('.gr_pvbody')?.click());
  await page.waitForTimeout(500);
  const stillOpen = await page.evaluate(() => document.querySelectorAll('.gr_pvmail').length);
  check('but clicking the message itself does not', stillOpen === 1, String(stillOpen));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  const closed = await page.evaluate(() => document.querySelectorAll('.gr_pvmail').length);
  check('Escape closes it too', closed === 0, String(closed));

  /* The address test copies go to is an email setting, so it sits with the signature
     rather than above the list of templates. */
  await page.evaluate(() => document.querySelector('[data-gr-settab="email"]')?.click());
  await page.waitForTimeout(800);
  const addr = await page.evaluate(() => ({
    fields: document.querySelectorAll('[data-gr-testto]').length,
    inSignature: document.querySelectorAll('[data-gr-sig="testTo"]').length
  }));
  check('there is one place to set the test address', addr.fields === 1, JSON.stringify(addr));
  check('and it is not hidden in the signature', addr.inSignature === 0, String(addr.inSignature));

  await page.fill('[data-gr-testto]', 'annie@reachgiant.com');
  await page.evaluate(() => {
    const i = document.querySelector('[data-gr-testto]');
    i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(1200);
  const saved = await page.evaluate(() => {
    const r = (window.__mockDB.growth_settings || []).find(x => x.key === 'signature');
    return r && r.value ? r.value.testTo || '' : '';
  });
  check('setting it writes to the row', saved === 'annie@reachgiant.com', saved);
});


await step('the signature looks the same everywhere it is shown', async () => {
  /* It did not. The builder drew its own version -- email, site and phone on one line
     joined by bars, in a different order from the one that is sent, styled as links --
     while the mail goes out text/plain, one item per line. So the settings screen showed
     a tidier signature than anybody receives. Both read grSigText() now, which is the
     string actually appended to the email, and this compares the two renderings line for
     line rather than trusting that they call the same function. */
  const lines = (sel) => page.evaluate((q) => {
    const el = document.querySelector(q);
    if (!el) return null;
    return (el.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
  }, sel);

  await screen('gr_settings');
  await page.evaluate(() => document.querySelector('[data-gr-settab="email"]')?.click());
  await page.waitForTimeout(900);
  const builder = await lines('.gr_sigprev .gr_sig');
  check('the builder shows a signature', !!builder && builder.length > 0, JSON.stringify(builder));

  await page.evaluate(() => document.querySelector('[data-gr-settab="templates"]')?.click());
  await page.waitForTimeout(900);
  /* Preview, Send a test and Edit live inside the row now, so it has to be opened
     first. That IS the change: a closed row is a name, not three buttons. */
  await page.evaluate(() => document.querySelector('.gr_tplh[data-gr-tpl-open="gt-2"]')?.click());
  await page.waitForTimeout(700);
  await page.evaluate(() =>
    [...document.querySelectorAll('[data-gr-tpltab]')].find(b => b.textContent === 'Edit')?.click());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('[data-gr-tpl-pv="gt-2"]')?.click());
  await page.waitForTimeout(900);
  const inMail = await lines('.gr_pvsig');
  check('and so does the preview of the mail', !!inMail && inMail.length > 0, JSON.stringify(inMail));
  /* The actual complaint: the same signature read differently in the two places. */
  check('and they are the same lines, in the same order',
    JSON.stringify(builder) === JSON.stringify(inMail),
    JSON.stringify({ builder: builder, mail: inMail }));
  /* And it is the SENT one that both follow: plain text, one item per line. A line
     holding two of them joined by a bar is the old, prettier, wrong rendering. */
  check('with one item per line, not joined with bars',
    !!inMail && inMail.every(l => l.indexOf('|') < 0), JSON.stringify(inMail));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
});


await step('every connector row is asked, not waiting to be asked', async () => {
  /* Claude AI was the only row nothing probed: its state was set by its own Test button
     and nothing reset it, so it read "Not tested" on every page load however many times
     it had been tested, and "Check all again" could not re-ask it. Reported as a
     connector that kept disconnecting; it was a row that had never been asked. */
  let asked = 0;
  await page.route('**/claude-api', r => {
    asked++;
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ text: 'ready' }) });
  });
  await page.route('**/growth-zoom*', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ configured: true, who: 'zoom@reachgiant.com', source: 'app' }) }));
  await page.route('**/growth-calendly*', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ configured: true, who: 'growth@reachgiant.com', source: 'app' }) }));

  await screen('gr_connectors');
  await page.waitForTimeout(2200);
  const rows = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('.gr_cnw').forEach(w => {
      const n = (w.querySelector('.gr_cnrow b') || {}).textContent || '?';
      const lamp = w.querySelector('.gr_lt');
      out[n.trim()] = { on: !!(lamp && lamp.classList.contains('gr_on')),
                        waiting: !!(lamp && lamp.classList.contains('gr_wait')) };
    });
    return out;
  });
  check('the Claude row was actually asked', asked >= 1, String(asked));
  check('and reports an answer rather than "not tested"',
    rows['Claude AI'] && rows['Claude AI'].on && !rows['Claude AI'].waiting,
    JSON.stringify(rows['Claude AI']));
  check('alongside the rows that were already asked',
    rows['Zoom'] && rows['Zoom'].on && rows['Calendly'] && rows['Calendly'].on,
    JSON.stringify({ zoom: rows['Zoom'], calendly: rows['Calendly'] }));

  /* "Check all again" has to re-ask THIS row too -- it was the one row the button could
     not refresh, which is the whole reason it looked stuck. */
  const before = asked;
  await page.evaluate(() => document.querySelector('[data-gr-conn-recheck]')?.click());
  await page.waitForTimeout(2200);
  check('and Check all again asks it once more', asked > before, before + ' then ' + asked);

  await page.unroute('**/claude-api');
  await page.unroute('**/growth-zoom*');
  await page.unroute('**/growth-calendly*');
});


await step('Zoom can be told to pull the calls in', async () => {
  /* Zoom was the one connector with no way to fetch anything: it could mint a link but
     the screen could not ask it what calls exist. The button is the whole feature from
     a user's side, so the check presses it rather than looking for it. */
  let syncHits = 0, sentMethod = '';
  await page.route('**/growth-zoom*', r => {
    const u = r.request().url();
    if (u.includes('action=sync_meetings')) {
      syncHits++; sentMethod = r.request().method();
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ added: 2, duplicate: 3, undated: 0, seen: 5, note: '' }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ configured: true, who: 'zoom@reachgiant.com', source: 'app' }) });
  });
  await page.route('**/growth-calendly*', r => r.fulfill({ status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ configured: true, who: 'growth@reachgiant.com', source: 'app' }) }));
  await page.route('**/claude-api', r => r.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify({ text: 'ready' }) }));

  await screen('gr_connectors');
  await page.waitForTimeout(2200);
  /* Rows are collapsed until opened, so the panel does not exist yet. Opening it is
     what a person does, and it is also the only way the button is reachable at all. */
  await page.evaluate(() => document.querySelector('[data-gr-conn="zoom"]')?.click());
  await page.waitForTimeout(900);

  const btn = await page.evaluate(() => {
    const b = document.querySelector('[data-gr-zoom-sync]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { text: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) };
  });
  /* Measure it, do not just find it: a button the stylesheet collapsed to nothing is
     present in the DOM and unclickable on the screen. */
  check('the Zoom row offers a sync button', !!btn && btn.w > 40 && btn.h > 14,
    JSON.stringify(btn));
  check('and it says what it does', !!btn && /sync/i.test(btn.text), btn && btn.text);

  await page.evaluate(() => document.querySelector('[data-gr-zoom-sync]')?.click());
  await page.waitForTimeout(1800);
  check('pressing it actually asks the function', syncHits >= 1, String(syncHits));
  /* It writes rows, so it must not be reachable by a link somebody can prefetch. */
  check('as a POST, not a GET', sentMethod === 'POST', sentMethod);

  /* A missing Zoom scope is a settings problem in Zoom, and the fix is several clicks
     away -- so it has to stay on the panel, not flash past in a toast. */
  await page.unroute('**/growth-zoom*');
  await page.route('**/growth-zoom*', r => {
    const u = r.request().url();
    if (u.includes('action=sync_meetings')) {
      return r.fulfill({ status: 400, contentType: 'application/json',
        body: JSON.stringify({ scope: true, error:
          'The Zoom app does not have the meeting:read:list_meetings:admin scope. ' +
          'In the Zoom marketplace open the app, add that scope, Activate it again, ' +
          'then press Sync meetings.' }) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ configured: true, who: 'zoom@reachgiant.com', source: 'app' }) });
  });
  await page.evaluate(() => document.querySelector('[data-gr-zoom-sync]')?.click());
  await page.waitForTimeout(2000);
  const shown = await page.evaluate(() => {
    const el = document.querySelector('.gr_cnw.gr_cnon .gr_cstat.bad');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { text: el.textContent.trim(), visible: r.width > 40 && r.height > 8 };
  });
  check('a missing scope stays on the panel instead of flashing past',
    !!shown && shown.visible, JSON.stringify(shown && shown.visible));
  check('and names the scope to add', !!shown && /list_meetings/.test(shown.text),
    shown && shown.text.slice(0, 80));

  await page.unroute('**/growth-zoom*');
  await page.unroute('**/growth-calendly*');
  await page.unroute('**/claude-api');
});


await step('a call opens what the person said when they booked', async () => {
  /* The row used to open the DEAL, and only when one was matched, so a booking from
     somebody nobody tracked was the one row on the screen that did nothing when clicked.
     It opens the call now, and the call carries the ten booking-form answers. */
  await screen('gr_meetings');
  await page.waitForTimeout(1500);

  const clickable = await page.evaluate(() =>
    [...document.querySelectorAll('[data-gr-meet]')].map(e => e.dataset.grMeet));
  /* gm-3 is the unattached Zoom call. Before this it had no data-gr-open at all. */
  check('every call on the screen can be opened, attached to a deal or not',
    clickable.includes('gm-1') && clickable.includes('gm-3'), JSON.stringify(clickable));

  await page.evaluate(() => document.querySelector('[data-gr-meet="gm-1"]')?.click());
  await page.waitForTimeout(900);

  const p1 = await page.evaluate(() => {
    const w = document.getElementById('grSheet');
    const sh = w && w.querySelector('.gr_sheet');
    const qs = [...document.querySelectorAll('.gr_mdq')];
    const box = sh && sh.getBoundingClientRect();
    return {
      open: !!(w && w.classList.contains('on')),
      mid: sh && sh.dataset.grMid,
      wide: box ? Math.round(box.width) : 0,
      pairs: qs.map(d => ({
        q: (d.querySelector('b') || {}).textContent || '',
        a: (d.querySelector('p') || {}).textContent || '',
        h: Math.round((d.querySelector('p') || { getBoundingClientRect: () => ({ height: 0 }) })
             .getBoundingClientRect().height)
      })),
      who: document.querySelector('.gr_mdwho') &&
           document.querySelector('.gr_mdwho').textContent.replace(/\s+/g, ' ').trim()
    };
  });
  check('clicking a call opens the panel for THAT call',
    p1.open && p1.mid === 'gm-1' && p1.wide > 300,
    JSON.stringify({ open: p1.open, mid: p1.mid, wide: p1.wide }));
  /* Assert the WORDS. Four headings with nothing under them is still four headings, and
     that is the exact shape the Changelog bug had. */
  check('the booking questions are there, with the answers under them',
    p1.pairs.length === 4 && p1.pairs.every(x => x.q.length > 8 && x.a.length > 2),
    JSON.stringify(p1.pairs.map(x => x.q.slice(0, 24) + ' -> ' + x.a.slice(0, 18))));
  check('including the money question, which is the one anybody opens this for',
    p1.pairs.some(x => /budget/i.test(x.q) && /1,500/.test(x.a)),
    JSON.stringify(p1.pairs.map(x => x.a).filter(a => /1,500/.test(a))));
  /* Calendly returns a multi-select as ONE string with newlines in it. Without
     white-space:pre-line those three choices run together into one line.

     The fixture's answer is deliberately SHORT -- "Google Ads\nSEO\nMeta Ads". The real
     answer is three long phrases that wrap to three lines whichever way it is rendered,
     so measuring height against THAT proves nothing: it was tried, pre-line was taken
     out, and the suite stayed green. Short enough to fit on one line, the only thing
     that can make it three is the breaks being honoured. */
  const multi = p1.pairs.find(x => /Google Ads/.test(x.a));
  const single = p1.pairs.find(x => /Under 100k/.test(x.a));
  check('a three-choice answer is drawn on three lines, not run into one',
    !!multi && !!single && multi.h > single.h * 2.4,
    JSON.stringify({ multi: multi && multi.h, single: single && single.h }));
  check('their email, phone and timezone come with it',
    /outlook\.com/.test(p1.who || '') && /\+447922116098/.test(p1.who || '') &&
    /Europe\/Berlin/.test(p1.who || ''), p1.who);

  /* Opening the deal from inside the call must REPLACE the panel. Two sheets in one host
     with one Escape key is how people get stuck behind a thing they cannot close. */
  await page.evaluate(() => document.querySelector('.gr_sheet [data-gr-open]')?.click());
  await page.waitForTimeout(900);
  const afterDeal = await page.evaluate(() => {
    const sh = document.querySelector('#grSheet .gr_sheet');
    return { sheets: document.querySelectorAll('#grSheet .gr_sheet').length,
             mid: sh && sh.dataset.grMid, cid: sh && sh.dataset.grId };
  });
  check('Open the deal swaps the panel for the deal, it does not stack a second one',
    afterDeal.sheets === 1 && !afterDeal.mid && !!afterDeal.cid,
    JSON.stringify(afterDeal));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  /* A call with no answers has to say which KIND of nothing it is. A Calendly booking
     synced before the answers were kept is not the same as a Zoom call that was never
     asked, and blank space would read as "they answered nothing" for both. */
  await page.evaluate(() => document.querySelector('[data-gr-meet="gm-3"]')?.click());
  await page.waitForTimeout(900);
  const zoomSaid = await page.evaluate(() => {
    const sh = document.querySelector('#grSheet .gr_sheet');
    return { mid: sh && sh.dataset.grMid, text: sh ? sh.textContent : '',
             rows: document.querySelectorAll('.gr_mdq').length };
  });
  check('a call that never had a booking form says so rather than showing nothing',
    zoomSaid.mid === 'gm-3' && zoomSaid.rows === 0 &&
    /did not come from Calendly/i.test(zoomSaid.text),
    JSON.stringify({ rows: zoomSaid.rows, mid: zoomSaid.mid }));
  check('and an unattached call admits it has no deal instead of offering a dead button',
    /Not attached to a deal/i.test(zoomSaid.text), '');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  const closed = await page.evaluate(() =>
    document.getElementById('grSheet').classList.contains('on'));
  check('Escape closes the call panel', !closed, String(closed));
});


await step('Settings opens over the screen instead of becoming one', async () => {
  /* It used to be a screen. Changing a template or a discount code meant leaving
     whatever sent you there, and coming back to the top of it. It is a panel now, the
     same shape as the templates drawer in Luke's CRM.

     The nav item still looks like every other nav item, and the app switches screens on
     ANY .nav-item click -- so the Growth module catches the event in the capture phase
     and stops it. If that interception ever breaks, the panel still opens and everything
     below still passes; the only thing that changes is the screen underneath. That is
     what the first check measures. */
  await screen('gr_pipeline');
  await page.waitForTimeout(1200);
  const before = await page.evaluate(() =>
    (document.querySelector('.screen.on') || {}).dataset?.screen);

  await page.evaluate(() =>
    document.querySelector('#appSidebar .nav-item[data-screen="gr_settings"]')?.click());
  await page.waitForTimeout(1100);

  const o = await page.evaluate(() => {
    const w = document.getElementById('grSetPanel');
    const d = w && w.querySelector('.gr_setd');
    const seg = d && d.querySelector('.gr_seg');
    const sb = seg && seg.getBoundingClientRect();
    const db = d && d.getBoundingClientRect();
    return {
      open: !!(w && w.classList.contains('on')),
      wide: db ? Math.round(db.width) : 0,
      behind: (document.querySelector('.screen.on') || {}).dataset?.screen,
      tabs: [...(d ? d.querySelectorAll('[data-gr-settab]') : [])].map(b => b.textContent.trim()),
      segH: sb ? Math.round(sb.height) : 0
    };
  });
  check('clicking Settings opens the panel', o.open && o.wide > 400,
    JSON.stringify({ open: o.open, wide: o.wide }));
  /* THE ONE THAT MATTERS. A nav item that navigates would leave Pipeline behind and
     put the empty gr_settings screen there instead. */
  check('and leaves you on the screen you were already on',
    o.behind === before && before === 'gr_pipeline',
    JSON.stringify({ before: before, after: o.behind }));
  check('with Templates, New, Package master, Reply style, Codes and Team',
    o.tabs.join(' | ') === 'Templates | + New template | Package master | Reply style | Codes & signature | Team',
    JSON.stringify(o.tabs));

  // Team is the half that had to survive the move.
  await page.evaluate(() => [...document.querySelectorAll('.gr_setd [data-gr-settab]')]
    .find(b => /team/i.test(b.textContent))?.click());
  await page.waitForTimeout(900);
  const t = await page.evaluate(() => {
    const d = document.querySelector('.gr_setd');
    const tick = d && d.querySelector('.gr_tck');
    const seg = d && d.querySelector('.gr_seg');
    return {
      segH: seg ? Math.round(seg.getBoundingClientRect().height) : 0,
      scrolls: d ? d.scrollHeight > d.clientHeight : false,
      heading: [...(d ? d.querySelectorAll('h2') : [])].map(x => x.textContent.trim()),
      people: d ? d.querySelectorAll('.gr_trow').length : 0,
      ticks: d ? d.querySelectorAll('.gr_tck').length : 0,
      tickW: tick ? Math.round(tick.getBoundingClientRect().width) : 0,
      sigFields: d ? d.querySelectorAll('[data-gr-sig]').length : 0
    };
  });
  check('Team still lists who works in Growth, with working ticks',
    t.heading.some(h => /Who works in Growth/i.test(h)) && t.people > 1 &&
    t.ticks > 1 && t.tickW > 10, JSON.stringify(t));
  /* Team used to draw a SECOND signature editor under the list, and that copy carried a
     "Logo or photo (link)" field writing signature.image -- which nothing has read since
     the logo came off the preview, because Growth sends text/plain. One editor now, and
     it is not this tab. */
  check('and no longer repeats the signature editor underneath it',
    t.sigFields === 0, String(t.sigFields));
  /* THE TAB STRIP, MEASURED ON A TAB THAT OVERFLOWS. The panel is a fixed-height flex
     column, so its children shrink to fit -- but only once something makes it overflow.
     Measured on a short tab the strip is a healthy 34px whether the rule is there or
     not, so the check passed against the bug. On Team, with everyone listed, it drops to
     6px without it: present in the DOM, unreadable and barely clickable. */
  check('the tab strip keeps its height on a tab long enough to scroll',
    t.scrolls && t.segH > 26, JSON.stringify({ scrolls: t.scrolls, segH: t.segH }));

  // It must be dismissable both ways: a panel opened from a nav item has no Back.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  const esc = await page.evaluate(() =>
    document.getElementById('grSetPanel').classList.contains('on'));
  check('Escape closes it', !esc, String(esc));

  await page.evaluate(() =>
    document.querySelector('#appSidebar .nav-item[data-screen="gr_settings"]')?.click());
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const w = document.getElementById('grSetPanel');
    const r = w.getBoundingClientRect();
    // the dimmed area, well clear of the drawer on the right
    w.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: Math.round(r.left + 40),
      clientY: Math.round(r.top + 300) }));
  });
  await page.waitForTimeout(700);
  const back = await page.evaluate(() => ({
    open: document.getElementById('grSetPanel').classList.contains('on'),
    screen: (document.querySelector('.screen.on') || {}).dataset?.screen }));
  check('and so does clicking the dimmed area beside it',
    !back.open && back.screen === 'gr_pipeline', JSON.stringify(back));

  /* Going somewhere else has to take it with you. Left up, it floats over another
     module's screen the way the Today button used to -- and this is also how it leaks
     into the rest of this suite: three earlier steps open Settings, and a panel still
     up when they finish swallows the next Escape meant for something else. */
  await page.evaluate(() =>
    document.querySelector('#appSidebar .nav-item[data-screen="gr_settings"]')?.click());
  await page.waitForTimeout(900);
  const upBefore = await page.evaluate(() =>
    document.getElementById('grSetPanel').classList.contains('on'));
  await screen('gr_training');
  await page.waitForTimeout(900);
  const away = await page.evaluate(() => ({
    open: document.getElementById('grSetPanel').classList.contains('on'),
    screen: (document.querySelector('.screen.on') || {}).dataset?.screen }));
  check('clicking another nav item takes the panel down with it',
    upBefore && !away.open && away.screen === 'gr_training',
    JSON.stringify({ wasUp: upBefore, after: away }));
});


await step('package emails are built from one master, not written six times', async () => {
  /* Every package email is the same onboarding letter with a different name and Stripe
     link in it. Written by hand, six of them drift apart and nobody finds out until a
     client reads one. The master holds the wording; a package email is the master with
     two values filled in.

     Nothing in growth_templates says "package" -- there is no such column. The Stripe
     link IS what makes one, here and in the list. */
  const open = async (tab) => {
    await page.evaluate(() =>
      document.querySelector('#appSidebar .nav-item[data-screen="gr_settings"]')?.click());
    await page.waitForTimeout(800);
    await page.evaluate(t => [...document.querySelectorAll('.gr_setd [data-gr-settab]')]
      .find(b => new RegExp(t, 'i').test(b.textContent))?.click(), tab);
    await page.waitForTimeout(700);
  };

  await screen('gr_meetings');
  await open('Templates');
  const g = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.gr_setd [data-gr-settab]')].map(b => b.textContent.trim()),
    groups: [...document.querySelectorAll('.gr_setd .gr_card .gr_ct h2')].map(x => x.textContent.trim()),
    counts: [...document.querySelectorAll('.gr_setd .gr_card .gr_ct .gr_n')].map(x => x.textContent.trim()),
    kinds: [...document.querySelectorAll('.gr_kind')].map(x => x.textContent.trim()),
    // Collapsed, a row shows no actions at all. Eighteen buttons for six templates was
    // the thing that made the list unreadable.
    openActions: document.querySelectorAll('.gr_tpla').length,
    boxed: (() => { const r = document.querySelector('.gr_tplr');
      return r ? Math.round(r.getBoundingClientRect().height) : 0; })()
  }));
  check('the panel carries all six tabs',
    g.tabs.join(' | ') === 'Templates | + New template | Package master | Reply style | Codes & signature | Team',
    JSON.stringify(g.tabs));
  /* The fixture is one of each kind on purpose: a list of one shape proves nothing about
     a split, and would pass just as well on code that never split anything. */
  check('the list splits package emails from the rest',
    g.groups.join(',') === 'Package emails,Other emails' && g.counts.join(',') === '2,1',
    JSON.stringify({ groups: g.groups, counts: g.counts }));
  check('and the ones carrying a Stripe link are the ones marked Package',
    g.kinds.join(',') === 'Package,Package,Other', JSON.stringify(g.kinds));
  check('a row is a closed box, not a name over three buttons',
    g.openActions === 0 && g.boxed > 40, JSON.stringify({ actions: g.openActions, rowH: g.boxed }));

  /* ---- the Info card ----
     Every fact on it is read off the body rather than stored beside it, and that is the
     whole point: there is no column to forget to update. So each check below changes the
     BODY and requires the card to follow, rather than reading a value the card could be
     printing from anywhere. */
  const facts = async (id) => {
    await page.evaluate(i => {
      const r = document.querySelector('.gr_tplr .gr_tplh[data-gr-tpl-open="' + i + '"]');
      if (r && r.getAttribute('aria-expanded') !== 'true') r.click();
    }, id);
    await page.waitForTimeout(600);
    return page.evaluate(() => {
      const out = {};
      document.querySelectorAll('.gr_tplinf .gr_fct').forEach(f => {
        const k = f.querySelector('.gr_fk'), v = f.querySelector('.gr_fv');
        if (k) out[k.textContent.trim()] = v ? v.innerText.trim() : '';
      });
      out._preview = (document.querySelector('.gr_tplinf .gr_prevb') || {}).innerText || '';
      out._warn = [...document.querySelectorAll('.gr_tplinf .gr_warn')].map(x => x.innerText.trim());
      return out;
    });
  };

  const pkgF = await facts('gt-2');
  check('Info names what kind of email it is',
    /Package email, built from the package master/.test(pkgF['Type'] || ''), pkgF['Type']);
  /* The link in the card has to be the link in the letter. A card that showed a stored
     column would pass a presence test and still send the wrong person's Stripe page. */
  check('and lifts the Stripe link out of the body, character for character',
    (pkgF['Stripe link'] || '') === 'https://buy.stripe.com/test123', pkgF['Stripe link']);
  /* {discount} is left standing on purpose -- the code is chosen at send time. So the
     card may say a spot EXISTS and must never name one, or it is telling you a template
     carries a discount it does not carry. */
  check('reports the discount as a spot, never as a code',
    /spot/i.test(pkgF['Discount'] || '') && !/RG\d|[A-Z]{2,}\d{2,}/.test(pkgF['Discount'] || ''),
    pkgF['Discount']);
  check('lists the placeholders that are really in it, and leaves {discount} out',
    (pkgF['Fills in automatically'] || '').replace(/\s+/g, ' ') === '{name} {company}',
    pkgF['Fills in automatically']);
  /* Two different templates must give two different numbers, or "21 words" is a constant
     that happens to be right once. */
  check('counts the words in that template\'s own body',
    (pkgF['Length'] || '') === '21 words', pkgF['Length']);
  check('and fills the preview with a stand-in, links flattened so they can be read',
    /Hi Michael,/.test(pkgF._preview) &&
    /Pay here via Stripe \(https:\/\/buy\.stripe\.com\/test123\)/.test(pkgF._preview) &&
    /picked when you send/i.test(pkgF._preview), pkgF._preview.slice(0, 80));

  /* THE DEFECT THIS CARD EXISTS TO SURFACE. The discounted twin says Hi "Name" -- a
     literal, not a placeholder -- so it goes out with the quotation marks and nobody's
     name in it. Nothing on a closed row says so; the card has to. */
  const badF = await facts('gt-3');
  check('a template that personalises nothing says so, rather than showing a blank',
    (badF['Fills in automatically'] || '') !== '' &&
    /nothing/i.test(badF['Fills in automatically'] || '') &&
    badF._warn.some(w => /nothing/i.test(w)), JSON.stringify(badF['Fills in automatically']));
  check('and that one is a different length, so the count is measured and not fixed',
    (badF['Length'] || '') !== (pkgF['Length'] || '') && /^\d+ words$/.test(badF['Length'] || ''),
    JSON.stringify({ pkg: pkgF['Length'], other: badF['Length'] }));

  /* A hand-written email has no Stripe link and no discount, so those two facts are
     absent rather than present-and-empty. An empty "Stripe link:" on a Zoom reminder
     reads as one that is missing. */
  const handF = await facts('gt-1');
  check('a hand-written email shows no Stripe or Discount fact at all',
    !('Stripe link' in handF) && !('Discount' in handF) &&
    /Written by hand/.test(handF['Type'] || ''),
    JSON.stringify(Object.keys(handF).filter(k => k[0] !== '_')));

  // ---- the master fills the preview as you type
  await open('New template');
  const modes = await page.evaluate(() =>
    [...document.querySelectorAll('.gr_mode b')].map(x => x.textContent.trim()));
  check('New template offers one, many, or write your own',
    modes.join(' | ') === 'Package email | Many packages | Other email', JSON.stringify(modes));

  await page.evaluate(() => {
    const n = document.getElementById('grPkgName');
    n.value = 'Paid Ads Volt 3k'; n.dispatchEvent(new Event('input', { bubbles: true }));
    const l = document.getElementById('grPkgLink');
    l.value = 'https://buy.stripe.com/zzz'; l.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(500);
  const pv = await page.evaluate(() =>
    (document.getElementById('grPkgPreviewBox') || {}).textContent || '');
  /* Both values, and the master's own wording around them. A preview that showed only
     what you typed would look right and prove nothing about the master being used. */
  check('the preview shows the master with your two values in it',
    /Paid Ads Volt 3k/.test(pv) && /buy\.stripe\.com\/zzz/.test(pv) &&
    /Head of Client Services/.test(pv), pv.slice(0, 70));

  // ---- creating one writes a row built from the master
  const before = await page.evaluate(() => (window.__mockDB.growth_templates || []).length);
  /* data-gr-pk-add was ALREADY the Training pricing "add a package" button. Reusing it
     meant that branch ran first, found no #grNewPack and returned -- the button looked
     alive and saved nothing. Renamed; this is the name nothing else answers to. */
  await page.evaluate(() => document.querySelector('[data-gr-pkgmake]')?.click());
  await page.waitForTimeout(1200);
  /* Read the ROW, not the screen. A template that paints and never saves looks identical
     until the next reload, which is the bug shape this module keeps finding. */
  const row = await page.evaluate(() => {
    const t = (window.__mockDB.growth_templates || []).find(x => x.name === 'Paid Ads Volt 3k');
    return t ? { name: t.name, subject: t.subject, hasLink: /buy\.stripe\.com\/zzz/.test(t.body),
                 fromMaster: /Head of Client Services/.test(t.body),
                 noLeftovers: !/\{package\}|\{payment_link\}/.test(t.body),
                 keepsDiscount: /\{discount\}/.test(t.body) } : null;
  });
  const after = await page.evaluate(() => (window.__mockDB.growth_templates || []).length);
  check('Create package email saves a row', after === before + 1 && !!row,
    JSON.stringify({ before, after }));
  check('built from the master, with both values filled in',
    !!row && row.fromMaster && row.hasLink && row.noLeftovers, JSON.stringify(row));
  /* {discount} is NOT filled in here: which code goes in is chosen when the email is
     sent, not when the template is made. */
  check('and {discount} left standing, because that is picked at send time',
    !!row && row.keepsDiscount, JSON.stringify(row && row.keepsDiscount));
  check('the new one files itself under Package emails',
    await page.evaluate(() => {
      const c = document.querySelector('.gr_setd .gr_card .gr_ct .gr_n');
      return c ? c.textContent.trim() : '';
    }) === '3', '');

  // ---- the master itself
  await open('Package master');
  const m = await page.evaluate(() => ({
    toks: [...document.querySelectorAll('.gr_toks code')].map(x => x.textContent),
    sub: (document.getElementById('grMtS') || {}).value,
    len: ((document.getElementById('grMtB') || {}).value || '').length
  }));
  check('the master names every placeholder it understands',
    m.toks.join(',') === '{name},{package},{payment_link},{discount}', JSON.stringify(m.toks));
  check('and opens with the real onboarding letter, not an empty box',
    m.len > 600 && /ReachGiant/.test(m.sub), JSON.stringify({ sub: m.sub, len: m.len }));

  await page.evaluate(() => {
    const b = document.getElementById('grMtB');
    b.value = b.value + '\nPS edited'; b.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(() => document.querySelector('[data-gr-mt-save]')?.click());
  await page.waitForTimeout(1200);
  const saved = await page.evaluate(() => {
    const r = (window.__mockDB.growth_settings || []).find(x => x.key === 'tpl_master');
    return r && r.value ? /PS edited/.test(r.value.body) : false;
  });
  check('saving the master writes it to the settings row', saved, String(saved));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
});


await step('a finished call carries its recording, and an unfinished one does not', async () => {
  /* Zoom records every call on this account and none of it used to reach the app: the
     recording sat in Zoom and the only way to find one was to go and look.

     The two fixtures are deliberately different. gm-4 was recorded and has a transcript;
     gm-5 happened and nobody recorded it. A screen that drew the block unconditionally
     would pass every presence test here and tell somebody there is a recording of a call
     nobody recorded. */
  await screen('gr_meetings');
  await page.waitForTimeout(1200);

  /* Upcoming first. A recording block above a call that has not happened yet promises
     something that does not exist, and the notes box under it is somewhere to write up
     a meeting nobody has had. */
  const onUpcoming = await page.evaluate(() =>
    [...document.querySelectorAll('[data-gr-meet]')]
      .filter(r => r.querySelector('details.gr_rec')).map(r => r.dataset.grMeet));
  check('no after-the-call block on a meeting that has not happened yet',
    onUpcoming.length === 0, JSON.stringify(onUpcoming));

  /* Measured HERE and kept. Past holds nothing but finished calls, so by the time the
     chip is compared there is no live one left on the screen to compare it against. */
  const liveChip = await page.evaluate(() => {
    const el = document.querySelector('.gr_mx:not(.gr_done) .gr_mt');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });

  await page.evaluate(() => document.querySelector('[data-gr-mview="past"]')?.click());
  await page.waitForTimeout(1000);
  await page.evaluate(() => [...document.querySelectorAll('details.gr_rec')].forEach(d => { d.open = true; }));
  await page.waitForTimeout(500);

  const read = (id) => page.evaluate((mid) => {
    const row = document.querySelector('[data-gr-meet="' + mid + '"]');
    const d = row && row.querySelector('details.gr_rec');
    if (!d) return { block: false };
    const a = d.querySelector('a.gr_joinbig');
    const ta = d.querySelector('[data-gr-note]');
    const sum = d.querySelector('[data-gr-sum]');
    const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
    return {
      block: true,
      href: a ? a.getAttribute('href') : null,
      watchBox: a ? box(a) : null,
      noteBox: ta ? box(ta) : null,
      summariseOffered: !!sum,
      text: d.innerText.replace(/\s+/g, ' ').trim()
    };
  }, id);

  const rec = await read('gm-4');
  const bare = await read('gm-5');

  check('the recorded call has an after-the-call block',
    rec.block === true, JSON.stringify(rec.block));
  /* MEASURED, not merely present. A Watch link that exists at 0px wide is the shape of
     bug this repo has shipped before. */
  check('with a Watch link somebody can actually click',
    !!rec.watchBox && rec.watchBox.w > 80 && rec.watchBox.h > 14, JSON.stringify(rec.watchBox));
  /* The one that was wrong until it was looked at. recording_play_passcode is a 98
     character encrypted token whose only documented use is ?pwd= on the share url.
     Without it the link lands on Zoom asking for a passcode nobody here was ever sent. */
  check('and the passcode travels in the link rather than sitting on the screen',
    /[?&]pwd=DFhmiswHzdjokje0nAAAIAAAANDW23POVUe920aca/.test(rec.href || '') &&
    !/DFhmiswHzdjokje0/.test(rec.text || ''),
    JSON.stringify((rec.href || '').slice(-60)));
  check('the summary line says how long it ran and what Zoom kept',
    /37 min/.test(rec.text) && /video/.test(rec.text) && /captions/.test(rec.text),
    rec.text.slice(0, 70));
  check('a transcript means a summary can be asked for',
    rec.summariseOffered === true, String(rec.summariseOffered));

  check('the call nobody recorded still gets a block, so it can carry notes',
    bare.block === true && !!bare.noteBox && bare.noteBox.w > 150, JSON.stringify(bare.noteBox));
  check('and says there is no recording rather than showing a dead button',
    /No recording in Zoom/.test(bare.text || '') && !bare.href, bare.text.slice(0, 60));
  /* Two different absences. No summary is fixed by pressing a button; no transcript is
     fixed in the Zoom marketplace, and a screen that said "no summary" for both would
     send somebody looking in the wrong place. */
  check('no transcript is said plainly, not offered as a button that cannot work',
    bare.summariseOffered === false && /nothing to summarise/.test(bare.text || ''),
    bare.text.slice(0, 80));

  /* READABLE, MEASURED UP THE WHOLE TREE. .gr_mx.gr_done carried one opacity:.6 for the
     finished look, and opacity on a parent cannot be undone by a child -- it makes a
     stacking context and nothing inside it can be more opaque. So the summary, the one
     thing anybody opens this block to read, rendered at 60% on a dark page and was very
     nearly invisible. Every presence check passed throughout: the text was there, the
     right colour, the right size, and unreadable.

     So this multiplies the opacity of every ancestor rather than reading the element's
     own, which is 1 either way and proves nothing. */
  const dim = await page.evaluate(() => {
    const d = document.querySelector('[data-gr-meet="gm-4"] details.gr_rec');
    const row = d.closest('.gr_mx');
    const eff = (el) => { let o = 1, n = el;
      while (n && n !== document.body) { o *= parseFloat(getComputedStyle(n).opacity || '1'); n = n.parentElement; }
      return Math.round(o * 100) / 100; };
    const watch = d.querySelector('a.gr_joinbig');
    return {
      rowIsDone: row.classList.contains('gr_done'),
      nameLine: eff(row.querySelector('.gr_rm')),
      block: eff(d),
      summaryText: eff(d.querySelector('.gr_recs, .gr_sump, .gr_mute')),
      watchBg: getComputedStyle(watch).backgroundColor,
      dayColour: getComputedStyle(row.closest('.gr_dayc')).getPropertyValue('--dc').trim()
    };
  });
  check('the after-the-call block is at full strength even though the call is done',
    dim.rowIsDone === true && dim.block === 1 && dim.summaryText === 1, JSON.stringify(dim));
  /* ...and the row still LOOKS done. Without this the check above passes just as well on
     code that simply stopped dimming anything. */
  check('while the row above it is still dimmed, so finished still reads as finished',
    dim.nameLine < 0.8, String(dim.nameLine));
  /* gr_joinbig paints itself var(--dc), the colour of the day it sits on, and a past day
     is grey. The one thing worth clicking rendered grey on grey and read as disabled. */
  /* THE CHIP ON A FINISHED CALL. #C7C7CC is an iOS LIGHT-theme grey: on a dark page it
     was the brightest thing in the row, so the loudest colour on the screen sat on the
     least interesting call. It now takes a muted fill with a border, and the border is
     paid for out of the padding -- measured against a live chip, because a box that
     grew a pixel would push every row in the list out of line with the others. */
  const chip = await page.evaluate(() => {
    const done = document.querySelector('.gr_mx.gr_done .gr_mt');
    const cs = getComputedStyle(done);
    const box = (el) => { const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) }; };
    return { bg: cs.backgroundColor, border: parseFloat(cs.borderTopWidth),
             done: box(done) };
  });
  chip.live = liveChip;
  check('a finished call’s time chip is not the light-theme grey block it was',
    chip.bg !== 'rgb(199, 199, 204)', chip.bg);
  check('and keeps an edge, so it still reads as a chip once the fill stops shouting',
    chip.border >= 1, String(chip.border));
  check('the same size as a live one, so the rows stay in line',
    !!chip.live && chip.done.w === chip.live.w && Math.abs(chip.done.h - chip.live.h) <= 1,
    JSON.stringify(chip));

  check('Watch does not take the grey of the past day it sits on',
    dim.watchBg !== 'rgb(142, 142, 147)' && dim.dayColour === '#8E8E93',
    JSON.stringify({ watch: dim.watchBg, day: dim.dayColour }));

  /* A summary is four headed sections and arrives as one string. Rendered flat it is a
     wall of prose, which on the longest thing on this screen is the same as not having
     it. The fixture summary is written with headings so a renderer that ignored them
     would fail here rather than look plausible. */
  await page.evaluate(async () => {
    await window.giantSupabase.from('growth_meetings').update({
      summary: 'What they want\n\nMore traffic to the three service pages.\n\n' +
               'Objections\n\nBurned by an agency last year.\n\n' +
               'Do next\n\nProposal by Friday.',
      summary_source: 'claude' }).eq('id', 'gm-4').select('id');
    window.grReload && await window.grReload();
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { document.querySelector('[data-gr-meet="gm-4"] details.gr_rec').open = true; });
  await page.waitForTimeout(400);
  const sum = await page.evaluate(() => {
    const d = document.querySelector('[data-gr-meet="gm-4"] details.gr_rec');
    const h = [...d.querySelectorAll('.gr_sumh')];
    const p = [...d.querySelectorAll('.gr_sump')];
    return { heads: h.map(x => x.textContent), paras: p.length,
             headWeight: h[0] ? getComputedStyle(h[0]).fontWeight : '',
             copy: !!d.querySelector('[data-gr-sumcopy]') };
  });
  check('the summary is split into its headings rather than one wall of prose',
    sum.heads.join('|') === 'What they want|Objections|Do next' && sum.paras === 3,
    JSON.stringify(sum.heads));
  check('and the headings are heavier than the prose under them',
    Number(sum.headWeight) >= 700, sum.headWeight);
  /* What happens to a call summary next is that somebody pastes it into an email. */
  check('a summary that exists can be copied out',
    sum.copy === true, String(sum.copy));

  /* Put it back. A row that HAS a summary offers no Summarise button, and the two checks
     below press exactly that button -- leaving this set would make them fail on a null,
     which reads like a broken screen rather than like a test that tidied up after
     itself badly. */
  await page.evaluate(async () => {
    await window.giantSupabase.from('growth_meetings')
      .update({ summary: null, summary_source: null }).eq('id', 'gm-4').select('id');
    window.grReload && await window.grReload();
  });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    document.querySelectorAll('details.gr_rec').forEach(d => { d.open = true; });
  });
  await page.waitForTimeout(400);

  /* The list turns a click on a row into "open this call". A <summary> is a click like
     any other, so without stopPropagation opening the block opens the sheet over it. */
  await page.evaluate(() => {
    const d = document.querySelector('[data-gr-meet="gm-4"] details.gr_rec');
    d.open = false; d.querySelector('summary').click();
  });
  await page.waitForTimeout(700);
  const sheetOpen = await page.evaluate(() => {
    const w = document.getElementById('grSheet');
    return !!(w && w.classList.contains('on'));
  });
  check('opening the block does not open the call over the top of it',
    sheetOpen === false, String(sheetOpen));

  /* WHAT THE SUMMARISER IS TOLD ABOUT WHO WAS TALKING. Zoom's captions carry no
     speaker, and this account produces captions and not transcripts, so most calls
     arrive as an unattributed stream of talk. Asked to split that into "what they want"
     and "what we said", a model will hand back "the client said their budget is 1.5k"
     with no way of knowing it was us who said it -- a confident wrong answer in the one
     place on this screen that costs money. The prompt has to say which kind it has.

     Both fixtures run through the same button, so a prompt that said the same thing
     either way would fail here rather than read plausibly in production. */
  const promptFor = async (mid) => {
    let sent = null;
    await page.route('**/claude-api', r => {
      sent = JSON.parse(r.request().postData() || '{}');
      return r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ text: 'What they want\nSomething\n\nDo next\nNothing' }) });
    });
    await page.evaluate((id) => {
      const d = document.querySelector('[data-gr-meet="' + id + '"] details.gr_rec');
      d.open = true; d.querySelector('[data-gr-sum]').click();
    }, mid);
    await page.waitForTimeout(1500);
    await page.unroute('**/claude-api');
    return (sent && sent.system) || '';
  };

  const namedP = await promptFor('gm-4');
  check('a transcript that names its speakers lets the summary say who said what',
    /may say who said what/i.test(namedP) && !/NO SPEAKER NAMES/.test(namedP),
    namedP.slice(-90));
  const blindP = await promptFor('gm-6');
  check('captions with no speaker forbid attributing anything to either side',
    /NO SPEAKER NAMES/.test(blindP) && /[Nn]ever say who said something/.test(blindP) &&
    /never guess\s+which side is the client/.test(blindP), blindP.slice(-110));

  // A note typed and left behind has to reach the row, not just the textarea.
  await page.evaluate(() => {
    const d = document.querySelector('[data-gr-meet="gm-5"] details.gr_rec');
    d.open = true;
    const ta = d.querySelector('[data-gr-note]');
    ta.value = 'Partner sign-off needed. Chase Friday.';
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(1200);
  const stored = await page.evaluate(() =>
    (window.__mockDB.growth_meetings.find(m => m.id === 'gm-5') || {}).notes);
  check('a note typed and left behind is written to the call',
    stored === 'Partner sign-off needed. Chase Friday.', JSON.stringify(stored));
});


await step('the tab you chose survives a reload', async () => {
  /* Past is where the recordings are, so somebody doing call follow-up lives there all
     morning -- and every reload threw them back to Upcoming. Proved with a REAL reload
     rather than by reading the stored value: the value was never the problem, honouring
     it on the way back up is. */
  await screen('gr_meetings');
  await page.waitForTimeout(900);
  const tab = () => page.evaluate(() => {
    const b = document.querySelector('[data-gr-mview][aria-pressed="true"]');
    return b ? b.dataset.grMview : null;
  });
  await page.evaluate(() => document.querySelector('[data-gr-mview="past"]').click());
  await page.waitForTimeout(700);
  check('clicking Past selects Past', (await tab()) === 'past', await tab());

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await screen('gr_meetings');
  await page.waitForTimeout(900);
  check('and a full reload comes back to Past, not to Upcoming',
    (await tab()) === 'past', await tab());

  /* A stale or hand-edited value selects a branch grRenderMeetings has no arm for, and
     the screen paints nothing at all -- worse than the bug being fixed. */
  await page.evaluate(() => { try { localStorage.setItem('giant.grMView', 'nonsense'); } catch (e) {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await screen('gr_meetings');
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => ({
    tab: (document.querySelector('[data-gr-mview][aria-pressed="true"]') || {}).dataset?.grMview || null,
    rows: document.querySelectorAll('[data-gr-meet]').length
  }));
  check('a value that is not a tab falls back to Upcoming rather than painting nothing',
    after.tab === 'up' && after.rows > 0, JSON.stringify(after));
  await page.evaluate(() => { try { localStorage.removeItem('giant.grMView'); } catch (e) {} });
});

await step('Reply style decides how every draft is written', async () => {
  /* Asked for by Luke, who built the same panel in his own CRM. The voice of a drafted
     email used to be a string inside grAiWrite, which meant the person who wanted it
     changed could not change it and nobody could tell what the rules even were.

     The trap this check exists to avoid: saving the row and never reading it. A settings
     screen that stores a tone the writer ignores looks completely correct from the
     outside -- the chip lights up, the row is in the database -- and changes nothing
     about a single email. So the last two checks read the prompt that actually leaves
     the browser, not the row that was saved. */
  await screen('gr_settings');
  await page.evaluate(() => document.querySelector('[data-gr-settab="reply"]')?.click());
  await page.waitForTimeout(900);

  const panel = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('[data-gr-reply-set]')];
    const box = (k) => document.querySelector('[data-gr-reply="' + k + '"]');
    const size = (el) => { const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) }; };
    return {
      tones: chips.filter(c => c.dataset.grReplySet === 'tone').map(c => c.textContent.trim()),
      lens: chips.filter(c => c.dataset.grReplySet === 'length').length,
      /* Measured, not counted. A chip the stylesheet collapsed is in the DOM and
         unpressable, which is the shape of bug this repo keeps shipping. */
      smallest: chips.length ? Math.min(...chips.map(c => size(c).w)) : 0,
      shortest: chips.length ? Math.min(...chips.map(c => size(c).h)) : 0,
      boxes: ['voice', 'always', 'never', 'steps', 'signoff'].filter(k => !!box(k)),
      pressed: chips.filter(c => c.getAttribute('aria-pressed') === 'true')
                    .map(c => c.dataset.grReplySet + '=' + c.dataset.v)
    };
  });
  check('the panel offers four tones and three lengths',
    panel.tones.length === 4 && panel.lens === 3, JSON.stringify(panel.tones));
  check('every chip is big enough to press',
    panel.smallest > 40 && panel.shortest > 14,
    JSON.stringify({ w: panel.smallest, h: panel.shortest }));
  check('and all five written rules have a box',
    panel.boxes.length === 5, panel.boxes.join(','));
  check('one tone and one length start chosen, so a draft is never styleless',
    panel.pressed.length === 2, panel.pressed.join(','));

  /* AND IT LOOKS CHOSEN. The check above reads aria-pressed, which is exactly what let
     the first version through: gr_chip had no selected rule at all, so Warm and Under
     60 words were marked chosen in the DOM and painted identically to the three beside
     them. Correct to anything reading attributes, unreadable to a person. Compare the
     colours actually computed, the way an eye would. */
  const look = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('[data-gr-reply-set="tone"]')];
    const on = chips.find(c => c.getAttribute('aria-pressed') === 'true');
    const off = chips.find(c => c.getAttribute('aria-pressed') !== 'true');
    if (!on || !off) return null;
    const g = (el) => { const s = getComputedStyle(el);
      return { bg: s.backgroundColor, fg: s.color }; };
    return { on: g(on), off: g(off) };
  });
  check('and the chosen chip is visibly different from the others',
    !!look && (look.on.bg !== look.off.bg || look.on.fg !== look.off.fg),
    JSON.stringify(look));

  await page.evaluate(() =>
    document.querySelector('[data-gr-reply-set="tone"][data-v="direct"]')?.click());
  await page.waitForTimeout(1200);
  const picked = await page.evaluate(() => ({
    row: ((window.__mockDB.growth_settings || []).find(x => x.key === 'reply_style') || {}).value || null,
    on: [...document.querySelectorAll('[data-gr-reply-set="tone"]')]
          .filter(c => c.getAttribute('aria-pressed') === 'true').map(c => c.dataset.v)
  }));
  /* Both sides. The row alone would pass with a screen that never repainted, and the
     screen alone would pass with nothing saved. */
  check('choosing a tone saves it and lights only that one',
    picked.row && picked.row.tone === 'direct' && picked.on.join(',') === 'direct',
    JSON.stringify({ saved: picked.row && picked.row.tone, on: picked.on }));

  const NEVER = 'Never mention the weather.';
  await page.fill('[data-gr-reply="never"]', NEVER);
  await page.evaluate(() => document.querySelector('[data-gr-reply="never"]')
    ?.dispatchEvent(new Event('change', { bubbles: true })));
  await page.waitForTimeout(1200);
  const typed = await page.evaluate(() =>
    ((window.__mockDB.growth_settings || []).find(x => x.key === 'reply_style') || {}).value || null);
  check('typing a rule saves it without losing the tone beside it',
    typed && typed.never === 'Never mention the weather.' && typed.tone === 'direct',
    JSON.stringify(typed && { never: typed.never, tone: typed.tone }));

  /* THE ONE THAT MATTERS. Everything above proves the panel works. This proves the
     panel is connected to anything. */
  let sysSeen = null;
  await page.route('**/claude-api', r => {
    try { sysSeen = (r.request().postDataJSON() || {}).system || ''; } catch (e) { sysSeen = ''; }
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ text: 'Hi there,\n\nDrafted.\n\nBest,' }) });
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await screen('gr_inbox');
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector('#grInbox [data-gr-act]')?.click());
  await page.waitForTimeout(1100);
  await page.evaluate(() => document.querySelector('[data-gr-ai="write"]')?.click());
  await page.waitForTimeout(1800);

  check('the house rules reach the model, not just the database',
    !!sysSeen && sysSeen.indexOf('direct and to the point') >= 0
             && sysSeen.indexOf(NEVER) >= 0,
    sysSeen ? JSON.stringify(sysSeen.slice(0, 120)) : 'no request captured');
  /* An empty rule written out as "Always cover: (not set)" is still an instruction, and
     the model does something with it. Boxes nobody filled in are left out entirely. */
  check('and a rule nobody filled in is left out rather than sent as empty',
    !!sysSeen && sysSeen.indexOf('(not set)') < 0 && sysSeen.indexOf('Always cover:\n\n') < 0,
    sysSeen ? 'clean' : 'no request captured');
  await page.unroute('**/claude-api');
});

await step('the reply is already written when you open the email', async () => {
  /* Luke's screen has the draft waiting; ours had a button you press and then watch.
     Three of these are about cost and staleness rather than about the card, because the
     card is the easy part:

       - asked ONCE, not per render. A draft regenerated on every repaint is a model
         call per keystroke somewhere else on the screen, and nothing on screen would
         look wrong while it happened.
       - never for a deal that is NOT waiting on us. Drafting a reply to a conversation
         where we spoke last is a paid-for answer to nothing.
       - gone when it goes stale. A draft answering Tuesday's question is wrong the
         moment Thursday's arrives, and a confident reply to a settled question is worse
         than no reply at all. */
  let asked = 0, sysSeen = null;
  await page.route('**/claude-api', r => {
    asked++;
    try { sysSeen = (r.request().postDataJSON() || {}).system || ''; } catch (e) {}
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ text: 'Hi Cesar,\n\nSending the agreement now.\n\nBest,' }) });
  });

  // gc-1 spoke last from our side; gc-2 is the one waiting on a reply.
  await screen('gr_pipeline');
  await page.evaluate(() => document.querySelector('[data-gr-open="gc-1"]')?.click());
  await page.waitForTimeout(1800);
  check('a deal that is not waiting on us is never drafted for',
    asked === 0, String(asked));
  await page.evaluate(() => document.querySelector('[data-gr-close]')?.click());
  await page.waitForTimeout(600);

  await page.evaluate(() => document.querySelector('[data-gr-open="gc-2"]')?.click());
  await page.waitForTimeout(2600);
  const made = await page.evaluate(() => {
    const d = (window.__mockDB.growth_clients || []).find(c => c.id === 'gc-2');
    const card = document.querySelector('.gr_draft');
    return {
      saved: d && d.reply_draft ? { msg: d.reply_draft.msg_id, sub: d.reply_draft.subject,
                                    body: String(d.reply_draft.body || '').slice(0, 20) } : null,
      on: !!(card && card.classList.contains('on')),
      says: card ? card.innerText.replace(/\s+/g, ' ').trim() : null,
      buttons: [...document.querySelectorAll('[data-gr-draft]')].map(b => b.textContent.trim())
    };
  });
  check('opening the deal writes a draft onto the ROW, not just the screen',
    !!made.saved && made.saved.msg === 'gx-3' && made.saved.body.length > 5,
    JSON.stringify(made.saved));
  check('and it answers their latest message, by id',
    made.saved && made.saved.msg === 'gx-3', made.saved && made.saved.msg);
  check('the card offers edit, regenerate and copy',
    made.buttons.join(',') === 'Edit and send,Regenerate,Copy', made.buttons.join(','));
  /* The whole risk of a ready-written reply is somebody assuming it already went. */
  check('and says on its face that nothing has been sent',
    !!made.says && /not sent/i.test(made.says), made.says ? made.says.slice(0, 60) : null);
  check('the house rules reach the drafted reply too, not only the composer',
    !!sysSeen && sysSeen.indexOf('HOUSE STYLE') >= 0, sysSeen ? 'yes' : 'no request');

  const askedAfterFirst = asked;
  /* Re-render the panel without changing anything. A draft regenerated per paint is
     the expensive bug that looks completely fine. */
  await page.evaluate(() => { if (typeof grRender === 'function') grRender(); });
  await page.waitForTimeout(400);
  await page.evaluate(() => { if (typeof grRender === 'function') grRender(); });
  await page.waitForTimeout(900);
  check('re-rendering does not write it again',
    asked === askedAfterFirst, asked + ' vs ' + askedAfterFirst);

  // Closing and reopening reads the stored draft rather than paying for a new one.
  await page.evaluate(() => document.querySelector('[data-gr-close]')?.click());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('[data-gr-open="gc-2"]')?.click());
  await page.waitForTimeout(1800);
  check('reopening reuses the stored draft instead of asking again',
    asked === askedAfterFirst, asked + ' vs ' + askedAfterFirst);

  /* THE ONE NO SCREEN SHOWS. A newer message from them makes the stored draft an
     answer to the wrong question. It has to stop being shown. */
  await page.evaluate(() => {
    window.__mockDB.growth_messages.push({
      id: 'gx-9', client_id: 'gc-2', direction: 'in', subject: 'One more thing',
      body: 'Actually, can we push the start date to January?',
      sent_at: new Date().toISOString(), thread_id: '', external_id: null,
      created_at: new Date().toISOString() });
    if (typeof window.grReload === 'function') window.grReload();
  });
  await page.waitForTimeout(2600);
  const stale = await page.evaluate(() => {
    const card = document.querySelector('.gr_draft');
    const d = (window.__mockDB.growth_clients || []).find(c => c.id === 'gc-2');
    return { shows: card ? card.innerText.replace(/\s+/g, ' ').trim() : null,
             storedMsg: d && d.reply_draft ? d.reply_draft.msg_id : null };
  });
  check('a newer message from them retires the old draft rather than showing it',
    !!stale.shows && !/Sending the agreement now/.test(stale.shows),
    stale.shows ? stale.shows.slice(0, 70) : 'no card');

  await page.unroute('**/claude-api');
});

await step('Meetings splits sales calls from onboarding calls', async () => {
  /* Calendly carries two event types now -- Growth Strategy Session and Kickoff Call --
     and they are two different jobs: a stranger you are selling to, and a client you
     have already won and are starting. Luke's screen splits on it.

     Derived from the title rather than stored, so it works on the 32 bookings already
     in the database instead of only on ones that arrive after a migration. */
  await screen('gr_meetings');
  await page.evaluate(() => { try { localStorage.removeItem('giant.grMKind'); } catch (e) {} });
  await page.evaluate(() => document.querySelector('[data-gr-mkind="all"]')?.click());
  await page.waitForTimeout(1200);

  const pills = await page.evaluate(() => [...document.querySelectorAll('[data-gr-mkind]')]
    .map(b => ({ k: b.dataset.grMkind, n: (b.querySelector('b') || {}).textContent,
                 on: b.getAttribute('aria-pressed') === 'true',
                 w: Math.round(b.getBoundingClientRect().width) })));
  check('there are three choices: all, sales and onboarding',
    pills.map(p => p.k).join(',') === 'all,sales,onboard', pills.map(p => p.k).join(','));
  check('each carries a count and is big enough to press',
    pills.every(p => /^\d+$/.test(String(p.n).trim()) && p.w > 90),
    JSON.stringify(pills.map(p => p.n + '/' + p.w)));
  /* One of each kind is in the fixtures, so a split that did nothing would show the
     same number three times. */
  const n = (k) => Number((pills.find(p => p.k === k) || {}).n);
  check('the counts actually differ, so the split is doing something',
    n('all') === n('sales') + n('onboard') && n('sales') > 0 && n('onboard') > 0,
    JSON.stringify({ all: n('all'), sales: n('sales'), onboard: n('onboard') }));

  const kinds = await page.evaluate(() => [...document.querySelectorAll('.gr_kt')]
    .map(x => x.textContent.trim()));
  check('every row says which kind of call it is',
    kinds.length > 0 && kinds.indexOf('Sales call') >= 0 && kinds.indexOf('Onboarding call') >= 0,
    kinds.join(','));
  /* The chip has to be readable, not merely present: a bare .gr_kt loses to
     `.gr_rm span`, which paints every span in a row grey. That shipped once. */
  const chip = await page.evaluate(() => {
    const el = document.querySelector('.gr_ktsales'); if (!el) return null;
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, fg: s.color };
  });
  check('and the chip is not the same grey as everything else on the row',
    !!chip && chip.fg === 'rgb(255, 255, 255)' && chip.bg !== 'rgba(0, 0, 0, 0)',
    JSON.stringify(chip));

  await page.evaluate(() => document.querySelector('[data-gr-mkind="sales"]')?.click());
  await page.waitForTimeout(1200);
  const filtered = await page.evaluate(() => ({
    shown: [...document.querySelectorAll('.gr_kt')].map(x => x.textContent.trim()),
    counts: [...document.querySelectorAll('[data-gr-mkind] b')].map(b => b.textContent.trim())
  }));
  check('choosing Sales calls hides the onboarding ones',
    filtered.shown.length > 0 && filtered.shown.every(t => t === 'Sales call'),
    filtered.shown.join(','));
  /* A filter that hides its own count is one you cannot tell is on. */
  check('and the counts keep counting everything, not just what is shown',
    filtered.counts.join(',') === pills.map(p => String(p.n).trim()).join(','),
    filtered.counts.join(',') + ' vs ' + pills.map(p => p.n).join(','));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await screen('gr_meetings');
  await page.waitForTimeout(1100);
  const kept = await page.evaluate(() => (document.querySelector('[data-gr-mkind][aria-pressed="true"]')
    || {}).dataset?.grMkind || null);
  check('the choice survives a reload, like the view tabs do', kept === 'sales', String(kept));

  /* Back to all, so nothing after this inherits a filtered screen. */
  await page.evaluate(() => { try { localStorage.removeItem('giant.grMKind'); } catch (e) {} });
  await page.evaluate(() => document.querySelector('[data-gr-mkind="all"]')?.click());
  await page.waitForTimeout(800);
});

await step('Sales SOPs: three processes, and a manager can change them', async () => {
  /* Luke asked for this twice in the same breath: "we can edit the SOPs as well.
     That's really important because I want to be able to change them." So the checks
     that matter are not that the screen draws -- they are that an edit reaches the
     database row, and that adding and removing a step works on content nobody wrote
     into this file. */
  await screen('gr_sops');
  await page.waitForTimeout(1300);

  const index = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.gr_soptile')];
    return {
      n: tiles.length,
      titles: tiles.map(t => (t.querySelector('b') || {}).textContent),
      /* Each process has its own colour, carried from the tile into the full screen.
         Three tiles the same colour would read as one thing in three parts. */
      colours: [...new Set(tiles.map(t => getComputedStyle(t).borderTopColor))].length,
      arrows: document.querySelectorAll('.gr_sopar').length
    };
  });
  check('the index is three processes in order',
    index.n === 3 && index.titles.join(' > ') === 'Before the call > During the call > After the call',
    index.titles.join(' > '));
  check('each with its own colour, and read as a flow',
    index.colours === 3 && index.arrows === 2,
    JSON.stringify({ colours: index.colours, arrows: index.arrows }));

  await page.evaluate(() => document.querySelector('[data-gr-sop="during"]')?.click());
  await page.waitForTimeout(1200);
  const full = await page.evaluate(() => ({
    hero: (document.querySelector('.gr_sophero h2') || {}).textContent,
    heroSize: Math.round(parseFloat(getComputedStyle(document.querySelector('.gr_sophero h2')).fontSize)),
    steps: [...document.querySelectorAll('.gr_sopcard b')].map(b => b.textContent),
    arrows: document.querySelectorAll('.gr_soparw').length,
    questions: document.querySelectorAll('.gr_sopq li').length
  }));
  check('opening one shows its steps in order, with arrows between',
    full.steps.length === 5 && full.arrows === 4 && full.steps[0] === 'Say hello and build rapport',
    JSON.stringify({ steps: full.steps.length, arrows: full.arrows }));
  check('and the ten questions to ask', full.questions === 10, String(full.questions));
  /* MEASURED, because twelve rules in this screen were written with a font shorthand
     naming a variable Giant does not define, and an invalid shorthand is dropped
     whole -- silently, and the screen still looked plausible. */
  check('the hero heading is the size the design asks for, not a dropped rule',
    full.heroSize >= 30, full.heroSize + 'px');

  await page.evaluate(() => document.querySelector('[data-gr-sopedit]')?.click());
  await page.waitForTimeout(1100);
  const before = await page.evaluate(() => document.querySelectorAll('[data-gr-sopf]').length);
  check('a manager can turn on editing', before > 10, String(before));

  await page.fill('[data-gr-sopf="during.steps.0.t"]', 'Say hello and mean it');
  await page.evaluate(() => document.querySelector('[data-gr-sopf="during.steps.0.t"]')
    ?.dispatchEvent(new Event('change', { bubbles: true })));
  await page.waitForTimeout(1300);
  const saved = await page.evaluate(() => {
    const r = (window.__mockDB.growth_settings || []).find(x => x.key === 'sops');
    return r && r.value && r.value.during ? r.value.during.steps[0].t : null;
  });
  /* The ROW, not the screen. A screen that paints the edit and never saves looks
     identical until somebody reloads. */
  check('changing a step writes it to the row',
    saved === 'Say hello and mean it', String(saved));
  /* And the rest of the process survived being rewritten around it. */
  const intact = await page.evaluate(() => {
    const r = (window.__mockDB.growth_settings || []).find(x => x.key === 'sops');
    return r && r.value && r.value.during
      ? { steps: r.value.during.steps.length, qs: r.value.during.questions.length,
          other: (r.value.before && r.value.before.steps || []).length }
      : null;
  });
  check('and nothing else in the SOP was lost on the way',
    intact && intact.steps === 5 && intact.qs === 10 && intact.other === 4,
    JSON.stringify(intact));

  await page.evaluate(() => document.querySelector('[data-gr-sopadd="during"]')?.click());
  await page.waitForTimeout(1300);
  const added = await page.evaluate(() => {
    const r = (window.__mockDB.growth_settings || []).find(x => x.key === 'sops');
    return r && r.value && r.value.during ? r.value.during.steps.length : -1;
  });
  check('adding a step adds one, to the row', added === 6, String(added));

  await page.evaluate(() => document.querySelector('[data-gr-sopdel="during.steps.5"]')?.click());
  await page.waitForTimeout(1300);
  const removed = await page.evaluate(() => {
    const r = (window.__mockDB.growth_settings || []).find(x => x.key === 'sops');
    return r && r.value && r.value.during ? r.value.during.steps.length : -1;
  });
  check('and removing one takes it away again', removed === 5, String(removed));
  /* A step somebody spent ten minutes writing is one click from gone, and the only
     other copy is in their head. */
  const undo = await page.evaluate(() => !!document.querySelector('#grToast [data-gr-undo]'));
  check('with an undo, because the only other copy is in somebody’s head',
    undo, String(undo));
});

await step('Growth is a named list, and the list can take it away', async () => {
  /* Luke asked for Growth to be "you, me, Matthew and Annie". The two people that takes
     it from are an owner and an in-house dev, both ABOVE the module's manager floor --
     so no role gate can express it, and the half of this that already existed could
     only ever add people.

     Driven by serving a doctored mock, because the gate runs once at sign-in off a row
     read before the first paint; setting the row afterwards proves nothing. */
  const withAccess = (list) => MOCK.replace('DB.growth_settings = [',
    'DB.growth_settings = [{ key: "access", value: ' + JSON.stringify(list) + ' },');

  const growthVisible = async () => page.evaluate(() => {
    const items = [...document.querySelectorAll('#appSidebar .nav-item[data-screen^="gr_"]')];
    const group = document.querySelector('[data-navgroup="growth"]');
    const shown = (el) => !!el && getComputedStyle(el).display !== 'none';
    return { items: items.filter(shown).length, group: shown(group) };
  });

  const reloadAs = async (mockBody) => {
    await page.unroute('**/@supabase/supabase-js@2*');
    await page.route('**/@supabase/supabase-js@2*', r =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: mockBody }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#view-app.on', { timeout: 30000 });
    await page.waitForTimeout(3600);
  };

  /* The signed-in account in the mock is u-me, an OWNER -- the case a role floor cannot
     catch, and exactly Kristina's. */
  await reloadAs(withAccess(['someone-else', 'another-person']));
  const off = await growthVisible();
  check('an owner who is not on the list loses the whole Growth group',
    off.items === 0 && !off.group, JSON.stringify(off));

  await reloadAs(withAccess(['u-me', 'someone-else']));
  const on = await growthVisible();
  check('and keeps it when they are on the list',
    on.items > 5 && on.group, JSON.stringify(on));

  /* FAILS OPEN on purpose. One bad row locking the sales team out of Growth is a worse
     day than one person seeing a tab they do not use. */
  await reloadAs(withAccess([]));
  const empty = await growthVisible();
  check('an empty list changes nothing, rather than hiding it from everybody',
    empty.items > 5 && empty.group, JSON.stringify(empty));

  // Back to the untouched mock so nothing after this inherits a doctored database.
  await reloadAs(MOCK);
  const back = await growthVisible();
  check('and with no list at all it behaves exactly as before',
    back.items > 5 && back.group, JSON.stringify(back));
});

await step('the course opens on the lesson you are up to', async () => {
  /* Every lesson used to start collapsed, so the first thing the screen asked of
     somebody starting the course was to work out where they were and click. Luke's
     opens the next unfinished one. */
  await screen('gr_training');
  /* Training remembers its sub-tab, and an earlier step leaves it on Q&A -- so without
     this the step measured a screen with no lessons on it at all and reported
     "0 lessons, none open", which is true and says nothing. */
  await page.evaluate(() => document.querySelector('[data-gr-traintab="course"]')?.click());
  await page.waitForTimeout(1400);
  const first = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.gr_cs')];
    const open = all.filter(l => l.classList.contains('gr_cson'));
    return { openCount: open.length, total: all.length,
             /* The body is really there, not just a class saying it is. */
             hasBody: !!(open[0] && open[0].querySelector('.gr_csb')),
             openIsFirst: !!(open[0] && all[0] && open[0] === all[0]) };
  });
  check('one lesson is open to begin with, not none',
    first.openCount === 1 && first.total > 1 && first.hasBody, JSON.stringify(first));
  check('and it is the one they have not done yet', first.openIsFirst, String(first.openIsFirst));

  /* THE TRAP. Defaulting the open lesson and clearing it to the same value on close
     makes it impossible to shut: the next paint reopens it. Closed has to be a
     different state from never-opened. */
  await page.evaluate(() => document.querySelector('.gr_cson [data-gr-lesson]')?.click());
  await page.waitForTimeout(700);
  await page.evaluate(() => { if (typeof grRender === 'function') grRender(); });
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => document.querySelectorAll('.gr_cson').length);
  /* first.openCount in the condition on purpose: with no lessons on screen this read
     0 === 0 and passed while measuring nothing, which is the exact shape of hollow
     pass the rest of this file exists to avoid. */
  check('closing it actually closes it, and it stays closed on the next paint',
    first.openCount === 1 && after === 0, first.openCount + ' -> ' + after);
});

await step('the world clock is a strip, and still says everything', async () => {
  /* Four 110px cards cost most of the first screenful on a screen whose job is the
     list underneath them. The risk in compacting it is losing what it was for, so
     this measures the two things that would quietly go: a clipped city name, and the
     offset that stops somebody booking a call at 3am their time. */
  await screen('gr_meetings');
  await page.waitForTimeout(900);
  const clk = await page.evaluate(() => {
    const strip = document.querySelector('.gr_wclkin');
    if (!strip) return null;
    const r = strip.getBoundingClientRect();
    const cities = [...document.querySelectorAll('.gr_wzc')];
    return {
      h: Math.round(r.height),
      zones: cities.length,
      clipped: cities.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent),
      titles: [...document.querySelectorAll('.gr_wz')].map(b => b.getAttribute('title') || ''),
      on: document.querySelectorAll('.gr_wzon').length
    };
  });
  check('all four zones are on one strip', !!clk && clk.zones === 4, clk && String(clk.zones));
  check('and it is a strip, not a row of cards', !!clk && clk.h < 70, clk && clk.h + 'px');
  check('no city name is cut off', !!clk && clk.clipped.length === 0,
    clk ? clk.clipped.join(',') || 'none' : 'no strip');
  /* The line Luke's strip drops. It moved to the hover rather than disappearing. */
  check('how far ahead or behind each zone is survives, on hover',
    !!clk && clk.titles.length === 4 && clk.titles.every(t => /ahead|behind|shown here|Same time/i.test(t)),
    clk ? JSON.stringify(clk.titles[1]) : 'none');
  check('exactly one zone is marked as the one times are shown in',
    !!clk && clk.on === 1, clk && String(clk.on));
});

for (const r of results) console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   ' + r.detail : ''));
const bad = results.filter(r => !r.pass);
console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' checks passed');
console.log(bad.length ? 'RESULT: ' + bad.length + ' FAILED' : 'RESULT: clean');
await browser.close();
server.close();
process.exit(bad.length ? 1 : 0);
