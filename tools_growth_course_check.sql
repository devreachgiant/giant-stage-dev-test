-- Can a sales rep edit the course? Can they tick somebody else's lesson?
--
--   supabase db query --linked -f tools_growth_course_check.sql
--
-- The whole point of 20261022120000 is a split: staff WRITE the training content, a rep
-- only READS it and marks their own lessons done. That split is worth nothing if it lives
-- in the page, so this measures it through real row level security as four different
-- people, inside a transaction that is ROLLED BACK.
--
-- It SEEDS a progress row for each of two reps before measuring. Without that, "a rep
-- sees 0 of someone else's progress" passes on an empty table and proves nothing -- the
-- trap 20261012130000 fell into, where a client-block policy that did nothing at all
-- looked like it was working because nobody had seeded a row.
--
-- Both sides every time. A rule that stops the rep writing their OWN row is not security,
-- it is a broken screen, so every refusal is paired with the thing that must still work.

begin;

create temp table result(check_name text, pass boolean, detail text);

do $$
declare
  v_staff  uuid;
  v_repA   uuid;
  v_repB   uuid;
  v_client uuid;
  n int; m int;
  ok boolean;
begin
  select id into v_staff  from public.profiles where role::text in ('owner','manager','inhouse_dev') limit 1;
  select id into v_repA   from public.profiles where role::text = 'member' limit 1;
  select id into v_repB   from public.profiles where role::text = 'member' and id <> v_repA limit 1;
  select id into v_client from public.profiles where coalesce(role::text,'client') = 'client' limit 1;

  if v_staff is null or v_repA is null then
    insert into result values ('people exist to test with', false,
      'need one staff profile and one member profile -- NOTHING was checked');
    return;
  end if;
  if v_repB is null then v_repB := v_staff; end if;

  -- Two people, part way through the course.
  insert into public.growth_course_done (owner_id, lesson_id) values (v_repA, 'zz-open'), (v_repA, 'zz-why');
  insert into public.growth_course_done (owner_id, lesson_id) values (v_repB, 'zz-open');

  -- ---------------------------------------------------------------- the content
  perform set_config('request.jwt.claims', json_build_object('sub', v_repA, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.growth_settings where key in ('course','clear','qa');
  begin
    update public.growth_settings set value = '{"hacked":true}'::jsonb where key = 'course';
    get diagnostics m = row_count;
    ok := (m = 0);
  exception when insufficient_privilege then ok := true; m := 0;
  end;
  reset role;
  insert into result values ('a rep reads the course, the answers and the Q and A', n = 3, n || ' of 3 keys');
  insert into result values ('a rep cannot rewrite a lesson', ok, m || ' rows changed');

  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role','authenticated')::text, true);
  set local role authenticated;
  begin
    update public.growth_settings set value = value where key = 'course';
    get diagnostics m = row_count;
    ok := (m = 1);
  exception when insufficient_privilege then ok := false; m := 0;
  end;
  reset role;
  insert into result values ('staff CAN rewrite a lesson', ok, m || ' rows changed');

  -- ---------------------------------------------------------------- progress
  perform set_config('request.jwt.claims', json_build_object('sub', v_repA, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.growth_course_done where owner_id = v_repA;
  select count(*) into m from public.growth_course_done where owner_id = v_repB;
  reset role;
  insert into result values ('a rep sees their own progress',        n = 2, n || ' of 2');
  insert into result values ('a rep cannot see another rep''s progress', m = 0, m || ' leaked');

  -- The one thing a rep MUST be able to do.
  perform set_config('request.jwt.claims', json_build_object('sub', v_repA, 'role','authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.growth_course_done (owner_id, lesson_id) values (v_repA, 'zz-clear');
    get diagnostics n = row_count;
    ok := (n = 1);
  exception when insufficient_privilege then ok := false; n := 0;
  end;
  reset role;
  insert into result values ('a rep CAN mark their own lesson done', ok, n || ' row written');

  -- ... and the thing they must not: ticking a lesson for somebody else.
  perform set_config('request.jwt.claims', json_build_object('sub', v_repA, 'role','authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.growth_course_done (owner_id, lesson_id) values (v_repB, 'zz-fake');
    get diagnostics n = row_count;
    ok := (n = 0);
  exception when insufficient_privilege then ok := true; n := 0;
  end;
  reset role;
  insert into result values ('a rep cannot tick a lesson for someone else', ok, n || ' rows written');

  -- Nor un-tick one of theirs.
  perform set_config('request.jwt.claims', json_build_object('sub', v_repA, 'role','authenticated')::text, true);
  set local role authenticated;
  begin
    delete from public.growth_course_done where owner_id = v_repB;
    get diagnostics n = row_count;
    ok := (n = 0);
  exception when insufficient_privilege then ok := true; n := 0;
  end;
  reset role;
  insert into result values ('a rep cannot clear another rep''s progress', ok, n || ' rows deleted');

  -- Staff see the whole class. That is what makes it a course and not a diary.
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.growth_course_done where lesson_id like 'zz-%';
  reset role;
  insert into result values ('staff see everyone''s progress', n >= 3, n || ' rows of at least 3');

  -- ---------------------------------------------------------------- best calls
  -- 20261022130000 reversed 20261021140000 here: the shelf is curated now. Reading is
  -- what must NOT have changed, so it is measured on the same pass as the refusal.
  insert into public.growth_watch_calls (title, url, added_by, position)
    values ('zz-check call', 'https://example.com/x', v_staff, 999);

  perform set_config('request.jwt.claims', json_build_object('sub', v_repA, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.growth_watch_calls where title like 'zz-check%';
  begin
    insert into public.growth_watch_calls (title, added_by) values ('zz-rep added', v_repA);
    get diagnostics m = row_count;
    ok := (m = 0);
  exception when insufficient_privilege then ok := true; m := 0;
  end;
  reset role;
  insert into result values ('a rep still READS the best calls', n = 1, n || ' of 1');
  insert into result values ('a rep cannot add a best call',     ok,    m || ' rows written');

  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role','authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.growth_watch_calls (title, added_by) values ('zz-staff added', v_staff);
    get diagnostics m = row_count;
    ok := (m = 1);
  exception when insufficient_privilege then ok := false; m := 0;
  end;
  reset role;
  insert into result values ('staff CAN add a best call', ok, m || ' rows written');

  -- ---------------------------------------------------------------- an agency client
  if v_client is null then
    insert into result values ('an agency client sees no training', false,
      'no client profile in this workspace -- NOT CHECKED');
  else
    perform set_config('request.jwt.claims', json_build_object('sub', v_client, 'role','authenticated')::text, true);
    set local role authenticated;
    select count(*) into n from public.growth_course_done;
    select count(*) into m from public.growth_settings where key = 'course';
    reset role;
    insert into result values ('an agency client sees no progress', n = 0, n || ' rows visible');
    insert into result values ('an agency client sees no course',   m = 0, m || ' keys visible');
  end if;
end $$;

select string_agg((case when pass then 'PASS  ' else 'FAIL  ' end) || rpad(check_name,48) || detail, chr(10) order by ctid) as report,
       count(*) filter (where not pass) as failures, count(*) as total from result;

rollback;
