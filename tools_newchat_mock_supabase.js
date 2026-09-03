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

  // a few threaded replies, so reply badges have something to render
  DB.messages.filter(m => m.reply_count > 0).slice(0, 40).forEach((m, i) => {
    for (let k = 0; k < m.reply_count; k++)
      DB.messages.push({ id: 'm-' + (++mid), channel_id: m.channel_id, author_id: 'u-' + (i + 1),
        body: 'Reply ' + (k + 1), created_at: iso(1, i * 3 + k), parent_id: m.id, reply_count: 0,
        edited_at: null, voice_note_url: null, voice_note_duration_ms: null, flagged: false,
        pinned_at: null, pinned_by: null });
  });

  DB.message_attachments = DB.messages.slice(0, 24).map((m, i) => ({
    id: 'att-' + i, message_id: m.id, file_name: i % 3 === 0 ? 'brief-' + i + '.pdf' : 'shot-' + i + '.png',
    file_size: 40000 + i * 9000, mime_type: i % 3 === 0 ? 'application/pdf' : 'image/png',
    storage_path: 'c/' + i + '/file-' + i, width: i % 3 === 0 ? null : 1200, height: i % 3 === 0 ? null : 800
  }));
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

  DB.projects = [{ id: 'p-1', name: 'Maribou — Q3 SEO', client_id: 'c-1' },
                 { id: 'p-2', name: 'Fortess DG — Site rebuild', client_id: 'c-2' }];
  DB.tasks = [];
  ['todo', 'in_progress', 'review', 'done'].forEach((st, si) => {
    for (let i = 0; i < 3; i++) DB.tasks.push({
      id: 't-' + si + '-' + i, name: 'Task ' + si + '.' + i, description: 'Detail for task ' + si + '.' + i,
      status: st, priority: pick(['low', 'medium', 'high']), assigned_to: i === 0 ? ME : 'u-' + (i + 1),
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
      assigned_to: 'u-' + (1 + n), department: 'general', due_at: iso(-2 - n, 0),
      project_id: null, client_id: cl.id, created_by: ME, created_at: iso(10 + n, 0),
      completed_at: st === 'done' ? iso(1, n) : null }))));
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
  DB.nav_favorites = [];   // migration 20260824140000
  DB.invitations = [];
  DB.channel_stars = [{ profile_id: ME, channel_id: 'ch-team-0' }];
  DB.inbox_actions = [];
  DB.scheduled_messages = [];
  DB.password_entries = [{ id: 'pw-1', client_id: 'c-1', title: 'GA4', username: 'ops@maribou.example' }];
  DB.password_entry_members = [{ entry_id: 'pw-1', profile_id: ME }];

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
    log.queries.push(t + '.' + this._mode);
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
        if (this._single === 'maybe') return { data: data[0] || null, error: null, count: total };
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
    channels: { is_private: false },
    invitations: { accepted_at: null, revoked_at: null }
  };
  function applyDefaults(t, r) {
    const d = DEFAULTS[t];
    if (!d || !r) return;
    for (const k in d) if (r[k] === undefined) r[k] = d[k];
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
        else if (name === 'generate_onboarding_token') data = 'tok-generated';
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
          if (name === 'search_messages_count') { data = rows.length; }
          else {
            const term = (arr(a.p_words)[0] || arr(a.p_phrases)[0] || arr(a.p_prefixes)[0] || '');
            data = rows.slice(0, a.p_limit || 20).map(m => {
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
          getPublicUrl: (path) => ({ data: { publicUrl: PLACEHOLDER_IMG } }),
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
