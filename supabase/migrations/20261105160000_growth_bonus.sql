-- Sales bonus: what each rep is owed on a sale, and what has been paid against it.
--
-- Asked for by Luke, with one rule stated twice and very plainly: "This is only for a
-- manager to add, that's really important. I can be able to see it, but Annie can only
-- view. Nobody can change this except me."
--
-- WHY A POLICY AND NOT JUST A HIDDEN FORM. His own version hides the form from
-- non-managers and stops there, which is the right shape for an artifact and the wrong
-- one for this. The numbers here are what somebody gets paid. A gate that lives only in
-- the page is a gate that holds until somebody opens a console, and "Annie can only
-- view" should not depend on Annie not being curious. The screen hides the form AND the
-- database refuses the write -- neither alone.
--
-- WHY A NEW HELPER. growth_is_staff() already exists and is exactly wrong for this: it
-- includes role 'growth', which is Annie. A bonus is readable by the whole sales team
-- and writable by the people who decide what gets paid, and those are two different
-- lists for the first time in this module.
--
-- PAYMENTS ARE A jsonb ARRAY on the sale, not their own table. A payment has no meaning
-- apart from the sale it is against -- it is never listed, filtered or joined on its
-- own -- and a sale carries two or three of them. A second table would buy a join and
-- cost a second policy to keep in step with this one.
--
-- TWO SHAPES OF "NO", worth knowing before reading the numbers below. An insert refused
-- by a `with check` RAISES; an update or delete refused by a `using` returns no rows.
-- A probe that only counted rows would read the refused insert as a crash rather than
-- as the refusal it is, so the write attempts were caught and recorded as 0.
--
-- MEASURED in a rolled-back transaction before this was applied, both sides, because
-- "0 rows" from Annie proves nothing unless a manager writing the same row returns 1:
--
--   a manager inserts a sale                     1
--   Annie (role growth) reads it                 1
--   Annie inserts a sale                         0
--   Annie changes what she is owed                0
--   Annie deletes it                             0
--   a client reads it                            0
--   the sale survived untouched at 3000          1
--
-- and afterwards: table left behind 0, function left behind 0.

create or replace function public.growth_is_manager()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
    (select p.role::text in ('owner','manager','inhouse_dev')
       from public.profiles p where p.id = auth.uid()),
    false);  -- no profile row means no business writing payroll
$function$;

create table if not exists public.growth_bonus (
  id          uuid primary key default gen_random_uuid(),
  rep_id      uuid not null references public.profiles(id) on delete cascade,
  -- The deal it came from, kept loosely: a sale that has been paid is a fact about the
  -- money even after somebody tidies the pipeline, so losing the deal must not lose it.
  client_id   uuid references public.growth_clients(id) on delete set null,
  client_name text not null default '',
  deal        text not null default '',
  amount      numeric(12,2) not null default 0,
  pct         numeric(5,2) not null default 10,
  sold_on     date not null default current_date,
  -- [{ id, amount, date }] -- see the note above on why this is not its own table.
  payments    jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id)
);

create index if not exists growth_bonus_rep_idx on public.growth_bonus (rep_id, sold_on desc);

alter table public.growth_bonus enable row level security;

-- READ: the whole sales team, which is what lets Annie see her own bonus. Clients are
-- refused by the same test every other growth_ table uses.
drop policy if exists growth_bonus_read on public.growth_bonus;
create policy growth_bonus_read on public.growth_bonus
  for select using ((select public.growth_is_staff()) = true);

-- WRITE: managers only. Split into three rather than one FOR ALL so that a future
-- change to one of them cannot quietly widen the other two.
drop policy if exists growth_bonus_insert on public.growth_bonus;
create policy growth_bonus_insert on public.growth_bonus
  for insert with check ((select public.growth_is_manager()) = true);

drop policy if exists growth_bonus_update on public.growth_bonus;
create policy growth_bonus_update on public.growth_bonus
  for update using ((select public.growth_is_manager()) = true)
           with check ((select public.growth_is_manager()) = true);

drop policy if exists growth_bonus_delete on public.growth_bonus;
create policy growth_bonus_delete on public.growth_bonus
  for delete using ((select public.growth_is_manager()) = true);

revoke all on public.growth_bonus from anon;
