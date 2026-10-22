/* Training, measured.  Run:  node tools_growth_training_check.mjs
   (SHOT_DIR=/some/dir to also write screenshots of what it measured.)

   Training was a personal task list, a philosophy page and a call script. It is now the
   sales course: seven lessons with progress per person, the clear answers, the best
   calls and the questions people ask. The three static tools are clean on a Training
   screen that renders a blank rectangle, so every check below is a MEASUREMENT, chosen
   so it FAILS on what was there before:

     - the tab strip said Plan / Calls to watch / Philosophy / Call script / Pricing.
       Reading the five labels is the check that could not have passed a week ago.
     - marking a lesson done is read back from the DATABASE, not from the screen. A
       check that set a flag on the row while the code read a cache measured nothing
       and passed; this reads the row the app actually wrote, and the owner_id on it.
     - the permission split is the point of the whole change, so it is driven twice:
       once as an inhouse dev, once as a member, counting the controls each one is
       offered. Hiding a button is only half of it -- 20261022120000 and its check
       prove the other half, which is that the database says no as well.
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
const shot = async (name) => { if (shotDir) await page.screenshot({ path: shotDir + '/' + name + '.png' }); };
const navOf = (s) => page.locator('#appSidebar .nav-item[data-screen="' + s + '"]');
const tabOf = (t) => page.locator('#grTraining [data-gr-traintab="' + t + '"]');

await step('open Growth and Training', async () => {
  await page.locator('.nav-group-label[data-navgroup="growth"]').click();
  await page.waitForTimeout(350);
  await navOf('gr_training').click();
  await page.waitForFunction(() => {
    const el = document.getElementById('grTraining');
    return el && el.innerHTML.length > 400;
  }, null, { timeout: 15000 }).catch(() => {});
  check('Training paints', await page.locator('#grTraining .gr_seg button').count() > 0);
  await shot('10-course');
});

await step('the five tabs are the course, not the old plan', async () => {
  const m = await page.evaluate(() => {
    const st = document.querySelector('#grTraining .gr_seg');
    if (!st) return null;
    const b = [...st.querySelectorAll('button')];
    return { labels: b.map(x => x.innerText.trim()), keys: b.map(x => x.dataset.grTraintab),
             on: (b.find(x => x.getAttribute('aria-pressed') === 'true') || {}).innerText };
  });
  if (!m) { check('the tab strip renders', false); return; }
  // The old strip was Plan / Calls to watch / Philosophy / Call script / Pricing.
  check('five tabs', m.keys.length === 5, JSON.stringify(m.keys));
  check('they read Course / Clear answers / Best calls / Q&A / Pricing',
        JSON.stringify(m.labels) === JSON.stringify(['Course', 'Clear answers', 'Best calls', 'Q&A', 'Pricing']),
        JSON.stringify(m.labels));
  check('Course is the one it opens on', (m.on || '').trim() === 'Course', m.on);
});

await step('the course says where you are and what to start', async () => {
  const m = await page.evaluate(() => {
    const h = document.querySelector('#grTraining .gr_sech');
    const card = document.querySelector('#grTraining .gr_card');
    const bar = document.querySelector('#grTraining .gr_prog i');
    const go = document.querySelector('#grTraining .gr_startb');
    const ls = [...document.querySelectorAll('#grTraining .gr_cs')];
    return {
      head: h ? h.innerText.replace(/\s+/g, ' ').trim() : '',
      prog: card ? (card.querySelector('.gr_pn') || {}).textContent : '',
      barW: bar ? Math.round(bar.getBoundingClientRect().width) : -1,
      start: go ? go.innerText.trim() : '',
      lessons: ls.map(x => ({
        n: (x.querySelector('.gr_csh0 > i') || {}).textContent,
        t: (x.querySelector('.gr_csh0 b') || {}).textContent,
        g: (x.querySelector('.gr_csh0 em') || {}).textContent,
        min: (x.querySelector('.gr_csh0 > u') || {}).textContent,
        w: Math.round(x.getBoundingClientRect().width),
        h: Math.round(x.getBoundingClientRect().height)
      }))
    };
  });
  check('it is called the sales course', /Sales course/.test(m.head), m.head);
  check('and counts the lessons in the subtitle', /3 short lessons/.test(m.head), m.head);
  check('progress reads 0 of 3', /^0 of 3\b/.test((m.prog || '').trim()), m.prog);
  check('the bar is empty at zero (' + m.barW + 'px)', m.barW === 0, m.barW + '');
  check('and it offers the first lesson by name', /^Start: /.test(m.start), m.start);
  check('three lessons', m.lessons.length === 3, JSON.stringify(m.lessons.map(x => x.t)));
  check('each is numbered', JSON.stringify(m.lessons.map(x => x.n)) === JSON.stringify(['1', '2', '3']),
        JSON.stringify(m.lessons.map(x => x.n)));
  check('each has a title and a line under it', m.lessons.every(x => x.t && x.g), JSON.stringify(m.lessons));
  check('each says how long it takes', m.lessons.every(x => /\d+ min/.test(x.min || '')),
        JSON.stringify(m.lessons.map(x => x.min)));
  check('and none collapsed', m.lessons.every(x => x.w > 300 && x.h > 50),
        JSON.stringify(m.lessons.map(x => x.w + 'x' + x.h)));
});

await step('a lesson opens and renders every kind of block', async () => {
  await page.locator('#grTraining .gr_csh0').first().click();
  await page.waitForTimeout(350);
  const m = await page.evaluate(() => {
    const b = document.querySelector('#grTraining .gr_csb');
    if (!b) return null;
    const d = b.querySelector('.gr_csd');
    const px = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    const card = b.closest('.gr_cs');
    return {
      paras: b.querySelectorAll('.gr_cst').length,
      heads: [...b.querySelectorAll('.gr_csh')].map(x => x.textContent),
      bullets: [...b.querySelectorAll('.gr_csl li')].map(x => x.textContent),
      doLabel: d ? (d.querySelector('span') || {}).textContent : '',
      doText: d ? (d.querySelector('p') || {}).textContent : '',
      doBg: d ? getComputedStyle(d).backgroundColor : '',
      doFg: d ? getComputedStyle(d).color : '',
      doSize: d ? px(d) : [0, 0],
      numBg: getComputedStyle(card.querySelector('.gr_csh0 > i')).backgroundColor,
      acts: [...b.querySelectorAll('.gr_csx button')].map(x => x.innerText.trim()).filter(Boolean)
    };
  });
  if (!m) { check('the lesson body renders', false); return; }
  check('a paragraph', m.paras >= 1, m.paras + '');
  check('a small heading', m.heads.length >= 1, JSON.stringify(m.heads));
  check('bullets with real text', m.bullets.length >= 2 && m.bullets.every(x => x.length > 5), JSON.stringify(m.bullets));
  check('the Do this block is labelled', /do this/i.test(m.doLabel), m.doLabel);
  check('and says what to do', m.doText.length > 10, m.doText);
  // The design's black-on-white block. Giant inverts with the theme, so the only thing
  // that must hold in BOTH is that it is the inverse of the page, not another grey card.
  check('it is inverted against the page', m.doBg !== m.doFg && m.doSize[0] > 200,
        m.doBg + ' on ' + m.doFg + ' ' + m.doSize.join('x'));
  check('the open lesson is marked red', /208, 4, 0/.test(m.numBg), m.numBg);
  check('and Mark done is offered', m.acts.some(a => a === 'Mark done'), JSON.stringify(m.acts));
  await shot('11-lesson');
});

await step('marking a lesson done writes YOUR row, and only yours', async () => {
  const before = await page.evaluate(() => (window.__mockDB.growth_course_done || []).length);
  await page.locator('#grTraining [data-gr-lesson-done]').first().click();
  await page.waitForTimeout(700);
  // Read the DATABASE. The screen agreeing with itself proves nothing.
  const row = await page.evaluate(() => {
    const rows = window.__mockDB.growth_course_done || [];
    const me = (window.giantSession && window.giantSession.user && window.giantSession.user.id) || null;
    return { n: rows.length, last: rows[rows.length - 1] || null, me: me };
  });
  check('a row was written', row.n === before + 1, before + ' -> ' + row.n);
  check('for this lesson', row.last && row.last.lesson_id === 'open', JSON.stringify(row.last));
  check('owned by the person who clicked', row.last && row.last.owner_id === row.me,
        JSON.stringify(row.last) + ' me=' + row.me);

  const after = await page.evaluate(() => {
    const card = document.querySelector('#grTraining .gr_cs');
    const bar = document.querySelector('#grTraining .gr_prog i');
    return { prog: (document.querySelector('#grTraining .gr_pn') || {}).textContent,
             tick: (card.querySelector('.gr_csh0 > i') || {}).textContent,
             done: card.classList.contains('gr_csdone'),
             barW: bar ? Math.round(bar.getBoundingClientRect().width) : 0,
             start: (document.querySelector('#grTraining .gr_startb') || {}).innerText || '' };
  });
  check('the count moves to 1 of 3', /^1 of 3\b/.test((after.prog || '').trim()), after.prog);
  check('the bar is no longer empty (' + after.barW + 'px)', after.barW > 4);
  check('the number becomes a tick', after.done && after.tick.trim() === '✓', JSON.stringify(after));
  check('and the button now says Continue', /^Continue: /.test(after.start.trim()), after.start);

  // ... and it comes back off.
  await page.locator('#grTraining [data-gr-lesson-done]').first().click();
  await page.waitForTimeout(700);
  const undone = await page.evaluate(() => ({
    n: (window.__mockDB.growth_course_done || []).length,
    prog: (document.querySelector('#grTraining .gr_pn') || {}).textContent }));
  check('un-ticking removes the row', undone.n === before, before + ' -> ' + undone.n);
  check('and the count goes back', /^0 of 3\b/.test((undone.prog || '').trim()), undone.prog);
});

await step('a lesson can send you to the page it is about, and back', async () => {
  await page.locator('#grTraining .gr_cs').nth(1).locator('.gr_csh0').click();
  await page.waitForTimeout(300);
  const link = page.locator('#grTraining .gr_csb [data-gr-traintab="phil"]');
  check('lesson two links to the principles', await link.count() === 1);
  if (await link.count() !== 1) return;
  await link.click();
  await page.waitForTimeout(400);
  const m = await page.evaluate(() => {
    const st = document.querySelector('#grTraining .gr_seg');
    const on = st.querySelector('[aria-pressed="true"]');
    return { body: (document.querySelector('#grTraining') || {}).innerText.slice(0, 200),
             lit: on ? on.innerText.trim() : '',
             back: !!document.querySelector('#grTraining [data-gr-traintab="course"].gr_slink') };
  });
  check('it opens the principles', /top tips/i.test(m.body), m.body.replace(/\s+/g, ' ').slice(0, 80));
  // It is a sub view, so the strip must still say Course rather than going blank.
  check('and Course stays lit', m.lit === 'Course', m.lit);
  check('with a way back', m.back);
  await page.locator('#grTraining [data-gr-traintab="course"]').first().click();
  await page.waitForTimeout(350);
  check('back returns to the course', await page.locator('#grTraining .gr_cs').count() === 3);
});

await step('clear answers, best calls and the questions all paint', async () => {
  await tabOf('clear').click(); await page.waitForTimeout(350);
  const cl = await page.evaluate(() => [...document.querySelectorAll('#grTraining .gr_ca')].map(x => ({
    q: (x.querySelector('b') || {}).textContent, a: (x.querySelector('p') || {}).textContent,
    w: Math.round(x.getBoundingClientRect().width) })));
  check('two clear answers', cl.length === 2, JSON.stringify(cl.map(x => x.q)));
  check('each has a question and an answer', cl.every(x => x.q && x.a && x.a.length > 20), JSON.stringify(cl));
  check('and none collapsed', cl.every(x => x.w > 300), JSON.stringify(cl.map(x => x.w)));

  await tabOf('lib').click(); await page.waitForTimeout(350);
  const lb = await page.evaluate(() => [...document.querySelectorAll('#grTraining .gr_bc3')].map(x => ({
    t: (x.querySelector('.gr_bch b') || {}).textContent,
    watch: !!x.querySelector('.gr_wbtn'),
    why: !!x.querySelector('.gr_bcw'),
    w: Math.round(x.getBoundingClientRect().width) })));
  check('the best calls shelf has a call', lb.length >= 1, JSON.stringify(lb));
  check('with a watch link and a why it worked', lb.every(x => x.watch && x.why), JSON.stringify(lb));
  check('and a real width', lb.every(x => x.w > 280), JSON.stringify(lb.map(x => x.w)));

  await tabOf('qa').click(); await page.waitForTimeout(350);
  const qa = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('#grTraining .gr_qa3')].map(x => (x.querySelector('.gr_qah b') || {}).textContent),
    search: !!document.getElementById('grQaQ'),
    views: [...document.querySelectorAll('#grTraining [data-gr-qaview]')].map(x => x.innerText.trim())
  }));
  check('the questions are listed', qa.rows.length === 2, JSON.stringify(qa.rows));
  check('there is a search box', qa.search);
  check('and a browse / practice switch', JSON.stringify(qa.views) === JSON.stringify(['Browse', 'Practice']), JSON.stringify(qa.views));
  await shot('12-qa');
});

await step('a question opens, and practice hides the answer until you ask', async () => {
  await page.locator('#grTraining .gr_qah').first().click();
  await page.waitForTimeout(350);
  const open = await page.evaluate(() => {
    const b = document.querySelector('#grTraining .gr_qab');
    if (!b) return null;
    const a = b.querySelector('.gr_qaa');
    return { feel: (b.querySelector('.gr_qaf p') || {}).textContent || '',
             label: a ? (a.querySelector('span') || {}).textContent : '',
             answer: a ? (a.querySelector('p') || {}).textContent : '',
             bg: a ? getComputedStyle(a).backgroundColor : '',
             fg: a ? getComputedStyle(a).color : '',
             tricks: [...b.querySelectorAll('.gr_tg')].map(x => x.textContent) };
  });
  if (!open) { check('the question opens', false); return; }
  check('it says what they are really asking', open.feel.length > 10, open.feel);
  check('the best answer is labelled', /best answer/i.test(open.label), open.label);
  check('and is there to read', open.answer.length > 20, open.answer);
  check('the answer block is inverted against the page', open.bg !== open.fg, open.bg + ' on ' + open.fg);
  check('the tricks are listed', open.tricks.length >= 1, JSON.stringify(open.tricks));

  await page.locator('#grTraining [data-gr-qaview="practice"]').click();
  await page.waitForTimeout(350);
  const p1 = await page.evaluate(() => ({
    q: (document.querySelector('#grTraining .gr_pr h3') || {}).textContent || '',
    shown: !!document.querySelector('#grTraining .gr_pr .gr_qaa') }));
  check('practice asks a question', p1.q.length > 8, p1.q);
  // The whole point: reading the answer first teaches nothing.
  check('and the answer starts hidden', !p1.shown);
  await page.locator('#grTraining [data-gr-prac-show]').click();
  await page.waitForTimeout(300);
  const p2 = await page.evaluate(() => ({
    shown: !!document.querySelector('#grTraining .gr_pr .gr_qaa'),
    txt: (document.querySelector('#grTraining .gr_pr .gr_qaa p') || {}).textContent || '' }));
  check('asking shows it', p2.shown && p2.txt.length > 20, p2.txt);
  await page.locator('#grTraining [data-gr-qaview="browse"]').click();
  await page.waitForTimeout(300);
});

/* ── the permission split ─────────────────────────────────────────────────────
   Counted as a staff member, then counted again as a rep. The database enforces
   this too, which tools_growth_course_check.sql measures as four different people;
   this is only the half that decides what a rep is OFFERED.                      */
