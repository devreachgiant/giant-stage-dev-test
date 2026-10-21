-- Can a rep actually run their own day, and still not touch what is not theirs?
--
--   supabase db query --linked -f tools_growth_editable_check.sql
--
-- Rolled back. Seeds rows first so every "cannot" is measured against something that
-- exists -- a refusal counted on an empty table proves nothing, which is the trap
-- 20261012130000 fell into. Both sides every time: the rep must still be able to do
-- their own work, or this is a broken screen rather than a safe one.
begin;
create temp table result(check_name text, pass boolean, detail text);
do $$
declare
  v_staff uuid; v_repA uuid; v_repB uuid; v_client uuid;
  tA uuid := gen_random_uuid(); tB uuid := gen_random_uuid();
  wA uuid := gen_random_uuid();
  n int; m int; ok boolean;
begin
  select id into v_staff from public.profiles where role::text in ('owner','manager','inhouse_dev') limit 1;
  select id into v_repA  from public.profiles where role::text = 'member' limit 1;
  select id into v_repB  from public.profiles where role::text = 'member' and id <> v_repA limit 1;
  select id into v_client from public.profiles where coalesce(role::text,'client') = 'client' limit 1;
  if v_staff is null or v_repA is null then
    insert into result values ('people exist to test with', false, 'need staff + member'); return; end if;
  if v_repB is null then v_repB := v_staff; end if;

  insert into public.growth_tasks (id, owner_id, text) values (tA, v_repA, 'zz rep A task');
  insert into public.growth_tasks (id, owner_id, text) values (tB, v_repB, 'zz rep B task');
  insert into public.growth_watch_calls (id, title, added_by) values (wA, 'zz staff call', v_staff);

  -- ---- a rep running their own day
  perform set_config('request.jwt.claims', json_build_object('sub', v_repA, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.growth_tasks where id = tA;
  update public.growth_tasks set done = true where id = tA; get diagnostics m = row_count;
  reset role;
  insert into result values ('a rep sees their own training task', n = 1, n || ' of 1');
  insert into result values ('a rep can tick it off',             m = 1, m || ' updated');

  perform set_config('request.jwt.claims', json_build_object('sub', v_repA, 'role','authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.growth_tasks (owner_id, text) values (v_repA, 'zz added by rep A');
    get diagnostics n = row_count; ok := (n = 1);
  exception when others then ok := false; n := 0; end;
  reset role;
  insert into result values ('a rep can add their own task', ok, n || ' inserted');

  -- ---- and not somebody else's
  perform set_config('request.jwt.claims', json_build_object('sub', v_repA, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.growth_tasks where id = tB;
  update public.growth_tasks set done = true where id = tB; get diagnostics m = row_count;
  reset role;
  insert into result values ('a rep cannot see another rep''s task',  n = 0, n || ' leaked');
  insert into result values ('a rep cannot tick another rep''s task', m = 0, m || ' changed');

  -- ---- the shared reading list: read and add yes, delete somebody else's no
  perform set_config('request.jwt.claims', json_build_object('sub', v_repA, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.growth_watch_calls where id = wA;
  begin
    insert into public.growth_watch_calls (title, added_by) values ('zz added by rep', v_repA);
    get diagnostics m = row_count; ok := (m = 1);
  exception when others then ok := false; m := 0; end;
  reset role;
  insert into result values ('a rep reads the shared watch list', n = 1, n || ' of 1');
  insert into result values ('a rep can add a call to it',        ok,    m || ' inserted');

  perform set_config('request.jwt.claims', json_build_object('sub', v_repA, 'role','authenticated')::text, true);
  set local role authenticated;
  delete from public.growth_watch_calls where id = wA; get diagnostics n = row_count;
  reset role;
  insert into result values ('a rep cannot delete somebody else''s call', n = 0, n || ' deleted');

  -- ---- money: a rep reads a discount code, staff invent them
  perform set_config('request.jwt.claims', json_build_object('sub', v_repA, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.growth_discounts;
  update public.growth_discounts set label = 'zz hacked'; get diagnostics m = row_count;
  reset role;
  insert into result values ('a rep reads the discount codes',    n > 0, n || ' codes');
  insert into result values ('a rep cannot change a discount',    m = 0, m || ' changed');

  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role','authenticated')::text, true);
  set local role authenticated;
  update public.growth_settings set value = value where key = 'pipeline'; get diagnostics n = row_count;
  update public.growth_discounts set label = label; get diagnostics m = row_count;
  reset role;
  insert into result values ('staff can edit the stage list',  n = 1, n || ' updated');
  insert into result values ('staff can edit discount codes',  m > 0, m || ' updated');

  -- ---- the agency's own clients see none of it
  if v_client is null then
    insert into result values ('an agency client sees no training', false, 'no client profile -- NOT CHECKED');
  else
    perform set_config('request.jwt.claims', json_build_object('sub', v_client, 'role','authenticated')::text, true);
    set local role authenticated;
    select count(*) into n from public.growth_tasks;
    select count(*) into m from public.growth_discounts;
    reset role;
    insert into result values ('an agency client sees no training', n = 0, n || ' tasks visible');
    insert into result values ('an agency client sees no codes',    m = 0, m || ' codes visible');
  end if;

  -- ---- the Training content actually arrived, so the screens are not empty
  select count(*) into n from public.growth_settings where key in ('philosophy','script','pricing');
  insert into result values ('Training content is seeded', n = 3, n || ' of 3 keys');
end $$;
select string_agg((case when pass then 'PASS  ' else 'FAIL  ' end) || rpad(check_name,42) || detail, chr(10) order by ctid) as report,
       count(*) filter (where not pass) as failures, count(*) as total from result;
rollback;
