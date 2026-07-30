-- Three visibility tiers per folder, not just "shared with specific people":
--   private -> only the creator (+ owner/manager oversight) can see it -- personal password storage
--   shared  -> creator + explicitly invited members (password_folder_members) -- e.g. one client's team
--   public  -> any non-client Giant staff member can see it, no invite needed -- shared tool/Google
--              logins the whole team needs (Nishchay: "make them public which can be visible to all
--              giant app members only")

ALTER TABLE "public"."password_folders"
    ADD COLUMN IF NOT EXISTS "visibility" "text" NOT NULL DEFAULT 'private'
    CHECK ("visibility" IN ('private', 'shared', 'public'));

DROP POLICY IF EXISTS "password_folders_select" ON "public"."password_folders";
CREATE POLICY "password_folders_select" ON "public"."password_folders"
    FOR SELECT USING (
        "public"."is_manager_or_owner"()
        OR "created_by" = "auth"."uid"()
        OR ("visibility" = 'public' AND NOT "public"."is_client_user"())
        OR ("visibility" = 'shared' AND EXISTS (SELECT 1 FROM "public"."password_folder_members" "m" WHERE "m"."folder_id" = "password_folders"."id" AND "m"."profile_id" = "auth"."uid"()))
    );

DROP POLICY IF EXISTS "password_entries_all" ON "public"."password_entries";
CREATE POLICY "password_entries_all" ON "public"."password_entries"
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM "public"."password_folders" "f"
            WHERE "f"."id" = "password_entries"."folder_id"
              AND (
                "public"."is_manager_or_owner"()
                OR "f"."created_by" = "auth"."uid"()
                OR ("f"."visibility" = 'public' AND NOT "public"."is_client_user"())
                OR ("f"."visibility" = 'shared' AND EXISTS (SELECT 1 FROM "public"."password_folder_members" "m" WHERE "m"."folder_id" = "f"."id" AND "m"."profile_id" = "auth"."uid"()))
              )
        )
    ) WITH CHECK (
        NOT "public"."is_client_user"()
        AND EXISTS (
            SELECT 1 FROM "public"."password_folders" "f"
            WHERE "f"."id" = "password_entries"."folder_id"
              AND (
                "public"."is_manager_or_owner"()
                OR "f"."created_by" = "auth"."uid"()
                OR ("f"."visibility" = 'public' AND NOT "public"."is_client_user"())
                OR ("f"."visibility" = 'shared' AND EXISTS (SELECT 1 FROM "public"."password_folder_members" "m" WHERE "m"."folder_id" = "f"."id" AND "m"."profile_id" = "auth"."uid"()))
              )
        )
    );