const controls = async () => page.evaluate(() => {
  const q = (s) => document.querySelectorAll('#grTraining ' + s).length;
  return { addLesson: q('[data-gr-lesson-add]'), editLesson: q('[data-gr-lesson-edit]'),
           addClear: q('[data-gr-cl-add]'), editClear: q('[data-gr-cl-edit]'),
           addQa: q('[data-gr-qa-add]'), editQa: q('[data-gr-qa-edit]'),
           addCall: q('[data-gr-watch-open]'), delCall: q('[data-gr-watch-del]'),
           markDone: q('[data-gr-lesson-done]'), whoChips: q('[data-gr-who]') };
});

await step('staff are offered the editing', async () => {
  await tabOf('course').click(); await page.waitForTimeout(300);
  if (await page.locator('#grTraining .gr_csb').count() === 0) {
    await page.locator('#grTraining .gr_csh0').first().click(); await page.waitForTimeout(300);
  }
  const c = await controls();
  check('staff can add a lesson', c.addLesson === 1, JSON.stringify(c));
  check('staff can edit the open lesson', c.editLesson === 1, JSON.stringify(c));
  check('staff can still tick their own lesson', c.markDone === 1, JSON.stringify(c));
  await tabOf('clear').click(); await page.waitForTimeout(300);
  const c2 = await controls();
  check('staff can add and edit a clear answer', c2.addClear === 1 && c2.editClear === 2, JSON.stringify(c2));
  await tabOf('qa').click(); await page.waitForTimeout(300);
  const c3 = await controls();
  check('staff can add a question', c3.addQa === 1, JSON.stringify(c3));
  await tabOf('lib').click(); await page.waitForTimeout(300);
  const c4 = await controls();
  check('staff can add and remove a best call', c4.addCall === 1 && c4.delCall === 1, JSON.stringify(c4));
});

