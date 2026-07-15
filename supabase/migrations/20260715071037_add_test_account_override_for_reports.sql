-- TEMPORARY TEST OVERRIDE — remove on request.
-- Grants nishchaypandya461012@gmail.com (id cee32408-d00a-4bb4-8cb3-1439ccd30397) the same
-- Help Us Improve permissions as owner/manager (feature submissions + work_order editing),
-- WITHOUT changing their actual profiles.role (stays "member"), so local testing doesn't
-- also unlock unrelated owner/manager-gated areas of the app (e.g. Finance).

DROP POLICY IF EXISTS "reports_insert_own" ON "public"."reports";

CREATE POLICY "reports_insert_own" ON "public"."reports"
    FOR INSERT TO "authenticated"
    WITH CHECK (
        ("reporter_id" = "auth"."uid"())
        AND (
            "type" = 'bug'::"public"."report_type"
            OR "auth"."uid"() = 'cee32408-d00a-4bb4-8cb3-1439ccd30397'::"uuid"  -- TEMP test override
            OR EXISTS (
                SELECT 1 FROM "public"."profiles"
                WHERE "profiles"."id" = "auth"."uid"()
                AND "profiles"."role" IN ('owner', 'manager')
            )
        )
    );

CREATE OR REPLACE FUNCTION "public"."reports_enforce_work_order_permission"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  IF NEW.work_order IS DISTINCT FROM OLD.work_order THEN
    IF "auth"."uid"() = 'cee32408-d00a-4bb4-8cb3-1439ccd30397'::"uuid" THEN  -- TEMP test override
      RETURN NEW;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "public"."profiles"
      WHERE "profiles"."id" = "auth"."uid"()
      AND "profiles"."role" IN ('owner', 'manager')
    ) THEN
      RAISE EXCEPTION 'Only owner or manager can set the work order';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
