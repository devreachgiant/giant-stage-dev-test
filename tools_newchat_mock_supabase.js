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
      role: i === 1 ? 'manager' : i === 2 ? 'inhouse_dev' : i <= 6 ? 'manager' : 'member',
      title: 'Specialist', bio: null, avatar_url: null,
      avatar_bg: '#2' + (i % 9) + '3' + (i % 7) + '4' + (i % 5), avatar_fg: '#eaeaea',
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
  DB.chat2_client_library = [
    { id: 'lib-1', client_id: 'c-1', kind: 'link', title: 'Brand kit', section: 'Brand',
      url: 'https://drive.example/kit', username: null, body: null, twofa: null,
      password_entry_id: null, file_url: null, file_name: null, file_size: null, mime_type: null,
      pinned: true, created_by: ME, created_at: iso(30, 0) },
    { id: 'lib-2', client_id: 'c-1', kind: 'note', title: 'Reporting cadence', section: 'Process',
      url: null, username: null, body: 'Monthly, first Tuesday.', twofa: null,
      password_entry_id: null, file_url: null, file_name: null, file_size: null, mime_type: null,
      pinned: false, created_by: ME, created_at: iso(20, 0) }
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

  DB.time_sessions = [{ client_id: 'c-1', duration_seconds: 5400, status: 'stopped' },
                      { client_id: 'c-1', duration_seconds: 1800, status: 'stopped' }];
  DB.invoices = [{ client_id: 'c-1', amount_cents: 120000, paid_at: iso(15, 0), currency: 'GBP', number: 'INV-1041' },
                 { client_id: 'c-1', amount_cents: 120000, paid_at: null, currency: 'GBP', number: 'INV-1042' }];
  DB.client_onboarding = [{ id: 'ob-1', client_id: 'c-1', name: 'Maribou', status: 'submitted',
    created_at: iso(60, 0), started_at: iso(59, 0), industry: 'Retail',
    company_website: 'https://maribou.example', timezone: 'Europe/London', working_notes: null,
    keywords: ['gifts', 'homeware'], mrr_cents: 120000, onboarding_sent_at: iso(58, 0),
    onboarding_submitted_at: iso(55, 0), contact_name: 'Ana', contact_email: 'ana@maribou.example',
    contact_phone: null, onboarding_token: 'tok-abc', onboarding_answers: { goals: 'More revenue' } }];
  DB.chat2_client_services = [{ client_id: 'c-1', dept_key: 'seo', active: true, spend_cents: 90000, lead_profile_id: 'u-1' },
                              { client_id: 'c-1', dept_key: 'googleAds', active: false, spend_cents: 0, lead_profile_id: null }];
  DB.chat2_client_access = [{ client_id: 'c-1', service_key: 'ga4', status: 'granted', updated_at: iso(9, 0), updated_by: ME }];
  DB.chat2_client_activity = [{ id: 'ac-1', client_id: 'c-1', actor_id: ME, actor_name: 'Nishchay Pandya',
    kind: 'note', summary: 'Kickoff call done', detail: null, department: 'general', created_at: iso(7, 0) }];

  DB.channel_stars = [{ profile_id: ME, channel_id: 'ch-team-0' }];
  DB.inbox_actions = [];
  DB.scheduled_messages = [];
  DB.unread_counts = DB.channels.slice(0, 6).map(c => ({ profile_id: ME, channel_id: c.id, unread_count: 2 }));
  DB.password_entries = [{ id: 'pw-1', client_id: 'c-1', title: 'GA4', username: 'ops@maribou.example' }];
  DB.password_entry_members = [{ entry_id: 'pw-1', profile_id: ME }];

  // Anything New Chat asks for that was not foreseen: an empty table, loudly noted,
  // rather than a TypeError that would look like a bug in the page.
  const table = (n) => {
    if (!DB[n]) { DB[n] = []; if (!log.unsupported.includes('table:' + n)) log.unsupported.push('table:' + n); }
    return DB[n];
  };

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
        const arr = table(t);
        const rows = (Array.isArray(this._payload) ? this._payload : [this._payload]).map(r => Object.assign({}, r));
        const done = [];
        rows.forEach(r => {
          if (this._mode === 'upsert') {
            const keys = this._onConflict;
            const existing = arr.find(x => keys.every(k => String(x[k]) === String(r[k])));
            if (existing) { Object.assign(existing, r); done.push(existing); return; }
          }
          if (r.id === undefined) r.id = newId(t);
          if (r.created_at === undefined && ['messages', 'tasks'].includes(t)) r.created_at = new Date().toISOString();
          arr.push(r); done.push(r);
        });
        log.writes.push(t + '.' + this._mode + ' x' + done.length);
        const data = done.map(r => projectRow(r, this._cols, t));
        if (this._single) return { data: data[0] || null, error: null };
        return { data: this._returning ? data : null, error: null };
      }

      if (this._mode === 'update') {
        const hit = this._rows();
        hit.forEach(r => Object.assign(r, this._payload));
        log.writes.push(t + '.update x' + hit.length);
        const data = hit.map(r => projectRow(r, this._cols, t));
        if (this._single) return { data: data[0] || null, error: null };
        return { data: this._returning ? data : null, error: null };
      }

      if (this._mode === 'delete') {
        const hit = this._rows();
        const arr = table(t);
        hit.forEach(r => { const i = arr.indexOf(r); if (i >= 0) arr.splice(i, 1); });
        log.writes.push(t + '.delete x' + hit.length);
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
  function Chan(name) { this.topic = name; log.realtime.push(name); }
  Chan.prototype.on = function () { return this; };
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
          getPublicUrl: (path) => ({ data: { publicUrl: 'https://mock.local/' + bucket + '/' + path } }),
          createSignedUrl: (path) => Promise.resolve({ data: { signedUrl: 'https://mock.local/' + bucket + '/' + path }, error: null }),
          remove: () => Promise.resolve({ data: [], error: null }),
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
    counts: () => Object.fromEntries(Object.keys(DB).map(k => [k, DB[k].length])),
    tally: () => {
      const t = {};
      log.queries.forEach(q => { t[q] = (t[q] || 0) + 1; });
      return t;
    }
  };
})();
