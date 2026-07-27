-- Chat & Huddles 2.0 — fully isolated schema, built alongside (not replacing) the
-- existing channels/messages/chat_sections chat system. One thread per (client,
-- department) pair, enforced by the partial unique index below, is the core rule
-- this rebuild exists to guarantee — the old channel/card model can't express it.
-- Gated to owners/managers only while this is under review; old chat is untouched.

CREATE TABLE IF NOT EXISTS "public"."chat2_threads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "kind" "text" NOT NULL CHECK ("kind" IN ('client_dept','home')),
    "client_id" "uuid" REFERENCES "public"."clients"("id") ON DELETE CASCADE,
    "department" "text" CHECK ("department" IN ('googleAds','metaAds','seo','web')),
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    PRIMARY KEY ("id"),
    CHECK (("kind" = 'client_dept' AND "client_id" IS NOT NULL AND "department" IS NOT NULL)
        OR ("kind" = 'home' AND "client_id" IS NULL AND "department" IS NULL))
);
ALTER TABLE "public"."chat2_threads" OWNER TO "postgres";

-- Enforces "exactly one thread per client×department pair" at the DB level.
CREATE UNIQUE INDEX IF NOT EXISTS "chat2_threads_client_dept_uniq"
    ON "public"."chat2_threads" ("client_id", "department") WHERE ("kind" = 'client_dept');
-- Enforces a single ReachGiant Home thread.
CREATE UNIQUE INDEX IF NOT EXISTS "chat2_threads_home_singleton"
    ON "public"."chat2_threads" (("kind" = 'home')) WHERE ("kind" = 'home');

CREATE TABLE IF NOT EXISTS "public"."chat2_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thread_id" "uuid" NOT NULL REFERENCES "public"."chat2_threads"("id") ON DELETE CASCADE,
    "author_id" "uuid" REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    "body" "text" NOT NULL,
    "flagged" boolean DEFAULT false NOT NULL,
    "parent_id" "uuid" REFERENCES "public"."chat2_messages"("id") ON DELETE CASCADE,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "edited_at" timestamp with time zone,
    PRIMARY KEY ("id")
);
ALTER TABLE "public"."chat2_messages" OWNER TO "postgres";
CREATE INDEX IF NOT EXISTS "chat2_messages_thread_idx" ON "public"."chat2_messages" ("thread_id", "created_at");

CREATE TABLE IF NOT EXISTS "public"."chat2_thread_members" (
    "thread_id" "uuid" NOT NULL REFERENCES "public"."chat2_threads"("id") ON DELETE CASCADE,
    "profile_id" "uuid" NOT NULL REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
    "last_read_at" timestamp with time zone,
    PRIMARY KEY ("thread_id", "profile_id")
);
ALTER TABLE "public"."chat2_thread_members" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."chat2_inbox_actions" (
    "message_id" "uuid" NOT NULL REFERENCES "public"."chat2_messages"("id") ON DELETE CASCADE,
    "profile_id" "uuid" NOT NULL REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
    "done" boolean DEFAULT false NOT NULL,
    "saved" boolean DEFAULT false NOT NULL,
    "task_id" "uuid" REFERENCES "public"."tasks"("id") ON DELETE SET NULL,
    PRIMARY KEY ("message_id", "profile_id")
);
ALTER TABLE "public"."chat2_inbox_actions" OWNER TO "postgres";

-- Account access checklist — this concept doesn't exist on the real clients table
-- at all (onboarding only ever collected free-text IDs), so this is new, not a
-- duplicate of anything.
CREATE TABLE IF NOT EXISTS "public"."chat2_client_access" (
    "client_id" "uuid" NOT NULL REFERENCES "public"."clients"("id") ON DELETE CASCADE,
    "service_key" "text" NOT NULL CHECK ("service_key" IN ('googleAds','meta','website','ga4','gsc')),
    "status" "text" DEFAULT 'none' NOT NULL CHECK ("status" IN ('granted','pending','none')),
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "uuid" REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    PRIMARY KEY ("client_id", "service_key")
);
ALTER TABLE "public"."chat2_client_access" OWNER TO "postgres";

-- Services & ad-spend toggle, kept deliberately separate from the real
-- client_services table so the whole build has one simple rule to review:
-- chat2_* is the only thing Chat 2.0 ever writes to.
CREATE TABLE IF NOT EXISTS "public"."chat2_client_services" (
    "client_id" "uuid" NOT NULL REFERENCES "public"."clients"("id") ON DELETE CASCADE,
    "dept_key" "text" NOT NULL CHECK ("dept_key" IN ('googleAds','metaAds','seo','web')),
    "active" boolean DEFAULT false NOT NULL,
    "spend_cents" integer DEFAULT 0 NOT NULL,
    PRIMARY KEY ("client_id", "dept_key")
);
ALTER TABLE "public"."chat2_client_services" OWNER TO "postgres";

