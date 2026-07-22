-- Tracks who has completed (watched + recorded proof for) each SOP, shown in the
-- SOP detail view's "Team completions" list.
CREATE TABLE IF NOT EXISTS "public"."sop_completions" (
    "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    "sop_id" uuid NOT NULL REFERENCES "public"."sops"("id") ON DELETE CASCADE,
    "profile_id" uuid NOT NULL REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
    "video_url" text,
    "completed_at" timestamptz DEFAULT now() NOT NULL,
    UNIQUE ("sop_id", "profile_id")
);

CREATE INDEX "sop_completions_sop_id_idx" ON "public"."sop_completions" ("sop_id");

ALTER TABLE "public"."sop_completions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sop_completions_select_all" ON "public"."sop_completions"
    FOR SELECT TO "authenticated"
    USING (true);

-- Only the person themselves can log/update their own completion.
CREATE POLICY "sop_completions_insert_own" ON "public"."sop_completions"
    FOR INSERT TO "authenticated"
    WITH CHECK ("profile_id" = "auth"."uid"());

CREATE POLICY "sop_completions_update_own" ON "public"."sop_completions"
    FOR UPDATE TO "authenticated"
    USING ("profile_id" = "auth"."uid"())
    WITH CHECK ("profile_id" = "auth"."uid"());
