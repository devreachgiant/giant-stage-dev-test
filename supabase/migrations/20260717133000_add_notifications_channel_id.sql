-- Lets the in-app notification bell deep-link chat mentions/DMs to their conversation.
ALTER TABLE "public"."notifications"
    ADD COLUMN "channel_id" uuid REFERENCES "public"."channels"("id") ON DELETE CASCADE;
