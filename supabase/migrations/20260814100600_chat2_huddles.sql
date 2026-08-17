-- Chat 3.0 huddles — same shape as old chat's "huddles" table (channel_id/started_by/
-- is_active/ended_at) but keyed to chat2_threads instead of old chat's channels table,
-- since Chat 3.0's threads (client_dept/dm/team_channel/home) are a different table
-- entirely. The real-time WebRTC signaling itself needs no schema — it's peer-to-peer
-- over a Supabase Realtime broadcast channel named by huddle id, exactly like old
-- chat's engine; this table only tracks "is a huddle currently active for this thread".

CREATE TABLE IF NOT EXISTS "public"."chat2_huddles" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "thread_id" uuid NOT NULL REFERENCES "public"."chat2_threads"("id") ON DELETE CASCADE,
    "started_by" uuid NOT NULL REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
    "started_at" timestamptz NOT NULL DEFAULT now(),
    "ended_at" timestamptz,
    "is_active" boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS "chat2_huddles_thread_idx" ON "public"."chat2_huddles" ("thread_id", "is_active");

ALTER TABLE "public"."chat2_huddles" ENABLE ROW LEVEL SECURITY;

-- Same visibility rule as chat2_threads itself: manager/owner, or a real thread member.
CREATE POLICY "chat2_huddles_select" ON "public"."chat2_huddles" FOR SELECT TO "authenticated"
    USING ("public"."is_manager_or_owner"() OR EXISTS (
        SELECT 1 FROM "public"."chat2_thread_members" m WHERE m."thread_id" = "thread_id" AND m."profile_id" = "auth"."uid"()
    ));
CREATE POLICY "chat2_huddles_insert" ON "public"."chat2_huddles" FOR INSERT TO "authenticated"
    WITH CHECK ("started_by" = "auth"."uid"());
CREATE POLICY "chat2_huddles_update" ON "public"."chat2_huddles" FOR UPDATE TO "authenticated"
    USING ("public"."is_manager_or_owner"() OR EXISTS (
        SELECT 1 FROM "public"."chat2_thread_members" m WHERE m."thread_id" = "thread_id" AND m."profile_id" = "auth"."uid"()
    ));

GRANT ALL ON "public"."chat2_huddles" TO "authenticated";
GRANT ALL ON "public"."chat2_huddles" TO "service_role";
