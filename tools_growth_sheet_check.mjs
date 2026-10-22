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

/* A call note carried the headline, what they want and the next steps. The three it
   dropped are the ones somebody reaches for afterwards: the facts, the lines they
   actually said with the point in the recording, and the worries next to the answer
   given. Driven against the note in the fixture, because a renderer that silently drops
   a section looks like a client who simply did not say much. */
await step('a call note shows the facts, the quotes and the worries', async () => {
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await navOf('gr_pipeline').click(); await page.waitForTimeout(700);
  const opened = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#grPipeline .gr_bc')].find(x => /Michael/.test(x.textContent));
    if (el) el.click();
    return !!el;
  });
  check('the client with a full note is on the board', opened);
  await page.waitForTimeout(600);
  await page.locator('#grSheet [data-gr-tab="notes"]').first().click();
  await page.waitForTimeout(500);
  const n = await page.evaluate(() => {
    const el = document.querySelector('#grSheet .gr_cn');
    if (!el) return null;
    return {
      headline: (el.querySelector('.gr_cnhl') || {}).textContent || '',
      facts: [...el.querySelectorAll('.gr_cnf > div')].map(d => ({
        k: d.querySelector('span').textContent, v: d.querySelector('b').textContent })),
      wants: [...el.querySelectorAll('.gr_cnw li')].map(x => x.textContent),
      said: [...el.querySelectorAll('.gr_cnqr')].map(d => ({
        t: (d.querySelector('span') || {}).textContent,
        link: (d.querySelector('a') || {}).getAttribute ? d.querySelector('a').getAttribute('href') : null,
        stamp: (d.querySelector('a') || {}).textContent || '' })),
      worries: [...el.querySelectorAll('.gr_cnor')].map(d => ({
        q: d.querySelector('b').textContent, a: d.querySelector('span').textContent })),
      next: [...el.querySelectorAll('.gr_cnnr')].map(d => ({
        t: d.querySelector('span').textContent, who: d.querySelector('em').textContent,
        done: d.classList.contains('gr_cndone'),
        line: getComputedStyle(d.querySelector('span')).textDecorationLine })),
      watch: !!el.querySelector('.gr_cnh a')
    };
  });
  check('the note rendered', !!n, '');
  if (!n) return;
  check('the headline is there', /\$80k/.test(n.headline), n.headline);
  check('the facts are a labelled grid', n.facts.length === 3 &&
    n.facts.some(f => /Budget/i.test(f.k) && /\$3,000/.test(f.v)), JSON.stringify(n.facts));
  check('what they want is listed', n.wants.length === 2, JSON.stringify(n.wants));
  check('what they said is quoted', n.said.length === 2, JSON.stringify(n.said.map(x => x.t)));
  // The stamp is the point in the recording, and the link has to carry it or pressing it
  // just opens the call at the beginning -- which is the same as having no stamp.
  check('each quote carries a timestamp', n.said.every(x => /^▶?\s*\d+:\d{2}$/.test((x.stamp || '').trim())),
    JSON.stringify(n.said.map(x => x.stamp)));
  check('182 seconds reads as 3:02', /3:02/.test(n.said[0].stamp), n.said[0].stamp);
  check('and the link jumps to that second',
    /[?&]timestamp=182\b/.test(n.said[0].link || ''), n.said[0].link);
  check('the worries sit next to their answers', n.worries.length === 2 &&
    /ten day exit/i.test(n.worries[0].a), JSON.stringify(n.worries));
  check('the next steps name who owns them',
    n.next.length === 2 && n.next[0].who === 'Luke' && n.next[1].who === 'Annie',
    JSON.stringify(n.next));
  // The tick is measured by the strike-through, not by the class alone: a "done" flag
  // that changes nothing a person can see is the check that passes against the bug.
  check('a finished step is struck through and an unfinished one is not',
    n.next[0].done && /line-through/.test(n.next[0].line) && !/line-through/.test(n.next[1].line),
    JSON.stringify(n.next.map(x => x.line)));
  check('and there is a way into the recording', n.watch);
});

/* Marking a deal won was a browser prompt asking for a number; logging work done
   elsewhere was not possible at all, so a client rung from somebody's phone looked
   abandoned here. Both write to the database, so both are driven and read back, and
   both are undoable -- the whole point of an Undo is that it puts the row back. */
