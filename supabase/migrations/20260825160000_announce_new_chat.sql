-- The release announcement for Chat, posted into #giant-app as the Giant Bot account,
-- the way release notes are posted there every time.
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
    '**Chat has been rebuilt.**', chr(10), chr(10),
    'The new Chat is live now - it is the **Chat** you will find under Communication. ',
    'Clients, Teams, Direct messages and Group DMs are each their own section, there is a ',
    '**Needs you** list for anything waiting on you, and client conversations now carry ',
    'their own Overview, Members, Onboarding and Billing.', chr(10), chr(10),
    'The old chat has not gone anywhere. It is under **Archive > Old Chat**, with all of ',
    'your history exactly where you left it, so use it whenever you would rather.', chr(10), chr(10),
    'This is a **beta**. Please raise anything that looks wrong - however small - and we ',
    'will work through them one by one.'
  );

  IF EXISTS (
    SELECT 1 FROM "public"."messages"
     WHERE "channel_id" = v_channel AND "author_id" = v_bot
       AND "body" LIKE '%Chat has been rebuilt%'
  ) THEN
    RAISE NOTICE 'Announcement already posted - skipping';
    RETURN;
  END IF;

  INSERT INTO "public"."messages" ("channel_id", "author_id", "body")
  VALUES (v_channel, v_bot, v_body);
END $$;
