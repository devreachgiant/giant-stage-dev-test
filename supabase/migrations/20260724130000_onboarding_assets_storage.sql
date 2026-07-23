-- Storage policies for the onboarding-assets bucket (bucket itself created via the
-- Storage API, matching report-media/sop-media/template-media). The public onboarding
-- form runs fully unauthenticated (anon), so uploads are scoped by embedding the
-- client's onboarding_token as the first path segment and checking it against a live,
-- unrevoked client row — the same trust boundary already used for reading/submitting
-- the client row itself (clients_public_form_select/submit).

CREATE POLICY "onboarding_assets_anon_insert" ON "storage"."objects"
    FOR INSERT TO "anon"
    WITH CHECK (
        "bucket_id" = 'onboarding-assets'
        AND EXISTS (
            SELECT 1 FROM "public"."clients"
            WHERE "clients"."onboarding_token" = ("storage"."foldername"("objects"."name"))[1]
        )
    );

CREATE POLICY "onboarding_assets_anon_select" ON "storage"."objects"
    FOR SELECT TO "anon"
    USING (
        "bucket_id" = 'onboarding-assets'
        AND EXISTS (
            SELECT 1 FROM "public"."clients"
            WHERE "clients"."onboarding_token" = ("storage"."foldername"("objects"."name"))[1]
        )
    );

CREATE POLICY "onboarding_assets_authenticated_select" ON "storage"."objects"
    FOR SELECT TO "authenticated"
    USING ("bucket_id" = 'onboarding-assets');
