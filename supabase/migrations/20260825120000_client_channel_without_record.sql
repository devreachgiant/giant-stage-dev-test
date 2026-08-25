-- `channels_client_dept_needs_client` (20260821100000) refused a client_dept channel with
-- no client_id, and the reason given was that such a row "would render as a department tab
-- strip attached to nothing".
--
-- That is no longer how the client renders it. New Chat gates the department strip and the
-- whole Management panel on `isClient`, which requires a client_id -- a client_dept channel
-- without one shows as a plain conversation in the Clients card and nothing else. The
-- constraint is now stopping something the UI handles correctly.
--
-- What it was blocking: creating a channel from the Clients card for a client that has no
-- `clients` record -- a prospect, a one-off, someone not onboarded. The alternative was to
-- make a clients row from a typed channel name, which would put a half-made client into
-- Management, Billing and the Members matrix.
--
-- This only RELAXES the constraint, so no existing row can be invalidated by it. To go
-- back, restore the CHECK from 20260821100000; every row that would then be illegal is one
-- created after this migration.

ALTER TABLE "public"."channels" DROP CONSTRAINT IF EXISTS "channels_client_dept_needs_client";

-- A department still implies a client: a department tab means nothing without one, and that
-- half of the original constraint is worth keeping.
ALTER TABLE "public"."channels" DROP CONSTRAINT IF EXISTS "channels_department_needs_client";
ALTER TABLE "public"."channels" ADD CONSTRAINT "channels_department_needs_client"
  CHECK ("department" IS NULL OR "client_id" IS NOT NULL);
