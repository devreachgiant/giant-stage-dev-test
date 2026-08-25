-- A person's status, the way Slack does it: an emoji, a short line of text, and when it
-- should clear itself. The status menu in the header has always offered presets -- On
-- lunch, In a meeting, Out of office -- but nothing was ever written down, so it changed
-- a dot on your own screen and nobody else ever saw it.
--
-- Four nullable columns, no new policy: profiles_update_self already lets a person write
-- their own row, and profiles are already readable across the workspace, which is the
-- point of a status.

ALTER TABLE "public"."profiles"
  -- The preset that was chosen, if it was a preset: 'online', 'away', 'busy', 'lunch',
  -- 'meeting', 'commuting', 'ooo', 'offline'. Null for a status typed by hand. Kept
  -- separate from the text so the presence dot has something to key off that does not
  -- depend on parsing what someone wrote.
  ADD COLUMN IF NOT EXISTS "status_key"        text,
  ADD COLUMN IF NOT EXISTS "status_emoji"      text,
  ADD COLUMN IF NOT EXISTS "status_text"       text,
  -- When it stops being true. Enforced on read rather than by a job: a status whose time
  -- has passed reads as no status, and the row is tidied the next time that person sets
  -- one. A cron to blank these would be a lot of machinery for a cosmetic field.
  ADD COLUMN IF NOT EXISTS "status_expires_at" timestamptz;

-- Short. This is a line in a sidebar, not a message, and a 2,000-character "status" would
-- break every layout that shows it.
ALTER TABLE "public"."profiles" DROP CONSTRAINT IF EXISTS "profiles_status_text_len";
ALTER TABLE "public"."profiles" ADD CONSTRAINT "profiles_status_text_len"
  CHECK ("status_text" IS NULL OR length("status_text") <= 100);

ALTER TABLE "public"."profiles" DROP CONSTRAINT IF EXISTS "profiles_status_emoji_len";
ALTER TABLE "public"."profiles" ADD CONSTRAINT "profiles_status_emoji_len"
  CHECK ("status_emoji" IS NULL OR length("status_emoji") <= 8);
