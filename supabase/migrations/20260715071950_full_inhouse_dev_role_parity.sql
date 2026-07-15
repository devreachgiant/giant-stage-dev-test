-- Full inhouse_dev parity with owner/manager, across every existing permission check
-- (per user request 2026-07-15). Two parts: shared helper functions (covers ~10 policies
-- for free since they call these), then every remaining policy with an inline role check.

CREATE OR REPLACE FUNCTION "public"."is_manager_or_owner"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT public.current_role() IN ('owner','manager','inhouse_dev')
$$;

CREATE OR REPLACE FUNCTION "public"."is_owner"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT public.current_role() IN ('owner','inhouse_dev')
$$;

CREATE OR REPLACE FUNCTION "public"."can_manage_project"("p_project_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.projects p
    where p.id = p_project_id and p.created_by = auth.uid()
  ) or exists (
    select 1 from public.profiles pr
    where pr.id = auth.uid() and pr.role in ('owner','manager','inhouse_dev')
  );
$$;

CREATE OR REPLACE FUNCTION "public"."create_invitation"("p_email" "text", "p_role" "public"."user_role" DEFAULT 'member'::"public"."user_role", "p_full_name" "text" DEFAULT NULL::"text", "p_invite_method" "text" DEFAULT 'password'::"text") RETURNS "public"."invitations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_inviter_role user_role; v_existing public.invitations%ROWTYPE;
  v_token text; v_row public.invitations%ROWTYPE;
BEGIN
  v_inviter_role := public.current_role();
  IF v_inviter_role IS NULL OR v_inviter_role NOT IN ('owner','manager','inhouse_dev') THEN
    RAISE EXCEPTION 'Only owners and managers can invite users';
  END IF;
  IF v_inviter_role = 'manager' AND p_role <> 'member' THEN
    RAISE EXCEPTION 'Managers can only invite members';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE lower(email) = lower(p_email)) THEN
    RAISE EXCEPTION 'This email already belongs to a workspace member';
  END IF;

  SELECT * INTO v_existing FROM public.invitations
   WHERE lower(email) = lower(p_email) AND accepted_at IS NULL
     AND revoked_at IS NULL AND expires_at > now() LIMIT 1;
  IF FOUND THEN
    UPDATE public.invitations
       SET expires_at = now() + interval '7 days',
           role = p_role, full_name = COALESCE(p_full_name, full_name),
           invite_method = p_invite_method
     WHERE id = v_existing.id RETURNING * INTO v_row;
    RETURN v_row;
  END IF;

  v_token := public.generate_invitation_token();
  INSERT INTO public.invitations (email, full_name, role, token, invited_by, invite_method)
  VALUES (lower(p_email), p_full_name, p_role, v_token, auth.uid(), p_invite_method)
  RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Extend every existing owner/manager permission check to also include the new
-- inhouse_dev role, for full parity (per user request 2026-07-15).

