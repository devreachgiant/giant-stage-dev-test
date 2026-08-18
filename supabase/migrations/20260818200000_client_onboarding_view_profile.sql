-- Widens client_onboarding so Management > Overview can show the profile the spec
-- asks for (profile, contact, working notes, keywords) without going back to the
-- raw clients table — which is still `SELECT TO authenticated USING (true)` and so
-- would hand every field to every logged-in user.
--
-- Contact details keep the tier 20260724120000 established: clients_manager has
-- them, clients_public does not. Rather than make the caller pick a view, the
-- gating happens in the projection, so one query is correct for every role.

-- CREATE OR REPLACE cannot reorder or rename a view's columns, only append, so the
-- view is dropped and rebuilt. Nothing else references it yet — only Chat 3.0.
DROP VIEW IF EXISTS "public"."client_onboarding";
CREATE VIEW "public"."client_onboarding" AS
SELECT
    c."id",
    c."name",
    c."status",
    c."created_at",
    c."started_at",
    c."industry",
    c."company_website",
    c."timezone",
    c."working_notes",
    c."keywords",
    c."mrr_cents",
    c."onboarding_sent_at",
    c."onboarding_submitted_at",
    -- Contact details: manager and owner only, matching clients_manager.
    CASE WHEN "public"."is_manager_or_owner"() THEN c."contact_name"  ELSE NULL END AS "contact_name",
    CASE WHEN "public"."is_manager_or_owner"() THEN c."contact_email" ELSE NULL END AS "contact_email",
    CASE WHEN "public"."is_manager_or_owner"() THEN c."contact_phone" ELSE NULL END AS "contact_phone",
    -- The token is a bearer credential: whoever holds the link can submit the form
    -- as the client, so it sits with the answers it unlocks.
    CASE WHEN "public"."is_manager_or_owner"()
         THEN c."onboarding_token" ELSE NULL END AS "onboarding_token",
    CASE WHEN "public"."is_manager_or_owner"()
         THEN c."onboarding_answers"
         ELSE COALESCE(c."onboarding_answers", '{}'::jsonb)
              - 'ein' - 'address' - 'business_address' - 'tax_id'
    END AS "onboarding_answers"
FROM "public"."clients" c
WHERE NOT "public"."is_client_user"();

ALTER VIEW "public"."client_onboarding" OWNER TO "postgres";
GRANT SELECT ON "public"."client_onboarding" TO "authenticated";

-- ROLLBACK: re-run 20260818160000 to restore the narrower projection.
