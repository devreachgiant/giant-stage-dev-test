-- The policy meant to stop a client-portal account minting an API token did not stop one.
--
-- 20261012120000 shipped two PERMISSIVE policies on api_tokens: api_tokens_own (FOR ALL,
-- check profile_id = auth.uid()) and api_tokens_no_clients (FOR INSERT, check the same plus
-- role <> 'client'). Permissive policies for the same command are ORed, and FOR ALL covers
-- INSERT -- so api_tokens_own allowed the insert by itself and the second policy added
-- exactly nothing.
--
-- Measured on production in a rolled-back transaction, as a real client-role profile:
--   before  client  INSERTED -- a client made an API token
--   before  member  INSERTED
--   after   client  refused (42501)      client reads own rows: 0
--   after   member  INSERTED             member reads own rows: 2
-- The member side is there on purpose: "0 rows" alone cannot tell "blocked correctly" from
-- "nothing was there".
--
-- RESTRICTIVE is the whole fix: a restrictive policy is ANDed with the permissive ones, so
-- it can actually take something away. Applied to ALL rather than INSERT so that an account
-- which BECOMES a client stops being able to read or use the tokens it already made -- the
-- MCP server refuses such a token at request time too, and this is the same rule one layer
-- down.

drop policy if exists api_tokens_no_clients on public.api_tokens;

drop policy if exists api_tokens_not_clients on public.api_tokens;
create policy api_tokens_not_clients on public.api_tokens
  as restrictive for all to authenticated
  using      (coalesce(public."current_role"()::text, 'client') <> 'client')
  with check (coalesce(public."current_role"()::text, 'client') <> 'client');
