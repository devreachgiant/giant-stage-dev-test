-- "Help Us Improve" feature: bug reports + feature suggestions from the team.

CREATE TYPE "public"."report_type" AS ENUM (
    'bug',
    'feature'
);

CREATE TYPE "public"."report_status" AS ENUM (
    'new',
    'triaged',
    'in_progress',
    'fixed',
    'wont_fix'
);

CREATE TYPE "public"."report_priority" AS ENUM (
    'low',
    'medium',
    'high',
    'critical'
);

CREATE TABLE IF NOT EXISTS "public"."reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "type" "public"."report_type" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text" NOT NULL,
    "media_url" "text" NOT NULL,
    "media_type" "text" NOT NULL,
    "link" "text",
    "reporter_id" "uuid" NOT NULL,
    "page_context" "text",
    "status" "public"."report_status" DEFAULT 'new'::"public"."report_status" NOT NULL,
    "priority" "public"."report_priority",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."reports" OWNER TO "postgres";

ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;

CREATE INDEX "reports_status_idx" ON "public"."reports" USING "btree" ("status", "created_at" DESC);
CREATE INDEX "reports_type_idx" ON "public"."reports" USING "btree" ("type", "created_at" DESC);
CREATE INDEX "reports_reporter_idx" ON "public"."reports" USING "btree" ("reporter_id");

ALTER TABLE "public"."reports" ENABLE ROW LEVEL SECURITY;

-- Anyone can submit a report as themselves.
CREATE POLICY "reports_insert_own" ON "public"."reports"
    FOR INSERT TO "authenticated"
    WITH CHECK (("reporter_id" = "auth"."uid"()));

-- Everyone can see all reports (transparency: avoid duplicate reports, see what's already flagged).
CREATE POLICY "reports_select_all" ON "public"."reports"
    FOR SELECT TO "authenticated"
    USING (true);

-- Only owner/manager roles can triage (update status/priority). Reporters can still edit their own open report.
CREATE POLICY "reports_update_triage_or_own" ON "public"."reports"
    FOR UPDATE TO "authenticated"
    USING (
        ("reporter_id" = "auth"."uid"())
        OR (EXISTS (
            SELECT 1 FROM "public"."profiles"
            WHERE "profiles"."id" = "auth"."uid"()
            AND "profiles"."role" IN ('owner', 'manager')
        ))
    );

-- Auto-bump updated_at on change.
CREATE OR REPLACE FUNCTION "public"."reports_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "reports_updated_at" BEFORE UPDATE ON "public"."reports"
    FOR EACH ROW EXECUTE FUNCTION "public"."reports_set_updated_at"();

-- Storage policies for the report-media bucket (bucket itself created via Storage API, see setup notes).
CREATE POLICY "report_media_authenticated_insert"
    ON "storage"."objects"
    AS PERMISSIVE FOR INSERT TO "authenticated"
    WITH CHECK (("bucket_id" = 'report-media'::"text"));

CREATE POLICY "report_media_authenticated_read"
    ON "storage"."objects"
    AS PERMISSIVE FOR SELECT TO "authenticated"
    USING (("bucket_id" = 'report-media'::"text"));

CREATE POLICY "report_media_owner_delete"
    ON "storage"."objects"
    AS PERMISSIVE FOR DELETE TO "authenticated"
    USING ((("bucket_id" = 'report-media'::"text") AND ("owner" = "auth"."uid"())));
