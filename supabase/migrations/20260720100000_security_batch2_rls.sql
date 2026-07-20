-- Security batch 2 — close the remaining anon-reachable RLS exposure.
-- Ships with the function-auth rollout (requireUser on all non-public functions)
-- and the frontend fetch-wrapper; the meetings change also requires the frontend's
-- switch to get_meeting_by_token (same PR).
--
-- What this closes:
--   1. meetings: anon could SELECT every meeting (tokens, guest emails, links) —
--      full enumeration meant anyone could join any meeting. Guests now fetch
--      exactly one meeting via a token-scoped SECURITY DEFINER RPC.
--   2. meeting_transcripts: anon could SELECT all AI meeting transcripts (nothing
--      in the app used that path) and INSERT arbitrary rows into any meeting.
--      SELECT becomes authenticated-only; INSERT (needed by guests transcribing
--      their own speech) is constrained to meetings that are currently active.
--   3. event_types: was SELECTable by anon; the public booking page reads through
--      bookings-api (service role), so anon access is unused. Authenticated-only.
--   4. bookings_anon_insert: unused — public bookings are created by bookings-api
--      with the service role. Dropped.
--   5. invitations: any logged-in user could read all pending invitations
--      (including invite tokens — a pending-invite hijack path). SELECT is now
--      limited to admin-type roles, matching the app's role vocabulary.

begin;

-- 1. meetings ---------------------------------------------------------------
create or replace function public.get_meeting_by_token(p_token text)
returns setof public.meetings
language sql
security definer
stable
set search_path = public
as $$
  select * from public.meetings where token = p_token;
$$;

revoke all on function public.get_meeting_by_token(text) from public;
grant execute on function public.get_meeting_by_token(text) to anon, authenticated;

drop policy if exists meetings_select_by_token on public.meetings;
create policy meetings_select_auth on public.meetings
  for select to authenticated using (true);

-- 2. meeting_transcripts ----------------------------------------------------
drop policy if exists transcripts_select_all on public.meeting_transcripts;
create policy transcripts_select_auth on public.meeting_transcripts
  for select to authenticated using (true);

-- The WITH CHECK subquery runs under the caller's own RLS, and anon has no
-- SELECT policy on meetings anymore — so the active-meeting test must go
-- through a SECURITY DEFINER helper or it would always fail for guests.
create or replace function public.meeting_is_active(p_meeting_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.meetings m
    where m.id = p_meeting_id and m.status = 'active'
  );
$$;

revoke all on function public.meeting_is_active(uuid) from public;
grant execute on function public.meeting_is_active(uuid) to anon, authenticated;

drop policy if exists transcripts_insert_all on public.meeting_transcripts;
create policy transcripts_insert_participant on public.meeting_transcripts
  for insert to anon, authenticated
  with check (public.meeting_is_active(meeting_id));

-- 3. event_types ------------------------------------------------------------
drop policy if exists event_types_select_all on public.event_types;
create policy event_types_select_auth on public.event_types
  for select to authenticated using (true);

-- 4. bookings ---------------------------------------------------------------
drop policy if exists bookings_anon_insert on public.bookings;

-- 5. invitations ------------------------------------------------------------
drop policy if exists invitations_select_auth on public.invitations;
create policy invitations_select_admin on public.invitations
  for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and (p.role)::text = any (array['owner','manager','inhouse_dev','admin'])
    )
  );

commit;
