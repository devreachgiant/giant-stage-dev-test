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
  check('the boot read still leaves the 364KB out', /key neq qa_examples/.test(q[0] || ''),
    JSON.stringify(q));
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

/* ---------------------------------------------------------------- the practice call */
// Read off the DATABASE rows, not the screen: a run that paints a score and never files
// it looks identical until you reload.
const runs = () => page.evaluate(() => (window.__mockDB.growth_practice_runs || [])
  .map(r => ({ owner: r.owner_id, area: r.area, score: Number(r.score) })));

await step('the picker says how you have done, per area', async () => {
  await page.evaluate(() => document.querySelector('[data-gr-traintab="practice"]')?.click());
  await page.waitForTimeout(1400);
  const m = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('[data-gr-prac-start]')].map(b => ({
      id: b.dataset.grPracStart,
      text: b.textContent.replace(/\s+/g, ' ').trim(),
      w: Math.round(b.getBoundingClientRect().width)
    }))
  }));
  const open  = m.cards.find(c => /Opening the call/.test(c.text));
  const worry = m.cards.find(c => /Handling worries/.test(c.text));
  check('both areas are offered', !!open && !!worry, JSON.stringify(m.cards.map(c => c.id)));
  // Two runs at 6 and 8 are seeded, so the average is a real number, not a placeholder.
  check('an area that has been practised shows its average', !!open && /7\.0 out of 10/.test(open.text), open && open.text);
  check('and one that has not says so', !!worry && /Not tried yet/.test(worry.text), worry && worry.text);
  check('the cards are a readable size', !!open && open.w > 180, String(open && open.w));

  const weak = m.cards.find(c => /Start with my weakest/.test(c.text));
  /* Never practised beats practised badly. 'open' averages 7 and 'worry' has never been
     tried, so the one you are avoiding is the one to offer -- picking the lower average
     would send you back to the thing you already do. */
  check('and the weakest offered is the one never tried, not the lower average',
    !!weak && /Handling worries/.test(weak.text), weak && weak.text);
});

await step('a call opens on what the prospect says, and keeps the answer back', async () => {
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-gr-prac-start]')]
      .find(x => /Handling worries/.test(x.textContent) && !/weakest/.test(x.textContent));
    if (b) b.click();
  });
  await page.waitForTimeout(1100);
  const m = await page.evaluate(() => {
    const box = document.querySelector('.gr_rmsgs');
    const b = box ? box.getBoundingClientRect() : null;
    const say = document.querySelector('#grRoomSay');
    return {
      lines: [...document.querySelectorAll('.gr_rmb')].map(e => e.textContent.trim()),
      h: b ? Math.round(b.height) : 0, w: b ? Math.round(b.width) : 0,
      sayFont: say ? getComputedStyle(say).fontSize : null,
      sayH: say ? Math.round(say.getBoundingClientRect().height) : 0,
      body: document.body.textContent
    };
  });
  check('the prospect speaks first, from the scenario',
    m.lines.length === 1 && /more than another agency quoted me/.test(m.lines[0]), JSON.stringify(m.lines));
  check('the call is a size you can hold a conversation in', m.h > 150 && m.w > 300,
    JSON.stringify({ w: m.w, h: m.h }));
  // 16px or iOS zooms the page the moment you tap to type.
  check('typing will not zoom the page', m.sayFont && parseFloat(m.sayFont) >= 16, m.sayFont);
  check('and the box is big enough to type into', m.sayH >= 44, String(m.sayH));
  /* THE WHOLE POINT. The strong answer is in the scenario and must not be on screen
     while you are answering -- shown first, this screen is reading, which is the thing
     it exists to replace. */
  check('the strong answer is NOT on screen during the call',
    m.body.indexOf('What did that other quote include?') < 0, 'leaked');
});

