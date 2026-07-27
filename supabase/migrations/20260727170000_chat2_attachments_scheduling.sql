-- Round 2 of matching old Chat & Huddles: file/image attachments + scheduled send,
-- for the Home composer and its thread-reply composer.
--
-- Attachments reuse the real 'chat-attachments' storage bucket (already open to any
-- authenticated upload/read, owner-only delete) rather than a new bucket — no new
-- storage policy needed. chat2_messages just gets a jsonb column to record what was
-- attached, same shape old chat itself would produce: [{name,url,mime_type,size,path}].
ALTER TABLE "public"."chat2_messages" ADD COLUMN IF NOT EXISTS "attachments" jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Scheduling mirrors the real `scheduled_messages` table/delivery pattern (a Netlify
-- scheduled function polls for due rows and inserts the real message), but on its
-- own chat2_* table/thread_id — Chat 2.0 stays fully isolated from old chat's tables.
CREATE TYPE "public"."chat2_scheduled_message_status" AS ENUM ('pending','sent','cancelled','failed');

CREATE TABLE IF NOT EXISTS "public"."chat2_scheduled_messages" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "thread_id" uuid NOT NULL REFERENCES "public"."chat2_threads"("id") ON DELETE CASCADE,
    "parent_id" uuid REFERENCES "public"."chat2_messages"("id") ON DELETE CASCADE,
    "sender_id" uuid NOT NULL REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
    "body" text NOT NULL,
    "attachments" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "scheduled_for" timestamptz NOT NULL,
    "status" "public"."chat2_scheduled_message_status" NOT NULL DEFAULT 'pending',
    "sent_message_id" uuid REFERENCES "public"."chat2_messages"("id") ON DELETE SET NULL,
    "error" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "sent_at" timestamptz
);

CREATE INDEX IF NOT EXISTS "chat2_scheduled_messages_due_idx" ON "public"."chat2_scheduled_messages" ("scheduled_for") WHERE ("status" = 'pending');
CREATE INDEX IF NOT EXISTS "chat2_scheduled_messages_sender_idx" ON "public"."chat2_scheduled_messages" ("sender_id", "status");

ALTER TABLE "public"."chat2_scheduled_messages" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chat2_scheduled_messages_select_own" ON "public"."chat2_scheduled_messages" FOR SELECT TO "authenticated"
    USING ("sender_id" = "auth"."uid"());
CREATE POLICY "chat2_scheduled_messages_insert_own" ON "public"."chat2_scheduled_messages" FOR INSERT TO "authenticated"
    WITH CHECK ("sender_id" = "auth"."uid"());
CREATE POLICY "chat2_scheduled_messages_update_own_pending" ON "public"."chat2_scheduled_messages" FOR UPDATE TO "authenticated"
    USING ("sender_id" = "auth"."uid"() AND "status" = 'pending');

GRANT ALL ON "public"."chat2_scheduled_messages" TO "authenticated";
GRANT ALL ON "public"."chat2_scheduled_messages" TO "service_role";
