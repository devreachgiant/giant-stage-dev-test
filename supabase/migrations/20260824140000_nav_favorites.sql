-- Favourites: the screens a person has pinned to the top of their sidebar. One row per
-- (person, screen), ordered by `position` so the list can be reordered later without a
-- second table.
--
-- A table rather than localStorage, for the reason channel_stars was moved off it
-- (migration 20260821120000): a shortcut list that vanishes when you open the app on
-- another machine is not a shortcut list. Same shape, same policy style.
--
-- `screen` is the nav item's data-screen value, deliberately not a foreign key: the nav
-- is markup, not data, and a screen that is renamed or removed should leave a dead
-- favourite that the client skips, not a migration that has to be kept in step with the
-- sidebar.

CREATE TABLE IF NOT EXISTS "public"."nav_favorites" (
  "profile_id" uuid NOT NULL REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
  "screen"     text NOT NULL CHECK (length("screen") BETWEEN 1 AND 64),
  "position"   integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("profile_id", "screen")
);

ALTER TABLE "public"."nav_favorites" ENABLE ROW LEVEL SECURITY;

-- Yours and nobody else's, in both directions. Scoped to auth.uid() rather than to a
-- role, so this is not something a manager can read or set on someone's behalf either --
-- the same call channel_stars makes, and for the same reason: it is a personal shortcut
-- list, not workspace configuration.
DROP POLICY IF EXISTS "nav_favorites_select_own" ON "public"."nav_favorites";
CREATE POLICY "nav_favorites_select_own" ON "public"."nav_favorites" FOR SELECT
  USING ("profile_id" = auth.uid());

DROP POLICY IF EXISTS "nav_favorites_insert_own" ON "public"."nav_favorites";
CREATE POLICY "nav_favorites_insert_own" ON "public"."nav_favorites" FOR INSERT
  WITH CHECK ("profile_id" = auth.uid());

DROP POLICY IF EXISTS "nav_favorites_update_own" ON "public"."nav_favorites";
CREATE POLICY "nav_favorites_update_own" ON "public"."nav_favorites" FOR UPDATE
  USING ("profile_id" = auth.uid()) WITH CHECK ("profile_id" = auth.uid());

DROP POLICY IF EXISTS "nav_favorites_delete_own" ON "public"."nav_favorites";
CREATE POLICY "nav_favorites_delete_own" ON "public"."nav_favorites" FOR DELETE
  USING ("profile_id" = auth.uid());

CREATE INDEX IF NOT EXISTS "nav_favorites_profile_idx"
  ON "public"."nav_favorites" ("profile_id", "position");
