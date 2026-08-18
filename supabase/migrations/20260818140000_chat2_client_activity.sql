-- A real audit trail for a client, replacing the derived feed in Chat 3.0's
-- Management > Activity tab.
--
-- The derived version assembled events from messages, tasks and vault rows. That
-- can only ever show things that left a durable artefact, which misses the entries
-- the spec actually asks for: "who viewed Files & Links and when". A view leaves
-- no trace unless something records it, so this table exists to record it.
--
-- APPEND-ONLY BY DESIGN. There is deliberately no UPDATE or DELETE policy. An
-- audit trail that participants can edit is not an audit trail, and "nobody would"
-- is not an access control. Rows go only when the client is deleted (CASCADE).

CREATE TABLE IF NOT EXISTS "public"."chat2_client_activity" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL PRIMARY KEY,
    "client_id" "uuid" NOT NULL REFERENCES "public"."clients"("id") ON DELETE CASCADE,
    -- Kept even if the profile is later deleted: an audit row that loses its actor
    -- is worse than useless, so the name is denormalised at write time too.
    "actor_id" "uuid" REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    "actor_name" "text",
    "kind" "text" NOT NULL,
    -- Already-composed, past-tense, human sentence ("posted in Google Ads"). The
    -- reader should not have to reconstruct what happened from ids.
    "summary" "text" NOT NULL,
    "detail" "text",
    "department" "text",
    "target_type" "text",
    "target_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "chat2_client_activity_kind_check" CHECK ("kind" IN (
        'message','file_upload','vault_add','vault_view','vault_reveal',
        'task_done','task_added','member_added','access_changed','onboarding','other'
    ))
);

CREATE INDEX IF NOT EXISTS "idx_chat2_client_activity_client_time"
    ON "public"."chat2_client_activity" ("client_id", "created_at" DESC);

ALTER TABLE "public"."chat2_client_activity" ENABLE ROW LEVEL SECURITY;

-- Same trust boundary as the client's library and threads: managers and owners see
-- everything, other staff see a client they are actually on, client-portal users
-- never. An audit trail naming who looked at what is itself sensitive.
CREATE POLICY "chat2_client_activity_select" ON "public"."chat2_client_activity" FOR SELECT TO "authenticated"
    USING (
        NOT "public"."is_client_user"() AND (
            "public"."is_manager_or_owner"() OR EXISTS (
                SELECT 1 FROM "public"."chat2_threads" t
                JOIN "public"."chat2_thread_members" m ON m."thread_id" = t."id"
                WHERE t."client_id" = "chat2_client_activity"."client_id"
                  AND m."profile_id" = "auth"."uid"()
            )
        )
    );

-- You may only write rows about yourself. Without this, one user could forge
-- another's audit entries, which defeats the point of having a trail.
CREATE POLICY "chat2_client_activity_insert_self" ON "public"."chat2_client_activity" FOR INSERT TO "authenticated"
    WITH CHECK (
        "actor_id" = "auth"."uid"() AND NOT "public"."is_client_user"() AND (
            "public"."is_manager_or_owner"() OR EXISTS (
                SELECT 1 FROM "public"."chat2_threads" t
                JOIN "public"."chat2_thread_members" m ON m."thread_id" = t."id"
                WHERE t."client_id" = "chat2_client_activity"."client_id"
                  AND m."profile_id" = "auth"."uid"()
            )
        )
    );

-- ROLLBACK:
--   DROP TABLE IF EXISTS "public"."chat2_client_activity";
