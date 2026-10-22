/* Analytics, measured.  Run:  node tools_growth_analytics_check.mjs
   (SHOT_DIR=/some/dir to also write screenshots of what it measured.)

   Analytics was four heroes and a funnel. The design has seven cards, and the four that
   were missing are the ones people actually ask for: how much is on the table, is
   anybody waiting on a reply, which calls happened, and who did we win.

   Every check below is a MEASUREMENT against the mock database, not a look for a
   heading, because a card that renders its title and then nothing is exactly the
   failure these would otherwise wave through:

     - the call log is counted against the meetings that have actually FINISHED, worked
       out here from starts_at and minutes rather than read off the screen. A log that
       lists next Tuesday is a calendar.
     - the weekly bars are measured in PIXELS. A bar that exists at 0px high is the trap
       this repo has fallen into before, and two bars of identical height would mean the
       booked/done split is not being drawn at all.
     - the money is summed here from the client rows and compared with what the card
       says, so a card wired to the wrong field fails rather than showing a confident
       wrong number.
*/
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

const shotDir = process.env.SHOT_DIR || '';
const shot = async (name) => { if (shotDir) await page.screenshot({ path: shotDir + '/' + name + '.png', fullPage: true }); };
const navOf = (s) => page.locator('#appSidebar .nav-item[data-screen="' + s + '"]');

// ── Analytics ────────────────────────────────────────────────────────────────
await step('open Growth and Analytics', async () => {
  await page.locator('.nav-group-label[data-navgroup="growth"]').click();
  await page.waitForTimeout(350);
  await navOf('gr_analytics').click();
  await page.waitForFunction(() => document.querySelectorAll('#grAnalytics .gr_card').length > 0,
    null, { timeout: 15000 }).catch(() => {});
  const n = await page.locator('#grAnalytics .gr_card').count();
  // Funnel, Money, Emails, Call log, Meetings per week, Wins.
  check('all six cards are on the page', n === 6, n + ' cards');
  const titles = await page.evaluate(() =>
    [...document.querySelectorAll('#grAnalytics .gr_ct h2')].map(h => h.textContent.trim()));
  check('and they are the six from the design',
    JSON.stringify(titles) === JSON.stringify(
      ['Sales funnel', 'Money', 'Emails and replies', 'Call log', 'Meetings per week', 'Wins']),
    JSON.stringify(titles));
  await shot('20-analytics');
});

await step('the four heroes are about calls, not emails', async () => {
  const h = await page.evaluate(() => [...document.querySelectorAll('#grAnalytics .gr_hero')]
    .map(x => ({ v: x.querySelector('.gr_hv').textContent.trim(),
                 l: x.querySelector('.gr_hl').textContent.trim(),
                 s: x.querySelector('.gr_hs').textContent.trim() })));
  check('there are four of them', h.length === 4, JSON.stringify(h.map(x => x.l)));
  check('the labels match the design',
    JSON.stringify(h.map(x => x.l)) ===
    JSON.stringify(['Meetings booked', 'Calls done', 'Average call', 'Clients won']),
    JSON.stringify(h.map(x => x.l)));
  // gm-2 ran 41 minutes and is the only finished call, so the average IS 41 -- and it
  // comes from actual_min, not from the 45 it was booked for. A hero reading 45 would
  // mean the real length is being ignored.
  check('the average call is the real length, not the booked one',
    h[2] && /^41/.test(h[2].v), h[2] && h[2].v);
  check('and the longest call says the same', h[2] && /41 min/.test(h[2].s), h[2] && h[2].s);
  check('hours talking is worked out from it', h[1] && /0\.7 hours/.test(h[1].s), h[1] && h[1].s);
});

