-- SOP version history. The "Version history" modal previously synthesized fake
-- rows purely from sops.version (a counter with no content behind it) — every
-- entry past the current one said just "Revision" with no real date or author.
-- Real snapshots are captured here on every edit, before the live row is
-- overwritten, so history can show what actually changed and who changed it.

CREATE TABLE IF NOT EXISTS "public"."sop_versions" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "sop_id" "uuid" NOT NULL,
    "version" integer NOT NULL,
    "snapshot" "jsonb" NOT NULL,
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    PRIMARY KEY ("id"),
    FOREIGN KEY ("sop_id") REFERENCES "public"."sops"("id") ON DELETE CASCADE,
    FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL
);

ALTER TABLE "public"."sop_versions" OWNER TO "postgres";

CREATE INDEX IF NOT EXISTS "sop_versions_sop_id_idx" ON "public"."sop_versions" ("sop_id", "version" DESC);

ALTER TABLE "public"."sop_versions" ENABLE ROW LEVEL SECURITY;

-- Same trust boundary as sops itself: any authenticated team member can read/write.
CREATE POLICY "sop_versions_all" ON "public"."sop_versions"
    USING (("auth"."uid"() IS NOT NULL))
    WITH CHECK (("auth"."uid"() IS NOT NULL));

GRANT ALL ON "public"."sop_versions" TO "authenticated";
