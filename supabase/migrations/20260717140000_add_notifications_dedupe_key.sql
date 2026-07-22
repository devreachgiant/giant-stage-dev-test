-- Lets client-side "state became true" checks (overdue task, overdue invoice, unread email)
-- insert a notification exactly once per event via ON CONFLICT DO NOTHING, instead of needing
-- a server-side cron job to track what's already been logged.
ALTER TABLE "public"."notifications"
    ADD COLUMN "dedupe_key" text;

CREATE UNIQUE INDEX "notifications_recipient_dedupe_key_idx"
    ON "public"."notifications" ("recipient_id", "dedupe_key")
    WHERE "dedupe_key" IS NOT NULL;
