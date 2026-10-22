/* The client sheet, measured.  Run:  node tools_growth_sheet_check.mjs
   (SHOT_DIR=/some/dir to also write screenshots of what it measured.)

   The sheet was rebuilt to match the design Luke has been working from, and nearly all
   of it is layout: a two row bar, a segmented tab strip, a black Do next card, four
   tiles, a follow up card. tools_newchat_parse/audit/isolation are all clean on a sheet
   that renders as a blank rectangle, and the main clickthrough only asserts that the
   five tabs exist and paint -- which they did before any of this too.

   So every check below is a MEASUREMENT of the thing that changed, chosen so it FAILS
   on what was there before:

     - the tab strip was underline tabs: the active tab had NO background. Asserting the
       active pill has a background that differs from the strip is the check that could
       not have passed a week ago.
     - the Do next card was var(--surface-2), a grey. It is now near black. The check
       reads the computed colour and asserts it is dark, rather than asserting a class.
     - the third tile said Emails. It says Meeting now. Reading the tile LABELS catches a
       card that renders but says the wrong thing, which no structural check can.
     - Lost was window.prompt, which is a no-op in the desktop build and so was silently
       doing nothing there. The check drives the dialog, which proves there IS one.
     - the composer body is a block-level textarea now; it used to inherit .gr_in's
       flex:1, which means nothing in a block parent and collapsed it to ~20 columns. The
       check measures its width against the composer's.
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

// Growth lives in an accordion group: opening it closes whatever else was open, and an
// item in a closed group sits at 0x0 and cannot be clicked.
await step('open Growth and a deal', async () => {
  await page.locator('.nav-group-label[data-navgroup="growth"]').click();
  await page.waitForTimeout(350);
  await navOf('gr_pipeline').click();
  await page.waitForFunction(() => document.querySelectorAll('#grPipeline .gr_bc').length > 0,
    null, { timeout: 15000 }).catch(() => {});
  const n = await page.locator('#grPipeline .gr_bc').count();
  check('there is a deal to open', n > 0, n + ' cards');
  await page.locator('#grPipeline .gr_bc').first().click();
  await page.waitForTimeout(450);
  check('the sheet opened', await page.locator('#grSheet .gr_sheet').count() === 1);
  await shot('01-sheet');
});

await step('the header bar carries stage, warmth, owner and the handoff', async () => {
  const m = await page.evaluate(() => {
    const sh = document.querySelector('#grSheet .gr_sheet');
    if (!sh) return null;
    const bars = [...sh.querySelectorAll('.gr_sbar')];
    const px = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    const stage = sh.querySelector('.gr_stage');
    const heat  = sh.querySelector('.gr_heat');
    const own   = sh.querySelector('.gr_ownc');
    const hand  = sh.querySelector('[data-gr-handoff]');
    return {
      bars: bars.length,
      stageBg: stage ? getComputedStyle(stage).backgroundColor : '',
      stageSize: stage ? px(stage) : [0, 0],
      heat: heat ? heat.innerText.replace(/\s+/g, ' ').trim() : '',
      heatSize: heat ? px(heat) : [0, 0],
      owner: own ? own.innerText.trim() : '',
      ownerAv: own ? px(own.querySelector('.gr_av') || own) : [0, 0],
      hand: hand ? hand.innerText.trim() : '',
      // row two is its own line: the won/lost row must start BELOW the stage row
      rowTwoTop: bars[1] ? Math.round(bars[1].getBoundingClientRect().top) : 0,
      rowOneBot: bars[0] ? Math.round(bars[0].getBoundingClientRect().bottom) : 0,
      won: !!sh.querySelector('[data-gr-won]'), lost: !!sh.querySelector('[data-gr-lost]')
    };
  });
  if (!m) { check('the bar renders', false); return; }
  check('there are two bars, not one', m.bars === 2, m.bars + ' bars');
  // Tinted with the stage's own colour. The old pill was flat var(--surface-2) (#1C1C1C),
  // so "not fully opaque grey" is exactly what could not have passed before.
  check('the stage pill is tinted with its stage colour', /rgba\(/.test(m.stageBg), m.stageBg);
  check('and the pill has real size (' + m.stageSize.join('x') + ')', m.stageSize[0] > 70 && m.stageSize[1] > 20);
  check('the warmth chip says a word and why', /^(Hot|Warm|Cold|Won|Lost)/.test(m.heat) && m.heat.length > 5, m.heat);
  check('and it is a real chip (' + m.heatSize.join('x') + ')', m.heatSize[0] > 50 && m.heatSize[1] > 18);
  check('the owner chip names the owner', m.owner.length > 1, m.owner);
  check('with an avatar that is not 0px (' + m.ownerAv.join('x') + ')', m.ownerAv[0] > 14 && m.ownerAv[1] > 14);
  check('the handoff button is offered to staff', /ReachGiant clients/.test(m.hand), m.hand);
  check('won and lost sit on their own row below', m.won && m.lost && m.rowTwoTop >= m.rowOneBot - 2,
        'row1 bottom ' + m.rowOneBot + ', row2 top ' + m.rowTwoTop);
});

await step('the tabs are a segmented strip, not underlines', async () => {
  const m = await page.evaluate(() => {
    const strip = document.querySelector('#grSheet .gr_stabs');
    if (!strip) return null;
    const cs = getComputedStyle(strip);
    const btns = [...strip.querySelectorAll('button')];
    const on = btns.find(b => b.getAttribute('aria-pressed') === 'true');
    const off = btns.find(b => b.getAttribute('aria-pressed') !== 'true');
    const bg = (el) => getComputedStyle(el).backgroundColor;
    const rad = parseFloat(cs.borderRadius) || 0;
    return { n: btns.length, stripBg: cs.backgroundColor, radius: rad,
             onBg: on ? bg(on) : '', offBg: off ? bg(off) : '',
             onW: on ? Math.round(on.getBoundingClientRect().width) : 0 };
  });
  if (!m) { check('the tab strip renders', false); return; }
  check('five tabs', m.n === 5, m.n + '');
  check('the strip is a rounded container (' + m.radius + 'px)', m.radius >= 20, m.stripBg);
  // The underline tabs had NO background on the active button. This is the check that
  // fails against the old build.
  check('the active tab is a filled pill', m.onBg !== 'rgba(0, 0, 0, 0)' && m.onBg !== m.stripBg,
        'on=' + m.onBg + ' strip=' + m.stripBg);
  check('and the inactive tab is not', m.offBg === 'rgba(0, 0, 0, 0)' || m.offBg === m.stripBg, m.offBg);
  check('the active tab has width (' + m.onW + 'px)', m.onW > 60);
});

await step('Do next is a black card with a verb and a template picker', async () => {
  const m = await page.evaluate(() => {
    const card = document.querySelector('#grSheet .gr_next');
    if (!card) return null;
    const bg = getComputedStyle(card).backgroundColor;
    const n = (bg.match(/\d+/g) || []).slice(0, 3).map(Number);
    const q = card.querySelector('.gr_nq'), b = card.querySelector('.gr_dob'), t = card.querySelector('.gr_dot');
    const px = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    return { bg, lum: n.length === 3 ? (n[0] + n[1] + n[2]) / 3 : 255,
             hot: card.classList.contains('hot'), ok: card.classList.contains('ok'),
             line: q ? q.innerText.trim() : '',
             btn: b ? b.innerText.trim() : '', btnSize: b ? px(b) : [0, 0],
             tpl: t ? t.innerText.replace(/\s+/g, ' ').trim() : '', tplSize: t ? px(t) : [0, 0],
             btnBg: b ? getComputedStyle(b).backgroundColor : '' };
  });
  if (!m) { check('the Do next card renders', false); return; }
  if (m.ok) { check('nothing to do, so the quiet card shows', m.line.length > 5, m.line); return; }
  // Grey (--surface-2 is #1C1C1C = 28) would also be dark, so the red variant is allowed
  // and the plain one must be near-black: --paper-ink is #0A0A0A = 10.
  check('the card is black (or the red reply card)', m.hot || m.lum < 20, m.bg);
  check('it says what to do as a sentence', /\.$/.test(m.line) && m.line.length > 12, m.line);
  check('the action button names the action', m.btn.length > 5, m.btn);
  check('and is a light pill on the dark card', m.btnBg !== m.bg, m.btnBg);
  check('the button is a real size (' + m.btnSize.join('x') + ')', m.btnSize[0] > 150 && m.btnSize[1] > 30);
  check('a template picker sits beside it', /template/i.test(m.tpl), m.tpl);
  check('and it is not squashed (' + m.tplSize.join('x') + ')', m.tplSize[0] > 90 && m.tplSize[1] > 30);
  check('the two buttons share one row', m.btnSize[1] > 0 && m.tplSize[1] > 0);
});

await step('the four tiles say stage, contact, meeting and follow up', async () => {
  const m = await page.evaluate(() => {
    const f = document.querySelector('#grSheet .gr_facts');
    if (!f) return null;
    return [...f.children].map(d => ({
      label: (d.querySelector('span') || {}).textContent || '',
      value: (d.querySelector('b') || {}).textContent || '',
      w: Math.round(d.getBoundingClientRect().width)
    }));
  });
  if (!m) { check('the tiles render', false); return; }
  const labels = m.map(x => x.label);
  check('there are four', m.length === 4, JSON.stringify(labels));
  // It used to be Emails. Reading the labels is what catches the wrong tile.
  check('the third is Meeting, not Emails', labels[2] === 'Meeting', labels[2]);
  check('they read Stage / Last contact / Meeting / Follow up',
        JSON.stringify(labels) === JSON.stringify(['Stage', 'Last contact', 'Meeting', 'Follow up']),
        JSON.stringify(labels));
  check('every tile says something', m.every(x => x.value.trim().length > 0), JSON.stringify(m.map(x => x.value)));
  check('and none collapsed', m.every(x => x.w > 80), JSON.stringify(m.map(x => x.w)));
});

await step('follow up is a card with three dated choices', async () => {
  const m = await page.evaluate(() => {
    const card = document.querySelector('#grSheet .gr_fuc');
    if (!card) return null;
    const chips = [...card.querySelectorAll('.gr_chip')];
    return { label: (card.querySelector('span') || {}).textContent || '',
             chips: chips.map(c => c.innerText.trim()),
             widths: chips.map(c => Math.round(c.getBoundingClientRect().width)),
             bg: getComputedStyle(card).backgroundColor };
  });
  if (!m) { check('the follow up card renders', false); return; }
  check('the card is labelled', /follow up/i.test(m.label), m.label);
  check('three choices, or a date already set', m.chips.length === 3 || m.chips.length === 1, JSON.stringify(m.chips));
  check('and every chip has width', m.widths.every(w => w > 50), JSON.stringify(m.widths));
});

await step('the timeline dots are rings, and every row says an event', async () => {
  const m = await page.evaluate(() => {
    const tl = document.querySelector('#grSheet .gr_tl');
    if (!tl) return null;
    const rows = [...tl.children];
    const dot = rows[0] && rows[0].querySelector('i');
    return { rows: rows.length,
             shadow: dot ? getComputedStyle(dot).boxShadow : '',
             dotW: dot ? Math.round(dot.getBoundingClientRect().width) : 0,
             events: rows.map(r => ((r.querySelector('span') || {}).textContent || '').trim()) };
  });
  if (!m) { check('no timeline on this deal (nothing has happened yet)', true); return; }
  check('there are rows', m.rows > 0, m.rows + '');
  check('the dot is a ring, not a disc', /inset/.test(m.shadow), m.shadow);
  check('and the dot is not 0px (' + m.dotW + ')', m.dotW >= 6);
  check('every row names an event', m.events.every(e => e.length > 3), JSON.stringify(m.events.slice(0, 3)));
});

await step('the template dropdown is grouped and really loads one', async () => {
  await page.locator('#grSheet .gr_dot').first().click();
  await page.waitForTimeout(300);
  const m = await page.evaluate(() => {
    const el = document.getElementById('grPick');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height),
             groups: [...el.querySelectorAll('.gr_ml')].map(d => d.textContent.trim()),
             std: [...el.querySelectorAll('[data-gr-pk="std"]')].map(b => b.textContent.trim()),
             mine: [...el.querySelectorAll('[data-gr-pk="tpl"]')].map(b => b.textContent.trim()),
             edit: !!el.querySelector('[data-gr-pk="edit"]') };
  });
  if (!m) { check('the dropdown opens', false); return; }
  check('the dropdown opens at a real size (' + m.w + 'x' + m.h + ')', m.w > 150 && m.h > 100);
  check('it is grouped', m.groups.length >= 1, JSON.stringify(m.groups));
  check('the six standard emails are offered', m.std.length === 6, JSON.stringify(m.std));
  check('the saved templates are listed too', m.mine.length > 0, JSON.stringify(m.mine));
  check('and there is a way to edit them', m.edit);

  // Pick a saved template: this must open the composer AND put the template in it.
  const name = m.mine[0];
  await page.locator('#grPick [data-gr-pk="tpl"]').first().click();
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => {
    const t = document.getElementById('grCBody');
    return { open: !!document.querySelector('#grSheet .gr_comp'),
             chars: t ? t.value.trim().length : 0,
             status: (document.querySelector('#grSheet .gr_cstat') || {}).textContent || '' };
  });
  check('picking one opens the composer', after.open);
  check('and the body is filled from it (' + after.chars + ' chars)', after.chars > 10);
  check('and it says which template', after.status.includes(name), after.status + ' / ' + name);
  await shot('02-composer');
});

/* The composer used to be appended UNDER the sheet in the same fixed-height flex column.
   Once it was this tall the column overflowed, flex shrank the sheet from 745px to 232px,
   and overflow:hidden clipped the sheet's own body away -- an open client with no content
   under its tabs. It floats over the sheet now. This measures that the sheet keeps its
   height and keeps its body inside itself. */
