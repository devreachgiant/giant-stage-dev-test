-- Release note for two chat fixes, posted into #giant-app as the Giant Bot account, the
-- way release notes are posted there every time.
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
    '**Two chat fixes are live.**', chr(10), chr(10),
    '**Reading back through a conversation.** The "Load earlier messages" button is gone. ',
    'Scrolling up now loads the rest by itself, and the message you are reading stays ',
    'exactly where it is while it happens - no jump to the newest message, and none of the ',
    'flicker it had afterwards. The line at the top tells you where you are: it says when ',
    'history is loading, and says when you have reached the start of the conversation.',
    chr(10), chr(10),
    '**Editing your own message.** Double-clicking a message to edit it was pasting the ',
    'reaction bar - the thumbs up, heart, fire, laughing and party emoji - into the box ',
    'along with your text. It opens with just your words now. The "(edited)" marker could ',
    'get typed in the same way; that is fixed too, and double-clicking a reaction no longer ',
    'opens the editor.', chr(10), chr(10),
    'Thank you for reporting these - please keep them coming, it is how they get found.'
  );

  IF EXISTS (
    SELECT 1 FROM "public"."messages"
     WHERE "channel_id" = v_channel AND "author_id" = v_bot
       AND "body" LIKE '%Two chat fixes are live%'
  ) THEN
    RAISE NOTICE 'Announcement already posted - skipping';
    RETURN;
  END IF;

  INSERT INTO "public"."messages" ("channel_id", "author_id", "body")
  VALUES (v_channel, v_bot, v_body);
END $$;
