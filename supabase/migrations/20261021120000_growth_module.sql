-- Growth: the sales side of the business, moved into Giant.
--
-- Luke has been running this as a separate Claude artifact ("ReachGiant Growth Team"). It
-- works, but it keeps its data in that artifact's own store, which means it is invisible to
-- everything else here -- the client who signs in Growth has to be retyped into Clients, and
-- nobody outside that one page can see the pipeline. This brings the data in.
--
-- WHO SEES WHAT. The artifact had two tiers and we keep them:
--
--   owner / manager / inhouse_dev   everything, plus Connectors and Settings
--   member (a sales rep)            only the clients they own. No Connectors, no Settings.
--   client                          nothing at all
--
-- The artifact made a rep "claim" their name from a list on first load, because it had no
-- idea who was signed in. Giant does, so that whole dance is gone: owner_id is a profile.
--
-- COST. Every policy here calls growth_is_staff() inside a scalar subquery -- (select ...) --
-- so the planner hoists it to an InitPlan and runs it once per query rather than once per
-- row. 20261013140000 is the migration that taught us this the hard way: a bare
-- current_role() in a policy cost 27.4ms across 172 rows against 0.6ms hoisted.
--
-- ONE RULE, ENFORCED ONCE. growth_meetings and growth_messages do not repeat the ownership
-- test. They ask whether the client row is visible and let growth_clients answer, the same
-- shape messages_select uses for channels. Two copies of a rule drift; one does not.
--
-- CLIENTS ARE BLOCKED RESTRICTIVELY. 20261012130000 is the migration that taught us a
-- permissive policy cannot take access away -- two permissive policies OR together, so a
-- "clients can't" rule next to a "staff can" rule let clients straight through. The block
-- below is `as restrictive`, which ANDs.

-- ---------------------------------------------------------------- helpers

create or replace function public.growth_is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.role::text in ('owner','manager','inhouse_dev') from public.profiles p where p.id = auth.uid()),
    false);
$$;
revoke all on function public.growth_is_staff() from public;
grant execute on function public.growth_is_staff() to authenticated;

create or replace function public.growth_is_client()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.role::text = 'client' from public.profiles p where p.id = auth.uid()),
    true);  -- no profile row means no business being here
$$;
revoke all on function public.growth_is_client() from public;
grant execute on function public.growth_is_client() to authenticated;

-- ---------------------------------------------------------------- clients (the pipeline)

create table if not exists public.growth_clients (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references public.profiles(id) on delete restrict,
  name          text not null,
  company       text default '',
  email         text default '',
  phone         text default '',
  website       text default '',
  location      text default '',
  timezone      text default '',
  source        text default '',
  stage         text not null default 'call',
  value_monthly numeric(12,2),
  next_step     text default '',
  summary       text default '',
  follow_up_on  date,
  first_call_on date,
  last_call_on  date,
  last_email_on date,
  emails_sent   integer not null default 0,
  calls_held    integer not null default 0,
  won_on        date,
  lost_on       date,
  lost_reason   text default '',
  handled_msg   text default '',          -- id of the last inbound message marked done
  intake        jsonb not null default '{}'::jsonb,   -- what their form said
  call_notes    jsonb not null default '[]'::jsonb,   -- Fathom recaps
  team_notes    jsonb not null default '[]'::jsonb,
  activity_log  jsonb not null default '[]'::jsonb,
  giant_handoff jsonb,                    -- set when queued for the main client list
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists growth_clients_owner_idx on public.growth_clients(owner_id);
create index if not exists growth_clients_stage_idx on public.growth_clients(stage);

-- ---------------------------------------------------------------- meetings

create table if not exists public.growth_meetings (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid references public.growth_clients(id) on delete cascade,
  title       text not null default 'Growth Strategy Session',
  starts_at   timestamptz not null,
  minutes     integer not null default 45,
  actual_min  integer,
  zoom_url    text default '',
  source      text default '',            -- Calendly, ReachGiant, typed in by hand
  brief       text default '',            -- the AI pre-meeting brief
  brief_at    timestamptz,
  external_id text unique,                -- so a re-sync updates rather than duplicates
  created_at  timestamptz not null default now()
);
create index if not exists growth_meetings_client_idx on public.growth_meetings(client_id);
create index if not exists growth_meetings_start_idx  on public.growth_meetings(starts_at desc);

-- ---------------------------------------------------------------- the inbox
-- The artifact kept a whole thread as one jsonb blob per client. One row per message
-- instead, so "what came in today" is an index scan rather than a scan of every blob.

create table if not exists public.growth_messages (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.growth_clients(id) on delete cascade,
  direction   text not null check (direction in ('in','out')),
  subject     text default '',
  body        text default '',
  sent_at     timestamptz not null default now(),
  thread_id   text default '',            -- Gmail thread, for replying in place
  external_id text unique,
  created_at  timestamptz not null default now()
);
create index if not exists growth_messages_client_idx on public.growth_messages(client_id, sent_at desc);

-- ---------------------------------------------------------------- email templates

create table if not exists public.growth_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  subject    text default '',
  body       text default '',
  position   integer not null default 0,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- shared settings
-- stages, discount codes, signature, which connectors are on. One row per key.

create table if not exists public.growth_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);

