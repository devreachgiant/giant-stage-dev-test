/* DMs with accounts that no longer exist.  Run:  node tools_dead_dm_check.mjs

   Three rows in the sidebar read "Unknown member". They were DM channels whose only
   channel_members row was the viewer's own -- left behind when the other account went.
   Nothing can be done with them: there is nobody to reply to. Three rows named after
   nobody read as a fault in the list rather than as history.

   Nothing is deleted. The channels and their messages stay and stay searchable; the
   sidebar declines to list a conversation it cannot name.

   THE HALF THAT MATTERS MORE is the one that must NOT happen: "not in the profile
   cache" has two causes -- the person is gone, or we failed to ask. The error from that
   lookup was being discarded, so the two were indistinguishable, and a rule that hides
   unresolved DMs would take LIVE conversations off the screen the moment the request
   failed. Both cases are driven here.
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
  catch (e) { check(label, false, 'threw: ' + String(e.message || e).slice(0, 180)); return null; }
};

const browser = await chromium.launch();

/* The fixtures are built before the app runs, so the sidebar's first render already
   sees them -- seeding afterwards would measure a re-render instead of the real path. */
const SEED = `
  (function(){
    const DB = window.__mockDB, ME = (DB.channel_members[0]||{}).profile_id;
    const mk = (id, name) => { DB.channels.push({ id, name, slug: id, description: null,
      is_private: true, is_dm: true, dm_pair: null, kind: 'dm', section_id: null,
      position: 0, created_by: ME, created_at: new Date().toISOString(), emoji: null }); };

    // 1. Nobody else is a member at all -- the three real ones in the sidebar.
    mk('ch-dm-orphan', 'Nish');
    DB.channel_members.push({ channel_id: 'ch-dm-orphan', profile_id: ME,
      joined_at: new Date().toISOString(), last_read_at: new Date().toISOString() });

    // 2. A member row exists, but that profile does not.
    mk('ch-dm-ghost', 'Ghost');
    DB.channel_members.push({ channel_id: 'ch-dm-ghost', profile_id: ME,
      joined_at: new Date().toISOString(), last_read_at: new Date().toISOString() });
    DB.channel_members.push({ channel_id: 'ch-dm-ghost', profile_id: 'no-such-profile-id',
      joined_at: new Date().toISOString(), last_read_at: new Date().toISOString() });

    // 3. An ordinary, live DM, which must be unaffected by any of this.
    const mate = (DB.profiles.find(p => p.id !== ME) || {}).id;
    mk('ch-dm-live', 'Live one');
    DB.channel_members.push({ channel_id: 'ch-dm-live', profile_id: ME,
      joined_at: new Date().toISOString(), last_read_at: new Date().toISOString() });
    DB.channel_members.push({ channel_id: 'ch-dm-live', profile_id: mate,
      joined_at: new Date().toISOString(), last_read_at: new Date().toISOString() });
    window.__seededMate = mate;
  })();
`;

async function openChat(breakProfileLookup) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  await page.route('**/@supabase/supabase-js@2*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
  await page.route('**://*.supabase.co/**', r => r.abort());
  await page.addInitScript(({ seed, breakIt }) => {
    const run = () => {
      if (!window.__mockDB || !(window.__mockDB.channel_members || []).length) return false;
      // eslint-disable-next-line no-eval
      eval(seed);
      if (breakIt) {
        /* Make the profile lookup FAIL, the way a dropped request does. Hiding must not
           happen on an answer we never got. */
        const realFrom = window.giantSupabase && window.giantSupabase.from;
        window.__breakArmed = true;
      }
      return true;
    };
    const t = setInterval(() => { if (run()) clearInterval(t); }, 60);
  }, { seed: SEED, breakIt: !!breakProfileLookup });
  await page.goto(BASE + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#view-app.on', { timeout: 30000 });
  await page.waitForTimeout(2600);
  await page.evaluate(() => document.querySelector('#appSidebar .nav-item[data-screen="newchat"]')?.click());
  await page.waitForTimeout(3200);
  return { ctx, page };
}

const sidebarRows = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-nc-dm-channel-id]')];
  return {
    ids: rows.map(r => r.dataset.ncDmChannelId),
    unknownLabels: rows.filter(r => /unknown member/i.test(r.textContent || '')).length,
    total: rows.length
  };
});

await step('a DM with an account that is gone is not listed', async () => {
  const { ctx, page } = await openChat(false);
  const seeded = await page.evaluate(() => !!(window.__mockDB.channels || []).find(c => c.id === 'ch-dm-orphan'));
  check('the fixtures were seeded before the first render', seeded, String(seeded));

  const rows = await sidebarRows(page);
  // The three in the real sidebar: only the viewer's own membership row remains.
  check('the one with no other member is gone from the list',
    !rows.ids.includes('ch-dm-orphan'), rows.ids.filter(x => /orphan/.test(x)).join(',') || 'absent');
  check('so is the one whose member has no profile',
    !rows.ids.includes('ch-dm-ghost'), rows.ids.filter(x => /ghost/.test(x)).join(',') || 'absent');
  check('the live DM is still there', rows.ids.includes('ch-dm-live'), 'present=' +
    rows.ids.includes('ch-dm-live'));
  // The symptom that prompted this.
  check('and nothing reads "Unknown member" any more', rows.unknownLabels === 0,
    rows.unknownLabels + ' such rows');
  check('the rest of the list is untouched', rows.total > 3, rows.total + ' DM rows');
  await ctx.close();
});

