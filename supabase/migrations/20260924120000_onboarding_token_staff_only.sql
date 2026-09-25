-- Minting an onboarding link is a staff action, and the database now says so.
--
-- generate_onboarding_token has been SECURITY DEFINER and GRANT ALL ... TO anon since the
-- 20260713135058 baseline. It takes a client id, writes a fresh token onto that client and
-- returns it. So anybody at all -- no account, nothing but the publishable anon key that
-- ships in config.js -- could mint themselves a working onboarding link for any client
-- whose UUID they knew, then read that client's onboarding answers through
-- get_onboarding_form: business name, address, EIN, contact details. Minting also
-- overwrites the token, so it silently breaks the link the real client was sent.
--
-- Verified against production on 2026-09-24 in a rolled-back transaction, acting as anon:
-- the mint returned a token, and get_onboarding_form returned that client's row with it.
--
-- The 2026-08-18 hotfix (20260818180000) closed the enumeration half of this -- anon can no
-- longer list clients, so UUIDs are no longer handed out in bulk -- which is why this reads
-- as "needs an id first" rather than "download everything". A client id is not a secret,
-- though: it travels in links, exports and screenshots, and one leaked id is one client's
-- tax number.
--
-- Two changes:
--
--   1. anon loses EXECUTE. The public form does not use this function -- it only calls
--      get_onboarding_form and submit_onboarding_form -- so nothing anonymous regresses.
--      All four callers in index.html are staff surfaces behind sign-in (Clients, White
--      Label, New Chat management, Pods).
--
--   2. A client-portal account cannot call it either. authenticated still holds EXECUTE,
--      and that role includes the client logins, so without this check one client could
--      mint a link for another and read their answers. The rule is deliberately "not a
--      client account" rather than "manager or owner", because ordinary staff do generate
--      these links and narrowing to managers would take that away.
--
-- search_path is pinned at the same time. A SECURITY DEFINER function without one resolves
-- unqualified names against the caller's search_path, which is how a definer function gets
-- turned into someone else's code.

revoke all on function public.generate_onboarding_token(uuid) from anon;
revoke all on function public.generate_onboarding_token(uuid) from public;

create or replace function public.generate_onboarding_token(p_client_id uuid)
  returns text
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
DECLARE
  v_token text;
BEGIN
  IF auth.uid() IS NULL OR coalesce(public."current_role"()::text, 'client') = 'client' THEN
    RAISE EXCEPTION 'Only signed-in staff can generate an onboarding link';
  END IF;

  -- Generate a 32-char URL-safe token
  -- extensions.gen_random_bytes, qualified: pgcrypto lives in the extensions schema, and
  -- pinning search_path to public alone made this function fail with "gen_random_bytes does
  -- not exist" -- caught by the dry run, which is the whole reason for having one.
  v_token := encode(extensions.gen_random_bytes(24), 'base64');
  -- Make URL-safe (strip +/= and replace with -_)
  v_token := translate(v_token, '+/=', '-_');
  UPDATE public.clients SET onboarding_token = v_token, onboarding_sent_at = now() WHERE id = p_client_id;
  RETURN v_token;
END $function$;

grant execute on function public.generate_onboarding_token(uuid) to authenticated;