await step('the money card adds up to the pipeline', async () => {
  const m = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#grAnalytics .gr_card')]
      .find(c => (c.querySelector('h2') || {}).textContent === 'Money');
    if (!card) return null;
    const big = [...card.querySelectorAll('.gr_mny > div')]
      .map(d => ({ v: d.querySelector('b').textContent.trim(), l: d.querySelector('span').textContent.trim() }));
    const rows = [...card.querySelectorAll('.gr_sr')].map(r => ({
      label: r.querySelector('span').textContent.trim(),
      n: r.querySelector('b').textContent.trim(),
      money: r.querySelector('em').textContent.trim(),
      dot: getComputedStyle(r.querySelector('i')).backgroundColor,
      dotW: Math.round(r.querySelector('i').getBoundingClientRect().width)
    }));
    // What the card SHOULD say, from the rows the app loaded.
    const cs = window.__mockDB.growth_clients;
    const live = cs.filter(c => c.stage !== 'won' && c.stage !== 'lost')
      .reduce((n, c) => n + (Number(c.value_monthly) || 0), 0);
    return { big, rows, live };
  });
  check('the money card rendered', !!m && m.big.length === 3, JSON.stringify(m && m.big));
  if (!m) return;
  const inPlay = Number((m.big[0].v || '').replace(/[^0-9]/g, ''));
  check('"in play" is the sum of every open deal, not of all of them',
    inPlay === m.live, inPlay + ' vs ' + m.live);
  check('there is one row per stage, lost left off', m.rows.length >= 4, JSON.stringify(m.rows.map(r => r.label)));
  // A colour dot that exists at 0px wide passed a check in this repo once. Measure it.
  check('every stage dot is actually drawn', m.rows.every(r => r.dotW >= 8),
    JSON.stringify(m.rows.map(r => r.dotW)));
  check('and they are not all the same colour',
    new Set(m.rows.map(r => r.dot)).size > 1, JSON.stringify(m.rows.map(r => r.dot)));
});

await step('the emails card knows who is waiting', async () => {
  const e = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#grAnalytics .gr_card')]
      .find(c => (c.querySelector('h2') || {}).textContent === 'Emails and replies');
    if (!card) return null;
    const expectedWaiting = window.__mockDB.growth_clients.filter(c => {
      const th = window.__mockDB.growth_messages.filter(m => m.client_id === c.id)
        .sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));
      const l = th[th.length - 1];
      return l && l.direction === 'in' && c.handled_msg !== l.id;
    }).length;
    return {
      big: [...card.querySelectorAll('.gr_mny > div')].map(d => d.querySelector('b').textContent.trim()),
      rw: (card.querySelector('.gr_rw') || {}).textContent || '',
      rows: [...card.querySelectorAll('.gr_cl')].length,
      expectedWaiting
    };
  });
  check('the emails card rendered', !!e && e.big.length === 3, JSON.stringify(e && e.big));
  if (!e) return;
  check('the waiting line counts the unanswered replies',
    e.rw.indexOf(e.expectedWaiting + ' waiting on you') === 0 ||
    (e.expectedWaiting === 0 && /Everyone has an answer/.test(e.rw)),
    e.rw + ' / expected ' + e.expectedWaiting);
  check('the reply rate is a percentage', /%$/.test(e.big[2]), e.big[2]);
  check('and the latest replies are listed under it', e.rows > 0, e.rows + ' rows');
});

await step('the call log lists calls that have already happened', async () => {
  const l = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#grAnalytics .gr_card')]
      .find(c => (c.querySelector('h2') || {}).textContent === 'Call log');
    if (!card) return null;
    const rows = [...card.querySelectorAll('.gr_cl')].map(r => ({
      date: (r.querySelector('.gr_cld') || {}).textContent,
      who: (r.querySelector('b') || {}).textContent,
      len: (r.querySelector('.gr_cll') || {}).textContent,
      stage: (r.querySelector('.gr_stc') || {}).textContent,
      opens: r.getAttribute('data-gr-open')
    }));
    // Worked out here rather than read off the screen: a finished meeting is one whose
    // start plus its length is in the past.
    const finished = window.__mockDB.growth_meetings.filter(m =>
      new Date(m.starts_at).getTime() + (m.minutes || 45) * 60000 < Date.now()).length;
    return { rows, finished };
  });
  check('the call log rendered', !!l, '');
  if (!l) return;
  check('it has a row for each finished call and no more',
    l.rows.length === l.finished, l.rows.length + ' rows vs ' + l.finished + ' finished');
  check('the one that has happened is listed', l.rows.length > 0 && /Michael/.test(l.rows[0].who || ''),
    JSON.stringify(l.rows[0]));
  check('with the length it actually ran', l.rows.length > 0 && l.rows[0].len === '41 min',
    l.rows[0] && l.rows[0].len);
  check('and the stage it is at now', l.rows.length > 0 && !!(l.rows[0].stage || '').trim(),
    l.rows[0] && l.rows[0].stage);
  check('a row opens the deal', l.rows.length > 0 && !!l.rows[0].opens, l.rows[0] && l.rows[0].opens);
});

