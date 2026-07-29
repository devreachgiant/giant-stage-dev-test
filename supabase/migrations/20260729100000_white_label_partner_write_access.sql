-- Luke: partners should be able to be given either read-only or write access to their
-- company's day-to-day content (milestones, notes, files, team, scope) — not a blanket
-- all-or-nothing read-only.
--
-- Deliberately NOT extended to: company-level structural changes (edit/archive company,
-- create/delete clients or projects, the Access list itself) or pricing (client price,
-- Partner Payout, internal cost) — those stay owner/manager-only regardless of this
-- setting. A "can_edit" partner can edit exactly the same fields they could already SEE;
-- write access never reveals anything new. Price/billing changes are additionally blocked
-- by a trigger below so a compromised or buggy client request can't bypass that boundary
-- via a raw API call even if RLS alone would have allowed the row.

ALTER TABLE "public"."white_label_company_members"
    ADD COLUMN IF NOT EXISTS "access_level" "text" NOT NULL DEFAULT 'read_only'
    CHECK ("access_level" IN ('read_only', 'can_edit'));

CREATE POLICY "white_label_clients_partner_edit" ON "public"."white_label_clients"
    FOR UPDATE USING (EXISTS (
        SELECT 1 FROM "public"."white_label_company_members" "m"
        WHERE "m"."company_id" = "white_label_clients"."company_id"
          AND "m"."profile_id" = "auth"."uid"() AND "m"."access_level" = 'can_edit'
    )) WITH CHECK (EXISTS (
        SELECT 1 FROM "public"."white_label_company_members" "m"
        WHERE "m"."company_id" = "white_label_clients"."company_id"
          AND "m"."profile_id" = "auth"."uid"() AND "m"."access_level" = 'can_edit'
    ));

CREATE POLICY "white_label_projects_partner_edit" ON "public"."white_label_projects"
    FOR UPDATE USING (EXISTS (
        SELECT 1 FROM "public"."white_label_clients" "c"
        JOIN "public"."white_label_company_members" "m" ON "m"."company_id" = "c"."company_id"
        WHERE "c"."id" = "white_label_projects"."client_id"
          AND "m"."profile_id" = "auth"."uid"() AND "m"."access_level" = 'can_edit'
    )) WITH CHECK (EXISTS (
        SELECT 1 FROM "public"."white_label_clients" "c"
        JOIN "public"."white_label_company_members" "m" ON "m"."company_id" = "c"."company_id"
        WHERE "c"."id" = "white_label_projects"."client_id"
          AND "m"."profile_id" = "auth"."uid"() AND "m"."access_level" = 'can_edit'
    ));

CREATE OR REPLACE FUNCTION "public"."enforce_wl_project_pricing_staff_only"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" = "public"
    AS $$
BEGIN
  IF (NEW.price IS DISTINCT FROM OLD.price OR NEW.billing IS DISTINCT FROM OLD.billing)
     AND auth.uid() IS NOT NULL AND NOT is_manager_or_owner() THEN
    RAISE EXCEPTION 'Only an owner or manager can change project pricing';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_enforce_wl_project_pricing_staff_only" ON "public"."white_label_projects";
CREATE TRIGGER "trg_enforce_wl_project_pricing_staff_only"
    BEFORE UPDATE ON "public"."white_label_projects"
    FOR EACH ROW EXECUTE FUNCTION "public"."enforce_wl_project_pricing_staff_only"();
