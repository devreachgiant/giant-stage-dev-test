-- Workshop: Google Search Console data, per client.
--
-- STAGING FIRST. Written for the stage-dev-test project (dqlbeloaoexulxjjxmgb). Run it
-- there by hand in the SQL editor, after 20261112170000_workshop_connections.sql.
--
-- WHAT IS REUSED, NOT DUPLICATED.
--   * The website is clients.company_website. There is no second "websites" table.
--   * Which Search Console property belongs to which client, and whether the last sync
--     worked, live on workshop_connections (source = 'gsc'): meta.property,
--     meta.last_synced_at, status, last_error.
--   * The agency Google refresh token lives in growth_secrets (key 'gsc_google'), which
--     is already service-role only.
-- So this migration only adds the two tables that hold the numbers themselves.
--
-- ONLY WHAT GOOGLE RETURNED. Every row is a Search Analytics response row, stored as
-- given: clicks, impressions, ctr and position are Google's, never computed here.
-- The 'total' rows are Google's own aggregate (a query with no dimension), not a sum of
-- the daily rows, because Google's totals and the sum of its rows legitimately differ.
--
-- NO DUPLICATES. A re-sync updates rather than adds: daily rows are unique on
-- (client_id, date); breakdown rows on (client_id, period, dimension, key), and each
-- sync replaces the rows of the periods it fetched.
--
-- WHO CAN READ. The same rule as clients and workshop_client_setup: anybody on the team,
-- never a client user. Nobody writes from the browser; only the Netlify functions do,
-- with the service role.

create table if not exists public.workshop_gsc_daily (
  client_id    uuid not null references public.clients(id) on delete cascade,
  date         date not null,
  clicks       integer not null default 0,
  impressions  integer not null default 0,
  ctr          double precision not null default 0,   -- 0..1, as Google returns it
  position     double precision not null default 0,
  synced_at    timestamptz not null default now(),
  primary key (client_id, date)
);

create index if not exists workshop_gsc_daily_date_idx
  on public.workshop_gsc_daily (client_id, date desc);

create table if not exists public.workshop_gsc_breakdown (
  client_id    uuid not null references public.clients(id) on delete cascade,
  period       text not null,      -- last_28d | prev_28d | last_3m
  dimension    text not null,      -- total | query | page | country | device | searchAppearance
  key          text not null default '',   -- '' for total
  clicks       integer not null default 0,
  impressions  integer not null default 0,
  ctr          double precision not null default 0,
  position     double precision not null default 0,
  start_date   date not null,
  end_date     date not null,
  synced_at    timestamptz not null default now(),
  primary key (client_id, period, dimension, key),
  constraint workshop_gsc_breakdown_period_ck
    check (period in ('last_28d', 'prev_28d', 'last_3m')),
  constraint workshop_gsc_breakdown_dimension_ck
    check (dimension in ('total', 'query', 'page', 'country', 'device', 'searchAppearance'))
);

create index if not exists workshop_gsc_breakdown_rank_idx
  on public.workshop_gsc_breakdown (client_id, period, dimension, clicks desc);

alter table public.workshop_gsc_daily     enable row level security;
alter table public.workshop_gsc_breakdown enable row level security;

drop policy if exists workshop_gsc_daily_team_read     on public.workshop_gsc_daily;
drop policy if exists workshop_gsc_breakdown_team_read on public.workshop_gsc_breakdown;

create policy workshop_gsc_daily_team_read on public.workshop_gsc_daily
  for select to authenticated
  using (auth.uid() is not null and not public.is_client_user());

create policy workshop_gsc_breakdown_team_read on public.workshop_gsc_breakdown
  for select to authenticated
  using (auth.uid() is not null and not public.is_client_user());

-- Read only from the browser. No insert/update/delete policies and no write grants:
-- the sync runs in a Netlify function with the service role.
revoke all on public.workshop_gsc_daily     from anon, authenticated;
revoke all on public.workshop_gsc_breakdown from anon, authenticated;
grant select on public.workshop_gsc_daily     to authenticated;
grant select on public.workshop_gsc_breakdown to authenticated;

comment on table public.workshop_gsc_daily is
  'Search Console clicks/impressions/ctr/position per client per day, exactly as Google returned them. Written only by netlify/functions/_workshop_gsc.js.';
comment on table public.workshop_gsc_breakdown is
  'Search Console rows by query/page/country/device/searchAppearance for fixed periods, plus Google''s own total. Each sync replaces the periods it fetched.';
