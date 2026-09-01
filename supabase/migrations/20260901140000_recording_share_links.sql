-- Shareable links for screen recordings.
--
-- Recordings could be downloaded or saved, but a saved one had no link anyone could be
-- given: the only address was the raw .webm in storage, buried in a card menu. This adds
-- the two columns a share link needs and the one policy that lets a link work for someone
-- who is not signed in.
--
-- visibility:
--   'workspace' (default) - anyone signed in to Giant can watch it, which is what the
--                           library already showed: recordings_meta_select is USING(true).
--   'public'              - anyone with the link, signed in or not.
--
-- The video file itself lives in the public "recordings" storage bucket, as every other
-- media bucket in this app does, so the underlying .webm URL has always been reachable by
-- anyone holding it. visibility governs the share PAGE and whether the link is handed out,
-- not the bytes; making the bucket private would break every recording already posted
-- into chat as a plain URL.

ALTER TABLE "public"."recordings"
  ADD COLUMN IF NOT EXISTS "share_token" text,
  ADD COLUMN IF NOT EXISTS "visibility"  text NOT NULL DEFAULT 'workspace',
  ADD COLUMN IF NOT EXISTS "view_count"  integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recordings_visibility_check') THEN
    ALTER TABLE "public"."recordings"
      ADD CONSTRAINT "recordings_visibility_check"
      CHECK ("visibility" IN ('workspace', 'public'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "recordings_share_token_key"
  ON "public"."recordings" ("share_token") WHERE "share_token" IS NOT NULL;

-- Every recording gets a token up front, so "copy link" never has to write to the row
-- first -- one less thing to fail at the moment someone is trying to hand over a link.
-- gen_random_uuid() rather than pgcrypto's gen_random_bytes: pgcrypto lives in the
-- extensions schema here and is not on the search path, and a v4 uuid with its hyphens
-- stripped is 32 hex characters of the same unguessability.
UPDATE "public"."recordings"
   SET "share_token" = replace(gen_random_uuid()::text, '-', '')
 WHERE "share_token" IS NULL;

CREATE OR REPLACE FUNCTION "public"."recordings_set_share_token"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."share_token" IS NULL THEN
    NEW."share_token" := replace(gen_random_uuid()::text, '-', '');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "recordings_share_token_trg" ON "public"."recordings";
CREATE TRIGGER "recordings_share_token_trg"
  BEFORE INSERT ON "public"."recordings"
  FOR EACH ROW EXECUTE FUNCTION "public"."recordings_set_share_token"();

-- The public page reads through a Netlify function running as the service role, the same
-- shape as the password share link, so no anon grant is added here. Owners keep the only
-- write access they had; visibility is theirs to change.
