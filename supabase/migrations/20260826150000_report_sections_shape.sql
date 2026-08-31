-- READ-ONLY. What project_views.sections actually holds, and how tasks relate to clients.
DO $$
DECLARE r record;
BEGIN
  RAISE NOTICE 'views that use sections:';
  FOR r IN SELECT v."name" vn, p."name" pn, v."sections"::text s
             FROM "public"."project_views" v JOIN "public"."projects" p ON p."id"=v."project_id"
            WHERE v."sections" IS NOT NULL AND v."sections"::text <> '[]' LOOP
    RAISE NOTICE '   "%" in "%": %', r.vn, r.pn, left(r.s, 220);
  END LOOP;
  RAISE NOTICE 'tasks by client:';
  FOR r IN SELECT COALESCE(c."name",'(no client)') cn, count(*) n
             FROM "public"."tasks" t LEFT JOIN "public"."clients" c ON c."id"=t."client_id"
            GROUP BY 1 ORDER BY 2 DESC LIMIT 10 LOOP
    RAISE NOTICE '   % : % tasks', r.cn, r.n;
  END LOOP;
  RAISE NOTICE 'tasks with a client set: % of %',
    (SELECT count(*) FROM "public"."tasks" WHERE "client_id" IS NOT NULL),
    (SELECT count(*) FROM "public"."tasks");
END $$;
