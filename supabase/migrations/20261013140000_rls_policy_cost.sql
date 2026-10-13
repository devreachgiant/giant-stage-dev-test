-- The client-isolation rules shipped this morning made the app slow for everyone.
--
-- Matthew: "Everything is super slow loading". Measured on production as a member:
--
--                                        before      after
--   50 messages in the busiest channel   117.4 ms    13.1 ms
--   list all channels                     49.6 ms     1.2 ms
--
-- Two mistakes in 20261013130000, both mine, both about COST rather than correctness. That
-- migration measured both sides of the security question carefully and never once measured
-- what the rule costs to evaluate -- on an expression that runs on every read in the app.
--
-- 1. current_role() was the FIRST thing in the condition, so it ran for every row. It is a
--    SECURITY DEFINER lookup into profiles. Measured directly, without any DDL:
--
--      current_role() called per row ........ 27.4 ms across 172 channels
--      the same call hoisted ................  0.6 ms
--      172 bare calls .......................  48.8 ms
--
--    Wrapping a call in a scalar subquery -- (select current_role()) -- lets the planner
--    hoist it to an InitPlan evaluated ONCE per query. Before this morning the call sat in
--    the last OR branch and was short-circuited for most rows, which is why nobody noticed
--    it was expensive.
--
-- 2. messages_select carried its own copy of the whole rule. RLS on channels ALSO applies
--    inside that subquery, so the expression ran twice per row -- the plan showed the CASE
--    twice, with four separate SubPlans. messages_select now just asks whether the channel
--    is visible and lets the channels policy answer. One rule, enforced once, which also
--    removes the drift between two copies that the previous migration was worried about.
--
-- APPLYING THIS: a policy swap takes an AccessExclusiveLock and blocks every read on the
-- table until it completes. Run each statement in its OWN short transaction with
-- `set lock_timeout = '5s'`, and retry on failure. Applied as one migration against a busy
-- table it will either freeze chat or deadlock -- it deadlocked twice here before being
-- split up.

set lock_timeout = '5s';

drop policy if exists channels_select on public.channels;
create policy channels_select on public.channels
  for select to authenticated
  using (
    case when coalesce((select public."current_role"())::text, 'client') = 'client' then
      (
        (kind = 'client_dept' and client_id is not null and client_id = (select public.my_client_id()))
        or (is_dm = true and exists (
              select 1 from public.channel_members cm
               where cm.channel_id = channels.id and cm.profile_id = (select auth.uid())))
      )
    else
      (
        is_private = false
        or exists (select 1 from public.channel_members cm
                    where cm.channel_id = channels.id and cm.profile_id = (select auth.uid()))
        or (is_dm = false and (select public."current_role"()) = 'inhouse_dev'::user_role)
      )
    end
  );

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages
  for select to authenticated
  using (exists (select 1 from public.channels c where c.id = messages.channel_id));
