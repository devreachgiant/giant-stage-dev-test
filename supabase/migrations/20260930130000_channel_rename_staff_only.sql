-- Renaming a channel is a staff action.
--
-- channels_update_open is `auth.uid() IS NOT NULL` -- any signed-in account at all. That
-- includes the client-portal logins, which are ordinary authenticated users. Verified
-- against production on 2026-09-30, acting as the client account: an UPDATE renaming team
-- channels reported 8 rows changed. A client could rename #google-ads.
--
-- It has not mattered much until now because nothing invited anybody to rename anything.
-- Adding a rename that people are meant to use makes the permission real.
--
-- The rule is "not a client", not "manager or owner": the point of this change is that any
-- member of the team can give a channel a name they will remember, which is what was asked
-- for. Only the portal accounts are excluded, and they have no business renaming an internal
-- conversation in the first place.

drop policy if exists channels_update_open on public.channels;

create policy channels_update_staff on public.channels
  for update to authenticated
  using (
    auth.uid() is not null
    and coalesce(public."current_role"()::text, 'client') <> 'client'
  );