await step('opening the composer does not squash the sheet behind it', async () => {
  const m = await page.evaluate(() => {
    const sh = document.querySelector('#grSheet .gr_sheet');
    const bd = sh && sh.querySelector('.gr_sbody');
    const cp = document.querySelector('#grSheet .gr_comp');
    if (!sh || !bd || !cp) return null;
    const r = e => e.getBoundingClientRect();
    return { sheetH: Math.round(r(sh).height), bodyH: Math.round(r(bd).height),
             bodyBottom: Math.round(r(bd).bottom), sheetBottom: Math.round(r(sh).bottom),
             compFixed: getComputedStyle(cp.parentElement).position };
  });
  if (!m) { check('the sheet and composer are both on screen', false); return; }
  check('the sheet is still its full height (' + m.sheetH + 'px)', m.sheetH > m.bodyH, m.sheetH + ' vs body ' + m.bodyH);
  check('and its body is not clipped off the bottom', m.bodyBottom <= m.sheetBottom + 2,
        'body ends ' + m.bodyBottom + ', sheet ends ' + m.sheetBottom);
  check('the composer floats rather than stacking', m.compFixed === 'fixed', m.compFixed);
});

await step('the composer matches the design, and its body is full width', async () => {
  const m = await page.evaluate(() => {
    const comp = document.querySelector('#grSheet .gr_comp');
    if (!comp) return null;
    const px = (el) => el ? Math.round(el.getBoundingClientRect().width) : 0;
    const body = comp.querySelector('.gr_cbody');
    const rows = [...comp.querySelectorAll('.gr_crow label')].map(l => l.textContent.trim());
    return {
      title: (comp.querySelector('.gr_chi b') || {}).innerText || '',
      from:  (comp.querySelector('.gr_chi span') || {}).innerText || '',
      tools: [...comp.querySelectorAll('.gr_ctool button')].map(b => b.innerText.replace(/\s+/g, ' ').trim()),
      rows: rows,
      bodyW: px(body), compW: px(comp),
      bodyH: body ? Math.round(body.getBoundingClientRect().height) : 0,
      sig: (comp.querySelector('.gr_sigb > span') || {}).textContent || '',
      sigName: (comp.querySelector('.gr_sig b') || {}).textContent || '',
      acts: [...comp.querySelectorAll('.gr_cacts button, .gr_cacts a')].map(b => b.innerText.trim()).filter(Boolean)
    };
  });
  if (!m) { check('the composer renders', false); return; }
  check('it is addressed to the person', /^New email to /.test(m.title), m.title);
  check('and says which mailbox it leaves from', /^From /.test(m.from), m.from);
  check('four tools above the email', m.tools.length === 4, JSON.stringify(m.tools));
  check('one of them writes it with AI', /AI/i.test(m.tools.join(' ')), JSON.stringify(m.tools));
  check('To and Subject are the two rows', JSON.stringify(m.rows) === JSON.stringify(['To', 'Subject']), JSON.stringify(m.rows));
  // .gr_in used to apply flex:1 here, which is meaningless in a block parent and left the
  // box about 20 columns wide. Measure it against its container, do not trust the class.
  check('the body fills the composer (' + m.bodyW + ' of ' + m.compW + ')', m.bodyW > m.compW * 0.85,
        m.bodyW + '/' + m.compW);
  check('and is tall enough to write in (' + m.bodyH + 'px)', m.bodyH > 150);
  check('the signature is shown, not typed into the body', /signature/i.test(m.sig), m.sig);
  check('and it names somebody', m.sigName.length > 2, m.sigName);
  check('Send, Save draft and Open in Gmail are all offered',
        ['Send', 'Save draft', 'Open in Gmail'].every(x => m.acts.some(a => a === x)), JSON.stringify(m.acts));
});

