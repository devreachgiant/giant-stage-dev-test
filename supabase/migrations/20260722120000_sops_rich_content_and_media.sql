-- Replace the plain-text "why" + line-per-step fields with a single rich-text
-- body (headings/bold/lists, authored via a contenteditable editor) and add a
-- video/media attachment slot, matching the report-media pattern.
ALTER TABLE "public"."sops" RENAME COLUMN "why" TO "content_html";
ALTER TABLE "public"."sops" DROP COLUMN "steps";
ALTER TABLE "public"."sops" ADD COLUMN "video_url" text;

-- Storage policies for the sop-media bucket (bucket itself created via the Storage API).
CREATE POLICY "sop_media_authenticated_insert"
    ON "storage"."objects"
    AS PERMISSIVE FOR INSERT TO "authenticated"
    WITH CHECK (("bucket_id" = 'sop-media'::"text"));

CREATE POLICY "sop_media_authenticated_read"
    ON "storage"."objects"
    AS PERMISSIVE FOR SELECT TO "authenticated"
    USING (("bucket_id" = 'sop-media'::"text"));

CREATE POLICY "sop_media_owner_delete"
    ON "storage"."objects"
    AS PERMISSIVE FOR DELETE TO "authenticated"
    USING ((("bucket_id" = 'sop-media'::"text") AND ("owner" = "auth"."uid"())));
