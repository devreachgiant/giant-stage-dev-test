// What an assistant can ask Giant for.
//
// Read-only, deliberately. Every one of these runs as the person whose token was presented,
// so what comes back is what they could already see by opening the app.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: read through the per-role VIEW, never the base
// table. Measured on production on 2026-10-12 -- a member selecting from public.clients
// gets all 58 rows WITH mrr_cents and contact_name. The app hides those by querying
// clients_public instead, so that protection is the app's choice of view, not row-level
// security on the table. An assistant reading base tables would hand a specialist every
// client's MRR: not by breaking a rule, by walking around one.
//
// So clientSource() below mirrors what the app does, and there is a check that a member
// connecting through MCP cannot see financials. If a tool is ever added that reads
// public.clients directly, that check is the thing that should fail.

const { asUser, writeAsUser } = require('./_mcp_identity');

const MANAGER_ROLES = ['owner', 'manager', 'inhouse_dev'];
const isManager = (role) => MANAGER_ROLES.includes(String(role || '').toLowerCase());

// The same ladder the app climbs: owners see everything, managers see contact details and
// dates, everybody else sees neither.
function clientSource(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'owner' || r === 'inhouse_dev') return 'clients';
  if (r === 'manager') return 'clients_manager';
  return 'clients_public';
}

const clamp = (n, def, max) => {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v) || v < 1) return def;
  return Math.min(v, max);
};
const esc = (s) => encodeURIComponent(String(s == null ? '' : s));

