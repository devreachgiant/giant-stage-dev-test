-- The Members matrix can now revoke a department, not just grant one, and the kind
-- check had no value for that. Without this the revocation write fails and the row
-- is simply never recorded -- the worst possible outcome for an audit trail, which
-- exists precisely so that someone losing access is traceable.
--
-- 'access_changed' was the alternative, but it already means a change to the client's
-- own third-party account access (chat2_client_access) and reusing it would conflate
-- two different things in the same feed.

ALTER TABLE "public"."chat2_client_activity"
  DROP CONSTRAINT IF EXISTS "chat2_client_activity_kind_check";

ALTER TABLE "public"."chat2_client_activity"
  ADD CONSTRAINT "chat2_client_activity_kind_check" CHECK ("kind" = ANY (ARRAY[
    'message', 'file_upload', 'vault_add', 'vault_view', 'vault_reveal',
    'task_done', 'task_added', 'member_added', 'member_removed',
    'access_changed', 'onboarding', 'payment', 'other'
  ]));
