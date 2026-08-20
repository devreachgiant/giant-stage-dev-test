-- Chat 3.0 Management > Overview shows a SERVICE LEADS section: who owns each
-- department for a client. There was nowhere to record that. chat2_client_services
-- is already keyed per client x department, which is exactly the grain a lead is
-- assigned at, so it goes here rather than in a new table.
--
-- ON DELETE SET NULL, not CASCADE: if a profile is deleted the service itself must
-- survive with no lead, rather than the client silently losing the whole department.

ALTER TABLE "public"."chat2_client_services"
  ADD COLUMN IF NOT EXISTS "lead_profile_id" uuid
  REFERENCES "public"."profiles"("id") ON DELETE SET NULL;

COMMENT ON COLUMN "public"."chat2_client_services"."lead_profile_id"
  IS 'Team member who owns this department for this client. Null means unassigned.';

-- Assigning a lead is a management action, and chat2_client_services already gates
-- every write behind chat2_client_services_write_mgr (is_manager_or_owner()), so
-- the new column inherits that rule with no policy change. SELECT stays open to
-- staff, which is what lets everyone see who to go to.

CREATE INDEX IF NOT EXISTS "chat2_client_services_lead_idx"
  ON "public"."chat2_client_services" ("lead_profile_id")
  WHERE "lead_profile_id" IS NOT NULL;
