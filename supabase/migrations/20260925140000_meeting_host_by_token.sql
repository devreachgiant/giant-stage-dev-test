-- "Loading host…", forever, for everybody outside the company.
--
-- The Giant Meet pre-join screen reads the host straight off public.profiles. Anonymous
-- visitors can read zero rows there -- correctly, since 20260818180000 and 20260915150000
-- closed that table down -- so the query returns nothing, no error is raised, and the
-- placeholder never changes. The guest sits on a page that will not say who they are about
-- to meet. Signed-in staff never saw it, which is why it survived: it only breaks for the
-- people the feature exists for.
--
-- Same shape as get_meeting_by_token, which is how the meeting row itself already reaches
-- an anonymous guest: a definer function that takes the token, and returns ONLY what that
-- page needs to draw. Presenting a valid meeting token is the authorisation.
--
-- Three columns, deliberately. Not profiles.*, not even the row: this is a name and a face
-- on a pre-join screen, and email is in there only because a profile with no full_name has
-- nothing else to show -- the same fallback the page already applies. No id, so it cannot
-- be used to walk anywhere else.

create or replace function public.get_meeting_host_by_token(p_token text)
  returns table (full_name text, email text, avatar_url text)
  language sql
  stable security definer
  set search_path to 'public'
as $function$
  select p.full_name, p.email, p.avatar_url
    from public.meetings m
    join public.profiles p on p.id = m.host_profile_id
   where m.token = p_token
     and p_token is not null
     and length(btrim(p_token)) > 0
   limit 1;
$function$;

comment on function public.get_meeting_host_by_token(text) is
  'The host name/avatar for one meeting, for the anonymous pre-join screen. Scoped to the '
  'presented token, returns no id, and exposes nothing about any other profile.';

revoke all on function public.get_meeting_host_by_token(text) from public;
grant execute on function public.get_meeting_host_by_token(text) to anon, authenticated;