await step('three replies end the call and score it', async () => {
  const before = (await runs()).length;
  for (const line of ['That makes sense to check. What did that quote include?',
                      'We charge for the management, and the ad spend stays yours.',
                      'Shall I send you the plan today?']) {
    await page.fill('#grRoomSay', line);
    await page.evaluate(() => document.querySelector('[data-gr-prac-send]')?.click());
    await page.waitForTimeout(1400);
  }
  await page.waitForTimeout(2500);
  const m = await page.evaluate(() => {
    const ring = document.querySelector('.gr_ring b');
    const r = document.querySelector('.gr_ring');
    return { score: ring ? ring.textContent : null,
             ringW: r ? Math.round(r.getBoundingClientRect().width) : 0,
             skills: [...document.querySelectorAll('.gr_skills > div > span')].map(e => e.textContent.trim()),
             // The SECOND note is "Change next time". The first is "Went well", and
             // reading both as one list let this pass while the advice half was empty.
             change: [...document.querySelectorAll('.gr_rep .gr_two .gr_note')].slice(1, 2)
               .flatMap(n => [...n.querySelectorAll('p')].map(e => e.textContent.trim())),
             body: document.body.textContent };
  });
  check('a score comes back', !!m.score && /^\d+(\.\d)?$/.test(m.score), String(m.score));
  check('the ring is drawn, not a 0px circle', m.ringW > 60, String(m.ringW));
  check('with the five skills scored', m.skills.length === 5, JSON.stringify(m.skills));
  check('and something to change', m.change.length > 0, JSON.stringify(m.change.slice(0, 2)));
  /* AFTER the score, the strong answer is the lesson. Before it, it was the spoiler. */
  check('now the strong answer is shown',
    m.body.indexOf('What did that other quote include?') >= 0, 'missing');
  /* It was printed twice: the local scorer filled "a stronger way to say it" with the
     scenario's model opener, which is already shown under its own heading. */
  check('and only once', (m.body.match(/What did that other quote include\?/g) || []).length === 1,
    String((m.body.match(/What did that other quote include\?/g) || []).length));

  const after = await runs();
  check('the run was filed', after.length === before + 1, JSON.stringify({ before, after: after.length }));
  const fresh = after.find(r => r.area === 'worry');
  check('under the right area, owned by the person who did it',
    !!fresh && fresh.area === 'worry' && !!fresh.owner, JSON.stringify(fresh));
  check('and with the score that was shown', !!fresh && String(fresh.score) === String(parseFloat(m.score)),
    JSON.stringify({ row: fresh && fresh.score, screen: m.score }));
});

await step('and the picker counts it from then on', async () => {
  await page.evaluate(() => document.querySelector('[data-gr-prac-end]')?.click());
  await page.waitForTimeout(1200);
  const txt = await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-gr-prac-start]')]
      .find(x => /Handling worries/.test(x.textContent) && !/weakest/.test(x.textContent));
    return b ? b.textContent.replace(/\s+/g, ' ').trim() : null;
  });
  check('the area that was just practised is no longer untried',
    !!txt && !/Not tried yet/.test(txt) && /1 call/.test(txt), String(txt));
});

await step('the scenarios edit here, like every other Training page', async () => {
  /* Lessons, clear answers and the questions all edit inline on this screen. Scenarios
     living only in the database would be the one piece of Training content a manager has
     to ask a developer about, which is how the pricing page ended up hard-coded before. */
  const read = () => page.evaluate(() => {
    const r = (window.__mockDB.growth_settings || []).find(x => x.key === 'practice');
    return r && r.value && r.value.areas ? r.value.areas : null;
  });
  const before = await read();
  await page.evaluate(() => document.querySelector('[data-gr-pa-edit="worry"]')?.click());
  await page.waitForTimeout(900);
  const fields = await page.evaluate(() => ({
    t: (document.querySelector('[data-gr-pa="t"]') || {}).value,
    lines: (document.querySelector('[data-gr-pa="s"]') || {}).value
  }));
  check('the editor opens on what is there', fields.t === 'Handling worries', String(fields.t));
  check('with the openers as one line each, split by ::',
    /quoted me\. :: That makes sense/.test(fields.lines || ''), String(fields.lines).slice(0, 80));

  await page.fill('[data-gr-pa="s"]',
    'They have gone quiet on me. :: Ask what changed since the call.\nI need to speak to my partner. :: Ask what the partner would want to know.');
  await page.fill('[data-gr-pa="t"]', 'Handling worries and stalls');
  await page.evaluate(() => document.querySelector('[data-gr-pa-save="worry"]')?.click());
  await page.waitForTimeout(1500);

  const after = await read();
  const a2 = (after || []).find(x => x.id === 'worry');
  check('the name is saved', a2 && a2.t === 'Handling worries and stalls', a2 && a2.t);
  check('and both openers round trip into the row',
    a2 && (a2.s || []).length === 2 && a2.s[0].p === 'They have gone quiet on me.' &&
    a2.s[1].b === 'Ask what the partner would want to know.', JSON.stringify(a2 && a2.s));
  /* Same merge rule as the questions. `source` is deliberately NOT on the form: an
     earlier version of this check asserted `who`, which the form DOES write back, so it
     passed happily against a rebuild. A check that only looks at fields the form shows
     cannot see a rebuild drop anything. */
  check('and a field the form never shows survives the save',
    a2 && a2.source === 'Luke, from a real call', String(a2 && a2.source));

  const shown = await page.evaluate(() => ({
    editorGone: !document.querySelector('[data-gr-pa="t"]'),
    card: [...document.querySelectorAll('.gr_pick')].map(b => b.textContent).join(' ')
  }));
  check('the form is put away on save', shown.editorGone, String(shown.editorGone));
  check('and the picker shows the new name straight away',
    /Handling worries and stalls/.test(shown.card), shown.card.slice(0, 60));

  // And the call that follows uses the new openers, not the ones it was seeded with.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-gr-prac-start]')]
      .find(x => /Handling worries and stalls/.test(x.textContent) && !/weakest/.test(x.textContent));
    if (b) b.click();
  });
  await page.waitForTimeout(1100);
  const line = await page.evaluate(() =>
    (document.querySelector('.gr_rmb') || {}).textContent || '');
  check('a call started from it opens on one of the new openers',
    /gone quiet on me|speak to my partner/.test(line), line);
  await page.evaluate(() => document.querySelector('[data-gr-prac-end]')?.click());
  await page.waitForTimeout(600);
});

