-- Can a deleted channel actually be put back?
--
--   supabase db query --linked -f tools_channel_archive_check.sql
--
-- Builds a throwaway channel with a threaded reply, a reaction and a star, deletes it,
-- restores it from the archive, and checks every part came back. Runs inside a transaction
-- that is ROLLED BACK, so it leaves nothing behind -- including no archive row.
--
-- It is written to fail loudly on the ways this can rot quietly: the trigger being dropped,
-- the restore silently inserting no messages, a threaded reply losing its parent, or a
-- second restore duplicating a channel instead of refusing.
begin;

create temp table result(check_name text, pass boolean, detail text);

do $$
declare
  v_ch uuid := gen_random_uuid();
  v_m1 uuid := gen_random_uuid();
  v_m2 uuid := gen_random_uuid();
  v_me uuid; v_arc uuid; v_said text;
  n_before int; n_archived int; n_after int; n_members_arch int; n_members_back int;
begin
  select id into v_me from public.profiles where coalesce(role::text,'client') <> 'client' limit 1;

  insert into public.channels (id, kind, name, slug, is_dm, is_private, description)
    values (v_ch, 'team_channel', 'zz-archive-check', 'zz-archive-check', false, false, 'check');
  insert into public.messages (id, channel_id, author_id, body) values (v_m1, v_ch, v_me, 'parent');
  insert into public.messages (id, channel_id, author_id, body, parent_id)
    values (v_m2, v_ch, v_me, 'reply', v_m1);
  insert into public.message_reactions (message_id, profile_id, emoji) values (v_m1, v_me, '👍');
  insert into public.channel_stars (profile_id, channel_id) values (v_me, v_ch);

  select count(*) into n_before from public.messages where channel_id = v_ch;

  delete from public.channels where id = v_ch;

  select id, message_count, jsonb_array_length(members)
    into v_arc, n_archived, n_members_arch
    from public.deleted_channel_archive where channel_id = v_ch;

  insert into result values ('the delete was archived at all', v_arc is not null,
    coalesce('archive ' || v_arc::text, 'NO ARCHIVE ROW -- is the trigger still there?'));
  insert into result values ('every message was captured', n_archived = n_before,
    coalesce(n_archived, -1) || ' captured of ' || n_before);
  insert into result values ('the cascade really did empty the channel',
    (select count(*) from public.messages where channel_id = v_ch) = 0, 'measured after delete');

  select public.restore_deleted_channel(v_arc) into v_said;
  select count(*) into n_after from public.messages where channel_id = v_ch;
  select count(*) into n_members_back from public.channel_members where channel_id = v_ch;

  insert into result values ('the channel came back', exists (select 1 from public.channels where id = v_ch), v_said);
  insert into result values ('every message came back', n_after = n_before, n_after || ' of ' || n_before);
  insert into result values ('a threaded reply kept its parent',
    exists (select 1 from public.messages where id = v_m2 and parent_id = v_m1),
    'reply -> parent');
  insert into result values ('reactions came back',
    (select count(*) from public.message_reactions where message_id = v_m1) = 1, 'one reaction');
  insert into result values ('stars came back',
    (select count(*) from public.channel_stars where channel_id = v_ch) = 1, 'one star');
  -- Membership must be what was archived, NOT what the auto-join trigger would rebuild:
  -- inserting a public channel adds every profile, so a restore that did not correct for
  -- that would quietly widen who is in a private-by-convention channel.
  insert into result values ('membership is the archived membership', n_members_back = n_members_arch,
    n_members_back || ' back of ' || n_members_arch || ' archived');

  select public.restore_deleted_channel(v_arc) into v_said;
  insert into result values ('a second restore refuses instead of duplicating',
    v_said like '%already exists%' and (select count(*) from public.messages where channel_id = v_ch) = n_before,
    v_said);
end $$;

select case when pass then 'PASS' else 'FAIL' end as status, check_name, detail from result
union all
select case when bool_and(pass) then 'ALL PASS' else 'FAILURES PRESENT' end,
       count(*) filter (where pass) || '/' || count(*) || ' checks passed', ''
  from result;

rollback;
