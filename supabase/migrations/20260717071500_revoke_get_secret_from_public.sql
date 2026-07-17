-- Security remediation — batch 1 follow-up: actually close the get_secret() vault leak.
--
-- The batch-1 migration (20260715150000) did:
--   revoke execute on function public.get_secret(text) from anon;
--   revoke execute on function public.get_secret(text) from authenticated;
-- That was a no-op. anon/authenticated never held a DIRECT execute grant on this
-- function — they inherited EXECUTE via the default grant to PUBLIC. The function's
-- ACL was {=X/postgres, postgres=X/postgres, service_role=X/postgres}: the leading
-- "=X" entry is the grant to PUBLIC. Revoking from anon/authenticated left PUBLIC's
-- grant in place, so anyone with the public anon key could still call get_secret and
-- read vault.decrypted_secrets via PostgREST rpc.
--
-- Fix: revoke EXECUTE from PUBLIC. Only postgres (owner) and service_role retain it,
-- which is what the server-side functions use. Verified against prod 2026-07-17:
-- anon rpc/get_secret now returns 42501 "permission denied for function get_secret".
--
-- Applied to prod ahead of this commit; committed so a fresh apply reproduces the state.

begin;

revoke execute on function "public"."get_secret"("p_name" "text") from "public";

commit;

-- PostgREST caches function EXECUTE privileges in its schema cache; a reload is
-- required for a grant/revoke to take effect on the REST surface. Supabase issues this
-- via NOTIFY. (Left as a comment — running it inside the migration transaction has no
-- effect; it was issued separately after apply.)
--   notify pgrst, 'reload schema';
