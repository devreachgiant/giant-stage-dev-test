-- Nishchay: "dm me from giant bot if someone report new bug and feature" -- he already gets a
-- notification-bell alert (see submitReport() in index.html), but wants an actual Giant Bot DM
-- too. Doing this as a server-side trigger (not client-side, like the notifications insert)
-- means it fires no matter how/where a report gets created, and can't be skipped by a client
-- bug. Reuses the exact same DM-channel shape as ensure_dm_channel()/dm_pair_key() so the
-- thread behaves like any other DM in the app.

CREATE OR REPLACE FUNCTION "public"."notify_bot_dm_on_report"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  bot_id uuid := 'a38ce649-d810-411d-8259-ecf47bef8884';
  target_id uuid := 'cee32408-d00a-4bb4-8cb3-1439ccd30397';
  pair_key text;
  chan_id uuid;
  reporter_name text;
  type_label text;
  msg_body text;
BEGIN
  -- Don't DM Nishchay about his own reports.
  IF NEW.reporter_id = target_id THEN
    RETURN NEW;
  END IF;

  pair_key := public.dm_pair_key(bot_id, target_id);
  SELECT id INTO chan_id FROM public.channels WHERE dm_pair = pair_key LIMIT 1;
  IF chan_id IS NULL THEN
    INSERT INTO public.channels (name, slug, is_private, is_dm, dm_pair, created_by)
    VALUES ('Giant Bot', 'dm-' || substring(pair_key, 1, 12) || '-' || substring(md5(random()::text), 1, 5), true, true, pair_key, bot_id)
    RETURNING id INTO chan_id;
    INSERT INTO public.channel_members (channel_id, profile_id) VALUES (chan_id, bot_id) ON CONFLICT DO NOTHING;
    INSERT INTO public.channel_members (channel_id, profile_id) VALUES (chan_id, target_id) ON CONFLICT DO NOTHING;
  ELSE
    -- Channel already existed (e.g. bot DM'd about something else before) -- make sure Nishchay
    -- is still in it in case he ever got removed.
    INSERT INTO public.channel_members (channel_id, profile_id) VALUES (chan_id, target_id) ON CONFLICT DO NOTHING;
  END IF;

  SELECT COALESCE(full_name, email) INTO reporter_name FROM public.profiles WHERE id = NEW.reporter_id;
  type_label := CASE WHEN NEW.type = 'bug' THEN 'New bug report' ELSE 'New feature suggestion' END;
  msg_body := '**' || type_label || ': "' || NEW.title || '"**'
    || E'\n\nFrom ' || COALESCE(reporter_name, 'Someone')
    || (CASE WHEN NEW.description IS NOT NULL AND NEW.description <> '' THEN E'\n\n' || "left"(NEW.description, 400) ELSE '' END);

  INSERT INTO public.messages (channel_id, author_id, body) VALUES (chan_id, bot_id, msg_body);

  RETURN NEW;
END;
$$;

ALTER FUNCTION "public"."notify_bot_dm_on_report"() OWNER TO "postgres";

DROP TRIGGER IF EXISTS "trg_notify_bot_dm_on_report" ON "public"."reports";
CREATE TRIGGER "trg_notify_bot_dm_on_report" AFTER INSERT ON "public"."reports"
    FOR EACH ROW EXECUTE FUNCTION "public"."notify_bot_dm_on_report"();
