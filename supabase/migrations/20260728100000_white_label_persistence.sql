-- White Label Companies had zero database persistence — the entire companies/
-- clients/projects tree was local-only JS state, seeded from two hardcoded demo
-- companies on every page load. "+ New Company" appeared to work (optimistic
-- local push, success toast) but nothing was ever written anywhere, so it
-- reverted to the same two demo companies on the next reload. This gives it
-- real tables.
--
-- Milestones/notes/files/scope/billing stay as jsonb on the project row rather
-- than becoming their own tables — they're small, always edited as part of a
-- project, and never queried independently, so a relational breakout would add
-- migration/RLS surface without adding real query power.
--
-- white_label_clients is a *separate* concept from the real `clients` CRM
-- table — a "client" here is a white-label partner's end customer, scoped
-- inside their company. real_client_id links to a real `clients` row only
-- when/if that client goes through the actual onboarding-link flow (the one
-- part of this module that was already real).

CREATE TABLE IF NOT EXISTS "public"."white_label_companies" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" text NOT NULL,
    "main_contact" text,
    "email" text,
    "phone" text,
    "status" text NOT NULL DEFAULT 'in_progress',
    "archived" boolean NOT NULL DEFAULT false,
    "team" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "created_by" uuid REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "public"."white_label_clients" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL REFERENCES "public"."white_label_companies"("id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "business_name" text,
    "email" text,
    "phone" text,
    "website" text,
    "main_contact" text,
    "summary" text,
    "onboarding_status" text NOT NULL DEFAULT 'not_sent',
    "real_client_id" uuid REFERENCES "public"."clients"("id") ON DELETE SET NULL,
    "onboarding_token" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "white_label_clients_company_id_idx" ON "public"."white_label_clients" ("company_id");

CREATE TABLE IF NOT EXISTS "public"."white_label_projects" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "client_id" uuid NOT NULL REFERENCES "public"."white_label_clients"("id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "type" text,
    "price" numeric NOT NULL DEFAULT 0,
    "paid" numeric NOT NULL DEFAULT 0,
    "start_date" date,
    "target_date" date,
    "status" text NOT NULL DEFAULT 'not_started',
    "pm" text,
    "team" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "milestones" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "notes" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "files" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "scope" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "billing" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "white_label_projects_client_id_idx" ON "public"."white_label_projects" ("client_id");

ALTER TABLE "public"."white_label_companies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."white_label_clients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."white_label_projects" ENABLE ROW LEVEL SECURITY;

-- Same pattern as blog_posts_staff_all / chat2_client_notes: any non-client-portal
-- staff account gets full CRUD. The module itself is already gated to manager+ in
-- the app UI (data-role-min="manager"); this just needs to not leak to client-role
-- accounts if the RLS boundary is ever relied on directly.
CREATE POLICY "white_label_companies_staff_all" ON "public"."white_label_companies" FOR ALL TO "authenticated"
    USING (NOT "public"."is_client_user"()) WITH CHECK (NOT "public"."is_client_user"());
CREATE POLICY "white_label_clients_staff_all" ON "public"."white_label_clients" FOR ALL TO "authenticated"
    USING (NOT "public"."is_client_user"()) WITH CHECK (NOT "public"."is_client_user"());
CREATE POLICY "white_label_projects_staff_all" ON "public"."white_label_projects" FOR ALL TO "authenticated"
    USING (NOT "public"."is_client_user"()) WITH CHECK (NOT "public"."is_client_user"());

GRANT ALL ON "public"."white_label_companies" TO "authenticated";
GRANT ALL ON "public"."white_label_clients" TO "authenticated";
GRANT ALL ON "public"."white_label_projects" TO "authenticated";
GRANT ALL ON "public"."white_label_companies" TO "service_role";
GRANT ALL ON "public"."white_label_clients" TO "service_role";
GRANT ALL ON "public"."white_label_projects" TO "service_role";
