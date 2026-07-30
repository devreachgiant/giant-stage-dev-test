-- Public, external share links for individual passwords (Nishchay: "for copy link I need
-- feature like 1pass anyone who are not part of giant can also see the password, we can set
-- expired time by default 3 days"). This is a deliberate, explicit exception to the rest of
-- the Password Manager's "must already be a logged-in Giant user with RLS-granted access"
-- model — a share link IS the credential for whoever holds it, same tradeoff 1Password/Bitwarden
-- Send make. Mitigated by: high-entropy unguessable token, default 3-day expiry, and the
-- creator (or any owner/manager) can revoke early. The public viewer never touches this table
-- directly — it goes through the password-share-get Netlify function using the service role,
-- same pattern as the existing share_packs / share-pack-get public link feature.

CREATE TABLE IF NOT EXISTS "public"."password_share_links" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL PRIMARY KEY,
    "entry_id" "uuid" NOT NULL REFERENCES "public"."password_entries"("id") ON DELETE CASCADE,
    "token" "text" NOT NULL UNIQUE,
    "created_by" "uuid" REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    "created_at" timestamptz NOT NULL DEFAULT "now"(),
    "expires_at" timestamptz NOT NULL,
    "revoked_at" timestamptz,
    "view_count" integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS "password_share_links_entry_id_idx" ON "public"."password_share_links" ("entry_id");
CREATE INDEX IF NOT EXISTS "password_share_links_token_idx" ON "public"."password_share_links" ("token");

ALTER TABLE "public"."password_share_links" ENABLE ROW LEVEL SECURITY;

-- Authenticated management (create happens via the password-share-create function using the
-- service role, so this SELECT/UPDATE policy is really for the "active links" list + revoke
-- button in the app — the creator or any owner/manager can see and revoke a link).
DROP POLICY IF EXISTS "password_share_links_select" ON "public"."password_share_links";
CREATE POLICY "password_share_links_select" ON "public"."password_share_links"
    FOR SELECT USING ("public"."is_manager_or_owner"() OR "created_by" = "auth"."uid"());

DROP POLICY IF EXISTS "password_share_links_revoke" ON "public"."password_share_links";
CREATE POLICY "password_share_links_revoke" ON "public"."password_share_links"
    FOR UPDATE USING ("public"."is_manager_or_owner"() OR "created_by" = "auth"."uid"())
    WITH CHECK ("public"."is_manager_or_owner"() OR "created_by" = "auth"."uid"());
