-- APPLIED 2026-09-16, after review. A client account could read every client we have.
--
-- clients_select_all is `USING (true)`, so every authenticated account -- team members and
-- CLIENT ACCOUNTS ALIKE -- can read every row of public.clients, mrr_cents included. Any
-- client who signs in can ask PostgREST for the list and get every other client's name,
-- status, monthly fee, contact email and Stripe customer id. Nothing in the page offers
-- this; it does not have to, because the rule is on the table and the API is public.
--
-- The fix is two permissive policies where there was one, so the two audiences are stated
-- separately and neither can be widened by accident:
--
--   the team    every client, as today. Members are unaffected by this migration.
--   a client    the one client their profile is linked to, and nothing else.
--
-- WHAT THIS DOES NOT FIX. mrr_cents stays readable by every team member, specialists
-- included. RLS is row-level: there is no way to hide one column from one audience while
-- PostgREST talks to the database as a single `authenticated` role for everybody. Doing
-- that proproperly means a view with the money left out, granted to the team, with the
-- table itself closed -- a larger change that would touch every module below.
--
-- BEFORE APPLYING, check these read paths still work for a signed-in client account. Each
-- is a select on clients somewhere in index.html; the team-facing ones are unaffected and
-- listed only so the review is complete:
--
--   the client portal            reads its own client row              -- must still work
--   onboarding                   onboarding_token / answers by id      -- must still work
--   chat, channel naming         id, name                              -- team only
--   projects, invoices, reports  id, name, mrr_cents, status           -- team only
--   the Pod System               both boards                           -- team only
--
-- VERIFIED IN PRODUCTION after applying: a client account reads 1 row, its own, and zero
-- other clients' mrr_cents; a team member reads all 51; anonymous reads none. The public
-- onboarding form was exercised end to end with a real generated token, anonymously, both
-- before and after the change, and loads identically -- it goes through get_onboarding_form,
-- which is SECURITY DEFINER and so never consulted this policy. The old policy was
-- `to authenticated`, so anonymous access was zero before the change as well.
--
-- DRY RUN against production, 2026-09-15, inside a rolled-back transaction:
--
--   client-test    51 clients readable  ->  1, their own linked client
--   Joven (member) 51 clients readable  ->  51, mrr_cents included. Unchanged.
--
-- There is exactly one client-role profile on the workspace and it has client_link_id set,
-- so no client account is locked out by this. A client-role profile with a null link would
-- see nothing at all, which is the correct answer for an account linked to no client, but
-- worth knowing before the second one is created.

drop policy if exists clients_select_all on public.clients;

create policy clients_select_team on public.clients
  for select to authenticated
  using (auth.uid() is not null and not public.is_client_user());

create policy clients_select_own on public.clients
  for select to authenticated
  using (id = public.current_user_client_link());