await step('the journey says what has actually happened', async () => {
  // Back to the board from wherever the steps above left things, then open Kelsey and
  // CHECK IT IS KELSEY: a card click that does not land leaves the previous client on
  // screen, and every assertion below would be about the wrong person.
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await navOf('gr_pipeline').click(); await page.waitForTimeout(700);
  const boardBtn = page.locator('#grPipeline [data-gr-pview="board"]');
  if (await boardBtn.count()) { await boardBtn.click(); await page.waitForTimeout(500); }
  // Whoever is still OPEN. Steps above this one mark people won and lost, so naming a
  // client here would eventually test a closed deal and quietly measure nothing.
  const target = await page.evaluate(() => {
    const c = window.__mockDB.growth_clients.find(x => x.stage !== 'won' && x.stage !== 'lost');
    return c ? { id: c.id, name: c.name, stage: c.stage, calls: c.calls_held || 0,
                 sent: c.emails_sent || 0, summary: c.summary || '' } : null;
  });
  check('there is still an open deal to work with', !!target, JSON.stringify(target));
  if (!target) return;
  const opened = await page.evaluate((id) => {
    const el = [...document.querySelectorAll('#grPipeline .gr_bc')].find(x => x.dataset.grOpen === id ||
      (x.getAttribute('data-gr-open') === id));
    if (el) el.click();
    return !!el;
  }, target.id);
  check('their card is on the board', opened, target.name);
  await page.waitForTimeout(700);
  const who = await page.evaluate(() =>
    (document.querySelector('#grSheet h2, #grSheet .gr_sh b') || {}).textContent || '');
  check('and the sheet is showing them', who.indexOf(target.name.split(' ')[0]) >= 0,
    who + ' vs ' + target.name);
  // Kelsey is at "booked": no call held, nothing written, no email. The stepper must
  // show that, because the stage alone cannot -- a deal parked in "proposal" with no
  // email ever sent looks identical to one that is going fine.
  const j = await page.evaluate(() => {
    const steps = [...document.querySelectorAll('#grSheet .gr_jr span')];
    return steps.map(x => ({ t: x.textContent.trim(), on: x.classList.contains('gr_jon'),
                             dot: Math.round((x.querySelector('i') || {}).getBoundingClientRect?.().width || 0) }));
  });
  check('there are four steps', j.length === 4, JSON.stringify(j.map(x => x.t)));
  check('named Booked, Met, Notes, Emailed',
    JSON.stringify(j.map(x => x.t)) === JSON.stringify(['Booked', 'Met', 'Notes', 'Emailed']),
    JSON.stringify(j.map(x => x.t)));
  // Measured, not asserted present: a dot at 0px wide has passed a check in this repo.
  check('every dot is drawn', j.every(x => x.dot >= 8), JSON.stringify(j.map(x => x.dot)));
  // Worked out here from the row rather than read off the screen, so this measures the
  // stepper's rule and not just that four dots exist.
  const want = {
    met: target.calls > 0 || target.stage !== 'booked',
    notes: (target.calls > 0 || target.stage !== 'booked') && !!target.summary.trim(),
    mailed: target.sent > 0
  };
  check('Booked is always lit', j[0].on === true, JSON.stringify(j.map(x => x.on)));
  check('Met matches whether a call has happened', j[1].on === want.met,
    j[1].on + ' vs ' + want.met);
  check('Notes matches whether anything was written', j[2].on === want.notes,
    j[2].on + ' vs ' + want.notes);
  check('Emailed matches whether an email has gone', j[3].on === want.mailed,
    j[3].on + ' vs ' + want.mailed);
});

await step('"+ Call held" records the call, and Undo takes it back', async () => {
  const before = await page.evaluate(() => {
    const c = window.__mockDB.growth_clients.find(x => x.stage !== 'won' && x.stage !== 'lost');
    return { id: c.id, calls: c.calls_held || 0, stage: c.stage, last: c.last_call_on,
             steps: [...document.querySelectorAll('#grSheet .gr_jr span')].map(x => x.classList.contains('gr_jon')) };
  });
  await page.locator('#grSheet [data-gr-logcall]').click();
  await page.waitForTimeout(800);
  const after = await page.evaluate((id) => {
    const c = window.__mockDB.growth_clients.find(x => x.id === id);
    const steps = [...document.querySelectorAll('#grSheet .gr_jr span')].map(x => x.classList.contains('gr_jon'));
    return { calls: c.calls_held, stage: c.stage, last: c.last_call_on, steps,
             toast: (document.getElementById('grToast') || {}).textContent || '',
             undo: !!document.querySelector('#grToast [data-gr-undo]') };
  }, before.id);
  check('the call count went up in the database', after.calls === before.calls + 1,
    before.calls + ' -> ' + after.calls);
  check('and the stage moved off booked', after.stage === 'call', after.stage);
  check('the date is today', after.last === new Date().toISOString().slice(0, 10), after.last);
  check('the journey lights Met', after.steps[1] === true, JSON.stringify(after.steps));
  check('the toast offers an Undo', after.undo, after.toast);

  await page.locator('#grToast [data-gr-undo]').click();
  await page.waitForTimeout(900);
  const undone = await page.evaluate((id) => {
    const c = window.__mockDB.growth_clients.find(x => x.id === id);
    return { calls: c.calls_held, stage: c.stage, last: c.last_call_on,
             steps: [...document.querySelectorAll('#grSheet .gr_jr span')].map(x => x.classList.contains('gr_jon')) };
  }, before.id);
  // All three fields, not just the count: an undo that restores the number and leaves
  // the stage moved is the kind of half-undo nobody notices until the board is wrong.
  check('Undo puts the count back', undone.calls === before.calls, undone.calls + '');
  check('Undo puts the stage back', undone.stage === before.stage, undone.stage);
  check('Undo puts the date back', (undone.last || null) === (before.last || null), String(undone.last));
  // Back to exactly the stepper it had before, whatever that was: this client may well
  // have had a call on record already, and "goes dark" would then be the wrong rule.
  check('and the journey reads as it did before',
    JSON.stringify(undone.steps) === JSON.stringify(before.steps),
    JSON.stringify(undone.steps) + ' vs ' + JSON.stringify(before.steps));
});

