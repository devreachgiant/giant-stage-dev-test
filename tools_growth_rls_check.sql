-- Can a sales rep see somebody else's deal? Can an agency client see the pipeline at all?
--
--   supabase db query --linked -f tools_growth_rls_check.sql
--
-- Everything runs inside a transaction that is ROLLED BACK, measured through real row-level
-- security as three different people.
--
-- It SEEDS two pipeline clients, one owned by each of two reps, before measuring. Without
-- that, "a rep sees 0 of someone else's clients" passes on an empty table and proves
-- nothing -- the same trap 20261012130000 fell into, where a client-block policy that did
-- nothing at all looked like it was working because nobody had seeded a row to measure.
--
-- Both sides are measured every time: the rep must still see their OWN client. A rule that
-- hides everything from everyone is not security, it is a broken screen.

begin;

create temp table result(check_name text, pass boolean, detail text);

do $$
declare
  v_staff   uuid;
  v_repA    uuid;
  v_repB    uuid;
  v_client  uuid;
  cA uuid := gen_random_uuid();
  cB uuid := gen_random_uuid();
  n int; m int;
  ok boolean;
begin
  select id into v_staff from public.profiles where role::text in ('owner','manager','inhouse_dev') limit 1;
  select id into v_repA  from public.profiles where role::text = 'member' limit 1;
  select id into v_repB  from public.profiles where role::text = 'member' and id <> v_repA limit 1;
  select id into v_client from public.profiles where coalesce(role::text,'client') = 'client' limit 1;

  if v_staff is null or v_repA is null then
    insert into result values ('people exist to test with', false,
      'need at least one staff profile and one member profile -- nothing was checked');
    return;
  end if;
  if v_repB is null then v_repB := v_staff; end if;   -- second owner, whoever is going spare

  -- Two deals, different owners, plus a meeting and a message hanging off rep A's.
  insert into public.growth_clients (id, owner_id, name, company, stage)
    values (cA, v_repA, 'zz-check rep A deal', 'A Ltd', 'call');
  insert into public.growth_clients (id, owner_id, name, company, stage)
    values (cB, v_repB, 'zz-check rep B deal', 'B Ltd', 'call');
  insert into public.growth_meetings (client_id, starts_at, title)
    values (cA, now() + interval '1 day', 'zz-check meeting');
  insert into public.growth_messages (client_id, direction, body)
    values (cA, 'in', 'zz-check reply from the prospect');

  -- ---------------------------------------------------------------- staff
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.growth_clients where name like 'zz-check%';
  reset role;
  insert into result values ('staff see the whole pipeline', n = 2, n || ' of 2 seeded deals');

  -- ---------------------------------------------------------------- rep A
  perform set_config('request.jwt.claims', json_build_object('sub', v_repA, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.growth_clients where id = cA;         -- their own
  select count(*) into m from public.growth_clients where id = cB;         -- somebody else's
  reset role;
  insert into result values ('a rep sees their own deal',        n = 1, n || ' of 1');
  insert into result values ('a rep cannot see another rep''s deal', m = 0, m || ' leaked');

  -- Meetings and messages must follow the client, not carry their own copy of the rule.
  perform set_config('request.jwt.claims', json_build_object('sub', v_repA, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.growth_meetings where client_id = cA;
  select count(*) into m from public.growth_messages where client_id = cA;
  reset role;
  insert into result values ('a rep sees their own meetings', n = 1, n || ' of 1');
  insert into result values ('a rep sees their own messages', m = 1, m || ' of 1');

  -- Rep B's meeting/message trail must not leak either. Seed one so this measures something.
  insert into public.growth_meetings (client_id, starts_at, title)
    values (cB, now() + interval '2 days', 'zz-check other meeting');
  perform set_config('request.jwt.claims', json_build_object('sub', v_repA, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.growth_meetings where client_id = cB;
  reset role;
  insert into result values ('a rep cannot see another rep''s meetings', n = 0, n || ' leaked');

  -- A rep must not be able to hand themselves someone else's deal.
  perform set_config('request.jwt.claims', json_build_object('sub', v_repA, 'role','authenticated')::text, true);
  set local role authenticated;
  begin
    update public.growth_clients set owner_id = v_repA where id = cB;
    get diagnostics n = row_count;
    ok := (n = 0);
  exception when insufficient_privilege then ok := true; n := 0;
  end;
  reset role;
  insert into result values ('a rep cannot steal another rep''s deal', ok, n || ' rows changed');

  -- Settings are read by everyone and written only by staff. That is what keeps a rep out
  -- of Connectors and Settings in the database as well as in the nav.
  perform set_config('request.jwt.claims', json_build_object('sub', v_repA, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.growth_settings where key = 'pipeline';
  begin
    update public.growth_settings set value = '{"hacked":true}'::jsonb where key = 'pipeline';
    get diagnostics m = row_count;
    ok := (m = 0);
  exception when insufficient_privilege then ok := true; m := 0;
  end;
  reset role;
  insert into result values ('a rep reads the stage list',   n = 1, n || ' of 1');
  insert into result values ('a rep cannot change settings', ok,    m || ' rows changed');

  -- ---------------------------------------------------------------- an agency client
  if v_client is null then
    insert into result values ('an agency client sees no pipeline', false,
      'no client profile in this workspace -- NOT CHECKED');
  else
    perform set_config('request.jwt.claims', json_build_object('sub', v_client, 'role','authenticated')::text, true);
    set local role authenticated;
    select count(*) into n from public.growth_clients;
    select count(*) into m from public.growth_messages;
    reset role;
    insert into result values ('an agency client sees no pipeline', n = 0, n || ' deals visible');
    insert into result values ('an agency client sees no replies',  m = 0, m || ' messages visible');
  end if;
end $$;

select string_agg((case when pass then 'PASS  ' else 'FAIL  ' end) || rpad(check_name,44) || detail, chr(10) order by ctid) as report,
       count(*) filter (where not pass) as failures, count(*) as total from result;

rollback;
