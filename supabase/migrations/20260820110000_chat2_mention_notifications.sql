-- Chat 3.0 mentions notified nobody. public.messages has had trg_notify_message_mentions
-- since old chat shipped, but Chat 3.0 writes chat2_messages, which had no equivalent --
-- so typing "@Luke" in Chat 3.0 produced a highlighted name and nothing else.
--
-- notifications.channel_id and message_id are foreign keys to the OLD chat tables, so a
-- chat2 target cannot be recorded in them; the insert would fail the constraint. Two
-- nullable columns are added instead, which also lets the bell deep-link to the thread.

ALTER TABLE "public"."notifications"
  ADD COLUMN IF NOT EXISTS "chat2_thread_id" uuid
    REFERENCES "public"."chat2_threads"("id") ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS "chat2_message_id" uuid
    REFERENCES "public"."chat2_messages"("id") ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION "public"."notify_chat2_message_mentions"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  mention_text text;
  mention_name text;
  target record;
  actor_name text;
  thread_label text;
  snippet text;
  th record;
BEGIN
  IF NEW.body IS NULL OR NEW.body = '' THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(full_name, email) INTO actor_name FROM public.profiles WHERE id = NEW.author_id;
  SELECT t.id, t.kind, t.name, t.is_private, t.department, c.name AS client_name
    INTO th
    FROM public.chat2_threads t
    LEFT JOIN public.clients c ON c.id = t.client_id
   WHERE t.id = NEW.thread_id;

  -- Chat 3.0 threads are not all channels, so "#name" would be wrong for most of them.
  thread_label := CASE
    WHEN th.kind = 'client_dept'  THEN COALESCE(th.client_name, 'a client') || ' · ' || COALESCE(th.department, 'General')
    WHEN th.kind = 'team_channel' THEN '#' || COALESCE(th.name, 'a channel')
    WHEN th.kind = 'home'         THEN 'ReachGiant Home'
    ELSE 'a DM'
  END;
  snippet := substr(NEW.body, 1, 160);

  -- Same @token grammar the app uses, and the same reserved words it ignores.
  FOR mention_text IN SELECT (regexp_matches(NEW.body, '@([a-zA-Z][a-zA-Z0-9_-]*)', 'g'))[1]
  LOOP
    mention_name := lower(mention_text);
    IF mention_name IN ('everyone', 'here', 'channel') THEN
      CONTINUE;
    END IF;

    FOR target IN
      SELECT id, role FROM public.profiles
      WHERE lower(split_part(COALESCE(full_name, ''), ' ', 1)) = mention_name
         OR lower(replace(COALESCE(full_name, ''), ' ', '')) = mention_name
         OR lower(COALESCE(full_name, '')) = mention_name
      LIMIT 5
    LOOP
      IF target.id = NEW.author_id THEN
        CONTINUE;
      END IF;

      -- Do not tell someone they were mentioned somewhere they cannot open: that
      -- leaks the thread's existence and the message snippet past the read rules.
      -- This mirrors chat2_messages_select plus the public-channel exception.
      IF NOT (
        target.role IN ('owner', 'manager', 'inhouse_dev')
        OR th.kind = 'home'
        OR (th.kind IN ('team_channel', 'client_dept') AND th.is_private = false)
        OR EXISTS (SELECT 1 FROM public.chat2_thread_members m
                    WHERE m.thread_id = NEW.thread_id AND m.profile_id = target.id)
      ) THEN
        CONTINUE;
      END IF;

      IF EXISTS (SELECT 1 FROM public.notifications
                  WHERE type = 'mention' AND chat2_message_id = NEW.id AND recipient_id = target.id) THEN
        CONTINUE;
      END IF;

      INSERT INTO public.notifications
        (recipient_id, actor_id, type, title, body, chat2_thread_id, chat2_message_id)
      VALUES (target.id, NEW.author_id, 'mention', 'You were mentioned',
              COALESCE(actor_name, 'Someone') || ' mentioned you in ' || thread_label || ': "' || snippet || '"',
              NEW.thread_id, NEW.id);
    END LOOP;
  END LOOP;

  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."notify_chat2_message_mentions"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_notify_chat2_message_mentions" ON "public"."chat2_messages";
CREATE TRIGGER "trg_notify_chat2_message_mentions" AFTER INSERT ON "public"."chat2_messages"
    FOR EACH ROW EXECUTE FUNCTION "public"."notify_chat2_message_mentions"();
