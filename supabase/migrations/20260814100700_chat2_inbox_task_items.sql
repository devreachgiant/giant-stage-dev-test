-- Master Inbox needs to show task-assignment activity alongside messages (Slack-style
-- "everything needing you" feed) — reuses chat2_inbox_actions for the same per-user
-- done/saved tracking instead of a second parallel table, so a task item can be
-- marked done/saved in the inbox exactly like a message item already can.

-- message_id is part of the current PK, so the PK has to go before it can become
-- nullable — replaced below with a plain surrogate id + two partial unique indexes.
ALTER TABLE "public"."chat2_inbox_actions" DROP CONSTRAINT IF EXISTS "chat2_inbox_actions_pkey";
ALTER TABLE "public"."chat2_inbox_actions" ALTER COLUMN "message_id" DROP NOT NULL;
ALTER TABLE "public"."chat2_inbox_actions" ADD COLUMN IF NOT EXISTS "task_id" uuid REFERENCES "public"."tasks"("id") ON DELETE CASCADE;

-- Exactly one of message_id/task_id must be set — an inbox action row is always about
-- one or the other, never both and never neither.
ALTER TABLE "public"."chat2_inbox_actions" DROP CONSTRAINT IF EXISTS "chat2_inbox_actions_one_target";
ALTER TABLE "public"."chat2_inbox_actions" ADD CONSTRAINT "chat2_inbox_actions_one_target"
    CHECK (("message_id" IS NOT NULL) <> ("task_id" IS NOT NULL));

ALTER TABLE "public"."chat2_inbox_actions" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid();
UPDATE "public"."chat2_inbox_actions" SET "id" = gen_random_uuid() WHERE "id" IS NULL;
ALTER TABLE "public"."chat2_inbox_actions" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "public"."chat2_inbox_actions" ADD PRIMARY KEY ("id");

CREATE UNIQUE INDEX IF NOT EXISTS "chat2_inbox_actions_message_uniq" ON "public"."chat2_inbox_actions" ("message_id", "profile_id") WHERE "message_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "chat2_inbox_actions_task_uniq" ON "public"."chat2_inbox_actions" ("task_id", "profile_id") WHERE "task_id" IS NOT NULL;
