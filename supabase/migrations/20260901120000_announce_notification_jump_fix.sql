-- Release note for the notification jump fix, posted into #giant-app as the Giant Bot
-- account, the way release notes are posted there every time.
--
-- Written as a migration rather than typed into the app so the exact text is reviewable,
-- and so it refuses rather than guesses: if the bot account or the channel cannot be
-- identified unambiguously it raises, and nothing is posted anywhere.
--
-- Guarded against a second run: re-applying finds the message already there and does
-- nothing.

DO $$
DECLARE
  v_bot uuid;
  v_channel uuid;
  v_count int;
  v_body text;
BEGIN
  SELECT "id" INTO v_bot FROM "public"."profiles" WHERE "email" = 'bot@reachgiant.com' LIMIT 1;
  IF v_bot IS NULL THEN
    RAISE EXCEPTION 'Giant Bot account (bot@reachgiant.com) not found - nothing posted';
  END IF;

  SELECT count(*) INTO v_count
    FROM "public"."channels"
   WHERE "is_dm" IS NOT TRUE
     AND (lower("slug") = 'giant-app' OR lower("name") = 'giant-app');
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one #giant-app channel, found % - nothing posted', v_count;
  END IF;

  SELECT "id" INTO v_channel
    FROM "public"."channels"
   WHERE "is_dm" IS NOT TRUE
     AND (lower("slug") = 'giant-app' OR lower("name") = 'giant-app')
   LIMIT 1;

  v_body := concat(
    '**Fixed: notifications now take you to the message itself.**', chr(10), chr(10),
    'Clicking a row in **Needs you**, or a notification from the bell, used to drop you ',
    'into the middle of a conversation with nothing marked - so you had to scroll back ',
    'through everything to find where you were actually tagged.', chr(10), chr(10),
    'It now opens the message itself. It loads back through the channel''s history as far ',
    'as it needs to, opens the thread if you were tagged in a reply, and rings the message ',
    'in red so you can see straight away what wanted you.', chr(10), chr(10),
    'Two other things came out of it: notifications were opening **Old Chat** in the ',
    'Archive rather than Chat, and a row could send you to a channel''s newest message ',
    'instead of the mention. Both fixed.', chr(10), chr(10),
    'Please keep raising anything that looks wrong - it is how these get found.'
  );

  IF EXISTS (
    SELECT 1 FROM "public"."messages"
     WHERE "channel_id" = v_channel AND "author_id" = v_bot
       AND "body" LIKE '%notifications now take you to the message itself%'
  ) THEN
    RAISE NOTICE 'Announcement already posted - skipping';
    RETURN;
  END IF;

  INSERT INTO "public"."messages" ("channel_id", "author_id", "body")
  VALUES (v_channel, v_bot, v_body);
END $$;
