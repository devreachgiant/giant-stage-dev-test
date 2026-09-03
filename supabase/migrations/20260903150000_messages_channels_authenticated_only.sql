-- SECURITY FIX, found while writing the Phase 3 permission tests.
--
-- messages and channels were readable by the ANON role — that is, by anyone at all. The
-- anon key is published in config.js, as it is designed to be, so "anon" here means any
-- person who opens the site and reads the page source. Verified before this migration:
-- a plain GET with the anon key and no sign-in returned real message bodies and real
-- channel names.
--
-- The cause is that messages_select and channels_select were written without a TO clause.
-- A policy with no role applies to every role, and both conditions are satisfied for any
-- non-private channel regardless of who is asking:
--
--   USING (c.is_private = false OR <is a member> OR <is inhouse_dev>)
--
-- The first branch was doing the work, for everybody. Private channels and DMs were never
-- exposed — all 78 DM channels are marked private — but every public channel's entire
-- history was.
--
-- The fix is the missing two words. Membership logic is untouched; only the set of roles
-- the policy applies to changes, so a signed-in person sees exactly what they saw before
-- and nobody else sees anything.
--
-- Nothing legitimate reads these tables anonymously: the public pages (share, pwshare,
-- rec, booking) all go through Netlify functions that use the service role.

DROP POLICY IF EXISTS "messages_select" ON "public"."messages";
CREATE POLICY "messages_select" ON "public"."messages" FOR SELECT
  TO "authenticated"
  USING (
    EXISTS (SELECT 1 FROM "public"."channels" c
             WHERE c."id" = "messages"."channel_id"
               AND (
                 c."is_private" = false
                 OR EXISTS (SELECT 1 FROM "public"."channel_members" cm
                             WHERE cm."channel_id" = c."id" AND cm."profile_id" = auth.uid())
                 OR (c."is_dm" = false AND public.current_role() = 'inhouse_dev')
               ))
  );

DROP POLICY IF EXISTS "channels_select" ON "public"."channels";
CREATE POLICY "channels_select" ON "public"."channels" FOR SELECT
  TO "authenticated"
  USING (
    "is_private" = false
    OR EXISTS (SELECT 1 FROM "public"."channel_members" cm
                WHERE cm."channel_id" = "channels"."id" AND cm."profile_id" = auth.uid())
    OR ("is_dm" = false AND public.current_role() = 'inhouse_dev')
  );

-- And the search functions themselves: a function is granted EXECUTE to PUBLIC by
-- default, and anon inherits PUBLIC — so revoking from anon alone left it callable.
REVOKE ALL ON FUNCTION "public"."search_messages" FROM PUBLIC;
REVOKE ALL ON FUNCTION "public"."search_messages_count" FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."search_messages" TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."search_messages_count" TO "authenticated";
