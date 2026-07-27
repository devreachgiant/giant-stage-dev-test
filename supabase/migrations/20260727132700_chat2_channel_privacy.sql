-- Team channels need a real public/private distinction: public channels should
-- be visible to everyone (so they can be found and joined later), private ones
-- only to invited members/managers — same trust boundary the old chat's
-- channels.is_private already uses, reimplemented here since Chat 2.0 stays on
-- its own isolated tables.

ALTER TABLE "public"."chat2_threads" ADD COLUMN IF NOT EXISTS "is_private" boolean DEFAULT true NOT NULL;

CREATE POLICY "chat2_threads_select_public_channel" ON "public"."chat2_threads" FOR SELECT TO "authenticated"
    USING ("kind" = 'team_channel' AND "is_private" = false);