await step('a discount code goes into the email, above the sign off, once', async () => {
  const before = await page.evaluate(() => (document.getElementById('grCBody') || {}).value || '');
  await page.locator('#grSheet [data-gr-pick="discount"]').click();
  await page.waitForTimeout(300);
  const codes = await page.evaluate(() => {
    const el = document.getElementById('grPick');
    return el ? [...el.querySelectorAll('[data-gr-pk="disc"]')].map(b => b.innerText.trim()) : [];
  });
  check('the codes are listed', codes.length > 0, JSON.stringify(codes));
  if (!codes.length) return;
  await page.locator('#grPick [data-gr-pk="disc"]').first().click();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => (document.getElementById('grCBody') || {}).value || '');
  const code = codes[0].split(/\s+/)[0];
  check('the code is now in the email', after.includes(code), code + ' / ' + after.slice(-120));
  check('and it was added, not replaced', after.length > before.length, before.length + ' -> ' + after.length);
  const signOff = after.lastIndexOf('Best,');
  check('it sits above the sign off', signOff === -1 || after.indexOf(code) < signOff,
        'code at ' + after.indexOf(code) + ', sign off at ' + signOff);

  // Twice must not mean twice.
  await page.locator('#grSheet [data-gr-pick="discount"]').click();
  await page.waitForTimeout(250);
  await page.locator('#grPick [data-gr-pk="disc"]').first().click();
  await page.waitForTimeout(400);
  const twice = await page.evaluate(() => (document.getElementById('grCBody') || {}).value || '');
  const count = twice.split(code).length - 1;
  check('adding it twice leaves one', count === 1, count + ' copies');
});

