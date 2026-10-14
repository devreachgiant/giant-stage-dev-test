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

const { asUser } = require('./_mcp_identity');

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
    description: 'Chat channels the caller can see, excluding direct messages.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    run: async (ctx, args = {}) => {
      const rows = await asUser(ctx.accessToken,
        'channels?select=id,name,display_name,kind,department,client_id&is_dm=is.false'
        + `&order=name.asc&limit=${clamp(args.limit, 100, 300)}`);
      return { channels: rows, count: rows.length };
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
const listForProtocol = () => TOOLS.map(({ name, description, inputSchema }) =>
  ({ name, description, inputSchema }));

module.exports = { TOOLS, byName, listForProtocol, clientSource, isManager };