await step('a call-log row opens that client', async () => {
  const id = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#grAnalytics .gr_card')]
      .find(c => (c.querySelector('h2') || {}).textContent === 'Call log');
    const r = card && card.querySelector('.gr_cl');
    return r ? r.getAttribute('data-gr-open') : null;
  });
  if (!id) { check('a call-log row opens that client', false, 'no row'); return; }
  await page.locator('#grAnalytics .gr_card:nth-of-type(4) .gr_cl').first().click();
  await page.waitForTimeout(500);
  const open = await page.evaluate(() => ({
    on: document.getElementById('grSheet').classList.contains('on'),
    name: (document.querySelector('#grSheet .gr_sheet h2, #grSheet .gr_sh b') || {}).textContent
  }));
  check('a call-log row opens that client', open.on, JSON.stringify(open));
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
});

await step('the weekly bars are drawn, and the two of them differ', async () => {
  const w = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#grAnalytics .gr_card')]
      .find(c => (c.querySelector('h2') || {}).textContent === 'Meetings per week');
    if (!card) return null;
    const weeks = [...card.querySelectorAll('.gr_wk')].map(k => ({
      n: k.querySelector('b').textContent.trim(),
      label: k.querySelector('span').textContent.trim(),
      bars: [...k.querySelectorAll('.gr_bars i')].map(i => Math.round(i.getBoundingClientRect().height))
    }));
    return { weeks, legend: card.querySelectorAll('.gr_leg').length };
  });
  check('six weeks are shown', !!w && w.weeks.length === 6, w && w.weeks.length + '');
  if (!w) return;
  check('each week draws two bars', w.weeks.every(k => k.bars.length === 2),
    JSON.stringify(w.weeks.map(k => k.bars)));
  // The measurement that matters: a bar present at 0px is the bug this repo has shipped.
  check('every bar has real height', w.weeks.every(k => k.bars.every(h => h >= 3)),
    JSON.stringify(w.weeks.map(k => k.bars)));
  const last = w.weeks[5];
  // One call five days ago, one later today. A chart whose week stops at this moment
  // loses the second and draws two identical bars, which is the bug worth catching.
  check('this week has both meetings on it', last.n === '2', JSON.stringify(last));
  check('and booked is taller than done, because one is still to come',
    last.bars[0] > last.bars[1], JSON.stringify(last.bars));
  check('the legend names both colours', w.legend === 2, w.legend + '');
});

