-- Storage policies for the template-media bucket (bucket itself created via the
-- Storage API), used for section images/videos in the Templates editor.
CREATE POLICY "template_media_authenticated_insert"
    ON "storage"."objects"
    AS PERMISSIVE FOR INSERT TO "authenticated"
    WITH CHECK (("bucket_id" = 'template-media'::"text"));

CREATE POLICY "template_media_authenticated_read"
    ON "storage"."objects"
    AS PERMISSIVE FOR SELECT TO "authenticated"
    USING (("bucket_id" = 'template-media'::"text"));

CREATE POLICY "template_media_owner_delete"
    ON "storage"."objects"
    AS PERMISSIVE FOR DELETE TO "authenticated"
    USING ((("bucket_id" = 'template-media'::"text") AND ("owner" = "auth"."uid"())));