DROP POLICY IF EXISTS "channel_members_admin_delete" ON "public"."channel_members";
CREATE POLICY "channel_members_admin_delete" ON "public"."channel_members" FOR DELETE TO "authenticated" USING ((("profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'inhouse_dev'::"text", 'admin'::"text"])))))));

DROP POLICY IF EXISTS "channel_members_admin_insert" ON "public"."channel_members";
CREATE POLICY "channel_members_admin_insert" ON "public"."channel_members" FOR INSERT TO "authenticated" WITH CHECK ((("profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'inhouse_dev'::"text", 'admin'::"text"])))))));

DROP POLICY IF EXISTS "channels_delete_owner_mgr" ON "public"."channels";
CREATE POLICY "channels_delete_owner_mgr" ON "public"."channels" FOR DELETE TO "authenticated" USING ((("created_by" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'inhouse_dev'::"text", 'admin'::"text"])))))));

DROP POLICY IF EXISTS "chat_sections_delete_own" ON "public"."chat_sections";
CREATE POLICY "chat_sections_delete_own" ON "public"."chat_sections" FOR DELETE TO "authenticated" USING ((("profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'inhouse_dev'::"text", 'admin'::"text"])))))));

DROP POLICY IF EXISTS "chat_sections_update_own" ON "public"."chat_sections";
CREATE POLICY "chat_sections_update_own" ON "public"."chat_sections" FOR UPDATE TO "authenticated" USING ((("profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'inhouse_dev'::"text", 'admin'::"text"]))))))) WITH CHECK (true);

DROP POLICY IF EXISTS "day_sessions_self_read" ON "public"."day_sessions";
CREATE POLICY "day_sessions_self_read" ON "public"."day_sessions" FOR SELECT TO "authenticated" USING ((("profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND (("profiles"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'inhouse_dev'::"text"])))))));

DROP POLICY IF EXISTS "hercules_self_read" ON "public"."hercules_outputs";
CREATE POLICY "hercules_self_read" ON "public"."hercules_outputs" FOR SELECT TO "authenticated" USING ((("profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND (("profiles"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'inhouse_dev'::"text"])))))));

DROP POLICY IF EXISTS "invoice_items_modify" ON "public"."invoice_items";
CREATE POLICY "invoice_items_modify" ON "public"."invoice_items" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['owner'::"public"."user_role", 'manager'::"public"."user_role", 'inhouse_dev'::"public"."user_role"])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['owner'::"public"."user_role", 'manager'::"public"."user_role", 'inhouse_dev'::"public"."user_role"]))))));

DROP POLICY IF EXISTS "invoices_delete" ON "public"."invoices";
CREATE POLICY "invoices_delete" ON "public"."invoices" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['owner'::"public"."user_role", 'manager'::"public"."user_role", 'inhouse_dev'::"public"."user_role"]))))));

DROP POLICY IF EXISTS "invoices_insert" ON "public"."invoices";
CREATE POLICY "invoices_insert" ON "public"."invoices" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['owner'::"public"."user_role", 'manager'::"public"."user_role", 'inhouse_dev'::"public"."user_role"]))))));

DROP POLICY IF EXISTS "invoices_update" ON "public"."invoices";
CREATE POLICY "invoices_update" ON "public"."invoices" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['owner'::"public"."user_role", 'manager'::"public"."user_role", 'inhouse_dev'::"public"."user_role"]))))));

DROP POLICY IF EXISTS "messages_pin_by_staff" ON "public"."messages";
CREATE POLICY "messages_pin_by_staff" ON "public"."messages" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "pr"
  WHERE (("pr"."id" = "auth"."uid"()) AND ("pr"."role" = ANY (ARRAY['owner'::"public"."user_role", 'manager'::"public"."user_role", 'inhouse_dev'::"public"."user_role"])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "pr"
  WHERE (("pr"."id" = "auth"."uid"()) AND ("pr"."role" = ANY (ARRAY['owner'::"public"."user_role", 'manager'::"public"."user_role", 'inhouse_dev'::"public"."user_role"]))))));

DROP POLICY IF EXISTS "stripe_config_modify" ON "public"."stripe_config";
CREATE POLICY "stripe_config_modify" ON "public"."stripe_config" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" IN ('owner'::"public"."user_role", 'inhouse_dev'::"public"."user_role")))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" IN ('owner'::"public"."user_role", 'inhouse_dev'::"public"."user_role"))))));

DROP POLICY IF EXISTS "time_sessions_select_team" ON "public"."time_sessions";
CREATE POLICY "time_sessions_select_team" ON "public"."time_sessions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND (("profiles"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'inhouse_dev'::"text"]))))));

DROP POLICY IF EXISTS "workspace_files_delete" ON "public"."workspace_files";
CREATE POLICY "workspace_files_delete" ON "public"."workspace_files" FOR DELETE TO "authenticated" USING ((("uploaded_by" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'inhouse_dev'::"text"])))))));

DROP POLICY IF EXISTS "workspace_files_read" ON "public"."workspace_files";
CREATE POLICY "workspace_files_read" ON "public"."workspace_files" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'inhouse_dev'::"text", 'member'::"text"]))))) OR ("uploaded_by" = "auth"."uid"())));

DROP POLICY IF EXISTS "workspace_files_update" ON "public"."workspace_files";
CREATE POLICY "workspace_files_update" ON "public"."workspace_files" FOR UPDATE TO "authenticated" USING ((("uploaded_by" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'inhouse_dev'::"text"]))))))) WITH CHECK ((("uploaded_by" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."role")::"text" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'inhouse_dev'::"text"])))))));
