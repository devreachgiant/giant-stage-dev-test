-- Lets owner/manager deactivate a team member (Slack-style): blocks their login via the
-- Auth Admin API and marks this timestamp, but keeps their profile row and all historical
-- data (messages, tasks, etc.) fully intact and attributed — no hard delete.
ALTER TABLE "public"."profiles"
    ADD COLUMN "deactivated_at" timestamptz;
