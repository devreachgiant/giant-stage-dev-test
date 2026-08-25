-- The Vault is the library on a client thread. It should be the library in a team channel
-- too -- the same shelf of files, logins, docs, sheets, video, links and notes -- and it
-- could not be, because a row here had to belong to a client: `client_id` was NOT NULL
-- with a foreign key, and a team channel has no client.
--
-- A row now belongs to EXACTLY ONE of a client or a channel. Nothing existing changes:
-- every current row keeps its client_id and its channel_id is null.

ALTER TABLE "public"."chat2_client_library" ALTER COLUMN "client_id" DROP NOT NULL;

ALTER TABLE "public"."chat2_client_library"
  ADD COLUMN IF NOT EXISTS "channel_id" uuid REFERENCES "public"."channels"("id") ON DELETE CASCADE;

-- One owner, never both and never neither. A row with both would be reachable by two
-- different rules below, and a row with neither is unreachable and unfindable.
ALTER TABLE "public"."chat2_client_library" DROP CONSTRAINT IF EXISTS "chat2_client_library_one_owner";
ALTER TABLE "public"."chat2_client_library" ADD CONSTRAINT "chat2_client_library_one_owner"
  CHECK (num_nonnulls("client_id", "channel_id") = 1);

CREATE INDEX IF NOT EXISTS "chat2_client_library_channel_idx"
  ON "public"."chat2_client_library" ("channel_id", "created_at" DESC);

-- The policies gain one branch each, and only one: a CHANNEL row is reachable by the
-- people in that channel. Client rows keep the rule they already had, client-role accounts
-- stay shut out of the whole table, and this holds encrypted credentials, so the branch is
-- membership in that exact channel and nothing looser.
DROP POLICY IF EXISTS "chat2_client_library_select" ON "public"."chat2_client_library";
CREATE POLICY "chat2_client_library_select" ON "public"."chat2_client_library" FOR SELECT TO "authenticated"
    USING (
        NOT "public"."is_client_user"() AND (
            "public"."is_manager_or_owner"()
            OR ("client_id" IS NOT NULL AND EXISTS (
                SELECT 1 FROM "public"."chat2_threads" t
                JOIN "public"."chat2_thread_members" m ON m."thread_id" = t."id"
                WHERE t."client_id" = "chat2_client_library"."client_id"
                  AND m."profile_id" = "auth"."uid"()
            ))
            OR ("channel_id" IS NOT NULL AND EXISTS (
                SELECT 1 FROM "public"."channel_members" cm
                WHERE cm."channel_id" = "chat2_client_library"."channel_id"
                  AND cm."profile_id" = "auth"."uid"()
            ))
        )
    );

DROP POLICY IF EXISTS "chat2_client_library_insert" ON "public"."chat2_client_library";
CREATE POLICY "chat2_client_library_insert" ON "public"."chat2_client_library" FOR INSERT TO "authenticated"
    WITH CHECK (
        "created_by" = "auth"."uid"() AND NOT "public"."is_client_user"() AND (
            "public"."is_manager_or_owner"()
            OR ("client_id" IS NOT NULL AND EXISTS (
                SELECT 1 FROM "public"."chat2_threads" t
                JOIN "public"."chat2_thread_members" m ON m."thread_id" = t."id"
                WHERE t."client_id" = "chat2_client_library"."client_id"
                  AND m."profile_id" = "auth"."uid"()
            ))
            OR ("channel_id" IS NOT NULL AND EXISTS (
                SELECT 1 FROM "public"."channel_members" cm
                WHERE cm."channel_id" = "chat2_client_library"."channel_id"
                  AND cm."profile_id" = "auth"."uid"()
            ))
        )
    );

DROP POLICY IF EXISTS "chat2_client_library_update" ON "public"."chat2_client_library";
CREATE POLICY "chat2_client_library_update" ON "public"."chat2_client_library" FOR UPDATE TO "authenticated"
    USING (
        NOT "public"."is_client_user"() AND (
            "public"."is_manager_or_owner"()
            OR ("client_id" IS NOT NULL AND EXISTS (
                SELECT 1 FROM "public"."chat2_threads" t
                JOIN "public"."chat2_thread_members" m ON m."thread_id" = t."id"
                WHERE t."client_id" = "chat2_client_library"."client_id"
                  AND m."profile_id" = "auth"."uid"()
            ))
            OR ("channel_id" IS NOT NULL AND EXISTS (
                SELECT 1 FROM "public"."channel_members" cm
                WHERE cm."channel_id" = "chat2_client_library"."channel_id"
                  AND cm."profile_id" = "auth"."uid"()
            ))
        )
    );
