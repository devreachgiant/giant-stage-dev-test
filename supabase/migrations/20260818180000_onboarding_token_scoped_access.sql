-- SECURITY FIX: the public onboarding form's policies exposed every client row to
-- anyone on the internet.
--
-- The two anon policies on clients were:
--
--   clients_public_form_select  FOR SELECT TO anon USING (onboarding_token IS NOT NULL)
--   clients_public_form_submit  FOR UPDATE TO anon USING (onboarding_token IS NOT NULL)
--
-- They check that a token EXISTS, not that it MATCHES the caller's. Every client
-- row has a token, so both matched every row — and SELECT returns every column.
-- Using only the publishable key that ships in config.js, an unauthenticated
-- caller could read all client names, mrr_cents, contact details, every other
-- client's onboarding_token, and the onboarding_answers blob including EIN and
-- address. The UPDATE policy is worse in kind: it grants anon write access to
-- every client row.
--
-- The form still has to work without a login, so access moves behind two
-- SECURITY DEFINER functions that take the token and are scoped to the single row
-- it matches. This is the same shape as password-vault-decrypt: the server does
-- the lookup, and holding an id (or here, a token) only ever gets you that one
-- thing. `SET search_path` is pinned on both so a definer function cannot be
-- redirected through a shadowed schema.
--
-- Column list matches exactly what the form already reads — nothing wider.

CREATE OR REPLACE FUNCTION "public"."get_onboarding_form"("p_token" "text")
RETURNS TABLE (
    "id" "uuid",
    "name" "text",
    "contact_name" "text",
    "contact_email" "text",
    "onboarding_answers" "jsonb",
    "onboarding_submitted_at" timestamp with time zone,
    "status" "public"."client_status"
)
LANGUAGE "sql" SECURITY DEFINER
SET "search_path" TO 'public'
AS $$
  SELECT c.id, c.name, c.contact_name, c.contact_email,
         c.onboarding_answers, c.onboarding_submitted_at, c.status
  FROM public.clients c
  -- A blank or NULL token must never match a row. Without this guard, a caller
  -- passing '' would otherwise rely on every row having a non-empty token.
  WHERE p_token IS NOT NULL AND length(p_token) > 0
    AND c.onboarding_token = p_token
  LIMIT 1;
$$;

ALTER FUNCTION "public"."get_onboarding_form"("p_token" "text") OWNER TO "postgres";

-- Writes exactly the two fields the form submits, on exactly the row whose token
-- was presented. It cannot touch any other column or any other client.
CREATE OR REPLACE FUNCTION "public"."submit_onboarding_form"("p_token" "text", "p_answers" "jsonb")
RETURNS boolean
LANGUAGE "plpgsql" SECURITY DEFINER
SET "search_path" TO 'public'
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_token IS NULL OR length(p_token) = 0 THEN
    RETURN false;
  END IF;
  UPDATE public.clients
     SET onboarding_answers = p_answers,
         onboarding_submitted_at = now()
   WHERE onboarding_token = p_token;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $$;

ALTER FUNCTION "public"."submit_onboarding_form"("p_token" "text", "p_answers" "jsonb") OWNER TO "postgres";

-- anon needs these two and nothing else. authenticated gets them too so the same
-- code path works if a signed-in user happens to open an onboarding link.
REVOKE ALL ON FUNCTION "public"."get_onboarding_form"("p_token" "text") FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."submit_onboarding_form"("p_token" "text", "p_answers" "jsonb") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."get_onboarding_form"("p_token" "text") TO "anon", "authenticated";
GRANT EXECUTE ON FUNCTION "public"."submit_onboarding_form"("p_token" "text", "p_answers" "jsonb") TO "anon", "authenticated";

-- With the functions in place, anon no longer needs table access at all.
DROP POLICY IF EXISTS "clients_public_form_select" ON "public"."clients";
DROP POLICY IF EXISTS "clients_public_form_submit" ON "public"."clients";

-- ROLLBACK (restores the vulnerability — only if the form breaks and you need it
-- working while a proper fix lands):
--   CREATE POLICY "clients_public_form_select" ON "public"."clients"
--     FOR SELECT TO "anon" USING (("onboarding_token" IS NOT NULL));
--   CREATE POLICY "clients_public_form_submit" ON "public"."clients"
--     FOR UPDATE TO "anon" USING (("onboarding_token" IS NOT NULL))
--     WITH CHECK (("onboarding_token" IS NOT NULL));