await step('nothing is deleted, only unlisted', async () => {
  const { ctx, page } = await openChat(false);
  const still = await page.evaluate(() => ({
    channel: !!(window.__mockDB.channels || []).find(c => c.id === 'ch-dm-orphan'),
    member: !!(window.__mockDB.channel_members || []).find(m => m.channel_id === 'ch-dm-orphan')
  }));
  /* The decision was to keep the data and filter in the module. A check that only
     looked at the sidebar would pass just as well if the rows had been deleted. */
  check('the channel row is still in the database', still.channel, String(still.channel));
  check('and so is its membership', still.member, String(still.member));
  await ctx.close();
});

await step('a failed lookup hides nothing', async () => {
  /* The dangerous half. "Not in the cache" after a request that never answered means
     nothing at all, and hiding on it would take live conversations off the screen --
     which is exactly why the previous version labelled rather than dropped.

     Only the by-id lookup is broken, and only after the app is up: hiding the whole
     profiles table stops Giant booting at all, which measures nothing. */
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  await page.route('**/@supabase/supabase-js@2*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }));
  await page.route('**://*.supabase.co/**', r => r.abort());
  await page.addInitScript((seed) => {
    const t = setInterval(() => {
      if (!window.__mockDB || !(window.__mockDB.channel_members || []).length) return;
      clearInterval(t);
      // eslint-disable-next-line no-eval
      eval(seed);
    }, 60);
  }, SEED);
  await page.goto(BASE + '/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#view-app.on', { timeout: 30000 });
  await page.waitForTimeout(2600);

  const armed = await page.evaluate(() => {
    const sb = window.giantSupabase;
    if (!sb || !sb.from) return false;
    const realFrom = sb.from.bind(sb);
    sb.from = (table, ...rest) => {
      const b = realFrom(table, ...rest);
      if (table !== 'profiles') return b;
      let byId = false;
      const wrap = (t) => new Proxy(t, { get(o, prop, r) {
        const v = Reflect.get(o, prop, r);
        if (prop === 'then' && byId) {
          const failed = Promise.resolve({ data: null, error: { message: 'lookup failed' } });
          return failed.then.bind(failed);
        }
        if (typeof v !== 'function') return v;
        return (...a) => {
          if (prop === 'in' && a[0] === 'id') byId = true;
          const out = v.apply(o, a);
          return (out && typeof out === 'object' && typeof out.then === 'function') ? wrap(out) : out;
        };
      }});
      return wrap(b);
    };
    return true;
  });
  check('the by-id profile lookup can be made to fail', armed, String(armed));

  /* The live partner has to be ABSENT from the cache, or the by-id lookup failing
     changes nothing and this passes for the wrong reason -- which it did: hiding on
     "unresolved" regardless of whether the lookup worked passed all eleven checks.
     ncProfilesProbe is the same object the renderer reads, so removing the entry puts
     the renderer in the state a failed lookup actually leaves it in. */
  await page.evaluate(() => document.querySelector('#appSidebar .nav-item[data-screen="newchat"]')?.click());
  await page.waitForTimeout(3000);
  const emptied = await page.evaluate(() => {
    const cache = window.ncProfilesProbe;
    const mate = window.__seededMate;
    if (!cache || !mate || !cache[mate]) return false;
    delete cache[mate];
    return true;
  });
  check('the live partner was taken out of the cache', emptied, String(emptied));

  /* A REAL re-render, not a screen switch. Clicking away and back leaves the sidebar
     exactly as it was, so the rows measured afterwards were the ones drawn BEFORE the
     cache was emptied -- which is why this passed against the dangerous version. */
  const rerendered = await page.evaluate(async () => {
    if (typeof window.nc_loadChannels !== 'function') return false;
    await window.nc_loadChannels();
    return true;
  });
  check('the sidebar was genuinely re-rendered', rerendered, String(rerendered));
  await page.waitForTimeout(2600);
  const rows = await sidebarRows(page);
  /* Whether the renderer was ACTUALLY in the state this is meant to test. Without
     this, "the live DM survives" passes just as well when the cache quietly refilled
     and the failed lookup never mattered -- which is what happened the first time. */
  const state = await page.evaluate(() => ({
    mateInCache: !!(window.ncProfilesProbe || {})[window.__seededMate],
    mate: window.__seededMate
  }));
  check('the partner was still missing from the cache when it rendered',
    !state.mateInCache, 'inCache=' + state.mateInCache);
  check('the live DM survives a failed lookup', rows.ids.includes('ch-dm-live'),
    'present=' + rows.ids.includes('ch-dm-live'));
  check('and the list is not emptied', rows.total > 3, rows.total + ' DM rows');
  await ctx.close();
});

for (const r of results) console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   ' + r.detail : ''));
const bad = results.filter(r => !r.pass);
console.log('\n' + (results.length - bad.length) + ' of ' + results.length + ' checks passed');
console.log(bad.length ? 'RESULT: ' + bad.length + ' FAILED' : 'RESULT: clean');
await browser.close();
server.close();
process.exit(bad.length ? 1 : 0);
