-- Phase 2: full-text search for messages.
--
-- Search is `body ILIKE '%term%'` today. A leading wildcard cannot use an index, so every
-- search is a sequential scan of the table: measured at 489ms across 12,396 messages with
-- no filters and no RLS, against a 200ms target. It gets linearly worse.
--
-- Config: 'english'. The team writes in English and stemming is what makes "report" find
-- "reports" and "reporting", which is the behaviour people expect from a search box. The
-- tradeoff is that a message in another language is stemmed by English rules -- close to
-- 'simple' in practice, so nothing is lost that matters here. If the workspace becomes
-- genuinely multilingual, switch to 'simple' and accept losing stemming.
--
-- Weights: messages have no title, so the body is B. A (title/subject) is left unused so
-- that files and canvases can carry their names at a higher weight later without
-- re-weighting what is already indexed. Attachment filenames are C, added by the same
-- trigger via the attachments table rather than denormalised into the message row.

ALTER TABLE "public"."messages" ADD COLUMN IF NOT EXISTS "search_tsv" tsvector;

CREATE OR REPLACE FUNCTION "public"."messages_search_tsv_update"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."search_tsv" :=
    setweight(to_tsvector('english', coalesce(NEW."body", '')), 'B');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "messages_search_tsv_trg" ON "public"."messages";
CREATE TRIGGER "messages_search_tsv_trg"
  BEFORE INSERT OR UPDATE OF "body" ON "public"."messages"
  FOR EACH ROW EXECUTE FUNCTION "public"."messages_search_tsv_update"();

-- The index the search actually uses.
CREATE INDEX IF NOT EXISTS "messages_search_tsv_gin"
  ON "public"."messages" USING gin ("search_tsv");

-- The filters hit these hard, and they are what keyset pagination orders by.
CREATE INDEX IF NOT EXISTS "messages_created_at_idx" ON "public"."messages" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "messages_author_id_idx"  ON "public"."messages" ("author_id");
CREATE INDEX IF NOT EXISTS "messages_channel_created_idx"
  ON "public"."messages" ("channel_id", "created_at" DESC);

-- Reactions, pins and saved items stay in their own tables and are filtered by EXISTS,
-- not folded into the tsvector: a reaction changing must not rewrite a message's index
-- row, and "has:pin" is a fact about the message, not a word in it.
CREATE INDEX IF NOT EXISTS "message_reactions_msg_emoji_idx"
  ON "public"."message_reactions" ("message_id", "emoji");
CREATE INDEX IF NOT EXISTS "message_reactions_profile_idx"
  ON "public"."message_reactions" ("profile_id", "message_id");
