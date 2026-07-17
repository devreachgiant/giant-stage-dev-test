-- Team Pay: internal payroll tracker. Fully dynamic on two independent axes:
--   1) Departments (pay_departments) — an admin-managed list, not hardcoded, so adding a new
--      team next year is just a row, not a code change.
--   2) Pay type per person (team_pay.base_type + bonus_type) — fixed weekly, fixed monthly, or
--      hourly, with an optional per-unit bonus that can attach to any of the three. Covers every
--      case in the "Team Pay Formulas" doc without hardcoding formulas per department.
-- Locked to owner/manager/inhouse_dev only — this is everyone's salary in one place.

CREATE TABLE "public"."pay_departments" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" text NOT NULL,
    "color" text NOT NULL DEFAULT '#D00400',
    "position" numeric NOT NULL DEFAULT 0,
    "created_by" uuid REFERENCES "public"."profiles"("id"),
    "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "public"."team_pay" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "profile_id" uuid NOT NULL REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
    "department_id" uuid REFERENCES "public"."pay_departments"("id") ON DELETE SET NULL,
    "base_type" text NOT NULL CHECK ("base_type" IN ('fixed_weekly', 'fixed_monthly', 'hourly')),
    "base_amount" numeric NOT NULL DEFAULT 0,
    "weekly_hours" numeric,
    "bonus_type" text NOT NULL DEFAULT 'none' CHECK ("bonus_type" IN ('none', 'per_unit')),
    "bonus_rate" numeric,
    "client_units" numeric DEFAULT 0,
    "units_locked_until" date,
    "local_currency_code" text,
    "local_exchange_rate" numeric,
    "created_by" uuid REFERENCES "public"."profiles"("id"),
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("profile_id")
);

CREATE INDEX "team_pay_department_id_idx" ON "public"."team_pay" ("department_id");

ALTER TABLE "public"."pay_departments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."team_pay" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pay_departments_manage" ON "public"."pay_departments"
    FOR ALL TO "authenticated"
    USING (EXISTS (SELECT 1 FROM "public"."profiles" WHERE "profiles"."id" = "auth"."uid"() AND "profiles"."role" IN ('owner', 'manager', 'inhouse_dev')))
    WITH CHECK (EXISTS (SELECT 1 FROM "public"."profiles" WHERE "profiles"."id" = "auth"."uid"() AND "profiles"."role" IN ('owner', 'manager', 'inhouse_dev')));

CREATE POLICY "team_pay_manage" ON "public"."team_pay"
    FOR ALL TO "authenticated"
    USING (EXISTS (SELECT 1 FROM "public"."profiles" WHERE "profiles"."id" = "auth"."uid"() AND "profiles"."role" IN ('owner', 'manager', 'inhouse_dev')))
    WITH CHECK (EXISTS (SELECT 1 FROM "public"."profiles" WHERE "profiles"."id" = "auth"."uid"() AND "profiles"."role" IN ('owner', 'manager', 'inhouse_dev')));

CREATE OR REPLACE FUNCTION "public"."team_pay_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "team_pay_updated_at" BEFORE UPDATE ON "public"."team_pay"
    FOR EACH ROW EXECUTE FUNCTION "public"."team_pay_set_updated_at"();