-- ---------------------------------------------------------------- training

create table if not exists public.growth_training (
  key        text primary key,            -- plan, checklist, calls
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS

alter table public.growth_clients   enable row level security;
alter table public.growth_meetings  enable row level security;
alter table public.growth_messages  enable row level security;
alter table public.growth_templates enable row level security;
alter table public.growth_settings  enable row level security;
alter table public.growth_training  enable row level security;

-- Clients of the agency never see the sales pipeline. Restrictive so it ANDs with
-- everything else rather than being OR'd away.
do $$
declare t text;
begin
  foreach t in array array['growth_clients','growth_meetings','growth_messages',
                           'growth_templates','growth_settings','growth_training']
  loop
    execute format(
      'drop policy if exists %1$s_no_clients on public.%1$s;
       create policy %1$s_no_clients on public.%1$s
         as restrictive for all to authenticated
         using ((select public.growth_is_client()) = false)
         with check ((select public.growth_is_client()) = false);', t);
  end loop;
end $$;

-- Pipeline: staff see all, a rep sees their own.
drop policy if exists growth_clients_rw on public.growth_clients;
create policy growth_clients_rw on public.growth_clients
  for all to authenticated
  using      ((select public.growth_is_staff()) or owner_id = (select auth.uid()))
  with check ((select public.growth_is_staff()) or owner_id = (select auth.uid()));

-- Meetings and messages do not restate the rule. They ask whether the client is visible;
-- RLS on growth_clients applies inside the subquery and answers. A meeting with no client
-- is an internal one, so staff only.
drop policy if exists growth_meetings_rw on public.growth_meetings;
create policy growth_meetings_rw on public.growth_meetings
  for all to authenticated
  using (
    case when client_id is null then (select public.growth_is_staff())
         else exists (select 1 from public.growth_clients c where c.id = client_id) end)
  with check (
    case when client_id is null then (select public.growth_is_staff())
         else exists (select 1 from public.growth_clients c where c.id = client_id) end);

drop policy if exists growth_messages_rw on public.growth_messages;
create policy growth_messages_rw on public.growth_messages
  for all to authenticated
  using      (exists (select 1 from public.growth_clients c where c.id = client_id))
  with check (exists (select 1 from public.growth_clients c where c.id = client_id));

-- Templates, settings and training are shared. Everyone in Growth reads them; only staff
-- change them, which is what hides Settings and Connectors from a rep in practice as well
-- as in the nav.
drop policy if exists growth_templates_read on public.growth_templates;
create policy growth_templates_read on public.growth_templates
  for select to authenticated using (true);
drop policy if exists growth_templates_write on public.growth_templates;
create policy growth_templates_write on public.growth_templates
  for all to authenticated
  using ((select public.growth_is_staff())) with check ((select public.growth_is_staff()));

drop policy if exists growth_settings_read on public.growth_settings;
create policy growth_settings_read on public.growth_settings
  for select to authenticated using (true);
drop policy if exists growth_settings_write on public.growth_settings;
create policy growth_settings_write on public.growth_settings
  for all to authenticated
  using ((select public.growth_is_staff())) with check ((select public.growth_is_staff()));

drop policy if exists growth_training_read on public.growth_training;
create policy growth_training_read on public.growth_training
  for select to authenticated using (true);
drop policy if exists growth_training_write on public.growth_training;
create policy growth_training_write on public.growth_training
  for all to authenticated
  using ((select public.growth_is_staff())) with check ((select public.growth_is_staff()));

revoke all on public.growth_clients, public.growth_meetings, public.growth_messages,
               public.growth_templates, public.growth_settings, public.growth_training
  from anon;

-- ---------------------------------------------------------------- seed
-- The six stages the artifact shipped with. Editable in Settings afterwards.

insert into public.growth_settings (key, value) values
  ('pipeline', jsonb_build_object(
     'staleDays', 5,
     'stages', jsonb_build_array(
       jsonb_build_object('key','booked',   'label','Booked',        'color','#626262'),
       jsonb_build_object('key','call',     'label','Call done',     'color','#1D5FA8'),
       jsonb_build_object('key','proposal', 'label','Proposal sent', 'color','#7C3AED'),
       jsonb_build_object('key','follow',   'label','Following up',  'color','#B7791F'),
       jsonb_build_object('key','won',      'label','Won',           'color','#1F7A45'),
       jsonb_build_object('key','lost',     'label','Lost',          'color','#B3302A'))))
on conflict (key) do nothing;
