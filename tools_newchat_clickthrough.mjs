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

// Playwright dismisses dialogs by default, so every confirm() reads as "no" and the
// guarded path never runs -- which looked like a broken control rather than a
// cancelled one. Accept them, and record what was asked.
const dialogs = [];
page.on('dialog', d => { dialogs.push(d.type() + ': ' + d.message().slice(0, 120)); d.accept().catch(() => {}); });

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
    () => document.querySelectorAll('#nc_chatChannelList .nc_ch-item[data-channel-id]').length > 0,
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

// the _boot-run-twice bug showed up as two reply badges under one message
await step('no message carries a duplicated reply badge', async () => {
  const dupes = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#nc_chatMsgsList [data-message-id]')];
    let worst = 0;
    rows.forEach(r => {
      const n = r.querySelectorAll('[class*="reply"], [data-nc-open-thread], [data-c3-thread]').length;
      if (n > worst) worst = n;
    });
    return worst;
  });
  check('no message carries a duplicated reply badge', dupes <= 1, 'max reply controls on one message=' + dupes);
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

// ── Master Inbox ─────────────────────────────────────────────────────────────
await step('the Master Inbox opens into its own pane', async () => {
  await page.evaluate(() => window.nc_openInbox && window.nc_openInbox());
  await page.waitForFunction(() => {
    const e = document.getElementById('nc_inboxPane');
    return e && getComputedStyle(e).display !== 'none' && e.innerHTML.trim().length > 0;
  }, null, { timeout: 20000 }).catch(() => {});
  const st = await page.evaluate(() => {
    const e = document.getElementById('nc_inboxPane');
    const r = e.getBoundingClientRect();
    return { display: getComputedStyle(e).display, chars: e.innerHTML.trim().length,
             w: Math.round(r.width), h: Math.round(r.height) };
  });
  check('the Master Inbox opens into its own pane',
    st.display !== 'none' && st.chars > 0 && st.h > 200, JSON.stringify(st));
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
  const r = await page.evaluate(async () => {
    const empty = document.querySelector('#nc_deptStrip .nc_dept-tab.nc_empty');
    if (!empty) return 'no empty dept tab';
    const before = window.__mock.db.channels.length;
    empty.click();
    await new Promise(r => setTimeout(r, 2000));
    return window.__mock.db.channels.length > before ? 'ok'
      : 'no channel created (writes: ' + window.__mock.log.writes.slice(-6).join(' | ') + ')';
  });
  check('an empty department tab creates its channel', r === 'ok', r);
});

// ── what the mock actually served, as evidence the paths ran ─────────────────
const evidence = await page.evaluate(() => ({
  tally: window.__mock.tally(), writes: window.__mock.log.writes,
  realtime: window.__mock.log.realtime, rpc: window.__mock.log.rpc,
  unsupported: window.__mock.log.unsupported, storage: window.__mock.log.storage.length
}));

const shot = path.join(process.env.TMPDIR || '/tmp', 'newchat-clickthrough.png');
await page.screenshot({ path: shot, fullPage: false });
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
console.log('dialogs accepted: ' + JSON.stringify(dialogs));
console.log('tables queried: ' + JSON.stringify(evidence.tally));
console.log('writes: ' + JSON.stringify(evidence.writes));
console.log('realtime topics: ' + JSON.stringify(evidence.realtime));
console.log('rpc: ' + JSON.stringify(evidence.rpc));
console.log('mock gaps: ' + JSON.stringify(evidence.unsupported));
console.log('screenshot: ' + shot);
console.log('\n' + results.filter(r => r.pass).length + '/' + results.length + ' checks passed');
process.exit(fails.length ? 1 : 0);
