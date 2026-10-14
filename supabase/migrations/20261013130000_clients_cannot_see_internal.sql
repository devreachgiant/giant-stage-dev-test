-- A client account could read the workspace.
--
-- Measured on production as the one client profile, under its own row-level security:
--   83 channels visible, 7,430 messages readable
--   of those, 2,202 messages in internal team channels -- including #security, which is
--   private and which the account was a MEMBER of
--   and 3,278 messages belonging to OTHER clients
--
-- Three separate causes, fixed here together because any one alone leaves the hole open.
--
-- 1. channels_select began with "is_private = false", and "not private" was being read as
--    "everybody, including clients". Every public team channel was therefore client-visible.
-- 2. trg_new_public_channel adds EVERY profile to each new public channel, clients included,
--    so client accounts accumulated memberships in internal channels. #security was created
--    public and made private later, and the membership stayed behind.
-- 3. The test client held 57 memberships in client_dept channels belonging to other clients.
--
-- messages_select carries a copy of the same visibility expression, so it is updated in step.
-- Two rules that must agree and are written twice are two rules that will drift; the check
-- in tools_client_isolation_check.sql exists to notice if they ever do.
--
-- WHAT A CLIENT MAY SEE AFTER THIS: the client_dept channels belonging to the client their
-- profile is linked to, and direct messages they are a participant in. Not internal team
-- channels, not reachgiant-home, not another client's channels.

-- Which client this account belongs to. SECURITY DEFINER for the same reason current_role()
-- is: a policy on channels cannot depend on the caller being able to read profiles.
create or replace function public.my_client_id()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select client_link_id from public.profiles where id = auth.uid()
$function$;

-- 1. Take away the memberships that should never have been granted.
delete from public.channel_members m
 using public.profiles p, public.channels c
 where p.id = m.profile_id
   and c.id = m.channel_id
   and coalesce(p.role::text, 'client') = 'client'
   and (
         c.kind in ('team_channel', 'home')
      or (c.kind = 'client_dept' and c.client_id is distinct from p.client_link_id)
   );

-- 2. Stop adding clients to new public channels.
create or replace function public.handle_new_public_channel()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
BEGIN
  IF NEW.is_private = false AND NEW.is_dm = false THEN
    -- Staff only. This used to add every profile, which is how client accounts ended up
    -- inside internal channels -- and a channel made private later keeps those members.
    INSERT INTO public.channel_members (channel_id, profile_id)
    SELECT NEW.id, p.id FROM public.profiles p
     WHERE coalesce(p.role::text, 'client') <> 'client'
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $function$;

-- 3. "Not private" stops meaning "visible to clients".
drop policy if exists channels_select on public.channels;
create policy channels_select on public.channels
  for select to authenticated
  using (
    case when coalesce(public."current_role"()::text, 'client') = 'client' then
      (
        (kind = 'client_dept' and client_id is not null and client_id = public.my_client_id())
        or (is_dm = true and exists (
              select 1 from public.channel_members cm
               where cm.channel_id = channels.id and cm.profile_id = auth.uid()))
      )
    else
      (
        is_private = false
        or exists (select 1 from public.channel_members cm
                    where cm.channel_id = channels.id and cm.profile_id = auth.uid())
        or (is_dm = false and public."current_role"() = 'inhouse_dev'::user_role)
      )
    end
  );

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages
  for select to authenticated
  using (
    exists (
      select 1 from public.channels c
       where c.id = messages.channel_id
         and case when coalesce(public."current_role"()::text, 'client') = 'client' then
               (
                 (c.kind = 'client_dept' and c.client_id is not null and c.client_id = public.my_client_id())
                 or (c.is_dm = true and exists (
                       select 1 from public.channel_members cm
                        where cm.channel_id = c.id and cm.profile_id = auth.uid()))
               )
             else
               (
                 c.is_private = false
                 or exists (select 1 from public.channel_members cm
                             where cm.channel_id = c.id and cm.profile_id = auth.uid())
                 or (c.is_dm = false and public."current_role"() = 'inhouse_dev'::user_role)
               )
             end
    )
  );
