-- The triage: 105 channels sorted into Home, team channels, client x department
-- threads and DMs. Only sets the new columns -- no message, membership or channel
-- row is otherwise touched, so old Chat keeps behaving exactly as it does today.

-- 1. Structural kinds, derived from what the row already says about itself.
UPDATE "public"."channels" SET "kind" = 'dm' WHERE "is_dm" = true AND "kind" IS NULL;
UPDATE "public"."channels" SET "kind" = 'home' WHERE "name" = 'reachgiant-home' AND "kind" IS NULL;
UPDATE "public"."channels" SET "kind" = 'team_channel' WHERE "kind" IS NULL;

-- 2. Client channels. The four -seo channels carry their department in the name and
--    486 messages of visibly SEO work, so they land in SEO rather than General;
--    everything else lands in General. Where a client has two channels they merge
--    into the one client and separate by department, which is why mango-vans and
--    wonderpark appear twice with different departments.
WITH triage(chan, client_name, dept) AS (VALUES
  ('burrus-seo',                 'Burrus Reseach, Inc.',                    'seo'),
  ('mango-vans-seo',             'Mango Vans',                              'seo'),
  ('Gulf & Geens SEO',           'Gulf and Greens (Michael S. Pepple, P.A)', 'seo'),
  ('wonderpark-seo',             'WonderPark',                              'seo'),
  ('fortress-development-group', 'Fortess DG',                              'general'),
  ('maribou',                    'Maribou',                                 'general'),
  ('MatraScaler',                'MatraScaler',                             'general'),
  ('modifyr',                    'MODIFYR',                                 'general'),
  ('mango-vans',                 'Mango Vans',                              'general'),
  ('wonderpark',                 'WonderPark',                              'general')
)
UPDATE "public"."channels" c
   SET "kind" = 'client_dept', "client_id" = cl."id", "department" = t.dept
  FROM triage t
  JOIN "public"."clients" cl ON cl."name" = t.client_name
 WHERE c."name" = t.chan AND c."is_dm" = false;

-- 3. The two duplicated clients, resolved by evidence rather than by name.
--    ReachGiant.com: two records, one with 22 tasks and one with 4 Chat 3.0 threads.
--    The threads one wins because this is a chat context and it is already the
--    record Chat 3.0 treats as this client.
UPDATE "public"."channels" c
   SET "kind" = 'client_dept', "department" = 'general',
       "client_id" = (SELECT cl."id" FROM "public"."clients" cl
                       WHERE cl."name" = 'ReachGiant.com'
                       ORDER BY (SELECT count(*) FROM "public"."chat2_threads" th WHERE th."client_id" = cl."id") DESC,
                                cl."created_at" DESC
                       LIMIT 1)
 WHERE c."name" = 'reachgiant.com' AND c."is_dm" = false;

--    Prestige Lighting: three records, all active, all empty -- nothing distinguishes
--    them, so the oldest is used as the canonical one. Reversible: this is one column.
UPDATE "public"."channels" c
   SET "kind" = 'client_dept', "department" = 'general',
       "client_id" = (SELECT cl."id" FROM "public"."clients" cl
                       WHERE cl."name" ILIKE 'Prestige Lighting Co%'
                       ORDER BY cl."created_at" ASC LIMIT 1)
 WHERE c."name" = 'prestige-lighting' AND c."is_dm" = false;

-- 4. "A X E" is deliberately NOT converted. No client of that name exists, churned or
--    otherwise, and attaching 19 messages to the wrong client is worse than leaving it
--    as a team channel until someone creates the record.
