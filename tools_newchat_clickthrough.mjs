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
check('supabase-js was replaced by the mock', await page.evaluate(() => !!(window.supabase && window.supabase.__isMock)));

// Favourites: a star on every nav item and a group above Communication. It stores a
// data-screen value, so Chat, Projects, SOPs and White Label are the same kind of thing
// to it -- the point of the feature is that it crosses modules.
await step('starring nav items fills the Favourites group', async () => {
  await page.waitForFunction(
    () => document.querySelectorAll('#appSidebar .nav-item[data-screen] .nav-fav-star').length > 5,
    null, { timeout: 20000 });
  const r = await page.evaluate(async () => {
    const label = document.getElementById('navFavGroupLabel');
    const body = document.getElementById('navFavBody');
    const hiddenWhenEmpty = getComputedStyle(label).display === 'none';
    // three screens from three different modules
    const want = ['newchat', 'tasks', 'sops'];
    for (const s of want) {
      const item = [...document.querySelectorAll('#appSidebar .nav-item[data-screen]')]
        .find(el => el.dataset.screen === s && !body.contains(el));
      if (item) item.querySelector('.nav-fav-star').click();
      await new Promise(r => setTimeout(r, 400));
    }
    await new Promise(r => setTimeout(r, 800));
    // Expand it to read the rows. Starring deliberately does NOT open the group: these are
    // an accordion, so opening Favourites would fold away whichever group you were using.
    if (label.classList.contains('nav-group-collapsed')) label.click();
    await new Promise(r => setTimeout(r, 500));
    const rows = [...body.querySelectorAll('[data-fav-screen]')].map(el => el.dataset.favScreen);
    const stored = window.__mock.db.nav_favorites.map(f => f.screen).sort();
    // the group sits above Communication
    const commLabel = document.querySelector('[data-navgroup="communication"]');
    const order = label.compareDocumentPosition(commLabel) & Node.DOCUMENT_POSITION_FOLLOWING;
    // no favourite may carry data-screen: a second element with the same value would
    // capture every .nav-item[data-screen=…] lookup in the app, this group being first.
    const noDuplicateScreens = ['newchat', 'tasks', 'sops'].every(s =>
      document.querySelectorAll('#appSidebar .nav-item[data-screen="' + s + '"]').length === 1);
    return { hiddenWhenEmpty, rows, stored, visible: getComputedStyle(label).display !== 'none',
             aboveCommunication: !!order, noDuplicateScreens,
             // the first star opens the group, or the heading appears over nothing
             expanded: !label.classList.contains('nav-group-collapsed'),
             rowsVisible: [...body.querySelectorAll('[data-fav-screen]')]
               .filter(el => el.getBoundingClientRect().height > 2).length };
  });
  check('starring nav items fills the Favourites group',
    r.hiddenWhenEmpty && r.visible && r.aboveCommunication && r.noDuplicateScreens
      && r.rows.join(',') === 'newchat,tasks,sops'
      && r.stored.join(',') === 'newchat,sops,tasks'
      && r.expanded && r.rowsVisible === 3,
    JSON.stringify(r));
});

await step('a favourite opens the screen, and unstarring removes it', async () => {
  const r = await page.evaluate(async () => {
    const body = document.getElementById('navFavBody');
    const row = [...body.querySelectorAll('[data-fav-screen]')].find(el => el.dataset.favScreen === 'newchat');
    row.click();
    await new Promise(r => setTimeout(r, 1200));
    const opened = !!document.querySelector('.screen[data-screen="newchat"].on');
    // unstar from inside the group
    [...body.querySelectorAll('[data-fav-screen]')].find(el => el.dataset.favScreen === 'sops')
      .querySelector('.nav-fav-star').click();
    await new Promise(r => setTimeout(r, 900));
    const out = { opened,
                  rows: [...body.querySelectorAll('[data-fav-screen]')].map(el => el.dataset.favScreen),
                  stored: window.__mock.db.nav_favorites.map(f => f.screen).sort() };
    // Put Communication back. The nav groups are an accordion, so expanding Favourites in
    // the previous step folded it away -- and every later check reaches New Chat through it.
    const comm = document.querySelector('.nav-group-toggle[data-navgroup="communication"]');
    if (comm && comm.classList.contains('nav-group-collapsed')) comm.click();
    await new Promise(r => setTimeout(r, 500));
    return out;
  });
  check('a favourite opens the screen, and unstarring removes it',
    r.opened && r.rows.join(',') === 'newchat,tasks' && r.stored.join(',') === 'newchat,tasks',
    JSON.stringify(r));
});

// Chat 2.0 and Chat 3.0 are the two builds New Chat came from. They are out of
// Communication and into Archive -- moved, not deleted, so both still open.
await step('Chat 2.0 and 3.0 are archived, not removed', async () => {
  const r = await page.evaluate(async () => {
    const inGroup = (screen, group) => {
      const rail = document.querySelector(`[data-navgroup-body="${group}"]`);
      return !!(rail && rail.querySelector(`.nav-item[data-screen="${screen}"]`));
    };
    const label = document.querySelector('.nav-group-toggle[data-navgroup="archive"]');
    if (label && label.classList.contains('nav-group-collapsed')) label.click();
    await new Promise(r => setTimeout(r, 500));
    const item = document.querySelector('[data-navgroup-body="archive"] .nav-item[data-screen="chat3"]');
    if (item) item.click();
    await new Promise(r => setTimeout(r, 1200));
    const opened = !!document.querySelector('.screen[data-screen="chat3"].on');
    // put Communication back: the accordion closed it, and later checks reach New Chat there
    const comm = document.querySelector('.nav-group-toggle[data-navgroup="communication"]');
    if (comm && comm.classList.contains('nav-group-collapsed')) comm.click();
    await new Promise(r => setTimeout(r, 500));
    return {
      inArchive: ['chat2', 'chat3'].filter(s => inGroup(s, 'archive')),
      stillInComms: ['chat2', 'chat3'].filter(s => inGroup(s, 'communication')),
      // Old chat joined them in Archive when New Chat took the name. It is NOT gated
      // there -- it is still the surface for clients -- while Chat 2.0 and 3.0 stay
      // manager-only inside the same group.
      chatArchived: inGroup('chat', 'archive'),
      chatGoneFromComms: !inGroup('chat', 'communication'),
      newChatStays: inGroup('newchat', 'communication'),
      // moved, not deleted: the screens are untouched and the item still navigates
      screensExist: ['chat2', 'chat3'].every(s => !!document.querySelector(`.screen[data-screen="${s}"]`)),
      opened,
      // Chat 2.0 sits behind a private-review ALLOWLIST of four profile ids (initApp
      // hides it outright for anyone else), and this fixture's user is not one of them.
      // So placement is what can be asserted for it; visibility is asserted on Chat 3.0.
      chat3Visible: getComputedStyle(
        document.querySelector('[data-navgroup-body="archive"] .nav-item[data-screen="chat3"]')).display !== 'none',
    };
  });
  check('Chat 2.0 and 3.0 are archived, not removed',
    r.inArchive.length === 2 && r.stillInComms.length === 0
      && r.chatArchived && r.chatGoneFromComms && r.newChatStays
      && r.screensExist && r.opened && r.chat3Visible,
    JSON.stringify(r));
});

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
      .filter(r => parseFloat(r.style.opacity || '1') < 1).length,
    // Every client on the books, plus a row per conversation. A client with channels
    // contributes one row each; a client with none contributes one dimmed row.
    deadOneToOnes: (() => {
      const db = window.__mock.db, me = window.__mock.me;
      const dead = new Set(db.profiles.filter(p => p.deactivated_at).map(p => p.id));
      return db.channels.filter(c => c.is_dm && c.dm_pair)
        .filter(c => db.channel_members.filter(m => m.channel_id === c.id && m.profile_id !== me).length === 1)
        .filter(c => c.dm_pair.split(':').some(id => dead.has(id))).length;
    })(),
    expectedDimmed: (() => {
      const db = window.__mock.db;
      return db.clients.filter(c => c.status !== 'churned')
        .filter(cl => !db.channels.some(c => c.kind === 'client_dept' && c.client_id === cl.id)).length;
    })(),
    // One row per client that HAS a conversation. Their departments are threads inside
    // it, reached from the strip, not rows of their own.
    clientsWithConversation: (() => {
      const db = window.__mock.db;
      const withChan = new Set(db.channels.filter(c => c.kind === 'client_dept' && c.client_id)
        .map(c => c.client_id));
      return db.clients.filter(c => c.status !== 'churned' && withChan.has(c.id)).length;
    })(),
    groups: document.querySelectorAll('#nc_cardGroupsBody .nc_ch-item').length,
    // truth from the data: a DM with more than one other member, or is_group set
    expectedGroups: (() => {
      const me = window.__mock.me, db = window.__mock.db;
      return db.channels.filter(c => c.is_dm).filter(c => c.is_group
        || db.channel_members.filter(m => m.channel_id === c.id && m.profile_id !== me).length > 1).length;
    })(),
    groupsInDirect: [...document.querySelectorAll('#nc_cardDirectBody .nc_ch-item')]
      .filter(el => el.dataset.ncDmGroup === '1').length
  };
});
check('sidebar renders its six nav cards', sidebar.cards === 6, 'cards=' + sidebar.cards);
check('sidebar behaves as an accordion (one card open)', sidebar.openCards === 1,
  'open=' + sidebar.openCards + ' heights=' + sidebar.heights.join(','));
// ONE row per client that HAS a conversation. Departments -- General, Google Ads, Meta
// Ads, SEO, Web -- are threads inside it, on the strip at the top, which is the shape the
// screen was designed around; a row each read as five separate clients.
//
// A client with NO conversation is not listed at all. That has moved more than once: it
// was listed, dimmed, on the reasoning that the card is a client list. It is not -- it is
// the list of conversations you have, and a dimmed row with nothing behind it made a
// deleted conversation look like it had come back. Clients without one are reached by
// name in the jump box, which is asserted further down.
check('one row per client that has a conversation',
  sidebar.clients > 0 && sidebar.clients === sidebar.clientsWithConversation,
  'listed=' + sidebar.clients + ' withConversation=' + sidebar.clientsWithConversation);
check('a client with no conversation is not listed',
  sidebar.dimmedClients === 0,
  'dimmed=' + sidebar.dimmedClients);
check('11 team channels + home are listed', sidebar.teams === 12, 'teams=' + sidebar.teams);
// Group conversations belong under GROUP DMS, one-to-ones under DIRECT. The card used to
// route on channels.is_group alone while the list treated "more than one other person" as a
// group either way, so every multi-person DM with is_group unset sat among the one-to-ones.
// ...minus the one-to-ones with someone who has left, which are hidden: they cannot be
// read or replied to, and the person is hidden everywhere else.
check('every live DM is listed, split by whether it is a group',
  sidebar.direct + sidebar.groups === 80 - sidebar.deadOneToOnes,
  'direct=' + sidebar.direct + ' groups=' + sidebar.groups);
check('multi-person DMs are under Group DMs, not Direct',
  sidebar.groups === sidebar.expectedGroups && sidebar.groupsInDirect === 0,
  'groups=' + sidebar.groups + ' expected=' + sidebar.expectedGroups
    + ' multi-person rows still in Direct=' + sidebar.groupsInDirect);

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
    const rows = [...document.querySelectorAll('#nc_chatMsgsList .nc_msg[data-msg-id], #nc_chatMsgsList [data-message-id]')];
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
await step('Library is not a Management tab any more', async () => {
  const r = await page.evaluate(async () => {
    const tabs = [...document.querySelectorAll('#nc_mgmtPane [data-c3-mgmt-tab]')]
      .map(e => e.dataset.c3MgmtTab);
    return { tabs, hasLibrary: tabs.includes('library') };
  });
  // It moved to the Vault tab, where the design puts it. Two ways into one panel is how
  // "what does Vault mean here" became a question in the first place.
  check('Library is not a Management tab any more',
    r.tabs.length > 0 && !r.hasLibrary, JSON.stringify(r));
});

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

// The row menu: on every channel, group DM and DM, with the items gated the way
// channels_delete_owner_mgr is on the server -- creator or owner/manager/inhouse_dev may
// delete, invite and rename; anyone may mute and leave.
// The trigger has to be VISIBLE without hovering. It shipped at opacity 0 until hover,
// which meant nothing on the row said a menu was there, so there was no reason to hover
// looking for one -- the feature was complete and undiscoverable.
await step('the row menu trigger is visible without hovering', async () => {
  const r = await page.evaluate(async () => {
    // The cards are an accordion, so a row in a closed one has no layout at all and
    // measures zero wide. Open each before measuring it, or the check reports "invisible"
    // for eleven cards that are simply shut.
    const look = async (card, sel) => {
      const c = [...document.querySelectorAll('.nc_navcard')].find(x => x.dataset.nccard === card);
      if (c && c.querySelector('.nc_navcard-body').getBoundingClientRect().height < 4) {
        c.querySelector('.nc_navcard-head').click();
        await new Promise(r => setTimeout(r, 450));
      }
      const rows = [...document.querySelectorAll(sel)];
      const withDots = rows.filter(x => x.querySelector('.nc_row-menu'));
      const first = withDots[0] && withDots[0].querySelector('.nc_row-menu');
      return { rows: rows.length, withDots: withDots.length,
               opacity: first ? Number(getComputedStyle(first).opacity) : -1,
               width: first ? Math.round(first.getBoundingClientRect().width) : -1 };
    };
    const teams = await look('teams', '#nc_cardTeamsBody .nc_ch-item');
    const direct = await look('direct', '#nc_cardDirectBody .nc_ch-item');
    const groups = await look('groups', '#nc_cardGroupsBody .nc_ch-item');
    return { teams, direct, groups };
  });
  const ok = (g) => g.withDots === g.rows && g.rows > 0 && g.opacity > 0.15 && g.width >= 16;
  check('the row menu trigger is visible without hovering',
    ok(r.teams) && ok(r.direct) && ok(r.groups), JSON.stringify(r));

  // The star belongs immediately before the chip, at the end of the row -- not floating
  // in the middle of it, which is where margin-left:auto alone put it.
  const starOrder = await page.evaluate(async () => {
    const c = [...document.querySelectorAll('.nc_navcard')].find(x => x.dataset.nccard === 'teams');
    if (c && c.querySelector('.nc_navcard-body').getBoundingClientRect().height < 4) {
      c.querySelector('.nc_navcard-head').click();
      await new Promise(r => setTimeout(r, 450));
    }
    // Let the card's open transition settle. Measuring mid-animation reports a gap that
    // reflects where the row is sliding through, not where it lands.
    for (let i = 0; i < 20; i++) {
      const b = c && c.querySelector('.nc_navcard-body').getBoundingClientRect().height;
      await new Promise(r => requestAnimationFrame(r));
      if (c && Math.abs(c.querySelector('.nc_navcard-body').getBoundingClientRect().height - b) < 0.5) break;
    }
    const row = [...document.querySelectorAll('#nc_cardTeamsBody .nc_ch-item')]
      .find(el => el.querySelector('.nc_star') && el.querySelector('.nc_row-menu'));
    if (!row) return { noRow: true };
    const s = row.querySelector('.nc_star').getBoundingClientRect();
    const m = row.querySelector('.nc_row-menu').getBoundingClientRect();
    // Adjacency measured structurally rather than by a pixel threshold: nothing else in
    // the row may sit between them. A gap in pixels drifts with padding and font size;
    // "the star is the last thing before the chip" is the property actually being claimed.
    const between = [...row.children].filter(el => {
      if (el.classList.contains('nc_star') || el.classList.contains('nc_row-menu')) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1) return false;
      const mid = (r.left + r.right) / 2;
      return mid > s.right && mid < m.left;
    }).map(el => el.className);
    return { starBeforeMenu: s.right <= m.left + 1, between,
             menuIsLast: Math.round(row.getBoundingClientRect().right - m.right) < 20 };
  });
  check('the star sits at the end, just before the menu',
    !starOrder.noRow && starOrder.starBeforeMenu && starOrder.between.length === 0
      && starOrder.menuIsLast,
    JSON.stringify(starOrder));
});

await step('every sidebar row has a menu, gated by role', async () => {
  const r = await page.evaluate(async () => {
    const open = async (sel) => {
      document.querySelectorAll('.nc_channel-ctx-menu').forEach(m => m.remove());
      const row = document.querySelector(sel);
      if (!row) return null;
      const btn = row.querySelector('.nc_row-menu');
      if (!btn) return { noButton: true };
      btn.click();
      await new Promise(r => setTimeout(r, 350));
      const menu = document.querySelector('.nc_channel-ctx-menu');
      const acts = menu ? [...menu.querySelectorAll('[data-action]')].map(e => e.dataset.action) : [];
      if (menu) menu.remove();
      return acts;
    };
    const team = await open('#nc_cardTeamsBody .nc_ch-item');
    const dm = await open('#nc_cardDirectBody .nc_ch-item');
    const grp = await open('#nc_cardGroupsBody .nc_ch-item');
    return { team, dm, grp, role: window.giantCurrentProfile && window.giantCurrentProfile.role };
  });
  const has = (a, k) => Array.isArray(a) && a.includes(k);
  check('every sidebar row has a menu, gated by role',
    // owner: everything on a channel and a group, no rename/invite/leave on a one-to-one
    has(r.team, 'mute') && has(r.team, 'leave') && has(r.team, 'delete')
      && has(r.team, 'invite') && has(r.team, 'rename')
      && has(r.grp, 'leave') && has(r.grp, 'rename') && has(r.grp, 'delete')
      && has(r.dm, 'mute') && has(r.dm, 'delete')
      && !has(r.dm, 'leave') && !has(r.dm, 'rename') && !has(r.dm, 'invite'),
    JSON.stringify(r));
});

await step('a member sees only mute, mark-unread and leave', async () => {
  const r = await page.evaluate(async () => {
    const was = window.giantCurrentProfile.role;
    window.giantCurrentProfile.role = 'member';
    document.querySelectorAll('.nc_channel-ctx-menu').forEach(m => m.remove());
    const row = document.querySelector('#nc_cardTeamsBody .nc_ch-item');
    row.querySelector('.nc_row-menu').click();
    await new Promise(r => setTimeout(r, 350));
    const menu = document.querySelector('.nc_channel-ctx-menu');
    const acts = menu ? [...menu.querySelectorAll('[data-action]')].map(e => e.dataset.action) : [];
    if (menu) menu.remove();
    window.giantCurrentProfile.role = was;
    return { acts };
  });
  check('a member sees only mute, mark-unread and leave',
    r.acts.includes('mute') && r.acts.includes('leave')
      && !r.acts.includes('delete') && !r.acts.includes('rename') && !r.acts.includes('invite'),
    JSON.stringify(r));
});

await step('leaving a channel removes only my membership', async () => {
  const r = await page.evaluate(async () => {
    const db = window.__mock.db, me = window.__mock.me;
    const row = document.querySelector('#nc_cardTeamsBody .nc_ch-item');
    const id = row.dataset.ncChannelId;
    const before = db.channel_members.filter(m => m.channel_id === id).length;
    const mineBefore = db.channel_members.some(m => m.channel_id === id && m.profile_id === me);
    row.querySelector('.nc_row-menu').click();
    await new Promise(r => setTimeout(r, 350));
    const menu = document.querySelector('.nc_channel-ctx-menu');
    const leave = menu && [...menu.querySelectorAll('[data-action]')].find(e => e.dataset.action === 'leave');
    if (!leave) return { noLeave: true };
    leave.click();
    await new Promise(r => setTimeout(r, 2500));
    return { mineBefore, before, after: db.channel_members.filter(m => m.channel_id === id).length,
             stillMine: db.channel_members.some(m => m.channel_id === id && m.profile_id === me),
             channelStillExists: !!db.channels.find(c => c.id === id) };
  });
  check('leaving a channel removes only my membership',
    !r.noLeave && r.mineBefore && r.after === r.before - 1 && r.stillMine === false
      && r.channelStillExists, JSON.stringify(r));
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

  // Coming back to the screen must show what arrived while you were away. Realtime places
  // messages as they land, but a subscription dropped by a backgrounded tab reconnects with
  // no replay -- so this plants a message WITHOUT going through ncNoteNeed, which is what a
  // missed event looks like, then leaves the screen and returns.
  const returned = await page.evaluate(async () => {
    const db = window.__mock.db, me = window.__mock.me;
    const mine = db.channel_members.filter(m => m.profile_id === me);
    const target = mine.find(m => {
      const ch = db.channels.find(c => c.id === m.channel_id);
      return ch && ch.kind === 'team_channel' && ch.id !== window.nc_activeChannelId;
    });
    if (!target) return { skipped: true };
    const on = () => [...document.querySelectorAll('#nc_cardNeedsBody .nc_ch-item')]
      .some(el => (el.dataset.ncChannelId || el.dataset.ncDmChannelId) === target.channel_id);
    // clear it, and let the throttle expire so the return actually recomputes
    target.last_read_at = new Date().toISOString();
    db.messages = db.messages.filter(x => x.channel_id !== target.channel_id);
    await window.nc_refreshNeedsYou(true);
    await new Promise(r => setTimeout(r, 1200));
    const before = on();

    // a message lands with the app none the wiser -- no realtime event
    db.messages.push({ id: 'm-missed-probe', channel_id: target.channel_id, author_id: 'u-5',
      body: 'sent while you were away', created_at: new Date().toISOString(),
      parent_id: null, reply_count: 0, flagged: false, pinned_at: null });
    const stillHidden = on();

    // leave the screen and come back, the way switching tabs does
    const host = document.querySelector('.screen[data-screen="newchat"]');
    host.classList.remove('on');
    await new Promise(r => setTimeout(r, 300));
    host.classList.add('on');
    await new Promise(r => setTimeout(r, 3000));
    return { before, stillHidden, after: on() };
  });
  check('returning to the screen picks up what was missed',
    !returned.skipped && returned.before === false && returned.stillHidden === false
      && returned.after === true, JSON.stringify(returned));

  // Threads. A mention inside a thread REPLY is the case that got dropped: the realtime
  // handler returned early on "thread reply, not involved" before it ever looked at the
  // body, so it never reached the unread count or this card.
  const thread = await page.evaluate(async () => {
    const db = window.__mock.db, me = window.__mock.me;
    const mine = db.channel_members.filter(m => m.profile_id === me);
    const target = mine.find(m => {
      const ch = db.channels.find(c => c.id === m.channel_id);
      return ch && ch.kind === 'team_channel' && ch.id !== window.nc_activeChannelId;
    });
    if (!target) return { skipped: true };
    target.last_read_at = new Date().toISOString();
    db.messages = db.messages.filter(x => x.channel_id !== target.channel_id);
    const parent = { id: 'm-thread-parent', channel_id: target.channel_id, author_id: 'u-5',
      body: 'kicking off the thread', created_at: new Date(Date.now() - 9e5).toISOString(),
      parent_id: null, reply_count: 1, flagged: false, pinned_at: null };
    const reply = { id: 'm-thread-reply', channel_id: target.channel_id, author_id: 'u-6',
      body: 'inside the thread @nishchay can you look', created_at: new Date().toISOString(),
      parent_id: parent.id, reply_count: 0, flagged: false, pinned_at: null };
    db.messages.push(parent);
    await window.nc_refreshNeedsYou(true);
    await new Promise(r => setTimeout(r, 1200));
    const beforeReply = [...document.querySelectorAll('#nc_cardNeedsBody .nc_ch-item')]
      .some(el => (el.dataset.ncChannelId || el.dataset.ncDmChannelId) === target.channel_id);

    // The reply arrives as a REALTIME event, not a recompute. That is the path that
    // returned early on "thread reply, not involved" -- before it had even looked at the
    // body -- so a mention inside a thread never reached the unread count or this card.
    db.messages.push(reply);
    const delivered = window.__mock.emit('messages', 'INSERT', reply);
    await new Promise(r => setTimeout(r, 1800));
    const row = [...document.querySelectorAll('#nc_cardNeedsBody .nc_ch-item')]
      .find(el => (el.dataset.ncChannelId || el.dataset.ncDmChannelId) === target.channel_id);
    return { beforeReply, delivered, listed: !!row, kind: row && row.dataset.needKind,
             channel: target.channel_id, subs: window.__mock.subscriberCount('messages') };
  });
  check('a mention inside a thread reply reaches Needs you',
    !thread.skipped && thread.subs > 0 && thread.delivered > 0
      && thread.beforeReply === false && thread.listed && thread.kind === 'mention',
    JSON.stringify(thread));

  // And clicking it lands on the message rather than the bottom of the channel.
  const jump = await page.evaluate(async (cid) => {
    const row = [...document.querySelectorAll('#nc_cardNeedsBody .nc_ch-item')]
      .find(el => (el.dataset.ncChannelId || el.dataset.ncDmChannelId) === cid);
    if (!row) return { noRow: true };
    row.click();
    // Poll rather than sleep: the highlight clears itself after 1.8s, so a fixed wait
    // longer than that reads an empty page and reports "nothing was highlighted".
    let lit = [];
    for (let i = 0; i < 24; i++) {
      lit = [...document.querySelectorAll('.nc_msg[data-msg-id]')]
        .filter(el => (el.style.background || '').includes('208'));
      if (lit.length) break;
      await new Promise(r => setTimeout(r, 150));
    }
    return { switched: window.nc_activeChannelId === cid,
             litCount: lit.length, litIds: lit.map(el => el.dataset.msgId) };
  }, thread.channel);
  check('clicking a Needs you row jumps to the message and highlights it',
    jump.switched && jump.litCount >= 1
      && (jump.litIds.includes('m-thread-reply') || jump.litIds.includes('m-thread-parent')),
    JSON.stringify(jump));

  // Newest first. This used to sort by reason -- every mention, then every flag, then
  // every unread -- so a message that had just arrived sat below a fortnight-old mention.
  const ordered = await page.evaluate(async () => {
    await window.nc_computeNeedsYou();
    await new Promise(r => setTimeout(r, 1200));
    const db = window.__mock.db, me = window.__mock.me;
    const rows = [...document.querySelectorAll('#nc_cardNeedsBody .nc_ch-item')]
      .map(el => el.dataset.ncChannelId || el.dataset.ncDmChannelId).filter(Boolean);
    // newest message from someone else, per listed channel
    const newest = (cid) => db.messages
      .filter(m => m.channel_id === cid && m.author_id !== me)
      .reduce((a, m) => Math.max(a, new Date(m.created_at).getTime()), 0);
    const times = rows.map(newest);
    const descending = times.every((t, i) => i === 0 || times[i - 1] >= t);
    return { rows: rows.length, descending,
             first: times[0] || 0, last: times[times.length - 1] || 0 };
  });
  check('Needs you lists the newest first',
    ordered.rows > 2 && ordered.descending && ordered.first >= ordered.last,
    JSON.stringify(ordered));

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

// A mention that lands in the conversation you are READING was never marked handled --
// only opening a channel does that, and you are already in it -- so the next recompute put
// that conversation straight back on the Needs you card, and no amount of reading could
// shift it. Reported as "it keeps the chat in the list even after I read it".
await step('a mention read as it arrives does not come back on the card', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const db = window.__mock.db;
    const needs = () => Object.keys(window.__ncNeedTargets || {});
    const mineIds = new Set(db.channel_members.filter(m => m.profile_id === 'u-me').map(m => m.channel_id));
    const ch = db.channels.find(c => mineIds.has(c.id) && c.kind === 'team_channel');
    if (!ch) return { skipped: 'no channel of mine' };
    // open it first, so it starts CLEAR -- at boot it already needs me, and asserting
    // against that baseline would prove nothing at all
    await window.nc_jumpToMessage(ch.id, null, null);
    await w(2500);
    const baselineClear = !needs().includes(ch.id);
    const m = { id: 'm-read-in-place', channel_id: ch.id, author_id: 'u-4',
      body: '@nishchay while you are here', created_at: new Date().toISOString(),
      edited_at: null, parent_id: null, reply_count: 0, voice_note_url: null,
      voice_note_duration_ms: null, flagged: false, pinned_at: null, pinned_by: null };
    db.messages.push(m);
    window.__mock.emit('messages', 'INSERT', m);
    await w(1800);
    const whileReading = !needs().includes(ch.id);
    // leave, then force the recompute that fires on focus / re-entering the screen
    const other = db.channels.find(c => mineIds.has(c.id) && c.kind === 'team_channel' && c.id !== ch.id);
    if (other) { await window.nc_jumpToMessage(other.id, null, null); await w(1200); }
    await window.nc_refreshNeedsYou(true);
    await w(2500);
    return { baselineClear, whileReading, afterRecompute: !needs().includes(ch.id),
             markedDone: (db.inbox_actions || []).some(a => a.message_id === 'm-read-in-place' && a.done) };
  });
  check('a mention arriving in the channel on screen is marked handled, and stays cleared',
    !r.skipped && r.baselineClear && r.whileReading && r.afterRecompute && r.markedDone,
    JSON.stringify(r));
});

// A search hit in a long conversation. The jump paged back 20 times at 50 a page and gave
// up 1,000 messages short -- and the three busiest conversations in the real workspace are
// all deeper than that, so an older hit left you somewhere near the message with nothing
// highlighted. Seeded past the old ceiling on purpose: at 1,200 the old code loads exactly
// 1,050 messages and stops.
await step('a search hit deep in a long conversation is actually reached', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const db = window.__mock.db;
    // chosen at runtime: earlier steps create, rename and delete channels, so a
    // hardcoded id is not necessarily one that still exists or that I am still in
    const mineIds = new Set(db.channel_members.filter(m => m.profile_id === 'u-me').map(m => m.channel_id));
    const target = db.channels.find(c => mineIds.has(c.id) && c.kind === 'team_channel');
    if (!target) return { skipped: 'no channel of mine' };
    const ch = target.id, base = Date.now() - 400 * 864e5;
    for (let i = 0; i < 1300; i++) db.messages.push({
      id: 'deep-' + i, channel_id: ch, author_id: 'u-7',
      body: i === 40 ? 'pangolin ledger anomaly' : 'deep filler ' + i,
      created_at: new Date(base + i * 36e5).toISOString(), edited_at: null, parent_id: null,
      reply_count: 0, voice_note_url: null, voice_note_duration_ms: null,
      flagged: false, pinned_at: null, pinned_by: null });
    // start from Chat, on the messages sub-tab: earlier steps leave other screens up
    document.querySelector('.nav-item[data-screen="newchat"]').click();
    await w(800);
    if (typeof window.nc_switchChatSubtab === 'function') window.nc_switchChatSubtab('messages');
    await w(1200);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    await w(600);
    const inp = document.querySelector('#cmdkInput, .cmdk-input, input[placeholder*="Search"]');
    if (!inp) return { skipped: 'no search input' };
    inp.focus(); inp.value = 'pangolin';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await w(2500);
    const hit = [...document.querySelectorAll('.cmdk-item, [data-cmdk-item]')]
      .find(e => /pangolin ledger/i.test(e.innerText));
    if (!hit) return { skipped: 'no result' };
    hit.click();
    // the flash is the only thing that says "this is the one you asked for"
    for (let i = 0; i < 60; i++) {
      await w(400);
      const el = document.querySelector('.nc_msg[data-msg-id="deep-40"]');
      const st = el && el.getAttribute('style') || '';
      if (el && /outline/.test(st) && /solid/.test(st)) {
        const b = el.getBoundingClientRect();
        return { depth: 1260, flashed: true, inView: b.top > 0 && b.bottom < window.innerHeight,
                 loaded: document.querySelectorAll('.nc_msg[data-msg-id]').length };
      }
    }
    return { depth: 1260, flashed: false, screen: document.querySelector('.nav-item.on') && document.querySelector('.nav-item.on').dataset.screen,
             ch, anyDeep: document.querySelectorAll('.nc_msg[data-msg-id^="deep-"]').length,
             loaded: document.querySelectorAll('.nc_msg[data-msg-id]').length };
  });
  check('a message 1,260 back is reached, highlighted and on screen',
    !r.skipped && r.flashed && r.inView && r.loaded > 1050, JSON.stringify(r));
  await page.evaluate(() => { const e = document.getElementById('cmdkOverlay'); if (e) e.classList.remove('on'); });
});

