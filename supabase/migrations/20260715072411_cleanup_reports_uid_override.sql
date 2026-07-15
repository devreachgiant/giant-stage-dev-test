-- Remove the earlier hardcoded-UID test override — now redundant since the proper
-- inhouse_dev role (added in full_inhouse_dev_role_parity) already grants this account
-- the same permissions cleanly, without a one-off UUID check scattered in policies.

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
                AND "profiles"."role" IN ('owner', 'manager', 'inhouse_dev')
            )
        )
    );

CREATE OR REPLACE FUNCTION "public"."reports_enforce_work_order_permission"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  IF NEW.work_order IS DISTINCT FROM OLD.work_order THEN
    IF NOT EXISTS (
      SELECT 1 FROM "public"."profiles"
      WHERE "profiles"."id" = "auth"."uid"()
      AND "profiles"."role" IN ('owner', 'manager', 'inhouse_dev')
    ) THEN
      RAISE EXCEPTION 'Only owner or manager can set the work order';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
