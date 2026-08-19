-- Realtime DELETE events only include the full OLD row when a table's replica
-- identity is FULL — by default only the primary key ("id") is sent. Chat 3.0's
-- live reaction-removal handler needs profile_id/emoji/message_id from the removed
-- row (there's no other way to know which reaction on which message was un-set),
-- so this widens what DELETE payloads carry for this table specifically.

ALTER TABLE "public"."chat2_message_reactions" REPLICA IDENTITY FULL;

-- Chat 3.0's new live thread subscription (messages/reactions/read-receipts) needs
-- these three tables in the realtime publication — only chat2_thread_canvas was
-- ever added before (for chat2's own canvas live-sync), chat2_messages/
-- chat2_thread_members/chat2_message_reactions were never turned on.
ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."chat2_messages";
ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."chat2_thread_members";
ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."chat2_message_reactions";
