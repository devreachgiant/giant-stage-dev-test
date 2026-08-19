-- Chat 3.0's Clients-mode "Starred" section — per-user, not shared/global. Nothing
-- in chat2 (or old chat) has an equivalent starring concept, so this is net-new.

CREATE TABLE IF NOT EXISTS "public"."chat2_starred_clients" (
    "profile_id" uuid NOT NULL REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
    "client_id" uuid NOT NULL REFERENCES "public"."clients"("id") ON DELETE CASCADE,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("profile_id", "client_id")
);

ALTER TABLE "public"."chat2_starred_clients" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chat2_starred_clients_own" ON "public"."chat2_starred_clients" FOR ALL TO "authenticated"
    USING ("profile_id" = "auth"."uid"()) WITH CHECK ("profile_id" = "auth"."uid"());

GRANT ALL ON "public"."chat2_starred_clients" TO "authenticated";
GRANT ALL ON "public"."chat2_starred_clients" TO "service_role";
