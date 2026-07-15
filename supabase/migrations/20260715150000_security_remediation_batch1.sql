-- Security remediation — batch 1: anon-reachable criticals
--
-- Scope: only the holes exploitable by anonymous or cross-user callers WITHOUT a
-- coordinated frontend change. Safe to apply on its own.
--
-- Deferred to batch 2 (need frontend token-passing or a schema change, verify together):
--   * function-level JWT auth across the 34 Netlify functions  (breaks frontend fetches until
--     they send Authorization: Bearer <supabase access_token>)
--   * magnus_missions all-verbs USING(true)  (authenticated-only; needs an owner column + FE change)
--   * invitations_select_auth, channels_update_open, bookings_anon_insert  (lower severity)

begin;

-- 1. Vault: get_secret() is SECURITY DEFINER over vault.decrypted_secrets and was
--    EXECUTE-granted to anon/authenticated — any holder of the public anon key could
--    read Resend + other secrets. Revoke non-server access; service_role keeps it
--    (server-side functions call it with the service role).
revoke execute on function "public"."get_secret"("p_name" "text") from "anon";
revoke execute on function "public"."get_secret"("p_name" "text") from "authenticated";

-- 2. OAuth / Stripe token tables were readable by ANY authenticated user
--    (gcal_tokens_view_any / stripe_tokens_view_any = USING (true)) — a member or client
--    account could exfiltrate everyone's Google + Stripe tokens. Restrict to self.
--    The backend functions that legitimately read these use the service role and bypass RLS.
drop policy if exists "gcal_tokens_view_any" on "public"."gcal_tokens";
create policy "gcal_tokens_select_self" on "public"."gcal_tokens"
  for select to "authenticated"
  using ("profile_id" = "auth"."uid"());

drop policy if exists "stripe_tokens_view_any" on "public"."stripe_tokens";
create policy "stripe_tokens_select_self" on "public"."stripe_tokens"
  for select to "authenticated"
  using ("profile_id" = "auth"."uid"());

-- 3. Share packs: the "Public can view share packs" policy allowed anon to SELECT (enumerate)
--    EVERY client deliverable. The public review page (share.html) reads packs only through the
--    share-pack-get function (service role), so anon table access is unnecessary. Drop the
--    combined anon+authenticated policy and re-grant read to authenticated users only.
drop policy if exists "Public can view share packs" on "public"."share_packs";
create policy "share_packs_select_authenticated" on "public"."share_packs"
  for select to "authenticated"
  using (true);

commit;
