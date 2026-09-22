-- The team-member view of the pod board, enforced where it has to be.
--
-- Until now the whole feature was manager-and-above: pods, pod_rates and pod_assignments
-- all read is_manager_or_owner(), and the screen was hidden from members with CSS. Luke
-- asked for a team-member view "without the MRR and payment dates etc." -- so a specialist
-- can now open the board and see the accounts they hold, what those accounts pay them, and
-- the rate card their pay comes off.
--
-- The page asks for a narrower set of columns for a specialist, which is the right thing
-- to do and is not a security boundary: anyone can retype a PostgREST query. So the rule
-- is written here. What a specialist may read:
--
--   pods            yes -- name, leader and capacity. No money on this table.
--   pod_rates       yes -- the rate card is their own compensation scheme.
--   pod_assignments only their own, which pod_assignments_own_select already said.
--   team_pay        only their own row.
--   pay_departments yes -- names, and the capacity band those names imply.
--
-- and what they may not: anybody else's assignments, from which a colleague's per-account
-- pay would follow directly through the rate card, and anybody else's pay row.
--
-- Nothing here is granted to client users. Every policy below is guarded with
-- is_client_user() so a client account that reaches the table gets nothing, which the
-- nav-hiding pass in the page cannot promise on its own.

-- ── pods: readable by the team, writable by managers ─────────────────────────
-- pods_manager_all stays and still carries insert, update and delete. This adds reading
-- only, as its own policy, so the two cannot be confused later.
drop policy if exists pods_team_select on public.pods;
create policy pods_team_select on public.pods
  for select to authenticated
  using (auth.uid() is not null and not public.is_client_user());

-- ── the rate card ────────────────────────────────────────────────────────────
drop policy if exists pod_rates_team_select on public.pod_rates;
create policy pod_rates_team_select on public.pod_rates
  for select to authenticated
  using (auth.uid() is not null and not public.is_client_user());

-- ── a person's own pay row ───────────────────────────────────────────────────
-- team_pay_manage is ALL to managers and is left alone. This is select on your own row
-- and nothing else: it is where the board learns which department somebody is in, and a
-- department is what sets their capacity. Reading your own pay is not a disclosure.
drop policy if exists team_pay_own_select on public.team_pay;
create policy team_pay_own_select on public.team_pay
  for select to authenticated
  using (profile_id = auth.uid());

-- ── department names ─────────────────────────────────────────────────────────
drop policy if exists pay_departments_team_select on public.pay_departments;
create policy pay_departments_team_select on public.pay_departments
  for select to authenticated
  using (auth.uid() is not null and not public.is_client_user());

-- pod_assignments needs nothing: pod_assignments_own_select already allows exactly the
-- rows a specialist may read, and was written for this view before it existed.

grant select on public.pods, public.pod_rates to authenticated;
grant select on public.team_pay, public.pay_departments to authenticated;
