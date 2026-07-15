-- Only owner/manager can submit feature suggestions via Help Us Improve.
-- Everyone can still submit bug reports.

DROP POLICY IF EXISTS "reports_insert_own" ON "public"."reports";

CREATE POLICY "reports_insert_own" ON "public"."reports"
    FOR INSERT TO "authenticated"
    WITH CHECK (
        ("reporter_id" = "auth"."uid"())
        AND (
            "type" = 'bug'::"public"."report_type"
            OR EXISTS (
                SELECT 1 FROM "public"."profiles"
                WHERE "profiles"."id" = "auth"."uid"()
                AND "profiles"."role" IN ('owner', 'manager')
            )
        )
    );
