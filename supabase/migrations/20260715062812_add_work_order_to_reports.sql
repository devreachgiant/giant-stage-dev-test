-- Let owner/manager set which order (1-10) reports should be worked on. Enforced with a
-- trigger (not just RLS) so a change to this specific column is rejected outright for
-- anyone else, even if they bypass the UI and call the API directly.

ALTER TABLE "public"."reports"
    ADD COLUMN "work_order" smallint CHECK ("work_order" BETWEEN 1 AND 10);

CREATE OR REPLACE FUNCTION "public"."reports_enforce_work_order_permission"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  IF NEW.work_order IS DISTINCT FROM OLD.work_order THEN
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

CREATE TRIGGER "reports_work_order_permission" BEFORE UPDATE ON "public"."reports"
    FOR EACH ROW EXECUTE FUNCTION "public"."reports_enforce_work_order_permission"();
