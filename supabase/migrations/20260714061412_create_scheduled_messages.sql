-- Scheduled messages: send a channel/DM message at a future time (like Slack's "Schedule send").

CREATE TYPE "public"."scheduled_message_status" AS ENUM (
    'pending',
    'sent',
    'cancelled',
    'failed'
);

CREATE TABLE IF NOT EXISTS "public"."scheduled_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "channel_id" "uuid" NOT NULL,
    "sender_id" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "scheduled_for" timestamp with time zone NOT NULL,
    "status" "public"."scheduled_message_status" DEFAULT 'pending'::"public"."scheduled_message_status" NOT NULL,
    "sent_message_id" "uuid",
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "sent_at" timestamp with time zone
);

ALTER TABLE "public"."scheduled_messages" OWNER TO "postgres";

ALTER TABLE ONLY "public"."scheduled_messages"
    ADD CONSTRAINT "scheduled_messages_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."scheduled_messages"
    ADD CONSTRAINT "scheduled_messages_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."scheduled_messages"
    ADD CONSTRAINT "scheduled_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."scheduled_messages"
    ADD CONSTRAINT "scheduled_messages_sent_message_id_fkey" FOREIGN KEY ("sent_message_id") REFERENCES "public"."messages"("id") ON DELETE SET NULL;

CREATE INDEX "scheduled_messages_due_idx" ON "public"."scheduled_messages" USING "btree" ("scheduled_for") WHERE ("status" = 'pending'::"public"."scheduled_message_status");
CREATE INDEX "scheduled_messages_sender_idx" ON "public"."scheduled_messages" USING "btree" ("sender_id", "status");

ALTER TABLE "public"."scheduled_messages" ENABLE ROW LEVEL SECURITY;

-- Only the sender can see/manage their own scheduled messages (private until actually sent,
-- same as Slack — nobody else should know a message is queued).
CREATE POLICY "scheduled_messages_select_own" ON "public"."scheduled_messages"
    FOR SELECT TO "authenticated"
    USING (("sender_id" = "auth"."uid"()));

CREATE POLICY "scheduled_messages_insert_own" ON "public"."scheduled_messages"
    FOR INSERT TO "authenticated"
    WITH CHECK (("sender_id" = "auth"."uid"()));

-- Cancelling = updating status to 'cancelled'. Only allowed while still pending.
CREATE POLICY "scheduled_messages_update_own_pending" ON "public"."scheduled_messages"
    FOR UPDATE TO "authenticated"
    USING (("sender_id" = "auth"."uid"()) AND ("status" = 'pending'::"public"."scheduled_message_status"));