// The Inbox used to open UNDER the conversation you were reading: its own header, its own
// sub-tabs and the department strip all stayed on screen, so a screen about everything
// waiting on you was topped by the bar for one unrelated channel. It is its own place now,
// and every piece of that chat furniture has to come back when you leave.
await step('the Inbox replaces the chat bar, and gives it back on the way out', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const vis = el => !!el && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      && el.getBoundingClientRect().height > 4;
    const thread = document.querySelector('main.nc_thread');
    const chatHead = () => thread.querySelector('.nc_thread-head:not(#nc_inboxHead)');
    // read a channel first, so there IS a chat bar to displace
    const row = document.querySelector('#nc_cardClientsBody .nc_ch-item[data-nc-channel-id]');
    if (row) { row.click(); await w(1800); }
    const hadChatBar = vis(chatHead());

    document.querySelector('.nc_open-inbox-btn').click();
    await w(2000);
    const inside = {
      pane: vis(document.getElementById('nc_inboxPane')),
      chatHeadGone: !vis(chatHead()),
      subTabsGone: !vis(document.getElementById('nc_chatSubTabs')),
      deptStripGone: !vis(document.getElementById('nc_deptStrip')),
      composerGone: !vis(thread.querySelector('.nc_composer')),
      ownHeader: vis(document.getElementById('nc_inboxHead'))
    };
    document.getElementById('nc_inboxClose').click();
    await w(1500);
    const after = {
      chatHeadBack: vis(chatHead()),
      subTabsBack: vis(document.getElementById('nc_chatSubTabs')),
      composerBack: vis(thread.querySelector('.nc_composer')),
      paneGone: !vis(document.getElementById('nc_inboxPane')),
      ownHeaderGone: !vis(document.getElementById('nc_inboxHead'))
    };
    return { hadChatBar, inside, after };
  });
  check('opening the Inbox hides the conversation header, sub-tabs, strip and composer',
    r.hadChatBar && Object.values(r.inside).every(Boolean), JSON.stringify(r.inside));
  check('leaving the Inbox restores the conversation it covered',
    Object.values(r.after).every(Boolean), JSON.stringify(r.after));
});

// Each chip has to list exactly what it counts, and only items of that kind. Both halves
// matter: a count and a list can agree while both are wrong, and a tab that filters on the
// wrong axis still returns a plausible number.
await step('every Inbox tab lists what its badge claims', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    // Earlier steps clear the Inbox as they go, so by now every mention seeded at load is
    // marked done. Without fresh ones the Mentions tab reads zero and "holds one kind of
    // item" would pass by checking nothing.
    const db = window.__mock.db;
    const mine = db.channel_members.filter(m => m.profile_id === 'u-me'
      && (db.channels.find(c => c.id === m.channel_id) || {}).kind === 'team_channel');
    for (let i = 0; i < 4; i++) db.messages.push({
      id: 'm-tabcheck-mention-' + i, channel_id: mine[i % mine.length].channel_id,
      author_id: 'u-9', body: '@nishchay tab check ' + i, created_at: new Date(Date.now() - i * 6e4).toISOString(),
      parent_id: null, reply_count: 0, flagged: false, pinned_at: null });
    window.nc_openInbox();
    await w(2500);
    const out = {};
    for (const btn of [...document.querySelectorAll('[data-c3-inbox-filter]')]) {
      const key = btn.dataset.c3InboxFilter;
      const claimed = parseInt(btn.innerText.replace(/[^0-9]+/g, ''), 10);
      btn.click(); await w(350);
      const ticks = [...document.querySelectorAll('#nc_inboxPane [data-c3-inbox-done]')];
      // a cleared card carries the key twice: the tick and its Undo link
      const listed = new Set(ticks.map(e => e.dataset.c3InboxDone)).size;
      const cards = ticks.filter(e => e.style.borderRadius === '50%')
        .map(e => e.closest('div[style*="border-radius:13px"]'));
      const kinds = [...new Set(cards.map(c => {
        const b = c && c.querySelector('div[style*="text-transform:uppercase"]');
        return b ? b.textContent.trim() : '?';
      }))];
      out[key] = { claimed, listed, kinds };
    }
    return out;
  });
  const one = (k, ...labels) => r[k] && r[k].listed > 0
    && r[k].kinds.every(x => labels.includes(x)) && r[k].kinds.length >= 1;
  check('each tab lists exactly as many items as its badge counts',
    Object.values(r).every(t => t.claimed === t.listed), JSON.stringify(r));
  check('Mentions, Flagged, New activity and Tasks each hold one kind of item',
    one('mention', 'Mentioned you') && one('flagged', 'Flagged for reply')
    && one('unread', 'New activity') && one('task', 'New task assigned', 'Your task'), JSON.stringify(r));
  check('All is the union, and is bigger than any single kind it contains',
    r.all.listed >= r.mention.listed + r.flagged.listed + r.unread.listed + r.task.listed,
    JSON.stringify({ all: r.all.listed, parts: [r.mention.listed, r.flagged.listed, r.unread.listed, r.task.listed] }));
});

// Every card read "Someone assigned you a task": profileName goes through mg.profilesById,
// and the only thing that ever filled it was the per-channel tasks view, which the Inbox
// does not open. The names were in chatProfilesCache the whole time.
await step('Inbox cards name the person, not "Someone"', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const db = window.__mock.db;
    // seeded tasks are all created by me; this one has a creator to look up
    db.tasks.push({ id: 't-named-creator', name: 'Task from someone else', description: null,
      status: 'todo', priority: 'high', assigned_to: ['u-me'], department: 'general',
      due_at: null, project_id: 'p-1', client_id: 'c-1', created_by: 'u-3',
      created_at: new Date().toISOString(), completed_at: null });
    window.nc_openInbox();
    await w(2500);
    // the step before this leaves whichever tab it checked last selected
    document.querySelector('[data-c3-inbox-filter="task"]').click();
    await w(600);
    const pane = document.getElementById('nc_inboxPane');
    const lines = [...pane.querySelectorAll('span[style*="font-weight:700"]')].map(e => e.textContent.trim());
    return {
      saysSomeone: /Someone/.test(pane.innerText),
      namesCreator: lines.some(t => /^Team Member \d+ assigned you a task$/.test(t)),
      ownTaskReadsAsMine: lines.includes('You added this task'),
      sample: lines.filter(t => /task$/.test(t)).slice(0, 4)
    };
  });
  check('a task names whoever assigned it, and my own reads as mine',
    !r.saysSomeone && r.namesCreator && r.ownTaskReadsAsMine, JSON.stringify(r));
});

// Save, clear and jump: the three things a row is for.
await step('Inbox rows save, clear and open the conversation they came from', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const vis = el => !!el && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      && el.getBoundingClientRect().height > 4;
    const rows = () => new Set([...document.querySelectorAll('#nc_inboxPane [data-c3-inbox-done]')]
      .map(e => e.dataset.c3InboxDone)).size;
    const tab = k => document.querySelector('[data-c3-inbox-filter="' + k + '"]').click();
    tab('all'); await w(400);
    const saveEl = document.querySelector('[data-c3-inbox-save]');
    const savedKey = saveEl && saveEl.dataset.c3InboxSave;
    if (saveEl) saveEl.click();
    await w(900);
    tab('saved'); await w(500);
    const savedShows = !!document.querySelector('[data-c3-inbox-save="' + savedKey + '"]');

    tab('all'); await w(400);
    const before = rows();
    const tick = document.querySelector('[data-c3-inbox-done]');
    const doneKey = tick && tick.dataset.c3InboxDone;
    if (tick) tick.click();
    await w(900);
    const leftAll = rows() === before - 1;
    tab('done'); await w(500);
    const doneShows = !!document.querySelector('[data-c3-inbox-done="' + doneKey + '"]');

    tab('mention'); await w(500);
    // fall back to All: the tick above may have cleared the last open mention
    if (!document.querySelector('[data-c3-inbox-jump]')) { tab('all'); await w(500); }
    const jump = document.querySelector('[data-c3-inbox-jump]');
    const target = jump && jump.dataset.c3InboxJump.split('::')[1];
    if (jump) jump.click();
    await w(2200);
    const landed = !vis(document.getElementById('nc_inboxPane'))
      && vis(document.querySelector('main.nc_thread .nc_thread-head:not(#nc_inboxHead)'));
    return { savedShows, leftAll, doneShows, target, landed,
             wrote: (window.__mock.log.writes || []).filter(x => /inbox_actions/.test(x)).length };
  });
  check('saving a row moves it into Saved, and clearing one moves it into Done',
    r.savedShows && r.leftAll && r.doneShows && r.wrote > 0, JSON.stringify(r));
  check('clicking a row leaves the Inbox and opens that conversation',
    !!r.target && r.landed, JSON.stringify(r));
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

await step('the "+" on a nav card creates a channel and shows it', async () => {
  const r = await page.evaluate(async () => {
    const out = {};
    document.querySelectorAll('.modal-overlay.on').forEach(m => m.classList.remove('on'));
    const card = [...document.querySelectorAll('.nc_navcard')].find(x => x.dataset.nccard === 'teams');
    if (card && card.querySelector('.nc_navcard-body').getBoundingClientRect().height < 4) {
      card.querySelector('.nc_navcard-head').click();
      await new Promise(r => setTimeout(r, 500));
    }
    const inList = () => [...document.querySelectorAll('#nc_chatChannelList .nc_ch-item, #nc_cardTeamsBody .nc_ch-item')]
      .some(e => /clickthrough-made/.test(e.textContent));
    out.presentBefore = inList();
    const plus = document.getElementById('nc_newChannelBtn2');
    out.plusExists = !!plus;
    if (!plus) return out;
    plus.click();
    await new Promise(r => setTimeout(r, 500));
    // Visibility measured for real. classList.contains('on') and getComputedStyle().display
    // both report on the element alone and say nothing about a hidden ANCESTOR -- which is
    // exactly how this check passed while the modal was opening inside the hidden old-chat
    // screen and the user saw nothing at all.
    const seen = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) return false;
      // These overlays are position:fixed, so offsetParent is null by spec and cannot be
      // the test. checkVisibility walks the ancestor chain, which is the whole point here:
      // the bug was a visible modal inside a display:none screen.
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
      for (let n = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      return true;
    };
    const modal = document.getElementById('nc_newChannelModal');
    out.modalOpened = seen(modal);
    out.wrongModalShown = seen(document.getElementById('newChannelModal'));
    if (!out.modalOpened) return out;
    // Pressed from Teams, so the form must come up on Team -- otherwise the default has
    // simply moved rather than been made to follow the card.
    out.defaultedToTeam =
      document.querySelector('#nc_newChannelModal [data-ctype].nc_sel')?.dataset.ctype === 'team';
    const name = document.getElementById('nc_newChannelName');
    if (name) { name.value = 'clickthrough-made'; name.dispatchEvent(new Event('input', { bubbles: true })); }
    const before = window.__mock.db.channels.length;
    document.getElementById('nc_newChannelSubmit')?.click();
    // Generous: the insert, the membership write, the debounced reload and a re-render.
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (inList()) break;
    }
    out.created = window.__mock.db.channels.length > before;
    out.presentAfter = inList();
    document.querySelectorAll('.modal-overlay.on').forEach(m => m.classList.remove('on'));
    return out;
  });
  // Creating it was never the broken half. The channel landed in the database and the
  // sidebar went on showing the old list, so the button read as dead.
  check('the "+" on a nav card creates a channel and shows it',
    r.plusExists && r.modalOpened && !r.wrongModalShown && r.created
      && r.defaultedToTeam && !r.presentBefore && r.presentAfter,
    JSON.stringify(r));
});

await step('every modal New Chat opens is actually on screen', async () => {
  const r = await page.evaluate(async () => {
    const seen = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 100) return false;
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
      for (let n = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      return true;
    };
    const shut = () => document.querySelectorAll('.modal-overlay.on, .nc_modal-overlay.on')
      .forEach(m => m.classList.remove('on'));
    const out = {};
    // Open each one the way the app does, then ask whether a person could see it.
    for (const id of ['nc_newChannelModal', 'nc_channelMembersModal', 'nc_pinnedMessagesModal',
                      'nc_newDmModal', 'nc_inviteToChannelModal']) {
      shut();
      const el = document.getElementById(id);
      if (!el) { out[id] = 'missing'; continue; }
      el.classList.add('on');
      // .nc_modal-overlay fades in over 280ms and seen() checks opacity, so measuring at
      // 120ms caught it mid-animation and reported a perfectly good modal as hidden --
      // a check that fails at random is worse than no check. Wait for it to settle.
      let last = -1;
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 50));
        const o = parseFloat(getComputedStyle(el).opacity || '1');
        if (o >= 0.99 && o === last) break;
        last = o;
      }
      out[id] = seen(el) ? 'visible' : 'hidden';
    }
    shut();
    // ...and that closing one actually targets itself rather than the old chat's copy.
    const ch = document.getElementById('nc_newChannelModal');
    ch.classList.add('on');
    await new Promise(r => setTimeout(r, 100));
    ch.querySelector('[data-close]')?.click();
    await new Promise(r => setTimeout(r, 150));
    out.closes = !ch.classList.contains('on');
    shut();
    return out;
  });
  const ids = ['nc_newChannelModal', 'nc_channelMembersModal', 'nc_pinnedMessagesModal',
               'nc_newDmModal', 'nc_inviteToChannelModal'];
  check('every modal New Chat opens is actually on screen',
    ids.every(k => r[k] === 'visible') && r.closes === true, JSON.stringify(r));
});

await step('a need on a client department the sidebar does not paint still lists', async () => {
  const r = await page.evaluate(async () => {
    const me = window.giantSession.user.id;
    // The Clients scope keeps ONE row per client -- its General -- so unread on any other
    // department points at a channel id with no row. That is the shape that lost two
    // channels out of five for real.
    window.nc__chatScope = 'clients';
    try { localStorage.setItem('giant_nc_chat_scope', 'clients'); } catch (_) {}
    window.__mock.db.messages.push({
      id: 'm-quiet-dept', channel_id: 'ch-cd-seo-8', author_id: 'u-7',
      body: 'the seo department needs a look', created_at: new Date().toISOString()
    });
    if (window.nc_renderChannelList) window.nc_renderChannelList();
    await window.nc_computeNeedsYou();
    await new Promise(r => setTimeout(r, 900));

    const painted = new Set([...document.querySelectorAll('#nc_chatChannelList .nc_ch-item[data-nc-channel-id]')]
      .map(e => e.dataset.ncChannelId));
    const onCard = new Set([...document.querySelectorAll('#nc_cardNeedsBody .nc_ch-item')]
      .map(e => e.dataset.ncChannelId || e.dataset.ncDmChannelId).filter(Boolean));
    const { data: uc } = await window.giantSupabase.from('unread_counts')
      .select('channel_id, unread_count').eq('profile_id', me);
    const unread = (uc || []).filter(x => (x.unread_count || 0) > 0).map(x => x.channel_id);
    return {
      target: 'ch-cd-seo-8',
      targetWasPainted: painted.has('ch-cd-seo-8'),      // false is the point
      targetOnCard: onCard.has('ch-cd-seo-8'),
      unreadCount: unread.length,
      missing: unread.filter(id => !onCard.has(id)),
      label: [...document.querySelectorAll('#nc_cardNeedsBody .nc_ch-item')]
        .filter(e => e.dataset.ncChannelId === 'ch-cd-seo-8')
        .map(e => e.textContent.trim().replace(/\s+/g, ' '))[0] || null
    };
  });
  // Every channel the database calls unread has a row. The card is the queue; a silent
  // drop is the one failure that cannot be noticed by looking at it.
  check('a need on a client department the sidebar does not paint still lists',
    r.targetOnCard && r.missing.length === 0 && !!r.label, JSON.stringify(r));
});

await step('unread badges survive a sidebar rebuild', async () => {
  const r = await page.evaluate(async () => {
    const me = window.giantSession.user.id;
    // A membership change is the ordinary trigger: it fires whenever anyone's
    // last_read_at is written, which is constantly.
    window.__mock.emit('channel_members', 'UPDATE', { channel_id: 'ch-team-0', profile_id: me });
    // Long enough for the debounced reload, the list repaint and the card rebuild.
    await new Promise(r => setTimeout(r, 2600));

    const { data: uc } = await window.giantSupabase.from('unread_counts')
      .select('channel_id, unread_count').eq('profile_id', me);
    const unread = new Set((uc || []).filter(x => (x.unread_count || 0) > 0).map(x => x.channel_id));
    const rows = [...document.querySelectorAll('#nc_chatChannelList .nc_ch-item[data-nc-channel-id]')];
    // Counting against what SHOULD carry one, not against an earlier count -- an earlier
    // count taken after a previous rebuild is already missing the badges, so "no worse
    // than before" passes on a build where every badge is gone.
    const expect = rows.filter(el => unread.has(el.dataset.ncChannelId)
      && el.dataset.ncChannelId !== window.nc_activeChannelId);
    const withBadge = expect.filter(el => el.querySelector('.nc_ch-unread-badge'));
    return { rowsRendered: rows.length, shouldHaveBadge: expect.length, haveBadge: withBadge.length };
  });
  // They used to vanish on every repaint and stay gone until the 30s poll or a reload.
  check('unread badges survive a sidebar rebuild',
    r.shouldHaveBadge > 0 && r.haveBadge === r.shouldHaveBadge, JSON.stringify(r));
});

await step('Invite members picks people, and they are actually added', async () => {
  const r = await page.evaluate(async () => {
    const out = {};
    document.querySelectorAll('.modal-overlay.on, .nc_modal-overlay.on').forEach(m => m.classList.remove('on'));
    document.getElementById('nc_newChannelBtn2')?.click();
    await new Promise(r => setTimeout(r, 700));
    out.parentFieldGone = !document.getElementById('nc_newChannelParent');
    const box = document.getElementById('nc_newChannelSuggest');
    // An empty suggestion box carries a border and background, so it drew a grey bar.
    out.suggestHiddenWhenEmpty = !!box && box.getBoundingClientRect().height < 1;

    const input = document.getElementById('nc_newChannelInvite');
    out.hasInput = !!input;
    if (!input) return out;
    input.focus();
    input.value = 'Team Member 3';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    for (let i = 0; i < 30 && !box.querySelector('.nc_invite-suggest-item'); i++) {
      await new Promise(r => setTimeout(r, 150));
    }
    const first = box.querySelector('.nc_invite-suggest-item');
    out.suggested = box.querySelectorAll('.nc_invite-suggest-item').length;
    out.suggestShows = !!box && box.getBoundingClientRect().height > 10;
    if (!first) return out;

    // A broad filter, to see the whole offered set at once.
    input.value = 'team member';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    const offered = [...box.querySelectorAll('.nc_invite-suggest-item')];
    const dead = new Set(window.__mock.db.profiles.filter(p => p.deactivated_at).map(p => p.id));
    out.deactivatedInFixture = dead.size;
    out.deactivatedOffered = offered.filter(el => dead.has(el.dataset.inviteId)).length;
    // Photos must render as a loaded <img>. background-image on a style attribute loses
    // an encoded storage filename and draws an empty circle instead.
    const withPhoto = offered.filter(el => el.querySelector('img'));
    out.rowsWithPhoto = withPhoto.length;
    out.photosLoaded = withPhoto.filter(el => {
      const img = el.querySelector('img');
      return img.complete && img.naturalWidth > 0;
    }).length;
    // Loading is not the same as fitting. An <img> whose box resolves against nothing
    // paints at the file's own size -- a full-width photograph in a 6px-tall row -- and
    // "the image loaded" passes happily on exactly that.
    out.photoBoxes = withPhoto.map(el => {
      const r = el.querySelector('img').getBoundingClientRect();
      return Math.round(r.width) + 'x' + Math.round(r.height);
    });
    out.photosSized = withPhoto.filter(el => {
      const r = el.querySelector('img').getBoundingClientRect();
      return r.width > 8 && r.width <= 40 && r.height > 8 && r.height <= 40;
    }).length;
    // Nothing may overflow the row it sits in, in either direction.
    out.rowsOverflowing = offered.filter(el => {
      const rr = el.getBoundingClientRect();
      return [...el.querySelectorAll('*')].some(ch => {
        const cr = ch.getBoundingClientRect();
        return cr.width > 0 && (cr.right > rr.right + 2 || cr.left < rr.left - 2);
      });
    }).length;
    out.tallestRow = Math.max(...offered.map(el => Math.round(el.getBoundingClientRect().height)));
    out.rowsWithName = offered.filter(el => (el.textContent || '').trim().length > 1).length;
    out.offered = offered.length;

    input.value = 'Team Member 3';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    // Re-query: the broad filter above rebuilt the list, so the earlier node is detached
    // and clicking it does nothing at all.
    const pick = box.querySelector('.nc_invite-suggest-item');
    if (!pick) return out;
    const picked = pick.dataset.inviteId;
    pick.click();
    await new Promise(r => setTimeout(r, 300));
    out.chips = document.querySelectorAll('#nc_newChannelChips .nc_invite-chip').length;

    const name = document.getElementById('nc_newChannelName');
    name.value = 'invite-flow-test';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('nc_newChannelSubmit')?.click();
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (window.__mock.db.channels.some(c => c.name === 'invite-flow-test')) break;
    }
    const made = window.__mock.db.channels.find(c => c.name === 'invite-flow-test');
    out.created = !!made;
    if (made) {
      const mem = window.__mock.db.channel_members.filter(m => m.channel_id === made.id);
      out.memberCount = mem.length;
      out.inviteeIsMember = mem.some(m => m.profile_id === picked);
      out.creatorIsMember = mem.some(m => m.profile_id === window.giantSession.user.id);
    }
    document.querySelectorAll('.nc_modal-overlay.on').forEach(m => m.classList.remove('on'));
    return out;
  });
  // The field took chips and threw them away on submit before this.
  check('Invite members picks people, and they are actually added',
    r.parentFieldGone && r.suggestHiddenWhenEmpty && r.suggested > 0 && r.suggestShows
      && r.chips === 1 && r.created && r.inviteeIsMember && r.creatorIsMember
      // every offered row names someone, no deactivated account is offered, and a photo
      // that exists actually renders
      && r.deactivatedInFixture > 0 && r.deactivatedOffered === 0
      && r.rowsWithName === r.offered
      && r.rowsWithPhoto > 0 && r.photosLoaded === r.rowsWithPhoto
      && r.photosSized === r.rowsWithPhoto && r.rowsOverflowing === 0 && r.tallestRow < 60,
    JSON.stringify(r));
});

await step('the DM picker takes one person, the group picker takes several', async () => {
  const r = await page.evaluate(async () => {
    const out = {};
    const shut = () => document.querySelectorAll('.modal-overlay.on, .nc_modal-overlay.on')
      .forEach(m => m.classList.remove('on'));
    const dead = new Set(window.__mock.db.profiles.filter(p => p.deactivated_at).map(p => p.id));
    out.deactivatedInFixture = dead.size;

    const open = async (btnId) => {
      shut();
      document.getElementById(btnId)?.click();
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 200));
        if (document.querySelectorAll('#nc_newDmList .nc_m-dm-item').length) break;
      }
      return [...document.querySelectorAll('#nc_newDmList .nc_m-dm-item')];
    };
    const selected = () => document.querySelectorAll('#nc_newDmList .nc_m-dm-item')
      .length && [...document.querySelectorAll('#nc_newDmList .nc_m-dm-item')]
        .filter(el => el.innerHTML.includes('M3.5 8.5l3 3 6-7')).length;

    // Direct card: one at a time.
    let rows = await open('nc_newDmBtn2');
    out.dmRows = rows.length;
    out.dmOffersDeactivated = rows.filter(el => dead.has(el.dataset.dmId)).length;
    out.dmTitle = document.querySelector('#nc_newDmModal h3')?.textContent || '';
    rows[0].click(); await new Promise(r => setTimeout(r, 200));
    rows[1].click(); await new Promise(r => setTimeout(r, 250));
    out.dmSelectedAfterTwo = selected();

    // Group DMs card: several.
    rows = await open('nc_newGroupBtn2');
    out.groupTitle = document.querySelector('#nc_newDmModal h3')?.textContent || '';
    rows[0].click(); await new Promise(r => setTimeout(r, 200));
    rows[1].click(); await new Promise(r => setTimeout(r, 250));
    out.groupSelectedAfterTwo = selected();
    shut();

    // The sidebar's "start a DM" fallback list, same rule.
    out.sidebarOffersDeactivated = [...document.querySelectorAll('#nc_chatDmList [data-start-dm]')]
      .filter(el => dead.has(el.dataset.startDm)).length;
    return out;
  });
  check('the DM picker takes one person, the group picker takes several',
    r.deactivatedInFixture > 0 && r.dmOffersDeactivated === 0 && r.sidebarOffersDeactivated === 0
      && r.dmRows > 2 && r.dmSelectedAfterTwo === 1 && r.groupSelectedAfterTwo === 2
      && /direct message/i.test(r.dmTitle) && /group/i.test(r.groupTitle),
    JSON.stringify(r));
});

await step('deleting a client conversation removes it', async () => {
  const r = await page.evaluate(async () => {
    const out = {};
    const card = [...document.querySelectorAll('.nc_navcard')].find(x => x.dataset.nccard === 'clients');
    if (card && card.querySelector('.nc_navcard-body').getBoundingClientRect().height < 4) {
      card.querySelector('.nc_navcard-head').click();
      await new Promise(r => setTimeout(r, 700));
    }
    const rows = () => [...document.querySelectorAll('#nc_cardClientsBody .nc_ch-item')];
    // Maribou has TWO General channels in the fixture, which is the real shape: the
    // sidebar unions them into one row, so deleting only the row's own channel leaves
    // the row standing and the click reads as dead.
    const row = rows().find(e => /Maribou/i.test(e.textContent));
    if (!row) { out.noRow = true; return out; }
    const cid = row.dataset.ncChannelId;
    out.rowChannelId = cid || null;
    const target = window.__mock.db.channels.find(c => c.id === cid);
    out.siblings = window.__mock.db.channels
      .filter(c => target && c.client_id === target.client_id).map(c => c.id);
    const btn = row.querySelector('.nc_row-menu');
    out.hasMenu = !!btn;
    if (!btn) return out;
    btn.click();
    await new Promise(r => setTimeout(r, 400));
    const del = document.querySelector('.nc_channel-ctx-menu [data-action="delete"]');
    out.hasDelete = !!del;
    if (!del) return out;
    const before = window.__mock.db.channels.length;
    del.click();
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (window.__mock.db.channels.length < before) break;
    }
    out.deleted = before - window.__mock.db.channels.length;
    await new Promise(r => setTimeout(r, 1500));
    // The CONVERSATION goes; the CLIENT stays. This flipped twice in a day -- the empty
    // row was removed because after a delete it read as the delete having failed, then
    // brought back because the card is the client list and every client belongs on it.
    // What must be true either way is that no row still points at a deleted channel.
    const after = rows().find(e => /Maribou/i.test(e.textContent));
    out.rowRemains = !!after;
    out.rowIsDimmedPlaceholder = !!(after && after.dataset.clientId && !after.dataset.ncChannelId);
    out.rowsStillOnDeletedChannels = rows()
      .filter(e => e.dataset.ncChannelId && out.siblings.includes(e.dataset.ncChannelId)).length;
    out.remaining = window.__mock.db.channels
      .filter(c => target && c.client_id === target.client_id).map(c => c.id);
    return out;
  });
  check('deleting a client conversation removes it',
    r.hasMenu && r.hasDelete && r.deleted > 0 && !r.rowRemains
      // Gone from the card entirely, not left behind as a dimmed client row. That
      // placeholder is what made a deleted conversation look like it had come back.
      && r.rowIsDimmedPlaceholder === false
      && r.rowsStillOnDeletedChannels === 0,
    JSON.stringify(r));
});

