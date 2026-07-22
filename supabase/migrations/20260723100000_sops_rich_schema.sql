-- Rebuilds the SOP data model to match the full handoff spec: numbered steps
-- (each with an optional caution note), tools/checklist/examples/mistakes
-- reference sections, versioning, a draft/published/needs_update/archived
-- lifecycle, and a per-person approval workflow (not just complete/incomplete)
-- tracked on sop_completions. Existing rows are treated as already-published
-- v1 SOPs owned by whoever created them — nothing in the current data implied
-- draft status, so defaulting new columns any other way would misrepresent it.

ALTER TABLE "public"."sops" RENAME COLUMN "content_html" TO "purpose";

ALTER TABLE "public"."sops"
    ADD COLUMN "status" text NOT NULL DEFAULT 'published'
        CHECK ("status" IN ('draft','published','needs_update','archived')),
    ADD COLUMN "version" integer NOT NULL DEFAULT 1,
    ADD COLUMN "owner_id" uuid REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    ADD COLUMN "est_time" text,
    ADD COLUMN "steps" jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN "tools" text[] NOT NULL DEFAULT '{}',
    ADD COLUMN "checklist" text[] NOT NULL DEFAULT '{}',
    ADD COLUMN "examples" text[] NOT NULL DEFAULT '{}',
    ADD COLUMN "mistakes" text[] NOT NULL DEFAULT '{}',
    ADD COLUMN "updated_at" timestamptz NOT NULL DEFAULT now();

UPDATE "public"."sops" SET "owner_id" = "created_by" WHERE "owner_id" IS NULL;

-- sop_completions: was a flat "did they submit a video" record — now tracks
-- the same not_started → in_progress → ready → submitted → approved /
-- changes_requested lifecycle each person moves through, plus their per-step
-- and per-checklist-item review state and an optional note to the reviewer.
ALTER TABLE "public"."sop_completions" RENAME COLUMN "completed_at" TO "submitted_at";
ALTER TABLE "public"."sop_completions" ALTER COLUMN "submitted_at" DROP NOT NULL;
ALTER TABLE "public"."sop_completions" ALTER COLUMN "submitted_at" DROP DEFAULT;

ALTER TABLE "public"."sop_completions"
    ADD COLUMN "status" text NOT NULL DEFAULT 'not_started'
        CHECK ("status" IN ('not_started','in_progress','ready','submitted','approved','changes_requested')),
    ADD COLUMN "note" text,
    ADD COLUMN "steps_reviewed" jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN "checklist_done" jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN "reviewed_by" uuid REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    ADD COLUMN "reviewed_at" timestamptz,
    ADD COLUMN "updated_at" timestamptz NOT NULL DEFAULT now();

-- A manager/owner needs to be able to approve or request changes on someone
-- else's submission — the existing "update_own" policy only covers the
-- person's own row, so approvals need a second, role-gated policy alongside it.
CREATE POLICY "sop_completions_update_reviewer" ON "public"."sop_completions"
    FOR UPDATE TO "authenticated"
    USING (EXISTS (SELECT 1 FROM "public"."profiles" WHERE "profiles"."id" = "auth"."uid"() AND "profiles"."role" IN ('owner','manager')))
    WITH CHECK (EXISTS (SELECT 1 FROM "public"."profiles" WHERE "profiles"."id" = "auth"."uid"() AND "profiles"."role" IN ('owner','manager')));
