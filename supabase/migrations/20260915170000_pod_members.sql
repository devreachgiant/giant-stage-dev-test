-- A pod has a team, and until now that was not written down anywhere.
--
-- The board showed every profile in the workspace on The team, because "who is on this
-- pod" had no answer to give: a person appeared there for the sole reason that they had a
-- Giant account. With one pod that reads as merely untidy. With the second pod -- which
-- the growth plan on this very board says to open at twenty clients -- it stops being
-- answerable at all: nothing would say which pod somebody belongs to.
--
-- Membership is its own fact, not a consequence of holding work. Somebody joins a pod
-- before they are given their first account, and stays in it between accounts; deriving
-- the team from live assignments would make a person flicker out of their own pod the
-- moment their last account moved.

create table if not exists public.pod_members (
  pod_id      uuid not null references public.pods(id) on delete cascade,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  added_by    uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (pod_id, profile_id)
);
create index if not exists idx_pod_members_profile on public.pod_members (profile_id);

-- Somebody can be in two pods: a specialist "can support clients across pods" in as many
-- words on How it works, so the primary key is the pair and not the person.

-- ── backfill ─────────────────────────────────────────────────────────────────
-- Whoever already holds live work on a client in a pod is in that pod. Nobody has to be
-- added by hand for the board to look the same the moment this is applied.
insert into public.pod_members (pod_id, profile_id)
select distinct c.pod_id, a.specialist_id
  from public.pod_assignments a
  join public.clients c on c.id = a.client_id
 where a.ended_at is null and a.specialist_id is not null and c.pod_id is not null
on conflict do nothing;

-- And the Pod Leader, who holds no accounts at all and would otherwise be the one person
-- missing from their own pod.
insert into public.pod_members (pod_id, profile_id)
select id, leader_id from public.pods where leader_id is not null
on conflict do nothing;

-- ── one pay row per person ───────────────────────────────────────────────────
-- team_pay has never had this, and it did not matter while Team Pay was the only screen
-- that wrote to it. The pod board can now set somebody's pay too, and two screens able to
-- insert for the same person is exactly how a second row appears -- after which every
-- figure on this board silently reads whichever one the planner returned first. There are
-- no duplicates today, so this can simply be declared.
create unique index if not exists idx_team_pay_one_per_profile on public.team_pay (profile_id);

-- ── who may see and change it ────────────────────────────────────────────────
-- The team reads it -- a specialist should be able to see who else is in their pod -- and
-- managers change it. The same split as the rest of the board.
alter table public.pod_members enable row level security;

drop policy if exists pod_members_team_select on public.pod_members;
create policy pod_members_team_select on public.pod_members
  for select to authenticated
  using (auth.uid() is not null and not public.is_client_user());

drop policy if exists pod_members_manager_write on public.pod_members;
create policy pod_members_manager_write on public.pod_members
  for all to authenticated
  using (public.is_manager_or_owner()) with check (public.is_manager_or_owner());

grant select, insert, update, delete on public.pod_members to authenticated;