await step('the Clients "+" opens the same form as Teams', async () => {
  const r = await page.evaluate(async () => {
    const seen = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 100) return false;
      return typeof el.checkVisibility === 'function'
        ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true;
    };
    const out = {};
    document.querySelectorAll('.modal-overlay.on, .nc_modal-overlay.on').forEach(m => m.classList.remove('on'));
    const btn = document.getElementById('nc_newClientChannelBtn');
    out.hasButton = !!btn;
    if (!btn) return out;
    // Pressing "+" must not open or collapse the card it sits on.
    const card = btn.closest('.nc_navcard');
    const bodyBefore = card.querySelector('.nc_navcard-body').getBoundingClientRect().height;
    btn.click();
    await new Promise(r => setTimeout(r, 900));
    out.opensTeamForm = seen(document.getElementById('nc_newChannelModal'));
    out.cardDidNotToggle =
      Math.abs(card.querySelector('.nc_navcard-body').getBoundingClientRect().height - bodyBefore) < 2;
    out.pickerGone = !document.getElementById('nc_newClientChannelModal');
    if (!out.opensTeamForm) return out;
    // The choice is on screen and pre-set from the card that was pressed.
    out.typeChoiceVisible = document.querySelectorAll('#nc_newChannelModal [data-ctype]').length === 2;
    out.defaultedToClient =
      document.querySelector('#nc_newChannelModal [data-ctype].nc_sel')?.dataset.ctype === 'client';
    // Selecting a type must not disturb the privacy row: both grids are .nc_m-role.
    out.privacyBefore = document.querySelector('#nc_newChannelModal [data-priv].nc_sel')?.dataset.priv;
    document.querySelector('#nc_newChannelModal [data-ctype="client"]').click();
    await new Promise(r => setTimeout(r, 150));
    out.privacyAfter = document.querySelector('#nc_newChannelModal [data-priv].nc_sel')?.dataset.priv;

    // No client or department pickers: the form asks where the channel belongs and
    // nothing else.
    out.noClientPicker = !document.getElementById('nc_newChannelClient');
    out.noDeptPicker = !document.getElementById('nc_newChannelDept');
    const name = document.getElementById('nc_newChannelName');
    name.value = 'from-clients-card';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    const before = window.__mock.db.channels.length;
    document.getElementById('nc_newChannelSubmit')?.click();
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (window.__mock.db.channels.length > before) break;
    }
    const made = window.__mock.db.channels.find(c => c.name === 'from-clients-card');
    out.created = !!made;
    out.shape = made ? { kind: made.kind, client: made.client_id || null, dept: made.department || null } : null;
    // A DEPARTMENT still implies a client -- the half of the old constraint that was kept,
    // because a department tab means nothing without one.
    out.rejectsDeptWithoutClient = await (async () => {
      const { error } = await window.giantSupabase.from('channels')
        .insert({ name: 'illegal', slug: 'illegal-x', kind: 'client_dept', department: 'seo' })
        .select().single();
      return !!error && /channels_department_needs_client/.test(error.message || '');
    })();
    document.querySelectorAll('.nc_modal-overlay.on').forEach(m => m.classList.remove('on'));
    // Only the Clients card is opened, and it is opened LAST. The cards are an accordion,
    // so opening Teams afterwards collapses Clients and every rect in it measures 0x0 --
    // which is how a perfectly round mark reported as not a circle.
    const clientsCard = [...document.querySelectorAll('.nc_navcard')].find(x => x.dataset.nccard === 'clients');
    if (clientsCard && clientsCard.querySelector('.nc_navcard-body').getBoundingClientRect().height < 4) {
      clientsCard.querySelector('.nc_navcard-head').click();
    }
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (clientsCard.querySelector('.nc_navcard-body').getBoundingClientRect().height > 40) break;
    }
    await new Promise(r => setTimeout(r, 400));
    const rows = [...document.querySelectorAll('#nc_cardClientsBody .nc_ch-item')];
    const idx = rows.findIndex(e => /from-clients-card/.test(e.textContent));
    out.inClientsCard = idx >= 0;
    out.clientRows = rows.length;
    // What you just made is at the top. Appended, it sat under fifty alphabetised
    // clients, which is the sidebar hiding your own work.
    out.positionInCard = idx;
    // ...and it wears an initial circle like every other row in this card, not a "#",
    // which made the one row that is not a client look like a stray team channel.
    const mark = idx >= 0 ? rows[idx].querySelector('.nc_hash') : null;
    out.markText = mark ? (mark.textContent || '').trim() : null;
    const mr = mark ? mark.getBoundingClientRect() : null;
    out.markBox = mr ? Math.round(mr.width) + 'x' + Math.round(mr.height) : null;
    out.markRadius = mark ? getComputedStyle(mark).borderRadius : null;
    // Round and roughly square: a percentage radius comes back resolved in px, so the
    // test is that the radius is at least half the box, not that the string says "50%".
    out.markIsCircle = !!mr && mr.width >= 16 && Math.abs(mr.width - mr.height) < 3
      && parseFloat(out.markRadius) >= mr.width / 2 - 1;
    out.inTeamsCard = [...document.querySelectorAll('#nc_cardTeamsBody .nc_ch-item')]
      .some(e => /from-clients-card/.test(e.textContent));
    return out;
  });
  check('the Clients "+" opens the same form as Teams',
    r.hasButton && r.opensTeamForm && r.cardDidNotToggle && r.pickerGone
      && r.typeChoiceVisible && r.defaultedToClient
      && r.privacyBefore === 'public' && r.privacyAfter === 'public'
      && r.noClientPicker && r.noDeptPicker
      && r.created && r.shape && r.shape.kind === 'client_dept'
      && r.shape.client === null && r.shape.dept === null
      && r.rejectsDeptWithoutClient
      && r.inClientsCard && !r.inTeamsCard
      // Two initials now, not one: "FD" tells two Fortress rows apart where "F" does not.
      && r.positionInCard === 0 && /^[A-Z]{2}$/.test(r.markText || '') && r.markIsCircle,
    JSON.stringify(r));
});

await step('scheduling a message works from New Chat\'s own composer', async () => {
  const r = await page.evaluate(async () => {
    const seen = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 20) return false;
      return typeof el.checkVisibility === 'function'
        ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true;
    };
    const out = {};
    document.querySelectorAll('.modal-overlay.on, .nc_modal-overlay.on').forEach(m => m.classList.remove('on'));
    const input = document.getElementById('nc_chatInput');
    if (input) { input.value = 'scheduled from the click-through'; input.dispatchEvent(new Event('input', { bubbles: true })); }
    const chev = document.getElementById('nc_chatScheduleBtn');
    out.hasChevron = !!chev;
    if (!chev) return out;
    chev.click();
    await new Promise(r => setTimeout(r, 500));
    const pop = document.getElementById('schedulePopover');
    out.popoverOpens = seen(pop);
    const presets = pop ? [...pop.querySelectorAll('.schedule-preset')] : [];
    out.presets = presets.length;
    if (!presets.length) return out;
    const before = window.__mock.db.scheduled_messages ? window.__mock.db.scheduled_messages.length : 0;
    presets[0].click();
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 200));
      const n = window.__mock.db.scheduled_messages ? window.__mock.db.scheduled_messages.length : 0;
      if (n > before) break;
    }
    const rows = window.__mock.db.scheduled_messages || [];
    out.wrote = rows.length - before;
    const mine = rows[rows.length - 1];
    out.forThisChannel = !!mine && mine.channel_id === window.nc_activeChannelId;
    // The pill is New Chat's own, and must actually show the count.
    await new Promise(r => setTimeout(r, 900));
    const pill = document.getElementById('nc_chatScheduledPill');
    out.pillShows = seen(pill);
    out.pillText = pill ? (pill.textContent || '').trim() : null;
    document.querySelectorAll('.modal-overlay.on').forEach(m => m.classList.remove('on'));
    return out;
  });
  check('scheduling a message works from New Chat\'s own composer',
    r.hasChevron && r.popoverOpens && r.presets > 0 && r.wrote === 1
      && r.forThisChannel && r.pillShows && /scheduled/i.test(r.pillText || ''),
    JSON.stringify(r));
});

await step('the formatting toolbar formats New Chat\'s own composer', async () => {
  const r = await page.evaluate(async () => {
    const out = {};
    const input = document.getElementById('nc_chatInput');
    if (!input) return { noInput: true };
    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    input.setSelectionRange(0, 5);
    const bold = document.getElementById('nc_chatFmtBold');
    out.hasBold = !!bold;
    if (!bold) return out;
    bold.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 200));
    out.wrapped = input.value;
    // The other chat's box must be untouched -- it is the one this used to write into.
    out.otherComposer = (document.getElementById('chatInput') || {}).value || '';

    // And the thread composer must format ITSELF, not the channel box.
    const t = document.getElementById('nc_threadInput');
    out.hasThreadInput = !!t;
    if (t) {
      const channelBefore = input.value;
      t.value = 'reply';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.focus();
      t.setSelectionRange(0, 5);
      const tb = document.getElementById('nc_threadFmtBold');
      out.hasThreadBold = !!tb;
      if (tb) {
        tb.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 200));
        out.threadWrapped = t.value;
        out.channelUntouched = input.value === channelBefore;
      }
    }
    return out;
  });
  check('the formatting toolbar formats New Chat\'s own composer',
    r.hasBold && r.wrapped === '**hello**' && r.otherComposer === ''
      && r.hasThreadInput && r.hasThreadBold
      && r.threadWrapped === '**reply**' && r.channelUntouched,
    JSON.stringify(r));
});

await step('Start huddle is wired to New Chat\'s own button', async () => {
  const r = await page.evaluate(async () => {
    const out = {};
    const btn = document.getElementById('nc_chatHuddleBtn');
    out.hasButton = !!btn;
    if (!btn) return out;
    // wireHuddleUI stamps this on whatever button it bound, so it is the direct
    // evidence that New Chat's button -- not the other screen's -- got the listener.
    out.wired = btn.dataset.huddleWired === '1';
    // The other screen's button being wired too is correct and expected -- both drive
    // the same feature, each while its own screen is the one on. What matters is that
    // getHuddleEls resolves to New Chat's elements from here.
    out.otherWired = (document.getElementById('chatHuddleBtn') || {}).dataset?.huddleWired === '1';
    out.resolvedId = (() => {
      const onNew = !!document.querySelector('.screen[data-screen="newchat"].on');
      return (onNew ? 'nc_' : '') + 'chatHuddleBtn';
    })();
    // ...and the feature resolves New Chat's elements while New Chat is the screen on.
    out.resolvesNewChat = !!document.querySelector('.screen[data-screen="newchat"].on');
    out.hasBar = !!document.getElementById('nc_chatHuddleBar');
    out.label = (document.getElementById('nc_chatHuddleBtnLabel') || {}).textContent || null;
    return out;
  });
  check('Start huddle is wired to New Chat\'s own button',
    r.hasButton && r.wired && r.resolvesNewChat && r.hasBar
      && r.resolvedId === 'nc_chatHuddleBtn' && /huddle/i.test(r.label || ''),
    JSON.stringify(r));
});

await step('a new client channel is public, with the whole team in it', async () => {
  const r = await page.evaluate(async () => {
    const db = window.__mock.db;
    // A client with no conversation yet. Clicking its row no longer creates one -- that
    // is deliberate, so a deleted conversation stays deleted -- so this presses the
    // "Start conversation" button the row opens.
    const withChan = new Set(db.channels.filter(c => c.kind === 'client_dept').map(c => c.client_id));
    const target = db.clients.find(c => c.status !== 'churned' && !withChan.has(c.id));
    if (!target) return { noEmptyClient: true };
    const card = [...document.querySelectorAll('.nc_navcard')].find(x => x.dataset.nccard === 'clients');
    if (card && card.querySelector('.nc_navcard-body').getBoundingClientRect().height < 4) {
      card.querySelector('.nc_navcard-head').click();
      await new Promise(r => setTimeout(r, 700));
    }
    // Clients with no conversation are no longer listed in the card, so this reaches the
    // one it wants by name, the way a person does.
    const out = { client: target.name };
    const jump = document.getElementById('nc_chatJumpToInput');
    if (jump) {
      jump.value = target.name.slice(0, 6);
      jump.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1300));
    }
    const results = document.getElementById('nc_jumpResults');
    const hit = results ? [...results.querySelectorAll('*')]
      .find(e => e.children.length === 0 && e.textContent.trim() === target.name) : null;
    out.foundRow = !!hit;
    if (!hit) return out;
    const before = db.channels.length;
    hit.click();
    await new Promise(r => setTimeout(r, 1800));
    const startBtn = document.getElementById('nc_startConvoBtn');
    out.startButtonShown = !!startBtn;
    if (startBtn) startBtn.click();
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (db.channels.length > before) break;
    }
    const made = db.channels.find(c => c.client_id === target.id && c.kind === 'client_dept');
    out.created = !!made;
    if (!made) return out;
    out.isPublic = made.is_private === false;
    const members = db.channel_members.filter(m => m.channel_id === made.id).map(m => m.profile_id);
    const team = db.profiles.filter(p => !p.deactivated_at && p.role !== 'client').map(p => p.id);
    const clients = db.profiles.filter(p => p.role === 'client').map(p => p.id);
    const dead = db.profiles.filter(p => p.deactivated_at).map(p => p.id);
    out.teamSize = team.length;
    out.memberCount = members.length;
    out.everyoneAdded = team.every(id => members.includes(id));
    out.noClientsAdded = !clients.some(id => members.includes(id));
    out.noDeactivatedAdded = !dead.some(id => members.includes(id));
    return out;
  });
  check('a new client channel is public, with the whole team in it',
    r.foundRow && r.startButtonShown && r.created && r.isPublic && r.teamSize > 1
      && r.everyoneAdded && r.noClientsAdded && r.noDeactivatedAdded,
    JSON.stringify(r));
});

await step('Management is a manager\'s tab, Messages and Vault are everyone\'s', async () => {
  const r = await page.evaluate(async () => {
    const out = {};
    const shown = (id) => {
      const el = document.getElementById(id);
      return !!el && el.style.display !== 'none';
    };
    const clientRow = [...document.querySelectorAll('#nc_cardClientsBody .nc_ch-item[data-nc-channel-id]')][0];
    if (!clientRow) return { noClientChannel: true };
    clientRow.click();
    await new Promise(r => setTimeout(r, 1600));
    out.roleNow = window.giantCurrentProfile.role;
    out.mgmtForStaff = shown('nc_mgmtTabBtn');
    // Same channel, seen as a member.
    window.giantCurrentProfile.role = 'member';
    if (window.nc_syncMgmtTab) window.nc_syncMgmtTab();
    else clientRow.click();
    await new Promise(r => setTimeout(r, 1400));
    out.mgmtForMember = shown('nc_mgmtTabBtn');
    out.vaultForMember = !!document.querySelector('#nc_chatSubTabs [data-subtab="canvas"]');
    window.giantCurrentProfile.role = out.roleNow;
    if (window.nc_syncMgmtTab) window.nc_syncMgmtTab();
    await new Promise(r => setTimeout(r, 600));
    out.mgmtBackForStaff = shown('nc_mgmtTabBtn');
    return out;
  });
  check('Management is a manager\'s tab, Messages and Vault are everyone\'s',
    r.mgmtForStaff === true && r.mgmtForMember === false
      && r.vaultForMember === true && r.mgmtBackForStaff === true,
    JSON.stringify(r));
});

await step('a deactivated account appears nowhere a person is offered', async () => {
  const r = await page.evaluate(async () => {
    const db = window.__mock.db;
    const dead = db.profiles.filter(p => p.deactivated_at);
    const out = { deactivatedInFixture: dead.length, offenders: [] };
    if (!dead.length) return out;
    const deadIds = new Set(dead.map(p => p.id));
    const deadNames = dead.map(p => (p.full_name || p.email || '').trim()).filter(Boolean);

    // 1. the @mention picker
    const input = document.getElementById('nc_chatInput');
    if (input) {
      input.focus();
      input.value = '@';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 600));
      const pop = document.querySelector('.mention-picker-pop');
      const txt = pop ? pop.textContent || '' : '';
      out.mentionPickerOpen = !!pop;
      if (deadNames.some(n => txt.includes(n))) out.offenders.push('mention-picker');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
    }
    // 2. the header avatar row / member count
    const head = document.getElementById('nc_chatHeadMembers');
    if (head && deadNames.some(n => (head.textContent || '').includes(n))) out.offenders.push('header-avatars');

    // 3. the DM picker, 4. the sidebar DM list, 5. the invite field
    const dmRows = [...document.querySelectorAll('#nc_newDmList .nc_m-dm-item')];
    if (dmRows.some(el => deadIds.has(el.dataset.dmId))) out.offenders.push('dm-picker');
    const startDm = [...document.querySelectorAll('#nc_chatDmList [data-start-dm]')];
    if (startDm.some(el => deadIds.has(el.dataset.startDm))) out.offenders.push('sidebar-dm-list');
    // Existing one-to-one conversations with someone who has left. The picker was
    // filtered; the conversations already in the list were not.
    const deadDmIds = new Set(db.channels.filter(c => c.is_dm && c.dm_pair)
      .filter(c => c.dm_pair.split(':').some(id => deadIds.has(id)))
      .filter(c => db.channel_members.filter(m => m.channel_id === c.id
        && m.profile_id !== window.__mock.me).length === 1)
      .map(c => c.id));
    out.deadDmConversations = deadDmIds.size;
    const dmRowsInList = [...document.querySelectorAll('#nc_chatDmList [data-nc-dm-channel-id], #nc_cardDirectBody .nc_ch-item')];
    if (dmRowsInList.some(el => deadDmIds.has(el.dataset.ncDmChannelId))) out.offenders.push('dm-conversation-list');

    // 6. the channel members modal, both halves
    const modalRows = [...document.querySelectorAll('#nc_chMembersList .nc_ch-member, #nc_chMembersList [data-remove]')];
    const modalTxt = modalRows.map(e => e.textContent || '').join(' ');
    if (deadNames.some(n => modalTxt.includes(n))) out.offenders.push('members-modal');
    return out;
  });
  check('a deactivated account appears nowhere a person is offered',
    r.deactivatedInFixture > 0 && r.deadDmConversations > 0 && r.offenders.length === 0,
    JSON.stringify(r));
});

await step('New Chat is now Chat, and the old one is in Archive', async () => {
  const r = await page.evaluate(async () => {
    const out = {};
    const items = [...document.querySelectorAll('.nav-item[data-screen]')];
    const byScreen = (s) => items.filter(e => e.dataset.screen === s);
    const comms = document.querySelector('[data-navgroup-body="communication"]');
    const arch = document.querySelector('[data-navgroup-body="archive"]');

    const newChat = byScreen('newchat')[0];
    out.newChatLabel = newChat ? newChat.dataset.label : null;
    out.newChatInComms = !!(newChat && comms && comms.contains(newChat));
    out.newChatVisible = !!(newChat && newChat.getBoundingClientRect().width > 10);
    out.keepsNewBadge = !!(newChat && /NEW/.test(newChat.textContent || ''));
    // Unread has somewhere to land now that this is THE chat.
    out.hasUnreadBadge = !!document.getElementById('nc_sidebarBadgeChat');

    const oldInArchive = byScreen('chat').find(e => arch && arch.contains(e));
    out.oldChatLabel = oldInArchive ? oldInArchive.dataset.label : null;
    out.oldChatArchived = !!oldInArchive;
    // ...and no Chat entry left loose in Communication for a non-client.
    out.commsChatEntries = byScreen('chat').filter(e => comms && comms.contains(e)).length;
    // Archive is now the in-house dev's alone. It used to be open to everyone, members
    // and clients included, on the grounds that Old Chat was still their surface -- that
    // is no longer the intent: Chat is the surface, and Archive is scaffolding.
    const gate = (el) => el && el.getAttribute('data-role-min');
    const only = (el) => el && el.getAttribute('data-role-only');
    out.archiveOnlyInhouse = only(document.querySelector('[data-navgroup="archive"]')) === 'inhouse_dev'
      && only(document.querySelector('[data-navgroup-body="archive"]')) === 'inhouse_dev';
    out.oldChatGated = !!gate(oldInArchive);
    out.chat2Gated = gate(byScreen('chat2')[0]) === 'manager';
    out.chat3Gated = gate(byScreen('chat3')[0]) === 'manager';
    out.role = window.giantCurrentProfile.role;
    return out;
  });
  check('New Chat is now Chat, and the old one is in Archive',
    r.newChatLabel === 'Chat' && r.newChatInComms && r.newChatVisible
      // Chat is not new any more; the unread count is a different badge and stays.
      && r.keepsNewBadge === false && r.hasUnreadBadge
      && r.oldChatArchived && r.oldChatLabel === 'Old Chat'
      && r.commsChatEntries === 0
      && r.archiveOnlyInhouse && !r.oldChatGated && r.chat2Gated && r.chat3Gated,
    JSON.stringify(r));
});

await step('the header controls all do something', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    const team = [...document.querySelectorAll('#nc_cardTeamsBody .nc_ch-item[data-nc-channel-id]')][0]
              || [...document.querySelectorAll('#nc_chatChannelList .nc_ch-item[data-nc-channel-id]')][0];
    if (team) { team.click(); await wait(1600); }

    // full-screen: was bound only to the other screen's button, so this did nothing
    const fs = document.getElementById('nc_chatFsBtn');
    out.hasFs = !!fs;
    const bodyBefore = document.body.classList.contains('chat-fullscreen');
    fs?.click(); await wait(400);
    out.fullscreenOn = document.body.classList.contains('chat-fullscreen') !== bodyBefore;
    fs?.click(); await wait(300);
    out.fullscreenOff = document.body.classList.contains('chat-fullscreen') === bodyBefore;

    // search in channel
    document.getElementById('nc_chatHeadSearchBtn')?.click(); await wait(600);
    out.searchFocused = (document.activeElement || {}).id === 'nc_chatSearchInput';
    document.getElementById('nc_chatHeadSearchBtn')?.click(); await wait(300);

    // privacy toggle writes and flips its label
    const w0 = window.__mock.log.writes.length;
    const before = document.getElementById('nc_chatHeadPrivacyLabel')?.textContent;
    document.getElementById('nc_chatHeadPrivacyBtn')?.click(); await wait(1500);
    out.privacyWrote = window.__mock.log.writes.length > w0;
    out.privacyFlipped = document.getElementById('nc_chatHeadPrivacyLabel')?.textContent !== before;
    document.getElementById('nc_chatHeadPrivacyBtn')?.click(); await wait(1200);

    // Reading upwards asks the database for more -- there is no button to click now.
    const q0 = window.__mock.log.queries.length;
    const _sc = document.getElementById('nc_chatMsgs');
    if (_sc) { _sc.scrollTop = 0; }
    await wait(1800);
    out.loadEarlierQueried = window.__mock.log.queries.length > q0;

    // "Add card" is gone: custom sections do not exist here, so it could only have made
    // a card that never appears.
    out.addCardGone = !document.getElementById('nc_chatAddSectionBtn');
    return out;
  });
  check('the header controls all do something',
    r.hasFs && r.fullscreenOn && r.fullscreenOff && r.searchFocused
      && r.privacyWrote && r.privacyFlipped && r.loadEarlierQueried && r.addCardGone,
    JSON.stringify(r));
});

await step('a message reacts, opens a thread, and the channel searches', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const db = window.__mock.db;
    const out = {};
    const team = [...document.querySelectorAll('#nc_cardTeamsBody .nc_ch-item[data-nc-channel-id]')][0];
    if (team) { team.click(); await wait(2000); }
    // .nc_msg, not any [data-msg-id]: a message's text node carries the id as well, and
    // the controls live on the message, not inside its text.
    const msgs = () => [...document.querySelectorAll('#nc_chatMsgs .nc_msg[data-msg-id]')];
    out.messagesPainted = msgs().length;
    if (!msgs().length) return out;
    const row = msgs()[msgs().length - 1];
    const id = row.dataset.msgId;
    out.msgId = id;
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await wait(300);

    // react
    const before = db.message_reactions ? db.message_reactions.length : 0;
    row.querySelector('.nc_msg-react-bar-emoji')?.click();
    await wait(1200);
    out.reacted = (db.message_reactions ? db.message_reactions.length : 0) > before;

    // reply in thread opens the thread panel
    row.querySelector('.nc_msg-reply-btn')?.click();
    await wait(1500);
    const panel = document.getElementById('nc_threadPanel') || document.getElementById('nc_threadPane');
    out.threadOpened = !!panel && panel.getBoundingClientRect().width > 100;
    out.threadInput = !!document.getElementById('nc_threadInput');
    const close = document.getElementById('nc_threadCloseBtn') || document.querySelector('[data-close-thread]');
    if (close) { close.click(); await wait(700); }

    // in-channel search finds a word that is definitely in this channel
    const word = (db.messages.find(m => m.channel_id === window.nc_activeChannelId && (m.body || '').length > 8) || {}).body;
    if (word) {
      document.getElementById('nc_chatHeadSearchBtn')?.click();
      await wait(500);
      const inp = document.getElementById('nc_chatSearchInput');
      if (inp) {
        inp.value = word.split(/\s+/)[0];
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(1200);
        out.searchTerm = inp.value;
        out.searchHits = document.querySelectorAll('#nc_chatSearchResults .nc_search-hit, #nc_chatSearchResults > *').length;
      }
      document.getElementById('nc_chatHeadSearchBtn')?.click();
      await wait(300);
    }
    return out;
  });
  // Named for what it drives. Pin, edit and delete are present in the module -- the
  // markup and the messages.update / messages.delete calls are there -- but they are NOT
  // exercised here, and a check that claims them would be the same overclaiming that has
  // bitten this branch six times.
  check('a message reacts, opens a thread, and the channel searches',
    r.messagesPainted > 0 && r.reacted && r.threadOpened && r.threadInput
      && r.searchHits > 0,
    JSON.stringify(r));
});

await step('the voice recorder is wired to New Chat\'s own mic', async () => {
  const r = await page.evaluate(async () => {
    const out = {};
    const mic = document.getElementById('nc_chatMicBtn');
    out.hasMic = !!mic;
    if (!mic) return out;
    // _wireVoiceUI stamps this on whatever button it bound, so it is direct evidence
    // that New Chat's mic -- not the other screen's -- carries the listener.
    out.micWired = mic.dataset.wired === '1';
    out.cancelWired = (document.getElementById('nc_chatVoiceCancel') || {}).dataset?.wired === '1';
    out.sendWired = (document.getElementById('nc_chatVoiceSend') || {}).dataset?.wired === '1';
    // ...and the recording bar it will drive belongs to this screen.
    out.recorderHere = !!document.getElementById('nc_chatVoiceRecorder');
    out.timerHere = !!document.getElementById('nc_chatVoiceTimer');
    out.levelHere = !!document.getElementById('nc_chatVoiceLevel');
    out.onNewChat = !!document.querySelector('.screen[data-screen="newchat"].on');
    // Pressing it asks for a microphone. Headless Chromium has none, so the recorder
    // cannot be driven further here -- what is assertable is that the press reaches the
    // feature rather than falling on the floor.
    out.startExposed = typeof window._startVoiceRecording === 'function';
    out.stopExposed = typeof window._stopVoiceRecording === 'function';
    return out;
  });
  check('the voice recorder is wired to New Chat\'s own mic',
    r.hasMic && r.micWired && r.cancelWired && r.sendWired
      && r.recorderHere && r.timerHere && r.levelHere
      && r.onNewChat && r.startExposed && r.stopExposed,
    JSON.stringify(r));
});

await step('a voice note lands in the channel you recorded it in', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    const team = [...document.querySelectorAll('#nc_cardTeamsBody .nc_ch-item[data-nc-channel-id]')][0];
    if (team) { team.click(); await wait(1800); }
    const here = window.nc_activeChannelId;
    out.channel = here || null;
    // The two screens track their own channel. The send path used to read the OTHER
    // one's, so the note was filed against whatever old chat had open -- it sent, and
    // then appeared nowhere.
    out.otherScreenChannel = window.activeChannelId || null;
    out.channelsDiffer = !!here && here !== window.activeChannelId;
    if (!here) return out;
    const row = {
      id: 'm-voice-note-test', channel_id: here, author_id: window.giantSession.user.id,
      body: '', created_at: new Date().toISOString(),
      voice_note_url: 'data:audio/webm;base64,AAAA', voice_note_duration_ms: 4200
    };
    window.__mock.db.messages.push(row);
    window.__mock.emit('messages', 'INSERT', row);
    for (let i = 0; i < 30; i++) {
      await wait(200);
      if (document.querySelector('#nc_chatMsgs .msg-voice')) break;
    }
    out.viaRealtime = !!document.querySelector('#nc_chatMsgs .msg-voice');
    out.rowViaRealtime = !!document.querySelector('#nc_chatMsgsList [data-msg-id="m-voice-note-test"]');
    if (!out.viaRealtime) {
      // Switch away and back so the list reloads from the database rather than from the
      // realtime append -- that separates "not rendered at all" from "not rendered live".
      const other = [...document.querySelectorAll('#nc_cardTeamsBody .nc_ch-item[data-nc-channel-id]')][1];
      if (other) { other.click(); await wait(1600); }
      if (team) { team.click(); await wait(2200); }
      for (let i = 0; i < 30; i++) {
        await wait(200);
        if (document.querySelector('#nc_chatMsgs .msg-voice')) break;
      }
    }
    out.viaReload = !!document.querySelector('#nc_chatMsgs .msg-voice');
    const player = document.querySelector('#nc_chatMsgs .msg-voice');
    out.playerRendered = !!player;
    out.hasPlayButton = !!document.querySelector('#nc_chatMsgs .msg-voice-play');
    out.hasDuration = !!document.querySelector('#nc_chatMsgs .msg-voice-time');
    return out;
  });
  // Live, not after a reload. The original chat's realtime subscription is running
  // whether or not its screen is, so it appended each incoming message to its own hidden
  // list first and New Chat's document-wide dedupe then skipped it as a duplicate --
  // every realtime message was dropped, not just voice notes.
  check('a voice note lands in the channel you recorded it in',
    r.channelsDiffer && r.viaRealtime && r.rowViaRealtime
      && r.playerRendered && r.hasPlayButton && r.hasDuration,
    JSON.stringify(r));
});

// Runs late on purpose: opening a client's Vault selects that client for Management
// too -- they are one client either way -- so running it before the Management checks
// left them reading whichever client this one had opened.
await step('the Vault is the library, in a client thread and a team channel alike', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const look = async (rowSel) => {
      const row = document.querySelector(rowSel);
      if (!row) return null;
      row.click();
      await wait(1800);
      if (window.nc_switchChatSubtab) window.nc_switchChatSubtab('canvas');
      await wait(1800);
      const host = document.getElementById('nc_vaultHost');
      const txt = host ? (host.textContent || '') : '';
      return {
        cards: host ? host.querySelectorAll('[data-c3-vault-add-card]').length : -1,
        library: host ? host.querySelectorAll('[data-c3-lib-add], [data-c3-lib-kind], [data-c3-lib-pin]').length : -1,
        mentionsAddItem: /add item|add to the vault/i.test(txt)
      };
    };
    // Scoping, not just rendering: a team channel's vault must show that CHANNEL's items
    // and never a client's. This table holds encrypted credentials, so a leak between
    // scopes is the failure that matters, not a missing button. Seeded BEFORE any vault
    // is opened -- the library caches per scope, so a row added after the first look
    // would not be re-read.
    const db = window.__mock.db;
    db.chat2_client_library = db.chat2_client_library || [];
    const seedTeam = [...document.querySelectorAll('#nc_cardTeamsBody .nc_ch-item[data-nc-channel-id]')][0];
    if (seedTeam) {
      db.chat2_client_library.push({ id: 'lib-chan-1', channel_id: seedTeam.dataset.ncChannelId,
        client_id: null, kind: 'link', title: 'CHANNEL-SCOPED-ITEM', section: 'General',
        url: 'https://example.com', created_by: window.__mock.me, created_at: new Date().toISOString() });
      db.chat2_client_library.push({ id: 'lib-client-1', channel_id: null, client_id: 'c-5',
        kind: 'link', title: 'CLIENT-SCOPED-ITEM', section: 'General',
        url: 'https://example.com', created_by: window.__mock.me, created_at: new Date().toISOString() });
    }

    // A client row backed by a real client RECORD. Client conversations with no record
    // sort first in this card, and they have no client to hold a library -- they still
    // get the card vault, which is the open question, not the assertion here.
    const withRecord = [...document.querySelectorAll('#nc_cardClientsBody .nc_ch-item[data-nc-channel-id]')]
      .find(el => {
        const c = window.__mock.db.channels.find(x => x.id === el.dataset.ncChannelId);
        return c && c.client_id;
      });
    const out = {
      pickedClientChannel: withRecord ? withRecord.dataset.ncChannelId : null,
      onClient: withRecord ? await look('#nc_cardClientsBody .nc_ch-item[data-nc-channel-id="' + withRecord.dataset.ncChannelId + '"]') : null,
      onTeam: await look('#nc_cardTeamsBody .nc_ch-item[data-nc-channel-id]')
    };
    const txt = (document.getElementById('nc_vaultHost') || {}).textContent || '';
    out.teamSeesOwnItem = txt.includes('CHANNEL-SCOPED-ITEM');
    out.teamLeaksClientItem = txt.includes('CLIENT-SCOPED-ITEM');
    if (window.nc_switchChatSubtab) window.nc_switchChatSubtab('messages');
    await wait(600);
    return out;
  });
  // The Vault is the library in EVERY conversation now. On a client thread it is that
  // client's shelf, shared across its departments; anywhere else it is that channel's
  // own, which 20260825180000 made possible by letting a library row hang off a channel
  // instead of a client -- exactly one of the two, enforced by a CHECK. The card vault
  // it replaced is gone rather than left unreachable.
  check('the Vault is the library, in a client thread and a team channel alike',
    !!r.onClient && !!r.onTeam
      && r.onClient.library > 0 && r.onClient.cards === 0
      && r.onTeam.library > 0 && r.onTeam.cards === 0
      && r.teamSeesOwnItem === true && r.teamLeaksClientItem === false,
    JSON.stringify(r));
});

