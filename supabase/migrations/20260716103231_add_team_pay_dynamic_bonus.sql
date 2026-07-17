-- Replaces the flat "$X per unit" bonus with a dynamic, admin-editable tiered scale
-- (matches Luke's "Simple Pay Formula" doc: first unit free, $7.50/unit up to 12,
-- $18.75/unit beyond), plus an optional ad-spend-based bonus (adds extra units based on
-- monthly ad spend, per the "Ad Spend Units" doc), and a configurable per-person review
-- cycle so client units lock between reviews instead of being freely editable anytime.
-- Both tier tables are shared/global (one bonus scale, one ad-spend scale for everyone),
-- fully editable from the UI — no formula numbers hardcoded in application code.

CREATE TABLE "public"."pay_bonus_tiers" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "from_units" numeric NOT NULL,
    "to_units" numeric,
    "rate_per_unit" numeric NOT NULL DEFAULT 0,
    "position" numeric NOT NULL DEFAULT 0,
    "created_by" uuid REFERENCES "public"."profiles"("id"),
    "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "public"."pay_adspend_tiers" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "from_spend" numeric NOT NULL,
    "to_spend" numeric,
    "extra_units" numeric NOT NULL DEFAULT 0,
    "position" numeric NOT NULL DEFAULT 0,
    "created_by" uuid REFERENCES "public"."profiles"("id"),
    "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "public"."team_pay"
    ADD COLUMN "monthly_ad_spend" numeric,
    ADD COLUMN "review_cycle_days" numeric NOT NULL DEFAULT 30,
    ADD COLUMN "last_reviewed_at" timestamptz;

ALTER TABLE "public"."team_pay" DROP COLUMN "units_locked_until";

ALTER TABLE "public"."pay_bonus_tiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."pay_adspend_tiers" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pay_bonus_tiers_manage" ON "public"."pay_bonus_tiers"
    FOR ALL TO "authenticated"
    USING (EXISTS (SELECT 1 FROM "public"."profiles" WHERE "profiles"."id" = "auth"."uid"() AND "profiles"."role" IN ('owner', 'manager', 'inhouse_dev')))
    WITH CHECK (EXISTS (SELECT 1 FROM "public"."profiles" WHERE "profiles"."id" = "auth"."uid"() AND "profiles"."role" IN ('owner', 'manager', 'inhouse_dev')));

CREATE POLICY "pay_adspend_tiers_manage" ON "public"."pay_adspend_tiers"
    FOR ALL TO "authenticated"
    USING (EXISTS (SELECT 1 FROM "public"."profiles" WHERE "profiles"."id" = "auth"."uid"() AND "profiles"."role" IN ('owner', 'manager', 'inhouse_dev')))
    WITH CHECK (EXISTS (SELECT 1 FROM "public"."profiles" WHERE "profiles"."id" = "auth"."uid"() AND "profiles"."role" IN ('owner', 'manager', 'inhouse_dev')));

-- Seed with the values from Luke's docs so the table isn't empty on first load.
INSERT INTO "public"."pay_bonus_tiers" ("from_units", "to_units", "rate_per_unit", "position") VALUES
    (0, 1, 0, 0),
    (1, 12, 7.5, 1),
    (12, NULL, 18.75, 2);

INSERT INTO "public"."pay_adspend_tiers" ("from_spend", "to_spend", "extra_units", "position") VALUES
    (0, 3000, 0, 0),
    (3000, 10000, 0.5, 1),
    (10000, 25000, 1, 2),
    (25000, 50000, 1.5, 3),
    (50000, 100000, 2, 4);
