-- The Pod System: pods, per-account service assignments, and the rate card.
--
-- The shape comes from the design in screenshots/Pod board rates and capacity. Three ideas
-- carry the whole thing:
--
--   a POD holds up to 20 clients under one Pod Leader, who owns the relationships;
--   a CLIENT SERVICE is one service on one client, assigned to one specialist, at a tier;
--   a RATE turns (service, tier) into money per account per month.
--
-- Payroll is then a sum over assignments rather than a number anybody types, which is the
-- point: pay follows the accounts a person actually holds, and stops when an account moves.

-- ── pods ─────────────────────────────────────────────────────────────────────
create table if not exists public.pods (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  leader_id    uuid references public.profiles(id) on delete set null,
  max_clients  integer not null default 20,
  -- "POD 2 OPENS AT 20 CLIENTS": a planned pod is shown before it exists, so the board can
  -- say what happens next rather than only what is true today.
  opens_at     integer,
  status       text not null default 'active' check (status in ('active','planned')),
  position     integer not null default 0,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- ── the pod fields a client needs ────────────────────────────────────────────
-- mrr_cents already exists and is the fee the design calls MRR.
alter table public.clients
  add column if not exists pod_id uuid references public.pods(id) on delete set null;
alter table public.clients
  add column if not exists health text;
alter table public.clients
  add column if not exists pay_day smallint;
alter table public.clients
  add column if not exists pay_cadence text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='clients_health_check') then
    alter table public.clients add constraint clients_health_check
      check (health is null or health in ('green','amber','red'));
  end if;
  if not exists (select 1 from pg_constraint where conname='clients_pay_day_check') then
    alter table public.clients add constraint clients_pay_day_check
      check (pay_day is null or (pay_day between 1 and 31));
  end if;
  if not exists (select 1 from pg_constraint where conname='clients_pay_cadence_check') then
    alter table public.clients add constraint clients_pay_cadence_check
      check (pay_cadence is null or pay_cadence in ('monthly','weekly','quarterly'));
  end if;
end $$;

-- ── one service on one client, held by one specialist ────────────────────────
-- Named pod_assignments, not client_services: that table already exists and means something
-- else -- a billed line with a monthly price -- and two tables one letter apart in meaning
-- is how the wrong one gets joined at two in the morning.
-- A client counts as one relationship however many services they take, so the services live
-- in their own rows rather than as columns on the client.
create table if not exists public.pod_assignments (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  service       text not null check (service in ('google_ads','meta_ads','seo','web')),
  -- SEO has no tiers, so tier is null there rather than a made-up value.
  tier          text check (tier is null or tier in ('standard','growth','advanced')),
  specialist_id uuid references public.profiles(id) on delete set null,
  -- an internal project pays the lower SEO rate
  is_internal   boolean not null default false,
  started_at    date not null default current_date,
  ended_at      date,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- One live assignment per service per client. An ended one may sit alongside it, which is
-- how "account losses are reviewed for cause" stays answerable later.
create unique index if not exists idx_pod_assignments_live
  on public.pod_assignments (client_id, service) where ended_at is null;
create index if not exists idx_pod_assignments_specialist on public.pod_assignments (specialist_id);

-- ── the rate card ────────────────────────────────────────────────────────────
-- A table rather than constants in the page, because the design says rates are reviewed
-- every 90 days, and a review that needs a developer is a review that does not happen.
create table if not exists public.pod_rates (
  id           uuid primary key default gen_random_uuid(),
  service      text not null check (service in ('google_ads','meta_ads','seo','web')),
  tier         text check (tier is null or tier in ('standard','growth','advanced')),
  is_internal  boolean not null default false,
  amount_cents integer not null check (amount_cents >= 0),
  note         text,
  updated_by   uuid references public.profiles(id) on delete set null,
  updated_at   timestamptz not null default now()
);
create unique index if not exists idx_pod_rates_key
  on public.pod_rates (service, coalesce(tier,''), is_internal);

insert into public.pod_rates (service, tier, is_internal, amount_cents, note) values
  ('google_ads','standard', false, 20000, '$0–$10k ad spend'),
  ('google_ads','growth',   false, 25000, '$10k–$50k'),
  ('google_ads','advanced', false, 32500, '$50k+'),
  ('meta_ads','standard',   false, 25000, '$0–$10k ad spend'),
  ('meta_ads','growth',     false, 30000, '$10k–$50k'),
  ('meta_ads','advanced',   false, 40000, '$50k+'),
  ('seo', null,             false, 30000, 'Paying SEO client'),
  ('seo', null,             true,  15000, 'Internal project')
on conflict do nothing;

-- ── who may see any of this ──────────────────────────────────────────────────
-- The board carries MRR, margin and per-person pay, so it is manager-and-above only. A
-- team-member view is a later, narrower policy rather than a filter in the page: hiding a
-- column in the UI is not the same as not sending the number.
alter table public.pods enable row level security;
alter table public.pod_assignments enable row level security;
alter table public.pod_rates enable row level security;

drop policy if exists pods_manager_all on public.pods;
create policy pods_manager_all on public.pods for all to authenticated
  using (public.is_manager_or_owner()) with check (public.is_manager_or_owner());

drop policy if exists pod_rates_manager_all on public.pod_rates;
create policy pod_rates_manager_all on public.pod_rates for all to authenticated
  using (public.is_manager_or_owner()) with check (public.is_manager_or_owner());

-- Managers manage every assignment; a specialist may read the ones that are theirs, which
-- is what a team view will be built on and carries no money with it.
drop policy if exists pod_assignments_manager_all on public.pod_assignments;
create policy pod_assignments_manager_all on public.pod_assignments for all to authenticated
  using (public.is_manager_or_owner()) with check (public.is_manager_or_owner());

drop policy if exists pod_assignments_own_select on public.pod_assignments;
create policy pod_assignments_own_select on public.pod_assignments for select to authenticated
  using (specialist_id = auth.uid());

grant select, insert, update, delete on public.pods, public.pod_assignments, public.pod_rates
  to authenticated;