await step('drag-drop and paste are bound to New Chat, not the original', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    const team = [...document.querySelectorAll('#nc_cardTeamsBody .nc_ch-item[data-nc-channel-id]')][0];
    if (team) { team.click(); await wait(1800); }
    // The drop listeners must be on THIS screen's main, not the other one's.
    const mine = document.querySelector('.screen[data-screen="newchat"]');
    out.hasOwnMain = !!mine;
    out.pasteGuardScreen = !!document.querySelector('.screen[data-screen="newchat"].on');
    if (!mine) return out;

    const file = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const before = document.querySelectorAll('#nc_chatAttachRow [data-att], #nc_chatAttachRow > *').length;
    mine.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    mine.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await wait(1200);
    out.channelAttachments =
      document.querySelectorAll('#nc_chatAttachRow [data-att], #nc_chatAttachRow > *').length - before;

    // ...and a paste, which used to return immediately because it asked whether the
    // ORIGINAL chat screen was on.
    const cd = new DataTransfer();
    cd.items.add(file);
    document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: cd }));
    await wait(1200);
    out.afterPaste =
      document.querySelectorAll('#nc_chatAttachRow [data-att], #nc_chatAttachRow > *').length - before;
    return out;
  });
  // What this proves is that the listeners are on THIS screen and the paste guard tests
  // THIS screen -- both of which named the original chat before, so a drop or a paste in
  // Chat did nothing at all. It does NOT prove a file reaches the composer: the attach
  // row's markup is not asserted here, and claiming otherwise would be the overclaiming
  // this branch keeps relearning.
  check('drag-drop and paste are bound to New Chat, not the original',
    r.hasOwnMain && r.pasteGuardScreen, JSON.stringify(r));
});

await step('a department tab opens that thread, it does not make a channel', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const db = window.__mock.db;
    const out = {};
    // A client that HAS an seo channel, so clicking SEO must open it, never create one.
    const seo = db.channels.find(c => c.kind === 'client_dept' && c.department === 'seo' && c.client_id);
    if (!seo) return { noFixture: true };
    out.clientId = seo.client_id;
    const gen = db.channels.find(c => c.kind === 'client_dept' && c.client_id === seo.client_id
      && (c.department || 'general') === 'general');
    if (!gen) return { noGeneral: true };
    if (window.nc_switchChannel) await window.nc_switchChannel(gen.id);
    await wait(2000);

    // The in-memory list is emptied of that department first: this is exactly the state
    // that made the strip create a duplicate -- the channel exists, the client just has
    // not loaded it yet.
    const before = db.channels.length;
    const tab = [...document.querySelectorAll('#nc_deptStrip [data-nc-dept], .nc_dept-strip [data-nc-dept]')]
      .find(e => e.dataset.ncDept === 'seo');
    out.foundTab = !!tab;
    if (!tab) return out;
    tab.click();
    await wait(2500);
    out.created = db.channels.length - before;
    out.landedOn = window.nc_activeChannelId;
    out.openedTheExistingOne = window.nc_activeChannelId === seo.id;
    return out;
  });
  check('a department tab opens that thread, it does not make a channel',
    r.foundTab && r.created === 0 && r.openedTheExistingOne, JSON.stringify(r));
});

await step('clicking your profile opens the status menu, and it saves', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    const person = document.getElementById('hdrPerson');
    out.hasPerson = !!person;
    if (!person) return out;
    const menu = document.getElementById('statusMenu');
    out.menuInsidePerson = !!(menu && person.contains(menu));
    // It used to be anchored to `.sidebar-foot .who`, which is moved into the header at
    // boot -- so the trigger was null, the block bailed, and this click did nothing.
    person.click();
    await wait(500);
    // On screen, not merely class="on". The menu opens UPWARD by default -- it used to
    // hang off the sidebar footer -- so anchored in the top bar it rendered above the
    // window and clicking your profile appeared to do nothing. Asserting the class is
    // exactly the mistake that shipped it.
    const seen = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 40) return false;
      if (r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth) return false;
      return typeof el.checkVisibility === 'function'
        ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true;
    };
    out.hasOnClass = !!menu && menu.classList.contains('on');
    out.rect = menu ? (() => { const r = menu.getBoundingClientRect();
      return Math.round(r.top) + ',' + Math.round(r.left) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); })() : null;
    out.opensOnClick = seen(menu);
    if (!out.opensOnClick) return out;

    // A preset writes it down. It used to change a dot on your own screen and nothing else.
    const writesBefore = window.__mock.log.writes.filter(w => w.startsWith('profiles.update')).length;
    menu.querySelector('[data-status="lunch"]').click();
    await wait(1200);
    out.presetWrote = window.__mock.log.writes.filter(w => w.startsWith('profiles.update')).length > writesBefore;
    const me = window.__mock.db.profiles.find(p => p.id === window.__mock.me);
    out.savedKey = me && me.status_key;
    out.savedEmoji = me && me.status_emoji;
    out.labelShows = (document.getElementById('userStatusLabel') || {}).textContent || '';

    // ...and a custom one, with a clear-after.
    person.click(); await wait(400);
    document.getElementById('statusMenuCustom').click();
    await wait(600);
    const modal = document.getElementById('statusCustomModal');
    out.modalOpens = !!modal && modal.classList.contains('on');
    if (!out.modalOpens) return out;
    document.getElementById('statusEmojiInput').value = '🚀';
    document.getElementById('statusTextInput').value = 'shipping chat';
    document.getElementById('statusClearAfter').value = '60';
    document.getElementById('statusCustomSave').click();
    await wait(1200);
    const me2 = window.__mock.db.profiles.find(p => p.id === window.__mock.me);
    out.customText = me2 && me2.status_text;
    out.customEmoji = me2 && me2.status_emoji;
    out.hasExpiry = !!(me2 && me2.status_expires_at);
    out.labelAfter = (document.getElementById('userStatusLabel') || {}).textContent || '';

    // An expired status reads as no status at all.
    me2.status_expires_at = new Date(Date.now() - 60000).toISOString();
    Object.assign(window.giantCurrentProfile, me2);
    if (window.giantPaintMyStatus) window.giantPaintMyStatus();
    await wait(300);
    out.expiredHidden = !/shipping chat/.test((document.getElementById('userStatusLabel') || {}).textContent || '');
    return out;
  });
  check('clicking your profile opens the status menu, and it saves',
    r.hasPerson && r.menuInsidePerson && r.opensOnClick
      && r.presetWrote && r.savedKey === 'lunch' && r.savedEmoji === '🍱'
      && r.modalOpens && r.customText === 'shipping chat' && r.customEmoji === '🚀'
      && r.hasExpiry && /shipping chat/.test(r.labelAfter) && r.expiredHidden,
    JSON.stringify(r));
});

await step('deactivated people are filtered by default, everywhere', async () => {
  const r = await page.evaluate(async () => {
    const db = window.__mock.db;
    const dead = db.profiles.filter(p => p.deactivated_at);
    const out = { deactivatedInFixture: dead.length };
    if (!dead.length) return out;
    const deadId = dead[0].id;
    const sb = window.giantSupabase;

    // 1. A plain read of profiles -- the shape 78 places in this file use -- must not
    //    return them, without that query having asked for anything.
    const plain = await sb.from('profiles').select('id, full_name, deactivated_at');
    out.plainReturned = (plain.data || []).length;
    out.plainIncludesDeactivated = (plain.data || []).some(p => p.id === deadId);

    // 2. Naming ids is RESOLVING someone already known, not offering a choice -- a
    //    message written by someone who has left must still show their name.
    const byId = await sb.from('profiles').select('id, full_name').in('id', [deadId]);
    out.resolvesById = (byId.data || []).some(p => p.id === deadId);
    const one = await sb.from('profiles').select('id, full_name').eq('id', deadId);
    out.resolvesByEq = (one.data || []).some(p => p.id === deadId);

    // 3. The explicit way out, for the screen that manages them.
    const all = await sb.profilesIncludingDeactivated().select('id, deactivated_at');
    out.optOutSeesThem = (all.data || []).some(p => p.id === deadId);

    // 4. A WRITE must never carry the filter. On an insert it is meaningless; on an
    //    update it would silently change which rows are written.
    const target = db.profiles.find(p => !p.deactivated_at && p.id !== window.__mock.me);
    const upd = await sb.from('profiles').update({ title: 'wrapper-write-test' }).eq('id', target.id);
    out.writeSucceeded = !upd.error;
    out.writeLanded = (db.profiles.find(p => p.id === target.id) || {}).title === 'wrapper-write-test';
    // ...including one that does not name an id.
    const upd2 = await sb.from('profiles').update({ title: 'by-email' }).eq('email', target.email);
    out.writeByOtherKeySucceeded = !upd2.error;

    // 5. It is installed on createClient, not on one client, because this file builds
    //    three of them -- so a client made fresh right now inherits it too.
    const fresh = window.supabase.createClient('https://x.supabase.co', 'anon-key');
    const freshRead = await fresh.from('profiles').select('id');
    out.freshClientFiltered = !(freshRead.data || []).some(p => p.id === deadId);
    out.freshHasOptOut = typeof fresh.profilesIncludingDeactivated === 'function';

    // 6. And the filter must not have broken ordinary reads of other tables.
    const chans = await sb.from('channels').select('id').limit(3);
    out.otherTablesFine = Array.isArray(chans.data) && chans.data.length > 0;
    return out;
  });
  check('deactivated people are filtered by default, everywhere',
    r.deactivatedInFixture > 0
      && r.plainReturned > 0 && r.plainIncludesDeactivated === false
      && r.resolvesById === true && r.resolvesByEq === true
      && r.optOutSeesThem === true && r.otherTablesFine === true
      && r.writeSucceeded === true && r.writeLanded === true
      && r.writeByOtherKeySucceeded === true
      && r.freshClientFiltered === true && r.freshHasOptOut === true,
    JSON.stringify(r));
});

await step('the jump box is a quick switcher: type, see matches, Enter to go', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const inp = document.getElementById('nc_chatJumpToInput');
    const out = { hasInput: !!inp };
    if (!inp) return out;
    const type = async (t) => {
      inp.value = t;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(500);
    };
    const panel = () => document.getElementById('nc_jumpResults');
    const rows = () => panel() ? [...panel().querySelectorAll('.nc_jump-row')] : [];
    const seen = (el) => {
      if (!el || el.style.display === 'none') return false;
      const rc = el.getBoundingClientRect();
      return rc.width > 80 && rc.height > 20 && rc.top >= 0 && rc.bottom <= window.innerHeight + 400;
    };

    // A CHANNEL by name
    await type('general');
    out.panelShows = seen(panel());
    out.channelRows = rows().length;
    out.everyRowMatches = rows().every(e => /general/i.test(e.textContent));
    // the panel sits directly under the box, not somewhere else on the page
    if (panel()) {
      const p = panel().getBoundingClientRect(), b = inp.getBoundingClientRect();
      out.gapUnderBox = Math.round(p.top - b.bottom);
    }

    // A PERSON by name
    const person = window.__mock.db.profiles.find(p => !p.deactivated_at && p.full_name && p.id !== window.__mock.me);
    await type((person.full_name || '').split(' ')[0]);
    out.personRows = rows().length;
    out.labelsPersonKind = rows().some(e => /person|direct|group/i.test(e.textContent));

    // A CLIENT by name
    const client = window.__mock.db.clients.find(c => c.status !== 'churned');
    await type(client.name.split(' ')[0]);
    out.clientRows = rows().length;
    out.labelsClientKind = rows().some(e => /client/i.test(e.textContent));

    // Enter routes you there, and the box clears itself
    const before = window.nc_activeChannelId;
    await type('general');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await wait(2000);
    out.navigated = window.nc_activeChannelId !== before || !!window.nc_activeChannelId;
    out.closedAfterGo = !seen(panel());
    out.boxCleared = inp.value === '';

    // Nothing matching says so
    await type('zzzz-no-such-thing');
    out.emptyState = /nothing matches/i.test((panel() || {}).textContent || '');

    // Escape closes it
    await type('general');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wait(400);
    out.escapeCloses = !seen(panel());
    return out;
  });
  check('the jump box is a quick switcher: type, see matches, Enter to go',
    r.hasInput && r.panelShows && r.channelRows > 0 && r.everyRowMatches
      && r.gapUnderBox >= 0 && r.gapUnderBox < 40
      && r.personRows > 0 && r.labelsPersonKind
      && r.clientRows > 0 && r.labelsClientKind
      && r.navigated && r.closedAfterGo && r.boxCleared
      && r.emptyState && r.escapeCloses,
    JSON.stringify(r));
});

await step('scheduling a message writes exactly one row', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const db = window.__mock.db;
    db.scheduled_messages = db.scheduled_messages || [];
    const out = {};
    const team = [...document.querySelectorAll('#nc_cardTeamsBody .nc_ch-item[data-nc-channel-id]')][0];
    if (team) { team.click(); await wait(1800); }
    out.here = window.nc_activeChannelId;
    // The other screen has its own open channel, and its module listens to the same
    // modal. That is the whole bug: one click, two writes, two different channels.
    out.otherScreenChannel = window.activeChannelId || null;

    const input = document.getElementById('nc_chatInput');
    input.value = 'scheduled once, not twice';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const before = db.scheduled_messages.length;
    document.getElementById('nc_chatScheduleBtn')?.click();
    await wait(600);
    // The CUSTOM path, not a preset. The preset buttons are rebuilt by whichever module
    // opened the popover, which destroys the other module's listeners and hides the bug
    // by accident. #scheduleMsgCustomBtn is never rebuilt, so both modules' listeners sit
    // on it and one click writes twice.
    const custom = document.getElementById('scheduleCustomTimeBtn')
      || document.querySelector('#schedulePopover [id*="ustom"]');
    out.presetFound = !!document.querySelector('#schedulePopover .schedule-preset');
    out.customEntryFound = !!custom;
    if (!custom) return out;
    custom.click();
    await wait(700);
    // Pick a time that is definitely in the future. combinedDate() reads the picker's
    // own state, which starts at roughly NOW, so clicking Save without setting one is
    // rejected as "pick a time in the future" -- and the check then measured zero writes
    // and blamed the app. Late tonight, which is future for any run before 23:58.
    const timeInput = document.getElementById('scheduleTimeInput');
    if (timeInput) {
      timeInput.value = '11:59 pm';
      timeInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await wait(300);
    }
    out.timeSet = timeInput ? timeInput.value : null;
    const saveBtn = document.getElementById('scheduleMsgCustomBtn');
    out.saveFound = !!saveBtn;
    if (!saveBtn) return out;
    saveBtn.click();
    for (let i = 0; i < 40; i++) {
      await wait(200);
      if (db.scheduled_messages.length > before) break;
    }
    await wait(1200);            // long enough for a second write to land if one is coming
    const made = db.scheduled_messages.slice(before);
    out.rowsWritten = made.length;
    out.channels = [...new Set(made.map(m => m.channel_id))];
    out.allInThisChannel = made.every(m => m.channel_id === out.here);
    return out;
  });
  check('scheduling a message writes exactly one row',
    r.customEntryFound && r.saveFound && r.rowsWritten === 1
      && r.allInThisChannel && r.channels.length === 1,
    JSON.stringify(r));
});

await step('scheduling from inside a thread also writes exactly one row', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const db = window.__mock.db;
    db.scheduled_messages = db.scheduled_messages || [];
    const out = {};
    const team = [...document.querySelectorAll('#nc_cardTeamsBody .nc_ch-item[data-nc-channel-id]')][0];
    if (team) { team.click(); await wait(1800); }
    out.channel = window.nc_activeChannelId;

    // Open a thread on a message, which is where it was reported from.
    const row = [...document.querySelectorAll('#nc_chatMsgs .nc_msg[data-msg-id]')].pop();
    if (!row) return { noMessage: true };
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await wait(300);
    row.querySelector('.nc_msg-reply-btn')?.click();
    await wait(1800);
    const tInput = document.getElementById('nc_threadInput');
    out.threadOpen = !!tInput && !!tInput.offsetParent;
    if (!tInput) return out;
    tInput.value = 'scheduled from a thread';
    tInput.dispatchEvent(new Event('input', { bubbles: true }));

    document.querySelectorAll('.toast, [class*="toast"]').forEach(t => t.remove());
    const before = db.scheduled_messages.length;
    document.getElementById('nc_threadScheduleBtn')?.click();
    await wait(700);
    const custom = document.getElementById('scheduleCustomTimeBtn');
    out.customFound = !!custom;
    if (!custom) return out;
    custom.click();
    await wait(700);
    const timeInput = document.getElementById('scheduleTimeInput');
    if (timeInput) {
      timeInput.value = '11:59 pm';
      timeInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await wait(300);
    }
    document.getElementById('scheduleMsgCustomBtn')?.click();
    for (let i = 0; i < 40; i++) {
      await wait(200);
      if (db.scheduled_messages.length > before) break;
    }
    await wait(1400);              // long enough for a second write to land
    const made = db.scheduled_messages.slice(before);
    out.rowsWritten = made.length;
    out.channels = [...new Set(made.map(m => m.channel_id))];
    out.parents = [...new Set(made.map(m => m.parent_id || null))];
    // Two toasts is what a person sees when two handlers ran.
    out.toasts = document.querySelectorAll('.toast, [class*="toast"]').length;
    return out;
  });
  check('scheduling from inside a thread also writes exactly one row',
    r.threadOpen && r.customFound && r.rowsWritten === 1
      && r.channels.length === 1 && r.channels[0] === r.channel
      && r.parents.length === 1 && r.parents[0] !== null,
    JSON.stringify(r));
});

await step('a Needs you row lands on the message that put it there', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    const db = window.__mock.db;
    // A mention far enough back that the channel's opening page of 50 will not contain
    // it -- which is the case that used to silently do nothing.
    const CH = 'ch-cd-seo-8';
    const inCh = db.messages.filter(m => m.channel_id === CH && !m.parent_id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    out.channelSize = inCh.length;
    if (inCh.length < 70) return out;
    const deepAt = new Date(new Date(inCh[70].created_at).getTime() - 60000).toISOString();
    db.messages.push({ id: 'm-deep-mention', channel_id: CH, author_id: 'u-3',
      body: '@Nishchay can you look at this one please', created_at: deepAt, parent_id: null,
      reply_count: 0, flagged: false, edited_at: null, pinned_at: null, pinned_by: null,
      voice_note_url: null, voice_note_duration_ms: null });
    // and a mention that is a reply inside a thread, which the timeline never renders
    const CH2 = 'ch-cd-seo-9';
    const in2 = db.messages.filter(m => m.channel_id === CH2 && !m.parent_id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const parent = in2[40];
    parent.reply_count = (parent.reply_count || 0) + 2;
    const base = new Date(parent.created_at).getTime();
    db.messages.push({ id: 'm-thr-a', channel_id: CH2, author_id: 'u-4', body: 'Another reply',
      created_at: new Date(base + 60000).toISOString(), parent_id: parent.id, reply_count: 0,
      flagged: false, edited_at: null, pinned_at: null, pinned_by: null,
      voice_note_url: null, voice_note_duration_ms: null });
    db.messages.push({ id: 'm-thr-b', channel_id: CH2, author_id: 'u-4',
      body: '@Nishchay please review the last point',
      created_at: new Date(base + 120000).toISOString(), parent_id: parent.id, reply_count: 0,
      flagged: false, edited_at: null, pinned_at: null, pinned_by: null,
      voice_note_url: null, voice_note_duration_ms: null });

    if (window.nc_refreshNeedsYou) await window.nc_refreshNeedsYou(true);
    await wait(2500);
    const body = document.getElementById('nc_cardNeedsBody');
    if (!body) return out;
    if (getComputedStyle(body).display === 'none') {
      const head = body.closest('.nc_navcard').querySelector('.nc_navcard-head');
      if (head) { head.click(); await wait(500); }
    }
    // The row must be pointed at the mention, not at whatever arrived most recently --
    // being sent to the newest message is indistinguishable from not jumping at all.
    const t1 = (window.__ncNeedTargets || {})[CH];
    out.target1 = t1 ? t1.id : null;
    const t2 = (window.__ncNeedTargets || {})[CH2];
    out.target2 = t2 ? t2.id : null;
    out.target2Parent = t2 ? t2.parentId : null;

    const land = async (row, id) => {
      row.click();
      let sawId = null;
      for (let i = 0; i < 90; i++) {           // ~13s: switch, page back, then land
        await wait(150);
        const hit = [...document.querySelectorAll('.nc_msg[data-msg-id]')].find(e => e.style.outline);
        if (hit) { sawId = hit.dataset.msgId; break; }
      }
      await wait(700);
      const el = document.querySelector(`.nc_msg[data-msg-id="${id}"]`);
      const res = { highlighted: sawId };
      if (el) {
        const host = el.closest('[id$="MsgsList"]') ? el.closest('[id$="MsgsList"]').parentElement
                   : el.parentElement;
        const a = el.getBoundingClientRect(), b = host.getBoundingClientRect();
        res.rendered = true;
        res.onScreen = a.top < b.bottom - 8 && a.bottom > b.top + 8;
      }
      return res;
    };

    const row1 = body.querySelector(`[data-nc-channel-id="${CH}"]`);
    out.row1Found = !!row1;
    if (row1) out.case1 = await land(row1, 'm-deep-mention');

    const row2 = body.querySelector(`[data-nc-channel-id="${CH2}"]`);
    out.row2Found = !!row2;
    if (row2) {
      out.case2 = await land(row2, 'm-thr-b');
      const panel = document.getElementById('nc_threadPanel') || document.querySelector('.nc_thread-panel');
      out.threadOpen = !!(panel && getComputedStyle(panel).display !== 'none');
    }
    return out;
  });
  check('a Needs you row lands on the message that put it there',
    r.target1 === 'm-deep-mention' && r.row1Found
      && r.case1 && r.case1.highlighted === 'm-deep-mention' && r.case1.rendered && r.case1.onScreen
      && r.target2 === 'm-thr-b' && r.target2Parent && r.row2Found
      && r.case2 && r.case2.highlighted === 'm-thr-b' && r.case2.onScreen,
    JSON.stringify(r));
});

await step('a notification deep link opens Chat, not the archive', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    out.hasJump = typeof window.jumpToChatMessage;
    if (out.hasJump !== 'function') return out;
    // The previous check's highlight is still on screen and would be mistaken for this
    // one's landing.
    document.querySelectorAll('[data-msg-id]').forEach(e => { e.style.outline = ''; });
    const CH = 'ch-cd-seo-10';
    const db = window.__mock.db;
    const inCh = db.messages.filter(m => m.channel_id === CH && !m.parent_id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (inCh.length < 70) return out;
    db.messages.push({ id: 'm-bell-mention', channel_id: CH, author_id: 'u-3',
      body: '@Nishchay please check this',
      created_at: new Date(new Date(inCh[70].created_at).getTime() - 60000).toISOString(),
      parent_id: null, reply_count: 0, flagged: false, edited_at: null,
      pinned_at: null, pinned_by: null, voice_note_url: null, voice_note_duration_ms: null });
    // This is the call behind the bell, the Inbox and a missed push notification.
    window.jumpToChatMessage(CH, 'm-bell-mention');
    for (let i = 0; i < 110; i++) {
      await wait(150);
      const hit = [...document.querySelectorAll('.nc_msg[data-msg-id]')].find(e => e.style.outline);
      if (hit) { out.highlighted = hit.dataset.msgId; break; }
    }
    await wait(600);
    const on = document.querySelector('.screen.on');
    out.screen = on ? on.dataset.screen : null;     // "chat" is the archived Old Chat
    const el = document.querySelector('.nc_msg[data-msg-id="m-bell-mention"]');
    out.rendered = !!el;
    if (el) {
      const host = document.getElementById('nc_chatMsgsList').parentElement;
      const a = el.getBoundingClientRect(), b = host.getBoundingClientRect();
      out.onScreen = a.top < b.bottom - 8 && a.bottom > b.top + 8;
    }
    return out;
  });
  check('a notification deep link opens Chat, not the archive',
    r.screen === 'newchat' && r.rendered && r.onScreen && r.highlighted === 'm-bell-mention',
    JSON.stringify(r));
});

await step('a recording can be linked, shared publicly and deleted', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const vis = (el) => { if (!el) return false; const b = el.getBoundingClientRect();
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && b.width > 4 && b.height > 4; };
    const out = {};
    document.querySelectorAll('.nav-group-toggle').forEach(t => { if (t.classList.contains('nav-group-collapsed')) t.click(); });
    await wait(600);
    const nav = document.querySelector('.nav-item[data-screen="record"]');
    if (!nav) return out;
    nav.click(); await wait(2500);
    // Re-queried every time: changing visibility re-renders the grid, and a card captured
    // before that is a detached node whose clicks go nowhere.
    const card = (id) => document.querySelector(`.rec-card-item[data-id="${id}"]`);
    const cards = [...document.querySelectorAll('.rec-card-item')];
    out.cards = cards.length;
    if (!card('rec-1')) return out;
    // The two things the recorder screen never offered: a link, without opening a menu.
    out.copyOnEveryCard = cards.every(c => vis(c.querySelector('[data-act="copy"]')));
    out.shareOnEveryCard = cards.every(c => vis(c.querySelector('[data-act="shareopts"]')));

    card('rec-1').querySelector('[data-act="copy"]').click(); await wait(600);
    out.copiedWorkspace = await navigator.clipboard.readText().catch(() => 'ERR');

    card('rec-1').querySelector('[data-act="shareopts"]').click(); await wait(700);
    out.dialogOpen = vis(document.getElementById('recShareBox'));
    out.dialogUrl = (document.getElementById('recShareUrl') || {}).value;
    const pub = [...document.querySelectorAll('input[name="recVis"]')].find(x => x.value === 'public');
    out.bothOptionsOffered = [...document.querySelectorAll('input[name="recVis"]')].length === 2;
    pub.click(); await wait(900);
    out.urlWentPublic = (document.getElementById('recShareUrl') || {}).value;
    out.rowVisibility = (window.__mock.db.recordings.find(x => x.id === 'rec-1') || {}).visibility;
    document.getElementById('recShareCopy').click(); await wait(500);
    out.copiedPublic = await navigator.clipboard.readText().catch(() => 'ERR');
    document.getElementById('recShareClose').click(); await wait(300);
    out.dialogClosed = !document.getElementById('recShareOverlay');

    // Someone else's recording: still linkable, but not yours to make public.
    card('rec-2').querySelector('[data-act="shareopts"]').click(); await wait(800);
    out.otherRadios = [...document.querySelectorAll('input[name="recVis"]')].map(x => x.value + (x.disabled ? ':disabled' : ''));
    out.otherUrlIsPublicPage = /\/rec\//.test((document.getElementById('recShareUrl') || {}).value || '');
    document.getElementById('recShareClose').click(); await wait(300);

    // Delete takes the video with it -- a row on its own leaves a file nobody can find.
    const before = window.__mock.db.recordings.length;
    card('rec-1').querySelector('[data-act="more"]').click(); await wait(400);
    out.menuOffersSharing = [...document.querySelectorAll('#recCardMenu [data-m]')].some(b => b.dataset.m === 'shareopts');
    [...document.querySelectorAll('#recCardMenu [data-m]')].find(b => b.dataset.m === 'del').click();
    await wait(800);
    const del = [...document.querySelectorAll('body > div button')].filter(b => b.textContent.trim() === 'Delete');
    out.confirmAsked = del.length > 0;
    if (del.length) { del[del.length - 1].click(); await wait(1600); }
    out.rowsRemoved = before - window.__mock.db.recordings.length;
    out.fileRemoved = (window.__mock.log.storage || []).some(x => x.startsWith('remove:recordings/'));
    return out;
  });
  // The canonical domain, not the origin serving the test. A recording link is pasted
  // into a chat and forwarded on, so it must not carry whichever host the sharer happened
  // to load -- the app also answers on the raw Netlify deploy URL. Asserting against
  // page.url() would pass on either, which is the bug it is supposed to catch.
  const origin = 'https://giant.reachgiant.com';
  check('a recording can be linked, shared publicly and deleted',
    r.cards >= 2 && r.copyOnEveryCard && r.shareOnEveryCard
      && r.copiedWorkspace === origin + '/?rec=rec-1'
      && r.dialogOpen && r.bothOptionsOffered
      && r.rowVisibility === 'public'
      && new RegExp('^' + origin + '/rec/[a-f0-9]{32}$').test(r.urlWentPublic || '')
      && r.copiedPublic === r.urlWentPublic && r.dialogClosed
      && r.otherRadios.join(',') === 'workspace:disabled,public:disabled'
      && r.otherUrlIsPublicPage && r.menuOffersSharing
      && r.confirmAsked && r.rowsRemoved === 1 && r.fileRemoved,
    JSON.stringify(r));
});

await step('history loads itself as you scroll up, without the view moving', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    document.querySelectorAll('.nav-group-toggle').forEach(t => {
      if (t.classList.contains('nav-group-collapsed')) t.click();
    });
    await wait(500);
    const chatNav = document.querySelector('.nav-item[data-screen="newchat"]');
    if (chatNav) { chatNav.click(); await wait(2500); }
    const close = document.getElementById('nc_threadClose');
    if (close) { close.click(); await wait(700); }
    const CH = 'ch-cd-seo-10';
    let opened = false;
    for (let i = 0; i < 30; i++) {
      const row = document.querySelector(`[data-nc-channel-id="${CH}"]`);
      if (row) { row.click(); opened = true; break; }
      await wait(300);
    }
    out.opened = opened;
    await wait(3000);
    const list = document.getElementById('nc_chatMsgsList');
    const sc = document.getElementById('nc_chatMsgs');
    if (!list || !sc) return out;
    out.listVisible = list.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      && sc.getBoundingClientRect().height > 50;
    if (!out.listVisible) return out;
    out.rendered = list.querySelectorAll('.nc_msg[data-msg-id]').length;
    // Nothing to click any more: reading upwards is the whole interaction.
    out.noButton = !document.getElementById('nc_chatLoadEarlierBtn');

    sc.scrollTop = Math.round(sc.scrollHeight * 0.5); await wait(800);
    const top = () => sc.getBoundingClientRect().top;
    const anchor = [...list.querySelectorAll('.nc_msg[data-msg-id]')]
      .find(m => m.getBoundingClientRect().bottom > top() + 4);
    out.anchorId = anchor ? anchor.dataset.msgId : null;
    if (!out.anchorId) return out;

    // Every frame: where the message sits, and where the reader has scrolled. A flicker is
    // the first moving while the second does not -- which is exactly what people saw.
    const samples = [];
    let stop = false;
    const sample = () => {
      if (stop) return;
      const el = list.querySelector(`.nc_msg[data-msg-id="${out.anchorId}"]`);
      if (el) samples.push([Math.round(el.getBoundingClientRect().top - top()), Math.round(sc.scrollTop)]);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    sc.scrollTop = 0;                       // read upwards; the page should arrive by itself
    await wait(4000);
    stop = true;

    const settled = [];
    let seenTop = false;
    for (const [y, st] of samples) { if (st <= 1) seenTop = true; if (seenTop) settled.push(y); }
    out.frames = settled.length;
    out.worstJumpWhileStill = settled.length ? Math.max(...settled.map(y => Math.abs(y - settled[0]))) : null;
    out.loadedByItself = list.querySelectorAll('.nc_msg[data-msg-id]').length > out.rendered;
    out.distanceFromBottom = Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight);
    out.jumpedToNewest = out.distanceFromBottom < 80;

    // and it keeps going, to the start of the conversation, still without a button
    for (let i = 0; i < 6; i++) { sc.scrollTop = 0; await wait(1800); }
    out.renderedAtEnd = list.querySelectorAll('.nc_msg[data-msg-id]').length;
    out.total = (window.__mock.db.messages || []).filter(m => m.channel_id === CH && !m.parent_id).length;
    out.topNote = (document.getElementById('nc_chatHistoryTop') || {}).textContent;
    return out;
  });
  check('history loads itself as you scroll up, without the view moving',
    r.opened && r.listVisible && r.noButton && r.loadedByItself && !r.jumpedToNewest
      && r.frames > 60 && r.worstJumpWhileStill === 0
      && r.renderedAtEnd === r.total
      && r.topNote === 'This is the beginning of the conversation',
    JSON.stringify(r));
});

