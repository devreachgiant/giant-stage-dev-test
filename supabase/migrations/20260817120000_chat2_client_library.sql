-- Chat 3.0's Vault is a per-CLIENT library, not a per-thread canvas. The existing
-- chat2_thread_canvas.cards store is keyed by thread_id (its primary key), so a
-- client with five department threads gets five disconnected vaults — the prototype
-- treats the library as one shelf per client ("Search this client's library…",
-- "N shared in this client"). That is a different grain, so it needs its own table
-- rather than an ALTER; chat2_thread_canvas stays exactly as it is for the
-- Home/DM/team_channel canvases that still use it.
--
-- Seven item kinds, each rendering a different form and row:
--   file            uploaded asset (images, video, PDFs, archives)
--   login           credentials + where the 2FA code lands
--   link            a URL, optionally password-protected
--   doc/sheet/video a titled external URL
--   note            free text
--
-- SECRETS: `login` (and a password-protected `link`) carry a secret. It is stored
-- AES-256-GCM encrypted using the SAME server-only PASSWORD_ENCRYPTION_KEY as
-- password_entries, via the same netlify/functions/password-vault-encrypt. The key
-- never reaches the browser and no plaintext secret is ever written to this table.
--
-- This deliberately duplicates the credential storage that password_entries already
-- provides (that module has its own folder/entry ACLs and share links). It was an
-- explicit product decision to keep the library self-contained. The cost to be aware
-- of: a credential kept in both places has two rows to rotate, and only one of them
-- is reachable from the Passwords screen. Rotating in one does not rotate the other.

CREATE TABLE IF NOT EXISTS "public"."chat2_client_library" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL PRIMARY KEY,
    "client_id" "uuid" NOT NULL REFERENCES "public"."clients"("id") ON DELETE CASCADE,
    "kind" "text" NOT NULL,
    "title" "text" NOT NULL,
    -- Collection name. Free text so teams can name their own shelves (the prototype
    -- seeds Access / Maintenance / Daily flow / Benchmarks / Set-up & SOPs) rather
    -- than being boxed into a fixed enum.
    "section" "text" NOT NULL DEFAULT 'General',
    "url" "text",
    "username" "text",
    "body" "text",
    -- Where the second factor actually lands, e.g. "Authy on Matthew's phone". This
    -- is the thing that blocks work at 2am, and nothing else in the app records it.
    "twofa" "text",
    -- AES-256-GCM. All three or none — enforced below.
    "secret_ciphertext" "text",
    "secret_iv" "text",
    "secret_auth_tag" "text",
    -- kind='file' only.
    "file_url" "text",
    "file_name" "text",
    "file_size" bigint,
    "mime_type" "text",
    "pinned" boolean DEFAULT false NOT NULL,
    "created_by" "uuid" REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,

    CONSTRAINT "chat2_client_library_kind_check" CHECK (
        "kind" IN ('file','login','doc','sheet','video','link','note')
    ),
    -- A half-written secret is undecryptable and indistinguishable from "no secret",
    -- so the row would silently look empty. Reject it at the database instead.
    CONSTRAINT "chat2_client_library_secret_complete" CHECK (
        ("secret_ciphertext" IS NULL AND "secret_iv" IS NULL AND "secret_auth_tag" IS NULL)
        OR ("secret_ciphertext" IS NOT NULL AND "secret_iv" IS NOT NULL AND "secret_auth_tag" IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS "idx_chat2_client_library_client" ON "public"."chat2_client_library" ("client_id");
CREATE INDEX IF NOT EXISTS "idx_chat2_client_library_client_kind" ON "public"."chat2_client_library" ("client_id", "kind");

ALTER TABLE "public"."chat2_client_library" ENABLE ROW LEVEL SECURITY;

-- Same trust boundary as the client's threads: managers/owners see everything,
-- other staff see a client's library only if they are a member of at least one of
-- that client's threads. Client-portal users are excluded outright — this shelf
-- holds internal credentials and internal notes and is never client-facing.
CREATE POLICY "chat2_client_library_select" ON "public"."chat2_client_library" FOR SELECT TO "authenticated"
    USING (
        NOT "public"."is_client_user"() AND (
            "public"."is_manager_or_owner"() OR EXISTS (
                SELECT 1 FROM "public"."chat2_threads" t
                JOIN "public"."chat2_thread_members" m ON m."thread_id" = t."id"
                WHERE t."client_id" = "chat2_client_library"."client_id"
                  AND m."profile_id" = "auth"."uid"()
            )
        )
    );

-- Writes need the same reachability, plus authorship on insert so rows cannot be
-- attributed to someone else.
CREATE POLICY "chat2_client_library_insert" ON "public"."chat2_client_library" FOR INSERT TO "authenticated"
    WITH CHECK (
        "created_by" = "auth"."uid"() AND NOT "public"."is_client_user"() AND (
            "public"."is_manager_or_owner"() OR EXISTS (
                SELECT 1 FROM "public"."chat2_threads" t
                JOIN "public"."chat2_thread_members" m ON m."thread_id" = t."id"
                WHERE t."client_id" = "chat2_client_library"."client_id"
                  AND m."profile_id" = "auth"."uid"()
            )
        )
    );

CREATE POLICY "chat2_client_library_update" ON "public"."chat2_client_library" FOR UPDATE TO "authenticated"
    USING (
        NOT "public"."is_client_user"() AND (
            "public"."is_manager_or_owner"() OR EXISTS (
                SELECT 1 FROM "public"."chat2_threads" t
                JOIN "public"."chat2_thread_members" m ON m."thread_id" = t."id"
                WHERE t."client_id" = "chat2_client_library"."client_id"
                  AND m."profile_id" = "auth"."uid"()
            )
        )
    );

-- Deleting someone else's saved credential is not recoverable, so it is limited to
-- the person who added it and to managers/owners.
CREATE POLICY "chat2_client_library_delete" ON "public"."chat2_client_library" FOR DELETE TO "authenticated"
    USING (
        NOT "public"."is_client_user"()
        AND ("created_by" = "auth"."uid"() OR "public"."is_manager_or_owner"())
    );
