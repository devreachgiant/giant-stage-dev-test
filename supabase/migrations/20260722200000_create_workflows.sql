-- Workflows: multi-stage business processes (e.g. "Client Onboarding"), distinct
-- from SOPs (single how-to docs) — a workflow's stages can each link to the SOP
-- that explains how to execute that stage. Stages are stored as a single jsonb
-- array rather than a child table since they're always read/written as a whole
-- ordered unit from the builder and the process-flow view, never queried piecemeal.
CREATE TABLE IF NOT EXISTS "public"."workflows" (
    "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    "name" text NOT NULL,
    "description" text,
    "department_id" uuid REFERENCES "public"."sop_departments"("id") ON DELETE SET NULL,
    "type" text,
    "owner_name" text,
    "status" text NOT NULL DEFAULT 'draft'
        CHECK ("status" IN ('draft','active','paused','blocked','complete','archived')),
    "expected_time" text,
    "stages" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "created_by" uuid REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "workflows_department_id_idx" ON "public"."workflows" ("department_id");

ALTER TABLE "public"."workflows" ENABLE ROW LEVEL SECURITY;

-- Same open collaborative model as sops/sop_departments: any signed-in team
-- member can read, add, and edit. The nav entry is data-client-hidden.
CREATE POLICY "workflows_select_all" ON "public"."workflows"
    FOR SELECT TO "authenticated"
    USING (true);

CREATE POLICY "workflows_insert_any_authenticated" ON "public"."workflows"
    FOR INSERT TO "authenticated"
    WITH CHECK (true);

CREATE POLICY "workflows_update_any_authenticated" ON "public"."workflows"
    FOR UPDATE TO "authenticated"
    USING (true)
    WITH CHECK (true);

CREATE POLICY "workflows_delete_any_authenticated" ON "public"."workflows"
    FOR DELETE TO "authenticated"
    USING (true);
