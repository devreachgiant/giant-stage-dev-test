/* Stand-in for @supabase/supabase-js, served in place of the CDN script so the
   timing is exactly right: window.supabase exists before the app's own scripts
   run, and nothing ever reaches the real project.

   It implements the slice of PostgREST that New Chat actually uses (see
   __mock.unsupported for anything it turns out not to). Fixtures below mirror the
   documented real shape: 53 active clients, 1 home + 11 team + 14 client channels
   across 11 client threads (Maribou deliberately holding two Generals), 80 DMs. */
(function () {
  'use strict';

  // ── deterministic pseudo-random, so two runs are comparable ──────────────
  let _s = 987654321;
  const rnd = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const iso = (daysAgo, i) => new Date(Date.UTC(2026, 7, 24) - daysAgo * 864e5 - i * 6e5).toISOString();

  // 4x3 grey SVG, inline so nothing in a test run ever leaves the page.
  // Every third profile has a picture, so the harness can tell "renders the photo" from
  // "renders a coloured circle" -- with avatar_url null everywhere, the bug where a photo
  // rendered as an empty circle was invisible to it.
  const AVATAR_IMG = (n) => 'data:image/svg+xml;utf8,'
    + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">'
      + '<rect width="64" height="64" fill="hsl(' + (n * 47 % 360) + ',45%,42%)"/></svg>');

  const PLACEHOLDER_IMG = 'data:image/svg+xml;utf8,'
    + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">'
      + '<rect width="400" height="300" fill="#3a3a3a"/></svg>');

  const log = { queries: [], unsupported: [], writes: [], realtime: [], storage: [], rpc: [] };

  // ── fixtures ─────────────────────────────────────────────────────────────
  const ME = 'u-me';
  const DB = {};

  const CLIENT_NAMES = ['Maribou', 'Fortess DG', 'Northwind Health', 'Rally Coffee', 'Beacon Legal',
    'Kite & Co', 'Verdant Landscapes', 'Ironside Fitness', 'Lumen Dental', 'Harbour Freight Co',
    'Sable Interiors', 'Copper Lane Bakery', 'Atlas Roofing', 'Brightwater Pools', 'Cedar Grove Vet',
    'Dune Surf School', 'Ember Kitchens', 'Foxglove Florist', 'Granite Accounting', 'Halcyon Spa',
    'Indigo Tattoo', 'Juniper Childcare', 'Kestrel Aviation', 'Larkspur Events', 'Meridian Solar',
    'Nimbus IT', 'Olive Branch Catering', 'Pinnacle Mortgages', 'Quarry Stoneworks', 'Redwood Removals',
    'Saltbox Storage', 'Tidewater Marine', 'Umbra Photography', 'Vellum Print', 'Willow Physio',
    'Xenon Signage', 'Yarrow Herbals', 'Zephyr Windows', 'Anchor Plumbing', 'Bramble Brewing',
    'Cobalt Security', 'Driftwood Cabins', 'Elm Street Optics', 'Fernway Travel', 'Glasshouse Studio',
    'Hollow Rock Climbing', 'Isle Cheese Co', 'Jetty Seafood', 'Knotwork Joinery', 'Loamfield Farms',
    'Mosswood Books', 'Nettle Tea Rooms', 'Oakmont Golf'];

  DB.clients = CLIENT_NAMES.map((name, i) => ({
    id: 'c-' + (i + 1), name, status: 'active',
    avatar_bg: '#' + (0x223344 + i * 0x050301).toString(16).slice(0, 6), avatar_fg: '#e8e8e8',
    industry: pick(['Retail', 'Health', 'Legal', 'Trades', 'Hospitality']),
    company_website: 'https://' + name.toLowerCase().replace(/[^a-z]+/g, '') + '.example',
    timezone: 'Europe/London', working_notes: null, keywords: [], mrr_cents: 120000 + i * 5000,
    contact_name: 'Contact ' + (i + 1), contact_email: 'c' + (i + 1) + '@example.com', contact_phone: null,
    created_at: iso(400 - i, 0)
  }));

  // 80 counterparties, so the 80 DMs are one real pair each rather than repeats.
  DB.profiles = [{
    id: ME, email: 'hello@lukasgriffin.com', full_name: 'Nishchay Pandya', display_name: 'Nishchay',
    role: 'owner', title: 'Founder', bio: null, avatar_url: null, avatar_bg: '#4A2424',
    avatar_fg: '#F0A0A0', onboarded_at: iso(300, 0)
  }];
  for (let i = 1; i <= 80; i++) {
    DB.profiles.push({
      id: 'u-' + i, email: 'user' + i + '@reachgiant.com', full_name: 'Team Member ' + i,
      display_name: 'Member ' + i,
      avatar_url: i % 3 === 0 ? AVATAR_IMG(i) : null,
      role: i === 1 ? 'manager' : i === 2 ? 'inhouse_dev' : i <= 6 ? 'manager' : 'member',
      title: 'Specialist', bio: null,
      avatar_bg: '#2' + (i % 9) + '3' + (i % 7) + '4' + (i % 5), avatar_fg: '#eaeaea',
      // Two deactivated accounts. They keep their profile row and their name on every
      // message they ever wrote -- that is the point of the column -- so a list that
      // filters them and a cache that does not are both correct, and the harness can
      // only tell the difference if some exist.
      deactivated_at: (i === 4 || i === 11) ? iso(30, i) : null,
      onboarded_at: iso(200, i)
    });
  }

  // channels: 1 home, 11 team, 14 client_dept over 11 clients, 80 dm
  DB.channels = [];
  const chan = (o) => { DB.channels.push(Object.assign({
    id: null, name: '', slug: '', description: null, is_private: false, is_dm: false, dm_pair: null,
    emoji: null, position: DB.channels.length, section_id: null, kind: 'team_channel',
    client_id: null, department: null, color: null, is_group: false, created_at: iso(300, DB.channels.length)
  }, o)); return o.id; };

  chan({ id: 'ch-home', name: 'home', slug: 'home', kind: 'home' });
  ['general', 'announcements', 'design', 'development', 'sales', 'support',
    'random', 'wins', 'ops', 'recruiting', 'finance'].forEach((n, i) =>
    chan({ id: 'ch-team-' + i, name: n, slug: n, kind: 'team_channel', section_id: 'sec-team' }));

  // 9 Generals + Maribou's second General + 4 SEO channels = 14, across 11 clients.
  for (let i = 1; i <= 9; i++)
    chan({ id: 'ch-cd-gen-' + i, name: DB.clients[i - 1].name, slug: 'client-' + i,
      kind: 'client_dept', client_id: 'c-' + i, department: 'general', section_id: 'sec-clients' });
  chan({ id: 'ch-cd-gen-1b', name: 'Maribou (old)', slug: 'maribou-old',
    kind: 'client_dept', client_id: 'c-1', department: 'general', section_id: 'sec-clients' });
  [8, 9, 10, 11].forEach((n, i) =>
    chan({ id: 'ch-cd-seo-' + n, name: DB.clients[n - 1].name + '-seo', slug: 'client-' + n + '-seo',
      kind: 'client_dept', client_id: 'c-' + n, department: 'seo', section_id: 'sec-clients' }));

  for (let i = 1; i <= 80; i++)
    chan({ id: 'ch-dm-' + i, name: '', kind: 'dm', is_dm: true, is_private: true,
      dm_pair: [ME, 'u-' + i].sort().join(':') });

  DB.channel_members = [];
  DB.channels.forEach(c => {
    DB.channel_members.push({ channel_id: c.id, profile_id: ME, joined_at: iso(200, 0), last_read_at: iso(1, 0) });
    if (c.is_dm) {
      const other = c.dm_pair.split(':').find(x => x !== ME);
      DB.channel_members.push({ channel_id: c.id, profile_id: other, joined_at: iso(200, 1), last_read_at: iso(2, 0) });
      // Every tenth DM is a group conversation with is_group NEVER SET -- which is the
      // real shape: plenty of group DMs carry more than two members and a false is_group,
      // and routing the sidebar card off that column alone filed them under DIRECT.
      const n = Number(c.id.split('-')[2]);
      if (n % 10 === 0) {
        DB.channel_members.push({ channel_id: c.id, profile_id: 'u-' + (((n + 3) % 80) + 1), joined_at: iso(200, 2), last_read_at: iso(2, 0) });
        DB.channel_members.push({ channel_id: c.id, profile_id: 'u-' + (((n + 7) % 80) + 1), joined_at: iso(200, 3), last_read_at: iso(2, 0) });
      }
      // and a few that do set it, so both routes are exercised
      if (n % 25 === 0) c.is_group = true;
      // Production shape, which this fixture did not have: channels.name on a DM is
      // POPULATED, by ensure_dm_channel / create_group_dm, and it names everyone EXCEPT
      // THE CREATOR. So a conversation somebody else opened is stored under the viewer's
      // own name. Leaving it '' here is what let "a message from Mave, labelled Nishchay"
      // ship -- the code read channels.name first and the fixture made that harmless.
      if (n % 10 === 0) {
        // opened by the other person: the stored name is the viewer's own, plus the rest
        c.name = 'Nishchay Pandya';   // the viewer's own name, exactly as production stores it
        c.dm_pair = null;              // group DMs carry no pair, so it cannot be resolved from one
      }
    } else {
      for (let i = 1; i <= 4; i++)
        DB.channel_members.push({ channel_id: c.id, profile_id: 'u-' + ((DB.channel_members.length + i) % 80 + 1),
          joined_at: iso(180, i), last_read_at: iso(3, i) });
    }
  });

  const BODIES = ['Sent the draft over, let me know.', 'Client approved the new creative.',
    'Ranking moved to page 1 for the money term.', 'Invoice is out.', 'Can we push the call to Thursday?',
    'Uploaded the audit.', 'Budget is nearly spent for the month.', 'New landing page is live.',
    'Two broken links fixed.', 'They want a second variant.'];
  DB.messages = [];
  let mid = 0;
  const seed = (cid, n, dept) => {
    for (let i = 0; i < n; i++) {
      const author = rnd() < 0.35 ? ME : 'u-' + (1 + Math.floor(rnd() * 80));
      DB.messages.push({
        id: 'm-' + (++mid), channel_id: cid, author_id: author,
        body: (dept === 'seo' ? '[SEO] ' : '') + pick(BODIES),
        created_at: iso(Math.floor(rnd() * 60), i), edited_at: null, parent_id: null,
        reply_count: rnd() < 0.12 ? 1 + Math.floor(rnd() * 3) : 0,
        voice_note_url: null, voice_note_duration_ms: null,
        flagged: rnd() < 0.05, pinned_at: rnd() < 0.02 ? iso(5, i) : null,
        pinned_by: null
      });
    }
  };
  DB.channels.filter(c => c.kind === 'team_channel' || c.kind === 'home').forEach(c => seed(c.id, 60));
  DB.channels.filter(c => c.kind === 'client_dept' && c.department === 'general')
    .forEach((c, i) => seed(c.id, c.id === 'ch-cd-gen-1' ? 61 : c.id === 'ch-cd-gen-1b' ? 12 : 40 + i));
  // the four -seo channels carry 486 messages of SEO work between them
  [122, 121, 122, 121].forEach((n, i) => seed('ch-cd-seo-' + [8, 9, 10, 11][i], n, 'seo'));
  DB.channels.filter(c => c.is_dm).forEach(c => seed(c.id, 4 + Math.floor(rnd() * 12)));

  // Messages that actually name me, so the Inbox's Mentions tab (and the mention half of
  // Needs you) has something to find. Without these both read zero and every assertion
  // about them passes by measuring nothing.
  DB.messages.filter(m => m.author_id !== ME && m.channel_id.startsWith('ch-team-')).slice(0, 7)
    .forEach((m, i) => { m.body = '@Nishchay ' + m.body; m.created_at = iso(i + 1, i); });

  // a few threaded replies, so reply badges have something to render
  DB.messages.filter(m => m.reply_count > 0).slice(0, 40).forEach((m, i) => {
    for (let k = 0; k < m.reply_count; k++)
      DB.messages.push({ id: 'm-' + (++mid), channel_id: m.channel_id, author_id: 'u-' + (i + 1),
        body: 'Reply ' + (k + 1), created_at: iso(1, i * 3 + k), parent_id: m.id, reply_count: 0,
        edited_at: null, voice_note_url: null, voice_note_duration_ms: null, flagged: false,
        pinned_at: null, pinned_by: null, forwarded_from: null });
  });

  DB.message_attachments = DB.messages.slice(0, 24).map((m, i) => ({
    id: 'att-' + i, message_id: m.id, file_name: i % 3 === 0 ? 'brief-' + i + '.pdf' : 'shot-' + i + '.png',
    file_size: 40000 + i * 9000, mime_type: i % 3 === 0 ? 'application/pdf' : 'image/png',
    storage_path: 'c/' + i + '/file-' + i, width: i % 3 === 0 ? null : 1200, height: i % 3 === 0 ? null : 800
  }));
  // The reported bug is about a message with SEVERAL files on it, and every row above
  // gives a message exactly one -- so the case could not arise. This is one message with
  // four, of four different kinds, which is what "multiple files sent in a message" is.
  const multiMsg = DB.messages[30];
  if (multiMsg) {
    [['contract.pdf', 'application/pdf', 220000],
     ['mockup.png', 'image/png', 180000],
     ['walkthrough.mp4', 'video/mp4', 900000],
     ['voice-note.m4a', 'audio/mp4', 60000]].forEach(([nm, mt, sz], i) => {
      DB.message_attachments.push({ id: 'att-multi-' + i, message_id: multiMsg.id,
        file_name: nm, file_size: sz, mime_type: mt,
        storage_path: 'c/multi/' + nm, width: null, height: null });
    });
  }

  DB.message_reactions = DB.messages.slice(0, 30).map((m, i) => ({
    id: 'rx-' + i, message_id: m.id, profile_id: 'u-' + (i + 1), emoji: pick(['👍', '🔥', '🎉', '👀'])
  }));
  DB.message_reads = DB.messages.slice(0, 50).map(m => ({ message_id: m.id, profile_id: 'u-1' }));

  DB.channel_canvas = [
    { channel_id: 'ch-cd-gen-1', content: '<h2>Maribou</h2><p>Shared canvas.</p>',
      updated_at: iso(2, 0), updated_by: ME,
      cards: [{ id: 'k1', kind: 'link', title: 'Ad account', url: 'https://ads.example', section: 'Accounts', pinned: true },
              { id: 'k2', kind: 'note', title: 'Tone of voice', body: 'Warm, plain.', section: 'Brand' }] },
    { channel_id: 'ch-team-0', content: '<p>Team notes.</p>', updated_at: iso(4, 0), updated_by: ME, cards: [] }
  ];

  // created_by matters: the Projects screen loads projects this person OWNS plus ones
  // shared through project_members, so without an owner it showed "No projects yet" and
  // that whole screen -- table, rows, everything on them -- was untestable.
  DB.projects = [{ id: 'p-1', name: 'Maribou — Q3 SEO', client_id: 'c-1', created_by: ME,
                   position: 1, color: '#D00400', created_at: iso(30, 0) },
                 { id: 'p-2', name: 'Fortess DG — Site rebuild', client_id: 'c-2', created_by: ME,
                   position: 2, color: '#5aa8d6', created_at: iso(20, 0) },
                 // The bar puts the workspace master list first, then anything you created
                 // yourself, then the rest by name. Two projects both created by me could
                 // not tell that rule from no rule at all, so: one master list, and one
                 // owned by somebody else whose name sorts last.
                 { id: 'p-master', name: 'ReachGiant Master List', client_id: null, created_by: 'u-4',
                   position: 3, color: '#3ECF8E', created_at: iso(40, 0) },
                 { id: 'p-theirs', name: 'Aardvark — someone else\'s', client_id: null, created_by: 'u-4',
                   position: 4, color: '#F59E0B', created_at: iso(15, 0) }];
  DB.tasks = [];
  ['todo', 'in_progress', 'review', 'done'].forEach((st, si) => {
    for (let i = 0; i < 3; i++) DB.tasks.push({
      id: 't-' + si + '-' + i, name: 'Task ' + si + '.' + i, description: 'Detail for task ' + si + '.' + i,
      status: st, priority: pick(['low', 'medium', 'high']), assigned_to: [i === 0 ? ME : 'u-' + (i + 1)],
      department: pick(['seo', 'general', 'web']), due_at: iso(-3 - i, 0), project_id: 'p-1',
      client_id: 'c-1', created_by: ME, created_at: iso(10 + i, 0),
      completed_at: st === 'done' ? iso(1, i) : null
    });
  });

  // Screen recordings, so the share-link work on that screen is testable at all.
  DB.recordings = [
    { id: 'rec-1', profile_id: ME, title: 'Client walkthrough', storage_path: ME + '/a.webm',
      url: 'https://example.test/storage/a.webm', duration_secs: 95, folder: null,
      visibility: 'workspace', share_token: 'a'.repeat(32), view_count: 0, created_at: iso(2, 0) },
    { id: 'rec-2', profile_id: 'u-2', title: 'Someone else\'s recording', storage_path: 'u-2/b.webm',
      url: 'https://example.test/storage/b.webm', duration_secs: 40, folder: 'Handovers',
      visibility: 'public', share_token: 'b'.repeat(32), view_count: 3, created_at: iso(5, 0) }
  ];

  DB.time_sessions = [{ client_id: 'c-1', duration_seconds: 5400, status: 'stopped' },
                      { client_id: 'c-1', duration_seconds: 1800, status: 'stopped' }];
  // Keyed by the client's own id, not a separate one: the management panel selects
  // client_onboarding by `id`, because that table is the restricted projection of
  // `clients` and shares its primary key. Getting this wrong made the panel render its
  // "no client record" state, which read as a broken tab.
  // One row per client that actually has a thread, so whichever one a test opens has a
  // record -- seeding only Maribou meant the panel's real layout was never exercised.
  DB.client_onboarding = DB.clients.slice(0, 11).map((cl, i) => ({
    id: cl.id, client_id: cl.id, name: cl.name,
    status: ['submitted', 'submitted', 'sent', 'draft'][i % 4],
    created_at: iso(60 - i, 0), started_at: iso(59 - i, 0), industry: cl.industry,
    company_website: cl.company_website, timezone: 'Europe/London',
    working_notes: i % 3 === 0 ? 'Google Ads only — very budget-conscious, reviews spend weekly.' : null,
    keywords: [['commercial real estate', 'property development'], ['gifts', 'homeware'],
               ['emergency dentist', 'implants'], []][i % 4],
    mrr_cents: (400 + i * 120) * 100,
    onboarding_sent_at: i % 4 === 3 ? null : iso(58 - i, 0),
    onboarding_submitted_at: i % 4 < 2 ? iso(55 - i, 0) : null,
    contact_name: cl.contact_name, contact_email: cl.contact_email, contact_phone: '+1 (917) 555-01' + (10 + i),
    onboarding_token: 'tok-' + cl.id,
    onboarding_answers: { goals: 'More revenue', budget: '$' + (5 + i) + 'k/mo' }
  }));
  const BILLABLE = ['googleAds', 'metaAds', 'seo', 'web'];
  DB.chat2_client_services = [];
  DB.chat2_client_access = [];
  DB.chat2_client_activity = [];
  DB.clients.slice(0, 11).forEach((cl, i) => {
    BILLABLE.forEach((k, n) => {
      // Two active services per client, which is what makes "2 active · $9,200 / mo"
      // and the dimmed "Not active" rows both testable.
      const active = (n === 0) || (n === (i % 3) + 1);
      DB.chat2_client_services.push({ client_id: cl.id, dept_key: k, active,
        spend_cents: active ? (2000 + n * 1500 + i * 100) * 100 : 0,
        lead_profile_id: active && n < 2 ? 'u-' + (1 + ((i + n) % 6)) : null });
    });
    ['ga4', 'gsc', 'googleAds', 'meta', 'website'].forEach((k, n) => {
      DB.chat2_client_access.push({ client_id: cl.id, service_key: k,
        status: n < 3 ? 'granted' : n === 3 ? 'pending' : 'none',
        updated_at: iso(9 + n, i), updated_by: ME });
    });
    DB.chat2_client_activity.push({ id: 'ac-' + cl.id, client_id: cl.id, actor_id: ME,
      actor_name: 'Nishchay Pandya', kind: 'note', summary: 'Kickoff call done',
      detail: null, department: 'general', created_at: iso(7 + i, 0) });
  });
  DB.invoices = DB.clients.slice(0, 11).flatMap((cl, i) => ([
    { client_id: cl.id, amount_cents: (400 + i * 120) * 100, paid_at: iso(15 + i, 0), currency: 'GBP', number: 'INV-10' + (40 + i) },
    { client_id: cl.id, amount_cents: (400 + i * 120) * 100, paid_at: null, currency: 'GBP', number: 'INV-11' + (40 + i) },
  ]));
  DB.chat2_client_library = DB.clients.slice(0, 11).flatMap((cl) => ([
    { id: 'lib-a-' + cl.id, client_id: cl.id, kind: 'link', title: 'Brand kit', section: 'Brand',
      url: 'https://drive.example/kit', username: null, body: null, twofa: null,
      password_entry_id: null, file_url: null, file_name: null, file_size: null, mime_type: null,
      pinned: true, created_by: ME, created_at: iso(30, 0) },
    { id: 'lib-b-' + cl.id, client_id: cl.id, kind: 'note', title: 'Reporting cadence', section: 'Process',
      url: null, username: null, body: 'Monthly, first Tuesday.', twofa: null,
      password_entry_id: null, file_url: null, file_name: null, file_size: null, mime_type: null,
      pinned: false, created_by: ME, created_at: iso(20, 0) },
  ]));
  DB.tasks = DB.tasks.concat(DB.clients.slice(1, 11).flatMap((cl, i) =>
    ['todo', 'in_progress', 'done'].map((st, n) => ({
      id: 't-' + cl.id + '-' + n, name: 'Task for ' + cl.name + ' #' + (n + 1),
      description: null, status: st, priority: ['low', 'medium', 'fire'][n],
      assigned_to: ['u-' + (1 + n)], department: 'general', due_at: iso(-2 - n, 0),
      project_id: null, client_id: cl.id, created_by: ME, created_at: iso(10 + n, 0),
      completed_at: st === 'done' ? iso(1, n) : null }))));
  // status_stage ships in migration 20260922130000: the nine-step pipeline beside the
  // four-value enum. Derived the same way the page derives it, and deliberately left OFF
  // some rows -- a task that predates the column has to land somewhere sensible, and
  // "somewhere sensible" is the thing worth testing.
  DB.tasks.forEach((t, i) => {
    if (i % 4 === 3) { t.status_stage = null; return; }
    t.status_stage = t.status === 'done' ? 'done'
      : t.status === 'in_progress' ? 'in_progress'
      : t.status === 'blocked' ? 'roadblock'
      : ['not_started', 'new_request', 'needs_detail'][i % 3];
  });
  // The four non-department grants (migration 20260824120000). Seeded unevenly on
  // purpose: a client where everyone has everything cannot tell a working tick from a
  // hardcoded one.
  DB.client_member_areas = [];
  DB.clients.slice(0, 11).forEach((cl, i) => {
    ['onboarding', 'deliverables', 'tasks', 'billing'].forEach((area, n) => {
      if ((i + n) % 3 === 0) DB.client_member_areas.push({
        client_id: cl.id, profile_id: 'u-' + (1 + ((i + n) % 6)), area, granted_by: ME,
        created_at: iso(12 + n, i) });
    });
  });
  DB.subtasks = [];
  DB.task_comments = [];
  DB.project_priorities = ['Fire', 'Medium', 'Low'].map((label, i) => ({
    id: 'pp-' + i, project_id: 'p-1', label, color: ['#FF6B3B', '#F2A93B', '#7C8797'][i],
    emoji: null, position: i + 1, kind: 'priority', created_at: iso(30, 0) }));
  // Custom columns. One of each select kind plus a plain text one, because the three
  // behave differently in a cell: a chip, several chips, and raw text. Values live on
  // tasks.custom_fields keyed by field id, which is how the real rows are shaped.
  DB.project_fields = [
    { id: 'pf-1', project_id: 'p-1', name: 'Stage', type: 'single_select', position: 1,
      options: [{ label: 'Draft', color: '#6fb1ff' }, { label: 'Shipped', color: '#34c77b' }],
      created_at: iso(30, 0) },
    { id: 'pf-2', project_id: 'p-1', name: 'Channels', type: 'multi_select', position: 2,
      options: [{ label: 'SEO', color: '#e8232a' }, { label: 'Ads', color: '#f0a500' }],
      created_at: iso(30, 0) },
    { id: 'pf-3', project_id: 'p-1', name: 'Notes', type: 'text', position: 3,
      options: [], created_at: iso(30, 0) }];

  // The real Team Pay module: everyone on a fixed weekly base except one hourly, which is
  // what the Pod System's Monthly/Weekly switch exists to reconcile against a monthly card.
  // ideal_accounts/max_accounts/cap_label ship in migration 20260915160000: the capacity a
  // specialist is held to is a fact about their department, not a constant in the page.
  DB.pay_departments = [
    { id:'pd-1', name:'PAID ADS', color:'#6fb1ff', position:1,
      ideal_accounts:15, max_accounts:20, cap_label:'Google Ads specialist' },
    { id:'pd-2', name:'PRODUCTION', color:'#34c77b', position:2,
      ideal_accounts:10, max_accounts:10, cap_label:'SEO specialist' },
    { id:'pd-3', name:'Managers', color:'#e8232a', position:3,
      ideal_accounts:15, max_accounts:20, cap_label:'Pod Leader' }];
  // Who is in which pod (migration 20260915170000). Empty by default: the checks that care
  // set it up themselves, and a board with no membership yet must still draw.
  DB.pod_members = [];
  // Billing dates (migration 20260917120000). Left unset on the fixtures: the renewals
  // checks set the dates they need, and a client with nothing filled in is a real state
  // the board has to render.
  DB.clients.forEach(c => { c.ends_on = null; c.next_charge_on = null;
                            c.billing_off_at = null; c.billing_off_by = null; });
  // The words on How it works, same migration. Seeded with what the page used to hard-code.
  // The same five roles, five growth bands and two notes the migration seeds, so a check
  // that asserts the design's blocks are all present is asserting something real.
  DB.pod_settings = [
    { key:'intro', value:{ title:'The Pod Leader owns the clients. Specialists deliver the work.',
      body:'One pod holds up to 20 clients under one Pod Leader.' } },
    { key:'roles', value:[
      { key:'lead', label:'POD LEADER', does:'Owns all client relationships.', note:'Weekly health report.' },
      { key:'google_ads', label:'GOOGLE ADS', does:'Campaign builds.', note:'Paid per account by tier.' },
      { key:'seo', label:'SEO & AI SEARCH', does:'SEO strategy.', note:'Max 10 accounts initially.' },
      { key:'meta_ads', label:'META ADS', does:'Campaign builds for Meta.', note:'Meta rates provisional.' },
      { key:'web', label:'WEB & DESIGN', does:'Essential development.', note:'Shared across the pod.' }] },
    { key:'growth', value:[
      { range:'1-20', what:'One Pod Leader owns all client relationships' },
      { range:'20-25', what:'Begin recruiting Account Manager #2' },
      { range:'25-40', what:'Two AMs · roughly 15-20 clients each' },
      { range:'40-60', what:'Third AM · Pod Leader leads Client Services' },
      { range:'60+',   what:'Pod Leader manages the AMs, fewer direct clients' }] },
    { key:'notes', value:[
      { label:'HOW PAY WORKS', body:'Payments apply only to active, assigned accounts.' },
      { label:'PERFORMANCE = MORE ACCOUNTS', body:'Good work earns more accounts.' }] },
    { key:'rates_note', value:'Same rate card in every location.' }];
  DB.team_pay = [
    { id:'tp-1', profile_id:'u-1', department_id:'pd-1', base_type:'fixed_weekly', base_amount:296,   weekly_hours:null },
    { id:'tp-2', profile_id:'u-2', department_id:'pd-2', base_type:'fixed_weekly', base_amount:346.15, weekly_hours:null },
    { id:'tp-3', profile_id:'u-3', department_id:'pd-1', base_type:'hourly',       base_amount:16,     weekly_hours:20 },
    { id:'tp-4', profile_id:ME,    department_id:'pd-3', base_type:'fixed_weekly', base_amount:1596.15, weekly_hours:null }];
  // u-4 onwards deliberately have no team_pay row: somebody with no pay set and no
  // accounts is exactly who a manager needs to see on the board, so the board must show them.
  // Meetings. One event type and three bookings covering the three states the Booked
  // meetings list has to draw: one nobody has looked at, one already accepted, and one
  // declined. The guest's timezone differs from the host's on purpose -- the row shows both
  // clocks only when they disagree, and a fixture where they agree would never prove it.
  DB.event_types = [{
    id: 'et-1', profile_id: ME, slug: 'sales-call', name: 'Sales call', duration_min: 30,
    buffer_before_min: 0, buffer_after_min: 0, location_type: 'video', location_detail: null,
    availability: { mon:['09:00-18:00'], tue:['09:00-18:00'], wed:['09:00-18:00'],
                    thu:['09:00-18:00'], fri:['09:00-18:00'] },
    timezone: 'Europe/London', min_notice_hours: 4, max_advance_days: 60, is_active: true,
    auto_generate_meet: true, invitees: [], blackout_dates: [],
    questions: [{ key: 'budget', label: 'Budget', type: 'text', required: false }],
  }];
  // Relative to the real clock, not the fixtures' pinned 2026-08-24: the list filters on
  // upcoming vs past, so a booking that is always in the past can only ever exercise half
  // of it.
  const soon = (mins) => new Date(Date.now() + mins * 60000).toISOString();
  const bk = (id, mins, over) => Object.assign({
    id, event_type_id: 'et-1', host_profile_id: ME,
    guest_name: 'Dana Prospect', guest_email: 'dana@example.com',
    guest_notes: 'Keen to talk about paid search.',
    questions_answers: { budget: '2k/month' },
    start_at: soon(mins), end_at: soon(mins + 30),
    timezone: 'America/New_York', status: 'confirmed',
    meeting_link: 'https://giant.reachgiant.com/meet/abc-def-ghi',
    cancel_token: 'tok-' + id, host_accepted_at: null, declined_at: null, decline_reason: null,
  }, over || {});
  DB.bookings = [
    // One with a location and one without: guest_geo is null for anything booked before
    // the column existed and for anything booked on localhost, so the row has to read fine
    // either way.
    bk('bk-new', 120, { guest_geo: { country: 'United States', countryCode: 'US',
                                     city: 'Austin', region: 'Texas', timezone: 'America/Chicago' } }),
    bk('bk-accepted', 240, { host_accepted_at: soon(-60), guest_name: 'Sam Accepted' }),
    bk('bk-declined', 360, { status: 'declined', declined_at: soon(-60),
        decline_reason: 'Clash with a client call', guest_name: 'Ravi Declined' }),
  ];

  DB.project_prefs = [];   // migration 20260908130000 -- per-person order and stars
  DB.nav_favorites = [];   // migration 20260824140000
  DB.invitations = [];
  DB.channel_stars = [{ profile_id: ME, channel_id: 'ch-team-0' }];
  DB.inbox_actions = [];
  DB.scheduled_messages = [];
  DB.password_entries = [{ id: 'pw-1', client_id: 'c-1', title: 'GA4', username: 'ops@maribou.example' }];
  DB.password_entry_members = [{ entry_id: 'pw-1', profile_id: ME }];

  // ── Growth (migration 20261021120000) ───────────────────────────────────
  // Growth's dates are anchored to NOW, not to iso()'s fixed day. Everything on
  // Analytics is relative -- the 7 and 30 day ranges, the six weekly buckets, the stale
  // badge -- so rows frozen two months in the past make every one of those read as
  // empty, and a check written over them measures nothing at all.
  const giso = (daysAgo, i) => new Date(Date.now() - daysAgo * 864e5 - (i || 0) * 6e5).toISOString();
  // Enough of a pipeline to exercise every screen: deals in four stages, one of them
  // with an unanswered reply so "Reply to" and the inbox badge have something to count,
  // and a meeting today so the Home and Meetings screens are not both empty states.
  // Two different owners, so the owner column renders rather than being uniformly blank.
  const GR_DEALS = [
    ['gc-1', 'Michael Cash',   'Northview Door Systems', 'call',     1000, ME],
    ['gc-2', 'Cesar Diaz',     'Costa Rica Brokerage',   'proposal', 1500, ME],
    ['gc-3', 'Amna Abbasi',    'stage.universe.talk',    'call',        0, 'u-7'],
    ['gc-4', 'Mike Worden',    'PPA Youth Sports',       'follow',   2250, ME],
    ['gc-5', 'Kelsey Rowe',    'Kreative Expressions',   'booked',      0, 'u-7'],
    ['gc-6', 'Pete Patrino',   'Finzanza',               'won',      3000, ME]
  ];
  DB.growth_clients = GR_DEALS.map(([id, name, company, stage, val, owner], i) => ({
    id, owner_id: owner, name, company,
    email: name.toLowerCase().replace(/[^a-z]+/g, '.') + '@example.com',
    phone: i === 0 ? '+1 612 555 0142' : '', website: '',
    location: i === 0 ? 'Minneapolis, MN' : '',
    // Deals spread across five zones, so the client Info tab's local-time line has
    // something to render for more than one of them. The last deal keeps no zone at all,
    // because the empty shape has to be right too. (The Home clocks no longer come from
    // these -- they are the team's four cities.)
    timezone: ['America/Chicago', 'America/New_York', 'Europe/London',
               'Africa/Johannesburg', 'America/Los_Angeles', ''][i] || '', source: 'Fiverr',
    stage, value_monthly: val || null, next_step: '', summary: 'Notes from the first call.',
    follow_up_on: i === 3 ? giso(1, 0).slice(0, 10) : null,
    first_call_on: giso(9 - i, 0).slice(0, 10), last_call_on: giso(9 - i, 0).slice(0, 10),
    last_email_on: i < 2 ? giso(6 - i, 0).slice(0, 10) : null,
    emails_sent: i < 2 ? 1 : 0, calls_held: stage === 'booked' ? 0 : 1,
    won_on: stage === 'won' ? giso(2, 0).slice(0, 10) : null,
    lost_on: null, lost_reason: '', handled_msg: '',
    // gc-1 came in through the booking form, so the Info tab's "From their form" block
    // has something to render. The others deliberately do not, because the empty shape
    // has to be right too.
    intake: i === 0 ? { source: 'Fiverr', interests: 'Google Ads', budget: '$3,000/mo',
                        ready: 'Right away', revenue: '$80k/mo', url: 'northviewdoors.com' } : {},
    // One full Fathom-shaped note on gc-1, so every part of the note renderer has
    // something to draw and the empty shape is still exercised by everybody else.
    call_notes: i === 0 ? [{
      title: 'ReachGiant Growth Strategy Session', d: giso(5, 0).slice(0, 10), min: 41,
      url: 'https://fathom.video/share/sample',
      headline: 'Doing $80k a month, wants more installs without paying per click.',
      facts: [{ k: 'Budget', v: '$3,000/mo' }, { k: 'Decides', v: 'Michael alone' },
              { k: 'Timing', v: 'Right away' }],
      wants: ['More qualified leads from Google', 'Someone to own the tracking'],
      said: [{ t: 'We have tried two agencies and both just sent us clicks.', s: 182 },
             { t: 'If it works I will spend more, that is not the issue.', s: 905 }],
      worries: [{ q: 'I do not want a long contract.', a: 'Three month minimum, ten day exit.' },
                { q: 'Will I see where the money goes?', a: 'Weekly report, same numbers we work from.' }],
      next: [{ t: 'Send the proposal', who: 'Luke', done: true },
             { t: 'Share the tracking audit', who: 'Annie', done: false }]
    }] : [],
    team_notes: [], activity_log: [], giant_handoff: null,
    created_at: giso(20 - i, 0), updated_at: giso(i, 0)
  }));
  /* THREE SHAPES, because the panel has to tell them apart: a booking with answers, a
     Calendly booking synced before the answers were kept, and a call that never had a
     booking form at all. A fixture where every row carried answers would pass just as
     well on a panel that showed them unconditionally. The multi-line answer is real:
     Calendly returns a multi-select as one string with newlines in it. */
  DB.growth_meetings = [
    { id: 'gm-1', client_id: 'gc-5', title: 'ReachGiant Growth Strategy Session',
      starts_at: new Date(Date.now() + 3 * 3600e3).toISOString(), minutes: 45, actual_min: null,
      zoom_url: 'https://us06web.zoom.us/j/000', source: 'Calendly', brief: '', brief_at: null,
      /* A REAL CALENDLY URI, not 'ext-1'. Cancel is offered only on a booking Calendly
         actually made -- tested by the uri, because `source` is a label anybody could
         type -- so with a made-up id here the button could not appear and a check for
         it would have been asserting against a screen that never had one. */
      external_id: 'https://api.calendly.com/scheduled_events/aaaaaaaa-1111-2222-3333-444444444444',
      created_at: giso(3, 0),
      invitee: { name: 'Umra Hayat', email: 'umra-hayat@outlook.com',
        phone: '+447922116098', timezone: 'Europe/Berlin', booked_at: giso(5, 0),
        qa: [
          { q: 'Please provide a brief overview of your company in a few sentences, so we can be prepared for our call.',
            a: 'Soul Sanctuary is an established UK-based mental health consultancy.' },
          /* SHORT on purpose. The real answer here is three long phrases, which wrap to
             three lines in the panel whether or not the newlines are honoured -- so a
             height measurement against it cannot tell a rendered line break from a
             wrap, and passes with white-space:pre-line taken out. Short enough to fit
             on one line, the only thing that can make it three is the breaks. */
          { q: 'Which of these marketing strategies are you interested in discussing further?',
            a: 'Google Ads\nSEO\nMeta Ads' },
          { q: 'What\u2019s your monthly marketing budget range? Our minimum budget requirement is $1,500 per month.',
            a: '$1,500 \u2013 $10,000' },
          { q: 'To help us understand your business and where you\u2019re at, what is your current annual revenue?',
            a: 'Under 100k' }
        ] } },
    // Synced before Giant kept the answers: Calendly, but nothing to show.
    { id: 'gm-2', client_id: 'gc-1', title: 'ReachGiant Growth Strategy Session',
      starts_at: giso(5, 0), minutes: 45, actual_min: 41, zoom_url: '', source: 'Calendly',
      brief: '', brief_at: null, external_id: 'ext-2', created_at: giso(8, 0), invitee: null },
    /* TWO CALLS THAT ARE OFF, and off in the two different ways.

       gm-c1 was cancelled in Calendly; gm-c2 was removed by somebody in Giant. Neither
       belongs on any screen, and BOTH are here because the two are filtered by different
       columns -- a filter that checked only one would hide one of them and leave the
       other sitting on the list, which is a pass on half the feature.

       They are dated in the FUTURE on purpose. A past call falls out of the Upcoming
       list on its own, so a cancelled one dated yesterday would be invisible for the
       wrong reason and the check would prove nothing. */
    { id: 'gm-c1', client_id: 'gc-1', title: 'Cancelled in Calendly',
      starts_at: new Date(Date.now() + 30 * 3600e3).toISOString(), minutes: 45, actual_min: null,
      zoom_url: '', source: 'Calendly', brief: '', brief_at: null,
      external_id: 'https://api.calendly.com/scheduled_events/cccccccc-1111-2222-3333-444444444444',
      created_at: giso(2, 0), invitee: null,
      cancelled_at: giso(0, 1), hidden_at: null, hidden_by: null },
    { id: 'gm-c2', client_id: 'gc-1', title: 'Removed from Giant',
      starts_at: new Date(Date.now() + 31 * 3600e3).toISOString(), minutes: 45, actual_min: null,
      zoom_url: '', source: 'Calendly', brief: '', brief_at: null,
      external_id: 'https://api.calendly.com/scheduled_events/dddddddd-1111-2222-3333-444444444444',
      created_at: giso(2, 0), invitee: null,
      cancelled_at: null, hidden_at: giso(0, 1), hidden_by: 'p-nish' },
    // Pulled from Zoom, attached to nobody: there was never a booking form to answer.
    { id: 'gm-3', client_id: null, title: 'Mango Vans Rebrand',
      starts_at: new Date(Date.now() + 26 * 3600e3).toISOString(), minutes: 30, actual_min: null,
      zoom_url: 'https://us06web.zoom.us/j/555', source: 'Zoom', brief: '', brief_at: null,
      external_id: 'zoom:555', created_at: giso(1, 0), invitee: null },
    /* The second Calendly event type, which Luke turned on in November: an onboarding
       call for somebody already won, not a sales call with a stranger. There is one of
       each kind here on purpose -- Meetings splits on it, and a fixture of one shape
       would pass just as well against code that never split anything. Production has
       never had one of these, so this is the only place the split can be exercised at
       all until the first kickoff is booked. */
    /* On gc-5, which already has an earlier meeting booked, so adding this one does not
       change what any deal CARD says. Hung on gc-1 it quietly broke a Pipeline check:
       a card shows its next meeting ahead of its next action, so Michael Cash stopped
       saying "Send proposal" -- the card was right and the fixture was wrong. */
    { id: 'gm-7', client_id: 'gc-5', title: 'ReachGiant Kickoff Call',
      starts_at: new Date(Date.now() + 30 * 3600e3).toISOString(), minutes: 55, actual_min: null,
      zoom_url: 'https://us06web.zoom.us/j/777', source: 'Calendly', brief: '', brief_at: null,
      external_id: 'ext-7', created_at: giso(1, 0), invitee: null },
    /* TWO FINISHED CALLS, because the block has to tell them apart and a fixture where
       every past call carried a recording would pass just as well on code that drew the
       Watch link unconditionally.

       gm-4 is recorded WITH a transcript: a watch link, and a summary that can be made.
       Its passcode is Zoom's 98 character play token, which belongs in the url as ?pwd=
       and nowhere on the screen -- shown as text it was a wall of base64 beside a copy
       button, and left off the link entirely Zoom asks for a passcode nobody here has.
       gm-5 is recorded by nobody: notes, and an honest line about why. */
    { id: 'gm-4', client_id: 'gc-5', title: 'ReachGiant Growth Strategy Session',
      starts_at: new Date(Date.now() - 30 * 3600e3).toISOString(), minutes: 45, actual_min: null,
      zoom_url: 'https://us06web.zoom.us/j/444', source: 'Calendly', brief: '', brief_at: null,
      external_id: 'ext-4', created_at: giso(2, 0), invitee: null,
      recording_url: 'https://us06web.zoom.us/rec/share/aaa',
      recording_passcode: 'DFhmiswHzdjokje0nAAAIAAAANDW23POVUe920aca', recording_minutes: 37,
      recording_at: new Date(Date.now() - 30 * 3600e3).toISOString(),
      recording_files: [{ type: 'MP4', kind: 'shared_screen', mb: 338.9 },
                        { type: 'CC', kind: 'closed_caption', mb: 0.1 }],
      transcript: 'Luke: How are the sites doing?\nRob: Traffic is down forty percent.\n' +
        'Luke: The service pages are thin.\nRob: We tried an agency last year.\n' +
        'Luke: What went wrong?\nRob: They never spoke to us.',
      summary: null, summary_at: null, summary_source: null, notes: null, notes_at: null },
    { id: 'gm-5', client_id: null, title: 'Instant call, nobody booked it',
      starts_at: new Date(Date.now() - 52 * 3600e3).toISOString(), minutes: 20, actual_min: null,
      zoom_url: '', source: 'Zoom', brief: '', brief_at: null,
      external_id: 'zoom:666', created_at: giso(2, 0), invitee: null,
      recording_url: null, recording_passcode: null, recording_minutes: null,
      recording_at: null, recording_files: null, transcript: null,
      summary: null, summary_at: null, summary_source: null, notes: null, notes_at: null },
    /* The ordinary case on this account: Zoom's live captions, which name nobody. Kept
       separate from gm-4 so the two prompts can be compared -- one fixture could not
       show that the wording changes with what it is given. */
    { id: 'gm-6', client_id: 'gc-5', title: 'Growth call, captions only',
      starts_at: new Date(Date.now() - 76 * 3600e3).toISOString(), minutes: 40, actual_min: null,
      zoom_url: 'https://us06web.zoom.us/j/777', source: 'Calendly', brief: '', brief_at: null,
      external_id: 'ext-6', created_at: giso(4, 0), invitee: null,
      recording_url: 'https://us06web.zoom.us/rec/share/ccc',
      recording_passcode: null, recording_minutes: 40,
      recording_at: new Date(Date.now() - 76 * 3600e3).toISOString(),
      recording_files: [{ type: 'MP4', kind: 'shared_screen', mb: 210.4 }],
      transcript: 'What is that?\nNo, that is just the note taker.\nSo if you can find this.\n' +
        'Yeah, and then it jumped out.\nI do not think we need that.\nIt is recording on Zoom now.',
      summary: null, summary_at: null, summary_source: null, notes: null, notes_at: null }
  ];
  // gc-2's last message is INBOUND and unhandled, so exactly one deal needs a reply.
  DB.growth_messages = [
    { id: 'gx-1', client_id: 'gc-1', direction: 'out', subject: 'Good chat today',
      body: 'Hi Michael, good chat today. Plan to follow.', sent_at: giso(6, 0),
      thread_id: '', external_id: null, created_at: giso(6, 0) },
    { id: 'gx-2', client_id: 'gc-2', direction: 'out', subject: "Here's the plan",
      body: 'Hi Cesar, here is what I would do.', sent_at: giso(5, 0),
      thread_id: '', external_id: null, created_at: giso(5, 0) },
    { id: 'gx-3', client_id: 'gc-2', direction: 'in', subject: "Re: Here's the plan",
      body: 'This looks good. Can you send the agreement?', sent_at: giso(1, 0),
      thread_id: '', external_id: null, created_at: giso(1, 0) }
  ];
  /* ONE OF EACH PAYMENT STATE, because the bonus screen splits on it and tells three
     different stories: unpaid, part paid, paid in full. Three unpaid sales would pass
     just as well against code that never worked out what was still owed. The amounts
     are picked so the arithmetic is checkable by hand: 10% of 3,000 is 300 with nothing
     paid, 10% of 5,000 is 500 with 200 paid leaving 300, and 10% of 1,500 is 150 paid
     in full -- so 600 is owed and 350 has gone out. */
  DB.growth_bonus = [
    { id: 'gb-1', rep_id: ME, client_id: 'gc-1', client_name: 'Michael Cash',
      deal: 'Google Ads 1.5k', amount: 3000, pct: 10, sold_on: giso(9, 0).slice(0, 10),
      payments: [], created_at: giso(9, 0), created_by: ME },
    { id: 'gb-2', rep_id: ME, client_id: 'gc-2', client_name: 'Cesar Diaz',
      deal: 'Paid Ads Volt 3k', amount: 5000, pct: 10, sold_on: giso(20, 0).slice(0, 10),
      payments: [{ id: 'p-1', amount: 200, date: giso(5, 0).slice(0, 10) }],
      created_at: giso(20, 0), created_by: ME },
    { id: 'gb-3', rep_id: ME, client_id: 'gc-5', client_name: 'Umra Hayat',
      deal: 'SEO Management', amount: 1500, pct: 10, sold_on: giso(40, 0).slice(0, 10),
      payments: [{ id: 'p-2', amount: 100, date: giso(30, 0).slice(0, 10) },
                 { id: 'p-3', amount: 50, date: giso(25, 0).slice(0, 10) }],
      created_at: giso(40, 0), created_by: ME }
  ];

  /* One of each KIND, because the list splits on it and a fixture of one shape proves
     nothing about the split. A package email is one carrying a Stripe link -- there is
     no column saying so -- and gt-2 is the one that has one. */
  DB.growth_templates = [
    { id: 'gt-1', name: 'Zoom reminder', subject: 'Our call tomorrow',
      body: 'Hi {name},\n\nQuick reminder about our call.\n\nBest,', position: 0,
      created_at: giso(30, 0) },
    { id: 'gt-2', name: 'Google Ads Management 1.5k', subject: 'Getting started with ReachGiant',
      body: 'Hi {name},\n\nWe are looking forward to working with {company}.\n\nPayment\nGoogle Ads Management 1.5k\n[Pay here via Stripe](https://buy.stripe.com/test123)\n{discount}\n\nBest,',
      position: 1, created_at: giso(20, 0) },
    /* A COPY OF A REAL DEFECT. The discounted twin Luke had been pasting from says
       Hi "Name", -- a literal, not {name} -- so it goes to every client with the
       quotation marks in it and nobody's name. Two package emails rather than one also
       stops the group count passing on code that hardcodes 1. */
    { id: 'gt-3', name: 'Google Ads Management 1.5k (Discount)', subject: 'Your discounted start',
      body: 'Hi "Name",\n\nWe are looking forward to working with you.\n\nPayment\nGoogle Ads Management\n[Pay here via Stripe](https://buy.stripe.com/test456)\n\nBest,',
      position: 2, created_at: giso(10, 0) }
  ];
  DB.growth_settings = [
    { key: 'pipeline', value: { staleDays: 5, stages: [
        { key: 'booked', label: 'Booked', color: '#626262' },
        { key: 'call', label: 'Call done', color: '#1D5FA8' },
        { key: 'proposal', label: 'Proposal sent', color: '#7C3AED' },
        /* A deliberately long one. Stage names are typed by a person -- Luke's own board
           has "Asked to Book Another Meeting" -- and the heading used to ellipse, which
           hides the one thing a column heading has to say. With six short names the
           not-cut-off check passed against the bug. */
        { key: 'follow', label: 'Asked to Book Another Meeting', color: '#B7791F' },
        { key: 'won', label: 'Won', color: '#1F7A45' },
        { key: 'lost', label: 'Lost', color: '#B3302A' } ] },
      updated_at: giso(30, 0), updated_by: ME }
  ];
  DB.growth_training = [];
  // Deliberately empty: a rep's plan is seeded from the template the first time they open
  // Training, and that is the path worth exercising.
  DB.growth_tasks = [];
  /* Both shapes, because production holds both: 24 releases written through the New
     entry form as { type, text }, and 15 written straight into the row as plain strings.
     Only the second kind was broken, so a fixture with objects alone would have passed
     against the bug the whole time. */
  DB.changelog_entries = [
    { id: 'cl-1', version: '0.0.39', released_at: '2026-10-29', created_by: 'u-me',
      items: ['Connectors stopped telling somebody plainly signed in to sign in first.',
              'Zoom keys no longer clear themselves when you press Save.'] },
    { id: 'cl-2', version: '0.0.9', released_at: '2026-10-01', created_by: 'u-me',
      items: [{ type: 'fix', text: 'Task delete reported success when the database had refused it.' },
              { type: 'feature', text: 'Pods board shows capacity per person.' },
              { type: 'improvement', text: 'Board columns remember their width.' }] },
    /* A type nothing knows, which used to be printed raw beside the line. */
    { id: 'cl-3', version: '0.0.8', released_at: '2026-09-30', created_by: 'u-me',
      items: [{ type: 'wibble', text: 'An item whose type is not one of the three.' }] }
  ];

  DB.growth_watch_calls = [
    { id: 'gw-1', title: 'Amy Neighbors', call_date: giso(40,0).slice(0,10), url: 'https://fathom.video/share/example',
      tags: ['Google Ads','SEO'], outcome: 'Said yes',
      note: 'Meta ads wrecked by bots, moved to Google Ads and SEO.',
      learned: 'Watch how the budget worry gets named out loud before any price is said.', position: 0,
      // 20261022190000. Two of them, so "more than one row" and the per-row link are
      // both real measurements rather than one row repeated.
      // A real moment is a sentence. The four-word ones here could never show the row
      // cutting a question off, which is exactly what it was doing.
      moments: [{ s: 1462, theme: 'Tracking and ad spend',
                  q: 'You said 15 percent of what ad spend, scaled each week?' },
                { s: 905, theme: 'Contracts and commitment',
                  q: 'Am I locked in for a year, or can I stop whenever I want?' }],
      added_by: ME, created_at: giso(40,0) },
    /* A call with NO recording, which is what five of the six on the shelf actually look
       like. Without one of these the screen can only be checked in the state where the
       button is there, and the reported bug was the state where it is not. */
    { id: 'gw-2', title: 'Michael Cash', call_date: giso(9,0).slice(0,10), url: '',
      tags: ['Google Ads'], outcome: 'Moved forward',
      note: 'Garage door installer, burned by past agencies.',
      learned: '', position: 1, moments: [], added_by: ME, created_at: giso(9,0) }
  ];
  DB.growth_discounts = [
    { id: 'gd-1', code: 'RG250',  label: 'Get $250 off each month',   colour: '#D91F0F', position: 0, created_at: iso(30,0) },
    { id: 'gd-2', code: 'RG500',  label: 'Get $500 off each month',   colour: '#E8590C', position: 1, created_at: iso(30,0) },
    { id: 'gd-3', code: 'RG1000', label: 'Get $1,000 off each month', colour: '#7048E8', position: 2, created_at: iso(30,0) }
  ];
  DB.growth_settings.push(
    { key: 'training_plan', value: { tasks: [
        { t: 'Read the pricing and packages', d: 0 },
        { t: 'Listen to 4 Fathom calls', d: 0 },
        { t: 'One hour of Meta basics', d: 0 },
        { t: 'Sit in on 2 or 3 live calls', d: 1 },
        { t: 'Run a mock call with Luke', d: 1 },
        { t: 'Take 1 or 2 real calls', d: 2 }] },
      updated_at: iso(30,0), updated_by: ME },
    { key: 'philosophy', value: { tips: [
        { h: 'They want to trust you', t: 'Be calm, confident and honest. Do not oversell.' },
        { h: 'They want to feel heard', t: 'Ask thoughtful questions and really listen.' },
        { h: 'They want someone who can lead', t: 'Guide the conversation with clarity.' },
        { h: 'They want someone real', t: 'Be human. People buy from people.' },
        { h: 'They want to say yes', t: 'Remove doubt by being transparent and easy to talk with.' }],
      checklist: ['Stay calm and do not oversell', 'Listen and ask questions', 'Be real, not scripted'] },
      updated_at: iso(30,0), updated_by: ME },
    { key: 'script', value: {
        flow: [{ h: 'Open', t: 'Warm hello. Ask what made them book.' },
               { h: 'Listen', t: 'Ask about the business and what has gone wrong.' },
               { h: 'Find the worry', t: 'Budget, long contracts, past agencies.' },
               { h: 'Offer', t: 'Say the plan in plain words.' },
               { h: 'Email in 10 minutes', t: 'Send the recap while the call is fresh.' }],
        worries: [{ q: 'Is it worth it at my budget?', a: 'Start small and grow when it works.' },
                  { q: 'I do not want a long contract.', a: 'No annual lock in. 3 month minimum.' }] },
      updated_at: iso(30,0), updated_by: ME },
    { key: 'pricing', value: {
        packs: [{ tag: 'Pack 1', name: 'Paid Ads Volt', price: '$3,000', inc: 'Google Ads + Meta Ads',
                  txt: 'Full management across Search, Instagram and Facebook.', link: 'https://example.com/pay1', top: false },
                { tag: 'Pack 2', name: 'Google Powerhouse', price: '$3,000', inc: 'Google Ads + SEO',
                  txt: 'Paid and organic working together.', link: 'https://example.com/pay2', top: true }],
        services: [{ n: 'Google Ads', p: '$1,500', w: 'Clicks but not enough real leads.', l: 'https://example.com/s1' },
                   { n: 'SEO Management', p: '$2,500', w: 'Wants inbound leads without paying per click.', l: '' }],
        notes: ['Packages cover up to $15,000 a month in ad spend.'] },
      updated_at: iso(30,0), updated_by: ME },
    { key: 'signature', value: { name: 'Nishchay Pandya', title: 'ReachGiant', phone: '', email: 'hello@example.com', site: 'reachgiant.com' },
      updated_at: iso(30,0), updated_by: ME },
    // Training's course. Three lessons rather than seven: enough to measure order,
    // progress and the block kinds, few enough that a failure names a lesson.
    { key: 'course', value: { lessons: [
        { id: 'open', t: 'Open relaxed and curious', g: 'Be like water. Listen first.', min: 6,
          blocks: [ { k: 'p', t: 'Be yourself. Adapt to the conversation instead of forcing a script.' },
                    { k: 'h', t: 'Questions to explore' },
                    { k: 'ul', items: ['Who are your main customers?', 'What made you look for help now?'] } ],
          do: 'Ask one question at a time.', go: [] },
        { id: 'why', t: 'Understand why people buy', g: 'This is the key to selling.', min: 5,
          // Luke's wording, with the apostrophe and the quoted word intact. The seed that
          // first filled this content stripped every one of them ("don't" -> "do not",
          // '"um"' -> 'um'), so the copy on screen was not the copy he wrote. Kept here so
          // a renderer or an editor that mangles them fails a check instead of shipping.
          blocks: [ { k: 'b', h: 'They want to feel heard', t: 'Ask thoughtful questions and really listen.' },
                    { k: 'b', h: 'They want someone real', t: 'Don\'t try too hard. Replace "um" with a short pause.' } ],
          do: 'Learn what they want before you say a word about what you sell.',
          go: [['See the principles', 'phil']] },
        { id: 'offer', t: 'Know the offer', g: 'Prices and the 10 day exit.', min: 5,
          blocks: [ { k: 'ul', items: ['Three month minimum', '10 day exit'] } ],
          do: 'Say the price and the exit in one breath.', go: [['Open Pricing', 'pricing']] } ] },
      updated_at: iso(30,0), updated_by: ME },
    { key: 'clear', value: { items: [
        { id: 'what', theme: 'Services and fit', q: 'What does ReachGiant do?',
          a: 'We help customers find you and choose you. Google Ads, Meta ads, SEO and AI search.' },
        { id: 'cost', theme: 'Pricing and budget', q: 'How much does it cost?',
          a: 'Everything is on our pricing page. I can walk you through what fits your goals.' } ] },
      updated_at: iso(30,0), updated_by: ME },
    // DECLARED in the opposite order to how they should RANK: q-lock is first here and is
    // asked 5 times, q-budget is second and asked 12. A list that forgets to sort by how
    // often a question comes up then looks wrong on screen, which is the point -- with
    // the fixture already in rank order, dropping the sort changed nothing and the check
    // was reading the fixture rather than the code.
    { key: 'qa', value: { items: [
        { id: 'q-lock', theme: 'Contracts and commitment', q: 'I do not want a long contract.',
          feel: 'They have been trapped before.',
          better: 'No annual lock in. Three month minimum and a 10 day exit.',
          // Written by hand, and deliberately NOT what splitting the answer would give.
          bullets: ['Nobody is locked in for a year', 'Three months, then ten days notice'],
          why: 'Say the exit before they ask for it.', tricks: ['Offer the exit first'] },
        { id: 'q-budget', theme: 'Pricing and budget', q: 'Is it worth it at my budget?',
          feel: 'They are afraid of spending money and getting nothing back.',
          // Two answers that really differ: the model's, and the rewrite a person says.
          // Both have to reach the screen, and their bullets come from different text --
          // a check that only read one of them could not tell them apart.
          aiBetter: 'You can start small. We fix the tracking first. Then we grow it.',
          better: 'Start small. Fix the tracking first. Only grow when it works.',
          why: 'Answer the fear, not the number.', tricks: ['Name the fear out loud'] },
        // Comes from Clear answers, so it is never counted and never ranked by asks. It
        // still gets a row and a number, and says "AI answer" where a count would be.
        { id: 'ai-what', theme: 'Services and fit', q: 'What does ReachGiant do?',
          better: 'We help customers find you and choose you.', ai: true } ] },
      updated_at: iso(30,0), updated_by: ME }
  );
  // How often each question comes up, and four examples on the first one so "show all"
  // has something to reveal. q-budget is asked more than q-lock, so the ranking and the
  // bar widths are a real measurement rather than two identical rows.
  (function () {
    const qa = DB.growth_settings.find(function (x) { return x.key === 'qa'; });
    const byId = {};
    qa.value.items.forEach(function (it) { byId[it.id] = it; });
    byId['q-budget'].n = 12; byId['q-budget'].calls = 9;
    byId['q-budget'].a = 'I usually say it depends on the spend.';
    byId['q-lock'].n = 5; byId['q-lock'].calls = 4;
    /* IN ITS OWN ROW, not on the item. 364KB of call transcripts rode along on every
       Growth page load when they sat in `qa`; the boot query now excludes this key and
       the Q and A screen fetches it. A check that still found them on the item would be
       measuring the fixture rather than the fetch. */
    const exById = {};
    exById['q-budget'] = [
      { call: 'Amy Neighbors', q: 'Is $1,500 enough to see anything?',
        a: 'It depends on your spend really.',
        better: 'At $1,500 we fix tracking first, then scale what converts.',
        trick: 'Give the first month a job', url: 'https://fathom.video/share/example', s: 162 },
      { call: 'Harbour Dental', q: 'What if it does not work?',
        a: 'We would look at the numbers.',
        better: 'Three months is the test. If the numbers are not there we say so.',
        trick: 'Name the test', url: 'https://fathom.video/share/example', s: 410 },
      { call: 'Bluewater Roofing', q: 'Why is it that much a month?',
        a: 'That is our standard rate.',
        better: 'It is the management, not the ads. The spend is yours and stays yours.' },
      { call: 'Mesa Pet Clinic', q: 'Can we start smaller?',
        a: 'Sure, we can work something out.',
        better: 'Yes. One service, one month, and we grow it when it pays.' }
    ];
    exById['q-lock'] = [{ call: 'Amy Neighbors', q: 'Am I locked in for a year?',
      a: 'No, it is three months.',
      better: 'No annual lock in. Three month minimum, then ten days notice any time.',
      url: 'https://fathom.video/share/example', s: 905 }];
    DB.growth_settings.push({ key: 'qa_examples', value: { byId: exById },
      updated_at: iso(30,0), updated_by: ME });
    DB.growth_settings.push({ key: 'qa_extra', value: {
      tricks: [{ t: 'Name the fear out loud', b: 'Say the worry before they do and it stops being a weapon.' },
               { t: 'Give the first month a job', b: 'A month with a purpose is easier to buy than a month of hope.' },
               { t: 'Offer the exit first', b: 'People commit faster when leaving is easy.' }],
      weak: [{ q: 'Why is it that much a month?',
               why: 'The answer was "that is our standard rate", which defends the price instead of explaining it.',
               fix: 'Separate the fee from the spend, then say what the fee buys.' }]
    }, updated_at: iso(30,0), updated_by: ME });
  })();
  // Nobody has started the course: "0 of 3" and the Start button are the first thing a
  // rep sees, so that is the state worth booting into.
  DB.growth_course_done = [];
  DB.growth_secrets = [];
  /* TWO MAILBOXES, keyed (profile_id, slot) since 20261022210000. One of each kind on
     purpose: slot 1 has a refresh token and keeps itself signed in, slot 2 is an old
     implicit-flow row with none, which is the one that stops working within the hour.
     A fixture with two identical rows could not tell those apart, and telling them
     apart is the whole point of the change. */
  /* A mailbox whose recent post is ALL notification-like, which is the shape that made
     the inbox look empty: inPrimary surfaces recent notifications into the inbox, and
     the renderer used to fold every notification into a bundle, so the count said 13 and
     the list showed nothing but bundles. One older notification too, which should still
     bundle, and one ordinary email, which must never have. */
  DB.emails = [
    { id: 'em-1', profile_id: ME, gmail_id: 'g1', thread_id: 't1',
      from_email: 'messages-noreply@linkedin.com', from_name: 'LinkedIn',
      subject: 'Someone at Sandhata you may know', snippet: 'Do you know Bharath?',
      body_text: 'Do you know Bharath?', is_unread: true, is_starred: false,
      labels: ['INBOX', 'CATEGORY_UPDATES'], received_at: new Date(Date.now() - 2 * 3600e3).toISOString() },
    { id: 'em-2', profile_id: ME, gmail_id: 'g2', thread_id: 't2',
      from_email: 'noreply@netlify.com', from_name: 'Netlify',
      /* Gmail hands snippets back ALREADY html-escaped. Written that way here on
         purpose: escaping it a second time for the page printed "You&#39;re" on screen,
         and a fixture with clean text could never have caught it. */
      subject: 'Deploy succeeded', snippet: 'You&#39;re live &amp; running',
      body_text: 'Your site is live', is_unread: true, is_starred: false,
      labels: ['INBOX', 'CATEGORY_UPDATES'], received_at: new Date(Date.now() - 4 * 3600e3).toISOString() },
    { id: 'em-3', profile_id: ME, gmail_id: 'g3', thread_id: 't3',
      from_email: 'michael.cash@example.com', from_name: 'Michael Cash',
      subject: 'Re: the proposal', snippet: 'This looks good, can you send the agreement?',
      body_text: 'This looks good, can you send the agreement?', is_unread: true, is_starred: false,
      labels: ['INBOX'], received_at: new Date(Date.now() - 5 * 3600e3).toISOString() },
    { id: 'em-4', profile_id: ME, gmail_id: 'g4', thread_id: 't4',
      from_email: 'noreply@hubspot.com', from_name: 'Hubspot',
      subject: 'Your weekly summary', snippet: 'Here is what happened',
      body_text: 'Here is what happened', is_unread: false, is_starred: false,
      labels: ['INBOX', 'CATEGORY_UPDATES'], received_at: new Date(Date.now() - 12 * 86400e3).toISOString() }
  ];
  DB.gmail_tokens = [
    { profile_id: ME, slot: 1, email: 'big@reachgiant.com', label: null,
      access_token: 'mock-access-1', refresh_token: 'mock-refresh-1',
      expires_at: new Date(Date.now() + 50 * 60000).toISOString(),
      // The full scope list the app asks for: with a narrower one it correctly decides
      // consent is missing and shows the connect banner instead of the mail.
      scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify email', connected_at: giso(30, 0), last_sync_at: giso(0, 1) },
    { profile_id: ME, slot: 2, email: 'hello@reachgiant.com', label: null,
      access_token: 'mock-access-2', refresh_token: null,
      expires_at: new Date(Date.now() - 60 * 60000).toISOString(),
      scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify email', connected_at: giso(10, 0), last_sync_at: null }
  ];
  DB.growth_settings.push(
    { key: 'philosophy', value: { tips: [{ h: 'They want to feel heard', t: 'Ask thoughtful questions and really listen.' }],
        checklist: ['Stay calm and do not oversell'] }, updated_at: iso(30,0), updated_by: ME },
    { key: 'script', value: { flow: [{ h: 'Open', t: 'Warm hello. Ask what made them book.' }],
        worries: [{ q: 'I do not want a long contract.', a: 'Three month minimum and a 10 day exit.' }] },
      updated_at: iso(30,0), updated_by: ME }
  );
  // One run, three hours ago: long enough past the half-hour schedule that the screen has
  // to say Not running, which is the state worth booting into. A fixture that starts
  // green would let a broken "is it running" check pass.
  DB.growth_runs = [
    // iso() is anchored to a fixed date, which would make this run read as two months
    // old. 'Not running' has to come from the AGE of the run, so the age has to be real.
    { id: 'gr-run-1', job: 'growth_sync', ran_at: new Date(Date.now() - 3 * 3600e3).toISOString(), ok: true, ms: 820,
      steps: [
        { k: 'calendly', label: 'Calendly bookings', said: 'No new bookings', ok: true },
        { k: 'gmail', label: 'Gmail replies', said: 'Not set up. The stored Google token lasts an hour and cannot be renewed from a server.', ok: null },
        { k: 'fathom', label: 'Fathom call notes', said: 'Not built yet', ok: null }
      ],
      note: 'No new bookings' }
  ];

  // Anything New Chat asks for that was not foreseen: an empty table, loudly noted,
  // rather than a TypeError that would look like a bug in the page.
  // unread_counts is a VIEW in the real schema -- one row per (channel, member) with a
  // subquery counting messages newer than last_read_at and not written by that member.
  // It was six hand-written rows here, which meant a screen reading it could not be
  // checked against anything. Computed on read, so it stays true as the test writes.
  const unreadCounts = () => {
    const byChannel = {};
    DB.messages.forEach(m => (byChannel[m.channel_id] = byChannel[m.channel_id] || []).push(m));
    return DB.channel_members.map(cm => {
      const ch = DB.channels.find(c => c.id === cm.channel_id) || {};
      const floor = cm.last_read_at || ch.created_at;
      const n = (byChannel[cm.channel_id] || []).filter(m =>
        m.author_id !== cm.profile_id && (!floor || new Date(m.created_at) > new Date(floor))).length;
      return { channel_id: cm.channel_id, name: ch.name, is_dm: !!ch.is_dm,
               profile_id: cm.profile_id, last_read_at: floor, unread_count: n };
    });
  };

  const table = (n) => {
    if (n === 'unread_counts') return unreadCounts();
    if (!DB[n]) { DB[n] = []; if (!log.unsupported.includes('table:' + n)) log.unsupported.push('table:' + n); }
    return DB[n];
  };

  // Tables the app asks for that the database does not have yet -- the state between a
  // migration being written and being applied. PostgREST answers PGRST205 there, and the
  // app is supposed to degrade rather than error, so the harness needs to be able to
  // produce it. window.__mock.hideTable('x') / showTable('x').
  const hidden = new Set();
  const MISSING = (n) => ({ data: null, count: null, status: 404, error: {
    code: 'PGRST205', details: null, hint: null,
    message: "Could not find the table 'public." + n + "' in the schema cache" } });

  // So a click-through can read a row back and prove a write landed, rather than
  // asserting that an input exists on a screen whose Save does nothing.
  try { window.__mockDB = DB; } catch (e) {}

  // ── PostgREST-ish query builder ──────────────────────────────────────────
  const FK = { 'messages.channels': 'channel_id', 'tasks.projects': 'project_id',
               'channel_members.profiles': 'profile_id' };
  const COL2TABLE = { profile_id: 'profiles', channel_id: 'channels', project_id: 'projects',
                      client_id: 'clients', message_id: 'messages', task_id: 'tasks',
                      author_id: 'profiles', parent_id: 'messages' };

  const norm = (v) => (v instanceof Date ? v.toISOString() : v);
  const cmp = (a, b) => {
    a = norm(a); b = norm(b);
    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  };

  // `col.eq.val` / `col.is.null`, as used inside or()
  function applyOrTerm(row, term) {
    const m = /^([\w.]+)\.(\w+)\.(.*)$/.exec(term);
    if (!m) return false;
    return test(row, m[1], m[2], m[3] === 'null' ? null : m[3]);
  }

  function test(row, col, op, val) {
    const v = row[col];
    switch (op) {
      case 'eq': return String(norm(v)) === String(norm(val));
      case 'neq': return String(norm(v)) !== String(norm(val));
      case 'gt': return cmp(v, val) > 0;
      case 'gte': return cmp(v, val) >= 0;
      case 'lt': return cmp(v, val) < 0;
      case 'lte': return cmp(v, val) <= 0;
      case 'is': return val === null ? (v === null || v === undefined) : v === val;
      case 'in': {
        const list = Array.isArray(val) ? val
          : String(val).replace(/^\(|\)$/g, '').split(',').map(s => s.replace(/^"|"$/g, ''));
        return list.map(String).includes(String(v));
      }
      case 'like': case 'ilike': {
        const re = new RegExp('^' + String(val).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$',
          op === 'ilike' ? 'i' : '');
        return re.test(String(v == null ? '' : v));
      }
      case 'contains': {
        if (Array.isArray(v)) return (Array.isArray(val) ? val : [val]).every(x => v.includes(x));
        if (v && typeof v === 'object') return Object.keys(val || {}).every(k => v[k] === val[k]);
        return false;
      }
      case 'not.is': return !(v === null || v === undefined);
      default:
        log.unsupported.push('op:' + op);
        return true;
    }
  }

  function projectRow(row, cols, tbl) {
    if (!cols || cols.trim() === '*') return Object.assign({}, row);
    const out = {};
    // split on top-level commas only, so embedded specs stay whole
    const parts = []; let depth = 0, cur = '';
    for (const ch of cols) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur);

    for (let p of parts) {
      p = p.trim();
      if (!p) continue;
      const emb = /^(?:([\w]+):)?([\w]+)\s*\((.*)\)$/.exec(p);
      if (emb) {
        const alias = emb[1] || emb[2];
        const spec = emb[2], sub = emb[3];
        let fkCol, target;
        if (/_id$/.test(spec)) { fkCol = spec; target = COL2TABLE[spec]; }
        else { target = spec; fkCol = FK[tbl + '.' + spec] || (spec.replace(/s$/, '') + '_id'); }
        const parent = table(target || spec);
        const hit = parent.find(r => String(r.id) === String(row[fkCol]));
        out[alias] = hit ? projectRow(hit, sub, target) : null;
        continue;
      }
      const al = /^([\w]+):([\w]+)$/.exec(p);
      if (al) { out[al[1]] = row[al[2]]; continue; }
      if (p === '*') { Object.assign(out, row); continue; }
      out[p] = row[p] === undefined ? null : row[p];
    }
    return out;
  }

  let idSeq = 0;
  const newId = (t) => t.slice(0, 3) + '-gen-' + (++idSeq);

  function Builder(tbl) {
    this._t = tbl;
    this._cols = '*';
    this._f = [];            // [col, op, val]
    this._ors = [];
    this._order = [];
    this._limit = null;
    this._range = null;
    this._mode = 'select';
    this._payload = null;
    this._onConflict = null;
    this._single = null;
    this._count = null;
    this._head = false;
  }
  const P = Builder.prototype;
  P.select = function (cols, opts) {
    if (cols) this._cols = cols;
    if (opts && opts.count) this._count = opts.count;
    if (opts && opts.head) this._head = true;
    if (this._mode === 'select') this._returning = true; else this._returning = true;
    return this;
  };
  ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains'].forEach(op => {
    P[op] = function (col, val) { this._f.push([col, op, val]); return this; };
  });
  P.not = function (col, op, val) { this._f.push([col, 'not.' + op, val]); return this; };
  P.filter = function (col, op, val) { this._f.push([col, op, val]); return this; };
  P.match = function (obj) { Object.keys(obj).forEach(k => this._f.push([k, 'eq', obj[k]])); return this; };
  P.or = function (str) { this._ors.push(String(str).split(/,(?![^(]*\))/)); return this; };
  P.order = function (col, opts) { this._order.push([col, !opts || opts.ascending !== false]); return this; };
  P.limit = function (n) { this._limit = n; return this; };
  P.range = function (a, b) { this._range = [a, b]; return this; };
  P.single = function () { this._single = 'single'; return this; };
  P.maybeSingle = function () { this._single = 'maybe'; return this; };
  P.csv = function () { this._csv = true; return this; };
  P.throwOnError = function () { this._throw = true; return this; };
  P.abortSignal = function () { return this; };
  P.insert = function (rows) { this._mode = 'insert'; this._payload = rows; return this; };
  P.upsert = function (rows, opts) {
    this._mode = 'upsert'; this._payload = rows;
    this._onConflict = opts && opts.onConflict ? String(opts.onConflict).split(',').map(s => s.trim()) : ['id'];
    return this;
  };
  P.update = function (patch) { this._mode = 'update'; this._payload = patch; return this; };
  P.delete = function () { this._mode = 'delete'; return this; };

  P._rows = function () {
    let rows = table(this._t).slice();
    this._f.forEach(([c, op, v]) => { rows = rows.filter(r => test(r, c, op, v)); });
    this._ors.forEach(terms => { rows = rows.filter(r => terms.some(t => applyOrTerm(r, t))); });
    return rows;
  };

  P._run = function () {
    const t = this._t;
    /* The filters go in the log too. Without them every read of a table looks alike,
       and a check cannot tell `select *` from one that deliberately leaves a row out. */
    log.queries.push(t + '.' + this._mode +
      (this._f.length ? '[' + this._f.map(f => f.join(' ')).join(',') + ']' : ''));
    if (hidden.has(t)) return MISSING(t);
    try {
      if (this._mode === 'select') {
        let rows = this._rows();
        this._order.forEach(([c, asc]) => rows.sort((a, b) => (asc ? 1 : -1) * cmp(a[c], b[c])));
        const total = rows.length;
        if (this._range) rows = rows.slice(this._range[0], this._range[1] + 1);
        if (this._limit != null) rows = rows.slice(0, this._limit);
        if (this._head) return { data: null, error: null, count: total, status: 200 };
        let data = rows.map(r => projectRow(r, this._cols, t));
        if (this._single === 'single') {
          if (data.length !== 1) return { data: null, count: total,
            error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
          return { data: data[0], error: null, count: total };
        }
        /* maybeSingle allows NO row, not several. PostgREST answers PGRST116 the moment
           a second row comes back, and this returned the first one with no error --
           which quietly hid a real bug: every read of gmail_tokens filtered on
           profile_id alone, so the first person to connect a second mailbox would have
           broken sending, and a check driven against this mock could not have seen it. */
        if (this._single === 'maybe') {
          if (data.length > 1) return { data: null, count: total,
            error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
          return { data: data[0] || null, error: null, count: total };
        }
        return { data, error: null, count: total, status: 200 };
      }

      if (this._mode === 'insert' || this._mode === 'upsert') {
        const bad = (Array.isArray(this._payload) ? this._payload : [this._payload])
          .map(r => checkConstraints(t, r)).find(Boolean);
        if (bad) {
          return { data: null, error: {
            code: '23514',
            message: 'new row for relation "' + t + '" violates check constraint "' + bad + '"'
          } };
        }
        const arr = table(t);
        const rows = (Array.isArray(this._payload) ? this._payload : [this._payload]).map(r => Object.assign({}, r));
        const done = [];
        rows.forEach(r => {
          if (this._mode === 'upsert') {
            const keys = this._onConflict;
            const existing = arr.find(x => keys.every(k => String(x[k]) === String(r[k])));
            if (existing) { Object.assign(existing, r); done.push(existing); return; }
          }
          applyDefaults(t, r);
          if (r.id === undefined) r.id = newId(t);
          if (r.created_at === undefined && ['messages', 'tasks'].includes(t)) r.created_at = new Date().toISOString();
          arr.push(r); done.push(r);
        });
        log.writes.push(t + '.' + this._mode + ' x' + done.length);
        done.forEach(r => deliver(t, this._mode === 'upsert' ? 'UPDATE' : 'INSERT', r));
        const data = done.map(r => projectRow(r, this._cols, t));
        if (this._single) return { data: data[0] || null, error: null };
        return { data: this._returning ? data : null, error: null };
      }

      if (this._mode === 'update') {
        const hit = this._rows();
        hit.forEach(r => Object.assign(r, this._payload));
        log.writes.push(t + '.update x' + hit.length);
        hit.forEach(r => deliver(t, 'UPDATE', r));
        const data = hit.map(r => projectRow(r, this._cols, t));
        if (this._single) return { data: data[0] || null, error: null };
        return { data: this._returning ? data : null, error: null };
      }

      if (this._mode === 'delete') {
        const hit = this._rows();
        const arr = table(t);
        hit.forEach(r => { const i = arr.indexOf(r); if (i >= 0) arr.splice(i, 1); });
        log.writes.push(t + '.delete x' + hit.length);
        hit.forEach(r => deliver(t, 'DELETE', {}, r));
        const data = hit.map(r => projectRow(r, this._cols, t));
        if (this._single) return { data: data[0] || null, error: null };
        return { data: this._returning ? data : null, error: null };
      }
    } catch (e) {
      return { data: null, error: { message: 'mock failure in ' + t + ': ' + e.message } };
    }
  };

  P.then = function (res, rej) {
    return new Promise(r => setTimeout(() => r(this._run()), 0)).then(res, rej);
  };
  P.catch = function (f) { return this.then(undefined, f); };
  P.finally = function (f) { return this.then(v => { f(); return v; }, e => { f(); throw e; }); };

  // ── realtime / storage / auth ────────────────────────────────────────────
  // Realtime subscribers, so a test can actually deliver an event. Without this the mock
  // accepted .on() and dropped it on the floor, which meant every realtime path in the app
  // -- the unread bump, Needs you placing a live message, the thread-reply branch -- was
  // never once exercised by the click-through.
  // The CHECK constraints the real schema carries. Without these the mock happily stored
  // rows Postgres refuses, and a check-through went green on a build that failed against
  // the database the moment a person tried it -- which is exactly what happened with
  // channels_client_dept_needs_client.
  // Column DEFAULTs the real schema applies on insert. Without them a row comes back
  // missing a value the app then filters on -- scheduled_messages.status is 'pending' by
  // default, so a freshly scheduled message was invisible to the pill's own query and the
  // count sat at zero on a feature that works perfectly well against the database.
  const DEFAULTS = {
    scheduled_messages: { status: 'pending' },
    messages: { flagged: false },
    task_comments: { created_at: '@now' },
    subtasks: { done: false, created_at: '@now' },
    channels: { is_private: false },
    invitations: { accepted_at: null, revoked_at: null },
    // time_sessions.started_at is "DEFAULT now() NOT NULL" -- the timer never sends it,
    // so without this the elapsed clock reads a missing date and shows NaN:NaN.
    time_sessions: { started_at: '@now', total_paused_ms: 0 }
  };
  function applyDefaults(t, r) {
    const d = DEFAULTS[t];
    if (!d || !r) return;
    for (const k in d) if (r[k] === undefined) r[k] = (d[k] === '@now' ? new Date().toISOString() : d[k]);
  }

  function checkConstraints(t, r) {
    if (t !== 'channels' || !r) return null;
    const KINDS = ['home', 'team_channel', 'client_dept', 'dm'];
    const DEPTS = ['general', 'googleAds', 'metaAds', 'seo', 'web'];
    if (r.kind != null && !KINDS.includes(r.kind)) return 'channels_kind_check';
    if (r.department != null && !DEPTS.includes(r.department)) return 'channels_department_check';
    // 20260825120000 dropped channels_client_dept_needs_client: a client conversation
    // with no client record is legal, and the UI shows it as a plain conversation. What
    // replaced it is the half worth keeping -- a DEPARTMENT still implies a client.
    if (r.department != null && r.client_id == null) return 'channels_department_needs_client';
    return null;
  }

  const subs = [];   // { table, event, cb }
  // Postgres sends a replication event for every write, so the mock does too. Before this,
  // realtime only fired when a test called __mock.emit by hand, which meant the harness
  // could not see a bug in the app's own write-then-refresh path: the write landed, no
  // event was delivered, and the check just watched the DOM stay stale forever.
  function deliver(t, ev, newRow, oldRow) {
    const up = String(ev).toUpperCase();
    const targets = subs.filter(s => s.table === t && (s.event === up || s.event === '*'));
    if (!targets.length) return 0;
    // Async, like the wire. A handler that runs inside the caller's own insert() would see
    // a half-applied world and would not match production ordering.
    setTimeout(() => targets.forEach(s => {
      try { s.cb({ eventType: up, new: newRow || {}, old: oldRow || {}, table: t, schema: 'public' }); }
      catch (e) { log.unsupported.push('realtime handler threw: ' + e.message); }
    }), 0);
    return targets.length;
  }
  function Chan(name) { this.topic = name; log.realtime.push(name); }
  Chan.prototype.on = function (kind, filter, cb) {
    if (kind === 'postgres_changes' && typeof cb === 'function' && filter) {
      subs.push({ table: filter.table, event: String(filter.event || '*').toUpperCase(), cb });
    }
    return this;
  };
  Chan.prototype.send = function () { return Promise.resolve('ok'); };
  Chan.prototype.track = function () { return Promise.resolve('ok'); };
  Chan.prototype.untrack = function () { return Promise.resolve('ok'); };
  Chan.prototype.presenceState = function () { return {}; };
  Chan.prototype.subscribe = function (cb) { if (cb) setTimeout(() => cb('SUBSCRIBED'), 0); return this; };
  Chan.prototype.unsubscribe = function () { return Promise.resolve('ok'); };

  const SESSION = {
    access_token: 'mock-access-token', refresh_token: 'mock-refresh-token',
    token_type: 'bearer', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: ME, email: 'hello@lukasgriffin.com', role: 'authenticated',
            app_metadata: {}, user_metadata: { full_name: 'Nishchay Pandya' },
            aud: 'authenticated', created_at: iso(300, 0) }
  };

  function createClient(url, key, opts) {
    const client = {
      supabaseUrl: url, supabaseKey: key,
      from: (t) => new Builder(t),
      schema: () => client,
      rpc: (name, args) => {
        log.rpc.push(name);
        let data = null;
        if (name === 'ensure_dm_channel') data = 'ch-dm-1';
        else if (name === 'create_group_dm') data = 'ch-dm-1';
        else if (name === 'generate_onboarding_token') {
          // The real function writes the token onto the client row and returns it; a mock
          // that only returns it lets a caller pass while never persisting anything.
          data = 'tok-' + Math.random().toString(36).slice(2, 10);
          const row = (DB.clients || []).find(c => c.id === (args && args.p_client_id));
          if (row) { row.onboarding_token = data; row.onboarding_sent_at = null; }
        }
        // The real search_messages is a Postgres function over a tsvector. This stands in
        // for it closely enough to exercise the UI: the same arguments, the same row
        // shape, the same <mark> highlighting, and the same AND / OR / NOT semantics --
        // words AND together, repeated filters OR, exclusions subtract.
        else if (name === 'search_messages' || name === 'search_messages_count') {
          const a = args || {};
          const arr = (x) => Array.isArray(x) ? x : [];
          const hay = (m) => String(m.body || '').toLowerCase();
          let rows = (DB.messages || []).filter(m => {
            const b = hay(m);
            if (!arr(a.p_words).every(w => b.includes(String(w).toLowerCase()))) return false;
            if (!arr(a.p_phrases).every(w => b.includes(String(w).toLowerCase()))) return false;
            if (!arr(a.p_prefixes).every(w => new RegExp('\\b' + String(w).toLowerCase()).test(b))) return false;
            if (arr(a.p_exclude_words).some(w => b.includes(String(w).toLowerCase()))) return false;
            if (arr(a.p_exclude_phrases).some(w => b.includes(String(w).toLowerCase()))) return false;
            if (arr(a.p_channels).length && !arr(a.p_channels).includes(m.channel_id)) return false;
            if (arr(a.p_exclude_channels).includes(m.channel_id)) return false;
            if (arr(a.p_authors).length && !arr(a.p_authors).includes(m.author_id)) return false;
            if (arr(a.p_exclude_authors).includes(m.author_id)) return false;
            if (a.p_after && new Date(m.created_at) < new Date(a.p_after)) return false;
            if (a.p_before && new Date(m.created_at) >= new Date(a.p_before)) return false;
            if (arr(a.p_is).includes('thread') && !m.parent_id && !(m.reply_count > 0)) return false;
            if (arr(a.p_is).includes('pinned') && !m.pinned_at) return false;
            if (arr(a.p_has).includes('pin') && !m.pinned_at) return false;
            if (arr(a.p_has).includes('link') && !/https?:\/\//i.test(m.body || '')) return false;
            if (arr(a.p_has).includes('file')
                && !(DB.message_attachments || []).some(x => x.message_id === m.id)) return false;
            return true;
          });
          rows.sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
          // The real count stops at a ceiling rather than scanning the whole table, so a
          // mock that counts for ever would hide the "500+" the tab has to print.
          if (name === 'search_messages_count') { data = Math.min(rows.length, 500); }
          else {
            // Keyset paging. The real function compares (rank, id) or (created_at, id);
            // this orders by created_at, so "everything after that row" is the same
            // contract -- forward progress, and no row served twice. Without it a mock
            // returns page one to every request and a Load more check passes while the
            // list never grows.
            if (a.p_cursor_id) {
              const at = rows.findIndex(m => m.id === a.p_cursor_id);
              rows = at >= 0 ? rows.slice(at + 1) : [];
            }
            const term = (arr(a.p_words)[0] || arr(a.p_phrases)[0] || arr(a.p_prefixes)[0] || '');
            data = rows.slice(0, Math.min(a.p_limit || 20, 500)).map(m => {
              const body = String(m.body || '');
              let snippet = body.slice(0, 160);
              if (term) {
                const i = body.toLowerCase().indexOf(String(term).toLowerCase());
                if (i >= 0) {
                  const s = Math.max(0, i - 40);
                  snippet = (s ? '… ' : '') + body.slice(s, i) + '<mark>' + body.slice(i, i + String(term).length)
                    + '</mark>' + body.slice(i + String(term).length, i + 120);
                }
              }
              return { id: m.id, channel_id: m.channel_id, author_id: m.author_id,
                       created_at: m.created_at, body, snippet, rank: 0.5 };
            });
          }
        }
        const p = Promise.resolve({ data, error: null });
        p.single = () => Promise.resolve({ data, error: null });
        p.maybeSingle = () => Promise.resolve({ data, error: null });
        return p;
      },
      channel: (n) => new Chan(n),
      removeChannel: () => Promise.resolve('ok'),
      removeAllChannels: () => Promise.resolve('ok'),
      getChannels: () => [],
      realtime: { channels: [], connect() {}, disconnect() {}, setAuth() {} },
      functions: { invoke: (n) => { log.rpc.push('fn:' + n); return Promise.resolve({ data: null, error: null }); } },
      storage: {
        from: (bucket) => ({
          upload: (path) => { log.storage.push('upload:' + bucket + '/' + path); return Promise.resolve({ data: { path }, error: null }); },
          // A data: URI, not a fake host. The Media gallery puts this straight into an
          // <img src>, and a https://mock.local/... URL made the browser try to resolve
          // it -- six DNS failures in the console per run, which is exactly the signal
          // this harness exists to keep clean.
          // Shaped like the real one: a cross-origin object URL carrying the path. It was
          // a fixed data: URI, which renders fine and makes it impossible to tell whether
          // a link was built for the right file -- or, now, asked to download at all.
          getPublicUrl: (path) => ({ data: { publicUrl:
            /\.(png|jpe?g|gif|webp|svg)$/i.test(String(path || '')) || /shot|img|image/i.test(String(path || ''))
              ? PLACEHOLDER_IMG
              // NOT *.supabase.co: the click-through aborts every request to that host as
              // a backstop against reaching the real project, and a <video src> pointing
              // at one made the route handler throw.
              : 'https://files.example.test/storage/v1/object/public/chat-attachments/'
                + String(path || '').split('/').map(encodeURIComponent).join('/') } }),
          createSignedUrl: (path) => Promise.resolve({ data: { signedUrl: 'https://mock.local/' + bucket + '/' + path }, error: null }),
          remove: (paths) => { log.storage.push('remove:' + bucket + '/' + [].concat(paths || []).join(',')); return Promise.resolve({ data: [], error: null }); },
          list: () => Promise.resolve({ data: [], error: null }),
          download: () => Promise.resolve({ data: new Blob(['mock']), error: null })
        })
      },
      auth: {
        getSession: () => Promise.resolve({ data: { session: SESSION }, error: null }),
        getUser: () => Promise.resolve({ data: { user: SESSION.user }, error: null }),
        refreshSession: () => Promise.resolve({ data: { session: SESSION, user: SESSION.user }, error: null }),
        setSession: () => Promise.resolve({ data: { session: SESSION }, error: null }),
        onAuthStateChange: (cb) => {
          setTimeout(() => { try { cb('SIGNED_IN', SESSION); } catch (_) {} }, 0);
          return { data: { subscription: { unsubscribe() {} } } };
        },
        signInWithPassword: () => Promise.resolve({ data: { session: SESSION, user: SESSION.user }, error: null }),
        signInWithOAuth: () => Promise.resolve({ data: {}, error: null }),
        signUp: () => Promise.resolve({ data: { session: SESSION, user: SESSION.user }, error: null }),
        signOut: () => Promise.resolve({ error: null }),
        updateUser: () => Promise.resolve({ data: { user: SESSION.user }, error: null }),
        resetPasswordForEmail: () => Promise.resolve({ data: {}, error: null }),
        exchangeCodeForSession: () => Promise.resolve({ data: { session: SESSION }, error: null }),
        verifyOtp: () => Promise.resolve({ data: { session: SESSION }, error: null }),
        admin: { listUsers: () => Promise.resolve({ data: { users: [] }, error: null }) }
      }
    };
    return client;
  }

  window.supabase = { createClient, SupabaseClient: function () {}, __isMock: true };
  window.__mock = {
    db: DB, log, session: SESSION, me: ME,
    // Deliver a postgres_changes event to whoever subscribed, the way Supabase would.
    // Does NOT write to DB -- the caller decides whether the row exists, so a test can
    // model an event arriving for a row it has already inserted.
    emit: (table, event, newRow, oldRow) => deliver(table, event || 'INSERT', newRow, oldRow),
    subscriberCount: (table) => subs.filter(s => s.table === table).length,
    hideTable: (n) => hidden.add(n),
    showTable: (n) => hidden.delete(n),
    counts: () => Object.fromEntries(Object.keys(DB).map(k => [k, DB[k].length])),
    tally: () => {
      const t = {};
      log.queries.forEach(q => { t[q] = (t[q] || 0) + 1; });
      return t;
    }
  };
})();