const TOOLS = [
  {
    name: 'list_clients',
    description:
      'List clients on the books, newest first. Returns only the fields the caller is ' +
      'allowed to see: financials and contact details are omitted unless their role ' +
      'already grants them in the app.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: active, onboarding, paused, churned' },
        search: { type: 'string', description: 'Match part of a client name' },
        limit:  { type: 'number', description: 'How many to return (default 50, max 200)' },
      },
    },
    run: async (ctx, args = {}) => {
      const src = clientSource(ctx.role);
      const cols = isManager(ctx.role)
        ? 'id,name,status,started_at,next_charge_on,ends_on,contact_name'
        : 'id,name,status,started_at';
      let q = `${src}?select=${cols}&order=created_at.desc&limit=${clamp(args.limit, 50, 200)}`;
      if (args.status) q += `&status=eq.${esc(args.status)}`;
      if (args.search) q += `&name=ilike.*${esc(args.search)}*`;
      const rows = await asUser(ctx.accessToken, q);
      return { clients: rows, count: rows.length, readAs: ctx.role, source: src };
    },
  },

  {
    name: 'list_tasks',
    description:
      'Tasks across projects the caller can see. Use status to narrow (todo, in_progress, ' +
      'blocked, done) and overdue:true for anything past its due date and not finished.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        status:     { type: 'string' },
        overdue:    { type: 'boolean' },
        search:     { type: 'string', description: 'Match part of a task name' },
        limit:      { type: 'number' },
      },
    },
    run: async (ctx, args = {}) => {
      let q = 'tasks?select=id,name,status,priority_label,due_date,project_id,assigned_to,created_at'
            + `&order=created_at.desc&limit=${clamp(args.limit, 50, 200)}`;
      if (args.project_id) q += `&project_id=eq.${esc(args.project_id)}`;
      if (args.status)     q += `&status=eq.${esc(args.status)}`;
      if (args.search)     q += `&name=ilike.*${esc(args.search)}*`;
      if (args.overdue) {
        q += `&due_date=lt.${new Date().toISOString().slice(0, 10)}&status=neq.done`;
      }
      const rows = await asUser(ctx.accessToken, q);
      return { tasks: rows, count: rows.length };
    },
  },

  {
    name: 'list_projects',
    description: 'Projects the caller is a member of or can otherwise see.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    run: async (ctx, args = {}) => {
      const rows = await asUser(ctx.accessToken,
        `projects?select=id,name,client_id,created_at&order=created_at.desc&limit=${clamp(args.limit, 50, 200)}`);
      return { projects: rows, count: rows.length };
    },
  },

  {
    name: 'search_messages',
    description:
      'Search chat messages the caller can see. Private channels they are not a member of ' +
      'never appear, because the search runs as them.',
    inputSchema: {
      type: 'object',
      properties: {
        query:      { type: 'string', description: 'Text to look for' },
        channel_id: { type: 'string' },
        limit:      { type: 'number' },
      },
      required: ['query'],
    },
    run: async (ctx, args = {}) => {
      if (!args.query || !String(args.query).trim()) {
        return { error: 'A search needs something to look for.' };
      }
      let q = 'messages?select=id,body,created_at,author_id,channel_id'
            + `&body=ilike.*${esc(args.query.trim())}*`
            + `&order=created_at.desc&limit=${clamp(args.limit, 25, 100)}`;
      if (args.channel_id) q += `&channel_id=eq.${esc(args.channel_id)}`;
      const rows = await asUser(ctx.accessToken, q);
      return { messages: rows, count: rows.length };
    },
  },

  {
    name: 'list_channels',
    description:
      'Chat channels the caller can see. Set include_dms to also list direct messages, ' +
      'each labelled with who it is with — that is how you find where to send someone a DM.',
    inputSchema: {
      type: 'object',
      properties: {
        include_dms: { type: 'boolean', description: 'Also list direct messages' },
        search:      { type: 'string', description: 'Match part of a channel or person name' },
        limit:       { type: 'number' },
      },
    },
    run: async (ctx, args = {}) => {
      const lim = clamp(args.limit, 100, 300);
      let q = 'channels?select=id,name,display_name,kind,department,client_id,is_dm,is_group'
            + `&order=name.asc&limit=${lim}`;
      if (!args.include_dms) q += '&is_dm=is.false';
      const rows = await asUser(ctx.accessToken, q);

      // A DM's row has no useful name on it -- the app works out who it is with from its
      // members. Without that, an assistant asked to message a person has a list of
      // conversations it cannot tell apart, which is exactly where this fell over: it could
      // post a message and had no way to find where to post it.
      const dmIds = rows.filter(r => r.is_dm).map(r => r.id);
      if (dmIds.length) {
        const members = await asUser(ctx.accessToken,
          'channel_members?select=channel_id,profile_id,profiles(id,full_name,email)'
          + `&channel_id=in.(${dmIds.join(',')})&limit=1000`);
        const byChannel = new Map();
        members.forEach(m => {
          if (!byChannel.has(m.channel_id)) byChannel.set(m.channel_id, []);
          byChannel.get(m.channel_id).push(m);
        });
        rows.forEach(r => {
          if (!r.is_dm) return;
          const others = (byChannel.get(r.id) || []).filter(m => m.profile_id !== ctx.profileId);
          r.with = others.map(m => (m.profiles || {}).full_name).filter(Boolean).join(', ');
          r.with_ids = others.map(m => m.profile_id);
          // Spelled out, because "with: Rash" and "with: Mave, Noor, Rash, V" look alike at
          // a glance and one of them is a private message to a person while the other is a
          // group of five. Searching for a name matches both.
          r.dm_kind = (r.is_group || others.length > 1) ? 'group' : 'one-to-one';
        });
      }

      const needle = String(args.search || '').trim().toLowerCase();
      const out = needle
        ? rows.filter(r => [r.display_name, r.name, r.with].some(
            v => String(v || '').toLowerCase().includes(needle)))
        : rows;
      return { channels: out, count: out.length,
               note: args.include_dms
                 ? 'Direct messages carry "with" (who it is with) and "dm_kind". A search '
                   + 'for a person matches their one-to-one AND any group they are in, so '
                   + 'check dm_kind is "one-to-one" before sending anything private.'
                 : 'Direct messages are not included. Pass include_dms to see them.' };
    },
  },

  {
    name: 'list_people',
    description:
      'Teammates in the workspace, with the ids other tools need. Use this to turn a name ' +
      'like "Rash" into the person, then find their direct message with list_channels.',
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Match part of a name or email' } },
    },
    run: async (ctx, args = {}) => {
      let q = 'profiles?select=id,full_name,email,role&order=full_name.asc&limit=200';
      if (args.search) q += `&or=(full_name.ilike.*${esc(args.search)}*,email.ilike.*${esc(args.search)}*)`;
      const rows = await asUser(ctx.accessToken, q);
      return { people: rows, count: rows.length };
    },
  },

  {
    name: 'list_meetings',
    description: 'Upcoming bookings and meetings the caller can see.',
    inputSchema: {
      type: 'object',
      properties: { upcoming_only: { type: 'boolean' }, limit: { type: 'number' } },
    },
    run: async (ctx, args = {}) => {
      let q = 'bookings?select=id,start_at,end_at,status,guest_name,guest_email,event_type_id'
            + `&order=start_at.asc&limit=${clamp(args.limit, 50, 200)}`;
      if (args.upcoming_only !== false) q += `&start_at=gte.${new Date().toISOString()}`;
      const rows = await asUser(ctx.accessToken, q);
      return { meetings: rows, count: rows.length };
    },
  },

  // ── the ones that change things ────────────────────────────────────────────
  //
  // Create and update only. There is deliberately no delete tool, and adding one later
  // should be an argued decision rather than a convenience: this assistant READS chat, so
  // anyone who can type in a channel can put words in front of it. The defence that
  // actually holds is not owning the dangerous verb.
  //
  // Each of these runs as the person, so the database refuses anything they could not do by
  // hand -- and writeAsUser turns a silent zero-row refusal into an error the assistant can
  // repeat back, instead of reporting success for a change that never happened.
  {
    name: 'create_task',
    writes: true,
    description:
      'Create a task. Needs a name and the project it belongs to — find one with ' +
      'list_projects first. Returns the task it made, so you can tell the person what was ' +
      'created rather than assuming it worked.',
    inputSchema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'What the task is' },
        description: { type: 'string' },
        project_id:  { type: 'string', description: 'Required — the project it belongs to' },
        client_id:   { type: 'string' },
        assigned_to: { type: 'string', description: 'Profile id of the person it is for' },
        due_date:    { type: 'string', description: 'yyyy-mm-dd' },
        status:      { type: 'string' },
      },
      required: ['name', 'project_id'],
    },
    run: async (ctx, args = {}) => {
      const name = String(args.name || '').trim();
      if (!name) return { error: 'A task needs a name.' };
      // Not optional, whatever it looks like. Both insert policies on tasks key off the
      // project -- is_project_member(project_id), or can_edit_project(project_id) -- so a
      // task without one is refused every time. Asked for plainly here, because
      // "new row violates row-level security policy" tells the person nothing they can act
      // on, and an assistant will simply try again the same way.
      if (!args.project_id) {
        return { error: 'Which project should this task go in? Use list_projects to find '
                      + 'one, then pass its id as project_id.' };
      }
      const row = { name, created_by: ctx.profileId };
      ['description', 'project_id', 'client_id', 'assigned_to', 'status'].forEach(k => {
        if (args[k]) row[k] = args[k];
      });
      // Parsed as written, never through new Date(): '2026-10-01' read as a Date is UTC
      // midnight, which is the day before for anybody west of Greenwich.
      if (args.due_date && /^\d{4}-\d{2}-\d{2}$/.test(args.due_date)) row.due_date = args.due_date;
      const rows = await writeAsUser(ctx.accessToken, 'tasks', 'POST', row);
      return { created: rows[0], note: 'Task created.' };
    },
  },

  {
    name: 'update_task',
    writes: true,
    description:
      'Change a task that already exists — its name, status, due date, who it is for. ' +
      'Only the fields you pass are changed.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id:     { type: 'string' },
        name:        { type: 'string' },
        description: { type: 'string' },
        status:      { type: 'string' },
        assigned_to: { type: 'string' },
        due_date:    { type: 'string', description: 'yyyy-mm-dd, or empty to clear it' },
      },
      required: ['task_id'],
    },
    run: async (ctx, args = {}) => {
      if (!args.task_id) return { error: 'Which task? Pass task_id.' };
      const patch = {};
      ['name', 'description', 'status', 'assigned_to'].forEach(k => {
        if (args[k] !== undefined) patch[k] = args[k];
      });
      if (args.due_date !== undefined) {
        patch.due_date = (args.due_date && /^\d{4}-\d{2}-\d{2}$/.test(args.due_date))
          ? args.due_date : null;
      }
      if (!Object.keys(patch).length) return { error: 'Nothing to change.' };
      const rows = await writeAsUser(ctx.accessToken,
        `tasks?id=eq.${esc(args.task_id)}`, 'PATCH', patch);
      return { updated: rows[0], changed: Object.keys(patch) };
    },
  },

  {
    name: 'post_message',
    writes: true,
    description:
      'Post a message to a channel or a direct message, as the person. Use list_channels ' +
      'to find the channel first. It appears under their name, so say so before posting.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string' },
        body:       { type: 'string', description: 'What to say' },
      },
      required: ['channel_id', 'body'],
    },
    run: async (ctx, args = {}) => {
      const body = String(args.body || '').trim();
      if (!args.channel_id || !body) return { error: 'A message needs a channel and something to say.' };
      const rows = await writeAsUser(ctx.accessToken, 'messages', 'POST', {
        channel_id: args.channel_id, author_id: ctx.profileId, body,
      });
      return { posted: { id: rows[0].id, channel_id: rows[0].channel_id },
               note: 'Posted under ' + ctx.name + '.' };
    },
  },

  {
    name: 'update_client',
    writes: true,
    description:
      'Change a client record — status, contact details, dates. Only the fields you pass ' +
      'are changed. Cannot create or remove a client.',
    inputSchema: {
      type: 'object',
      properties: {
        client_id:      { type: 'string' },
        status:         { type: 'string', description: 'active, onboarding, paused, churned' },
        contact_name:   { type: 'string' },
        contact_email:  { type: 'string' },
        next_charge_on: { type: 'string', description: 'yyyy-mm-dd' },
        notes:          { type: 'string' },
      },
      required: ['client_id'],
    },
    run: async (ctx, args = {}) => {
      if (!args.client_id) return { error: 'Which client? Pass client_id.' };
      const patch = {};
      ['status', 'contact_name', 'contact_email', 'notes'].forEach(k => {
        if (args[k] !== undefined) patch[k] = args[k];
      });
      if (args.next_charge_on && /^\d{4}-\d{2}-\d{2}$/.test(args.next_charge_on)) {
        patch.next_charge_on = args.next_charge_on;
      }
      if (!Object.keys(patch).length) return { error: 'Nothing to change.' };
      // Always the base table for a write: the per-role views are for reading, and an
      // update aimed at one would either fail or quietly write somewhere unexpected.
      const rows = await writeAsUser(ctx.accessToken,
        `clients?id=eq.${esc(args.client_id)}`, 'PATCH', patch);
      return { updated: { id: rows[0].id, name: rows[0].name }, changed: Object.keys(patch) };
    },
  },

  {
    name: 'whoami',
    description:
      'Who this connection is acting as, and therefore what it can see. Useful when an ' +
      'answer looks short: it is probably short because of who is asking.',
    inputSchema: { type: 'object', properties: {} },
    run: async (ctx) => ({
      name: ctx.name, email: ctx.email, role: ctx.role,
      note: 'Everything is read as this person, under their own permissions.',
    }),
  },
];

const byName = (n) => TOOLS.find(t => t.name === n) || null;
// What a connection may see depends on what it was granted. A read-only connection is not
// shown the writing tools at all -- an assistant that cannot see a tool does not try it, and
// does not tell the person it could have done something it cannot.
const listForProtocol = (canWrite) => TOOLS
  .filter(t => canWrite || !t.writes)
  .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

module.exports = { TOOLS, byName, listForProtocol, clientSource, isManager };
