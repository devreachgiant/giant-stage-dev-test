-- White Label reuses the existing public /onboard/:token form and the clients table
-- for onboarding, rather than building a second parallel onboarding system. White
-- Label clients are a distinct concept from the general Clients CRM module though, so
-- rows created from White Label are tagged via `source`, and get a `reviewed_at`
-- timestamp the CRM onboarding UI doesn't currently track (it only shows sent/submitted).
ALTER TABLE "public"."clients" ADD COLUMN IF NOT EXISTS "source" "text";
ALTER TABLE "public"."clients" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;