await step('double-clicking a message opens the message, not the reaction bar', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    document.querySelectorAll('.nav-group-toggle').forEach(t => {
      if (t.classList.contains('nav-group-collapsed')) t.click();
    });
    await wait(500);
    const nav = document.querySelector('.nav-item[data-screen="newchat"]');
    if (nav) { nav.click(); await wait(2500); }
    const close = document.getElementById('nc_threadClose');
    if (close) { close.click(); await wait(700); }
    const list = document.getElementById('nc_chatMsgsList');
    if (!list) return out;
    const mine = [...list.querySelectorAll('[data-msg-body][data-msg-mine="1"]')];
    out.editableMessages = mine.length;
    if (!mine.length) return out;
    const body = mine[mine.length - 1];
    const root = body.closest('.nc_msg');
    out.msgId = body.dataset.msgId;

    // One reaction bar per message, and none of it inside the text. A bar in the body is
    // part of the message as far as innerText, editing and copying are concerned.
    out.barsOnMessage = root.querySelectorAll('.nc_msg-react-bar').length;
    out.barsInsideText = body.querySelectorAll('.nc_msg-react-bar').length;
    out.emojiNodesInText = body.querySelectorAll('.nc_msg-react-bar-emoji').length;
    out.textReads = body.innerText;

    body.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await wait(900);
    const ta = root.querySelector('textarea');
    out.editorOpened = !!ta;
    out.editorValue = ta ? ta.value : null;
    out.editorClean = ta ? !/👍|❤️|🔥|😂|🎉|\(edited\)/.test(ta.value) : null;
    if (ta) {
      ta.value = 'edited by the check';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await wait(1400);
    }
    out.saved = (window.__mock.db.messages.find(m => m.id === out.msgId) || {}).body;
    out.stillRendered = !!document.querySelector(`.nc_msg[data-msg-id="${out.msgId}"]`);
    return out;
  });
  check('double-clicking a message opens the message, not the reaction bar',
    r.editableMessages > 0 && r.barsOnMessage === 1 && r.barsInsideText === 0
      && r.emojiNodesInText === 0 && !/👍|❤️|🔥|😂|🎉/.test(r.textReads || '')
      && r.editorOpened && r.editorClean && r.editorValue === r.textReads
      && r.saved === 'edited by the check' && r.stillRendered,
    JSON.stringify(r));
});

await step('Needs you rows say who, what kind, how long and how much', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    document.querySelectorAll('.nav-group-toggle').forEach(t => {
      if (t.classList.contains('nav-group-collapsed')) t.click();
    });
    await wait(500);
    const nav = document.querySelector('.nav-item[data-screen="newchat"]');
    if (nav) { nav.click(); await wait(2000); }
    if (window.nc_refreshNeedsYou) await window.nc_refreshNeedsYou(true);
    await wait(2500);
    const body = document.getElementById('nc_cardNeedsBody');
    if (!body) return out;
    const card = body.closest('.nc_navcard');
    if (getComputedStyle(body).display === 'none') {
      card.querySelector('.nc_navcard-head').click(); await wait(700);
    }
    await wait(600);
    const rows = [...body.querySelectorAll('.nc_need-row')];
    out.rows = rows.length;
    if (!rows.length) return out;
    // One shape of row on the card. It used to be built two ways -- cloned sidebar rows
    // and hand-built fallbacks -- which could not agree on what a row shows.
    out.allRowsNewShape = body.querySelectorAll('.nc_ch-item').length === rows.length;
    out.headCountMatches = (card.querySelector('.nc_navcard-count') || {}).textContent === String(rows.length);
    out.everyRowHasTick = rows.every(r => !!r.querySelector('.nc_need-tick'));
    out.everyRowHasName = rows.every(r => (r.querySelector('.nc_need-name') || {}).textContent);
    out.everyRowHasStar = rows.every(r => !!r.querySelector('.nc_star'));
    out.everyRowHasAge = rows.every(r => /^(now|\d+[mhdw])$/.test((r.querySelector('.nc_need-age') || {}).textContent || ''));
    // One count per row, and it is the same circular badge every other card uses -- these
    // rows briefly had a second, differently-shaped number of their own.
    out.doubledCounts = rows.filter(r => r.querySelectorAll('.nc_ch-unread-badge, .nc_need-count').length > 1).length;
    out.badgeShape = rows.filter(r => r.querySelector('.nc_need-count')).length;
    // and nothing anywhere in Chat is a bare "#" any more
    const screen = document.querySelector('.screen[data-screen="newchat"]');
    out.bareHashes = [...screen.querySelectorAll('*')]
      .filter(e => e.children.length === 0 && e.textContent.trim() === '#').length;
    // A DM reads as the person, not as "Channel": the channel row has no name of its own.
    out.placeholderNames = rows.filter(r => /^(Channel|Direct message)$/.test(r.querySelector('.nc_need-name').textContent)).length;
    // Names on one line, and the row never wider than the card.
    out.anyNameWrapped = rows.some(r => r.querySelector('.nc_need-name').getBoundingClientRect().height > 22);
    out.anyRowOverflows = rows.some(r => r.scrollWidth > r.clientWidth + 2);
    // Ticks and stars each line up in one column.
    out.tickColumns = new Set(rows.map(r => Math.round(r.querySelector('.nc_need-tick').getBoundingClientRect().left))).size;
    out.starColumns = new Set(rows.map(r => Math.round(r.querySelector('.nc_star').getBoundingClientRect().right))).size;
    // The chip appears when there is room for it and steps aside when there is not,
    // because with it in, 41 of 50 names truncated at this sidebar's width.
    const width = body.clientWidth;
    out.narrowHidesChip = width < 320
      ? rows.every(r => r.querySelector('.nc_need-chip').getBoundingClientRect().width < 2)
      : rows.every(r => r.querySelector('.nc_need-chip').getBoundingClientRect().width > 2);
    out.chipTextsAreKinds = [...new Set(rows.map(r => r.querySelector('.nc_need-chip').textContent))]
      .every(t => ['Client', 'Team', 'DM', 'Group'].includes(t));

    // The tick clears a row without opening the conversation.
    const first = rows[0];
    const firstId = first.dataset.ncChannelId;
    const channelBefore = window.nc_activeChannelId;
    first.querySelector('.nc_need-tick').click();
    await wait(1600);
    out.tickCleared = !body.querySelector(`.nc_need-row[data-nc-channel-id="${firstId}"]`);
    out.tickDidNotNavigate = window.nc_activeChannelId === channelBefore;
    // and the row itself still opens its conversation.
    const next = body.querySelector('.nc_need-row');
    const nextId = next && next.dataset.ncChannelId;
    if (next) { next.click(); await wait(2500); }
    out.rowOpensConversation = window.nc_activeChannelId === nextId;
    return out;
  });
  check('Needs you rows say who, what kind, how long and how much',
    r.rows > 0 && r.allRowsNewShape && r.headCountMatches
      && r.everyRowHasTick && r.everyRowHasName && r.everyRowHasStar && r.everyRowHasAge
      && r.placeholderNames <= 2 && !r.anyNameWrapped && !r.anyRowOverflows
      && r.doubledCounts === 0 && r.badgeShape === 0 && r.bareHashes === 0
      && r.tickColumns === 1 && r.starColumns === 1
      && r.narrowHidesChip && r.chipTextsAreKinds
      && r.tickCleared && r.tickDidNotNavigate && r.rowOpensConversation,
    JSON.stringify(r));
});

await step('every card offers a star, in one column, without hovering', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    document.querySelectorAll('.nav-group-toggle').forEach(t => {
      if (t.classList.contains('nav-group-collapsed')) t.click();
    });
    await wait(500);
    const nav = document.querySelector('.nav-item[data-screen="newchat"]');
    if (nav) { nav.click(); await wait(2200); }
    const cards = { clients: 'nc_cardClientsBody', teams: 'nc_cardTeamsBody',
                    direct: 'nc_cardDirectBody', groups: 'nc_cardGroupsBody',
                    needs: 'nc_cardNeedsBody' };
    out.perCard = {};
    for (const [key, id] of Object.entries(cards)) {
      const body = document.getElementById(id);
      if (!body) continue;
      const head = body.closest('.nc_navcard').querySelector('.nc_navcard-head');
      if (head && getComputedStyle(body).display === 'none') { head.click(); await wait(700); }
      const rows = [...body.querySelectorAll('.nc_ch-item')];
      const starred = rows.filter(x => x.querySelector('.nc_star'));
      // Visible with no mouse anywhere near it: the star used to appear on hover only,
      // so you could not see what you had starred without running down the list.
      const visible = starred.filter(x => {
        const s = x.querySelector('.nc_star');
        return s.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
          && s.getBoundingClientRect().width > 4;
      });
      // Always in the slot before the row's "..." menu, and always the same slot: two
      // competing auto margins used to split the space and put every star at a different x.
      // Measured on screen, not in the DOM: the sequence is set by CSS `order` precisely
      // so that a badge painted later cannot land in the middle of the group.
      const beforeMenu = starred.filter(x => {
        const s = x.querySelector('.nc_star'), m = x.querySelector('.nc_row-menu');
        if (!m) return true;
        return s.getBoundingClientRect().right <= m.getBoundingClientRect().left + 1;
      });
      // One avatar on every row, the same size everywhere, and never a bare "#": a list
      // used to mix "#" for a channel, a coloured initial for a client, a photo for a
      // person and a glyph for a group, so nothing lined up.
      const avas = rows.map(x => x.querySelector('.nc_ava')).filter(Boolean);
      const sizes = new Set(avas.map(a => Math.round(a.getBoundingClientRect().width)
        + 'x' + Math.round(a.getBoundingClientRect().height)));
      out.perCard[key] = {
        rows: rows.length, withStar: starred.length, visible: visible.length,
        beforeMenu: beforeMenu.length,
        avatars: avas.length, avatarSizes: [...sizes],
        bareHash: rows.filter(x => {
          const a = x.querySelector('.nc_hash');
          return a && !a.classList.contains('nc_ava') && a.textContent.trim() === '#';
        }).length,
        columns: new Set(starred.map(x => Math.round(x.querySelector('.nc_star').getBoundingClientRect().right))).size
      };
    }
    // Every kind of conversation reaches the Starred card. It used to be filled from the
    // channel list alone, so starring a DM or a group wrote the row to the database and
    // then had nowhere to show it.
    out.starrable = {};
    for (const [label, id] of Object.entries({ team: 'nc_cardTeamsBody', client: 'nc_cardClientsBody',
                                               dm: 'nc_cardDirectBody', group: 'nc_cardGroupsBody' })) {
      const body = document.getElementById(id);
      if (!body) continue;
      const head = body.closest('.nc_navcard').querySelector('.nc_navcard-head');
      if (head && getComputedStyle(body).display === 'none') { head.click(); await wait(700); }
      const row = [...body.querySelectorAll('.nc_ch-item')].find(x => x.querySelector('.nc_star:not(.nc_star-on)'));
      if (!row) { out.starrable[label] = 'no unstarred row'; continue; }
      const cid = row.dataset.ncChannelId || row.dataset.ncDmChannelId;
      row.querySelector('.nc_star').click();
      await wait(1700);
      const sb = document.getElementById('nc_cardStarredBody');
      const sh = sb.closest('.nc_navcard').querySelector('.nc_navcard-head');
      if (sh && getComputedStyle(sb).display === 'none') { sh.click(); await wait(600); }
      out.starrable[label] = sb.querySelector(`[data-nc-channel-id="${cid}"],[data-nc-dm-channel-id="${cid}"]`)
        ? 'in starred' : 'MISSING';
    }

    // and it stars without opening the conversation
    const cb = document.getElementById('nc_cardClientsBody');
    // One that is not starred yet: the loop above has starred some, and clicking a set
    // star UNSETS it, which would take the row straight back out of the Starred card.
    const row = [...cb.querySelectorAll('.nc_ch-item')].find(x => x.querySelector('.nc_star:not(.nc_star-on)'));
    if (row) {
      const id = row.dataset.ncChannelId;
      const before = (window.__mock.db.channel_stars || []).length;
      const wasOpen = window.nc_activeChannelId;
      row.querySelector('.nc_star').click();
      await wait(1600);
      out.starWrote = (window.__mock.db.channel_stars || []).length !== before;
      out.starDidNotOpen = window.nc_activeChannelId === wasOpen;
      out.inStarredCard = !!document.querySelector(`#nc_cardStarredBody [data-nc-channel-id="${id}"]`);
    }
    return out;
  });
  // and starring works for every kind of conversation, not only the ones the Starred card
  // happened to be built from
  const kinds = r.starrable || {};
  const cards = Object.values(r.perCard || {});
  check('every card offers a star, in one column, without hovering',
    cards.length >= 4
      && cards.every(c => c.withStar > 0 && c.visible === c.withStar
                       && c.beforeMenu === c.withStar && c.columns === 1)
      // and one standard avatar throughout
      && cards.every(c => c.avatars === c.rows && c.bareHash === 0
                       && c.avatarSizes.length === 1 && c.avatarSizes[0] === '20x20')
      && ['team', 'client', 'dm', 'group'].every(k => kinds[k] === 'in starred')
      && r.starWrote && r.starDidNotOpen && r.inStarredCard,
    JSON.stringify(r));
});

await step('the chat sidebar can be resized, and remembers it', async () => {
  const before = await page.evaluate(() => {
    const nav = document.querySelector('.nav-item[data-screen="newchat"]');
    if (nav) nav.click();
    return null;
  });
  await page.waitForTimeout(2000);
  const width = () => page.evaluate(() =>
    Math.round(document.getElementById('nc_chatChannels').getBoundingClientRect().width));
  const r = {};
  r.start = await width();
  const handle = await page.$('.nc_col-resize[data-resize="channels"]');
  r.handleFound = !!handle;
  if (!handle) { check('the chat sidebar can be resized, and remembers it', false, JSON.stringify(r)); return; }
  const box = await handle.boundingBox();
  // A real drag, with a real mouse: the handle was in the markup for months with nothing
  // listening to it, which no assertion about the element's existence would have caught.
  await page.mouse.move(box.x + box.width / 2, box.y + 150);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 150, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  r.afterDrag = await width();
  r.saved = await page.evaluate(() => localStorage.getItem('giant_nc_sidebar_w'));
  // dragged past the minimum, it stops rather than collapsing
  const h2 = await page.$('.nc_col-resize[data-resize="channels"]');
  const b2 = await h2.boundingBox();
  await page.mouse.move(b2.x + b2.width / 2, b2.y + 150);
  await page.mouse.down();
  await page.mouse.move(b2.x + b2.width / 2 - 600, b2.y + 150, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  r.afterSquash = await width();
  // double-click puts it back
  await page.dblclick('.nc_col-resize[data-resize="channels"]');
  await page.waitForTimeout(500);
  r.afterReset = await width();
  r.savedAfterReset = await page.evaluate(() => localStorage.getItem('giant_nc_sidebar_w'));
  check('the chat sidebar can be resized, and remembers it',
    r.handleFound && r.start === 300
      && r.afterDrag > r.start + 80 && String(r.saved) === String(r.afterDrag)
      && r.afterSquash >= 205 && r.afterSquash <= 215
      && r.afterReset === 300 && r.savedAfterReset === '300',
    JSON.stringify(r));
});

await step('a long card scrolls, and still scrolls after a render and a search', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    document.querySelectorAll('.nav-group-toggle').forEach(t => {
      if (t.classList.contains('nav-group-collapsed')) t.click();
    });
    await wait(500);
    const nav = document.querySelector('.nav-item[data-screen="newchat"]');
    if (nav) { nav.click(); await wait(2200); }
    // Direct, not Clients: the Clients card lists only conversations now and comfortably
    // fits, and a card that fits proves nothing about scrolling.
    const card = document.querySelector('.nc_navcard[data-nccard="direct"]');
    const body = document.getElementById('nc_cardDirectBody');
    if (!card || !body) return out;
    if (getComputedStyle(body).display === 'none') {
      card.querySelector('.nc_navcard-head').click(); await wait(900);
    }
    // A card taller than the space it has must scroll INSIDE itself. It is laid out as a
    // flex column for that; when something resets its display the body takes its natural
    // height and overflow:hidden simply cuts the list off with no way to reach the rest.
    const state = (label) => {
      const cs = getComputedStyle(card);
      return { label, rows: body.querySelectorAll('.nc_ch-item').length,
        display: cs.display, canScroll: body.scrollHeight > body.clientHeight + 2,
        unreachable: Math.max(0, body.scrollHeight - body.clientHeight - (body.scrollHeight - body.clientHeight)) };
    };
    out.fresh = state('just opened');
    body.scrollTop = 300; await wait(250);
    out.scrolledTo = body.scrollTop;
    // a re-render must not undo it
    if (window.nc_refreshNeedsYou) await window.nc_refreshNeedsYou(true);
    await wait(2000);
    out.afterRender = state('after a re-render');
    // and neither must a search that hides cards and then clears
    const jump = document.getElementById('nc_chatJumpTo');
    if (jump) {
      jump.value = 'a'; jump.dispatchEvent(new Event('input', { bubbles: true })); await wait(1200);
      jump.value = ''; jump.dispatchEvent(new Event('input', { bubbles: true })); await wait(1400);
    }
    if (getComputedStyle(body).display === 'none') {
      card.querySelector('.nc_navcard-head').click(); await wait(900);
    }
    out.afterSearch = state('after a search and clear');
    out.heightLeftBehind = body.style.height || '';
    return out;
  });
  const ok = (s) => s && s.rows > 20 && s.display === 'flex' && s.canScroll;
  check('a long card scrolls, and still scrolls after a render and a search',
    ok(r.fresh) && ok(r.afterRender) && ok(r.afterSearch)
      && r.scrolledTo === 300 && r.heightLeftBehind === '',
    JSON.stringify(r));
});

await step('the Clients card lists conversations, and a client without one is still reachable', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    document.querySelectorAll('.nav-group-toggle').forEach(t => {
      if (t.classList.contains('nav-group-collapsed')) t.click();
    });
    await wait(500);
    const nav = document.querySelector('.nav-item[data-screen="newchat"]');
    if (nav) { nav.click(); await wait(2500); }
    const body = document.getElementById('nc_cardClientsBody');
    if (!body) return out;
    const card = body.closest('.nc_navcard');
    if (getComputedStyle(body).display === 'none') { card.querySelector('.nc_navcard-head').click(); await wait(900); }
    const db = window.__mock.db;
    const withChan = new Set(db.channels.filter(c => c.kind === 'client_dept' && c.client_id).map(c => c.client_id));
    out.clientsTotal = db.clients.filter(c => c.status !== 'churned').length;
    out.withConversation = withChan.size;
    out.rows = body.querySelectorAll('.nc_ch-item').length;
    // The card is the list of conversations you HAVE. A client sitting in it with nothing
    // behind it reads as one, and made a deleted conversation look like it had come back.
    out.placeholderRows = body.querySelectorAll('.nc_ch-item[data-client-id]:not([data-nc-channel-id])').length;
    // ...but a client without a conversation must still be reachable, or you could never
    // start one. The jump box lists every client by name.
    const none = db.clients.find(c => c.status !== 'churned' && !withChan.has(c.id));
    out.clientWithout = none ? none.name : null;
    if (!none) return out;
    const jump = document.getElementById('nc_chatJumpToInput');
    if (jump) { jump.value = none.name.slice(0, 6); jump.dispatchEvent(new Event('input', { bubbles: true })); await wait(1300); }
    const results = document.getElementById('nc_jumpResults');
    out.jumpFindsIt = !!(results && results.textContent.includes(none.name));
    const before = db.channels.length;
    const hit = results ? [...results.querySelectorAll('*')]
      .find(e => e.children.length === 0 && e.textContent.trim() === none.name) : null;
    if (hit) { hit.click(); await wait(2200); }
    out.createdNothing = db.channels.length - before === 0;
    out.offersStart = !!document.getElementById('nc_startConvo');
    return out;
  });
  check('the Clients card lists conversations, and a client without one is still reachable',
    r.rows > 0 && r.rows <= r.withConversation + 2 && r.placeholderRows === 0
      && r.clientsTotal > r.withConversation
      && r.jumpFindsIt && r.createdNothing && r.offersStart,
    JSON.stringify(r));
});

await step('clicking a client does not create a conversation; starting one does', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    document.querySelectorAll('.nav-group-toggle').forEach(t => {
      if (t.classList.contains('nav-group-collapsed')) t.click();
    });
    await wait(500);
    const nav = document.querySelector('.nav-item[data-screen="newchat"]');
    if (nav) { nav.click(); await wait(2500); }
    const body = document.getElementById('nc_cardClientsBody');
    if (!body) return out;
    const card = body.closest('.nc_navcard');
    if (getComputedStyle(body).display === 'none') { card.querySelector('.nc_navcard-head').click(); await wait(900); }
    const db = window.__mock.db;
    const before = (db.channels || []).length;
    // A client with no conversation is not in the card at all now, so it is reached by
    // name -- which is the path that used to create a channel just for looking.
    const withChan = new Set(db.channels.filter(c => c.kind === 'client_dept' && c.client_id)
      .map(c => c.client_id));
    const target = db.clients.find(c => c.status !== 'churned' && !withChan.has(c.id));
    const jump = document.getElementById('nc_chatJumpToInput');
    if (target && jump) {
      jump.value = target.name.slice(0, 6);
      jump.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(1300);
    }
    const results = document.getElementById('nc_jumpResults');
    const hit = results ? [...results.querySelectorAll('*')]
      .find(e => e.children.length === 0 && e.textContent.trim() === (target || {}).name) : null;
    out.foundPlaceholder = !!hit;
    if (!hit) return out;
    hit.click(); await wait(2200);
    // Nothing created. Clicking a client used to make the channel on the spot, which is
    // why deleting one appeared to do nothing -- the click you make to check it is gone
    // silently made another -- and why the workspace filled with empty channels.
    out.createdOnClick = (window.__mock.db.channels || []).length - before;
    out.startPanel = !!document.getElementById('nc_startConvo');
    out.topic = (document.getElementById('nc_chatHeadTopic') || {}).textContent;
    const btn = document.getElementById('nc_startConvoBtn');
    out.buttonShown = !!btn;
    if (btn) { btn.click(); await wait(3000); }
    out.createdOnStart = (window.__mock.db.channels || []).length - before;
    out.opened = !!window.nc_activeChannelId;
    return out;
  });
  check('clicking a client does not create a conversation; starting one does',
    r.foundPlaceholder && r.createdOnClick === 0 && r.startPanel
      && r.topic === 'No conversation yet' && r.buttonShown
      && r.createdOnStart === 1 && r.opened,
    JSON.stringify(r));
});

await step('the Chat nav badges are one group, not two odd shapes', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    // An earlier check leaves the app in focus mode, which hides the sidebar outright,
    // so this puts the layout back before measuring anything. Every number below is zero
    // otherwise, and a check that measures nothing passes for the wrong reason.
    out.focusWas = document.body.dataset.focus || '0';
    document.body.dataset.focus = '0';
    document.querySelectorAll('.sidebar').forEach(s => s.classList.remove('collapsed'));
    // The rail carries its group's name in data-navgroup-body and the toggle carries the
    // same name in data-navgroup; they are not siblings, so this pairs them by name. The
    // nav is an accordion, so open the one holding Chat rather than all of them.
    const chatRail = document.querySelector('.nav-rail[data-navgroup-body]:has(.nav-item[data-screen="newchat"])')
      || [...document.querySelectorAll('.nav-rail[data-navgroup-body]')]
           .find(r => r.querySelector('.nav-item[data-screen="newchat"]'));
    if (chatRail && chatRail.classList.contains('nav-rail-collapsed')) {
      const toggle = document.querySelector('.nav-group-toggle[data-navgroup="'
        + chatRail.dataset.navgroupBody + '"]');
      if (toggle) toggle.click();
    }
    await wait(900);
    const item = document.querySelector('.nav-item[data-screen="newchat"]');
    if (!item) return out;
    const ir = item.getBoundingClientRect();
    out.itemVisible = ir.width > 40;
    out.itemBox = Math.round(ir.width) + 'x' + Math.round(ir.height);
    const sb = document.querySelector('.sidebar');
    out.sidebarBox = sb ? Math.round(sb.getBoundingClientRect().width) + 'x'
      + Math.round(sb.getBoundingClientRect().height) : null;
    out.sidebarClass = sb ? sb.className : null;
    out.railClass = item.parentElement ? item.parentElement.className : null;
    out.railBox = item.parentElement
      ? Math.round(item.parentElement.getBoundingClientRect().width) + 'x'
        + Math.round(item.parentElement.getBoundingClientRect().height) : null;
    out.screenOn = (document.querySelector('.screen.on') || {}).dataset?.screen;
    const count = document.getElementById('nc_sidebarBadgeChat');
    if (count) { count.textContent = '36'; count.style.display = ''; }
    await wait(400);
    const badges = [...item.querySelectorAll('.badge')]
      .filter(b => b.getBoundingClientRect().width > 2);
    out.badges = badges.map(b => b.textContent.trim());
    const boxes = badges.map(b => b.getBoundingClientRect());
    const label0 = item.getBoundingClientRect();
    // One badge now that NEW has gone. What is left to check is that the unread count sits
    // where it should -- right of the label, on its centre line -- which is the half of
    // this that was never about the pairing.
    out.oneBadgePlaced = boxes.length === 1
      && boxes[0].left > label0.left + 40
      && Math.abs((boxes[0].top + boxes[0].height / 2) - (label0.top + label0.height / 2)) <= 1.5;
    if (badges.length < 2) return out;
    // Same height and same corner radius: they were 15px and 11px, which is what made
    // them read as two unrelated things stuck to the word rather than one group.
    out.heights = [...new Set(boxes.map(b => Math.round(b.height)))];
    out.radii = [...new Set(badges.map(b => getComputedStyle(b).borderRadius))];
    // Sitting together, not spread by the nav row's 11px gap.
    out.gap = Math.round(boxes[1].left - boxes[0].right);
    // and to the right of the label, on the same centre line
    const label = item.getBoundingClientRect();
    out.rightOfLabel = boxes[0].left > label.left + 40;
    out.centred = boxes.every(b =>
      Math.abs((b.top + b.height / 2) - (label.top + label.height / 2)) <= 1.5);
    return out;
  });
  check('the Chat unread badge sits right of the label, on its centre line',
    r.badges && r.badges.length === 1 && r.badges[0] === '36' && r.oneBadgePlaced,
    JSON.stringify(r));
});

await step('global search finds conversations by name, not only what was said in them', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    const db = window.__mock.db;
    const team = db.channels.find(c => c.kind === 'team_channel');
    const dm = db.channels.find(c => c.is_dm && !c.is_group);
    const stamp = (id, txt, who) => db.messages.push({ id: 'm-gs-' + Math.random().toString(36).slice(2, 8),
      channel_id: id, author_id: who, body: txt, created_at: new Date().toISOString(), parent_id: null,
      reply_count: 0, flagged: false, edited_at: null, pinned_at: null, pinned_by: null,
      voice_note_url: null, voice_note_duration_ms: null });
    stamp(team.id, 'quokka sighting in the team channel', 'u-2');
    stamp(dm.id, 'quokka sighting in a direct message', 'u-3');

    document.getElementById('globalSearchBox').click();
    await wait(700);
    const input = document.getElementById('cmdkInput');
    out.opened = !!input;
    if (!input) return out;
    const run = async (q) => {
      input.focus(); input.value = q;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(2600);
      const res = document.getElementById('cmdkResults');
      return (res ? res.innerText : '').split('\n').map(l => l.trim()).filter(Boolean);
    };
    // A channel BY NAME. The search only ever looked inside message bodies, so this was
    // findable only if somebody had typed its name in a message.
    const byName = await run(team.name.slice(0, 5));
    // The first SECTION, not the first line -- a row of result tabs sits above them now.
    const SECTIONS = ['CHATS', 'MESSAGES', 'TASKS', 'CLIENTS'];
    out.chatsSectionFirst = byName.filter(l => SECTIONS.includes(l))[0] === 'CHATS';
    out.findsChannelByName = byName.some(l => l === '#' + team.name);
    // Sections, in the order asked for, and the ones that were noise are gone.
    const all = await run('a');
    out.sectionOrder = all.filter(l => ['CHATS', 'MESSAGES', 'TASKS', 'CLIENTS', 'PEOPLE', 'INVOICES', 'EMAILS', 'CHAT & HUDDLES', 'CHAT 2.0'].includes(l));
    // A message in a DM used to be labelled "in #" -- a DM channel has no name.
    const byBody = await run('quokka');
    out.dmLabelled = byBody.some(l => /in\s+\S/.test(l) && !/in\s*#\s*$/.test(l));
    out.noEmptyHash = !byBody.some(l => /in #$/.test(l));
    // from: with a name that has spaces in it
    const filtered = await run('from:"Team Member 2" quokka');
    out.fromFiltered = filtered.filter(l => /quokka/.test(l)).length;
    out.fromFilterKeptOne = out.fromFiltered === 1;
    // and the filter buttons write the chip for you
    input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(400);
    document.querySelector('#cmdkFilters [data-cmdk-filter="from:"]').click();
    await wait(400);
    out.buttonWrote = input.value.trim();
    out.hint = (document.getElementById('cmdkFilterHint') || {}).textContent;
    document.getElementById('cmdkOverlay').style.display = 'none';
    return out;
  });
  check('global search finds conversations by name, not only what was said in them',
    r.opened && r.chatsSectionFirst && r.findsChannelByName
      && r.sectionOrder.join(',') === 'CHATS,MESSAGES,TASKS,CLIENTS'
      && r.dmLabelled && r.noEmptyHash
      && r.fromFilterKeptOne
      && r.buttonWrote === 'from:' && /from whom/.test(r.hint || ''),
    JSON.stringify(r));
});

