-- New Chat renders old chat's data in the Chat 3.0 shape, so `channels` needs the
-- four things chat2_threads has and it does not: what kind of thread it is, which
-- client it belongs to, which department, and a colour.
--
-- Every column is nullable with a safe default and nothing existing is rewritten in
-- a way old chat reads, so the original Chat screen is unaffected -- it does not
-- select these columns and will not see them.

ALTER TABLE "public"."channels"
  ADD COLUMN IF NOT EXISTS "kind" text,
  ADD COLUMN IF NOT EXISTS "client_id" uuid REFERENCES "public"."clients"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "department" text,
  ADD COLUMN IF NOT EXISTS "color" text;

-- Mirrors chat2_threads' own vocabulary so the two describe a thread identically.
ALTER TABLE "public"."channels" DROP CONSTRAINT IF EXISTS "channels_kind_check";
ALTER TABLE "public"."channels" ADD CONSTRAINT "channels_kind_check"
  CHECK ("kind" IS NULL OR "kind" = ANY (ARRAY['home','team_channel','client_dept','dm']));

ALTER TABLE "public"."channels" DROP CONSTRAINT IF EXISTS "channels_department_check";
ALTER TABLE "public"."channels" ADD CONSTRAINT "channels_department_check"
  CHECK ("department" IS NULL OR "department" = ANY (ARRAY['general','googleAds','metaAds','seo','web']));

-- A client_dept thread without a client is meaningless, and would render as a
-- department tab strip attached to nothing.
ALTER TABLE "public"."channels" DROP CONSTRAINT IF EXISTS "channels_client_dept_needs_client";
ALTER TABLE "public"."channels" ADD CONSTRAINT "channels_client_dept_needs_client"
  CHECK ("kind" <> 'client_dept' OR "client_id" IS NOT NULL);

-- chat2_messages has `flagged` and chat2_thread_canvas has `cards`; the equivalents
-- here are what let the Chat 3.0 features run against this data unchanged.
ALTER TABLE "public"."messages"
  ADD COLUMN IF NOT EXISTS "flagged" boolean NOT NULL DEFAULT false;
ALTER TABLE "public"."channel_canvas"
  ADD COLUMN IF NOT EXISTS "cards" jsonb;

CREATE INDEX IF NOT EXISTS "channels_client_dept_idx"
  ON "public"."channels" ("client_id", "department") WHERE "client_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "channels_kind_idx" ON "public"."channels" ("kind");
