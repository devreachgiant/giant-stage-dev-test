-- Extend the same public/private discoverability model team channels already have
-- (20260727132700_chat2_channel_privacy.sql) to client×department threads. This
-- only affects whether non-manager staff can discover/read without an explicit
-- chat2_thread_members row — managers/owners keep seeing everything regardless,
-- same as today (that base policy is untouched).

DROP POLICY IF EXISTS "chat2_threads_select_public_channel" ON "public"."chat2_threads";
CREATE POLICY "chat2_threads_select_public_channel" ON "public"."chat2_threads" FOR SELECT TO "authenticated"
    USING ("kind" IN ('team_channel', 'client_dept') AND "is_private" = false);