await step('wins, and the range changes what is counted', async () => {
  const winsOf = () => page.evaluate(() => {
    const card = [...document.querySelectorAll('#grAnalytics .gr_card')]
      .find(c => (c.querySelector('h2') || {}).textContent === 'Wins');
    if (!card) return null;
    return { sub: (card.querySelector('.gr_ct span') || {}).textContent.trim(),
             rows: [...card.querySelectorAll('.gr_cl')].map(r => ({
               who: (r.querySelector('b') || {}).textContent,
               money: (r.querySelector('.gr_wv') || {}).textContent })),
             empty: !!card.querySelector('.gr_mute') };
  });
  await page.locator('#grAnalytics [data-gr-range="all"]').click();
  await page.waitForTimeout(450);
  const all = await winsOf();
  const wonRows = await page.evaluate(() =>
    window.__mockDB.growth_clients.filter(c => c.stage === 'won').length);
  check('all time lists every won deal', all && all.rows.length === wonRows,
    JSON.stringify(all && all.rows) + ' vs ' + wonRows);
  check('with the monthly value on it', all && all.rows.length > 0 && /\/mo$/.test(all.rows[0].money),
    all && all.rows[0] && all.rows[0].money);
  check('and the subtitle says so', all && all.sub === 'All time', all && all.sub);

  await page.locator('#grAnalytics [data-gr-range="week"]').click();
  await page.waitForTimeout(450);
  const week = await winsOf();
  check('7 days says This period', week && week.sub === 'This period', week && week.sub);
  // The deal was won two days ago, so 7 days must still show it. A card that quietly
  // ignores the range would look identical on the All time pass, so both are checked.
  check('a win from two days ago is still inside 7 days',
    week && week.rows.length === all.rows.length, JSON.stringify(week && week.rows));

  // Now push that win outside the window and reload from the database. This is the
  // measurement the range exists for: the row must leave, and the card must say why
  // it is empty rather than leaving a titled rectangle with nothing in it.
  await page.evaluate(() => {
    const c = window.__mockDB.growth_clients.find(x => x.stage === 'won');
    c.won_on = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
  });
  await page.evaluate(() => window.grReload());
  await page.waitForTimeout(700);
  const gone = await winsOf();
  check('a win outside the range drops out of the list',
    gone && gone.rows.length === 0, JSON.stringify(gone && gone.rows));
  check('and the card says why it is empty rather than showing nothing',
    gone && gone.empty, JSON.stringify(gone));
  // 30 days still has it, so the row left because of the range and not because the
  // reload lost it.
  await page.locator('#grAnalytics [data-gr-range="month"]').click();
  await page.waitForTimeout(450);
  const month = await winsOf();
  check('and 30 days still has it, so it was the range that moved it',
    month && month.rows.length === 1, JSON.stringify(month && month.rows));
  await shot('21-analytics-week');
  // The app scrolls an inner container, so a full-page shot still stops at the fold.
  // Scroll it to the bottom to look at the bars and the wins.
  await page.evaluate(() => {
    const el = document.getElementById('grAnalytics');
    const sc = el && el.closest('.screen, .gr_wrap, main') || el;
    let n = el; while (n && n.scrollHeight <= n.clientHeight + 4) n = n.parentElement;
    if (n) n.scrollTop = n.scrollHeight;
    return sc ? 1 : 0;
  });
  await page.waitForTimeout(400);
  await shot('22-analytics-bottom');
  await page.locator('#grAnalytics [data-gr-range="all"]').click();
  await page.waitForTimeout(400);
});

/* The second view. Fathom is not connected, so the list is a sample -- which makes it
   all the more important that the screen SAYS so, and that the parts that will carry
   real data (the search, the weekly bars, the per-person tally) actually work now
   rather than being drawn once and discovered broken on the day the data arrives. */
await step('Analytics has a second view for the calls', async () => {
  await page.locator('#grAnalytics [data-gr-anview="fathom"]').click();
  await page.waitForTimeout(500);
  const m = await page.evaluate(() => {
    const el = document.getElementById('grAnalytics');
    return {
      sub: (el.querySelector('.gr_sub, .gr_hd p, header p') || {}).textContent || el.innerText.slice(0, 120),
      sample: !!el.querySelector('.gr_samp'),
      heroes: [...el.querySelectorAll('.gr_hero .gr_hl')].map(x => x.textContent.trim()),
      cards: [...el.querySelectorAll('.gr_ct h2')].map(x => x.textContent.trim()),
      rows: el.querySelectorAll('.gr_fc').length,
      count: (el.querySelector('[data-gr-anview="fathom"] b') || {}).textContent,
      search: !!document.getElementById('grFcQ')
    };
  });
  check('it says plainly that these are sample calls', m.sample);
  check('the three cards are there',
    JSON.stringify(m.cards) === JSON.stringify(['Calls per week', 'By salesperson', 'All sales calls']),
    JSON.stringify(m.cards));
  check('with four heroes above them', m.heroes.length === 4, JSON.stringify(m.heroes));
  check('the tab carries the number of calls', Number(m.count) > 0, m.count);
  check('and the list is rendered', m.rows > 0, m.rows + ' rows');
  check('there is a search box', m.search);
  await shot('23-fathom');
});

