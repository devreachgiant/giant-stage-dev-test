-- Makes "EIN and Business Address are manager-only" a real restriction instead of
-- a UI convention.
--
-- Those two are not columns — they are keys inside clients.onboarding_answers, a
-- jsonb blob. And clients_select_all is `FOR SELECT TO authenticated USING (true)`,
-- so any logged-in user can select the whole blob straight from the table. Chat
-- 3.0 hid them in markup, which protects nothing: one API call returns them.
--
-- Column grants cannot filter keys WITHIN a jsonb value, so a narrower view is not
-- enough on its own. This view strips the keys in the projection instead. Views run
-- as their owner, so a non-manager physically cannot retrieve the removed keys —
-- the same mechanism 20260724120000 already uses for contact info and MRR.
--
-- The real answer keys were read off the onboarding form itself: the address key is
-- `address`, not `business_address`. The extra names below are defensive — removing
-- a key that is not present is a no-op in jsonb.
--
-- SCOPE: this fixes onboarding answers only. The broader problem — that
-- clients_select_all exposes every column of every client to every authenticated
-- user, including client-portal accounts — is deliberately left alone here and
-- raised separately, because narrowing it touches every screen that reads clients.

CREATE OR REPLACE VIEW "public"."client_onboarding" AS
SELECT
    c."id",
    c."name",
    -- clients has no `archived` column; `churned` is the app's archive equivalent.
    c."status",
    c."created_at",
    -- Stored in cents on the table; the caller converts.
    c."mrr_cents",
    c."onboarding_sent_at",
    c."onboarding_submitted_at",
    -- The token is a bearer credential: whoever holds the link can submit the form
    -- as the client. It belongs on the same shelf as the answers it unlocks.
    CASE WHEN "public"."is_manager_or_owner"()
         THEN c."onboarding_token" ELSE NULL END AS "onboarding_token",
    CASE WHEN "public"."is_manager_or_owner"()
         THEN c."onboarding_answers"
         ELSE COALESCE(c."onboarding_answers", '{}'::jsonb)
              - 'ein' - 'address' - 'business_address' - 'tax_id'
    END AS "onboarding_answers"
FROM "public"."clients" c
-- A client-portal user has no business reading any client's intake answers,
-- including their own agency-side record.
WHERE NOT "public"."is_client_user"();

ALTER VIEW "public"."client_onboarding" OWNER TO "postgres";
GRANT SELECT ON "public"."client_onboarding" TO "authenticated";

-- ROLLBACK:
--   DROP VIEW IF EXISTS "public"."client_onboarding";