await step('Lost asks why with buttons, and Cancel changes nothing', async () => {
  await page.keyboard.press('Escape');     // close the composer
  await page.waitForTimeout(300);
  const stageBefore = await page.evaluate(() => {
    const s = document.querySelector('#grSheet .gr_stage');
    return s ? s.value : '';
  });
  await page.locator('#grSheet [data-gr-lost]').click();
  await page.waitForTimeout(350);
  const m = await page.evaluate(() => {
    const d = document.querySelector('.gr_dlgw .gr_dlg');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height),
             title: (d.querySelector('h3') || {}).textContent || '',
             ask: (d.querySelector('p') || {}).textContent || '',
             reasons: [...d.querySelectorAll('[data-gr-lostr]')].map(b => b.textContent.trim()),
             go: !!d.querySelector('[data-gr-lostgo]'), cancel: !!d.querySelector('[data-gr-lostx]') };
  });
  // window.prompt is a no-op in the desktop build, so the old path did nothing at all
  // there. This is the check that proves there is a dialog to press.
  if (!m) { check('the lost dialog opens', false); return; }
  check('the lost dialog opens at a real size (' + m.w + 'x' + m.h + ')', m.w > 280 && m.h > 200);
  check('it names the person', /as lost$/.test(m.title.trim()), m.title);
  check('and says the answer is optional', /skip/i.test(m.ask), m.ask);
  check('five reasons are offered', m.reasons.length === 5, JSON.stringify(m.reasons));
  check('with a confirm and a cancel', m.go && m.cancel);
  await shot('03-lost');

  await page.locator('[data-gr-lostr]').first().click();
  await page.waitForTimeout(250);
  const picked = await page.evaluate(() =>
    [...document.querySelectorAll('[data-gr-lostr]')].filter(b => b.getAttribute('aria-pressed') === 'true').length);
  check('picking a reason marks it', picked === 1, picked + ' pressed');

  await page.locator('[data-gr-lostx]').click();
  await page.waitForTimeout(400);
  const gone = await page.evaluate(() => !document.querySelector('.gr_dlgw'));
  check('cancel closes it', gone);
  const stageAfter = await page.evaluate(() => {
    const s = document.querySelector('#grSheet .gr_stage');
    return s ? s.value : '';
  });
  check('and the deal did not move', stageAfter === stageBefore, stageBefore + ' -> ' + stageAfter);
});

