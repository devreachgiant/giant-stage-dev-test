-- Client contact info (email/phone) should only be visible to owner/manager/
-- inhouse_dev, matching the same tiering already used for MRR on the client
-- list (clients_public excludes financials for non-owners). Views run as
-- their owner, so picking the right view per role in the frontend is a real
-- column-level restriction, not just hiding markup.
--
-- Three tiers:
--   clients          (raw table) -> owner/inhouse_dev: everything incl. MRR
--   clients_manager   (new)      -> manager: everything except MRR/Stripe
--   clients_public    (expanded) -> everyone else: also excludes contact info

CREATE OR REPLACE VIEW "public"."clients_manager" AS
SELECT
    "id", "name", "slug", "initial", "avatar_bg", "avatar_fg", "status", "owner_id",
    "started_at", "notes", "created_at", "updated_at", "company_website", "industry",
    "address", "timezone", "logo_url", "services", "custom_fields",
    "onboarding_submitted_at", "onboarding_sent_at",
    "contact_name", "contact_email", "contact_phone", "phone", "email"
FROM "public"."clients";

ALTER VIEW "public"."clients_manager" OWNER TO "postgres";
GRANT SELECT ON "public"."clients_manager" TO "authenticated";

-- clients_public previously exposed only a handful of columns (a narrower set
-- than what "visible to the whole team" should mean) — broadened to everything
-- except contact info and financials.
CREATE OR REPLACE VIEW "public"."clients_public" AS
SELECT
    "id", "name", "slug", "initial", "avatar_bg", "avatar_fg", "status", "owner_id",
    "started_at", "notes", "created_at", "updated_at", "company_website", "industry",
    "address", "timezone", "logo_url", "services", "custom_fields",
    "onboarding_submitted_at"
FROM "public"."clients";
