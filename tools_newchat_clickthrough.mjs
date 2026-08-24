/* Click-through test for New Chat.  Run:  node tools_newchat_clickthrough.mjs
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
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const consoleErrors = [];
const pageErrors = [];
const blocked = [];
page.on('console', m => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400));
  if (m.type() === 'warning' && /newchat/.test(m.text())) consoleErrors.push('WARN ' + m.text().slice(0, 300));
});
page.on('pageerror', e => pageErrors.push(String(e.message || e).slice(0, 400)));

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
check('supabase-js was replaced by the mock', await page.evaluate(() => !!(window.supabase && window.supabase.__isMock)));

// ── the nav item is visible to this role, and clicking it opens the screen ───
await step('New Chat nav item is present for owner', async () => {
  const nav = page.locator('.nav-item[data-screen="newchat"]');
  await nav.waitFor({ state: 'visible', timeout: 20000 });
  check('New Chat nav item is present for owner', true);
  await nav.click();
});

await step('New Chat screen becomes active', async () => {
  await page.waitForSelector('.screen[data-screen="newchat"].on', { timeout: 20000 });
  check('New Chat screen becomes active', true);
});

// init is deferred until giantSupabase/giantSession/giantCurrentProfile exist
await step('New Chat initialises (channel rows render)', async () => {
  await page.waitForFunction(
    () => document.querySelectorAll('#nc_chatChannelList .nc_ch-item[data-nc-channel-id]').length > 0,
    null, { timeout: 40000 });
  check('New Chat initialises (channel rows render)', true);
});

await step('the init failure screen did not replace the pane', async () => {
  const failed = await page.evaluate(() =>
    document.querySelector('.screen[data-screen="newchat"]').textContent.includes('New Chat could not start'));
  check('the init failure screen did not replace the pane', !failed);
});

// ── DOM structure: the trap the audit cannot see ─────────────────────────────
const structure = await page.evaluate(() => {
  const ids = ['nc_chatMediaPane', 'nc_chatCanvasPane', 'nc_inboxPane', 'nc_magnusPane',
               'nc_tasksPane', 'nc_mgmtPane'];
  const msgs = document.getElementById('nc_chatMsgs');
  const strip = document.querySelector('.nc_tabstrip');
  const out = { msgsParent: msgs && msgs.parentElement.className, panes: {} };
  ids.forEach(id => {
    const el = document.getElementById(id);
    out.panes[id] = !el ? 'MISSING' : {
      sameParentAsMsgs: el.parentElement === (msgs && msgs.parentElement),
      insideTabstrip: !!(strip && strip.contains(el)),
      parent: el.parentElement.id || el.parentElement.className
    };
  });
  out.tabstripHeight = strip ? strip.getBoundingClientRect().height : null;
  const tabs = [...document.querySelectorAll('#nc_chatSubTabs .nc_chat-subtab')];
  const tops = new Set(tabs.filter(t => t.offsetParent).map(t => Math.round(t.getBoundingClientRect().top)));
  out.tabRows = tops.size;
  out.deptTabs = document.querySelectorAll('#nc_deptStrip .nc_dept-tab').length;
  return out;
});

check('every pane is a sibling of the message list',
  Object.values(structure.panes).every(p => p !== 'MISSING' && p.sameParentAsMsgs),
  JSON.stringify(structure.panes));
check('no pane is nested inside .nc_tabstrip',
  Object.values(structure.panes).every(p => p !== 'MISSING' && !p.insideTabstrip));
check('the tab strip is one line', structure.tabRows <= 1,
  'tab rows=' + structure.tabRows + ' height=' + structure.tabstripHeight);

// ── sidebar: accordion, all clients listed ───────────────────────────────────
const sidebar = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.nc_navcard')];
  const open = cards.filter(c => {
    const b = c.querySelector('.nc_navcard-body');
    return b && b.getBoundingClientRect().height > 4;
  });
  const rects = cards.map(c => Math.round(c.getBoundingClientRect().height));
  return {
    cards: cards.length,
    openCards: open.length,
    heights: rects,
    counts: cards.map(c => (c.querySelector('.nc_navcard-count') || {}).textContent || ''),
    clients: document.querySelectorAll('#nc_cardClientsBody .nc_ch-item').length,
    teams: document.querySelectorAll('#nc_cardTeamsBody .nc_ch-item').length,
    direct: document.querySelectorAll('#nc_cardDirectBody .nc_ch-item').length,
    dimmedClients: [...document.querySelectorAll('#nc_cardClientsBody .nc_ch-item')]
      .filter(r => parseFloat(r.style.opacity || '1') < 1).length
  };
});
check('sidebar renders its six nav cards', sidebar.cards === 6, 'cards=' + sidebar.cards);
check('sidebar behaves as an accordion (one card open)', sidebar.openCards === 1,
  'open=' + sidebar.openCards + ' heights=' + sidebar.heights.join(','));
check('all 53 clients are listed', sidebar.clients === 53, 'clients=' + sidebar.clients);
check('clients without a channel render dimmed', sidebar.dimmedClients === 42,
  'dimmed=' + sidebar.dimmedClients + ' (expect 53 - 11 threads = 42)');
check('11 team channels + home are listed', sidebar.teams === 12, 'teams=' + sidebar.teams);
check('80 DMs are listed', sidebar.direct === 80, 'direct=' + sidebar.direct);

// Every nav card had the same coloured dot, so the rail read as one undifferentiated
// block you had to parse by label. Each card now carries its own icon; assert they are
// real and distinct, because "a dot in a tinted square" and "an icon in a tinted square"
// are one CSS line apart.
await step('each nav card has its own icon, not a dot', async () => {
  const n = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.nc_navcard')];
    // The FIRST span in the head is the tile. Any span will also match the chevron's,
    // which made the previous version of this report six icons on a build that had none.
    const shapes = cards.map(c => {
      const tile = c.querySelector('.nc_navcard-head > span:first-child > svg');
      return tile ? tile.innerHTML.replace(/\s+/g, '') : null;
    });
    return { cards: cards.length,
             withIcon: shapes.filter(Boolean).length,
             distinct: new Set(shapes.filter(Boolean)).size,
             dotsLeft: cards.filter(c =>
               c.querySelector('.nc_navcard-head > span:first-child > span[style*="border-radius:50%"]')).length };
  });
  check('each nav card has its own icon, not a dot',
    n.cards === 6 && n.withIcon === 6 && n.distinct === 6 && n.dotsLeft === 0,
    JSON.stringify(n));
});

// Three ways the DM list could come up empty while DMs existed, all silent: a persisted
// scope filter with no control left to change it, a counterparty profile that had not
// resolved dropping the whole row, and the "start a DM" fallback rows never reaching the
// card. The mock has no RLS and a fully-hydrated profile cache, which is exactly why none
// of them ever showed up here.
await step('a DM still lists when its counterparty has not resolved', async () => {
  const r = await page.evaluate(async () => {
    const db = window.__mock.db, me = window.__mock.me;
    const dm = db.channels.find(c => c.is_dm);
    const other = db.channel_members.find(m => m.channel_id === dm.id && m.profile_id !== me);
    // a counterparty the profile cache cannot resolve
    const orphan = 'u-ghost';
    other.profile_id = orphan;
    // Set the scope through the control that set it, not by assignment: the toggle still
    // exists in the DOM behind the accordion, and its handler is what re-renders both
    // lists. Poking window.nc__chatScope and calling the renderer only worked on the
    // build that exposes it -- the first version of this check passed on the broken one
    // because the call was a no-op there and it read the previous render.
    const btn = document.querySelector('.nc_ch-scope-btn[data-scope="clients"]');
    if (!btn) return { noToggle: true };
    btn.click();
    await new Promise(r => setTimeout(r, 2000));
    const src = document.getElementById('nc_chatDmList');
    const out = { listed: src.querySelectorAll('[data-nc-dm-channel-id]').length,
                  orphanListed: !!src.querySelector(`[data-nc-dm-channel-id="${dm.id}"]`) };
    // Put the scope back through the same control. Leaving it set is global state, and it
    // cost the Needs you check five rows further down the run before this line existed.
    const back = document.querySelector('.nc_ch-scope-btn[data-scope="team"]');
    if (back) back.click();
    await new Promise(r => setTimeout(r, 1200));
    try { localStorage.removeItem('giant_nc_chat_scope'); } catch (e) {}
    return out;
  });
  check('a DM still lists when its counterparty has not resolved',
    !r.noToggle && r.listed > 1 && r.orphanListed, JSON.stringify(r));
});

// ── open a team channel and read messages ────────────────────────────────────
await step('a team channel opens and paints messages', async () => {
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.nc_navcard')].find(c => c.dataset.nccard === 'teams');
    if (card) card.querySelector('.nc_navcard-head').click();
  });
  await page.locator('#nc_cardTeamsBody .nc_ch-item').first().click();
  await page.waitForFunction(
    () => document.querySelectorAll('#nc_chatMsgsList .nc_msg, #nc_chatMsgsList [data-message-id]').length > 0,
    null, { timeout: 20000 });
  const n = await page.evaluate(() =>
    document.querySelectorAll('#nc_chatMsgsList .nc_msg, #nc_chatMsgsList [data-message-id]').length);
  check('a team channel opens and paints messages', n > 0, 'messages rendered=' + n);
});

// The header used to print the workspace profile count, so it read the same number on
// every channel. The fixture gives each team channel 5 members against 81 profiles, which
// is what makes the two cases distinguishable at all.
// The count now arrives one round trip after the channel switch -- the base topic is
// painted synchronously and the count appended when channel_members resolves -- so this
// has to wait for it rather than read straight after the message list.
await step('the header counts this channel\'s members, not the workspace', async () => {
  await page.waitForFunction(
    () => /·\s*\d+\s*member/.test(document.getElementById('nc_chatHeadTopic').textContent),
    null, { timeout: 15000 });
  const m = await page.evaluate(async () => {
    const topic = document.getElementById('nc_chatHeadTopic').textContent;
    const shown = /·\s*(\d+)\s*member/.exec(topic);
    const cid = window.nc_activeChannelId;
    return { topic, shown: shown ? +shown[1] : null,
             actual: window.__mock.db.channel_members.filter(x => x.channel_id === cid).length,
             profiles: window.__mock.db.profiles.length };
  });
  check('the header counts this channel\'s members, not the workspace',
    m.shown !== null && m.shown === m.actual && m.shown !== m.profiles,
    'header said ' + m.shown + ', channel has ' + m.actual + ', workspace has ' + m.profiles);
});

// Duplicate reply badges have shipped twice: once from _boot running twice, and once from
// a de-dupe guard that looked for '.nc_msg-reply-cta' while the element was created
// unprefixed, so it never matched and every re-render appended another. The old version of
// this check counted anything with "reply" in a class name and reported 0 -- there were no
// badges on screen at all, so it was passing on an empty set.
await step('a message with replies shows exactly one reply badge', async () => {
  const open = await page.evaluate(async () => {
    // a channel that definitely has a message with replies
    const db = window.__mock.db;
    const parent = db.messages.find(m => m.reply_count > 0
      && db.messages.some(r => r.parent_id === m.id));
    if (!parent) return null;
    const row = [...document.querySelectorAll('#nc_cardTeamsBody .nc_ch-item, #nc_cardClientsBody .nc_ch-item')]
      .find(el => (el.dataset.ncChannelId || el.dataset.ncDmChannelId) === parent.channel_id);
    if (row) row.click(); else window.nc_switchChatSubtab && null;
    return { channel: parent.channel_id, clicked: !!row };
  });
  if (!open || !open.clicked) { check('a message with replies shows exactly one reply badge', false, JSON.stringify(open)); return; }
  await page.waitForFunction(
    () => document.querySelectorAll('#nc_chatMsgsList .nc_msg-reply-cta, #nc_chatMsgsList .msg-reply-cta').length > 0,
    null, { timeout: 20000 }).catch(() => {});
  const count = async () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('#nc_chatMsgsList [data-msg-id], #nc_chatMsgsList [data-message-id]')];
    let worst = 0, total = 0;
    rows.forEach(r => {
      const n = r.querySelectorAll('.nc_msg-reply-cta, .msg-reply-cta').length;
      total += n;
      if (n > worst) worst = n;
    });
    return { worst, total };
  });
  const first = await count();
  // The invariant the duplicate came from: the guard removes '.nc_msg-reply-cta' before
  // appending, so a badge built with any other class can never be de-duplicated. A channel
  // switch will not reproduce that -- it rebuilds the list from fresh elements -- and the
  // realtime paths that re-attach to a LIVE element are what actually double it.
  const classed = await page.evaluate(() => {
    const all = [...document.querySelectorAll('#nc_chatMsgsList .nc_msg-reply-cta, #nc_chatMsgsList .msg-reply-cta')];
    return { total: all.length,
             guardable: all.filter(e => e.classList.contains('nc_msg-reply-cta')).length };
  });
  // Leave and come back. The append-on-every-render bug only shows on the second pass, and
  // switching channels is how a person triggers it.
  await page.evaluate(() => {
    const other = [...document.querySelectorAll('#nc_cardTeamsBody .nc_ch-item')]
      .find(el => el.dataset.ncChannelId !== window.nc_activeChannelId);
    if (other) other.click();
  });
  await page.waitForTimeout(1500);
  await page.evaluate((cid) => {
    const back = [...document.querySelectorAll('#nc_cardTeamsBody .nc_ch-item, #nc_cardClientsBody .nc_ch-item')]
      .find(el => (el.dataset.ncChannelId || el.dataset.ncDmChannelId) === cid);
    if (back) back.click();
  }, open.channel);
  await page.waitForTimeout(2500);
  const second = await count();
  check('a message with replies shows exactly one reply badge',
    first.total > 0 && first.worst === 1 && second.worst === 1
      && classed.total > 0 && classed.guardable === classed.total,
    JSON.stringify({ first, classed, second }));
});

// ── open a client thread: department strip + the three extra tabs ────────────
await step('a client thread opens with its department strip', async () => {
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.nc_navcard')].find(c => c.dataset.nccard === 'clients');
    if (card) card.querySelector('.nc_navcard-head').click();
  });
  // the first client row that is NOT dimmed, i.e. one that actually has a channel
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#nc_cardClientsBody .nc_ch-item')]
      .find(r => parseFloat(r.style.opacity || '1') === 1);
    if (row) row.click();
  });
  await page.waitForFunction(
    () => document.querySelectorAll('#nc_deptStrip .nc_dept-tab').length > 0, null, { timeout: 20000 });
  const st = await page.evaluate(() => ({
    depts: document.querySelectorAll('#nc_deptStrip .nc_dept-tab').length,
    stripVisible: getComputedStyle(document.getElementById('nc_deptStrip')).display !== 'none',
    tasksTab: getComputedStyle(document.getElementById('nc_tasksTabBtn')).display !== 'none',
    magnusTab: getComputedStyle(document.getElementById('nc_magnusTabBtn')).display !== 'none',
    mgmtTab: getComputedStyle(document.getElementById('nc_mgmtTabBtn')).display !== 'none',
    messagesTab: !!document.querySelector('#nc_chatSubTabs [data-subtab="messages"]')
      && getComputedStyle(document.querySelector('#nc_chatSubTabs [data-subtab="messages"]')).display !== 'none'
  }));
  check('a client thread opens with its department strip', st.stripVisible && st.depts === 5,
    'depts=' + st.depts + ' visible=' + st.stripVisible);
  check('Tasks, Magnus and Management tabs appear on a client thread',
    st.tasksTab && st.magnusTab && st.mgmtTab, JSON.stringify(st));
  check('the Messages tab is dropped on a client thread', !st.messagesTab,
    'messages tab visible=' + st.messagesTab);
});

// still one line with the department strip in it
// One line means every tab shares a row, not that they share a `top`: the department
// tabs are shorter than the sub-tabs and the strip centres them, so identical tops
// would actually be the wrong thing to assert. Compare vertical centres, and the
// strip's own height.
await step('the tab strip stays one line on a client thread', async () => {
  const m = await page.evaluate(() => {
    const els = [...document.querySelectorAll('#nc_deptStrip .nc_dept-tab, #nc_chatSubTabs .nc_chat-subtab')]
      .filter(e => e.offsetParent);
    const centres = els.map(e => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; });
    const strip = document.querySelector('.nc_tabstrip').getBoundingClientRect();
    return { n: els.length, spread: Math.round(Math.max(...centres) - Math.min(...centres)),
             stripHeight: Math.round(strip.height),
             overflows: els.some(e => e.getBoundingClientRect().right > strip.right + 1) };
  });
  check('the tab strip stays one line on a client thread',
    m.n >= 9 && m.spread <= 2 && m.stripHeight <= 52,
    'tabs=' + m.n + ' centre spread=' + m.spread + 'px strip height=' + m.stripHeight
      + ' overflowing=' + m.overflows);
});

// ── every tab: does it paint ITS OWN pane? ───────────────────────────────────
const PANE_OF = { media: 'nc_chatMediaPane', canvas: 'nc_chatCanvasPane', tasks: 'nc_tasksPane',
                  magnus: 'nc_magnusPane', management: 'nc_mgmtPane' };

for (const [tab, paneId] of Object.entries(PANE_OF)) {
  await step('tab "' + tab + '" paints ' + paneId, async () => {
    // fingerprint every pane first, so a renderer painting the wrong one is visible
    const before = await page.evaluate((ids) => {
      const o = {};
      ids.forEach(id => { const e = document.getElementById(id); o[id] = e ? e.innerHTML.length : -1; });
      return o;
    }, Object.values(PANE_OF));

    await page.evaluate((t) => window.nc_switchChatSubtab(t), tab);
    await page.waitForFunction((id) => {
      const e = document.getElementById(id);
      return e && getComputedStyle(e).display !== 'none' && e.innerHTML.trim().length > 0;
    }, paneId, { timeout: 20000 }).catch(() => {});

    const after = await page.evaluate((ids) => {
      const o = {};
      ids.forEach(id => { const e = document.getElementById(id); o[id] = e ? e.innerHTML.length : -1; });
      return o;
    }, Object.values(PANE_OF));

    const vis = await page.evaluate((id) => {
      const e = document.getElementById(id);
      const r = e.getBoundingClientRect();
      return { display: getComputedStyle(e).display, chars: e.innerHTML.trim().length,
               w: Math.round(r.width), h: Math.round(r.height) };
    }, paneId);

    check('tab "' + tab + '" shows its pane', vis.display !== 'none' && vis.chars > 0,
      JSON.stringify(vis));
    // "renders squeezed into the tab bar" was the symptom of the wrong-parent bug
    check('tab "' + tab + '" pane has room to render', vis.h > 200 && vis.w > 400,
      vis.w + 'x' + vis.h);

    const strayed = Object.keys(after).filter(id => id !== paneId && after[id] !== before[id]);
    check('tab "' + tab + '" repainted no other pane', strayed.length === 0,
      strayed.length ? 'also repainted: ' + strayed.join(', ') : '');
  });
}

// The strip is one row of tabs, so exactly one thing in it may look selected. Only the
// messages view lights a department; every tool tab clears it. Which department you are
// in stays legible in the header directly above.
await step('only one tab in the strip is ever active', async () => {
  const read = () => page.evaluate(() => ({
    on: [...document.querySelectorAll('#nc_deptStrip .nc_dept-tab')]
      .filter(t => t.classList.contains('nc_on')).map(t => t.dataset.ncDept),
    tab: window.nc__chatSubtab || 'messages'
  }));
  const seen = {};
  for (const t of ['messages', 'media', 'canvas', 'tasks', 'magnus', 'management']) {
    await page.evaluate((x) => window.nc_switchChatSubtab(x), t);
    await page.waitForTimeout(350);
    seen[t] = (await read()).on;
  }
  await page.evaluate(() => window.nc_openInbox && window.nc_openInbox());
  await page.waitForTimeout(600);
  seen.inbox = (await read()).on;

  const ok = seen.messages.length === 1
    && ['media', 'canvas', 'tasks', 'magnus', 'management', 'inbox']
         .every(t => seen[t].length === 0);
  check('only one tab in the strip is ever active', ok, JSON.stringify(seen));
});

// ── Management > Overview, in detail ─────────────────────────────────────────
// "The pane has content" is too weak a check: the pane rendered its own
// "No client record loaded" state for a whole run and still passed, because a fixture
// key was wrong. These assert what is actually on it.
await step('Overview renders the client record, not its empty state', async () => {
  await page.evaluate(() => window.nc_switchChatSubtab('management'));
  await page.waitForFunction(
    () => document.getElementById('nc_mgmtPane').innerHTML.length > 4000, null, { timeout: 20000 })
    .catch(() => {});
  const o = await page.evaluate(() => {
    const pane = document.getElementById('nc_mgmtPane');
    const t = pane.innerText;
    const cid = (window.__mock.db.channels.find(c => c.id === window.nc_activeChannelId) || {}).client_id;
    const name = (window.__mock.db.clients.find(c => c.id === cid) || {}).name;
    return { empty: t.includes('No client record loaded'), name,
             hasName: !!name && t.includes(name), hasMrr: /\bMRR\b/.test(t),
             folds: pane.querySelectorAll('[data-c3-mgmt-fold]').length,
             serviceRows: (t.match(/Active|Not active/g) || []).length,
             chars: pane.innerHTML.length };
  });
  check('Overview renders the client record, not its empty state',
    !o.empty && o.hasName && o.hasMrr, JSON.stringify(o));
});

await step('Overview\'s collapsed sections open on click', async () => {
  const before = await page.evaluate(() => document.getElementById('nc_mgmtPane').innerHTML.length);
  await page.evaluate(() => document.querySelector('[data-c3-mgmt-fold="access"]').click());
  await page.waitForFunction((n) => document.getElementById('nc_mgmtPane').innerHTML.length > n,
    before, { timeout: 10000 }).catch(() => {});
  const after = await page.evaluate(() => {
    const pane = document.getElementById('nc_mgmtPane');
    return { chars: pane.innerHTML.length, granted: pane.innerText.includes('GRANTED'),
             rows: pane.querySelectorAll('[data-c3-access-cycle]').length };
  });
  check('Overview\'s collapsed sections open on click',
    after.chars > before && after.rows === 5, JSON.stringify({ before, ...after }));
});

// The strip's rule runs the full width of the pane, hard against the sidebar, while its
// labels sit on the same gutter as the cards. Both are easy to undo by adding padding to
// a wrapper, and neither shows up in any static check.
await step('the Management tab strip is full-bleed and scrolls away', async () => {
  const r = await page.evaluate(async () => {
    const pane = document.getElementById('nc_mgmtPane');
    const strip = pane.querySelector('[data-c3-mgmt-tab]').parentElement;
    const card = pane.querySelector('[data-c3-mgmt-fold]');
    const pr = pane.getBoundingClientRect();
    const before = strip.getBoundingClientRect();
    const labelLeft = Math.round(strip.querySelector('[data-c3-mgmt-tab]').getBoundingClientRect().left - pr.left);
    const cardLeft = card ? Math.round(card.getBoundingClientRect().left - pr.left) : -1;
    pane.scrollTop = 300;
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    const after = strip.getBoundingClientRect();
    return { stripWidth: Math.round(before.width), paneWidth: pane.clientWidth,
             leftGap: Math.round(before.left - pr.left),
             labelLeft, cardLeft, scrolled: pane.scrollTop,
             movedBy: Math.round(before.top - after.top) };
  });
  check('the Management tab strip is full-bleed and scrolls away',
    r.stripWidth === r.paneWidth && r.leftGap === 0
      && r.scrolled > 0 && r.movedBy >= r.scrolled - 1
      && Math.abs(r.labelLeft - r.cardLeft) <= 2,
    JSON.stringify(r));
});

await step('the status pill offers every client status', async () => {
  const st = await page.evaluate(() => {
    const sel = document.querySelector('[data-c3-status-set]');
    if (!sel) return { missing: true };
    return { options: [...sel.options].map(o => o.value), selected: sel.value };
  });
  check('the status pill offers every client status',
    !st.missing && st.options.length === 5 && st.options.includes('churned') && !!st.selected,
    JSON.stringify(st));
});

// Activity claimed to show "messages ... and billing" while the trail can contain
// neither -- nothing writes a message or payment row -- and the reconstruction that
// could supply them was hidden as soon as one real row existed. For a client with any
// history that is immediately, so the tab showed a single line.
await step('Activity reconstructs the messages and payments the trail cannot hold', async () => {
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('[data-c3-mgmt-tab]')].find(x => x.dataset.c3MgmtTab === 'activity');
    if (t) t.click();
  });
  await page.waitForFunction(
    () => /reconstructed/i.test(document.getElementById('nc_mgmtPane').innerText),
    null, { timeout: 20000 }).catch(() => {});
  const a = await page.evaluate(() => {
    const pane = document.getElementById('nc_mgmtPane');
    const text = pane.innerText;
    const cid = (window.__mock.db.channels.find(c => c.id === window.nc_activeChannelId) || {}).client_id;
    const chans = window.__mock.db.channels.filter(c => c.client_id === cid).map(c => c.id);
    const msgs = window.__mock.db.messages
      .filter(m => chans.includes(m.channel_id) && !m.parent_id).length;
    const paid = window.__mock.db.invoices.filter(i => i.client_id === cid && i.paid_at).length;
    return { shown: +((/·\s*(\d+)\s*reconstructed/i.exec(text) || [])[1] || 0),
             expect: Math.min(msgs, 40) + paid,
             posted: (text.match(/posted a message/g) || []).length,
             // the caption must not promise what the trail cannot record
             overclaims: /Full history for this client/.test(text),
             chars: pane.innerHTML.length };
  });
  check('Activity reconstructs the messages and payments the trail cannot hold',
    a.shown > 1 && a.shown === a.expect && a.posted > 0 && !a.overclaims,
    JSON.stringify(a));
});

// c3AvatarStyle took (bg, fg) while its only caller passed three arguments, so
// avatar_url was dropped -- and the caller had already skipped the initials on the
// assumption the photo was there. Everyone with a profile picture got an empty circle.
await step('members with a profile picture render it, not an empty circle', async () => {
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('[data-c3-mgmt-tab]')].find(x => x.dataset.c3MgmtTab === 'members');
    if (t) t.click();
  });
  await page.waitForFunction(
    () => document.querySelectorAll('#nc_mgmtPane [data-nc-member]').length > 0,
    null, { timeout: 20000 });
  // naturalWidth, not "is there a src". The first version of this check asserted that a
  // background-image had been set, and passed while the URL was double-encoded and every
  // photo rendered as a black circle. A screenshot caught it; the check had not.
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('#nc_mgmtPane [data-nc-member] img')];
    return imgs.length > 0 && imgs.every(i => i.complete);
  }, null, { timeout: 15000 }).catch(() => {});
  const a = await page.evaluate(() => {
    const byId = Object.fromEntries(window.__mock.db.profiles.map(p => [p.id, p]));
    let withPhoto = 0, loaded = 0, broken = 0, blank = 0, initials = 0;
    document.querySelectorAll('#nc_mgmtPane [data-nc-member]').forEach(row => {
      const p = byId[row.dataset.ncMember];
      const mark = row.querySelector('div[style*="border-radius:50%"]');
      if (!p || !mark) return;
      const img = mark.querySelector('img');
      const txt = mark.textContent.trim();
      if (p.avatar_url) {
        withPhoto++;
        if (img && img.naturalWidth > 0) loaded++;
        else if (img) broken++;
        else if (!txt) blank++;   // the original failure: no photo AND no initials
      } else if (txt) initials++;
    });
    return { withPhoto, loaded, broken, blank, initials };
  });
  check('members with a profile picture render it, not an empty circle',
    a.withPhoto > 0 && a.loaded === a.withPhoto && a.broken === 0 && a.blank === 0
      && a.initials > 0,
    JSON.stringify(a));
});

// The Vault tab used to render two different screens: the client LIBRARY on client
// threads and the card Vault everywhere else, so what "Vault" meant depended on which
// conversation you were in. One thing now; the library moved to Management.
await step('the Vault is the same screen on a client thread and a team channel', async () => {
  const read = async () => page.evaluate(async () => {
    await new Promise(r => setTimeout(r, 900));
    const pane = document.getElementById('nc_chatCanvasPane');
    return { cards: pane.querySelectorAll('[data-c3-vault-add-card]').length,
             library: pane.querySelectorAll('[data-c3-lib-add], [data-c3-lib-kind]').length };
  });
  // a client thread
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.nc_navcard')].find(c => c.dataset.nccard === 'clients');
    if (card && card.querySelector('.nc_navcard-body').getBoundingClientRect().height < 4)
      card.querySelector('.nc_navcard-head').click();
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('#nc_cardClientsBody .nc_ch-item')]
      .find(x => parseFloat(x.style.opacity || '1') === 1 && x.dataset.ncChannelId);
    if (r) r.click();
  });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.nc_switchChatSubtab('canvas'));
  const onClient = await read();

  // a team channel
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.nc_navcard')].find(c => c.dataset.nccard === 'teams');
    if (card && card.querySelector('.nc_navcard-body').getBoundingClientRect().height < 4)
      card.querySelector('.nc_navcard-head').click();
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const r = document.querySelector('#nc_cardTeamsBody .nc_ch-item');
    if (r) r.click();
  });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.nc_switchChatSubtab('canvas'));
  const onTeam = await read();

  check('the Vault is the same screen on a client thread and a team channel',
    onClient.cards === 1 && onTeam.cards === 1
      && onClient.library === 0 && onTeam.library === 0,
    JSON.stringify({ onClient, onTeam }));
});

// and the library it used to occupy is reachable, in the pane that owns client data
await step('the client library is a Management tab', async () => {
  const r = await page.evaluate(async () => {
    const card = [...document.querySelectorAll('.nc_navcard')].find(c => c.dataset.nccard === 'clients');
    if (card && card.querySelector('.nc_navcard-body').getBoundingClientRect().height < 4)
      card.querySelector('.nc_navcard-head').click();
    await new Promise(r => setTimeout(r, 400));
    const row = [...document.querySelectorAll('#nc_cardClientsBody .nc_ch-item')]
      .find(x => parseFloat(x.style.opacity || '1') === 1 && x.dataset.ncChannelId);
    if (row) row.click();
    await new Promise(r => setTimeout(r, 1200));
    window.nc_switchChatSubtab('management');
    await new Promise(r => setTimeout(r, 1800));
    const tab = [...document.querySelectorAll('[data-c3-mgmt-tab]')]
      .find(x => x.dataset.c3MgmtTab === 'library');
    if (!tab) return { hasTab: false };
    tab.click();
    await new Promise(r => setTimeout(r, 2000));
    const pane = document.getElementById('nc_mgmtPane');
    return { hasTab: true,
             wired: pane.querySelectorAll('[data-c3-lib-add]').length,
             showsItems: /Brand kit|Reporting cadence|No items/i.test(pane.innerText) };
  });
  check('the client library is a Management tab',
    r.hasTab && r.wired > 0 && r.showsItems, JSON.stringify(r));
});

// ── Management > Members ─────────────────────────────────────────────────────
// The table lists the client's members, not the whole workspace. That is the change
// worth pinning: reverting it is a one-word edit and the symptom is 81 rows of empty
// checkboxes, which looks like data rather than a bug.
await step('Members lists the client\'s members, not everyone', async () => {
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('[data-c3-mgmt-tab]')].find(x => x.dataset.c3MgmtTab === 'members');
    if (t) t.click();
  });
  await page.waitForFunction(
    () => document.querySelectorAll('#nc_mgmtPane [data-nc-member]').length > 0,
    null, { timeout: 20000 }).catch(() => {});
  const m = await page.evaluate(() => {
    const pane = document.getElementById('nc_mgmtPane');
    const cid = (window.__mock.db.channels.find(c => c.id === window.nc_activeChannelId) || {}).client_id;
    const chans = window.__mock.db.channels.filter(c => c.kind === 'client_dept' && c.client_id === cid).map(c => c.id);
    // A member is anyone with a department channel row OR an area grant -- billing-only
    // access is still access, and the row has to exist for it to be revocable.
    const expect = new Set(window.__mock.db.channel_members
      .filter(x => chans.includes(x.channel_id)).map(x => x.profile_id));
    window.__mock.db.client_member_areas.filter(a => a.client_id === cid)
      .forEach(a => expect.add(a.profile_id));
    // Managers, owners and in-house devs are members of every client by role, with no
    // row anywhere, so they belong in the expected set too.
    window.__mock.db.profiles
      .filter(p => ['owner', 'manager', 'inhouse_dev'].includes(p.role) && !p.deactivated_at)
      .forEach(p => expect.add(p.id));
    // and a deactivated account is nobody's member, whatever rows it still holds
    window.__mock.db.profiles.filter(p => p.deactivated_at).forEach(p => expect.delete(p.id));
    const addBtn = pane.querySelector('[data-c3-member-add-open]');
    // Read the columns off the cells' own titles ("Hidden — Billing") rather than by
    // scraping header text: Onboarding and Billing are also Management sub-tabs, and
    // matching on visible strings picked those up instead.
    const labels = (sel) => [...new Set([...pane.querySelectorAll(sel)]
      .map(el => (el.title.split('—')[1] || '').trim()).filter(Boolean))].sort();
    const rows = pane.querySelectorAll('[data-nc-member]').length;
    // Every row has nine ticks whether or not they are clickable; the role-granted ones
    // carry no action, which is the point of them.
    const staff = new Set(window.__mock.db.profiles
      .filter(p => ['owner', 'manager', 'inhouse_dev'].includes(p.role)).map(p => p.id));
    const byRole = [...pane.querySelectorAll('[data-nc-tick-role="1"]')];
    return { rows, expected: expect.size, profiles: window.__mock.db.profiles.length,
             ticks: pane.querySelectorAll('[data-nc-tick]').length,
             lockedAllStaff: byRole.every(el => staff.has(el.dataset.ncTick.split(':')[0])),
             // an in-house dev is locked on all nine; a manager or owner only on the four
             // areas, because channels_select never gave them blanket channel read
             devLocked: byRole.filter(el => el.dataset.ncTick.startsWith('u-2:')).length,
             ownerLocked: byRole.filter(el => el.dataset.ncTick.startsWith('u-me:')).length,
             areaCols: labels('[data-c3-area-cell]'),
             deptCols: labels('[data-c3-matrix-cell]'),
             hasAddControl: !!addBtn };
  });
  check('Members lists the client\'s members, not everyone',
    m.rows === m.expected && m.rows > 0 && m.rows < m.profiles
      && m.ticks === m.rows * 9 && m.lockedAllStaff
      && m.devLocked === 9 && m.ownerLocked === 4
      && m.areaCols.join('|') === 'Billing|Deliverables|Onboarding|Tasks'
      // the rename: the department is "Web", not "Web Projects", everywhere it renders
      && m.deptCols.join('|') === 'General|Google Ads|Meta Ads|SEO|Web'
      && m.hasAddControl,
    JSON.stringify(m));
});

// A permissions grid whose last two columns are off-screen is the worst kind of hidden,
// so assert the whole table fits rather than trusting that it does.
await step('all nine permission columns fit without scrolling', async () => {
  const r = await page.evaluate(() => {
    const pane = document.getElementById('nc_mgmtPane');
    const scroller = pane.querySelector('[data-c3-member-remove]')
      .closest('div[style*="overflow-x"]');
    const cells = [...pane.querySelectorAll('[data-c3-area-cell]')];
    const last = cells[cells.length - 1];
    const sr = scroller.getBoundingClientRect();
    return { scrollW: scroller.scrollWidth, clientW: scroller.clientWidth,
             lastRight: Math.round(last.getBoundingClientRect().right),
             edge: Math.round(sr.right) };
  });
  // The guard matters more than the comparison: a hidden pane measures zero on every
  // axis, and 0 <= 0 passed this check while proving nothing.
  check('all nine permission columns fit without scrolling',
    r.clientW > 400 && r.lastRight > 0
      && r.scrollW <= r.clientW && r.lastRight <= r.edge, JSON.stringify(r));
});

// Deactivated accounts cannot sign in, so listing them is offering access to nobody.
// They stay in the profile CACHE, because their name belongs on the messages they wrote.
await step('deactivated accounts are not offered access', async () => {
  const d = await page.evaluate(() => {
    const pane = document.getElementById('nc_mgmtPane');
    const dead = new Set(window.__mock.db.profiles.filter(p => p.deactivated_at).map(p => p.id));
    const rows = [...pane.querySelectorAll('[data-nc-member]')].map(r => r.dataset.ncMember);
    return { deactivated: dead.size,
             inTable: rows.filter(id => dead.has(id)).length,
             cached: window.__mock.db.profiles.filter(p => p.deactivated_at).length };
  });
  check('deactivated accounts are not offered access',
    d.deactivated > 0 && d.inTable === 0, JSON.stringify(d));
});

// "+ Add member" was a bare <select>. It opens a searchable list now, with an invite
// path for people who have no account to tick.
await step('Add member opens a searchable list and can invite by email', async () => {
  await page.evaluate(() => document.querySelector('[data-c3-member-add-open]').click());
  await page.waitForSelector('#c3AddSearch', { timeout: 10000 });
  const before = await page.evaluate(() => ({
    picks: document.querySelectorAll('[data-c3-member-add-pick]').length,
    invites: window.__mock.db.invitations.length,
  }));

  // Search for an email taken from the list itself. Guessing a name matched eleven
  // people ("member 7" also matches 70-79), and guessing an id matched nobody, because
  // whether a given person is addable depends on the fixture's membership seeding.
  const term = await page.evaluate(() => {
    const row = document.querySelector('[data-c3-member-add-pick]');
    return (row.dataset.ncAddName.match(/\S+@\S+/) || [''])[0];
  });
  // the search filters in the DOM, so the caret survives -- a re-render would not
  await page.fill('#c3AddSearch', term);
  await page.waitForTimeout(250);
  const filtered = await page.evaluate(() => ({
    visible: [...document.querySelectorAll('[data-c3-member-add-pick]')]
      .filter(el => el.style.display !== 'none').length,
    focused: document.activeElement && document.activeElement.id === 'c3AddSearch',
  }));

  await page.fill('#c3AddSearch', '');
  await page.fill('#c3InviteEmail', 'brand.new@example.com');
  await page.evaluate(() => document.querySelector('[data-c3-member-invite]').click());
  await page.waitForFunction((n) => window.__mock.db.invitations.length > n,
    before.invites, { timeout: 15000 }).catch(() => {});
  const after = await page.evaluate(() => {
    const inv = window.__mock.db.invitations[window.__mock.db.invitations.length - 1];
    return { invites: window.__mock.db.invitations.length,
             email: inv && inv.email, hasToken: !!(inv && inv.token && inv.token.length >= 40) };
  });

  check('Add member opens a searchable list and can invite by email',
    before.picks > 1 && filtered.visible === 1 && filtered.focused
      && after.invites === before.invites + 1
      && after.email === 'brand.new@example.com' && after.hasToken,
    JSON.stringify({ before, term, filtered, after }));
});

// ── Master Inbox ─────────────────────────────────────────────────────────────
await step('the Master Inbox replaces the thread', async () => {
  // Start from a thread that is actually showing. Earlier steps can leave a tool tab open,
  // where nc_chatMsgs is already hidden -- which is how this passed on a build that stacked
  // the Inbox under the channel's messages.
  await page.evaluate(() => window.nc_switchChatSubtab('messages'));
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById('nc_chatMsgs')).display !== 'none',
    null, { timeout: 10000 });
  await page.evaluate(() => window.nc_openInbox && window.nc_openInbox());
  await page.waitForFunction(() => {
    const e = document.getElementById('nc_inboxPane');
    return e && getComputedStyle(e).display !== 'none' && e.innerHTML.trim().length > 0;
  }, null, { timeout: 20000 }).catch(() => {});
  const st = await page.evaluate(() => {
    const e = document.getElementById('nc_inboxPane');
    const r = e.getBoundingClientRect();
    const thread = document.querySelector('main.nc_thread');
    const composer = thread && thread.querySelector('.nc_composer');
    return { display: getComputedStyle(e).display, chars: e.innerHTML.trim().length,
             w: Math.round(r.width), h: Math.round(r.height),
             // it REPLACES the thread. Without this the check passed while the channel's
             // messages and the Inbox were stacked in one column with a shared composer.
             msgsHidden: getComputedStyle(document.getElementById('nc_chatMsgs')).display === 'none',
             composerHidden: !composer || getComputedStyle(composer).display === 'none' };
  });
  check('the Master Inbox replaces the thread',
    st.display !== 'none' && st.chars > 0 && st.h > 200
      && st.msgsHidden && st.composerHidden, JSON.stringify(st));
});

// The Inbox scanned the 400 newest messages and filtered afterwards, so an older mention
// did not exist as far as it was concerned -- the same sampling bug as the Needs you card,
// and the reason the two disagreed. It asks for mentions and flags by name now.
await step('the Inbox finds a mention outside its newest-messages sample', async () => {
  const r = await page.evaluate(async () => {
    const db = window.__mock.db, me = window.__mock.me;
    const mine = db.channel_members.filter(m => m.profile_id === me);
    const target = mine.find(m => {
      const ch = db.channels.find(c => c.id === m.channel_id);
      return ch && ch.kind === 'team_channel';
    }) || mine[0];
    // 60 days old: well outside the 400 newest messages once the noise below lands, but
    // inside the Inbox's deliberate 90-day window. The first version used 200 days, which
    // then failed for the right reason once that window was introduced -- the check was
    // proving "not limited to the newest 400", not "unbounded".
    db.messages.push({ id: 'm-old-mention', channel_id: target.channel_id, author_id: 'u-6',
      body: 'ages ago @nishchay flagged this', created_at: new Date(Date.now() - 60 * 864e5).toISOString(),
      parent_id: null, reply_count: 0, flagged: false, pinned_at: null });
    // and 500 newer messages elsewhere, so it is nowhere near the recent window
    const noisy = mine[1].channel_id;
    for (let i = 0; i < 500; i++) db.messages.push({ id: 'm-inbox-noise-' + i, channel_id: noisy,
      author_id: 'u-4', body: 'noise ' + i, created_at: new Date(Date.now() - i * 6e4).toISOString(),
      parent_id: null, reply_count: 0, flagged: false, pinned_at: null });

    window.nc_openInbox();
    await new Promise(res => setTimeout(res, 2500));
    const pane = document.getElementById('nc_inboxPane');
    return { found: /ages ago/.test(pane.innerText), chars: pane.innerHTML.length };
  });
  check('the Inbox finds a mention outside its newest-messages sample', r.found, JSON.stringify(r));
});

// ── back to messages, and send something (an optimistic write) ───────────────
await step('the composer sends a message', async () => {
  await page.evaluate(() => window.nc_switchChatSubtab('messages'));
  const wrote = await page.evaluate(async () => {
    const inp = document.getElementById('nc_chatInput');
    if (!inp) return 'no input';
    const before = window.__mock.log.writes.filter(w => w.startsWith('messages.insert')).length;
    if (inp.isContentEditable) inp.textContent = 'harness check';
    else inp.value = 'harness check';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('nc_chatSend').click();
    await new Promise(r => setTimeout(r, 1500));
    const after = window.__mock.log.writes.filter(w => w.startsWith('messages.insert')).length;
    return after > before ? 'ok' : 'no insert (writes: ' + window.__mock.log.writes.join(' | ') + ')';
  });
  check('the composer sends a message', wrote === 'ok', wrote);
});

// ── an empty department tab creates its channel on click ─────────────────────
await step('an empty department tab creates its channel', async () => {
  const nativeBefore = dialogs.filter(d => d.startsWith('confirm:') || d.startsWith('alert:')).length;
  const r = await page.evaluate(async () => {
    const empty = document.querySelector('#nc_deptStrip .nc_dept-tab.nc_empty');
    if (!empty) return 'no empty dept tab';
    const before = window.__mock.db.channels.length;
    empty.click();
    await new Promise(r => setTimeout(r, 2000));
    // Clicking a tab is navigation, so it must not put a dialog in the way -- native or
    // the app's own. It creates one empty private channel and says so with a toast.
    if (document.getElementById('giantConfirmWarnOverlay')) return 'it asked first';
    return window.__mock.db.channels.length > before ? 'ok'
      : 'no channel created (writes: ' + window.__mock.log.writes.slice(-6).join(' | ') + ')';
  });
  // Native dialogs are auto-accepted by this harness, so a window.confirm here would
  // sail through unnoticed -- which is exactly how it survived. Count them instead.
  const nativeAfter = dialogs.filter(d => d.startsWith('confirm:') || d.startsWith('alert:')).length;
  check('an empty department tab creates its channel without asking',
    r === 'ok' && nativeAfter === nativeBefore,
    r + (nativeAfter > nativeBefore ? ' | raised a native dialog: ' + dialogs[dialogs.length - 1] : ''));
});

// Last on purpose: this one writes. Ticking a department that has no channel yet creates
// one, and removing a member deletes their rows — run it earlier and it moves the ground
// under the checks that follow, which is exactly what it did.
await step('a tick grants a department, and Remove clears them all', async () => {
  // Self-contained: earlier steps left the composer showing and renderMgmt() returns
  // early while its pane is hidden, so acting on whatever markup was still in the DOM
  // clicked handlers whose state had moved on.
  await page.evaluate(() => window.nc_switchChatSubtab('management'));
  await page.waitForFunction(() => {
    const p = document.getElementById('nc_mgmtPane');
    return p && getComputedStyle(p).display !== 'none';
  }, null, { timeout: 20000 });
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('[data-c3-mgmt-tab]')].find(x => x.dataset.c3MgmtTab === 'members');
    if (t) t.click();
  });
  // Wait for the matrix to actually agree with the database rather than for markup to
  // exist: creating a department earlier invalidated it, and acting on the pre-reload
  // render meant clicking a cell whose tick state was one channel out of date.
  await page.waitForFunction(() => {
    const pane = document.getElementById('nc_mgmtPane');
    const cells = [...pane.querySelectorAll('[data-c3-matrix-cell]')];
    if (!cells.length) return false;
    const cid = (window.__mock.db.channels.find(c => c.id === window.nc_activeChannelId) || {}).client_id;
    const byDept = {};
    window.__mock.db.channels.filter(c => c.kind === 'client_dept' && c.client_id === cid)
      .forEach(c => { byDept[c.department] = c.id; });
    return cells.every(el => {
      const [pid, dept] = el.dataset.c3MatrixCell.split('::');
      const chId = byDept[dept];
      const on = !!chId && window.__mock.db.channel_members
        .some(m => m.channel_id === chId && m.profile_id === pid);
      return el.title.startsWith(on ? 'Can open' : 'Hidden');
    });
  }, null, { timeout: 20000 });
  const r = await page.evaluate(async () => {
    const pane = document.getElementById('nc_mgmtPane');
    const cid = (window.__mock.db.channels.find(c => c.id === window.nc_activeChannelId) || {}).client_id;
    const chans = () => window.__mock.db.channels
      .filter(c => c.kind === 'client_dept' && c.client_id === cid).map(c => c.id);
    const rowsFor = (pid) => window.__mock.db.channel_members
      .filter(x => chans().includes(x.channel_id) && x.profile_id === pid).length;
    // Deliberately not a staff member: their ticks are granted by role, carry no action
    // and cannot be removed, so picking the first row now picks a person this check
    // cannot act on at all.
    const plain = new Set(window.__mock.db.profiles
      .filter(p => !['owner', 'manager', 'inhouse_dev'].includes(p.role)).map(p => p.id));
    const row = [...pane.querySelectorAll('[data-c3-member-remove]')]
      .find(el => plain.has(el.dataset.c3MemberRemove));
    if (!row) return { skipped: 'no non-staff member to act on' };
    const pid = row.dataset.c3MemberRemove;
    const before = rowsFor(pid);

    // an unticked cell for this member: ticking it must write one membership row
    const off = [...pane.querySelectorAll('[data-c3-matrix-cell]')]
      .find(el => el.dataset.c3MatrixCell.startsWith(pid + '::') && el.title.startsWith('Hidden'));
    if (!off) return { skipped: 'no unticked cell' };
    off.click();
    await new Promise(res => setTimeout(res, 1200));
    const afterTick = rowsFor(pid);

    // The four area columns write to a different table, so they need their own proof.
    const areasFor = (p) => window.__mock.db.client_member_areas
      .filter(a => a.client_id === cid && a.profile_id === p).length;
    const areaBefore = areasFor(pid);
    const areaOff = [...pane.querySelectorAll('[data-c3-area-cell]')]
      .find(el => el.dataset.c3AreaCell.startsWith(pid + '::') && el.title.startsWith('Hidden'));
    let areaAfter = areaBefore, gated = null, areaKey = null;
    if (areaOff) {
      areaKey = areaOff.dataset.c3AreaCell.split('::')[1];
      areaOff.click();
      await new Promise(res => setTimeout(res, 1200));
      areaAfter = areasFor(pid);
      // the grant is what the gate reads, so check the gate and not just the row
      gated = window.nc_canArea(areaKey, pid);
    }

    document.querySelector(`[data-c3-member-remove="${pid}"]`).click();
    await new Promise(res => setTimeout(res, 1500));
    return { before, afterTick, areaBefore, areaAfter, areaKey, gated,
             areaAfterRemove: areasFor(pid), afterRemove: rowsFor(pid),
             stillListed: !!document.querySelector(`[data-c3-member-remove="${pid}"]`),
             // kept as failure context: which cell was clicked, and what the mock saw
             dept: off.dataset.c3MatrixCell, writes: window.__mock.log.writes.slice(-8) };
  });
  check('a tick grants a department, and Remove clears them all',
    !r.skipped && r.afterTick === r.before + 1 && r.afterRemove === 0 && r.stillListed === false
      && r.areaAfter === r.areaBefore + 1 && r.gated === true && r.areaAfterRemove === 0,
    JSON.stringify(r));
});

// "Needs you" used to answer "is anything unread" by pulling the 600 newest messages
// across every channel and working it out in the browser. That loses things: one chatty
// channel drags the cutoff forward, and an older unread message in a quiet channel never
// appears -- on the one list whose job is to not lose things. It reads unread_counts now,
// which the database computes per channel with no window and no cap.
await step('Needs you finds an old unread message behind a busy channel', async () => {
  const r = await page.evaluate(async () => {
    const db = window.__mock.db, me = window.__mock.me;
    const mine = db.channel_members.filter(m => m.profile_id === me);
    // a quiet channel, read three weeks ago, with one message since
    const quiet = mine.find(m => {
      const ch = db.channels.find(c => c.id === m.channel_id);
      return ch && ch.is_dm && !db.messages.some(x => x.channel_id === m.channel_id);
    }) || mine[mine.length - 1];
    quiet.last_read_at = new Date(Date.now() - 21 * 864e5).toISOString();
    db.messages.push({ id: 'm-quiet-probe', channel_id: quiet.channel_id, author_id: 'u-9',
      body: 'Can you look at this?', created_at: new Date(Date.now() - 12 * 864e5).toISOString(),
      parent_id: null, reply_count: 0, flagged: false, pinned_at: null });
    // and a fortnight of noise elsewhere, which is what drags the old cutoff forward
    const busy = mine[0].channel_id;
    for (let i = 0; i < 900; i++) db.messages.push({ id: 'm-noise-' + i, channel_id: busy,
      author_id: 'u-3', body: 'chatter ' + i,
      created_at: new Date(Date.now() - i * 6e5).toISOString(),
      parent_id: null, reply_count: 0, flagged: false, pinned_at: null });

    await window.nc_computeNeedsYou();
    await new Promise(res => setTimeout(res, 600));
    const rows = [...document.querySelectorAll('#nc_cardNeedsBody .nc_ch-item')];
    return { quiet: quiet.channel_id,
             listed: rows.some(el => el.dataset.ncChannelId === quiet.channel_id
                                  || el.dataset.ncDmChannelId === quiet.channel_id),
             rows: rows.length };
  });
  check('Needs you finds an old unread message behind a busy channel',
    r.listed && r.rows > 0, JSON.stringify(r));

  // The card opens the Master Inbox, so it has to agree with it. The Inbox keeps a
  // mention until you clear it; the card used to drop it the moment you opened the
  // channel, which is how "Nothing needs you" ended up above a pane reading "All 37".
  const mention = await page.evaluate(async () => {
    const db = window.__mock.db, me = window.__mock.me;
    // A channel where the probe message will be the ONLY reason it needs you: nothing
    // flagged, no other mention. Picking any member row made the clear look broken --
    // the channel still qualified on a flagged message the fixture had put there.
    const mine = db.channel_members.filter(m => m.profile_id === me);
    const clean = mine.find(m => !db.messages.some(x => x.channel_id === m.channel_id
      && (x.flagged || /@nishchay/i.test(x.body || ''))));
    const target = clean || mine[3];
    // read to the second: nothing in here is unread any more either
    target.last_read_at = new Date().toISOString();
    const msg = { id: 'm-mention-probe', channel_id: target.channel_id, author_id: 'u-5',
      body: 'hey @nishchay can you take this', created_at: new Date(Date.now() - 6e5).toISOString(),
      parent_id: null, reply_count: 0, flagged: false, pinned_at: null };
    db.messages.push(msg);
    await window.nc_computeNeedsYou();
    await new Promise(res => setTimeout(res, 500));
    const on = (id) => [...document.querySelectorAll('#nc_cardNeedsBody .nc_ch-item')]
      .some(el => el.dataset.ncChannelId === id || el.dataset.ncDmChannelId === id);
    const readButListed = on(target.channel_id);

    // and it drops out once the Inbox marks it done
    db.inbox_actions.push({ id: 'ia-probe', profile_id: me, message_id: msg.id, task_id: null,
      done: true, saved: false, created_at: new Date().toISOString() });
    await window.nc_computeNeedsYou();
    await new Promise(res => setTimeout(res, 500));
    return { readButListed, clearedAndGone: !on(target.channel_id), usedCleanChannel: !!clean };
  });
  check('a read mention still needs you, and a cleared one does not',
    mention.readButListed && mention.clearedAndGone, JSON.stringify(mention));

  // Working through the queue: opening a row takes it off the list and keeps it off,
  // including across a recompute -- a mention does not clear itself the way unread does.
  const worked = await page.evaluate(async () => {
    const db = window.__mock.db, me = window.__mock.me;
    const mine = db.channel_members.filter(m => m.profile_id === me);
    const target = mine.find(m => {
      const ch = db.channels.find(c => c.id === m.channel_id);
      return ch && ch.kind === 'team_channel';
    }) || mine[0];
    target.last_read_at = new Date().toISOString();
    db.messages.push({ id: 'm-queue-probe', channel_id: target.channel_id, author_id: 'u-5',
      body: 'please review @nishchay', created_at: new Date(Date.now() - 3e5).toISOString(),
      parent_id: null, reply_count: 0, flagged: false, pinned_at: null });
    await window.nc_computeNeedsYou();
    await new Promise(r => setTimeout(r, 500));
    const on = () => [...document.querySelectorAll('#nc_cardNeedsBody .nc_ch-item')]
      .some(el => el.dataset.ncChannelId === target.channel_id
                || el.dataset.ncDmChannelId === target.channel_id);
    const before = on();

    // open it the way a person would: click the row in the card
    const row = [...document.querySelectorAll('#nc_cardNeedsBody .nc_ch-item')]
      .find(el => el.dataset.ncChannelId === target.channel_id
                || el.dataset.ncDmChannelId === target.channel_id);
    if (row) row.click();
    await new Promise(r => setTimeout(r, 2000));
    const afterClick = on();

    // and it must not come back when the card recomputes
    await window.nc_computeNeedsYou();
    await new Promise(r => setTimeout(r, 700));
    return { before, afterClick, afterRecompute: on(),
             markedDone: db.inbox_actions.some(a => a.message_id === 'm-queue-probe' && a.done) };
  });
  check('opening a row clears it, and it stays cleared',
    worked.before && !worked.afterClick && !worked.afterRecompute && worked.markedDone,
    JSON.stringify(worked));

  // A message that arrives AFTER load must enter the card. computeNeedsYou runs once at
  // boot, so before this the list described the moment you opened the page: a message in
  // ReachGiant Home or a DM lit its unread badge and the card one row above it did not move.
  const live = await page.evaluate(async () => {
    const db = window.__mock.db, me = window.__mock.me;
    const mine = db.channel_members.filter(m => m.profile_id === me);
    const target = mine.find(m => {
      const ch = db.channels.find(c => c.id === m.channel_id);
      return ch && ch.kind === 'team_channel' && ch.id !== window.nc_activeChannelId;
    });
    if (!target) return { skipped: true };
    const on = () => [...document.querySelectorAll('#nc_cardNeedsBody .nc_ch-item')]
      .some(el => (el.dataset.ncChannelId || el.dataset.ncDmChannelId) === target.channel_id);
    // clear it first, the way reading the channel would
    target.last_read_at = new Date().toISOString();
    db.messages = db.messages.filter(x => !(x.channel_id === target.channel_id
      && /@nishchay/i.test(x.body || '')) && !(x.channel_id === target.channel_id && x.flagged));
    await window.nc_computeNeedsYou();
    await new Promise(r => setTimeout(r, 700));
    const before = on();
    // now someone posts, exactly as the realtime handler would deliver it
    window.nc_noteNeed({ id: 'm-live-probe', channel_id: target.channel_id, author_id: 'u-5',
      body: 'anyone around?', flagged: false, created_at: new Date().toISOString() });
    await new Promise(r => setTimeout(r, 500));
    return { before, after: on() };
  });
  check('a message that arrives after load enters Needs you',
    !live.skipped && live.before === false && live.after === true, JSON.stringify(live));

  // The header toggles the card and nothing else -- expanding it used to also throw the
  // Inbox over the thread you were reading. The Inbox has its own button now.
  const opened = await page.evaluate(async () => {
    const card = [...document.querySelectorAll('.nc_navcard')].find(c => c.dataset.nccard === 'needs');
    const pane = document.getElementById('nc_inboxPane');
    pane.style.display = 'none';
    const bodyH = () => card.querySelector('.nc_navcard-body').getBoundingClientRect().height;
    const wasOpen = bodyH() > 4;
    card.querySelector('.nc_navcard-head').click();
    await new Promise(res => setTimeout(res, 900));
    const toggled = (bodyH() > 4) !== wasOpen;
    const inboxStayedShut = getComputedStyle(pane).display === 'none';

    card.querySelector('.nc_open-inbox-btn').click();
    await new Promise(res => setTimeout(res, 1500));
    return { toggled, inboxStayedShut,
             opensOnButton: getComputedStyle(pane).display !== 'none',
             chars: pane.innerHTML.trim().length };
  });
  check('the Needs you header toggles, and its button opens the Inbox',
    opened.toggled && opened.inboxStayedShut && opened.opensOnButton && opened.chars > 0,
    JSON.stringify(opened));
});

// The four area columns need a table that ships in migration 20260824120000. Between
// writing that migration and applying it PostgREST answers PGRST205, so the screen has to
// degrade rather than error -- it shipped as a red toast on every open plus four columns
// whose ticks could not persist. Last, and on a fresh client: loadClientMemberMatrix is
// guarded by mgmtMatrixFor and will not reload for a client it has already seen, so the
// only honest way to reach this state is the way a person would.
await step('a table that is not deployed yet degrades instead of erroring', async () => {
  await page.evaluate(() => {
    window.__mock.hideTable('client_member_areas');
    const card = [...document.querySelectorAll('.nc_navcard')].find(c => c.dataset.nccard === 'clients');
    if (card && !card.querySelector('.nc_navcard-body').getBoundingClientRect().height)
      card.querySelector('.nc_navcard-head').click();
  });
  await page.waitForTimeout(400);
  // a different client, so the matrix loads fresh against the missing table
  // The LAST client with a thread, not "a different one from the active channel": earlier
  // steps take the first, and one of them can leave the app on a team channel, where
  // there is no current client to differ from -- so "different" picked the already-loaded
  // one and its matrix never reloaded against the hidden table.
  const switched = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#nc_cardClientsBody .nc_ch-item')]
      .filter(r => parseFloat(r.style.opacity || '1') === 1 && r.dataset.ncChannelId);
    const last = rows[rows.length - 1];
    if (!last) return false;
    last.click();
    return true;
  });
  if (!switched) { check('a table that is not deployed yet degrades instead of erroring', false, 'no second client to switch to'); return; }
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.nc_switchChatSubtab('management'));
  await page.waitForFunction(() => {
    const p = document.getElementById('nc_mgmtPane');
    return p && getComputedStyle(p).display !== 'none' && p.innerHTML.length > 4000;
  }, null, { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('[data-c3-mgmt-tab]')].find(x => x.dataset.c3MgmtTab === 'members');
    if (t) t.click();
  });
  await page.waitForFunction(
    () => document.querySelectorAll('#nc_mgmtPane [data-nc-member]').length > 0,
    null, { timeout: 20000 }).catch(() => {});
  const r = await page.evaluate(() => {
    const pane = document.getElementById('nc_mgmtPane');
    const rows = pane.querySelectorAll('[data-nc-member]').length;
    const out = { rows,
      areaCells: pane.querySelectorAll('[data-c3-area-cell]').length,
      ticksPerRow: rows ? pane.querySelectorAll('[data-nc-tick]').length / rows : 0,
      explains: /not deployed yet/i.test(pane.innerText) };
    window.__mock.showTable('client_member_areas');
    return out;
  });
  check('a table that is not deployed yet degrades instead of erroring',
    r.rows > 0 && r.areaCells === 0 && r.ticksPerRow === 5 && r.explains,
    JSON.stringify(r));
});

// ── what the mock actually served, as evidence the paths ran ─────────────────
const evidence = await page.evaluate(() => ({
  tally: window.__mock.tally(), writes: window.__mock.log.writes,
  realtime: window.__mock.log.realtime, rpc: window.__mock.log.rpc,
  unsupported: window.__mock.log.unsupported, storage: window.__mock.log.storage.length
}));

const shot = path.join(process.env.TMPDIR || '/tmp', 'newchat-clickthrough.png');
await page.screenshot({ path: shot, fullPage: false });
clearInterval(confirmWatcher);
await browser.close();
server.close();

// ── report ───────────────────────────────────────────────────────────────────
const fails = results.filter(r => !r.pass);
console.log('\n=== CLICK-THROUGH ===');
results.forEach(r => console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   [' + r.detail + ']' : '')));
console.log('\nconsole errors (' + consoleErrors.length + '):');
[...new Set(consoleErrors)].slice(0, 25).forEach(e => console.log('  ! ' + e));
console.log('uncaught page errors (' + pageErrors.length + '):');
[...new Set(pageErrors)].slice(0, 25).forEach(e => console.log('  !! ' + e));
console.log('\nrequests to the real project that were blocked: ' + blocked.length);
console.log('failed requests: ' + JSON.stringify([...new Set(failedReqs.map(f => f.split('?')[0]))].slice(0, 10)));
console.log('dialogs accepted: ' + JSON.stringify(dialogs));
console.log('tables queried: ' + JSON.stringify(evidence.tally));
console.log('writes: ' + JSON.stringify(evidence.writes));
console.log('realtime topics: ' + JSON.stringify(evidence.realtime));
console.log('rpc: ' + JSON.stringify(evidence.rpc));
console.log('mock gaps: ' + JSON.stringify(evidence.unsupported));
console.log('screenshot: ' + shot);
console.log('\n' + results.filter(r => r.pass).length + '/' + results.length + ' checks passed');
process.exit(fails.length ? 1 : 0);
