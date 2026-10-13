-- Can a client account see anything internal?
--
--   supabase db query --linked -f tools_client_isolation_check.sql
--
-- Measured as a real client profile under its own row-level security, inside a transaction
-- that is ROLLED BACK. It creates a throwaway client and a throwaway internal channel with a
-- message in it, so the answer never depends on what happens to be in the database today --
-- an empty workspace would make a "sees 0 internal messages" check pass while proving
-- nothing.
--
-- Written after a client account was found able to read 7,430 messages across 83 channels,
-- including a private channel called #security and 3,278 messages belonging to other
-- clients. Three separate causes, so this checks all three: the visibility rule, the
-- auto-join trigger, and leftover memberships.
--
-- channels_select and messages_select each carry a copy of the visibility rule. Two rules
-- that must agree and are written twice will drift, so this exercises BOTH.
begin;

create temp table result(check_name text, pass boolean, detail text);

do $$
declare
  v_client_profile uuid;
  v_client_row     uuid;
  v_internal       uuid := gen_random_uuid();
  v_own            uuid := gen_random_uuid();
  v_staff          uuid;
  n_internal int; n_own int; n_internal_msgs int; n_own_msgs int; n_members int;
  staff_before int; staff_after int;
begin
  select id into v_staff from public.profiles where role = 'member' limit 1;
  -- A real client profile, not a fabricated one: profiles.id is foreign-keyed to auth.users,
  -- so a synthetic profile cannot exist. The CHANNELS are still created here, so the check
  -- never passes merely because the workspace happens to be empty.
  select id, client_link_id into v_client_profile, v_client_row
    from public.profiles where coalesce(role::text,'client') = 'client' limit 1;
  if v_client_profile is null then
    insert into result values ('a client account exists to test with', false,
      'no client profile in this workspace -- nothing was checked');
    return;
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into staff_before from public.messages;
  reset role;

  -- An internal channel with something in it, and one that genuinely belongs to this client.
  insert into public.channels (id, kind, name, slug, is_dm, is_private)
    values (v_internal, 'team_channel', 'zz-internal-check', 'zz-internal-check', false, false);
  insert into public.messages (channel_id, author_id, body)
    values (v_internal, v_staff, 'internal only');
  insert into public.channels (id, kind, name, slug, is_dm, is_private, client_id)
    values (v_own, 'client_dept', 'zz-own-check', 'zz-own-check', false, false, v_client_row);
  insert into public.messages (channel_id, author_id, body)
    values (v_own, v_staff, 'for this client');

  -- The auto-join trigger just ran on both public channels.
  select count(*) into n_members from public.channel_members
   where channel_id = v_internal and profile_id = v_client_profile;
  insert into result values ('a new public channel does not auto-add clients', n_members = 0,
    n_members || ' client memberships added by the trigger');

  perform set_config('request.jwt.claims', json_build_object('sub', v_client_profile, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n_internal from public.channels where kind in ('team_channel','home');
  select count(*) into n_internal_msgs from public.messages m
    join public.channels c on c.id = m.channel_id where c.kind in ('team_channel','home');
  select count(*) into n_own from public.channels where id = v_own;
  select count(*) into n_own_msgs from public.messages where channel_id = v_own;
  reset role;

  insert into result values ('a client sees NO internal channels', n_internal = 0,
    n_internal || ' internal channels visible');
  insert into result values ('a client reads NO internal messages', n_internal_msgs = 0,
    n_internal_msgs || ' internal messages readable');
  -- The other half: the rule must not have simply blinded the client to everything.
  insert into result values ('a client still sees their OWN channel', n_own = 1,
    n_own || ' of their own channels visible');
  insert into result values ('a client still reads their OWN messages', n_own_msgs = 1,
    n_own_msgs || ' of their own messages readable');

  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into staff_after from public.messages;
  reset role;
  -- Two messages were added above, so staff should see exactly two more. Anything else means
  -- the rule narrowed what STAFF can see, which is the way this fix could do real damage.
  insert into result values ('staff visibility is untouched', staff_after = staff_before + 2,
    staff_before || ' -> ' || staff_after || ' (expected +2)');

  insert into result values ('no client holds an internal membership anywhere',
    (select count(*) from public.channel_members m
       join public.profiles p on p.id = m.profile_id
       join public.channels c on c.id = m.channel_id
      where coalesce(p.role::text,'client') = 'client'
        and (c.kind in ('team_channel','home')
             or (c.kind = 'client_dept' and c.client_id is distinct from p.client_link_id))) = 0,
    'leftover memberships across the whole workspace');
end $$;

select case when pass then 'PASS' else 'FAIL' end as status, check_name, detail from result
union all
select case when bool_and(pass) then 'ALL PASS' else 'FAILURES PRESENT' end,
       count(*) filter (where pass) || '/' || count(*) || ' checks passed', '' from result;

rollback;
