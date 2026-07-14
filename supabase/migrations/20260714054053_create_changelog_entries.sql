-- Version & Changelog: lets the team see what changed in each release.

CREATE TABLE IF NOT EXISTS "public"."changelog_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "version" "text" NOT NULL,
    "released_at" "date" DEFAULT CURRENT_DATE NOT NULL,
    "items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."changelog_entries" OWNER TO "postgres";

ALTER TABLE ONLY "public"."changelog_entries"
    ADD CONSTRAINT "changelog_entries_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."changelog_entries"
    ADD CONSTRAINT "changelog_entries_version_key" UNIQUE ("version");

ALTER TABLE ONLY "public"."changelog_entries"
    ADD CONSTRAINT "changelog_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;

CREATE INDEX "changelog_entries_released_at_idx" ON "public"."changelog_entries" USING "btree" ("released_at" DESC);

ALTER TABLE "public"."changelog_entries" ENABLE ROW LEVEL SECURITY;

-- Any team member can read, add, and edit changelog entries (same open model as report triage).
CREATE POLICY "changelog_select_all" ON "public"."changelog_entries"
    FOR SELECT TO "authenticated"
    USING (true);

CREATE POLICY "changelog_insert_any_authenticated" ON "public"."changelog_entries"
    FOR INSERT TO "authenticated"
    WITH CHECK (true);

CREATE POLICY "changelog_update_any_authenticated" ON "public"."changelog_entries"
    FOR UPDATE TO "authenticated"
    USING (true);

CREATE OR REPLACE FUNCTION "public"."changelog_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "changelog_entries_updated_at" BEFORE UPDATE ON "public"."changelog_entries"
    FOR EACH ROW EXECUTE FUNCTION "public"."changelog_set_updated_at"();
