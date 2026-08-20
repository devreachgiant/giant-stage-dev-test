-- The mention body read "Block Medical Center · googleAds" -- the raw dept_key rather
-- than the label the app shows everywhere else. Same four keys as
-- chat2_client_services_dept_key_check, plus 'general', which is a thread department
-- but not a billable service so it is absent from that constraint.

CREATE OR REPLACE FUNCTION "public"."chat2_dept_label"("p_key" text) RETURNS text
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT CASE p_key
    WHEN 'googleAds' THEN 'Google Ads'
    WHEN 'metaAds'   THEN 'Meta Ads'
    WHEN 'seo'       THEN 'SEO'
    WHEN 'web'       THEN 'Web Projects'
    WHEN 'general'   THEN 'General'
    ELSE COALESCE(p_key, 'General')
  END;
$$;

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

  thread_label := CASE
    WHEN th.kind = 'client_dept'  THEN COALESCE(th.client_name, 'a client') || ' · ' || public.chat2_dept_label(th.department)
    WHEN th.kind = 'team_channel' THEN '#' || COALESCE(th.name, 'a channel')
    WHEN th.kind = 'home'         THEN 'ReachGiant Home'
    ELSE 'a DM'
  END;
  snippet := substr(NEW.body, 1, 160);

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
