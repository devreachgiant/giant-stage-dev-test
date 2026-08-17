-- Fixes a real bug in the previous migration (20260814100700): partial unique
-- indexes (WHERE message_id/task_id IS NOT NULL) cannot be used as a plain
-- ON CONFLICT (col, col) target — PostgREST's .upsert(..., {onConflict:'message_id,
-- profile_id'}) generates exactly that plain form, which would fail to find a
-- matching arbiter and error on every save/done/task-mark in both chat2's own live
-- Master Inbox and Chat 3.0's. Standard (non-partial) UNIQUE constraints don't have
-- this problem — NULLs are never considered equal to each other under a plain
-- UNIQUE constraint, so message_id/task_id can each independently be NULL on
-- however many rows without violating uniqueness, while still enforcing "one action
-- row per (message_id, profile_id)" and "one per (task_id, profile_id)" for the
-- rows that do have a value. No predicate needed, so it matches ON CONFLICT cleanly.

DROP INDEX IF EXISTS "public"."chat2_inbox_actions_message_uniq";
DROP INDEX IF EXISTS "public"."chat2_inbox_actions_task_uniq";

ALTER TABLE "public"."chat2_inbox_actions" ADD CONSTRAINT "chat2_inbox_actions_message_uniq" UNIQUE ("message_id", "profile_id");
ALTER TABLE "public"."chat2_inbox_actions" ADD CONSTRAINT "chat2_inbox_actions_task_uniq" UNIQUE ("task_id", "profile_id");
