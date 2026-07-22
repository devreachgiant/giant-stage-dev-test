-- Round out the open CRUD model for SOPs/departments: the original migrations
-- only granted select+insert (sops) and select+insert+update (sop_departments).
-- Editing/deleting SOPs and deleting a department both need these.
CREATE POLICY "sops_update_any_authenticated" ON "public"."sops"
    FOR UPDATE TO "authenticated"
    USING (true)
    WITH CHECK (true);

CREATE POLICY "sops_delete_any_authenticated" ON "public"."sops"
    FOR DELETE TO "authenticated"
    USING (true);

CREATE POLICY "sop_departments_delete_any_authenticated" ON "public"."sop_departments"
    FOR DELETE TO "authenticated"
    USING (true);
