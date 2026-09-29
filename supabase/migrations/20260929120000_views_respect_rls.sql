-- Five views handed out everything the tables beneath them refuse.
--
-- A view without security_invoker runs as the view's OWNER, not the caller. Row level
-- security is then evaluated against the owner -- a superuser -- so every policy on the
-- underlying table is skipped. The tables here are correct: an anonymous caller selecting
-- from public.clients gets 0 rows. Selecting the same data through public.clients_public
-- got 58.
--
-- Measured against production on 2026-09-29, acting as anon, in a rolled-back transaction:
--
--   client_onboarding      58 rows   <- the view that exists to withhold EIN and address
--   clients_manager        58 rows   <- the view that exists to withhold financials
--   clients_public         58 rows
--   unread_counts        1243 rows
--   workspace_files_stats   1 row
--
-- And these are simple views, so Postgres makes them auto-updatable. An anonymous UPDATE
-- through clients_public reported 58 rows changed; DELETE was accepted too. So this was not
-- only a read of every client -- names, industries, addresses, websites, notes, onboarding
-- answers -- but the ability to overwrite or remove them, using nothing but the publishable
-- key that ships in config.js by design.
--
-- Two changes, because either alone is not enough:
--
--   1. security_invoker = true. The view now runs as whoever called it, so the policies on
--      clients, client_onboarding's source, messages and so on finally apply. This is the
--      real fix, and it is what makes the views safe for any caller rather than just for
--      the one we remembered to revoke.
--
--   2. anon loses every privilege on all five. None of them is used by an anonymous page --
--      the public booking, meeting and onboarding pages go through SECURITY DEFINER
--      functions scoped to a token, which is the correct pattern and already in place. So
--      nothing anonymous regresses, and defence does not rest on a single setting.
--
-- Writes are revoked from authenticated too. Every one of these is a read model; the app
-- writes to the tables. A view that nobody writes through should not be writable.
--
-- white_label_projects_partner already had security_invoker and is left alone.

alter view public.client_onboarding      set (security_invoker = true);
alter view public.clients_manager        set (security_invoker = true);
alter view public.clients_public         set (security_invoker = true);
alter view public.unread_counts          set (security_invoker = true);
alter view public.workspace_files_stats  set (security_invoker = true);

revoke all on public.client_onboarding      from anon;
revoke all on public.clients_manager        from anon;
revoke all on public.clients_public         from anon;
revoke all on public.unread_counts          from anon;
revoke all on public.workspace_files_stats  from anon;

revoke insert, update, delete, truncate on public.client_onboarding      from authenticated;
revoke insert, update, delete, truncate on public.clients_manager        from authenticated;
revoke insert, update, delete, truncate on public.clients_public         from authenticated;
revoke insert, update, delete, truncate on public.unread_counts          from authenticated;
revoke insert, update, delete, truncate on public.workspace_files_stats  from authenticated;

grant select on public.client_onboarding      to authenticated;
grant select on public.clients_manager        to authenticated;
grant select on public.clients_public         to authenticated;
grant select on public.unread_counts          to authenticated;
grant select on public.workspace_files_stats  to authenticated;
