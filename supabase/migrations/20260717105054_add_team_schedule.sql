-- Team Schedule: per-person working hours/timezone + date-based exceptions (leave, public
-- holidays, days off, one-off temporary changes), per Luke's Team Pulse Schedule mockup.
-- Reuses the existing profiles.timezone column as each person's home timezone rather than
-- duplicating it here.

CREATE TABLE "public"."team_schedules" (
    "profile_id" uuid PRIMARY KEY REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
    "work_days" text[] NOT NULL DEFAULT '{Mon,Tue,Wed,Thu,Fri}',
    "start_time" time NOT NULL DEFAULT '09:00',
    "end_time" time NOT NULL DEFAULT '17:00',
    "break_start" time,
    "break_end" time,
    "updated_by" uuid REFERENCES "public"."profiles"("id"),
    "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "public"."schedule_exceptions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "profile_id" uuid NOT NULL REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
    "date" date NOT NULL,
    "kind" text NOT NULL CHECK ("kind" IN ('leave', 'holiday', 'off', 'temp')),
    "label" text,
    "created_by" uuid REFERENCES "public"."profiles"("id"),
    "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "schedule_exceptions_profile_date_idx" ON "public"."schedule_exceptions" ("profile_id", "date");

ALTER TABLE "public"."team_schedules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."schedule_exceptions" ENABLE ROW LEVEL SECURITY;

-- Visible to any internal (non-client) team member — matches Team Pulse's own visibility
-- (the nav item itself is data-client-hidden), enforced again here for defense in depth.
CREATE POLICY "team_schedules_select" ON "public"."team_schedules"
    FOR SELECT TO "authenticated"
    USING (EXISTS (SELECT 1 FROM "public"."profiles" WHERE "profiles"."id" = "auth"."uid"() AND "profiles"."role" <> 'client'));

CREATE POLICY "schedule_exceptions_select" ON "public"."schedule_exceptions"
    FOR SELECT TO "authenticated"
    USING (EXISTS (SELECT 1 FROM "public"."profiles" WHERE "profiles"."id" = "auth"."uid"() AND "profiles"."role" <> 'client'));

-- Editing is manager-only (matches the mockup's isManager gate on "Edit schedule").
CREATE POLICY "team_schedules_manage" ON "public"."team_schedules"
    FOR ALL TO "authenticated"
    USING (EXISTS (SELECT 1 FROM "public"."profiles" WHERE "profiles"."id" = "auth"."uid"() AND "profiles"."role" IN ('owner', 'manager', 'inhouse_dev')))
    WITH CHECK (EXISTS (SELECT 1 FROM "public"."profiles" WHERE "profiles"."id" = "auth"."uid"() AND "profiles"."role" IN ('owner', 'manager', 'inhouse_dev')));

CREATE POLICY "schedule_exceptions_manage" ON "public"."schedule_exceptions"
    FOR ALL TO "authenticated"
    USING (EXISTS (SELECT 1 FROM "public"."profiles" WHERE "profiles"."id" = "auth"."uid"() AND "profiles"."role" IN ('owner', 'manager', 'inhouse_dev')))
    WITH CHECK (EXISTS (SELECT 1 FROM "public"."profiles" WHERE "profiles"."id" = "auth"."uid"() AND "profiles"."role" IN ('owner', 'manager', 'inhouse_dev')));

CREATE OR REPLACE FUNCTION "public"."team_schedules_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "team_schedules_updated_at" BEFORE UPDATE ON "public"."team_schedules"
    FOR EACH ROW EXECUTE FUNCTION "public"."team_schedules_set_updated_at"();