await step('the per-week bars and the per-person tally add up', async () => {
  const m = await page.evaluate(() => {
    const el = document.getElementById('grAnalytics');
    const weeks = [...el.querySelectorAll('.gr_wk')].map(k => ({
      n: Number(k.querySelector('b').textContent),
      h: Math.round(k.querySelector('.gr_bars i').getBoundingClientRect().height)
    }));
    const reps = [...el.querySelectorAll('.gr_sr')].map(r => ({
      who: r.querySelector('span').textContent.trim(), n: Number(r.querySelector('b').textContent) }));
    return { weeks, reps, total: Number((el.querySelector('[data-gr-anview="fathom"] b') || {}).textContent) };
  });
  check('eight weeks of bars', m.weeks.length === 8, m.weeks.length + '');
  // Pixels, not presence: a bar at 0px high has passed a check in this repo before.
  check('a week with calls draws a taller bar than a week without',
    Math.max(...m.weeks.map(w => w.h)) > Math.min(...m.weeks.map(w => w.h)) ||
    m.weeks.every(w => w.n === m.weeks[0].n), JSON.stringify(m.weeks));
  check('the busiest week has the tallest bar',
    m.weeks.reduce((a, b) => a.n >= b.n ? a : b).h === Math.max(...m.weeks.map(w => w.h)),
    JSON.stringify(m.weeks));
  check('every salesperson in the list is named', m.reps.length > 0 && m.reps.every(r => r.who.length > 1),
    JSON.stringify(m.reps));
  // The per-person counts must account for every call, or one of them is being dropped.
  check('their calls add up to the total',
    m.reps.reduce((n, r) => n + r.n, 0) === m.total,
    m.reps.reduce((n, r) => n + r.n, 0) + ' vs ' + m.total);
});

await step('the search actually filters, and the caret stays put', async () => {
  const before = await page.locator('#grAnalytics .gr_fc').count();
  const who = await page.evaluate(() => {
    const r = document.querySelector('#grAnalytics .gr_fc .gr_cll');
    return r ? r.textContent.trim() : '';
  });
  await page.locator('#grFcQ').click();
  await page.keyboard.type(who.slice(0, 5));
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => ({
    rows: document.querySelectorAll('#grAnalytics .gr_fc').length,
    value: (document.getElementById('grFcQ') || {}).value,
    caret: (document.getElementById('grFcQ') || {}).selectionStart,
    focused: document.activeElement && document.activeElement.id,
    // Every row left should be that person's.
    allTheirs: [...document.querySelectorAll('#grAnalytics .gr_fc')]
      .every(r => (r.textContent || '').toLowerCase().includes(document.getElementById('grFcQ').value.toLowerCase()))
  }));
  // Typing five letters into a box that re-renders every keystroke: without putting the
  // caret back, the letters land in reverse and the value comes out scrambled.
  check('the five letters typed arrive in the order they were typed',
    after.value === who.slice(0, 5), after.value + ' vs ' + who.slice(0, 5));
  check('the caret is still at the end', after.caret === 5, after.caret + '');
  check('and the box still has focus', after.focused === 'grFcQ', after.focused);
  check('the list is shorter than it was', after.rows < before, after.rows + ' of ' + before);
  check('and every row left matches what was typed', after.allTheirs);
  await page.locator('#grFcQ').fill('');
  await page.waitForTimeout(400);
});

await step('Show 40 more adds to the list, and switching back resets it', async () => {
  const first = await page.locator('#grAnalytics .gr_fc').count();
  check('the list is capped to start with', first === 40, first + '');
  await page.locator('#grAnalytics [data-gr-fcmore]').click();
  await page.waitForTimeout(450);
  const second = await page.locator('#grAnalytics .gr_fc').count();
  check('and the button shows the rest', second > first, second + ' after ' + first);
  await page.locator('#grAnalytics [data-gr-anview="sales"]').click();
  await page.waitForTimeout(450);
  const sales = await page.evaluate(() =>
    [...document.querySelectorAll('#grAnalytics .gr_ct h2')].map(x => x.textContent.trim()));
  check('switching back shows the sales screen again',
    sales[0] === 'Sales funnel', JSON.stringify(sales));
  check('and the range chips came with it',
    await page.locator('#grAnalytics [data-gr-range]').count() === 3);
});

await step('nothing raw reaches the screen', async () => {
  const raw = await page.evaluate(() => {
    const t = document.getElementById('grAnalytics').innerText || '';
    return (t.match(/&[a-z]+;|undefined|NaN|\[object/g) || []).slice(0, 5);
  });
  check('no raw entity, undefined or NaN on Analytics', raw.length === 0, JSON.stringify(raw));
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
