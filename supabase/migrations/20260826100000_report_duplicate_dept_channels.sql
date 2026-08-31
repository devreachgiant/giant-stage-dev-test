-- READ-ONLY REPORT. Changes nothing: no DDL, no DML, only RAISE NOTICE.
--
-- Before 99aad9b, clicking a department tab decided the channel was missing from the
-- in-memory list alone, so a department whose channel had not loaded yet was created a
-- second time. Those duplicates are still here: invisible in the sidebar now that it
-- shows one row per client, but holding messages of their own.
--
-- This lists every (client, department) that has more than one channel, with the message
-- count in each, so a human can decide what to do. Nothing is merged or deleted -- moving
-- messages between channels is the one thing this branch has never done on its own.

DO $$
DECLARE
  r record;
  c record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT ch."client_id",
           COALESCE(ch."department", 'general') AS dept,
           count(*) AS copies
      FROM "public"."channels" ch
     WHERE ch."kind" = 'client_dept' AND ch."client_id" IS NOT NULL
     GROUP BY 1, 2
    HAVING count(*) > 1
     ORDER BY count(*) DESC
  LOOP
    n := n + 1;
    RAISE NOTICE '--- % / % : % channels', COALESCE((SELECT "name" FROM "public"."clients" WHERE "id" = r."client_id"), r."client_id"::text), r.dept, r.copies;
    FOR c IN
      SELECT ch."id", ch."name", ch."created_at",
             (SELECT count(*) FROM "public"."messages" m WHERE m."channel_id" = ch."id") AS msgs
        FROM "public"."channels" ch
       WHERE ch."kind" = 'client_dept'
         AND ch."client_id" = r."client_id"
         AND COALESCE(ch."department", 'general') = r.dept
       ORDER BY ch."created_at"
    LOOP
      RAISE NOTICE '      % | % messages | created % | %', c."id", c.msgs, c."created_at"::date, c."name";
    END LOOP;
  END LOOP;
  IF n = 0 THEN
    RAISE NOTICE 'No client/department has more than one channel.';
  ELSE
    RAISE NOTICE '=== % duplicated client/department pairs ===', n;
  END IF;
END $$;
