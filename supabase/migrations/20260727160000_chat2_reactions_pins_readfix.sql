-- Round 1 of matching old Chat & Huddles' message hover-bar feature set in Chat 2.0:
-- reactions, pinning, and a real read-receipts source. Also fixes a latent bug found
-- while building this: chat2_messages had NO select policy letting a plain (non-
-- manager) member read Home messages before their own chat2_thread_members row
-- existed — markRead() only creates that row AFTER the first load's SELECT already
-- ran, so a member's very first visit to Home would silently show zero messages
-- (RLS filters, not an error) until a second load. Same "kind='home' is open to
-- everyone" carve-out already used for chat2_threads/chat2_thread_members/insert.

CREATE POLICY "chat2_messages_select_home_anyone" ON "public"."chat2_messages" FOR SELECT TO "authenticated"
    USING (EXISTS (SELECT 1 FROM "public"."chat2_threads" t WHERE t."id" = "thread_id" AND t."kind" = 'home'));

ALTER TABLE "public"."chat2_messages" ADD COLUMN IF NOT EXISTS "pinned" boolean DEFAULT false NOT NULL;

CREATE TABLE IF NOT EXISTS "public"."chat2_message_reactions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "message_id" uuid NOT NULL REFERENCES "public"."chat2_messages"("id") ON DELETE CASCADE,
    "profile_id" uuid NOT NULL REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
    "emoji" text NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("message_id", "profile_id", "emoji")
);
CREATE INDEX IF NOT EXISTS "chat2_message_reactions_message_id_idx" ON "public"."chat2_message_reactions" ("message_id");

ALTER TABLE "public"."chat2_message_reactions" ENABLE ROW LEVEL SECURITY;

-- Same visibility rule as the messages themselves: manager/owner, a real thread
-- member, or anyone at all when the message lives in the open Home thread.
CREATE POLICY "chat2_message_reactions_select" ON "public"."chat2_message_reactions" FOR SELECT TO "authenticated"
    USING ("public"."is_manager_or_owner"() OR EXISTS (
        SELECT 1 FROM "public"."chat2_messages" m JOIN "public"."chat2_thread_members" tm ON tm."thread_id" = m."thread_id"
        WHERE m."id" = "message_id" AND tm."profile_id" = "auth"."uid"()
    ) OR EXISTS (
        SELECT 1 FROM "public"."chat2_messages" m JOIN "public"."chat2_threads" t ON t."id" = m."thread_id"
        WHERE m."id" = "message_id" AND t."kind" = 'home'
    ));

CREATE POLICY "chat2_message_reactions_insert" ON "public"."chat2_message_reactions" FOR INSERT TO "authenticated"
    WITH CHECK ("profile_id" = "auth"."uid"());
CREATE POLICY "chat2_message_reactions_delete" ON "public"."chat2_message_reactions" FOR DELETE TO "authenticated"
    USING ("profile_id" = "auth"."uid"());

GRANT ALL ON "public"."chat2_message_reactions" TO "authenticated";
GRANT ALL ON "public"."chat2_message_reactions" TO "service_role";
