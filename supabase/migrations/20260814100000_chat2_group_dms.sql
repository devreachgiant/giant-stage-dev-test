-- Chat 3.0 needs group DMs (3+ people), which chat2's dm_pair model can't express
-- (dm_pair is a strict 2-length array, uniquely indexed). Add is_group and relax
-- the dm_pair uniqueness to only apply to true 1:1 DMs — group DMs get dm_pair
-- NULL and rely on chat2_thread_members for membership, same as the old chat's
-- create_group_dm pattern (no dm_pair equivalent there either).

ALTER TABLE "public"."chat2_threads" ADD COLUMN IF NOT EXISTS "is_group" boolean DEFAULT false NOT NULL;

DROP INDEX IF EXISTS "public"."chat2_threads_dm_pair_uniq";
CREATE UNIQUE INDEX IF NOT EXISTS "chat2_threads_dm_pair_uniq"
    ON "public"."chat2_threads" ("dm_pair") WHERE ("kind" = 'dm' AND "is_group" = false);

ALTER TABLE "public"."chat2_threads" DROP CONSTRAINT IF EXISTS "chat2_threads_check";
ALTER TABLE "public"."chat2_threads" ADD CONSTRAINT "chat2_threads_check" CHECK (
    ("kind" = 'client_dept' AND "client_id" IS NOT NULL AND "department" IS NOT NULL)
    OR ("kind" = 'home' AND "client_id" IS NULL AND "department" IS NULL)
    OR ("kind" = 'dm' AND "is_group" = false AND "dm_pair" IS NOT NULL AND array_length("dm_pair", 1) = 2)
    OR ("kind" = 'dm' AND "is_group" = true AND "name" IS NOT NULL)
    OR ("kind" = 'team_channel' AND "name" IS NOT NULL)
);