await step('staff can look at someone else, but cannot tick for them', async () => {
  await tabOf('course').click(); await page.waitForTimeout(300);
  const chips = page.locator('#grTraining [data-gr-who]');
  const n = await chips.count();
  check('there is a second person to look at', n >= 2, n + ' chips');
  if (n < 2) return;
  await chips.nth(1).click(); await page.waitForTimeout(450);
  const m = await page.evaluate(() => ({
    head: (document.querySelector('#grTraining .gr_card h2') || {}).textContent || '',
    open: document.querySelectorAll('#grTraining .gr_csb').length }));
  check('the card names whose progress it is', /progress$/.test(m.head.trim()) && !/^Your /.test(m.head), m.head);
  if (!m.open) { await page.locator('#grTraining .gr_csh0').first().click(); await page.waitForTimeout(300); }
  const c = await page.evaluate(() => ({
    done: document.querySelectorAll('#grTraining [data-gr-lesson-done]').length,
    note: (document.querySelector('#grTraining .gr_csx .gr_mute') || {}).textContent || '' }));
  // Looking is not the same as ticking. growth_course_done pins owner_id in its with
  // check, so this is the screen agreeing with a rule the database already enforces.
  check('Mark done is not offered for someone else', c.done === 0, JSON.stringify(c));
  check('and it says who can tick it', /can tick this one off/.test(c.note), c.note);
  await page.locator('#grTraining [data-gr-who]').first().click(); await page.waitForTimeout(400);
  const back = await page.evaluate(() =>
    (document.querySelector('#grTraining .gr_card h2') || {}).textContent || '');
  check('switching back shows your own again', /^Your progress/.test(back.trim()), back);
});