await step('"+ Email sent" logs a message, and Undo removes it again', async () => {
  const before = await page.evaluate(() => {
    const c = window.__mockDB.growth_clients.find(x => x.stage !== 'won' && x.stage !== 'lost');
    return { id: c.id, sent: c.emails_sent || 0,
             msgs: window.__mockDB.growth_messages.filter(m => m.client_id === c.id).length };
  });
  await page.locator('#grSheet [data-gr-logmail]').click();
  await page.waitForTimeout(1000);
  const after = await page.evaluate((b) => {
    const c = window.__mockDB.growth_clients.find(x => x.id === b.id);
    return { sent: c.emails_sent,
             msgs: window.__mockDB.growth_messages.filter(m => m.client_id === b.id).length,
             undo: !!document.querySelector('#grToast [data-gr-undo]') };
  }, before);
  check('a message row is written', after.msgs === before.msgs + 1, before.msgs + ' -> ' + after.msgs);
  check('and the count on the client goes up', after.sent === before.sent + 1, after.sent + '');
  check('with an Undo offered', after.undo);

  await page.locator('#grToast [data-gr-undo]').click();
  await page.waitForTimeout(1000);
  const undone = await page.evaluate((b) => {
    const c = window.__mockDB.growth_clients.find(x => x.id === b.id);
    return { sent: c.emails_sent,
             msgs: window.__mockDB.growth_messages.filter(m => m.client_id === b.id).length };
  }, before);
  check('Undo puts the count back', undone.sent === before.sent, undone.sent + '');
  // The row has to go as well, or the timeline keeps a ghost of an email nobody sent.
  check('and the message row is gone with it', undone.msgs === before.msgs,
    before.msgs + ' vs ' + undone.msgs);
});

await step('Won asks the amount in a sheet, not a browser prompt', async () => {
  await page.locator('#grSheet [data-gr-won]').click();
  await page.waitForTimeout(600);
  const d = await page.evaluate(() => {
    const w = document.querySelector('[data-gr-wonwrap]');
    if (!w) return null;
    return { packs: [...w.querySelectorAll('[data-gr-wonv]')].map(b => b.textContent.trim()),
             box: !!document.getElementById('grWonAmt'),
             go: !!w.querySelector('[data-gr-wongo]') };
  });
  check('the Won sheet opened', !!d, '');
  if (!d) return;
  // The packs come from Settings, so the prices offered are the ones we actually sell.
  check('it offers the packs we sell', d.packs.length >= 2, JSON.stringify(d.packs));
  check('the prices are on them', d.packs.every(t => /\$/.test(t)), JSON.stringify(d.packs));
  check('and there is a box for anything else', d.box && d.go);

  await page.locator('[data-gr-wonv]').first().click();
  await page.waitForTimeout(400);
  const filled = await page.evaluate(() => (document.getElementById('grWonAmt') || {}).value);
  check('choosing a pack fills the amount', Number(filled) > 0, filled);

  const was = await page.evaluate(() => {
    const c = window.__mockDB.growth_clients.find(x => x.stage !== 'won' && x.stage !== 'lost');
    return { id: c.id, stage: c.stage, value: c.value_monthly, won: c.won_on };
  });
  await page.locator('[data-gr-wongo]').click();
  await page.waitForTimeout(900);
  const now = await page.evaluate((id) => {
    const c = window.__mockDB.growth_clients.find(x => x.id === id);
    return { stage: c.stage, value: c.value_monthly, won: c.won_on,
             undo: !!document.querySelector('#grToast [data-gr-undo]'),
             dialog: !!document.querySelector('[data-gr-wonwrap]') };
  }, was.id);
  check('the deal is won in the database', now.stage === 'won', now.stage);
  check('at the amount that was chosen', Number(now.value) === Number(filled),
    now.value + ' vs ' + filled);
  check('dated today', now.won === new Date().toISOString().slice(0, 10), String(now.won));
  check('the sheet closed behind it', !now.dialog);
  check('and it can be undone', now.undo);

  await page.locator('#grToast [data-gr-undo]').click();
  await page.waitForTimeout(900);
  const back = await page.evaluate((id) => {
    const c = window.__mockDB.growth_clients.find(x => x.id === id);
    return { stage: c.stage, value: c.value_monthly, won: c.won_on };
  }, was.id);
  check('Undo puts the stage back', back.stage === was.stage, back.stage + ' vs ' + was.stage);
  check('and the amount back to what it was',
    (back.value || null) === (was.value || null), String(back.value) + ' vs ' + String(was.value));
  check('and clears the won date', (back.won || null) === (was.won || null), String(back.won));
});

