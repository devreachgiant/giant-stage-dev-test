-- Luke: "How do I add Samuel to the white label company so he can see it?" — Samuel is an
-- external partner (already a real 'member'-role account), and he should see ONLY his own
-- White Label company, not ReachGiant's other clients/partners/pricing. That access model
-- didn't exist at all: White Label is currently gated to manager/owner in the frontend, and
-- the RLS underneath (white_label_*_staff_all: "NOT is_client_user()") already lets ANY
-- non-client staff see EVERY company regardless of role — so simply un-gating the nav for a
-- member would have exposed everyone else's companies too. This adds a real per-company
-- membership table + tightens RLS so partners only ever see what they're explicitly added to.

CREATE TABLE IF NOT EXISTS "public"."white_label_company_members" (
    "company_id" "uuid" NOT NULL REFERENCES "public"."white_label_companies"("id") ON DELETE CASCADE,
    "profile_id" "uuid" NOT NULL REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
    "added_by" "uuid" REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    PRIMARY KEY ("company_id", "profile_id")
);

ALTER TABLE "public"."white_label_company_members" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "white_label_company_members_staff_all" ON "public"."white_label_company_members"
    FOR ALL USING (is_manager_or_owner()) WITH CHECK (is_manager_or_owner());
CREATE POLICY "white_label_company_members_own_select" ON "public"."white_label_company_members"
    FOR SELECT USING ("profile_id" = "auth"."uid"());

-- Tighten white_label_companies: staff keep full access, partners get read-only access to
-- companies they're a member of (and nothing else).
DROP POLICY IF EXISTS "white_label_companies_staff_all" ON "public"."white_label_companies";
CREATE POLICY "white_label_companies_staff_all" ON "public"."white_label_companies"
    FOR ALL USING (is_manager_or_owner()) WITH CHECK (is_manager_or_owner());
CREATE POLICY "white_label_companies_partner_select" ON "public"."white_label_companies"
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM "public"."white_label_company_members" "m"
        WHERE "m"."company_id" = "white_label_companies"."id" AND "m"."profile_id" = "auth"."uid"()
    ));

-- white_label_clients: child of a company via company_id.
DROP POLICY IF EXISTS "white_label_clients_staff_all" ON "public"."white_label_clients";
CREATE POLICY "white_label_clients_staff_all" ON "public"."white_label_clients"
    FOR ALL USING (is_manager_or_owner()) WITH CHECK (is_manager_or_owner());
CREATE POLICY "white_label_clients_partner_select" ON "public"."white_label_clients"
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM "public"."white_label_company_members" "m"
        WHERE "m"."company_id" = "white_label_clients"."company_id" AND "m"."profile_id" = "auth"."uid"()
    ));

-- white_label_projects: grandchild of a company via client_id -> white_label_clients.company_id.
DROP POLICY IF EXISTS "white_label_projects_staff_all" ON "public"."white_label_projects";
CREATE POLICY "white_label_projects_staff_all" ON "public"."white_label_projects"
    FOR ALL USING (is_manager_or_owner()) WITH CHECK (is_manager_or_owner());
CREATE POLICY "white_label_projects_partner_select" ON "public"."white_label_projects"
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM "public"."white_label_clients" "c"
        JOIN "public"."white_label_company_members" "m" ON "m"."company_id" = "c"."company_id"
        WHERE "c"."id" = "white_label_projects"."client_id" AND "m"."profile_id" = "auth"."uid"()
    ));

-- The RLS policy above correctly scopes WHICH ROWS a partner can read, but RLS is row-level,
-- not column-level — the `billing` jsonb blob on those rows also carries `internalCost` and
-- the numbers `profit` is computed from, which the app's own UI explicitly labels "Owner-only
-- breakdown ... hidden from your team and the white label partner" (renderProjectBillingTab).
-- That label was only ever a JS conditional (isOwnerView()) — anyone with row access could
-- already see the real internalCost/profit figures via the network tab regardless of what the
-- UI rendered. This view is what the frontend now queries for partner reads instead of the raw
-- table, so the internal numbers never leave the database for a partner in the first place.
-- security_invoker means it still runs as the querying user, so the RLS policies above (row
-- scoping) still apply on top of this column redaction.
CREATE OR REPLACE VIEW "public"."white_label_projects_partner_safe"
    WITH (security_invoker = true) AS
    SELECT
        "id", "client_id", "name", "type", "price", "paid", "start_date", "target_date",
        "status", "pm", "team", "milestones", "notes", "files", "scope",
        jsonb_build_object(
            'paymentStatus', "billing"->'paymentStatus',
            'partnerPayout', "billing"->'partnerPayout',
            'partnerPaidTotal', "billing"->'partnerPaidTotal',
            'partnerPayoutStatus', "billing"->'partnerPayoutStatus'
        ) AS "billing",
        "created_at", "updated_at"
    FROM "public"."white_label_projects";

GRANT SELECT ON "public"."white_label_projects_partner_safe" TO "authenticated";
