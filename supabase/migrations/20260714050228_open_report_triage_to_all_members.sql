-- Allow any authenticated team member (not just owner/manager) to triage
-- (update status/priority on) bug reports and feature suggestions.

DROP POLICY IF EXISTS "reports_update_triage_or_own" ON "public"."reports";

CREATE POLICY "reports_update_any_authenticated" ON "public"."reports"
    FOR UPDATE TO "authenticated"
    USING (true);