/* Replying used to mean writing from memory: the thread was behind the composer, and
   going back to read it lost the draft. The pane puts what they wrote beside the box. */
await step('replying shows the thread and what we know about them', async () => {
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  await navOf('gr_pipeline').click(); await page.waitForTimeout(700);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('#grPipeline .gr_bc')].find(x => /Michael/.test(x.textContent));
    if (el) el.click();
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => { const b = document.querySelector('#grSheet [data-gr-act]'); if (b) b.click(); });
  await page.waitForTimeout(900);
  const m = await page.evaluate(() => {
    const pane = document.querySelector('.gr_rsl');
    const comp = document.querySelector('.gr_comp');
    if (!pane || !comp) return { pane: !!pane, comp: !!comp };
    const pr = pane.getBoundingClientRect(), cr = comp.getBoundingClientRect();
    return {
      pane: true, comp: true,
      label: (pane.querySelector('.gr_rsk') || {}).textContent || '',
      body: (pane.querySelector('.gr_rsmb') || {}).textContent || '',
      older: pane.querySelectorAll('.gr_rso').length,
      know: (pane.querySelector('.gr_rsknow') || {}).textContent || '',
      // Beside, not behind: the pane has to sit to the LEFT of the box, or it is just
      // a second thing covering the first.
      sideBySide: Math.round(pr.right) <= Math.round(cr.left) + 2,
      paneW: Math.round(pr.width), paneH: Math.round(pr.height)
    };
  });
  check('the thread pane is there', m.pane && m.comp, JSON.stringify(m));
  if (!m.pane) return;
  check('and it is drawn at a readable size', m.paneW > 200 && m.paneH > 100,
    m.paneW + 'x' + m.paneH);
  check('it sits beside the box, not over it', m.sideBySide, JSON.stringify(m));
  check('the last message is shown in full', m.body.length > 10, m.body.slice(0, 60));
  // "Good to know" is the call note's headline and wants -- the thing somebody would
  // otherwise close the composer to go and look up.
  check('"Good to know" carries the call note', /Good to know/i.test(m.know) && /\$80k/.test(m.know),
    m.know.slice(0, 120));
  check('what they want is listed under it', /qualified leads/i.test(m.know), m.know.slice(0, 160));
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
});

await step('a brand new email has no thread pane to show', async () => {
  // Kelsey has never been emailed, so there is nothing to put beside the box and the
  // composer should be on its own rather than next to an empty rectangle.
  const none = await page.evaluate(() => {
    const c = window.__mockDB.growth_clients.find(x =>
      !window.__mockDB.growth_messages.some(m => m.client_id === x.id) &&
      x.stage !== 'won' && x.stage !== 'lost');
    return c ? c.id : null;
  });
  if (!none) { check('a never-emailed client exists to test with', false, 'none'); return; }
  await page.evaluate((id) => {
    const el = [...document.querySelectorAll('#grPipeline .gr_bc')]
      .find(x => x.getAttribute('data-gr-open') === id);
    if (el) el.click();
  }, none);
  await page.waitForTimeout(600);
  await page.evaluate(() => { const b = document.querySelector('#grSheet [data-gr-act]'); if (b) b.click(); });
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => ({
    comp: !!document.querySelector('.gr_comp'),
    pane: !!document.querySelector('.gr_rsl')
  }));
  check('the composer still opens', r.comp);
  check('and there is no empty thread pane beside it', !r.pane);
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
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
