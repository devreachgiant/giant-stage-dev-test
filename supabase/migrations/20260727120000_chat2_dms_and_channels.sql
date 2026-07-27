-- Chat 2.0: internal Team tab (DMs + team channels), built for real per Luke's
-- explicit call — keeps Chat 2.0 fully self-contained on its own chat2_* tables
-- rather than reading old Chat & Huddles' channels/messages, even though that
-- means a second DM implementation exists app-wide. Still additive, still zero
-- overlap with the old chat's tables.

ALTER TABLE "public"."chat2_threads" DROP CONSTRAINT IF EXISTS "chat2_threads_check";
ALTER TABLE "public"."chat2_threads" DROP CONSTRAINT IF EXISTS "chat2_threads_kind_check";

ALTER TABLE "public"."chat2_threads" ADD COLUMN IF NOT EXISTS "dm_pair" "uuid"[];
ALTER TABLE "public"."chat2_threads" ADD COLUMN IF NOT EXISTS "name" "text";

ALTER TABLE "public"."chat2_threads" ADD CONSTRAINT "chat2_threads_kind_check"
    CHECK ("kind" IN ('client_dept','home','dm','team_channel'));

ALTER TABLE "public"."chat2_threads" ADD CONSTRAINT "chat2_threads_check" CHECK (
    ("kind" = 'client_dept' AND "client_id" IS NOT NULL AND "department" IS NOT NULL)
    OR ("kind" = 'home' AND "client_id" IS NULL AND "department" IS NULL)
    OR ("kind" = 'dm' AND "dm_pair" IS NOT NULL AND array_length("dm_pair", 1) = 2)
    OR ("kind" = 'team_channel' AND "name" IS NOT NULL)
);

-- dm_pair is always stored sorted (smaller uuid first) by the app, so this
-- enforces "exactly one DM thread per pair" the same way the client×department
-- unique index does.
CREATE UNIQUE INDEX IF NOT EXISTS "chat2_threads_dm_pair_uniq"
    ON "public"."chat2_threads" ("dm_pair") WHERE ("kind" = 'dm');

-- DM/team-channel membership uses the same chat2_thread_members table and RLS
-- already in place — no policy changes needed, since those policies are
-- generic over thread_id, not specific to client_dept threads.
