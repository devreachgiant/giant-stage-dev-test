-- An in-house dev needs to reach every channel to support it: Prestige Lighting was
-- invisible to one, because both of its channels are private and the dev is not a
-- member, so the client did not exist as far as that session was concerned.
--
-- Scoped deliberately, and each limit is a decision rather than an oversight:
--
-- 1. inhouse_dev ONLY. is_manager_or_owner() would have been the tidier predicate --
--    it already means owner + manager + inhouse_dev, and it is what
--    chat2_threads_select uses for Chat 3.0 -- but that grants every manager and
--    owner blanket read on private channels, which nobody has today. Chosen scope is
--    the smallest that solves the problem. It does mean a dev can see more than an
--    owner, which is worth remembering when this is next revisited.
--
-- 2. NOT DMs. `channels` holds 80 direct-message rows carrying 6,844 messages.
--    "Access to every channel" must not quietly become "read everyone's private
--    conversations", so the exception is gated on is_dm = false and DMs keep
--    requiring membership exactly as before.
--
-- 3. This widens the ORIGINAL Chat screen too. RLS is per-table, not per-module, so
--    this is the one change on this branch that the old Chat screen can see. An
--    in-house dev will now find private channels such as security, rg-managers and
--    team-pay-channel readable there as well as in New Chat.

DROP POLICY IF EXISTS "channels_select" ON "public"."channels";
CREATE POLICY "channels_select" ON "public"."channels" FOR SELECT
  USING (
    "is_private" = false
    OR EXISTS (SELECT 1 FROM "public"."channel_members" cm
                WHERE cm."channel_id" = "channels"."id" AND cm."profile_id" = auth.uid())
    OR ("is_dm" = false AND public.current_role() = 'inhouse_dev')
  );

-- Messages follow the channel. Being able to list a channel you cannot read is not
-- access, so the same exception is mirrored here rather than left to diverge.
DROP POLICY IF EXISTS "messages_select" ON "public"."messages";
CREATE POLICY "messages_select" ON "public"."messages" FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM "public"."channels" c
             WHERE c."id" = "messages"."channel_id"
               AND (
                 c."is_private" = false
                 OR EXISTS (SELECT 1 FROM "public"."channel_members" cm
                             WHERE cm."channel_id" = c."id" AND cm."profile_id" = auth.uid())
                 OR (c."is_dm" = false AND public.current_role() = 'inhouse_dev')
               ))
  );
