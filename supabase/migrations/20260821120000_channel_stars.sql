-- Starring in New Chat was per-device localStorage, chosen at the time to avoid a
-- schema change. That makes stars vanish when you open the app on another machine,
-- which is the wrong trade for something meant to be a personal shortcut list.
--
-- Chat 3.0 has chat2_starred_clients, but that stars a CLIENT. Here the thing being
-- starred is a channel, which covers client threads, team channels and DMs alike --
-- a channel already knows which client it belongs to via client_id, so starring the
-- channel loses nothing and works for the two thirds of the sidebar that are not
-- clients at all.

CREATE TABLE IF NOT EXISTS "public"."channel_stars" (
  "profile_id" uuid NOT NULL REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
  "channel_id" uuid NOT NULL REFERENCES "public"."channels"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("profile_id", "channel_id")
);

ALTER TABLE "public"."channel_stars" ENABLE ROW LEVEL SECURITY;

-- A star is private to the person who set it: nobody else needs to read it, and
-- nobody at all should be able to set one on someone else's behalf. Every policy is
-- scoped to auth.uid() rather than to a role, so this is not something a manager can
-- see or change either.
DROP POLICY IF EXISTS "channel_stars_select_own" ON "public"."channel_stars";
CREATE POLICY "channel_stars_select_own" ON "public"."channel_stars" FOR SELECT
  USING ("profile_id" = auth.uid());

DROP POLICY IF EXISTS "channel_stars_insert_own" ON "public"."channel_stars";
CREATE POLICY "channel_stars_insert_own" ON "public"."channel_stars" FOR INSERT
  WITH CHECK ("profile_id" = auth.uid());

DROP POLICY IF EXISTS "channel_stars_delete_own" ON "public"."channel_stars";
CREATE POLICY "channel_stars_delete_own" ON "public"."channel_stars" FOR DELETE
  USING ("profile_id" = auth.uid());

CREATE INDEX IF NOT EXISTS "channel_stars_profile_idx"
  ON "public"."channel_stars" ("profile_id");
