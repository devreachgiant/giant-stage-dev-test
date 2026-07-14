-- Fix: cancelling (and editing) a scheduled message silently failed.
-- Root cause: the UPDATE policy only had a USING clause, no WITH CHECK.
-- Postgres reuses USING as WITH CHECK when none is given, so the *new* row
-- was also required to satisfy status = 'pending' — which is never true once
-- you cancel/send/edit it, so every update got silently rejected (0 rows).

DROP POLICY IF EXISTS "scheduled_messages_update_own_pending" ON "public"."scheduled_messages";

CREATE POLICY "scheduled_messages_update_own_pending" ON "public"."scheduled_messages"
    FOR UPDATE TO "authenticated"
    USING (("sender_id" = "auth"."uid"()) AND ("status" = 'pending'::"public"."scheduled_message_status"))
    WITH CHECK (("sender_id" = "auth"."uid"()));
