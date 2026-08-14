-- Chat 3.0's "Vault" tab is a richer, card-based canvas for client×department
-- threads (title/collapse/delete cards with checklist items and images), vs. the
-- plain-text Canvas chat2's Home/DM/team_channel threads already use. Reuses the
-- same thread-scoped chat2_thread_canvas table (PK thread_id already means every
-- thread, including each client_dept thread, has its own independent row) rather
-- than a new table. `cards` is nullable and additive — existing rows (and Home/DM/
-- team_channel canvases going forward) keep using the plain-text `content` column
-- untouched; only when `cards` is non-null does the UI render the Vault card view.

ALTER TABLE "public"."chat2_thread_canvas" ADD COLUMN IF NOT EXISTS "cards" jsonb NULL;