await step('the sidebar search finds messages, with names still first', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    const nav = document.querySelector('.nav-item[data-screen="newchat"]');
    if (nav) { nav.click(); await wait(2200); }
    const db = window.__mock.db;
    const team = db.channels.find(c => c.kind === 'team_channel');
    db.messages.push({ id: 'm-jump-probe', channel_id: team.id, author_id: 'u-3',
      body: 'pangolin migration notes', created_at: new Date().toISOString(), parent_id: null,
      reply_count: 0, flagged: false, edited_at: null, pinned_at: null, pinned_by: null,
      voice_note_url: null, voice_note_duration_ms: null });
    const input = document.getElementById('nc_chatJumpToInput');
    out.hasInput = !!input;
    if (!input) return out;
    input.value = 'pangolin';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(2600);
    const panel = document.getElementById('nc_jumpResults');
    const rows = [...panel.querySelectorAll('.nc_jump-row')];
    out.rows = rows.map(x => x.innerText.replace(/\n/g, ' | '));
    // The box next to the conversations could find the room but never a word said in it.
    const msgRow = rows.find(x => /pangolin/i.test(x.textContent));
    out.foundMessage = !!msgRow;
    out.saysWhoAndWhere = !!(msgRow && /in #/.test(msgRow.innerText));
    if (msgRow) {
      msgRow.click();
      for (let i = 0; i < 40; i++) {
        await wait(200);
        const el = document.querySelector('.nc_msg[data-msg-id="m-jump-probe"]');
        if (el && el.style.outline) { out.landedOnTheMessage = true; break; }
      }
    }
    // A name still comes first: the room you are looking for is usually the room.
    input.value = team.name.slice(0, 5);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(2200);
    const first = document.querySelector('#nc_jumpResults .nc_jump-row');
    out.firstIsAName = !!first && first.innerText.split('\n')[0].trim() === team.name;
    input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
    return out;
  });
  check('the sidebar search finds messages, with names still first',
    r.hasInput && r.foundMessage && r.saysWhoAndWhere
      && r.landedOnTheMessage && r.firstIsAName,
    JSON.stringify(r));
});

await step('typing in: or from: offers what you can filter by, and picking one applies it', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    const db = window.__mock.db;
    const team = db.channels.find(c => c.kind === 'team_channel');
    document.getElementById('globalSearchBox').click();
    await wait(700);
    const input = document.getElementById('cmdkInput');
    out.opened = !!input;
    if (!input) return out;
    const type = async (v) => {
      input.focus(); input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(2300);
    };
    // Half-typed chip: offer the conversations it could mean, rather than running a
    // search for a value that is not finished and answering "No results".
    await type('in:' + team.name.slice(0, 4));
    out.header = (document.querySelector('#cmdkResults div') || {}).textContent;
    out.suggestions = [...document.querySelectorAll('.cmdk-suggest')].map(x => x.innerText.split('\n')[0]);
    out.offersTheChannel = out.suggestions.some(l => l === '#' + team.name);
    out.enterHintOnFirst = /Enter/.test((document.querySelector('.cmdk-suggest') || {}).innerText || '');
    // Enter takes the first one and writes it into the box.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(2000);
    out.afterEnter = input.value.trim();
    // A person's name with a space in it, which the old parser could not carry at all.
    await type('from:Team Mem');
    out.peopleOffered = [...document.querySelectorAll('.cmdk-suggest')].map(x => x.innerText.split('\n')[0]);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(2400);
    out.afterPersonPick = input.value.trim();
    const picked = (out.peopleOffered[0] || '').trim();
    const lines = (document.getElementById('cmdkResults') || {}).innerText.split('\n').map(l => l.trim()).filter(Boolean);
    // and every result really is from that person. "Team Member 1" as a substring also
    // matches Team Member 10 through 19, so an exact name has to win.
    const subs = lines.filter(l => / in /.test(l));
    out.resultAuthors = [...new Set(subs.map(l => l.split(' in ')[0]))];
    out.onlyThatPerson = subs.length > 0 && out.resultAuthors.every(a => a === picked);
    document.getElementById('cmdkOverlay').style.display = 'none';
    return out;
  });
  check('typing in: or from: offers what you can filter by, and picking one applies it',
    r.opened && /which conversation/i.test(r.header || '')
      && r.offersTheChannel && r.enterHintOnFirst
      && /^in:\S+$/.test(r.afterEnter)
      && r.peopleOffered.length > 0
      && /^from:"[^"]+"$/.test(r.afterPersonPick)
      && r.onlyThatPerson,
    JSON.stringify(r));
});

await step('search: tabs with counts, recent searches, and a zero state that helps', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    try { localStorage.removeItem('giant_search_recent'); } catch (e) {}
    const db = window.__mock.db;
    const team = db.channels.find(c => c.kind === 'team_channel');
    db.messages.push({ id: 'm-tabs-1', channel_id: team.id, author_id: 'u-2',
      body: 'narwhal sighting logged', created_at: new Date().toISOString(), parent_id: null,
      reply_count: 0, flagged: false, edited_at: null, pinned_at: null, pinned_by: null,
      voice_note_url: null, voice_note_duration_ms: null });
    document.getElementById('globalSearchBox').click();
    await wait(700);
    const input = document.getElementById('cmdkInput');
    if (!input) return out;
    const type = async (v) => {
      input.focus(); input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(2200);
    };
    await type('narwhal');
    // Tabs carry the counts the search already returned -- no second round trip.
    const tabs = [...document.querySelectorAll('[data-cmdk-tab]')].map(b => b.innerText.replace(/\s+/g, ' ').trim());
    out.tabs = tabs;
    out.hasAllTab = tabs.some(t => /^All \d+/.test(t));
    out.hasMessagesTab = tabs.some(t => /^Messages \d+/.test(t));
    // Clicking one narrows to that section.
    const msgTab = [...document.querySelectorAll('[data-cmdk-tab]')].find(b => /^Messages/.test(b.innerText));
    if (msgTab) { msgTab.click(); await wait(2200); }
    const headers = (document.getElementById('cmdkResults') || {}).innerText
      .split('\n').map(l => l.trim()).filter(l => ['CHATS','MESSAGES','TASKS','CLIENTS'].includes(l));
    out.afterTabClick = headers;
    out.onlyMessages = headers.length === 1 && headers[0] === 'MESSAGES';
    // A search that found something is remembered, and offered when the box is emptied.
    await type('');
    out.recentShown = [...document.querySelectorAll('.cmdk-recent')].map(x => x.innerText.trim());
    out.remembersIt = out.recentShown.some(x => /narwhal/.test(x));
    // Zero results says what it looked for and offers to drop the narrowest part.
    // A COMPLETED chip: a query ending mid-chip correctly shows the picker instead of
    // running a search, which is what this asserted by accident the first time.
    await type('from:"Team Member 1" "a phrase that appears nowhere at all"');
    const zero = (document.getElementById('cmdkResults') || {}).innerText;
    out.zeroEchoesFilters = /Looking for/.test(zero);
    const drop = document.getElementById('cmdkDropNarrowest');
    out.offersToDrop = !!drop;
    if (drop) {
      out.dropLabel = drop.innerText.trim();
      drop.click(); await wait(2300);
      out.afterDrop = input.value.trim();
    }
    // and clearing empties the list
    await type('');
    const clear = document.getElementById('cmdkClearRecent');
    if (clear) { clear.click(); await wait(500); }
    out.recentAfterClear = [...document.querySelectorAll('.cmdk-recent')].length;
    document.getElementById('cmdkOverlay').style.display = 'none';
    return out;
  });
  check('search: tabs with counts, recent searches, and a zero state that helps',
    r.hasAllTab && r.hasMessagesTab && r.onlyMessages
      && r.remembersIt && r.recentAfterClear === 0
      && r.zeroEchoesFilters && r.offersToDrop
      && /a phrase that appears nowhere/.test(r.dropLabel || '')
      && !/a phrase that appears nowhere/.test(r.afterDrop || 'x'),
    JSON.stringify(r));
});

await step('search: a name typed without spaces, your own conversations, and the keyboard', async () => {
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    const db = window.__mock.db;
    const cl = db.clients.find(c => /\s/.test(c.name));
    const squashed = cl.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    out.client = cl.name; out.typed = squashed;
    const team = db.channels.find(c => c.kind === 'team_channel');
    for (let i = 0; i < 3; i++) db.messages.push({ id: 'm-kbd-' + i, channel_id: team.id,
      author_id: 'u-2', body: 'kiwi bird note ' + i, created_at: new Date().toISOString(),
      parent_id: null, reply_count: 0, flagged: false, edited_at: null, pinned_at: null,
      pinned_by: null, voice_note_url: null, voice_note_duration_ms: null });
    document.getElementById('globalSearchBox').click();
    await wait(700);
    const input = document.getElementById('cmdkInput');
    if (!input) return out;
    const type = async (v) => { input.focus(); input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true })); await wait(2300); };
    const text = () => (document.getElementById('cmdkResults') || {}).innerText || '';

    // "mangovans" is how people type "Mango Vans" and "mango-vans-seo". Matching the raw
    // string against the raw name finds neither.
    await type(squashed);
    out.findsChats = /CHATS/.test(text());
    out.findsTheConversation = text().includes(cl.name);

    // from: lists people by name. An email on every row is noise -- it is only worth the
    // line when two people share a name and it is the only thing telling them apart.
    await type('from:');
    const fromRows = [...document.querySelectorAll('.cmdk-suggest')].map(x => x.innerText);
    out.fromCount = fromRows.length;
    out.fromShowsNoEmails = !fromRows.some(x => /@/.test(x));
    // (Two people sharing a name still get their email as the tie-breaker. Not asserted
    // here: the directory is cached for a minute, so renaming a fixture mid-run changes
    // nothing and the assertion would pass without testing anything.)

    // An empty in: offers YOUR conversations, not whichever eight the database returned
    // first -- which is what made the list look arbitrary.
    await type('in:');
    const sugg = [...document.querySelectorAll('.cmdk-suggest')];
    out.suggestionCount = sugg.length;
    out.noStrangersOffered = !sugg.some(x => /not a member/.test(x.innerText));

    // The keyboard: the first result is already selected, arrows move, Enter opens.
    await type('kiwi');
    out.results = document.querySelectorAll('.cmdk-item').length;
    out.firstSelected = !!(document.querySelector('.cmdk-item') || {}).style?.background;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await wait(300);
    out.arrowMoves = !!([...document.querySelectorAll('.cmdk-item')][1] || {}).style?.background;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await wait(200);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(2500);
    out.enterClosedIt = (document.getElementById('cmdkOverlay') || {}).style.display !== 'flex';
    out.enterWentSomewhere = (document.querySelector('.screen.on') || {}).dataset?.screen;
    return out;
  });
  check('search: a name typed without spaces, your own conversations, and the keyboard',
    r.findsChats && r.findsTheConversation
      && r.suggestionCount > 0 && r.noStrangersOffered
      && r.fromCount > 0 && r.fromShowsNoEmails
      && r.results >= 3 && r.firstSelected && r.arrowMoves
      && r.enterClosedIt && r.enterWentSomewhere === 'newchat',
    JSON.stringify(r));
});

// Every failure in the app arrives through toast({type:'error'}), and most callers pass
// 'Could not save that: ' + error.message -- so what people read is a Postgres sentence
// written for whoever wrote the database. Translated at the one place they all pass
// through, with the original kept for the bug report, where it is actually useful.
await step('errors are readable, and can be reported in one click', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const f = window.giantFriendlyError;
    if (typeof f !== 'function') return { skipped: 'no translator' };
    const cases = {
      check: f('Could not delete that: new row for relation "chat2_inbox_actions" violates check constraint "chat2_inbox_actions_one_target"').text,
      missing: f("Could not save that order: Could not find the table 'public.project_prefs' in the schema cache").text,
      rls: f('Could not load: new row violates row-level security policy for table "tasks"').text,
      offline: f('Failed to fetch').text,
      expired: f('JWT expired').text,
      // already plain English: it must come through untouched
      plain: f('Your changes were saved').text,
    };
    const out = {
      // nothing a person reads should still contain the database's own vocabulary
      noJargon: !/relation |constraint|PGRST|schema cache|row-level security|JWT/i
        .test(Object.values(cases).join(' ')),
      keepsLead: /^Could not delete that/.test(cases.check),
      explainsMissingTable: /has not been set up/i.test(cases.missing),
      saysNotYourFault: /not something you did wrong/i.test(cases.check),
      startsCapitalised: /^[A-Z]/.test(cases.expired) && /^[A-Z]/.test(cases.offline),
      leavesPlainAlone: cases.plain === 'Your changes were saved',
    };

    document.querySelectorAll('.toast').forEach(e => e.remove());
    const db = window.__mock.db;
    db.reports = db.reports || [];
    if (!db.channels.some(c => c.name === 'giant-app'))
      db.channels.push({ id: 'ch-giantapp', name: 'giant-app', kind: 'team_channel',
                         is_dm: false, department: null, client_id: null });
    out.hasToastHost = !!document.getElementById('toastHost');
    // Toasts render into #toastHost, and by this point in the suite an earlier step has
    // removed it -- traced to harness cleanup running el.remove() over a NodeList, never to
    // app code. Put it back rather than skip: the behaviour under test is the toast, and a
    // check that quietly skips is a check that proves nothing.
    if (!out.hasToastHost) {
      const h = document.createElement('div');
      h.className = 'toast-host'; h.id = 'toastHost';
      document.getElementById('appView').appendChild(h);
      out.hostRestored = true;
    }
    toast({ type: 'error', message: 'Could not delete that: new row for relation "x" violates check constraint "y"' });
    for (let i = 0; i < 12 && !document.querySelector('.toast.error'); i++) await w(150);
    const et = document.querySelector('.toast.error');
    if (!et) return { ...out, skipped: 'no error toast appeared (host: ' + out.hasToastHost + ')' };
    out.errorOffersReport = !!et.querySelector('[data-report]');
    toast({ type: 'success', message: 'Saved' });
    await w(300);
    out.successOffersNone = !document.querySelector('.toast.success [data-report]');

    const before = { reports: db.reports.length, posts: db.messages.length };
    et.querySelector('[data-report]').click();
    await w(2200);
    out.reportWritten = db.reports.length - before.reports;
    out.reportIsBug = (db.reports[db.reports.length - 1] || {}).type === 'bug';
    out.reportKeepsTechnical = /check constraint/.test((db.reports[db.reports.length - 1] || {}).description || '');
    const posts = db.messages.filter(m => m.channel_id === 'ch-giantapp');
    out.postedToGiantApp = posts.length;
    out.mentionsTheDev = posts.some(m => /@Nishchay/.test(m.body || ''));
    out.thanks = /sent to the dev team/i.test(et.querySelector('.toast-body').textContent);
    document.querySelectorAll('.toast').forEach(e => e.remove());
    return out;
  });
  check('a database error becomes a sentence, keeping what the caller said',
    !r.skipped && r.noJargon && r.keepsLead && r.explainsMissingTable
      && r.saysNotYourFault && r.startsCapitalised && r.leavesPlainAlone, JSON.stringify(r));
  check('only errors offer Report, and pressing it files a bug and posts to #giant-app',
    !r.skipped && r.errorOffersReport && r.successOffersNone && r.reportWritten === 1
      && r.reportIsBug && r.reportKeepsTechnical && r.postedToGiantApp === 1
      && r.mentionsTheDev && r.thanks, JSON.stringify(r));
});

await step('the Pod System board adds up, and is manager-only', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const db = window.__mock.db;
    db.pods = [{ id: 'pod-1', name: 'Pod 1', leader_id: 'u-1', max_clients: 20,
                 opens_at: null, status: 'active', position: 0 }];
    db.pod_rates = [
      { id:'r-g1', service:'google_ads', tier:'standard', is_internal:false, amount_cents:20000, note:'$0–$10k ad spend' },
      { id:'r-g2', service:'google_ads', tier:'growth',   is_internal:false, amount_cents:25000, note:'$10k–$50k' },
      { id:'r-g3', service:'google_ads', tier:'advanced', is_internal:false, amount_cents:32500, note:'$50k+' },
      { id:'r-s1', service:'seo', tier:null, is_internal:false, amount_cents:30000, note:'Paying SEO client' },
      { id:'r-s2', service:'seo', tier:null, is_internal:true,  amount_cents:15000, note:'Internal project' }];
    const cls = db.clients.slice(0, 4);
    cls[0].mrr_cents = 150000; cls[1].mrr_cents = 200000; cls[2].mrr_cents = 250000; cls[3].mrr_cents = 0;
    cls[0].health = 'green'; cls[1].health = 'amber'; cls[2].health = 'red';
    // A client belongs to a pod because it has a pod_id, not because somebody happens to
    // hold one of its services — that is what the twenty is counted against.
    cls.forEach(x => { x.pod_id = 'pod-1'; });
    db.clients.forEach(x => { if (!cls.includes(x)) x.pod_id = null; });
    db.pod_assignments = [
      { id:'a1', client_id:cls[0].id, service:'google_ads', tier:'growth',   specialist_id:'u-1', is_internal:false, ended_at:null },
      { id:'a2', client_id:cls[1].id, service:'google_ads', tier:'standard', specialist_id:'u-1', is_internal:false, ended_at:null },
      { id:'a3', client_id:cls[2].id, service:'seo', tier:null, specialist_id:'u-2', is_internal:false, ended_at:null },
      { id:'a4', client_id:cls[3].id, service:'seo', tier:null, specialist_id:'u-2', is_internal:true,  ended_at:null },
      // ended: it must not be paid for, and must not put its client on the board
      { id:'a5', client_id:cls[0].id, service:'meta_ads', tier:'standard', specialist_id:'u-3', is_internal:false, ended_at:'2026-08-01' }];

    const nav = document.querySelector('.nav-item[data-screen="pods"]');
    const out = { nav: !!nav, roleGate: nav && nav.getAttribute('data-role-min') };
    // sits in the Business group: after its label, before the next group's
    const items = [...document.querySelectorAll('.nav-group-label, .nav-item[data-screen]')];
    const gi = items.findIndex(e => e.dataset.navgroup === 'business');
    const ni = items.indexOf(nav);
    const nextGroup = items.findIndex((e, i) => i > gi && e.classList.contains('nav-group-label'));
    out.underBusiness = gi > -1 && ni > gi && (nextGroup === -1 || ni < nextGroup);
    // Luke's preview: owner, manager and the in-house dev, and nobody else. The
    // specialist view is built and checked below, and simply not reachable from the nav
    // until this attribute comes off -- which is the whole of turning it on.
    const had = document.body.className;
    document.body.className = 'role-member';
    out.hiddenFromMember = getComputedStyle(nav).display === 'none';
    // Clients are hidden from in a pass at init that keys off this attribute, not by the
    // role CSS, so what there is to check here is that the attribute is still on both.
    out.hiddenFromClient = nav.hasAttribute('data-client-hidden')
      && document.querySelector('.screen[data-screen="pods"]').hasAttribute('data-client-hidden');
    document.body.className = 'role-manager';
    out.shownToManager = getComputedStyle(nav).display !== 'none';
    document.body.className = had;

    document.querySelectorAll('.nav-group-toggle').forEach(t => {
      if (t.classList.contains('nav-group-collapsed')) t.click(); });
    await w(400);
    nav.click();
    for (let i = 0; i < 40 && !(window.podState && window.podState.loaded); i++) await w(250);
    await w(800);
    out.loaded = !!(window.podState && window.podState.loaded);
    out.subtitle = (document.getElementById('pods_subtitle') || {}).textContent;
    const body = () => document.getElementById('pods_body').innerText;
    // Accounts alone: 250 growth + 200 standard + 300 seo + 150 internal = 900, with the
    // ended Meta row unpaid. Payroll is larger than this because it also carries the Team
    // Pay bases -- the Pod Leader holds no accounts and must not be free -- so the check
    // reads the accounts figure from the state rather than expecting payroll to equal it.
    out.accountsOnly = window.podState.__accountsPay;
    out.mrr = /\$6,000/.test(out.subtitle);          // 1500 + 2000 + 2500 + 0
    out.payrollExceedsAccounts = window.podState.__totalPay > window.podState.__accountsPay;
    out.excludesEnded = !/Meta/.test(body());
    out.capacity = /4 \/ 20/.test(body());
    out.health = /\b2\b/.test(body()) && /green/.test(body());
    const subBefore = (document.getElementById('pods_subtitle') || {}).textContent;
    document.querySelector('[data-pods-period="wk"]').click(); await w(400);
    const subAfter = (document.getElementById('pods_subtitle') || {}).textContent;
    out.weekly = /\/wk/.test(subAfter) && subAfter !== subBefore;
    document.querySelector('[data-pods-period="mo"]').click(); await w(400);
    const tabs = [...document.querySelectorAll('[data-pods-tab]')];
    out.tabLabels = tabs.map(t => t.textContent.trim());
    // two specialists share the first name "Team" in the fixtures: neither tab may say only that
    out.namesNotAmbiguous = new Set(tabs.filter(t => t.dataset.podsTab.startsWith('p:'))
      .map(t => t.textContent.trim())).size === tabs.filter(t => t.dataset.podsTab.startsWith('p:')).length;
    const rates = tabs.find(t => /Rates/.test(t.textContent));
    rates.click(); await w(400);
    // Amounts are fields now, not text, so they are read from the inputs. 200 / 325 / 150
    // is the seeded card: Google standard, Google advanced, and the internal SEO rate.
    const amounts = [...document.querySelectorAll('[data-pods-field="rateAmount"]')].map(el => el.value);
    out.rateAmounts = amounts.join(',');
    out.ratesShown = ['200', '325', '150'].every(v => amounts.includes(v));
    out.noDuplicatedNote = !/Paying clientPaying/.test(body());
    return out;
  });
  check('the Pod System sits under Business, and only managers and above can open it',
    r.nav && r.roleGate === 'manager' && r.underBusiness && r.hiddenFromMember
      && r.shownToManager && r.hiddenFromClient, JSON.stringify(r));
  check('payroll, MRR and capacity are computed, and ended accounts are not paid',
    r.loaded && r.accountsOnly === 90000 && r.mrr && r.payrollExceedsAccounts
      && r.excludesEnded && r.capacity && r.health, JSON.stringify(r));
  check('weekly restates the same money, and the rate card reads from the database',
    r.weekly && r.ratesShown && r.noDuplicatedNote && r.namesNotAmbiguous, JSON.stringify(r));
});

await step('the board matches the reference design, and uses real Team Pay figures', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const db = window.__mock.db;
    db.pods = [{ id:'pod-1', name:'Pod 1', leader_id:'u-me', max_clients:20,
                 opens_at:null, status:'active', position:0 }];
    const cs = db.clients.slice(0, 2);
    db.clients.forEach(x => { x.pod_id = null; });
    cs.forEach(x => { x.pod_id = 'pod-1'; });
    cs[0].mrr_cents = 250000; cs[1].mrr_cents = 180000;
    cs[0].health = 'green'; cs[1].health = 'amber';
    db.pod_assignments = [
      { id:'a1', client_id:cs[0].id, service:'google_ads', tier:'growth', specialist_id:'u-1', is_internal:false, ended_at:null },
      { id:'a2', client_id:cs[1].id, service:'seo', tier:null, specialist_id:'u-2', is_internal:false, ended_at:null }];
    document.querySelector('.nav-item[data-screen="pods"]').click();
    await w(400);
    // an earlier step leaves its own tab selected, and the stat tiles only exist on the
    // dashboard -- measuring The team would report the 44px figure as missing
    if (window.podState) window.podState.tab = 'dash';
    await window.podsReload();
    await w(700);
    const root = document.getElementById('pods_root');
    const px = (el, prop) => el ? getComputedStyle(el)[prop] : null;
    const out = {
      // the design's own values, from Pod System.dc.html
      bg: px(root, 'backgroundColor'),
      font: (px(root, 'fontFamily') || '').split(',')[0].replace(/"/g, ''),
      h1: px(root.querySelector('h1'), 'fontSize') + '/' + px(root.querySelector('h1'), 'fontWeight'),
      statBig: px(root.querySelector('.p-statbig'), 'fontSize'),
      tabRadius: px(root.querySelector('.p-tab'), 'borderRadius'),
      tabPad: px(root.querySelector('.p-tab'), 'padding'),
      cardBg: px(root.querySelector('.p-card'), 'backgroundColor'),
      cardRadius: px(root.querySelector('.p-card'), 'borderRadius'),
      cardPad: px(root.querySelector('.p-card'), 'padding'),
      // the design's order: pod columns, then the leader band, then the chips
      order: [...root.querySelectorAll('[id^="pods_"]')].map(e => e.id)
        .filter(x => ['pods_subtitle','pods_pods','pods_leader','pods_tabs','pods_body'].includes(x)),
      headerHasLogo: /REACHGIANT/.test(root.innerText),
      headerAdd: !!document.querySelector('#pods_actions [data-pods-add]'),
    };
    const cards = [...document.querySelectorAll('#pods_pods > div')];
    out.podCards = cards.length;
    out.podCardText = cards.map(c => c.innerText.replace(/\n+/g, ' | '));
    // POD 1 is solid red; the pods that have not opened are dashed and grey
    out.pod1Border = cards[0] ? getComputedStyle(cards[0]).borderColor : null;
    out.pod2Dashed = cards[1] ? getComputedStyle(cards[1]).borderStyle : null;
    const sub = () => document.getElementById('pods_subtitle').textContent;
    // Matthew's real base is $1,596.15 a week; the rate card is monthly, so the board has to
    // reconcile the two. 1596.15 * 52 / 12 = 6916.65
    out.baseConverted = /\$6,917/.test(document.getElementById('pods_body').innerText)
      || /\$6,917/.test(sub());
    out.monthly = sub();
    document.querySelector('[data-pods-period="wk"]').click(); await w(400);
    out.weekly = sub();
    // the subtitle belongs to the board, not to one tab
    const team = [...document.querySelectorAll('[data-pods-tab]')].find(b => /The team/.test(b.textContent));
    out.hasTeamTab = !!team;
    if (team) { team.click(); await w(500);
      // The team opens on a pod now, and this fixture has no pod membership, so the
      // people are behind Everyone. What is being checked is what a person's card says,
      // not which scope it opens on -- that has its own check.
      const everyone = document.querySelector('#pods_body [data-pods-scope="all"]');
      out.hasEveryoneScope = !!everyone;
      if (everyone) { everyone.click(); await w(600); }
      out.teamShowsBaseAndAccounts = /base/.test(document.getElementById('pods_body').innerText)
        && /account/.test(document.getElementById('pods_body').innerText);
      out.subtitleFollowsOnAnyTab = /\/wk/.test(sub());
    }
    document.querySelector('[data-pods-period="mo"]').click(); await w(400);
    return out;
  });
  check('the board is laid out in the design’s order, with its pod columns and leader band',
    JSON.stringify(r.order) === JSON.stringify(['pods_subtitle','pods_pods','pods_leader','pods_tabs','pods_body'])
      && r.podCards === 3 && /POD 1 · ACTIVE/.test(r.podCardText[0] || '')
      && /OPENS AT 20 CLIENTS/.test(r.podCardText[1] || '')
      && /OPENS AT 40 CLIENTS/.test(r.podCardText[2] || '')
      && r.pod1Border === 'rgb(232, 35, 42)' && r.pod2Dashed === 'dashed'
      && r.headerHasLogo && r.headerAdd, JSON.stringify(r));
  check('the design’s palette, type scale and card geometry are reproduced exactly',
    r.bg === 'rgb(11, 11, 12)' && r.font === 'Instrument Sans' && r.h1 === '32px/700'
      && r.statBig === '44px' && r.tabRadius === '99px' && r.tabPad === '9px 16px'
      && r.cardBg === 'rgb(20, 20, 22)' && r.cardRadius === '16px' && r.cardPad === '20px 22px',
    JSON.stringify(r));
  check('real Team Pay bases are converted onto the rate card’s monthly footing',
    r.baseConverted && /\/mo/.test(r.monthly) && /\/wk/.test(r.weekly)
      && r.monthly !== r.weekly, JSON.stringify(r));
  check('The team shows base plus accounts, and the summary follows the period on any tab',
    r.hasTeamTab && r.teamShowsBaseAndAccounts && r.subtitleFollowsOnAnyTab, JSON.stringify(r));
});

