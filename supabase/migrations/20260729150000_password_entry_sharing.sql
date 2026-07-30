-- Per-password sharing with specific teammates, independent of folder membership
-- (Nishchay: "how to share on specific password with particular teammates, not whole folder").
-- Until now "Share with team" just copied a deep link that only worked if the recipient
-- already had folder-level access — there was no way to grant access to ONE password inside
-- an otherwise-private/not-shared-with-them folder. This adds that as a real access grant,
-- same recursion-safe SECURITY DEFINER pattern as password_folder_members.

CREATE TABLE IF NOT EXISTS "public"."password_entry_members" (
    "entry_id" "uuid" NOT NULL REFERENCES "public"."password_entries"("id") ON DELETE CASCADE,
    "profile_id" "uuid" NOT NULL REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
    "added_by" "uuid" REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    "added_at" timestamptz NOT NULL DEFAULT "now"(),
    PRIMARY KEY ("entry_id", "profile_id")
);
CREATE INDEX IF NOT EXISTS "password_entry_members_profile_id_idx" ON "public"."password_entry_members" ("profile_id");

ALTER TABLE "public"."password_entry_members" ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION "public"."is_password_entry_member"("p_entry_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER SET "search_path" = "public" STABLE
    AS $$ SELECT EXISTS (SELECT 1 FROM public.password_entry_members WHERE entry_id = p_entry_id AND profile_id = auth.uid()); $$;

-- Who's allowed to manage (add/remove) an entry's individual members: the entry's own
-- creator, the folder's creator, or any owner/manager. SECURITY DEFINER so this can query
-- password_entries/password_folders directly without re-triggering their RLS.
CREATE OR REPLACE FUNCTION "public"."password_entry_owned_by_me_or_folder"("p_entry_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER SET "search_path" = "public" STABLE
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.password_entries e
    JOIN public.password_folders f ON f.id = e.folder_id
    WHERE e.id = p_entry_id
      AND (public.is_manager_or_owner() OR e.created_by = auth.uid() OR f.created_by = auth.uid())
  );
$$;

DROP POLICY IF EXISTS "password_entry_members_manage" ON "public"."password_entry_members";
CREATE POLICY "password_entry_members_manage" ON "public"."password_entry_members"
    FOR ALL USING ("public"."is_manager_or_owner"() OR "public"."password_entry_owned_by_me_or_folder"("entry_id"))
    WITH CHECK ("public"."is_manager_or_owner"() OR "public"."password_entry_owned_by_me_or_folder"("entry_id"));

DROP POLICY IF EXISTS "password_entry_members_self_select" ON "public"."password_entry_members";
CREATE POLICY "password_entry_members_self_select" ON "public"."password_entry_members"
    FOR SELECT USING ("profile_id" = "auth"."uid"());

-- Broaden password_entries SELECT to also allow entry-level members, WITHOUT touching write
-- access (insert/update/delete still require folder-level access — entry members are
-- view/decrypt only). Two permissive policies combine with OR for SELECT; the original
-- password_entries_all stays as the write gate for INSERT/UPDATE/DELETE.
DROP POLICY IF EXISTS "password_entries_select_extra" ON "public"."password_entries";
CREATE POLICY "password_entries_select_extra" ON "public"."password_entries"
    FOR SELECT USING ("public"."is_password_entry_member"("id"));
