-- The anon insert/select policies on onboarding-assets referenced an
-- unqualified "name" column inside a correlated EXISTS subquery against
-- "clients" (which also has a "name" column). Postgres resolved it to
-- clients.name instead of the intended storage.objects.name, so every
-- upload compared a client's own name to its own token and always failed
-- with "new row violates row-level security policy". Recreated with
-- explicit table qualifiers.

DROP POLICY IF EXISTS "onboarding_assets_anon_insert" ON "storage"."objects";
DROP POLICY IF EXISTS "onboarding_assets_anon_select" ON "storage"."objects";

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
