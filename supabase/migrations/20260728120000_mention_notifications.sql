-- Matthew (via Help Us Improve): "I usually log in to see 38 notifications in
-- giant-app but have to read the whole thread to make sure I wasn't tagged.
-- Slack would show it at the top if you were tagged so you didn't miss it."
--
-- Chat @mentions currently create no notification at all — the real bell-icon
-- notification system (public.notifications, already wired to a live panel with
-- realtime push) only ever gets task_assigned/report_submitted rows. This adds a
-- 'mention' type, sourced from a trigger rather than client-side code: old chat
-- has 8+ separate places that INSERT INTO messages (main composer, thread
-- replies, voice notes, scheduled delivery, meeting-invite posts...), and a
-- trigger is the only way to guarantee every one of them is covered without
-- hunting down and patching each call site individually — including the
-- Netlify scheduled-message-send function, which writes via service role and
-- has no shared code with the browser at all.

ALTER TABLE "public"."notifications" ADD COLUMN IF NOT EXISTS "channel_id" uuid REFERENCES "public"."channels"("id") ON DELETE CASCADE;
ALTER TABLE "public"."notifications" ADD COLUMN IF NOT EXISTS "message_id" uuid REFERENCES "public"."messages"("id") ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION "public"."notify_message_mentions"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" = "public"
    AS $$
DECLARE
  mention_text text;
  mention_name text;
  target record;
  actor_name text;
  channel_label text;
  snippet text;
BEGIN
  IF NEW.body IS NULL OR NEW.body = '' THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO actor_name FROM public.profiles WHERE id = NEW.author_id;
  SELECT CASE WHEN is_dm THEN 'a DM' ELSE '#' || name END INTO channel_label
    FROM public.channels WHERE id = NEW.channel_id;
  snippet := substr(NEW.body, 1, 160);

  -- Mirrors the app's own @mention regex/matching (parseMentions in index.html):
  -- @word, matched against first name / full name with spaces stripped / full name.
  FOR mention_text IN SELECT (regexp_matches(NEW.body, '@([a-zA-Z][a-zA-Z0-9_-]*)', 'g'))[1]
  LOOP
    mention_name := lower(mention_text);
    IF mention_name IN ('everyone', 'here', 'channel') THEN
      CONTINUE;
    END IF;

    FOR target IN
      SELECT id FROM public.profiles
      WHERE lower(split_part(full_name, ' ', 1)) = mention_name
         OR lower(replace(full_name, ' ', '')) = mention_name
         OR lower(full_name) = mention_name
      LIMIT 5
    LOOP
      IF target.id = NEW.author_id THEN
        CONTINUE;
      END IF;
      IF EXISTS (SELECT 1 FROM public.notifications WHERE type = 'mention' AND message_id = NEW.id AND recipient_id = target.id) THEN
        CONTINUE;
      END IF;
      INSERT INTO public.notifications (recipient_id, actor_id, type, title, body, channel_id, message_id)
      VALUES (target.id, NEW.author_id, 'mention', 'You were mentioned',
              coalesce(actor_name, 'Someone') || ' mentioned you in ' || coalesce(channel_label, 'a channel') || ': "' || snippet || '"',
              NEW.channel_id, NEW.id);
    END LOOP;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_notify_message_mentions" ON "public"."messages";
CREATE TRIGGER "trg_notify_message_mentions" AFTER INSERT ON "public"."messages"
    FOR EACH ROW EXECUTE FUNCTION "public"."notify_message_mentions"();