await step('Pricing is off the Training strip but not orphaned', async () => {
  await screen('gr_training');
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('[data-gr-traintab]')].map(b => b.dataset.grTraintab));
  check('Pricing is not a tab any more', tabs.indexOf('pricing') < 0, tabs.join(','));
  check('the other five are', ['course', 'practice', 'clear', 'lib', 'qa'].every(t => tabs.indexOf(t) >= 0),
    tabs.join(','));
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
     confusing: Practice is a tab of its own now, so a button called Practice inside
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
  /* Adding Practice made six tabs. .gr_seg was inline-flex with no wrap and no scroll,
     so the sixth -- Pricing -- was CLIPPED by the screen edge and could not be reached
     at all. Nothing looked wrong from a desktop, and the page did not even scroll
     sideways to hint at it, which is why this is measured against the viewport rather
     than eyeballed. */
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
  check('all five tabs are rendered', !!m && m.names.length === 5, JSON.stringify(m && m.names));
  check('the strip scrolls rather than clipping what will not fit', !!m && !m.clipped, String(m && m.clipped));
  check('so the last tab can actually be reached', !!m && m.lastVisible, String(m && m.lastVisible));
  check('and the page itself does not scroll sideways', !!m && !m.pageSideways, String(m && m.pageSideways));

  // The call screen is the one you would actually use on a phone.
  await pp.evaluate(() => document.querySelector('[data-gr-traintab="practice"]')?.click());
  await pp.waitForTimeout(1200);
  await pp.evaluate(() => {
    const b = [...document.querySelectorAll('[data-gr-prac-start]')].find(x => !/weakest/.test(x.textContent));
    if (b) b.click();
  });
  await pp.waitForTimeout(1200);
  const room = await pp.evaluate(() => {
    const t = document.querySelector('#grRoomSay'), s = document.querySelector('[data-gr-prac-send]');
    const tb = t ? t.getBoundingClientRect() : null, sb = s ? s.getBoundingClientRect() : null;
    return { tw: tb ? Math.round(tb.width) : 0, th: tb ? Math.round(tb.height) : 0,
             sendOn: sb ? sb.right <= innerWidth + 1 : false,
             font: t ? getComputedStyle(t).fontSize : null,
             sideways: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  check('you can type a reply on a phone', room.tw > 150 && room.th >= 44, JSON.stringify(room));
  check('and reach Send', room.sendOn, String(room.sendOn));
  check('without the page zooming when you tap', room.font && parseFloat(room.font) >= 16, room.font);
  check('and nothing runs off the side', !room.sideways, String(room.sideways));
  await ph.close();
});

for (const r of results) console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   ' + r.detail : ''));
const bad = results.filter(r => !r.pass);
console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' checks passed');
console.log(bad.length ? 'RESULT: ' + bad.length + ' FAILED' : 'RESULT: clean');
await browser.close();
server.close();
process.exit(bad.length ? 1 : 0);