await step('a pod can be created, and a client assigned into it', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const db = window.__mock.db;
    // start with nothing: the board's first job is to offer the first step
    db.pods = []; db.pod_assignments = [];
    // and nobody left in a pod that no longer exists
    db.clients.forEach(x => { x.pod_id = null; });
    if (window.podState) { window.podState.pods = []; window.podState.assignments = []; }
    document.querySelectorAll('.nav-group-toggle').forEach(t => {
      if (t.classList.contains('nav-group-collapsed')) t.click(); });
    await w(400);
    document.querySelector('.nav-item[data-screen="pods"]').click();
    await w(500);
    // The screen may already be open from the check before this one, in which case its
    // class never changes and the reload-on-open observer never fires. Ask directly.
    if (window.podState) window.podState.tab = 'dash';
    await window.podsReload();
    await w(700);
    const body = () => document.getElementById('pods_body');
    // the design puts the action beside the title, not in the board body
    const header = () => document.getElementById('pods_actions');
    const out = { offersPod: !!header().querySelector('[data-pods-newpod]') };
    if (!out.offersPod) return { ...out, skipped: 'no create-pod button on an empty board' };

    // window.prompt is a no-op in the Electron build, which is why the app has giantPrompt
    // and why stubbing the native one would prove nothing about the desktop app
    const origPrompt = window.giantPrompt;
    let usedNativePrompt = false;
    const origNative = window.prompt;
    window.prompt = () => { usedNativePrompt = true; return 'Pod 1'; };
    window.giantPrompt = () => Promise.resolve('Pod 1');
    header().querySelector('[data-pods-newpod]').click();
    await w(1200);
    window.giantPrompt = origPrompt;
    window.prompt = origNative;
    out.usedNativePrompt = usedNativePrompt;
    out.podCreated = (db.pods || []).length;
    out.thenOffersAddClient = !!header().querySelector('[data-pods-add]');
    if (!out.thenOffersAddClient) return out;

    header().querySelector('[data-pods-add]').click();
    await w(1200);
    if (!document.querySelector('.pods-editor')) return { ...out, skipped: 'editor did not open' };
    // the client is identified by id, not by a figure -- the fixtures seed clients with the
    // same MRR, and finding by value reads back somebody else's row
    // Two explicit modes now. Staging a new client then cancelling must leave nothing
    // behind — the client used to be written the moment Create was clicked.
    const beforeCancel = db.clients.length;
    const stage = document.getElementById('pods_edSearch');
    stage.value = 'Ghost Co ' + Date.now();
    stage.dispatchEvent(new Event('input', { bubbles: true }));
    await w(400);
    document.querySelector('[data-pods-new]').click();
    await w(500);
    out.stagedNotWritten = db.clients.length === beforeCancel;
    document.getElementById('pods_edCancel').click();
    await w(500);
    out.cancelLeavesNothing = db.clients.length === beforeCancel;

    // reopen, and pick an existing client through the Existing client mode
    document.querySelector('#pods_actions [data-pods-add]').click();
    await w(1000);
    document.querySelector('[data-pods-mode="pick"]').click();
    await w(400);
    const search = document.getElementById('pods_edSearch');
    const firstName = (window.podState.clients[0] || {}).name || '';
    search.value = firstName.slice(0, 4);
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await w(400);
    out.searchNarrows = document.querySelectorAll('#pods_edList [data-pods-pick]').length
      < window.podState.clients.length;
    document.querySelector('#pods_edList [data-pods-pick]').click();
    await w(500);
    const savingId = document.getElementById('pods_edClient').value;
    out.pickedBySearch = !!savingId;
    // every client from the Clients module appears on All clients, including ones with no
    // assignment yet -- the board is where they get assigned, so hiding them hides the work
    out.clientsInModule = window.podState.clients.length;

    const mrr = document.getElementById('pods_edMrr');
    mrr.value = '2000'; mrr.dispatchEvent(new Event('input', { bubbles: true }));
    await w(200);
    // the design has a date, not a day number: picking one keeps its day of the month
    const dt = document.getElementById('pods_edDate');
    const d15 = new Date(); d15.setDate(15);
    dt.value = d15.toISOString().slice(0, 10);
    dt.dispatchEvent(new Event('change', { bubbles: true }));
    await w(400);
    // services are added by chip, then configured on their own row
    document.querySelector('[data-pods-addsvc="google_ads"]').click(); await w(400);
    const tier = document.querySelector('[data-pods-tier="google_ads"]');
    tier.value = 'growth'; tier.dispatchEvent(new Event('change', { bubbles: true }));
    await w(400);
    const who = document.querySelector('[data-pods-who="google_ads"]');
    const someone = [...who.options].find(o => o.value);
    who.value = someone ? someone.value : ''; who.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-pods-addsvc="seo"]').click(); await w(400);
    // growth 250 + seo 300, priced on the row and in the TEAM COST cell before saving
    const cardTxt = document.getElementById('pods_edCard').innerText;
    out.livePreview = /\$550/.test(cardTxt);
    out.hasStatusPills = !!document.querySelector('[data-pods-status="active"]');
    out.hasHealthDot = !!document.getElementById('pods_edHealth');
    out.perServiceRate = /\$250/.test(cardTxt) && /\$300/.test(cardTxt);
    document.getElementById('pods_edSave').click();
    await w(2200);
    out.closed = !document.querySelector('.pods-editor');
    const saved = db.clients.find(c => c.id === savingId) || {};
    out.client = { mrr: saved.mrr_cents, payDay: saved.pay_day, inPod: !!saved.pod_id };
    const rows = (db.pod_assignments || []).filter(a => a.client_id === savingId);
    out.assignments = rows.length;
    out.google = rows.some(a => a.service === 'google_ads' && a.tier === 'growth' && a.specialist_id);
    out.seoUntiered = rows.some(a => a.service === 'seo' && a.tier === null);
    out.subtitle = (document.getElementById('pods_subtitle') || {}).textContent;
    // the accounts figure, which is what this step created; payroll also carries the Team
    // Pay bases, so the two are deliberately different numbers
    out.accountsPay = window.podState.__accountsPay;

    // The team is the whole workspace, not only those already earning: two ways of being
    // paid sit side by side, and somebody with neither still has to be visible.
    const teamTab = [...document.querySelectorAll('[data-pods-tab]')].find(b => b.dataset.podsTab === 'team');
    teamTab.click(); await w(600);
    // Everyone is a scope on this tab now, not the whole of it: the tab opens on a pod,
    // because a person appearing here for the sole reason that they have a Giant account
    // is what made it unreadable. The workspace is still one click away, and that is what
    // this check is about.
    const everyone2 = document.querySelector('#pods_body [data-pods-scope="all"]');
    if (everyone2) everyone2.click();
    await w(700);
    const teamTxt = document.getElementById('pods_body').innerText;
    out.rosterSize = (window.podState.roster || []).length;
    // one card per person, plus the Capacity card the tab now opens with
    out.teamCards = document.querySelectorAll('#pods_body .p-card').length;
    out.hasCapacityCard = /CAPACITY/.test(document.getElementById('pods_body').innerText);
    out.showsTimeBasis = /a week|\/hr|a month/.test(teamTxt);
    out.showsPerAccount = /per account/.test(teamTxt);
    out.showsUnpaid = /no pay set in Team Pay/.test(teamTxt);

    const allTab = [...document.querySelectorAll('[data-pods-tab]')].find(b => b.dataset.podsTab === 'all');
    allTab.click(); await w(600);
    // counted after the create above, or the new client makes the two disagree by one
    out.clientsInModule = window.podState.clients.length;
    out.allClientsCount = document.querySelectorAll('#pods_body [data-pods-client]').length;
    out.unassignedAreOffered = /not in a pod/.test(document.getElementById('pods_body').innerText);

    // the leader picker referenced a function from another module and threw on open
    let leaderError = null;
    const onErr = (e) => { leaderError = String(e.message || e); };
    window.addEventListener('error', onErr);
    const dash = [...document.querySelectorAll('[data-pods-tab]')].find(b => b.dataset.podsTab === 'dash');
    dash.click(); await w(500);
    const setL = document.querySelector('[data-pods-setleader]');
    if (setL) { setL.click(); await w(900); }
    out.leaderPickerOpens = setL ? !!document.querySelector('.pods-ask') : 'no unset pod to try';
    out.leaderError = leaderError;
    window.removeEventListener('error', onErr);
    document.querySelectorAll('.pods-ask').forEach(e => e.remove());
    return out;
  });
  check('an empty board offers a pod, and once there is one, offers a client',
    r.offersPod && r.podCreated === 1 && r.thenOffersAddClient, JSON.stringify(r));
  check('it asks through the app’s own prompt, not the native one Electron ignores',
    r.usedNativePrompt === false, JSON.stringify(r));
  check('the client panel is the design’s: health dot, status pills, per-service rates',
    !r.skipped && r.hasHealthDot && r.hasStatusPills && r.perServiceRate, JSON.stringify(r));
  check('The team shows everyone in the workspace, however they are paid',
    !r.skipped && r.teamCards === r.rosterSize + 1 && r.hasCapacityCard && r.rosterSize > 0
      && r.showsTimeBasis && r.showsPerAccount && r.showsUnpaid, JSON.stringify(r));
  check('choosing a Pod Leader opens a picker instead of throwing',
    !r.skipped && r.leaderPickerOpens && !r.leaderError, JSON.stringify(r));
  check('All clients lists every client the Clients module has, not only assigned ones',
    !r.skipped && r.allClientsCount === r.clientsInModule
      && r.unassignedAreOffered, JSON.stringify(r));
  check('naming a client stages it, and cancelling leaves nothing behind',
    !r.skipped && r.stagedNotWritten && r.cancelLeavesNothing, JSON.stringify(r));
  check('the client picker is searched rather than scrolled',
    !r.skipped && r.searchNarrows && r.pickedBySearch, JSON.stringify(r));
  check('the editor prices the services before saving, then writes client and assignments',
    !r.skipped && r.livePreview && r.closed && r.assignments === 2 && r.google && r.seoUntiered
      && r.client.mrr === 200000 && r.client.payDay === 15 && r.client.inPod,
    JSON.stringify(r));
  check('and the board immediately reflects what was just entered',
    !r.skipped && r.accountsPay === 55000 && /\$2,000/.test(r.subtitle || ''),
    JSON.stringify(r));
});

await step('clients move between pods, and a full pod refuses a twenty-first', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const db = window.__mock.db;
    db.pods = [{ id:'pod-a', name:'Pod A', leader_id:'u-me', max_clients:20, opens_at:null, status:'active', position:0 },
               { id:'pod-b', name:'Pod B', leader_id:'u-1',  max_clients:2,  opens_at:null, status:'active', position:1 }];
    db.pod_assignments = [];
    db.clients.forEach(x => { x.pod_id = null; });
    const cls = db.clients.slice(0, 4);
    cls[0].pod_id = 'pod-a';
    // Pod B is deliberately at its limit of two
    cls[1].pod_id = 'pod-b'; cls[2].pod_id = 'pod-b';
    document.querySelector('.nav-item[data-screen="pods"]').click();
    await w(400);
    if (window.podState) window.podState.tab = 'dash';
    await window.podsReload();
    await w(700);
    const out = {};
    // each column counts its own clients, rather than every pod showing the same number
    out.columns = [...document.querySelectorAll('#pods_pods > div')].map(c =>
      (c.innerText.match(/(\d+)\s*\/\s*(\d+)\s*clients/) || [])[0] || null).filter(Boolean);

    // opening the next pod: the header offers one, and the dashed placeholder is the way
    // the design intends -- it was decoration before, leaving no way to make a second pod
    out.headerOffersNewPod = !!document.querySelector('#pods_actions [data-pods-newpod]');
    const ph = document.querySelector('[data-pods-openpod]');
    out.placeholderClickable = !!ph;
    // Pod B is at its limit of two, so the next placeholder should read as due
    out.readyWhenFull = /READY TO OPEN/.test(document.getElementById('pods_pods').innerText);
    const before2 = db.pods.length;
    const origGP = window.giantPrompt;
    window.giantPrompt = () => Promise.resolve('Pod C');
    if (ph) { ph.click(); await w(1400); }
    window.giantPrompt = origGP;
    out.secondPodOpened = db.pods.length === before2 + 1
      && db.pods.some(x => x.name === 'Pod C' && x.status === 'active');
    // back to two pods for the rest of the step
    db.pods = db.pods.filter(x => x.name !== 'Pod C');
    await window.podsReload(); await w(500);

    // move the Pod A client into Pod B, which is full: it must be refused
    window.podState.tab = 'all';
    window.podState.render ? null : null;
    await window.podsReload(); await w(600);
    document.querySelector('[data-pods-client="' + cls[0].id + '"]').click();
    await w(1200);
    const podChips = [...document.querySelectorAll('[data-pods-pod]')];
    out.podPicker = podChips.length;
    out.startsInPodA = !!podChips.find(x => x.dataset.podsPod === 'pod-a'
      && /rgb\(232, 35, 42\)/.test(getComputedStyle(x).borderColor));
    const toB = podChips.find(x => x.dataset.podsPod === 'pod-b');
    toB.click(); await w(500);
    // refused, so the draft stays on Pod A
    out.fullPodRefused = window.podState.__draftPod !== 'pod-b';

    // now make room in Pod B and move it for real
    cls[2].pod_id = null;
    await window.podsReload(); await w(500);
    document.querySelector('[data-pods-client="' + cls[0].id + '"]').click();
    await w(1000);
    const toB2 = [...document.querySelectorAll('[data-pods-pod]')].find(x => x.dataset.podsPod === 'pod-b');
    toB2.click(); await w(400);
    document.getElementById('pods_edSave').click();
    await w(2000);
    out.moved = (db.clients.find(x => x.id === cls[0].id) || {}).pod_id === 'pod-b';
    out.podAEmptyNow = db.clients.filter(x => x.pod_id === 'pod-a').length === 0;
    return out;
  });
  check('each pod column counts its own clients against its own maximum',
    r.columns && r.columns.length === 2 && r.columns[0] !== r.columns[1], JSON.stringify(r));
  check('a second pod can be opened, and the placeholder says so when one is full',
    r.headerOffersNewPod && r.placeholderClickable && r.readyWhenFull && r.secondPodOpened,
    JSON.stringify(r));
  check('a full pod refuses another client rather than quietly taking a twenty-first',
    r.podPicker >= 2 && r.fullPodRefused, JSON.stringify(r));
  check('a client can be moved from one pod to another',
    r.moved && r.podAEmptyNow, JSON.stringify(r));
});

await step('the client panel creates, connects and onboards in one place', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const db = window.__mock.db;
    db.pods = [{ id:'pod-z', name:'Pod Z', leader_id:'u-me', max_clients:20, opens_at:null, status:'active', position:0 }];
    db.pod_assignments = [];
    db.clients.forEach(x => { x.pod_id = null; });
    db.channels = (db.channels || []).filter(ch => ch.kind !== 'client_dept');
    document.querySelector('.nav-item[data-screen="pods"]').click();
    await w(400);
    if (window.podState) window.podState.tab = 'dash';
    await window.podsReload();
    await w(700);
    document.querySelector('#pods_actions [data-pods-add]').click();
    await w(1200);
    const out = {};

    // a client that does not exist yet: named, staged, and written only on save
    const name = 'Pod Panel Co ' + Date.now();
    const search = document.getElementById('pods_edSearch');
    search.value = name; search.dispatchEvent(new Event('input', { bubbles: true }));
    await w(400);
    const before = db.clients.length;
    document.querySelector('[data-pods-new]').click();
    await w(600);
    out.stagedOnly = db.clients.length === before;
    out.titleShowsName = (document.getElementById('pods_edName') || {}).value === name;
    out.saveSaysCreate = /Create and add to pod/.test(document.getElementById('pods_edCard').innerText);

    // its services, each offering to open a conversation
    document.querySelector('[data-pods-addsvc="google_ads"]').click(); await w(400);
    document.querySelector('[data-pods-addsvc="seo"]').click(); await w(400);
    out.chanOfferedByDefault = [...document.querySelectorAll('[data-pods-chan]')].every(x => x.checked);

    // while it is only staged, the onboarding block says the link waits on the save
    out.onboardingShown = /ONBOARDING/.test(document.getElementById('pods_edCard').innerText);
    out.linkWaitsOnSave = /as soon as this client is saved/.test(
      document.getElementById('pods_edCard').innerText);

    const mrr = document.getElementById('pods_edMrr');
    mrr.value = '3000'; mrr.dispatchEvent(new Event('input', { bubbles: true }));
    await w(250);
    document.getElementById('pods_edSave').click();
    await w(3000);

    const made = db.clients.find(x => x.name === name);
    out.created = !!made;
    if (!made) return out;
    out.createdStatus = made.status;
    out.createdInModule = !!(made.slug && made.initial);
    out.savedMrr = made.mrr_cents;
    out.inPod = made.pod_id === 'pod-z';
    const chans = (db.channels || []).filter(ch => ch.client_id === made.id);
    out.channelsOpened = chans.map(ch => ch.department).sort().join(',');
    out.channelsPublic = chans.every(ch => ch.is_private === false);
    out.teamAdded = chans.every(ch =>
      (db.channel_members || []).filter(m => m.channel_id === ch.id).length > 1);

    // the panel comes back on the client it just made, so its link can be generated there
    out.reopened = !!document.querySelector('.pods-editor')
      && (document.getElementById('pods_edName') || {}).value === name;
    const mk = document.getElementById('pods_obMake');
    out.offersLink = !!mk;
    if (mk) { mk.click(); await w(1500); }
    out.linkAfter = /\/onboard\//.test(document.getElementById('pods_edCard').innerText);
    out.tokenStored = !!(db.clients.find(x => x.id === made.id) || {}).onboarding_token;
    document.querySelectorAll('.pods-editor').forEach(e => e.remove());
    return out;
  });
  check('naming a client stages it; nothing is written until the panel is saved',
    r.stagedOnly && r.titleShowsName && r.saveSaysCreate && r.linkWaitsOnSave, JSON.stringify(r));
  check('saving creates the client, in the shape the Clients module writes',
    r.created && r.createdStatus === 'onboarding' && r.createdInModule, JSON.stringify(r));
  check('choosing services opens a conversation for each, public and with the team in it',
    r.chanOfferedByDefault && r.channelsOpened === 'googleAds,seo'
      && r.channelsPublic && r.teamAdded, JSON.stringify(r));
  check('the panel returns to the new client so its onboarding link can be made',
    r.reopened && r.onboardingShown && r.offersLink && r.linkAfter && r.tokenStored,
    JSON.stringify(r));
  check('and its money and pod are saved with it',
    r.savedMrr === 300000 && r.inPod, JSON.stringify(r));
});

await step('How it works explains the pod from the board’s own data', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const db = window.__mock.db;
    db.pods = [{ id:'pod-h', name:'Pod H', leader_id:'u-me', max_clients:20, opens_at:null, status:'active', position:0 }];
    db.clients.forEach(x => { x.pod_id = null; });
    const cs = db.clients.slice(0, 5);
    cs.forEach(x => { x.pod_id = 'pod-h'; });
    // the whole Meta rate card, so the warning can quote it as the design does
    db.pod_rates = (db.pod_rates || []).filter(x => x.service !== 'meta_ads').concat([
      { id:'r-m1', service:'meta_ads', tier:'standard', is_internal:false, amount_cents:25000, note:'$0–$10k ad spend' },
      { id:'r-m2', service:'meta_ads', tier:'growth',   is_internal:false, amount_cents:30000, note:'$10k–$50k' },
      { id:'r-m3', service:'meta_ads', tier:'advanced', is_internal:false, amount_cents:40000, note:'$50k+' }]);
    // three Meta accounts, all on one person: the design's own warning
    db.pod_assignments = [
      { id:'m1', client_id:cs[0].id, service:'meta_ads', tier:'standard', specialist_id:'u-3', is_internal:false, ended_at:null },
      { id:'m2', client_id:cs[1].id, service:'meta_ads', tier:'growth',   specialist_id:'u-3', is_internal:false, ended_at:null },
      { id:'m3', client_id:cs[2].id, service:'meta_ads', tier:'standard', specialist_id:'u-3', is_internal:false, ended_at:null },
      { id:'g1', client_id:cs[3].id, service:'google_ads', tier:'growth', specialist_id:'u-1', is_internal:false, ended_at:null }];
    document.querySelector('.nav-item[data-screen="pods"]').click();
    await w(400);
    if (window.podState) window.podState.tab = 'dash';
    await window.podsReload();
    await w(800);
    const out = {};
    const dash = document.getElementById('pods_body').innerText;
    out.metaWarning = /3rd Meta account reached/.test(dash);
    out.warningNamesRates = /\$250/.test(dash) && /\$400/.test(dash);

    const how = [...document.querySelectorAll('[data-pods-tab]')].find(b => b.dataset.podsTab === 'how');
    out.hasHowTab = !!how;
    if (!how) return out;
    how.click(); await w(700);
    // Every word on this tab is a field for a manager, so what it says is the fields'
    // values as well as the text around them.
    const body2 = document.getElementById('pods_body');
    const txt = body2.innerText + ' '
      + [...body2.querySelectorAll('input, textarea')].map(el => el.value).join(' ');
    out.roles = ['POD LEADER', 'GOOGLE ADS', 'SEO & AI SEARCH', 'META ADS', 'WEB & DESIGN']
      .every(k => txt.includes(k));
    out.blocks = ['CAPACITY LIMITS', 'HOW PAY WORKS', 'PERFORMANCE = MORE ACCOUNTS', 'GROWTH PLAN']
      .every(k => txt.includes(k));
    // the people are filled in from the board, not written into the page
    out.namesRealHolders = /Team Member 3/.test(txt) && /Team Member 1/.test(txt);
    // and the growth plan marks where this workspace actually is
    out.marksNow = /NOW · 5 CLIENTS/.test(txt);
    return out;
  });
  check('the dashboard raises the design’s Meta warning, with its rates',
    r.metaWarning && r.warningNamesRates, JSON.stringify(r));
  check('How it works carries every role and every block from the design',
    r.hasHowTab && r.roles && r.blocks, JSON.stringify(r));
  check('it names whoever actually holds the work, and marks where the pod is now',
    r.namesRealHolders && r.marksNow, JSON.stringify(r));
});

await step('duplicate names are refused, and any department can be opened', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const db = window.__mock.db;
    const existingName = db.clients[0].name;
    document.querySelector('#pods_actions [data-pods-add]').click();
    await w(1000);
    const search = document.getElementById('pods_edSearch');
    search.value = existingName;
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await w(400);
    const before = db.clients.length;
    const mk = document.querySelector('[data-pods-new]');
    if (mk) { mk.click(); await w(400); }
    // staged, so still nothing written -- the refusal happens when it would be created
    document.getElementById('pods_edSave').click();
    await w(1500);
    const out = { refusedDuplicate: db.clients.length === before,
                  panelStillOpen: !!document.querySelector('.pods-editor') };
    document.querySelectorAll('.pods-editor').forEach(e => e.remove());

    // a General conversation, which no service covers
    const cli = db.clients.find(x => x.pod_id);
    db.channels = (db.channels || []).filter(ch => ch.client_id !== cli.id);
    await window.podsReload(); await w(500);
    window.podState.tab = 'all';
    await window.podsReload(); await w(600);
    document.querySelector('[data-pods-client="' + cli.id + '"]').click();
    await w(1200);
    const gen = document.querySelector('[data-pods-thread="general"]');
    out.offersGeneral = !!gen;
    if (gen) { gen.click(); await w(1600); }
    out.generalOpened = (db.channels || []).some(ch => ch.client_id === cli.id && ch.department === 'general');
    document.querySelectorAll('.pods-editor').forEach(e => e.remove());
    return out;
  });
  check('a client Giant already has cannot be created a second time',
    r.refusedDuplicate && r.panelStillOpen, JSON.stringify(r));
  check('a conversation can be opened for a department with no service behind it',
    r.offersGeneral && r.generalOpened, JSON.stringify(r));
});

await step('internal projects are paid like work, and counted like nothing else', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const db = window.__mock.db;
    db.pods = [{ id:'pod-i', name:'Pod I', leader_id:'u-me', max_clients:20, opens_at:null, status:'active', position:0 }];
    db.clients.forEach(x => { x.pod_id = null; });
    const cs = db.clients.slice(0, 2);
    cs.forEach(x => { x.pod_id = 'pod-i'; x.mrr_cents = 100000; });
    db.pod_assignments = [
      { id:'c1', client_id:cs[0].id, label:null, service:'seo', tier:null, specialist_id:'u-2', is_internal:false, ended_at:null },
      // three of ours, one of them unassigned
      { id:'i1', client_id:null, label:'Reach Giant', service:'seo', tier:null, specialist_id:'u-2', is_internal:true, ended_at:null },
      { id:'i2', client_id:null, label:'Lukas Griffin Artwork', service:'seo', tier:null, specialist_id:'u-2', is_internal:true, ended_at:null },
      { id:'i3', client_id:null, label:'MODIFYR', service:'seo', tier:null, specialist_id:null, is_internal:true, ended_at:null }];
    document.querySelector('.nav-item[data-screen="pods"]').click();
    await w(400);
    if (window.podState) window.podState.tab = 'all';
    await window.podsReload();
    await w(800);
    const out = {};
    const body = document.getElementById('pods_body');
    out.blockShown = /INTERNAL ·/.test(body.innerText);
    out.namesHolder = /TO TEAM MEMBER 2|TO NOOR/i.test(body.innerText);
    out.lists = ['Reach Giant', 'Lukas Griffin Artwork', 'MODIFYR'].every(n => body.innerText.includes(n));
    out.unassignedSaidSo = /unassigned/.test(body.innerText);
    out.rows = document.querySelectorAll('[data-pods-int]').length;

    // they are not clients: no client row is one of them, and none counts against the pod.
    // All clients lists every client by design, so the count there is not the thing to test.
    const clientNames = [...document.querySelectorAll('[data-pods-client]')].map(e => e.innerText);
    out.noInternalAmongClients = !clientNames.some(t =>
      /Reach Giant|Lukas Griffin Artwork|MODIFYR/.test(t));
    out.podCounts = window.podState.clients.filter(c => c.pod_id === 'pod-i').length;
    out.capacitySaysTwo = /2 \/ 20/.test(document.getElementById('pods_pods').innerText);
    // 3 internal at $150 + one paying SEO client at $300 = $750 of account pay
    out.accountsPay = window.podState.__accountsPay;
    // and MRR is the clients' only
    out.mrr = /\$200,000|\$2,000/.test(document.getElementById('pods_subtitle').textContent);
    return out;
  });
  check('the internal block lists our own properties and names who holds them',
    r.blockShown && r.lists && r.rows === 3 && r.unassignedSaidSo, JSON.stringify(r));
  check('they are paid off the same rate card as client work',
    r.accountsPay === 75000, JSON.stringify(r));
  check('but they are not clients: not listed as one, not counted against the pod',
    r.noInternalAmongClients && r.podCounts === 2 && r.capacitySaysTwo, JSON.stringify(r));
});

await step('work can be given and taken back from a person\'s own tab', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const db = window.__mock.db;
    db.pods = [{ id:'pod-j', name:'Pod J', leader_id:'u-me', max_clients:20, opens_at:null, status:'active', position:0 }];
    db.clients.forEach(x => { x.pod_id = null; });
    const cs = db.clients.slice(0, 2);
    cs.forEach(x => { x.pod_id = 'pod-j'; });
    db.pod_assignments = [
      { id:'a1', client_id:cs[0].id, label:null, service:'seo', tier:null, specialist_id:'u-2', is_internal:false, ended_at:null },
      { id:'a2', client_id:null, label:'Reach Giant', service:'seo', tier:null, specialist_id:'u-2', is_internal:true, ended_at:null }];
    document.querySelector('.nav-item[data-screen="pods"]').click();
    await w(400);
    window.podState.tab = 'p:u-2';
    await window.podsReload();
    await w(700);
    const out = {};
    const body = document.getElementById('pods_body');
    // their chip counts internal work, so their tab has to show it or the two disagree
    const chip = document.querySelector('[data-pods-tab="p:u-2"]');
    out.chipSays = chip ? chip.innerText.replace(/\s+/g, ' ').trim() : '';
    out.internalShown = /Reach Giant/.test(body.innerText);
    out.noAddInternalHere = !body.querySelector('[data-pods-addint]');

    // give them a second client: client, then service, then no tier for SEO
    const before = db.pod_assignments.length;
    const btn = body.querySelector('[data-pods-assign="u-2"]');
    out.hasGive = !!btn;
    btn.click(); await w(400);
    const pick = (re) => { const o = [...document.querySelectorAll('.pods-ask [data-ask-pick]')]
      .find(x => re.test(x.innerText)); if (o) o.click(); return !!o; };
    out.offeredOther = pick(new RegExp(cs[1].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await w(350);
    out.offeredService = pick(/SEO/i);
    await w(700);
    out.wrote = db.pod_assignments.length === before + 1;
    const made = db.pod_assignments[db.pod_assignments.length - 1];
    out.madeRight = !!made && made.specialist_id === 'u-2' && made.client_id === cs[1].id
      && made.service === 'seo' && made.ended_at == null;
    out.rowsNow = document.querySelectorAll('[data-pods-client]').length;

    // and take the first one back
    const origConfirm = window.giantConfirmWarn;
    let asked = '';
    window.giantConfirmWarn = (t, m) => { asked = t + ' :: ' + m; return Promise.resolve(true); };
    const x = body.querySelector('[data-pods-unassign="a1"]');
    out.hasTakeBack = !!x;
    if (x) { x.click(); await w(900); }
    window.giantConfirmWarn = origConfirm;
    out.asked = asked;
    out.ended = !!(db.pod_assignments.find(a => a.id === 'a1') || {}).ended_at;
    out.rowsAfter = document.querySelectorAll('[data-pods-client]').length;
    return out;
  });
  check('their tab shows their internal work, because their chip counts it',
    r.internalShown && r.noAddInternalHere && /2/.test(r.chipSays), JSON.stringify(r));
  check('a client can be given to them from their own tab, at a rate',
    r.hasGive && r.offeredOther && r.offeredService && r.wrote && r.madeRight && r.rowsNow === 2,
    JSON.stringify(r));
  check('and taken back again from the same row, after saying what that means',
    r.hasTakeBack && r.ended && r.rowsAfter === 1 && /stops being paid/.test(r.asked),
    JSON.stringify(r));
});

await step('a specialist gets their own accounts, and none of the money that is not theirs', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const db = window.__mock.db;
    const uid = window.giantSession.user.id;
    db.pods = [{ id:'pod-k', name:'Pod K', leader_id:'u-2', max_clients:20, opens_at:null, status:'active', position:0 }];
    db.clients.forEach(x => { x.pod_id = null; });
    const cs = db.clients.slice(0, 3);
    cs.forEach(x => { x.pod_id = 'pod-k'; x.mrr_cents = 900000; x.pay_day = 14; });
    db.pod_assignments = [
      { id:'m1', client_id:cs[0].id, label:null, service:'seo', tier:null, specialist_id:uid, is_internal:false, ended_at:null },
      { id:'m2', client_id:null, label:'Reach Giant', service:'seo', tier:null, specialist_id:uid, is_internal:true, ended_at:null },
      // somebody else's, on a client we are not on and on one we are
      { id:'o1', client_id:cs[1].id, label:null, service:'google_ads', tier:'growth', specialist_id:'u-2', is_internal:false, ended_at:null },
      { id:'o2', client_id:cs[0].id, label:null, service:'meta_ads', tier:'advanced', specialist_id:'u-2', is_internal:false, ended_at:null }];

    // The nav no longer offers this to a member -- it is gated for Luke's preview -- so
    // the board is opened directly. What is being checked is that the view itself is
    // right and asks for nothing that is not theirs, which is what makes turning the gate
    // off later a one-attribute change rather than a piece of work.
    const was = window.giantCurrentProfile.role;
    window.giantCurrentProfile.role = 'member';
    window.__mock.log.selects = [];
    document.querySelector('.nav-item[data-screen="pods"]').click();
    await w(400);
    await window.podsReload();
    await w(900);

    const out = {};
    const body = document.getElementById('pods_body').innerText;
    const sub = document.getElementById('pods_subtitle').textContent;
    out.sub = sub;
    out.body = body.slice(0, 400);
    // theirs, and only theirs
    out.hasMine = body.includes(cs[0].name) && /Reach Giant/.test(body);
    out.notOthers = !body.includes(cs[1].name);
    // 1 client account + 1 internal = 2; SEO 300 + internal 150 = $450
    out.countTwo = /\b2\b/.test(sub);
    out.earns = /\$450/.test(body);
    // and none of the board's money anywhere on the page
    const all = document.getElementById('pods_root').innerText;
    out.noMrr = !/MRR|\$9,000/.test(all);
    out.noPayroll = !/Payroll|margin|PAY DAY/i.test(all);
    out.noOtherTabs = ![...document.querySelectorAll('[data-pods-tab]')]
      .some(t => /Dashboard|All clients|The team/.test(t.textContent));
    out.noActions = !document.querySelector('#pods_actions [data-pods-add], #pods_actions [data-pods-newpod]');
    out.tabs = [...document.querySelectorAll('[data-pods-tab]')].map(t => t.textContent.trim());

    // the state itself must not hold what was never theirs to see
    out.stateHasNoMrr = window.podState.clients.every(c => c.mrr_cents === undefined);
    out.stateHasNoPayDay = window.podState.clients.every(c => c.pay_day === undefined);
    out.stateOnlyMyAssignments = window.podState.assignments.every(a => a.specialist_id === uid);
    out.stateOnlyMyPay = (window.podState.pay || []).every(x => x.profile_id === uid);

    // How it works is still theirs to read, without naming who holds what
    const how = [...document.querySelectorAll('[data-pods-tab]')].find(t => /How it works/.test(t.textContent));
    how.click(); await w(400);
    const howTxt = document.getElementById('pods_body').innerText;
    out.howShown = /Pod Leader owns the clients/.test(howTxt);
    out.howNamesNobody = !/nobody assigned yet/.test(howTxt);

    window.giantCurrentProfile.role = was;
    return out;
  });
  check('their board is their accounts and their internal work, not anybody else\'s',
    r.hasMine && r.notOthers && r.countTwo && r.earns, JSON.stringify(r));
  check('MRR, payroll, margin and payment dates are not on the page at all',
    r.noMrr && r.noPayroll && r.noOtherTabs && r.noActions, JSON.stringify(r));
  check('and were never fetched: the numbers are absent from the state, not hidden in it',
    r.stateHasNoMrr && r.stateHasNoPayDay && r.stateOnlyMyAssignments && r.stateOnlyMyPay,
    JSON.stringify(r));
  check('How it works reads the same, minus the names it could not know',
    r.howShown && r.howNamesNobody, JSON.stringify(r));
});

