-- Can anything holding the publishable key read a connector credential?
--
--   supabase db query --linked -f tools_growth_secrets_check.sql
--
-- growth_secrets has RLS on and NO policies, AND the table grants are revoked, so a
-- caller holding the publishable key is refused twice over. That is easy to state and
-- easy to get wrong later, so it is measured here as the callers that matter, inside a
-- rolled back transaction, with a row seeded first so "0 rows" means refused rather
-- than empty.
--
-- A refusal arrives in two different shapes here and BOTH count as refused: RLS hands
-- back zero rows, while a revoked grant raises insufficient_privilege before RLS is
-- even consulted. A check that only accepted one of them would start failing the day
-- somebody "helpfully" added a GRANT, which is the day it matters most.

begin;

create temp table result(check_name text, pass boolean, detail text);

do $$
declare
  v_staff uuid; v_rep uuid; n int; ok boolean;
begin
  select id into v_staff from public.profiles where role::text in ('owner','manager','inhouse_dev') limit 1;
  select id into v_rep   from public.profiles where role::text = 'member' limit 1;
  if v_staff is null then
    insert into result values ('people exist to test with', false, 'no staff profile -- NOTHING checked');
    return;
  end if;

  -- Seed one, as the service role does. Without this every count below is 0 for the
  -- wrong reason and the whole file passes while proving nothing.
  insert into public.growth_secrets (key, value, label, updated_by)
    values ('zz-check', 'super-secret-value', 'zz@example.com', v_staff);

  -- the service role, which is what the Netlify function uses
  select count(*) into n from public.growth_secrets where key = 'zz-check';
  insert into result values ('the service role can read it', n = 1, n || ' of 1');

  -- staff, through the publishable key
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role','authenticated')::text, true);
  set local role authenticated;
  begin
    select count(*) into n from public.growth_secrets;
    ok := (n = 0);
  exception when insufficient_privilege then ok := true; n := -1;
  end;
  reset role;
  insert into result values ('an owner cannot read a secret from the page', ok,
    case when n < 0 then 'refused outright' else n || ' rows visible' end);

  -- a rep
  if v_rep is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role','authenticated')::text, true);
    set local role authenticated;
    begin
      select count(*) into n from public.growth_secrets;
      ok := (n = 0);
    exception when insufficient_privilege then ok := true; n := -1;
    end;
    reset role;
    insert into result values ('a rep cannot read a secret', ok,
      case when n < 0 then 'refused outright' else n || ' rows visible' end);
  end if;

  -- and nobody can write one either, so a token can only ever arrive via the function
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role','authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.growth_secrets (key, value) values ('zz-sneak', 'x');
    get diagnostics n = row_count;
    ok := (n = 0);
  exception when insufficient_privilege then ok := true; n := -1;
  end;
  reset role;
  -- "0 rows written" would be ambiguous: refused, or an insert that did nothing? Say which.
  insert into result values ('an owner cannot write one from the page either', ok,
    case when n < 0 then 'refused outright' else n || ' rows written' end);

  -- anon is what config.js hands to the world
  set local role anon;
  begin
    select count(*) into n from public.growth_secrets;
    ok := (n = 0);
  exception when insufficient_privilege then ok := true; n := -1;
  end;
  reset role;
  insert into result values ('anon cannot read a secret', ok,
    case when n < 0 then 'refused outright' else n || ' rows visible' end);
end $$;

select string_agg((case when pass then 'PASS  ' else 'FAIL  ' end) || rpad(check_name,46) || detail, chr(10) order by ctid) as report,
       count(*) filter (where not pass) as failures, count(*) as total from result;

rollback;
