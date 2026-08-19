-- Follow-up to 20260818180000, which dropped anon's SELECT on clients.
--
-- The onboarding-assets storage policies scope uploads by checking the path's
-- first segment against a live client token:
--
--   EXISTS (SELECT 1 FROM public.clients WHERE onboarding_token = foldername(name)[1])
--
-- That subquery runs AS THE CALLER, so RLS on clients applies to it. With anon's
-- table access removed, the EXISTS silently evaluates false for every upload and
-- the public form loses the ability to attach files — with no error that points
-- at the cause.
--
-- The check itself is still the right one; it just needs to run somewhere that can
-- see the table. A SECURITY DEFINER helper does the lookup and returns only a
-- boolean, so anon learns whether the token it already holds is valid and nothing
-- else. It cannot be used to enumerate tokens: you must present one to test one.

CREATE OR REPLACE FUNCTION "public"."is_valid_onboarding_token"("p_token" "text")
RETURNS boolean
LANGUAGE "sql" SECURITY DEFINER STABLE
SET "search_path" TO 'public'
AS $$
  SELECT p_token IS NOT NULL
     AND length(p_token) > 0
     AND EXISTS (SELECT 1 FROM public.clients WHERE onboarding_token = p_token);
$$;

ALTER FUNCTION "public"."is_valid_onboarding_token"("p_token" "text") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."is_valid_onboarding_token"("p_token" "text") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."is_valid_onboarding_token"("p_token" "text") TO "anon", "authenticated";

DROP POLICY IF EXISTS "onboarding_assets_anon_insert" ON "storage"."objects";
CREATE POLICY "onboarding_assets_anon_insert" ON "storage"."objects"
    FOR INSERT TO "anon"
    WITH CHECK (
        "bucket_id" = 'onboarding-assets'
        AND "public"."is_valid_onboarding_token"(("storage"."foldername"("objects"."name"))[1])
    );

DROP POLICY IF EXISTS "onboarding_assets_anon_select" ON "storage"."objects";
CREATE POLICY "onboarding_assets_anon_select" ON "storage"."objects"
    FOR SELECT TO "anon"
    USING (
        "bucket_id" = 'onboarding-assets'
        AND "public"."is_valid_onboarding_token"(("storage"."foldername"("objects"."name"))[1])
    );

-- ROLLBACK: restore the inline EXISTS in both policies and drop the function.
-- Note that the inline form only works while anon can SELECT clients, so it must
-- be rolled back together with 20260818180000, not on its own.
