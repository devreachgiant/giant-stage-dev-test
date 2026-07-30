-- password_folders' policies reference password_folder_members, and
-- password_folder_members' policies reference password_folders back -- Postgres detects that
-- mutual RLS-to-RLS reference as infinite recursion the moment both need to be evaluated in the
-- same query (e.g. an INSERT ... RETURNING on password_folders, which needs its SELECT policy,
-- which needs to check password_folder_members). Fix: SECURITY DEFINER helper functions that
-- check membership/ownership by querying the table directly (bypassing RLS internally, since
-- they run as the function owner), so no table's policy ever needs to re-evaluate another
-- table's RLS to answer the question.

CREATE OR REPLACE FUNCTION "public"."is_password_folder_member"("p_folder_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER SET "search_path" = "public" STABLE
    AS $$ SELECT EXISTS (SELECT 1 FROM public.password_folder_members WHERE folder_id = p_folder_id AND profile_id = auth.uid()); $$;

CREATE OR REPLACE FUNCTION "public"."password_folder_owned_by_me_or_visible"("p_folder_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER SET "search_path" = "public" STABLE
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.password_folders f
    WHERE f.id = p_folder_id
      AND (
        public.is_manager_or_owner()
        OR f.created_by = auth.uid()
        OR (f.visibility = 'public' AND NOT public.is_client_user())
        OR (f.visibility = 'shared' AND public.is_password_folder_member(p_folder_id))
      )
  );
$$;

CREATE OR REPLACE FUNCTION "public"."password_folder_created_by_me"("p_folder_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER SET "search_path" = "public" STABLE
    AS $$ SELECT EXISTS (SELECT 1 FROM public.password_folders WHERE id = p_folder_id AND created_by = auth.uid()); $$;

DROP POLICY IF EXISTS "password_folders_select" ON "public"."password_folders";
CREATE POLICY "password_folders_select" ON "public"."password_folders"
    FOR SELECT USING (
        "public"."is_manager_or_owner"()
        OR "created_by" = "auth"."uid"()
        OR ("visibility" = 'public' AND NOT "public"."is_client_user"())
        OR ("visibility" = 'shared' AND "public"."is_password_folder_member"("id"))
    );

DROP POLICY IF EXISTS "password_folder_members_manage" ON "public"."password_folder_members";
CREATE POLICY "password_folder_members_manage" ON "public"."password_folder_members"
    FOR ALL USING ("public"."is_manager_or_owner"() OR "public"."password_folder_created_by_me"("folder_id"))
    WITH CHECK ("public"."is_manager_or_owner"() OR "public"."password_folder_created_by_me"("folder_id"));

DROP POLICY IF EXISTS "password_entries_all" ON "public"."password_entries";
CREATE POLICY "password_entries_all" ON "public"."password_entries"
    FOR ALL USING ("public"."password_folder_owned_by_me_or_visible"("folder_id"))
    WITH CHECK (NOT "public"."is_client_user"() AND "public"."password_folder_owned_by_me_or_visible"("folder_id"));
