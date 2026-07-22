-- Lets any signed-in team member rename an SOP department (same open model as
-- creating one) — the original migration only granted select+insert.
CREATE POLICY "sop_departments_update_any_authenticated" ON "public"."sop_departments"
    FOR UPDATE TO "authenticated"
    USING (true)
    WITH CHECK (true);