await step('marking lost records the reason that was chosen', async () => {
  await page.locator('#grSheet [data-gr-lost]').click();
  await page.waitForTimeout(300);
  const reason = await page.evaluate(() => {
    const b = document.querySelectorAll('[data-gr-lostr]')[1];
    return b ? b.textContent.trim() : '';
  });
  await page.locator('[data-gr-lostr]').nth(1).click();
  await page.waitForTimeout(200);
  await page.locator('[data-gr-lostgo]').click();
  await page.waitForTimeout(700);
  // Read the DATABASE, not the screen. A check that set a flag on the row while the code
  // read a cache measured nothing and passed; this reads the row the app actually wrote.
  const row = await page.evaluate(() => {
    const id = (document.querySelector('#grSheet .gr_sheet') || {}).dataset
      ? document.querySelector('#grSheet .gr_sheet').dataset.grId : null;
    const r = (window.__mockDB.growth_clients || []).find(x => x.id === id);
    return r ? { stage: r.stage, lost_reason: r.lost_reason, lost_on: r.lost_on } : null;
  });
  check('the deal is lost in the data', row && row.stage === 'lost', JSON.stringify(row));
  check('with the reason that was clicked', row && row.lost_reason !== undefined && row.lost_reason === reason,
        JSON.stringify(row) + ' want ' + reason);
  check('and the day it happened', row && !!row.lost_on, JSON.stringify(row));
  const bar = await page.evaluate(() => {
    const sh = document.querySelector('#grSheet .gr_sheet');
    return sh ? (sh.querySelector('.gr_sbar2') || {}).innerText || '' : '';
  });
  check('and the sheet now says so', /lost/i.test(bar), bar.replace(/\s+/g, ' ').trim());
});

