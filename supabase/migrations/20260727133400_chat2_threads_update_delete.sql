-- chat2_threads had INSERT/SELECT policies only — renaming a team channel,
-- switching public/private, or deleting one would silently fail under RLS.
-- Same trust level as everything else manager/owner-gated in Chat 2.0.
-- Deleting a thread cascades to its chat2_messages/chat2_thread_members rows
-- via the existing ON DELETE CASCADE foreign keys — no orphaned data.

CREATE POLICY "chat2_threads_update_mgr" ON "public"."chat2_threads" FOR UPDATE TO "authenticated"
    USING ("public"."is_manager_or_owner"()) WITH CHECK ("public"."is_manager_or_owner"());

CREATE POLICY "chat2_threads_delete_mgr" ON "public"."chat2_threads" FOR DELETE TO "authenticated"
    USING ("public"."is_manager_or_owner"());
