-- ReachGiant Home is open to everyone, not just managers/owners (explicit call —
-- overrides the original spec's "top-level posting is manager-only" rule). The
-- existing chat2_thread_members_write_mgr / chat2_messages_insert policies only
-- let managers/owners self-join or post, so a plain member could never satisfy
-- the membership check for the Home thread on their own. These two additional
-- permissive policies (Postgres OR's multiple permissive policies together) open
-- self-join and posting specifically for the Home thread, leaving every other
-- thread kind's access rules untouched.

CREATE POLICY "chat2_thread_members_self_join_home" ON "public"."chat2_thread_members" FOR INSERT TO "authenticated"
    WITH CHECK ("profile_id" = "auth"."uid"() AND EXISTS (
        SELECT 1 FROM "public"."chat2_threads" t WHERE t."id" = "thread_id" AND t."kind" = 'home'
    ));

CREATE POLICY "chat2_messages_insert_home_anyone" ON "public"."chat2_messages" FOR INSERT TO "authenticated"
    WITH CHECK ("author_id" = "auth"."uid"() AND EXISTS (
        SELECT 1 FROM "public"."chat2_threads" t WHERE t."id" = "thread_id" AND t."kind" = 'home'
    ));
