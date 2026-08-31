-- Merge Maribou's duplicate General channel, by explicit decision.
--
-- Maribou has had two General channels since July -- created 13 July and 30 July, before
-- any of the New Chat work. The sidebar has been unioning them on read, which is why one
-- Maribou appeared while twelve messages sat in a channel nobody opened.
--
-- Checked before writing this, and all of it came back empty or already-satisfied: no
-- thread replies, no canvas, no huddles, no scheduled messages, no notifications, no
-- stars, no library items, no child channels, and every one of the source's 13 members is
-- already a member of the destination. The date ranges do not overlap either -- source is
-- 13-27 July, destination starts 30 July -- so the twelve messages slot in ahead of the
-- rest and the conversation reads in order.
--
-- This is the one thing this work has avoided doing on its own: moving messages between
-- channels. It is done here because it was asked for, on a pair that predates the branch,
-- and the reversal facts are printed before anything moves.

DO $$
DECLARE
  src uuid := 'e74ec15e-74f5-456e-be6b-055a827ce65e';
  dst uuid := '87885346-6b50-4431-a59b-6187cd27fd32';
  r record;
  moved int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "public"."channels" WHERE "id" = src) THEN
    RAISE NOTICE 'source channel is gone -- already merged, nothing to do';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "public"."channels" WHERE "id" = dst) THEN
    RAISE EXCEPTION 'destination channel % not found -- refusing to move anything', dst;
  END IF;

  -- Everything needed to put this back, printed before it changes.
  FOR r IN SELECT "id", "name", "slug", "kind", "client_id", "department", "is_private",
                  "created_by", "created_at", "section_id"
             FROM "public"."channels" WHERE "id" = src LOOP
    RAISE NOTICE 'REVERSAL: channel row  id=% name=% slug=% kind=% client=% dept=% private=% created=%',
      r."id", r."name", r."slug", r."kind", r."client_id", r."department", r."is_private", r."created_at";
  END LOOP;
  FOR r IN SELECT "id", "created_at" FROM "public"."messages" WHERE "channel_id" = src ORDER BY "created_at" LOOP
    RAISE NOTICE 'REVERSAL: message % (%)', r."id", r."created_at";
  END LOOP;

  UPDATE "public"."messages" SET "channel_id" = dst WHERE "channel_id" = src;
  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE 'moved % messages into %', moved, dst;

  -- Safe now: no messages remain, and its members are all members of the destination.
  DELETE FROM "public"."channels" WHERE "id" = src;
  RAISE NOTICE 'deleted the emptied duplicate %', src;
  RAISE NOTICE 'destination now holds % messages',
    (SELECT count(*) FROM "public"."messages" WHERE "channel_id" = dst);
END $$;
