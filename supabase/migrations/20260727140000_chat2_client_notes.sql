-- Client Hub → Notes & Files needs real inline notes. The existing `notes` table
-- is personal scratch space (profile_id-owned, no client_id at all) so it can't be
-- reused here without leaking one person's private notes into a shared client view.
-- Files reuse the existing `workspace_files` table instead (already client_id-scoped,
-- already has a real storage bucket + RLS) — no new table needed for that half.
--
-- Same isolation rule as the rest of Chat 2.0: new chat2_* table, clients stays
-- read-only. RLS mirrors blog_posts_staff_all — any non-client-portal user gets
-- full CRUD, since this whole tab is already gated to owner/manager/inhouse_dev
-- at the module level.

CREATE TABLE IF NOT EXISTS "public"."chat2_client_notes" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "client_id" uuid NOT NULL REFERENCES "public"."clients"("id") ON DELETE CASCADE,
    "author_id" uuid REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    "body" text NOT NULL DEFAULT '',
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "chat2_client_notes_client_id_idx" ON "public"."chat2_client_notes" ("client_id", "created_at" DESC);

ALTER TABLE "public"."chat2_client_notes" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chat2_client_notes_staff_all" ON "public"."chat2_client_notes" FOR ALL TO "authenticated"
    USING (NOT "public"."is_client_user"()) WITH CHECK (NOT "public"."is_client_user"());

GRANT ALL ON "public"."chat2_client_notes" TO "authenticated";
GRANT ALL ON "public"."chat2_client_notes" TO "service_role";
