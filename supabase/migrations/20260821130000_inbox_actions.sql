-- Master Inbox needs somewhere to record what you have done with an item: cleared it,
-- saved it, or turned it into a task.
--
-- chat2_inbox_actions cannot be reused. Its message_id is a foreign key to
-- chat2_messages, so an old-chat message id fails the constraint outright -- the same
-- shape of problem as channel_canvas versus chat2_thread_canvas, and solved the same
-- way: a parallel table pointing at this side's messages.
--
-- Mirrors the chat2 table deliberately, down to the one-target check, so the ported
-- panel reads and writes it with only the table name changed.

CREATE TABLE IF NOT EXISTS "public"."inbox_actions" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "profile_id" uuid NOT NULL REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
  "message_id" uuid REFERENCES "public"."messages"("id") ON DELETE CASCADE,
  "task_id"    uuid REFERENCES "public"."tasks"("id") ON DELETE SET NULL,
  "done"       boolean NOT NULL DEFAULT false,
  "saved"      boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- An action is about exactly one thing. Without this a row could point at both a
  -- message and a task, and the key the UI builds ("msg:<id>" / "task:<id>") would be
  -- ambiguous.
  CONSTRAINT "inbox_actions_one_target" CHECK (("message_id" IS NOT NULL) <> ("task_id" IS NOT NULL)),
  CONSTRAINT "inbox_actions_message_uniq" UNIQUE ("message_id", "profile_id"),
  CONSTRAINT "inbox_actions_task_uniq"    UNIQUE ("task_id", "profile_id")
);

ALTER TABLE "public"."inbox_actions" ENABLE ROW LEVEL SECURITY;

-- Your inbox is yours. Every policy is scoped to auth.uid() rather than to a role, so
-- unlike most tables here there is no manager exception: clearing an item is a private
-- act and nobody else needs to see or change it.
DROP POLICY IF EXISTS "inbox_actions_select_own" ON "public"."inbox_actions";
CREATE POLICY "inbox_actions_select_own" ON "public"."inbox_actions" FOR SELECT
  USING ("profile_id" = auth.uid());

DROP POLICY IF EXISTS "inbox_actions_insert_own" ON "public"."inbox_actions";
CREATE POLICY "inbox_actions_insert_own" ON "public"."inbox_actions" FOR INSERT
  WITH CHECK ("profile_id" = auth.uid());

DROP POLICY IF EXISTS "inbox_actions_update_own" ON "public"."inbox_actions";
CREATE POLICY "inbox_actions_update_own" ON "public"."inbox_actions" FOR UPDATE
  USING ("profile_id" = auth.uid()) WITH CHECK ("profile_id" = auth.uid());

DROP POLICY IF EXISTS "inbox_actions_delete_own" ON "public"."inbox_actions";
CREATE POLICY "inbox_actions_delete_own" ON "public"."inbox_actions" FOR DELETE
  USING ("profile_id" = auth.uid());

CREATE INDEX IF NOT EXISTS "inbox_actions_profile_idx"
  ON "public"."inbox_actions" ("profile_id");
