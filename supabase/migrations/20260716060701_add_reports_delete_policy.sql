-- Allow deleting a report if you're the reporter, or owner/manager/inhouse_dev (triage staff).
-- No DELETE policy previously existed on reports at all, so deletes were silently denied by RLS.

CREATE POLICY "reports_delete_own_or_triage" ON "public"."reports"
    FOR DELETE TO "authenticated"
    USING (
        ("reporter_id" = "auth"."uid"())
        OR EXISTS (
            SELECT 1 FROM "public"."profiles"
            WHERE "profiles"."id" = "auth"."uid"()
            AND "profiles"."role" IN ('owner', 'manager', 'inhouse_dev')
        )
    );
