-- Password manager: client-wise folders, shareable with specific teammates, similar to
-- 1Password. Passwords are stored ENCRYPTED (AES-256-GCM ciphertext, iv, authTag columns) --
-- the actual encrypt/decrypt happens server-side in Netlify functions using a secret key that
-- never reaches the browser. RLS controls WHICH ROWS a user can even reach; encryption means
-- even a full DB dump or RLS misconfiguration doesn't expose plaintext passwords.

CREATE TABLE IF NOT EXISTS "public"."password_folders" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL PRIMARY KEY,
    "name" "text" NOT NULL,
    "client_id" "uuid" REFERENCES "public"."clients"("id") ON DELETE SET NULL,
    "created_by" "uuid" REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."password_folder_members" (
    "folder_id" "uuid" NOT NULL REFERENCES "public"."password_folders"("id") ON DELETE CASCADE,
    "profile_id" "uuid" NOT NULL REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
    "added_by" "uuid" REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    PRIMARY KEY ("folder_id", "profile_id")
);

CREATE TABLE IF NOT EXISTS "public"."password_entries" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL PRIMARY KEY,
    "folder_id" "uuid" NOT NULL REFERENCES "public"."password_folders"("id") ON DELETE CASCADE,
    "title" "text" NOT NULL,
    "username" "text",
    "url" "text",
    "notes" "text",
    "password_ciphertext" "text" NOT NULL,
    "password_iv" "text" NOT NULL,
    "password_auth_tag" "text" NOT NULL,
    "created_by" "uuid" REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_password_entries_folder" ON "public"."password_entries" ("folder_id");
CREATE INDEX IF NOT EXISTS "idx_password_folder_members_profile" ON "public"."password_folder_members" ("profile_id");
CREATE INDEX IF NOT EXISTS "idx_password_folders_client" ON "public"."password_folders" ("client_id");

ALTER TABLE "public"."password_folders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."password_folder_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."password_entries" ENABLE ROW LEVEL SECURITY;

-- Folders: visible to owner/manager (oversight, matches every other module's pattern),
-- the creator, and anyone explicitly shared via password_folder_members. Any staff (non-client)
-- account can create a folder; only the creator or owner/manager can rename/delete it.
CREATE POLICY "password_folders_select" ON "public"."password_folders"
    FOR SELECT USING (
        "public"."is_manager_or_owner"()
        OR "created_by" = "auth"."uid"()
        OR EXISTS (SELECT 1 FROM "public"."password_folder_members" "m" WHERE "m"."folder_id" = "password_folders"."id" AND "m"."profile_id" = "auth"."uid"())
    );
CREATE POLICY "password_folders_insert" ON "public"."password_folders"
    FOR INSERT WITH CHECK (NOT "public"."is_client_user"() AND "created_by" = "auth"."uid"());
CREATE POLICY "password_folders_update" ON "public"."password_folders"
    FOR UPDATE USING ("public"."is_manager_or_owner"() OR "created_by" = "auth"."uid"())
    WITH CHECK ("public"."is_manager_or_owner"() OR "created_by" = "auth"."uid"());
CREATE POLICY "password_folders_delete" ON "public"."password_folders"
    FOR DELETE USING ("public"."is_manager_or_owner"() OR "created_by" = "auth"."uid"());

-- Folder membership (sharing): only the folder's creator or owner/manager can manage who has
-- access; a member can see their own membership rows (so the frontend can tell which folders
-- are "shared with me").
CREATE POLICY "password_folder_members_manage" ON "public"."password_folder_members"
    FOR ALL USING (
        "public"."is_manager_or_owner"()
        OR EXISTS (SELECT 1 FROM "public"."password_folders" "f" WHERE "f"."id" = "password_folder_members"."folder_id" AND "f"."created_by" = "auth"."uid"())
    ) WITH CHECK (
        "public"."is_manager_or_owner"()
        OR EXISTS (SELECT 1 FROM "public"."password_folders" "f" WHERE "f"."id" = "password_folder_members"."folder_id" AND "f"."created_by" = "auth"."uid"())
    );
CREATE POLICY "password_folder_members_self_select" ON "public"."password_folder_members"
    FOR SELECT USING ("profile_id" = "auth"."uid"());

-- Entries: anyone with access to the parent folder (owner/manager, creator, or shared member)
-- can read AND manage the entries inside it -- sharing a folder is meant to let a teammate
-- actually use/add/update the credentials in it, not just view a locked list.
CREATE POLICY "password_entries_all" ON "public"."password_entries"
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM "public"."password_folders" "f"
            WHERE "f"."id" = "password_entries"."folder_id"
              AND (
                "public"."is_manager_or_owner"()
                OR "f"."created_by" = "auth"."uid"()
                OR EXISTS (SELECT 1 FROM "public"."password_folder_members" "m" WHERE "m"."folder_id" = "f"."id" AND "m"."profile_id" = "auth"."uid"())
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
                OR EXISTS (SELECT 1 FROM "public"."password_folder_members" "m" WHERE "m"."folder_id" = "f"."id" AND "m"."profile_id" = "auth"."uid"())
              )
        )
    );