await step('a rep is offered none of it, and can still tick their own lesson', async () => {
  // Same page, same data, one field different.
  await page.evaluate(() => { window.giantCurrentProfile.role = 'member'; });
  await page.evaluate(() => { if (window.grInit) window.grInit('gr_training'); });
  await page.waitForTimeout(400);

  await tabOf('lib').click(); await page.waitForTimeout(300);
  const c4 = await controls();
  check('a rep cannot add or remove a best call', c4.addCall === 0 && c4.delCall === 0, JSON.stringify(c4));
  const txt = await page.evaluate(() => {
    const w = document.querySelector('#grTraining .gr_bcw');
    return { editable: !!(w && w.querySelector('textarea')), reads: !!(w && w.querySelector('p')) };
  });
  check('the lesson on a call is read only for a rep', !txt.editable && txt.reads, JSON.stringify(txt));

  await tabOf('clear').click(); await page.waitForTimeout(300);
  const c2 = await controls();
  check('a rep cannot add or edit a clear answer', c2.addClear === 0 && c2.editClear === 0, JSON.stringify(c2));
  const seen = await page.evaluate(() => document.querySelectorAll('#grTraining .gr_ca').length);
  check('but still reads all of them', seen === 2, seen + ' of 2');

  await tabOf('qa').click(); await page.waitForTimeout(300);
  const c3 = await controls();
  check('a rep cannot add or edit a question', c3.addQa === 0 && c3.editQa === 0, JSON.stringify(c3));

  await tabOf('course').click(); await page.waitForTimeout(300);
  // Open it only if it is not already: the staff step left one open, and clicking a
  // header toggles, so clicking blind closed it and every control read as absent.
  if (await page.locator('#grTraining .gr_csb').count() === 0) {
    await page.locator('#grTraining .gr_csh0').first().click(); await page.waitForTimeout(300);
  }
  check('a lesson is open to measure', await page.locator('#grTraining .gr_csb').count() === 1);
  const c = await controls();
  check('a rep cannot add or edit a lesson', c.addLesson === 0 && c.editLesson === 0, JSON.stringify(c));
  check('a rep is not offered the other people', c.whoChips === 0, JSON.stringify(c));
  // The one thing they MUST be able to do. A rule that stops the rep doing their own
  // work is not security, it is a broken screen.
  check('a rep CAN still mark their own lesson done', c.markDone === 1, JSON.stringify(c));
  await shot('13-rep');

  const before = await page.evaluate(() => (window.__mockDB.growth_course_done || []).length);
  await page.locator('#grTraining [data-gr-lesson-done]').click();
  await page.waitForTimeout(700);
  const n = await page.evaluate(() => (window.__mockDB.growth_course_done || []).length);
  check('and it really writes', n === before + 1, before + ' -> ' + n);

  await page.evaluate(() => { window.giantCurrentProfile.role = 'inhouse_dev'; });
});

await step('nothing raw reaches the screen', async () => {
  const raw = await page.evaluate(() => {
    const out = [];
    for (const t of ['course', 'clear', 'lib', 'qa', 'pricing']) {
      const b = document.querySelector('#grTraining [data-gr-traintab="' + t + '"]');
      if (b) b.click();
      const m = (document.getElementById('grTraining').innerText || '').match(/&(?:[a-z]+|#\d+);/ig);
      if (m) out.push(t + ': ' + m.join(','));
    }
    return out;
  });
  check('no raw HTML entity is visible', raw.length === 0, JSON.stringify(raw));
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
