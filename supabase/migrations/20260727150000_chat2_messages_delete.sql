-- chat2_messages had no DELETE policy at all — the new per-message hover actions
-- (matching old Chat & Huddles' delete-your-own-message convention) need one.
-- Same author-or-manager rule as the existing UPDATE policy.

CREATE POLICY "chat2_messages_delete_own_or_mgr" ON "public"."chat2_messages" FOR DELETE TO "authenticated"
    USING ("author_id" = "auth"."uid"() OR "public"."is_manager_or_owner"());
