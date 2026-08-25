-- Client conversations are the team's shared record of a client, so they should be public
-- and everyone should be in them. New ones are created that way as of today; these are the
-- ones made before that, by the department-tab auto-create, which made each channel private
-- with a single member -- whoever happened to open the tab first. In the app that reads as
-- "Private · 1 member" on a conversation the whole team is supposed to share.
--
-- Scoped to kind = 'client_dept'. Team channels and DMs are untouched: a private team
-- channel is private on purpose, and a DM is private by definition.

UPDATE "public"."channels"
   SET "is_private" = false
 WHERE "kind" = 'client_dept'
   AND "is_private" IS DISTINCT FROM false;

-- Everyone who works here. Deactivated accounts are excluded -- they cannot sign in, and a
-- membership row for one only inflates every member count.
--
-- Client-role accounts are excluded too, and this is the one line worth arguing about: a
-- client_dept channel is where the TEAM talks about a client, not where it talks TO them.
-- Adding the client's own login here would show them that conversation, and these rows are
-- now public, so it would be readable in old chat as well. If clients are ever meant to
-- join their own channel that should be a deliberate grant per client, not a blanket
-- insert in a backfill.
INSERT INTO "public"."channel_members" ("channel_id", "profile_id")
SELECT c."id", p."id"
  FROM "public"."channels" c
  CROSS JOIN "public"."profiles" p
 WHERE c."kind" = 'client_dept'
   AND p."deactivated_at" IS NULL
   AND ("p"."role" IS NULL OR "p"."role" <> 'client')
ON CONFLICT ("channel_id", "profile_id") DO NOTHING;