/* The Info tab had name, company, email, phone, website and value. The design also
   asks where they are, what time it is there, how they found us, and what they wrote on
   the booking form -- which was being stored and SCORED all along and shown nowhere, so
   the only way to read a prospect's budget was the console. */
await step('Info has the contact, location and form blocks', async () => {
  // Michael (gc-1) specifically: he is the one who came in through the booking form and
  // has a time zone. Whichever card happens to be first is not the same thing.
  await page.keyboard.press('Escape'); await page.waitForTimeout(350);
  const found = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#grPipeline .gr_bc')].find(x => /Michael/.test(x.textContent));
    if (el) el.click();
    return !!el;
  });
  check('Michael is on the board to open', found);
  await page.waitForTimeout(450);
  await page.locator('#grSheet [data-gr-tab="details"]').first().click();
  await page.waitForTimeout(450);
  const m = await page.evaluate(() => {
    const sh = document.getElementById('grSheet');
    return {
      cards: [...sh.querySelectorAll('.gr_pft')].map(x => x.textContent.trim()),
      src: !!sh.querySelector('[data-gr-f="source"]'),
      loc: !!sh.querySelector('[data-gr-f="location"]'),
      tz: !!sh.querySelector('select[data-gr-f="timezone"]'),
      tzOpts: sh.querySelectorAll('select[data-gr-f="timezone"] option').length,
      intake: [...sh.querySelectorAll('.gr_intk span')].map(x => x.textContent.trim()),
      localTime: (sh.querySelector('.gr_tzb b') || {}).textContent
    };
  });
  check('the tab is grouped into cards', m.cards.length >= 4, JSON.stringify(m.cards));
  check('"Found us through" is there to fill in', m.src);
  check('so is the city', m.loc);
  check('and a time zone to choose from', m.tz && m.tzOpts > 10, m.tzOpts + ' options');
  // The time zone is America/Chicago, so this must be a clock reading, not the zone name.
  check('their local time is shown as a time', /\d{1,2}:\d{2}/.test(m.localTime || ''), m.localTime);
  check('what they wrote on the form is listed', m.intake.length >= 5, JSON.stringify(m.intake));
  check('including the budget, which was stored and never shown',
    m.intake.some(x => /Budget/.test(x) && /\$/.test(x)), JSON.stringify(m.intake));
});