await step('the rate card is edited on the page, and payroll follows it', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const db = window.__mock.db;
    db.pods = [{ id:'pod-r', name:'Pod R', leader_id:'u-1', max_clients:20, opens_at:null, status:'active', position:0 }];
    db.clients.forEach(x => { x.pod_id = null; });
    const c0 = db.clients[0]; c0.pod_id = 'pod-r';
    db.pod_rates = [
      { id:'rr-1', service:'google_ads', tier:'standard', is_internal:false, amount_cents:20000, note:'$0–$10k ad spend' },
      { id:'rr-2', service:'seo', tier:null, is_internal:false, amount_cents:30000, note:'Paying SEO client' }];
    db.pod_assignments = [
      { id:'ra-1', client_id:c0.id, label:null, service:'google_ads', tier:'standard', specialist_id:'u-1', is_internal:false, ended_at:null }];
    document.querySelector('.nav-item[data-screen="pods"]').click();
    await w(400);
    window.podState.tab = 'rates';
    await window.podsReload();
    await w(800);
    const out = {};
    const body = document.getElementById('pods_body');

    // every service is offered, including the ones with no rate yet -- that is the gap
    out.servicesShown = ['GOOGLE ADS', 'META ADS', 'SEO', 'WEB'].every(t => body.innerText.includes(t));
    out.emptySaidSo = /No rate set yet/.test(body.innerText);

    // change an amount
    const amt = [...body.querySelectorAll('[data-pods-field="rateAmount"]')]
      .find(el => el.dataset.id === 'rr-1');
    out.amountIsAField = !!amt && amt.value === '200';
    const payBefore = window.podState.__accountsPay;
    amt.focus(); amt.value = '275'; amt.blur();
    await w(600);
    out.wrote = (db.pod_rates.find(x => x.id === 'rr-1') || {}).amount_cents;
    out.payFollowed = window.podState.__accountsPay !== payBefore;
    out.subtitleFollowed = /\$275|27,500/.test(
      document.getElementById('pods_subtitle').textContent) || window.podState.__accountsPay === 27500;

    // change a note, and the small print underneath
    const nt = [...body.querySelectorAll('[data-pods-field="rateNote"]')]
      .find(el => el.dataset.id === 'rr-2');
    nt.focus(); nt.value = 'Retainer SEO'; nt.blur();
    await w(500);
    out.noteWrote = (db.pod_rates.find(x => x.id === 'rr-2') || {}).note;
    const small = body.querySelector('[data-pods-field="ratesNote"]');
    small.focus(); small.value = 'Reviewed every 60 days now.'; small.blur();
    await w(500);
    out.settingWrote = (db.pod_settings.find(x => x.key === 'rates_note') || {}).value;

    // typing nothing writes nothing
    const writesBefore = window.__mock.log.writes.length;
    nt.focus(); nt.blur();
    await w(300);
    out.noWriteOnNoChange = window.__mock.log.writes.length === writesBefore;

    // Escape puts a field back
    amt.focus(); amt.value = '9999';
    amt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await w(200);
    out.escapeReverted = amt.value === '275';

    // a rate can be added: only the combinations this service does not already have
    const add = body.querySelector('[data-pods-rate-add="google_ads"]');
    out.canAdd = !!add;
    add.click(); await w(400);
    const opts = [...document.querySelectorAll('.pods-ask [data-ask-pick]')].map(x => x.innerText);
    out.offered = opts.join(' | ');
    out.doesNotOfferStandard = !opts.some(t => /^Standard/.test(t));
    const growth = [...document.querySelectorAll('.pods-ask [data-ask-pick]')].find(x => /Growth/.test(x.innerText));
    growth.click(); await w(400);
    const box = document.getElementById('giantPromptOverlay');
    out.askedHowMuch = !!box;
    if (box) {
      const inp = box.querySelector('input');
      inp.value = '250';
      const btns = [...box.querySelectorAll('button')];
      btns[btns.length - 1].click();
    }
    await w(900);
    const made = db.pod_rates.find(x => x.service === 'google_ads' && x.tier === 'growth');
    out.added = !!made && made.amount_cents === 25000;
    return out;
  });
  check('every service is on the card, including one with no rate yet',
    r.servicesShown && r.emptySaidSo && r.amountIsAField, JSON.stringify(r));
  check('an amount is typed on the page and payroll follows it',
    r.wrote === 27500 && r.payFollowed, JSON.stringify(r));
  check('so are the tier note and the small print under the card',
    r.noteWrote === 'Retainer SEO' && r.settingWrote === 'Reviewed every 60 days now.',
    JSON.stringify(r));
  check('a field that was not changed writes nothing, and Escape puts it back',
    r.noWriteOnNoChange && r.escapeReverted, JSON.stringify(r));
  check('a rate can be added, and a duplicate of one that exists is never offered',
    r.canAdd && r.doesNotOfferStandard && r.askedHowMuch && r.added, JSON.stringify(r));
});

await step('the words and the capacity are configuration, not code', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const db = window.__mock.db;
    db.pods = [{ id:'pod-c', name:'Pod C', leader_id:'u-1', max_clients:20, opens_at:null, status:'active', position:0 }];
    db.clients.forEach(x => { x.pod_id = null; });
    db.clients.slice(0, 3).forEach(x => { x.pod_id = 'pod-c'; });
    db.pod_assignments = [];
    document.querySelector('.nav-item[data-screen="pods"]').click();
    await w(400);
    window.podState.tab = 'how';
    await window.podsReload();
    await w(900);
    const out = {};
    const body = document.getElementById('pods_body');

    // the limits are read off the pod and the departments, not written out a second time
    const limits = body.innerText;
    out.limitsFromPod = /Pod C[\s\S]{0,40}max 20 clients/.test(limits);
    out.limitsFromDepts = /Google Ads specialist/.test(limits) && /SEO specialist/.test(limits);

    // change the intro, a role and a growth row
    const setField = async (name, i, val) => {
      const el = [...body.querySelectorAll('[data-pods-field="' + name + '"]')]
        .find(e => i == null || e.dataset.i === String(i));
      if (!el) return false;
      el.focus(); el.value = val; el.blur();
      await w(450);
      return true;
    };
    out.introEditable = await setField('introTitle', null, 'Pods, restated.');
    out.roleEditable  = await setField('roleDoes', 1, 'Runs the ads and says so.');
    out.growthEditable = await setField('growthWhat', 0, 'One leader, all the clients.');
    const get = (k) => (db.pod_settings.find(x => x.key === k) || {}).value;
    out.introWrote = (get('intro') || {}).title;
    out.roleWrote = ((get('roles') || [])[1] || {}).does;
    out.growthWrote = ((get('growth') || [])[0] || {}).what;
    // editing one field must not flatten the rest of the list
    out.rolesStillFive = (get('roles') || []).length === 5;
    out.roleLabelKept = ((get('roles') || [])[1] || {}).label === 'GOOGLE ADS';

    // a growth row can be added and the NOW marker follows the real client count
    const before = (get('growth') || []).length;
    body.querySelector('[data-pods-growth-add]').click();
    await w(800);
    out.growthAdded = (get('growth') || []).length === before + 1;
    out.marksNow = /NOW · 3 CLIENTS/.test(document.getElementById('pods_body').innerText);

    // now the capacity, on The team
    window.podState.tab = 'team';
    window.podState.render ? 0 : 0;
    await window.podsReload();
    await w(900);
    const team = document.getElementById('pods_body');
    out.capacityCard = /CAPACITY/.test(team.innerText);
    const idealEl = [...team.querySelectorAll('[data-pods-field="deptIdeal"]')]
      .find(e => e.dataset.id === 'pd-1');
    out.idealIsAField = !!idealEl && idealEl.value === '15';
    // above the maximum is refused, and the field goes back
    idealEl.focus(); idealEl.value = '99'; idealEl.blur();
    await w(500);
    out.refusedAboveMax = (db.pay_departments.find(d => d.id === 'pd-1') || {}).ideal_accounts === 15
      && idealEl.value === '15';
    idealEl.focus(); idealEl.value = '12'; idealEl.blur();
    await w(500);
    out.idealWrote = (db.pay_departments.find(d => d.id === 'pd-1') || {}).ideal_accounts;
    // emptying it means "not measured", which is a real answer and not zero
    const maxEl = [...team.querySelectorAll('[data-pods-field="deptMax"]')]
      .find(e => e.dataset.id === 'pd-2');
    maxEl.focus(); maxEl.value = ''; maxEl.blur();
    await w(500);
    out.emptyIsNull = (db.pay_departments.find(d => d.id === 'pd-2') || {}).max_accounts === null;
    // and the pod's own size
    const podEl = team.querySelector('[data-pods-field="podMax"]');
    podEl.focus(); podEl.value = '25'; podEl.blur();
    await w(600);
    out.podMaxWrote = (db.pods.find(p => p.id === 'pod-c') || {}).max_clients;
    out.columnFollowed = /3 \/ 25/.test(document.getElementById('pods_pods').innerText);
    return out;
  });
  check('the capacity limits are read off the pod and the departments, not written twice',
    r.limitsFromPod && r.limitsFromDepts, JSON.stringify(r));
  check('the intro, a role and a growth row are all edited on the page',
    r.introWrote === 'Pods, restated.' && r.roleWrote === 'Runs the ads and says so.'
      && r.growthWrote === 'One leader, all the clients.', JSON.stringify(r));
  check('editing one field in a list leaves the rest of the list alone',
    r.rolesStillFive && r.roleLabelKept, JSON.stringify(r));
  check('rows can be added, and the growth plan still marks where the pod actually is',
    r.growthAdded && r.marksNow, JSON.stringify(r));
  check('a department\'s capacity is edited on The team, and an impossible one refused',
    r.capacityCard && r.idealIsAField && r.refusedAboveMax && r.idealWrote === 12,
    JSON.stringify(r));
  check('an empty cap means not measured, not zero, and the pod size feeds the columns',
    r.emptyIsNull && r.podMaxWrote === 25 && r.columnFollowed, JSON.stringify(r));
});

await step('a pod has a team, and it is managed where it is read', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const db = window.__mock.db;
    db.pods = [
      { id:'pod-t1', name:'Pod One', leader_id:'u-me', max_clients:20, opens_at:null, status:'active', position:0 },
      { id:'pod-t2', name:'Pod Two', leader_id:null,  max_clients:20, opens_at:null, status:'active', position:1 }];
    db.clients.forEach(x => { x.pod_id = null; });
    const c0 = db.clients[0]; c0.pod_id = 'pod-t1';
    db.pod_assignments = [
      { id:'ta-1', client_id:c0.id, label:null, service:'seo', tier:null, specialist_id:'u-2', is_internal:false, ended_at:null }];
    db.pod_members = [{ pod_id:'pod-t1', profile_id:'u-me' }, { pod_id:'pod-t1', profile_id:'u-2' }];
    document.querySelector('.nav-item[data-screen="pods"]').click();
    await w(400);
    window.podState.tab = 'team';
    window.podState.teamScope = null;
    await window.podsReload();
    await w(900);
    const out = {};
    const body = () => document.getElementById('pods_body');

    // it opens on a pod, not on the whole workspace
    const scopes = [...body().querySelectorAll('[data-pods-scope]')].map(b => b.textContent.trim());
    out.scopes = scopes.join(' | ');
    out.opensOnAPod = (body().querySelector('[data-pods-scope].on') || {}).dataset
      ? body().querySelector('[data-pods-scope].on').dataset.podsScope === 'pod-t1' : false;
    out.cards = body().querySelectorAll('.p-card').length;     // 2 people + Capacity card
    out.leaderMarked = /leads Pod One/.test(body().innerText);
    out.rosterIsBigger = window.podState.roster.length > 2;

    // the empty pod says so rather than showing everybody
    body().querySelector('[data-pods-scope="pod-t2"]').click();
    await w(600);
    out.emptyPodSaidSo = /Nobody in this pod yet/.test(body().innerText);
    // only the Capacity card is left -- no person cards at all
    out.emptyPodCards = body().querySelectorAll('.p-card').length - 1;

    // somebody can be added to it, and only people who are not in it already are offered
    body().querySelector('[data-pods-addmate="pod-t2"]').click();
    await w(400);
    let opts = [...document.querySelectorAll('.pods-ask [data-ask-pick]')];
    out.offersInvite = opts.some(o => /Invite somebody new/.test(o.innerText));
    const pick = opts.find(o => o.dataset.askPick === 'u-3');
    out.offersOthers = !!pick;
    pick.click();
    await w(900);
    out.added = db.pod_members.some(m => m.pod_id === 'pod-t2' && m.profile_id === 'u-3');
    out.nowInPodTwo = /Team Member 3/.test(body().innerText);

    // and taken out again, having been told what it costs
    let asked = '';
    const orig = window.giantConfirmWarn;
    window.giantConfirmWarn = (t, m) => { asked = t + ' :: ' + m; return Promise.resolve(true); };
    body().querySelector('[data-pods-dropmate="u-3"]').click();
    await w(900);
    window.giantConfirmWarn = orig;
    out.asked = asked;
    out.removed = !db.pod_members.some(m => m.pod_id === 'pod-t2' && m.profile_id === 'u-3');

    // pay is edited on the card
    body().querySelector('[data-pods-scope="pod-t1"]').click();
    await w(700);
    const amt = [...body().querySelectorAll('[data-pods-field="payAmount"]')]
      .find(e => e.dataset.id === 'u-2');
    out.payIsAField = !!amt;
    const payBefore = window.podState.__totalPay;
    amt.focus(); amt.value = '500'; amt.blur();
    await w(700);
    out.payWrote = (db.team_pay.find(t => t.profile_id === 'u-2') || {}).base_amount;
    out.payrollFollowed = window.podState.__totalPay !== payBefore;

    // changing the base type away from hourly clears the hours it no longer means
    db.team_pay.find(t => t.profile_id === 'u-2').base_type = 'hourly';
    db.team_pay.find(t => t.profile_id === 'u-2').weekly_hours = 20;
    await window.podsReload(); await w(800);
    const selBase = [...body().querySelectorAll('[data-pods-pay="base"]')]
      .find(e => e.dataset.id === 'u-2');
    out.hoursShownWhenHourly = !!body().querySelector('[data-pods-field="payHours"]');
    selBase.value = 'fixed_weekly';
    selBase.dispatchEvent(new Event('change', { bubbles: true }));
    await w(900);
    const row = db.team_pay.find(t => t.profile_id === 'u-2');
    out.baseWrote = row.base_type;
    out.hoursCleared = row.weekly_hours === null;

    // somebody with no pay row at all is offered one rather than shown a blank
    const noPay = window.podState.roster.find(pp =>
      !db.team_pay.some(t => t.profile_id === pp.id));
    out.someoneHasNoPay = !!noPay;
    body().querySelector('[data-pods-scope="all"]').click();
    await w(900);
    out.offersSetPay = !!body().querySelector('[data-pods-setpay]');
    return out;
  });
  check('the tab opens on a pod and shows only its people, with the leader marked',
    r.opensOnAPod && r.cards === 3 && r.leaderMarked && r.rosterIsBigger, JSON.stringify(r));
  check('an empty pod says so instead of listing the whole workspace',
    r.emptyPodSaidSo && r.emptyPodCards === 0 && /Pod One|Pod Two/.test(r.scopes),
    JSON.stringify(r));
  check('somebody is added to a pod, or invited if they have no account yet',
    r.offersOthers && r.offersInvite && r.added && r.nowInPodTwo, JSON.stringify(r));
  check('and taken out again, after being told their accounts stay assigned',
    r.removed && /stay assigned|hold no accounts/.test(r.asked), JSON.stringify(r));
  check('a base is edited on the card and payroll follows it',
    r.payIsAField && r.payWrote === 500 && r.payrollFollowed, JSON.stringify(r));
  check('hours exist only while somebody is hourly, and are cleared when they stop being',
    r.hoursShownWhenHourly && r.baseWrote === 'fixed_weekly' && r.hoursCleared,
    JSON.stringify(r));
  check('somebody with no pay set is offered one rather than shown a blank',
    r.someoneHasNoPay && r.offersSetPay, JSON.stringify(r));
});

// Back to a manager, so anything after this sees the board it expects.
await page.evaluate(async () => {
  window.giantCurrentProfile.role = 'owner';
  await window.podsReload();
});

// Matthew, 2026-09-16: "tracking of the payment renewal dates for all of our clients... this
// has been an issue recently where a client has canceled and they still have been charged."
// The case in his message is the one this has to catch: work ends 1 Oct, card is charged 2 Oct.
await step('a client charged after their last day is flagged before it happens', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const db = window.__mock.db;
    const iso = (offsetDays) => { const d = new Date(); d.setHours(0,0,0,0);
      d.setDate(d.getDate() + offsetDays); return d.toISOString().slice(0, 10); };
    db.pods = [{ id:'pod-b', name:'Pod B', leader_id:'u-me', max_clients:20, opens_at:null, status:'active', position:0 }];
    db.clients.forEach(c => { c.pod_id = null; c.ends_on = null; c.next_charge_on = null;
                              c.billing_off_at = null; c.billing_off_by = null; });
    const [paul, wpf, fine, quiet] = db.clients;
    // Paul Davis: last day the 1st, charge lands the 2nd. The whole point.
    paul.pod_id = 'pod-b'; paul.mrr_cents = 250000;
    paul.ends_on = iso(14); paul.next_charge_on = iso(15);
    // WPF: ended already, nobody confirmed the billing was turned off
    wpf.pod_id = 'pod-b'; wpf.ends_on = iso(-3);
    // an ordinary client renewing soon, no end date: informational, not a problem
    fine.pod_id = 'pod-b'; fine.next_charge_on = iso(5);
    // and one with nothing set at all
    quiet.pod_id = 'pod-b';
    db.pod_assignments = [];
    document.querySelector('.nav-item[data-screen="pods"]').click();
    await w(400);
    await window.podsReload();
    await w(700);
    const out = {};
    // Reached by clicking the tab, not by setting podState. Setting the tab directly hid
    // that the tab had never been added to the bar at all -- the view rendered fine and
    // was unreachable, which is the same as not existing.
    const tabBtn = document.querySelector('[data-pods-tab="renewals"]');
    out.tabExists = !!tabBtn;
    out.tabCount = tabBtn ? tabBtn.textContent.replace(/\D+/g, '') : '';
    if (tabBtn) tabBtn.click();
    await w(900);
    const body = document.getElementById('pods_body');
    const txt = () => document.getElementById('pods_body').innerText;

    out.flagsPaul = new RegExp(paul.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(txt())
      && /next charge/i.test(txt());
    out.saysTurnItOff = /turn the Stripe payment off/i.test(txt());
    out.flagsEnded = /nobody has confirmed/i.test(txt());
    // the tab itself carries the count, so it is visible without opening it
    // a client with no dates is still reachable rather than invisible
    out.listsUndated = /NO DATES YET/.test(txt());

    // the dates are editable in place
    const nc = [...body.querySelectorAll('[data-pods-field="nextCharge"]')]
      .find(e => e.dataset.id === quiet.id);
    out.dateIsAField = !!nc;
    nc.focus(); nc.value = iso(3); nc.blur();
    await w(800);
    out.dateWrote = (db.clients.find(c => c.id === quiet.id) || {}).next_charge_on === iso(3);

    // "know for sure that we have turned off their Stripe payment"
    const orig = window.giantConfirmWarn; let asked = '';
    window.giantConfirmWarn = (t, m) => { asked = t + ' :: ' + m; return Promise.resolve(true); };
    document.querySelector('[data-pods-billoff="' + paul.id + '"]').click();
    await w(900);
    window.giantConfirmWarn = orig;
    out.asked = asked;
    const p2 = db.clients.find(c => c.id === paul.id);
    out.stamped = !!p2.billing_off_at && p2.billing_off_by === window.giantSession.user.id;
    out.clearedAfterOff = !/turn the Stripe payment off/i.test(txt());

    // changing a date afterwards must drop that confirmation — it was about the old arrangement
    const nc2 = [...document.getElementById('pods_body').querySelectorAll('[data-pods-field="nextCharge"]')]
      .find(e => e.dataset.id === paul.id);
    nc2.focus(); nc2.value = iso(40); nc2.blur();
    await w(800);
    out.confirmationDropped = (db.clients.find(c => c.id === paul.id) || {}).billing_off_at === null;

    // and the dashboard says it too, without anybody opening this tab
    window.podState.tab = 'dash';
    await window.podsReload();
    await w(800);
    out.onDashboard = /turn the Stripe payment off|nobody has confirmed/i.test(
      document.getElementById('pods_body').innerText);
    return out;
  });
  check('the client whose charge lands after their last day is named, with what to do',
    r.flagsPaul && r.saysTurnItOff, JSON.stringify(r));
  check('so is one whose last day has passed with the billing still on',
    r.flagsEnded && r.listsUndated, JSON.stringify(r));
  check('and the tab is actually in the bar, carrying the count',
    r.tabExists && r.tabCount === '3', JSON.stringify(r));
  check('the dates are typed straight onto the board',
    r.dateIsAField && r.dateWrote, JSON.stringify(r));
  check('confirming the payment is off is stamped with who said so, and clears the flag',
    r.stamped && /actually cancelled/i.test(r.asked) && r.clearedAfterOff, JSON.stringify(r));
  check('and changing a date afterwards drops that confirmation',
    r.confirmationDropped, JSON.stringify(r));
  check('the warning reaches the dashboard, not only its own tab',
    r.onDashboard, JSON.stringify(r));
});

// A message from Mave appeared on Needs you labelled "Nishchay" -- the viewer's own name.
// channels.name is written once and names everyone EXCEPT the creator, so it is right only
// for whoever opened the conversation and wrong for the person being messaged.
await step('a DM on Needs you is named for the other person, never for you', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const db = window.__mock.db;
    const me = window.giantSession.user.id;
    const myName = (db.profiles.find(p => p.id === me) || {}).full_name;
    // a group DM somebody else opened: stored under the viewer's own name, no dm_pair
    const ch = db.channels.find(c => c.is_dm && c.name === myName && !c.dm_pair);
    const out = { myName, found: !!ch };
    if (!ch) return out;
    out.storedName = ch.name;
    const others = db.channel_members.filter(m => m.channel_id === ch.id && m.profile_id !== me)
      .map(m => (db.profiles.find(p => p.id === m.profile_id) || {}).full_name).filter(Boolean);
    out.othersInChannel = others.slice(0, 3);

    // put a mention from one of them on it, so it lands on Needs you
    const author = db.channel_members.find(m => m.channel_id === ch.id && m.profile_id !== me).profile_id;
    db.messages.push({ id: 'dmbug-1', channel_id: ch.id, author_id: author,
      body: 'hey @Nishchay can you look at this', created_at: new Date().toISOString(),
      parent_id: null, reply_count: 0, flagged: false });
    db.inbox_actions = [];

    await window.nc_computeNeedsYou();
    await w(900);
    const rows = [...document.querySelectorAll('#nc_cardNeedsBody .nc_ch-item')];
    const row = rows.find(x => x.dataset.ncChannelId === ch.id);
    out.rowFound = !!row;
    if (row) {
      out.rowLabel = [...row.querySelectorAll('span')].map(sp => sp.textContent.trim())
        .filter(Boolean).join(' | ');
      out.showsMyOwnName = new RegExp(myName.split(' ')[0], 'i').test(out.rowLabel);
      out.namesSomeoneElse = others.some(n => out.rowLabel.includes(n.split(' ')[0]));
    }
    return out;
  });
  check('the fixture has a DM stored under the viewer\'s own name, as production does',
    r.found && r.storedName === r.myName, JSON.stringify(r));
  check('and Needs you does not label it with your own name',
    r.rowFound && r.showsMyOwnName === false, JSON.stringify(r));
  check('it names somebody actually in the conversation instead',
    r.namesSomeoneElse === true, JSON.stringify(r));
});

// A task link pasted into a chat opened a second copy of the whole app in a new tab, then
// booted it just to show a panel. Every internal link did, because they render as ordinary
// anchors with target="_blank".
await step('a link to Giant opens in Giant, not in a second copy of it', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const out = {};
    // what a link in a message actually looks like
    const host = document.createElement('div');
    host.innerHTML = '<a id="probeTask" target="_blank" rel="noopener" '
      + 'href="https://giant.reachgiant.com/app?task=t-probe">the task</a>'
      + '<a id="probeExternal" target="_blank" href="https://example.com/x">outside</a>'
      + '<a id="probeOnboard" target="_blank" '
      + 'href="https://giant.reachgiant.com/onboard/abc123">onboarding form</a>';
    document.body.appendChild(host);

    let openedWith = null;
    const realOpen = window.openTaskDetailPanel;
    window.openTaskDetailPanel = (id) => { openedWith = id; };
    // nothing must reach the browser's own navigation
    let navigated = null;
    const realAssign = window.location.assign;
    out.hasHandler = typeof realOpen === 'function';

    const fire = (id) => {
      const el = document.getElementById(id);
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    out.taskPrevented = fire('probeTask');
    out.openedWith = openedWith;

    // an outside link is left completely alone
    out.externalPrevented = fire('probeExternal');

    // and so is a standalone page that genuinely has to load as its own document
    openedWith = null;
    out.onboardPrevented = fire('probeOnboard');
    out.onboardDidNotOpenPanel = openedWith === null;

    // a modified click still means "new tab" -- the choice is not taken away
    const el = document.getElementById('probeTask');
    const meta = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    el.dispatchEvent(meta);
    out.metaClickLeftAlone = !meta.defaultPrevented;

    window.openTaskDetailPanel = realOpen;
    host.remove();
    return out;
  });
  check('clicking a task link opens the panel here instead of a new tab',
    r.hasHandler && r.taskPrevented && r.openedWith === 't-probe', JSON.stringify(r));
  check('a link to anywhere else is left exactly as it was',
    r.externalPrevented === false, JSON.stringify(r));
  check('so is a standalone page that has to load as its own document',
    r.onboardPrevented === false && r.onboardDidNotOpenPanel, JSON.stringify(r));
  check('and cmd-click still opens a new tab, because that is what it means',
    r.metaClickLeftAlone, JSON.stringify(r));
});

// The loop behind "Maximum call stack size exceeded", which Luke saw for three days under
// three different sets of frames. Removing a channel unsubscribes it, which leaves the
// topic, which supabase-js reports back through the SAME status callback as CLOSED -- so
// handling CLOSED by removing the channel asks for the channel to be removed again.
await step('a dead realtime channel is torn down once, not forever', async () => {
  const r = await page.evaluate(async () => {
    const w = ms => new Promise(res => setTimeout(res, ms));
    const hook = window.__giantNotifSub;
    const out = { exposed: !!hook };
    if (!hook) return out;

    // Stand in for supabase: removeChannel reports CLOSED back through the status callback,
    // exactly as the real one does. Before the guard this recursed until the stack ran out.
    let statusCb = null, removeCalls = 0, depth = 0, maxDepth = 0, overflowed = false;
    const sb = window.giantSupabase;
    const realChannel = sb.channel.bind(sb);
    const realRemove = sb.removeChannel.bind(sb);
    sb.channel = () => ({
      on() { return this; },
      subscribe(cb) { statusCb = cb; return this; },
      topic: 'notifications-test',
    });
    sb.removeChannel = (ch) => {
      removeCalls++;
      depth++; if (depth > maxDepth) maxDepth = depth;
      if (depth > 40) { overflowed = true; depth--; return; }
      // this is the part that used to bite: the teardown reports itself
      try { if (statusCb) statusCb('CLOSED'); } catch (e) { overflowed = true; }
      depth--;
    };

    // From a known state: it has already subscribed for real at boot, so subscribe()
    // would return at its own guard and the check would pass having done nothing.
    hook.__resetForTest();
    hook.subscribe();
    out.subscribed = typeof statusCb === 'function';
    if (statusCb) statusCb('CHANNEL_ERROR');   // the channel dies
    await w(200);

    out.removeCalls = removeCalls;
    out.maxDepth = maxDepth;
    out.overflowed = overflowed;
    out.tearingDown = hook.status().tearingDown;

    sb.channel = realChannel;
    sb.removeChannel = realRemove;
    hook.__resetForTest();
    return out;
  });
  check('the notification channel exposes its teardown so this can be checked at all',
    r.exposed && r.subscribed, JSON.stringify(r));
  check('a dead channel is removed exactly once, and removing it does not remove it again',
    r.removeCalls === 1 && r.maxDepth === 1 && r.overflowed === false, JSON.stringify(r));
  check('and it stays marked as tearing down until the retry, so nothing re-enters',
    r.tearingDown === true, JSON.stringify(r));
});

// Chat stopped being new a while ago, and Archive is scaffolding nobody but the in-house
// dev has any use for.
await step('Chat has no NEW badge, and Archive is for the in-house dev alone', async () => {
  const r = await page.evaluate(() => {
    const out = {};
    const chat = document.querySelector('.nav-item[data-screen="newchat"]');
    out.chatExists = !!chat;
    out.newBadge = chat ? chat.querySelectorAll('.badge-new').length : -1;
    // the unread count is a different badge and must survive
    out.unreadBadgeKept = !!document.getElementById('nc_sidebarBadgeChat');

    const label = document.querySelector('[data-navgroup="archive"]');
    const rail  = document.querySelector('[data-navgroup-body="archive"]');
    out.bothGated = !!label && !!rail
      && label.getAttribute('data-role-only') === 'inhouse_dev'
      && rail.getAttribute('data-role-only') === 'inhouse_dev';

    const was = document.body.className;
    const seen = {};
    ['role-owner', 'role-manager', 'role-member', 'role-client', 'role-inhouse_dev'].forEach(c => {
      document.body.className = c;
      seen[c] = getComputedStyle(label).display !== 'none';
    });
    document.body.className = was;
    out.seen = seen;
    // an owner outranks the in-house dev, so a data-role-min gate would have let them in
    out.hiddenFromOwner = seen['role-owner'] === false;
    out.shownToInhouseDev = seen['role-inhouse_dev'] === true;
    out.hiddenFromEveryoneElse = !seen['role-manager'] && !seen['role-member'] && !seen['role-client'];
    return out;
  });
  check('the NEW badge is off Chat, and the unread count is not',
    r.chatExists && r.newBadge === 0 && r.unreadBadgeKept, JSON.stringify(r));
  check('Archive is gated on both the label and the rail, or half of it would still show',
    r.bothGated, JSON.stringify(r));
  check('only the in-house dev sees it — an owner does not, which a role floor could not do',
    r.shownToInhouseDev && r.hiddenFromOwner && r.hiddenFromEveryoneElse, JSON.stringify(r));
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
