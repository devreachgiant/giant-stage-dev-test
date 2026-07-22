-- SOPs & Workflows: lets any team member document how work gets done, grouped
-- into departments they can create inline from the same screen.

CREATE TABLE IF NOT EXISTS "public"."sop_departments" (
    "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    "name" text NOT NULL UNIQUE,
    "created_by" uuid REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."sops" (
    "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    "department_id" uuid NOT NULL REFERENCES "public"."sop_departments"("id") ON DELETE CASCADE,
    "title" text NOT NULL,
    "category" text,
    "why" text,
    "steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "created_by" uuid REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX "sops_department_id_idx" ON "public"."sops" ("department_id");

ALTER TABLE "public"."sop_departments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."sops" ENABLE ROW LEVEL SECURITY;

-- Same open model as changelog/reports: any signed-in team member can read and add.
-- The nav entry is data-client-hidden, so client-role users never see this screen.
CREATE POLICY "sop_departments_select_all" ON "public"."sop_departments"
    FOR SELECT TO "authenticated"
    USING (true);

CREATE POLICY "sop_departments_insert_any_authenticated" ON "public"."sop_departments"
    FOR INSERT TO "authenticated"
    WITH CHECK (true);

CREATE POLICY "sops_select_all" ON "public"."sops"
    FOR SELECT TO "authenticated"
    USING (true);

CREATE POLICY "sops_insert_any_authenticated" ON "public"."sops"
    FOR INSERT TO "authenticated"
    WITH CHECK (true);