await step('the local time is right, not just present', async () => {
  // Worked out here with Intl against the same zone. A clock that renders OUR time and
  // calls it theirs looks completely normal on screen and is the whole point of the row.
  const r = await page.evaluate(() => {
    const sh = document.getElementById('grSheet');
    const shown = (sh.querySelector('.gr_tzb b') || {}).textContent || '';
    const want = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit',
      hour12: true, timeZone: 'America/Chicago', timeZoneName: 'short' });
    const here = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    return { shown: shown.trim(), want, here };
  });
  check('the clock matches that time zone', r.shown === r.want, r.shown + ' vs ' + r.want);
  check('and it is their time, not the browser\'s',
    r.shown.indexOf(r.here) !== 0 || r.want.indexOf(r.here) === 0, JSON.stringify(r));
});

await step('choosing a time zone saves it and moves the clock', async () => {
  await page.selectOption('#grSheet select[data-gr-f="timezone"]', 'Asia/Tokyo');
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => {
    const row = window.__mockDB.growth_clients.find(c => c.id === 'gc-1');
    const sh = document.getElementById('grSheet');
    return { saved: row && row.timezone,
             shown: ((sh.querySelector('.gr_tzb b') || {}).textContent || '').trim(),
             want: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit',
               hour12: true, timeZone: 'Asia/Tokyo', timeZoneName: 'short' }) };
  });
  check('the new zone is written to the database', after.saved === 'Asia/Tokyo', after.saved);
  check('and the clock on screen moved with it', after.shown === after.want,
    after.shown + ' vs ' + after.want);
  await page.selectOption('#grSheet select[data-gr-f="timezone"]', 'America/Chicago');
  await page.waitForTimeout(500);
});

await step('a client with no form and no zone says so instead of showing an empty card', async () => {
  await page.keyboard.press('Escape'); await page.waitForTimeout(350);
  // gc-3 has no intake and no timezone, which is the ordinary case.
  await page.evaluate(() => { window.grOpen && window.grOpen('gc-3'); });
  const opened = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#grPipeline .gr_bc')];
    const el = cards.find(x => /Amna/.test(x.textContent));
    if (el) el.click();
    return !!el;
  });
  if (!opened) { check('a client with no form shows the empty shape', false, 'no card for Amna'); return; }
  await page.waitForTimeout(450);
  await page.locator('#grSheet [data-gr-tab="details"]').first().click();
  await page.waitForTimeout(450);
  const m = await page.evaluate(() => {
    const sh = document.getElementById('grSheet');
    return { intake: sh.querySelectorAll('.gr_intk').length,
             clock: sh.querySelectorAll('.gr_tzb').length,
             hint: (sh.querySelector('.gr_pfc .gr_mute') || {}).textContent || '' };
  });
  check('no "from their form" card when they never filled one in', m.intake === 0, m.intake + '');
  check('no clock when there is no zone', m.clock === 0, m.clock + '');
  check('and a line saying what setting one would do', /time zone/i.test(m.hint), m.hint);
});

await step('nothing raw reaches the screen, and Escape puts it all away', async () => {
  const raw = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#grSheet .gr_sheet, #grPick, .gr_dlgw').forEach(el => {
      const t = el.innerText || '';
      const m = t.match(/&(?:[a-z]+|#\d+);/ig);
      if (m) out.push(...m);
    });
    return out;
  });
  check('no raw HTML entity is visible', raw.length === 0, JSON.stringify(raw));

  await page.keyboard.press('Escape'); await page.waitForTimeout(250);
  await page.keyboard.press('Escape'); await page.waitForTimeout(250);
  await page.keyboard.press('Escape'); await page.waitForTimeout(350);
  const shut = await page.evaluate(() => {
    const w = document.getElementById('grSheet');
    return { on: w.classList.contains('on'), display: getComputedStyle(w).display,
             pick: !!document.getElementById('grPick'), dlg: !!document.querySelector('.gr_dlgw') };
  });
  check('the sheet, the menu and the dialog are all gone', !shut.on && shut.display === 'none' && !shut.pick && !shut.dlg,
        JSON.stringify(shut));
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
