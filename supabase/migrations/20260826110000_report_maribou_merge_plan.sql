-- READ-ONLY. What is attached to the older Maribou General channel, so the merge that
-- follows moves everything and orphans nothing. No DDL, no DML, only RAISE NOTICE.

DO $$
DECLARE
  src uuid := 'e74ec15e-74f5-456e-be6b-055a827ce65e';   -- older, 12 messages
  dst uuid := '87885346-6b50-4431-a59b-6187cd27fd32';   -- newer, 65 messages
  v int;
BEGIN
  SELECT count(*) INTO v FROM "public"."messages" WHERE "channel_id" = src;
  RAISE NOTICE 'messages           src=% ', v;
  SELECT count(*) INTO v FROM "public"."messages" WHERE "channel_id" = src AND "parent_id" IS NOT NULL;
  RAISE NOTICE '  of which replies %', v;
  SELECT count(*) INTO v FROM "public"."channel_members" WHERE "channel_id" = src;
  RAISE NOTICE 'channel_members    src=%', v;
  SELECT count(*) INTO v FROM "public"."channel_members" cm WHERE cm."channel_id" = src
    AND NOT EXISTS (SELECT 1 FROM "public"."channel_members" d WHERE d."channel_id" = dst AND d."profile_id" = cm."profile_id");
  RAISE NOTICE '  not already in dst %', v;
  SELECT count(*) INTO v FROM "public"."channel_canvas" WHERE "channel_id" = src;
  RAISE NOTICE 'channel_canvas     src=%', v;
  SELECT count(*) INTO v FROM "public"."channel_canvas" WHERE "channel_id" = dst;
  RAISE NOTICE '                   dst=%  (both would collide on a one-row-per-channel key)', v;
  SELECT count(*) INTO v FROM "public"."huddles" WHERE "channel_id" = src;
  RAISE NOTICE 'huddles            src=%', v;
  SELECT count(*) INTO v FROM "public"."scheduled_messages" WHERE "channel_id" = src;
  RAISE NOTICE 'scheduled_messages src=%', v;
  SELECT count(*) INTO v FROM "public"."notifications" WHERE "channel_id" = src;
  RAISE NOTICE 'notifications      src=%', v;
  SELECT count(*) INTO v FROM "public"."channel_stars" WHERE "channel_id" = src;
  RAISE NOTICE 'channel_stars      src=%', v;
  SELECT count(*) INTO v FROM "public"."chat2_client_library" WHERE "channel_id" = src;
  RAISE NOTICE 'library items      src=%', v;
  SELECT count(*) INTO v FROM "public"."channels" WHERE "parent_id" = src;
  RAISE NOTICE 'child channels     src=%', v;
  RAISE NOTICE 'oldest src message: %', (SELECT min("created_at")::date FROM "public"."messages" WHERE "channel_id" = src);
  RAISE NOTICE 'newest src message: %', (SELECT max("created_at")::date FROM "public"."messages" WHERE "channel_id" = src);
  RAISE NOTICE 'dst range: % .. %', (SELECT min("created_at")::date FROM "public"."messages" WHERE "channel_id" = dst),
                                     (SELECT max("created_at")::date FROM "public"."messages" WHERE "channel_id" = dst);
END $$;
