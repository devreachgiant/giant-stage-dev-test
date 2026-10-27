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

await step('the board still fits rather than scrolling', async () => {
  /* The reason the add control is not a permanent column. The board is a fixed grid on
     purpose -- "the stages have to FIT, not scroll" -- and a seventh share taken from
     six columns turned "Proposal sent" into "Proposa...". */
  const m = await page.evaluate(() => {
    const b = document.querySelector('.gr_board');
    return { overflows: b.scrollWidth > b.clientWidth + 1,
             extraCol: !!document.querySelector('.gr_colnew'),
             addOffBoard: !!document.querySelector('.gr_hint ~ * [data-gr-coladd], p [data-gr-coladd]') };
  });
  check('no sideways scrollbar on the board', !m.overflows, String(m.overflows));
  check('and no empty column parked there waiting', !m.extraCol, String(m.extraCol));
  check('the add button lives under the board instead', m.addOffBoard, String(m.addOffBoard));
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
  check('the question has call examples to lose', (before.ex || []).length === 4,
    String((before.ex || []).length));
  check('and an ask count that ranks the list', before.n === 12, String(before.n));

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
  check('and did not throw away the call examples', (after.ex || []).length === 4,
    String((after.ex || []).length));
  check('or the ask count', after.n === 12, String(after.n));

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

/* ---------------------------------------------------------------- the practice call */
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

for (const r of results) console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   ' + r.detail : ''));
const bad = results.filter(r => !r.pass);
console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' checks passed');
console.log(bad.length ? 'RESULT: ' + bad.length + ' FAILED' : 'RESULT: clean');
await browser.close();
server.close();
process.exit(bad.length ? 1 : 0);
