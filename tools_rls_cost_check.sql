-- What do the row-level security rules COST?
--
--   supabase db query --linked -f tools_rls_cost_check.sql
--
-- Written after the client-isolation rules made the whole app slow. That change was measured
-- carefully for correctness -- both sides, every role -- and never once for cost, on an
-- expression that runs on every read in the app. 50 messages went from 13 ms to 117 ms and
-- nobody noticed until Matthew said "everything is super slow loading".
--
-- Two kinds of check, and the structural ones are the ones that work.
--
-- Verified by putting the broken rules back inside a rolled-back transaction: the structural
-- checks failed immediately and named the policies, while BOTH timing checks still passed at
-- 9.4 ms. A warm transaction with no concurrent load does not reproduce what 14 people
-- hitting the app at once does. Treat the timings as a coarse backstop and a number worth
-- reading, never as the thing standing between a slow rule and production.
--
-- STRUCTURAL: a function called bare in a policy runs ONCE PER ROW. Wrapped in a scalar
-- subquery -- (select current_role()) -- the planner hoists it to an InitPlan and calls it
-- once per query. Measured on this database: 27.4 ms per-row versus 0.6 ms hoisted, across
-- 172 channels. This fails if any policy on a hot table calls one of these bare.
--
-- Read-only. Takes no locks. Safe to run against production whenever.
begin;

create temp table result(check_name text, pass boolean, detail text);

-- ── 1. no un-hoisted PROFILE LOOKUPS in SELECT policies on hot tables ────────
--
-- Scoped deliberately. A first version flagged every bare auth.uid() too and failed on 15
-- pre-existing policies -- a check that fails on things nobody is going to fix today is a
-- check that gets ignored or deleted, and it would have buried the one finding that
-- mattered. So this fails only on the calls measured to be expensive here:
-- current_role() and my_client_id(), which read from profiles, inside SELECT policies,
-- which are the ones evaluated across whole tables. Bare auth.uid() reads a setting rather
-- than a table and is reported below as information, not as a failure.
with pol as (
  select c.relname as tbl, p.polname, pg_get_expr(p.polqual, p.polrelid) as e
    from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname in ('channels','messages','channel_members','message_attachments',
                       'message_reactions','message_reads','unread_counts')
     and p.polcmd in ('r','*')
     and p.polqual is not null
), counted as (
  select tbl, polname, fn,
         (length(e) - length(replace(e, fn || '()', ''))) / nullif(length(fn || '()'), 0) as total,
         (length(e) - length(replace(e, 'SELECT ' || fn || '()', ''))) / nullif(length('SELECT ' || fn || '()'), 0) as hoisted
    from pol, lateral (values ('"current_role"'), ('my_client_id')) f(fn)
)
insert into result
select 'no per-row profile lookups in SELECT policies',
       coalesce(bool_and(coalesce(total,0) = coalesce(hoisted,0)), true),
       coalesce(string_agg(tbl || '.' || polname || ' calls ' || fn || ' bare '
                           || (total - hoisted) || 'x', '; ')
                filter (where coalesce(total,0) <> coalesce(hoisted,0)),
                'every profile lookup is wrapped in (select ...)')
  from counted;

-- ── 2. the rule is written once, not copied ──────────────────────────────────
insert into result
select 'messages_select defers to channels rather than copying it',
       (select pg_get_expr(polqual, polrelid) !~* 'is_private'
          from pg_policy p join pg_class c on c.oid = p.polrelid
         where c.relname = 'messages' and p.polname = 'messages_select'),
       'a second copy of the visibility rule evaluates the whole expression twice per row';

-- ── 3. what it actually costs right now ──────────────────────────────────────
do $$
declare v_me uuid; v_ch uuid; t0 timestamptz; n int; d_msg numeric; d_ch numeric;
begin
  select id into v_me from public.profiles where role = 'member' limit 1;
  select channel_id into v_ch from public.messages group by channel_id order by count(*) desc limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_me, 'role','authenticated')::text, true);
  set local role authenticated;
  t0 := clock_timestamp();
  select count(*) into n from (select * from public.messages where channel_id = v_ch
                                order by created_at desc limit 50) q;
  d_msg := extract(milliseconds from clock_timestamp() - t0);
  t0 := clock_timestamp();
  select count(*) into n from public.channels;
  d_ch := extract(milliseconds from clock_timestamp() - t0);
  reset role;
  -- Budgets are deliberately loose: this runs against a live database over the network and
  -- a tight threshold would cry wolf. They are set to catch the SHAPE of the regression --
  -- 117 ms and 50 ms were what the broken rule cost -- not to police milliseconds.
  insert into result values
    ('opening a channel stays under 50ms', d_msg < 50, round(d_msg,1) || ' ms for 50 messages'),
    ('listing channels stays under 15ms',  d_ch  < 15, round(d_ch,1)  || ' ms for every channel');
end $$;

-- Reported, not enforced: bare auth.uid() reads a setting rather than a table, so it is
-- far cheaper than a profile lookup -- but wrapping it still helps on a large scan, and
-- knowing where they are beats pretending they are not there.
insert into result
select 'note: policies with a bare auth.uid()', true,
       coalesce(count(*)::text || ' policies (informational, not a failure)', '0')
  from pg_policy p join pg_class c on c.oid = p.polrelid
 where c.relname in ('channels','messages','channel_members','message_attachments',
                     'message_reactions','message_reads','unread_counts')
   and p.polqual is not null
   and pg_get_expr(p.polqual, p.polrelid) like '%auth.uid()%'
   and pg_get_expr(p.polqual, p.polrelid) not like '%SELECT auth.uid()%';

select case when pass then 'PASS' else 'FAIL' end as status, check_name, detail from result
union all
select case when bool_and(pass) then 'ALL PASS' else 'FAILURES PRESENT' end,
       count(*) filter (where pass) || '/' || count(*) || ' checks passed', '' from result;

rollback;