ALTER TABLE "public"."chat2_threads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."chat2_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."chat2_thread_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."chat2_inbox_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."chat2_client_access" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."chat2_client_services" ENABLE ROW LEVEL SECURITY;

-- Threads: any authenticated manager/owner can see the thread shells (needed for
-- department rollups, pipeline, overview); actual message content is still gated
-- by membership below. Members can also see the thread rows they belong to.
CREATE POLICY "chat2_threads_select" ON "public"."chat2_threads" FOR SELECT TO "authenticated"
    USING ("public"."is_manager_or_owner"() OR EXISTS (
        SELECT 1 FROM "public"."chat2_thread_members" m WHERE m."thread_id" = "id" AND m."profile_id" = "auth"."uid"()
    ));
CREATE POLICY "chat2_threads_insert_mgr" ON "public"."chat2_threads" FOR INSERT TO "authenticated"
    WITH CHECK ("public"."is_manager_or_owner"());

-- Messages: readable/writable only by thread members, or any manager/owner
-- (owners see everything per spec). This is the real authorization boundary.
CREATE POLICY "chat2_messages_select" ON "public"."chat2_messages" FOR SELECT TO "authenticated"
    USING ("public"."is_manager_or_owner"() OR EXISTS (
        SELECT 1 FROM "public"."chat2_thread_members" m WHERE m."thread_id" = "chat2_messages"."thread_id" AND m."profile_id" = "auth"."uid"()
    ));
CREATE POLICY "chat2_messages_insert" ON "public"."chat2_messages" FOR INSERT TO "authenticated"
    WITH CHECK ("author_id" = "auth"."uid"() AND ("public"."is_manager_or_owner"() OR EXISTS (
        SELECT 1 FROM "public"."chat2_thread_members" m WHERE m."thread_id" = "chat2_messages"."thread_id" AND m."profile_id" = "auth"."uid"()
    )));
CREATE POLICY "chat2_messages_update_own_or_mgr" ON "public"."chat2_messages" FOR UPDATE TO "authenticated"
    USING ("author_id" = "auth"."uid"() OR "public"."is_manager_or_owner"());

-- Membership itself is the per-department access boundary — only managers/owners
-- may grant it, matching the acceptance criterion that this is enforced server-side.
CREATE POLICY "chat2_thread_members_select" ON "public"."chat2_thread_members" FOR SELECT TO "authenticated"
    USING ("public"."is_manager_or_owner"() OR "profile_id" = "auth"."uid"());
CREATE POLICY "chat2_thread_members_write_mgr" ON "public"."chat2_thread_members" FOR ALL TO "authenticated"
    USING ("public"."is_manager_or_owner"()) WITH CHECK ("public"."is_manager_or_owner"());
CREATE POLICY "chat2_thread_members_update_own_read" ON "public"."chat2_thread_members" FOR UPDATE TO "authenticated"
    USING ("profile_id" = "auth"."uid"()) WITH CHECK ("profile_id" = "auth"."uid"());

-- Inbox actions (save/done/task) are strictly per-user, own rows only.
CREATE POLICY "chat2_inbox_actions_own" ON "public"."chat2_inbox_actions" FOR ALL TO "authenticated"
    USING ("profile_id" = "auth"."uid"()) WITH CHECK ("profile_id" = "auth"."uid"());

-- Access checklist and services/spend: any manager/owner can read+write (same
-- trust boundary as the clients table itself); everyone else read-only so the
-- Client Hub can still render for members who are thread members but not managers.
CREATE POLICY "chat2_client_access_select" ON "public"."chat2_client_access" FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "chat2_client_access_write_mgr" ON "public"."chat2_client_access" FOR ALL TO "authenticated"
    USING ("public"."is_manager_or_owner"()) WITH CHECK ("public"."is_manager_or_owner"());

CREATE POLICY "chat2_client_services_select" ON "public"."chat2_client_services" FOR SELECT TO "authenticated" USING (true);
CREATE POLICY "chat2_client_services_write_mgr" ON "public"."chat2_client_services" FOR ALL TO "authenticated"
    USING ("public"."is_manager_or_owner"()) WITH CHECK ("public"."is_manager_or_owner"());

GRANT ALL ON "public"."chat2_threads" TO "authenticated";
GRANT ALL ON "public"."chat2_messages" TO "authenticated";
GRANT ALL ON "public"."chat2_thread_members" TO "authenticated";
GRANT ALL ON "public"."chat2_inbox_actions" TO "authenticated";
GRANT ALL ON "public"."chat2_client_access" TO "authenticated";
GRANT ALL ON "public"."chat2_client_services" TO "authenticated";

-- Seed the singleton Home thread so the app never has to create it lazily.
INSERT INTO "public"."chat2_threads" ("kind") VALUES ('home')
ON CONFLICT DO NOTHING;
