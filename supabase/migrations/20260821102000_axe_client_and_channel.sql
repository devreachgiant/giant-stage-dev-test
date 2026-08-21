-- "A X E" was left as a team channel in the triage because no client of that name
-- existed in any spelling -- checked against spaces stripped and a loose a.?x.?e
-- pattern, both of which returned nothing. Confirmed since that it should be a
-- client, so the record is created here rather than the channel being attached to
-- a wrong one.
--
-- Creating a client is not only a chat change: it appears on the Clients screen and
-- anywhere clients are listed. Deliberate, and reversible by deleting this one row
-- (the channel's client_id is ON DELETE SET NULL, so removing it cannot cascade
-- into the 19 messages).

INSERT INTO "public"."clients" ("name", "slug", "status")
SELECT 'A X E', 'a-x-e', 'active'
WHERE NOT EXISTS (SELECT 1 FROM "public"."clients" WHERE "slug" = 'a-x-e');

UPDATE "public"."channels" c
   SET "kind" = 'client_dept', "department" = 'general',
       "client_id" = (SELECT "id" FROM "public"."clients" WHERE "slug" = 'a-x-e')
 WHERE c."name" = 'A X E' AND c."is_dm" = false;
