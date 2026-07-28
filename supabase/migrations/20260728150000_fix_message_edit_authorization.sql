-- HOTFIX: any team member could edit ANY other member's message body in a shared channel
-- (including thread replies), not just their own.
--
-- Root cause: Postgres RLS treats multiple PERMISSIVE policies for the same command as
-- OR'd together. "messages_update_self" correctly restricts UPDATE to (author_id = auth.uid()),
-- but two OTHER permissive UPDATE policies exist for the unrelated pin feature:
--   messages_pin_by_member: any channel_members row for the channel
--   messages_pin_by_staff:  any owner/manager/inhouse_dev role
-- Neither of those restricts WHICH COLUMNS can change -- RLS is row-level, not column-level --
-- so satisfying either one (channel membership, or being staff) was enough to let someone
-- update the `body` column of a message they didn't author, not just `pinned_at`/`pinned_by`
-- as intended.
--
-- Fix: a BEFORE UPDATE trigger that enforces the actual business rule regardless of which RLS
-- policy let the statement through -- only the original author (or a backend/service-role
-- context, where auth.uid() is null) may change a message's body.

CREATE OR REPLACE FUNCTION "public"."enforce_message_body_edit_ownership"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER SET "search_path" = "public"
    AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body
     AND auth.uid() IS NOT NULL
     AND auth.uid() != OLD.author_id THEN
    RAISE EXCEPTION 'Only the original author can edit this message';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_enforce_message_body_edit_ownership" ON "public"."messages";
CREATE TRIGGER "trg_enforce_message_body_edit_ownership"
    BEFORE UPDATE ON "public"."messages"
    FOR EACH ROW EXECUTE FUNCTION "public"."enforce_message_body_edit_ownership"();
