-- Favorites + tags on passwords, plus search/filter support (Nishchay: "add search/filter and
-- tags/favorites"). No RLS changes needed — these are just extra columns on password_entries,
-- covered by the existing row-level policies.

ALTER TABLE "public"."password_entries" ADD COLUMN IF NOT EXISTS "favorite" boolean NOT NULL DEFAULT false;
ALTER TABLE "public"."password_entries" ADD COLUMN IF NOT EXISTS "tags" "text"[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS "password_entries_favorite_idx" ON "public"."password_entries" ("favorite") WHERE "favorite" = true;
CREATE INDEX IF NOT EXISTS "password_entries_tags_idx" ON "public"."password_entries" USING GIN ("tags");
